/**
 * Interest management for ground items and corpses (fog memo §2.7, WP2): 512 px cells, each human
 * client receives the entities of a ±VISION.AOI_RING cell ring (7×7 cells, ±1792 px) around itself.
 * AOI, not LOS: loot positions are semi-public and static, LOS over thousands of items is wasted
 * CPU, and the client fog hides them visually anyway.
 *
 * Never brute-forced per viewer (32 × 5000 items measured 3.4 ms/tick). Instead, once per tick:
 * - entities are tracked by sweeping state.items / state.corpses once (not per viewer), so every
 *   spawn path (drops, deaths, containers spilling, message handlers between ticks) is picked up
 *   without hooks in other modules; a spawn becomes an `add` for the viewers whose ring holds it;
 * - a viewer that changed cell gets the entering cells as `add` and the leaving cells as `remove`
 *   (14 cells per crossing, about once per 2 s per player).
 * Despawns need nothing: deleting an entity from state sends a DELETE to every view holding it.
 * The room applies the drained diffs to the StateViews (views.ts).
 *
 * Restrictions (disclosure.ts): a ground item a player just dropped ("spawn") or picked up
 * ("ghost"), and a new corpse ("spawn", actors = victim and killer), is, until the change is
 * published, shown in its new state only to "knowers" — its actors and the viewers that see one of
 * them (sticky) — and in its old state to everyone else (absent / still lying there). Restricted
 * entities are few (drops are capped per user, inventory.ts) and reconciled every tick.
 */

import { VISION, aoiCell, type Corpse, type GroundItem } from "@extract/shared";
import { offMap } from "./audience.js";
import type { Match } from "./match.js";
import type { PlayerRuntime } from "./types.js";

export type AoiEntity = GroundItem | Corpse;

export interface AoiDiff {
  viewer: number;
  add: AoiEntity[];
  remove: AoiEntity[];
}

export type RestrictKind = "spawn" | "ghost";

interface Restriction {
  kind: RestrictKind;
  actors: Set<PlayerRuntime>;
  /** Human roster indexes that saw an actor since the change (they get the new state). */
  knowers: Set<number>;
}

interface Tracked {
  cell: number;
  stamp: number;
  /** Key in its state map (items / corpses) when last seen. */
  key: string;
  corpse: boolean;
}

export class AoiSystem {
  private cols = 0;
  private rows = 0;
  private readonly cells = new Map<number, Set<AoiEntity>>();
  private readonly tracked = new Map<AoiEntity, Tracked>();
  /** Human roster index → cell key of the ring its view currently holds. */
  private readonly viewerCell = new Map<number, number>();
  private diffs = new Map<number, AoiDiff>();
  private stamp = 0;
  private readonly restricted = new Map<AoiEntity, Restriction>();
  /** Entities whose restriction just ended: reconciled once more so everyone gets the new state. */
  private readonly released = new Set<AoiEntity>();

  /**
   * Show `e` in its new state only to knowers until unrestrict (a second actor adds up). `knowers`
   * seeds viewers that already know (a new corpse: those who saw the victim alive last tick).
   */
  restrict(e: AoiEntity, kind: RestrictKind, actor: PlayerRuntime, knowers: Iterable<number> = []): void {
    const r = this.restricted.get(e);
    if (r) {
      r.actors.add(actor);
      for (const k of knowers) r.knowers.add(k);
      return;
    }
    this.restricted.set(e, { kind, actors: new Set([actor]), knowers: new Set(knowers) });
  }

  /**
   * In-raid objectives (objectives.ts): a hidden cache is shown to nobody until reveal() names a
   * viewer (no actors: vision never adds knowers on its own). Never unrestricted.
   */
  hide(e: AoiEntity): void {
    if (!this.restricted.has(e)) this.restricted.set(e, { kind: "spawn", actors: new Set(), knowers: new Set() });
  }

  /** Let viewer `i` see a hidden entity from now on (sticky). */
  reveal(e: AoiEntity, i: number): void {
    this.restricted.get(e)?.knowers.add(i);
  }

  unrestrict(e: AoiEntity): void {
    if (this.restricted.delete(e)) this.released.add(e);
  }

  restrictedAs(e: AoiEntity): RestrictKind | undefined {
    return this.restricted.get(e)?.kind;
  }

  /** May viewer i hold `e` in its view right now (restrictions only; the ring is separate)? */
  allowed(e: AoiEntity, i: number): boolean {
    const r = this.restricted.get(e);
    if (!r) return true;
    return r.kind === "spawn" ? r.knowers.has(i) : !r.knowers.has(i);
  }

  /** Recompute entity cells and viewer ring diffs. Called every tick at the end of Match.step. */
  update(m: Match): void {
    this.dims(m);
    this.diffs = new Map();
    const stamp = ++this.stamp;
    const spawned: AoiEntity[] = [];
    let live = 0;
    const visit = (e: AoiEntity, key: string, corpse: boolean) => {
      live++;
      const cell = this.cellKey(e.x, e.y);
      const t = this.tracked.get(e);
      if (!t) {
        this.tracked.set(e, { cell, stamp, key, corpse });
        this.bucket(cell).add(e);
        spawned.push(e);
        return;
      }
      t.stamp = stamp;
      t.key = key;
      // Ground items and corpses do not move today; handled anyway so a mover can never go stale.
      if (t.cell !== cell) {
        this.cells.get(t.cell)?.delete(e);
        this.bucket(cell).add(e);
        t.cell = cell;
        spawned.push(e);
      }
    };
    // forEach: no [key, value] tuple per entry (thousands of items every tick).
    m.state.items.forEach((g, k) => visit(g, k, false));
    m.state.corpses.forEach((c, k) => visit(c, k, true));
    // Sweep despawns only when something disappeared (the common tick has none).
    if (this.tracked.size !== live) {
      for (const [e, t] of this.tracked) {
        if (t.stamp === stamp) continue;
        this.cells.get(t.cell)?.delete(e);
        this.tracked.delete(e);
        this.restricted.delete(e);
        this.released.delete(e);
      }
    }
    // Knowers first (vision.update already ran this tick), so every add below respects them.
    for (const r of this.restricted.values()) {
      for (const v of m.allRuntimes()) {
        if (v.isNpc || r.knowers.has(v.rosterIndex) || offMap(m, v.rosterIndex)) continue;
        for (const a of r.actors) {
          if (a === v || m.vision.sees(v.rosterIndex, a.rosterIndex)) {
            r.knowers.add(v.rosterIndex);
            break;
          }
        }
      }
    }

    for (const rt of m.allRuntimes()) {
      if (rt.isNpc) continue;
      const i = rt.rosterIndex;
      // Left the map (dead / extracted) before this tick: the ring freezes (no spectating). The
      // tick of the death itself still runs, so the player's own corpse reaches their view.
      if (offMap(m, i)) {
        this.viewerCell.delete(i);
        continue;
      }
      const cell = this.cellKey(rt.pub.x, rt.pub.y);
      const prev = this.viewerCell.get(i);
      if (prev === undefined) {
        // Not attached yet: ring() fills the whole ring when the view is created.
        this.viewerCell.set(i, cell);
        continue;
      }
      if (prev !== cell) {
        this.viewerCell.set(i, cell);
        const d = this.diffOf(i);
        this.forRingCells(cell, (k) => {
          if (!this.cellInRing(prev, k)) for (const e of this.cells.get(k) ?? []) if (this.allowed(e, i)) d.add.push(e);
        });
        this.forRingCells(prev, (k) => {
          if (!this.cellInRing(cell, k)) for (const e of this.cells.get(k) ?? []) d.remove.push(e);
        });
      }
    }
    if (spawned.length) {
      for (const [i, vc] of this.viewerCell) {
        for (const e of spawned) if (this.cellInRing(vc, this.tracked.get(e)!.cell) && this.allowed(e, i)) this.diffOf(i).add.push(e);
      }
    }
    // Restricted (and just released) entities: every ring viewer gets the state it may know.
    const recon = (e: AoiEntity) => {
      const t = this.tracked.get(e);
      if (!t) return;
      for (const [i, vc] of this.viewerCell) {
        if (!this.cellInRing(vc, t.cell)) continue;
        const d = this.diffOf(i);
        if (this.allowed(e, i)) d.add.push(e);
        else d.remove.push(e);
      }
    };
    for (const e of this.restricted.keys()) recon(e);
    for (const e of this.released) recon(e);
    this.released.clear();
  }

  /** Diffs of the last update; the room applies them to the attached views. */
  drainDiffs(): AoiDiff[] {
    const out = [...this.diffs.values()];
    this.diffs = new Map();
    return out;
  }

  /**
   * Everything in the ring around (x, y), recorded as viewer i's ring: a (re)connecting view is
   * filled with this and later diffs are relative to it.
   */
  ring(m: Match, i: number, x: number, y: number): AoiEntity[] {
    this.dims(m);
    const cell = this.cellKey(x, y);
    this.viewerCell.set(i, cell);
    const out: AoiEntity[] = [];
    this.forRingCells(cell, (k) => {
      for (const e of this.cells.get(k) ?? []) if (this.allowed(e, i)) out.push(e);
    });
    return out;
  }

  /**
   * Still attached to state? The grid is refreshed once per tick, but a pickup or search between
   * ticks can delete an entity, and StateView.add throws on a detached instance.
   */
  isLive(m: Match, e: AoiEntity): boolean {
    const t = this.tracked.get(e);
    if (!t) return false;
    return (t.corpse ? m.state.corpses.get(t.key) : m.state.items.get(t.key)) === e;
  }

  /** Is the point inside the AOI ring of a viewer at (vx, vy)? (chest audiences) */
  inRing(vx: number, vy: number, x: number, y: number): boolean {
    return AoiSystem.ringContains(vx, vy, x, y);
  }

  static ringContains(vx: number, vy: number, x: number, y: number): boolean {
    const a = aoiCell(vx, vy), b = aoiCell(x, y);
    return Math.abs(a.cx - b.cx) <= VISION.AOI_RING && Math.abs(a.cy - b.cy) <= VISION.AOI_RING;
  }

  private dims(m: Match): void {
    if (this.cols) return;
    this.cols = Math.max(1, Math.ceil(m.map.width / VISION.AOI_CELL));
    this.rows = Math.max(1, Math.ceil(m.map.height / VISION.AOI_CELL));
  }

  private cellKey(x: number, y: number): number {
    const { cx, cy } = aoiCell(x, y);
    const c = Math.max(0, Math.min(this.cols - 1, cx));
    const r = Math.max(0, Math.min(this.rows - 1, cy));
    return r * this.cols + c;
  }

  private cellInRing(center: number, k: number): boolean {
    const dc = Math.abs((center % this.cols) - (k % this.cols));
    const dr = Math.abs(Math.floor(center / this.cols) - Math.floor(k / this.cols));
    return dc <= VISION.AOI_RING && dr <= VISION.AOI_RING;
  }

  private forRingCells(center: number, f: (k: number) => void): void {
    const c0 = center % this.cols, r0 = Math.floor(center / this.cols), R = VISION.AOI_RING;
    for (let r = Math.max(0, r0 - R); r <= Math.min(this.rows - 1, r0 + R); r++) {
      for (let c = Math.max(0, c0 - R); c <= Math.min(this.cols - 1, c0 + R); c++) f(r * this.cols + c);
    }
  }

  private bucket(k: number): Set<AoiEntity> {
    let s = this.cells.get(k);
    if (!s) {
      s = new Set();
      this.cells.set(k, s);
    }
    return s;
  }

  private diffOf(i: number): AoiDiff {
    let d = this.diffs.get(i);
    if (!d) {
      d = { viewer: i, add: [], remove: [] };
      this.diffs.set(i, d);
    }
    return d;
  }
}
