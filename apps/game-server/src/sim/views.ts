/**
 * Per-client StateView bookkeeping (critique "Where owner-only data lives", WP2 syncViews). One
 * StateView per connected human, keyed by rosterIndex. Rules:
 * - the client's own `self` entry is added first and never removed from its own view; another
 *   player's `self` entry is NEVER added to any view;
 * - its own Player is always in its view (alive or not);
 * - other Players: exactly the viewer's published vision row (vision.ts, with hysteresis), so a
 *   client never decodes a player it may not see (no position, hp or weapon leaks);
 * - ground items and corpses: the AOI ring (aoi.ts diffs);
 * - `loot` entries come and go only through `view` events (search sessions, WP-B).
 * - Spectating (spectate.ts): while viewer i watches party mate t (mirror), "other Players" and the
 *   AOI ring are t's — t's published vision row, t's ring with t's disclosure rights — never more.
 *   i keeps its own self entry and Player; t's self / loot entries are never added. Ring entities
 *   added for the mirror are removed again when it ends.
 *
 * Players are reconciled against the published row every sync (32×32 `has` lookups, ~µs), which is
 * simpler and more robust than replaying flips: reconnects, re-keys and rows cleared on death need
 * no special cases. Plain @colyseus/schema (no networking), so tests drive it with a real Encoder /
 * Decoder (views.test.ts).
 */

import type { StateView } from "@colyseus/schema";
import type { AoiEntity } from "./aoi.js";
import { offMap } from "./audience.js";
import type { Match } from "./match.js";

/**
 * AOI entities (ground items, corpses) added to one view per tick (security audit "StateView patch
 * overflow"): a ring crossing into thousands of items used to add them all in one tick, and the
 * view's patch outgrew the encoder buffer. The rest wait in a per-viewer backlog (insertion order)
 * and follow in the next ticks; removals apply at once and also cancel a pending add. About 60 B per
 * add, so one tick's adds stay near 12 KB per view. An honest ring crossing adds well under this.
 */
export const VIEW_ADDS_PER_TICK = 200;

export class ViewSync {
  private readonly views = new Map<number, StateView>();
  /** Viewer → AOI entities still to add (VIEW_ADDS_PER_TICK). */
  private readonly backlog = new Map<number, Set<AoiEntity>>();
  /** Spectator → the party mate whose view it mirrors (spectate.ts). */
  private readonly mirrors = new Map<number, number>();
  /** Spectator → ring entities its view holds because of the mirror (removed when it ends). */
  private readonly mirrored = new Map<number, Set<AoiEntity>>();

  constructor(private readonly m: Match) {}

  /**
   * (Re)connect: a fresh view gets the self entry first, then its own Player, the published vision
   * row and the AOI ring. A reconnect replaces the old view entirely.
   */
  attach(rosterIndex: number, view: StateView): void {
    const rt = this.m.rosterRuntime(rosterIndex);
    if (!rt) return;
    view.add(rt.self);
    view.add(rt.pub);
    this.views.set(rosterIndex, view);
    this.backlog.delete(rosterIndex);
    this.syncPlayers(rosterIndex, view);
    // A player who already left the map gets no world around their body (no spectating).
    if (!offMap(this.m, rosterIndex)) {
      for (const e of this.m.aoi.ring(this.m, rosterIndex, rt.pub.x, rt.pub.y)) if (this.live(e) && !view.has(e)) this.queue(rosterIndex, e);
      this.drain(rosterIndex, view);
    }
    // A reconnect in the middle of a ready search session: the old view held the loot entry and no
    // new `view add` will come (the player is already in the target's ready set).
    const t = rt.search ? this.m.containers.targets.get(rt.search.key) : undefined;
    const loot = t?.ready.has(rt) ? this.m.state.loot.get(t.key) : undefined;
    if (loot && !view.has(loot)) view.add(loot);
  }

  detach(rosterIndex: number, view?: StateView): void {
    if (view && this.views.get(rosterIndex) !== view) return;
    this.views.delete(rosterIndex);
    this.backlog.delete(rosterIndex);
    this.mirrors.delete(rosterIndex);
    this.mirrored.delete(rosterIndex);
  }

  /**
   * Viewer i (dead / extracted, checked by spectate.ts) starts mirroring target t: its players
   * become t's published row (plus t itself) and t's AOI ring is queued into its view. Called
   * between ticks or right after the step, when t's ring cell is current. False without a view.
   */
  mirror(i: number, t: number): boolean {
    const view = this.views.get(i);
    const target = this.m.rosterRuntime(t);
    if (!view || !target || i === t) return false;
    if (this.mirrors.get(i) !== t) this.unmirror(i);
    this.mirrors.set(i, t);
    if (!this.mirrored.has(i)) this.mirrored.set(i, new Set());
    for (const e of this.m.aoi.ring(this.m, t, target.pub.x, target.pub.y)) if (this.live(e) && !view.has(e)) this.queue(i, e);
    this.syncPlayers(i, view);
    this.drain(i, view);
    return true;
  }

  /** Viewer i stops mirroring: back to its own (empty) row; the mirrored ring entities leave its view. */
  unmirror(i: number): void {
    if (!this.mirrors.delete(i)) return;
    const view = this.views.get(i);
    const added = this.mirrored.get(i);
    this.mirrored.delete(i);
    this.backlog.delete(i);
    if (!view) return;
    if (added) for (const e of added) if (view.has(e)) view.remove(e);
    this.syncPlayers(i, view);
  }

  /** The roster index viewer i mirrors, if any. */
  mirrorOf(i: number): number | undefined {
    return this.mirrors.get(i);
  }

  /** Whose vision row and ring viewer i gets: the mirrored mate's, else its own. */
  private source(i: number): number {
    return this.mirrors.get(i) ?? i;
  }

  /** AOI adds still waiting for viewer i (tests, perf logs). */
  pendingAdds(rosterIndex: number): number {
    return this.backlog.get(rosterIndex)?.size ?? 0;
  }

  viewOf(rosterIndex: number): StateView | undefined {
    return this.views.get(rosterIndex);
  }

  /** Once per tick, after Match.step and before broadcastPatch. */
  sync(): void {
    // Flips are implied by the reconciliation below; drained so they never pile up.
    this.m.vision.drainChanges();
    for (const [i, view] of this.views) this.syncPlayers(i, view);
    const diffs = this.m.aoi.drainDiffs();
    for (const d of diffs) {
      if (!this.mirrors.has(d.viewer)) this.applyDiff(d.viewer, d.add, d.remove);
      // Spectators of this viewer follow its ring (spectate.ts).
      if (this.mirrors.size > 0) for (const [s, t] of this.mirrors) if (t === d.viewer) this.applyDiff(s, d.add, d.remove);
    }
    for (const i of [...this.backlog.keys()]) {
      const view = this.views.get(i);
      if (view) this.drain(i, view);
      else this.backlog.delete(i);
    }
  }

  private applyDiff(i: number, add: readonly AoiEntity[], remove: readonly AoiEntity[]): void {
    const view = this.views.get(i);
    if (!view) return;
    const pending = this.backlog.get(i);
    const added = this.mirrored.get(i);
    for (const e of remove) {
      pending?.delete(e);
      added?.delete(e);
      if (view.has(e)) view.remove(e);
    }
    for (const e of add) if (this.live(e) && !view.has(e)) this.queue(i, e);
  }

  private queue(i: number, e: AoiEntity): void {
    let q = this.backlog.get(i);
    if (!q) {
      q = new Set();
      this.backlog.set(i, q);
    }
    q.add(e);
  }

  /** Up to VIEW_ADDS_PER_TICK pending adds of viewer i, oldest first (still live and allowed). */
  private drain(i: number, view: StateView): void {
    const q = this.backlog.get(i);
    if (!q) return;
    let budget = VIEW_ADDS_PER_TICK;
    for (const e of q) {
      if (budget <= 0) break;
      q.delete(e);
      if (!this.live(e) || view.has(e) || !this.m.aoi.allowed(e, this.source(i))) continue;
      view.add(e);
      this.mirrored.get(i)?.add(e);
      budget--;
    }
    if (q.size === 0) this.backlog.delete(i);
  }

  /** Apply a sim `view` event (loot entry of a search session). */
  applyLoot(to: number, op: "add" | "remove", key: string): void {
    const view = this.views.get(to);
    const entry = this.m.state.loot.get(key);
    if (!view || !entry) return;
    if (op === "add") {
      if (!view.has(entry)) view.add(entry);
    } else if (view.has(entry)) {
      view.remove(entry);
    }
  }

  private live(e: AoiEntity): boolean {
    return this.m.aoi.isLive(this.m, e);
  }

  /**
   * Own Player always; every other Player iff vision publishes it for this viewer — or, while it
   * mirrors a mate, for that mate (sees(t, t) is true: the mate's own Player is in).
   */
  private syncPlayers(i: number, view: StateView): void {
    const m = this.m;
    const src = this.source(i);
    for (const rt of m.allRuntimes()) {
      const want = rt.rosterIndex === i || m.vision.sees(src, rt.rosterIndex);
      const has = view.has(rt.pub);
      if (want && !has) view.add(rt.pub);
      else if (!want && has) view.remove(rt.pub);
    }
  }
}
