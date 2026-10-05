import { Room, ServerError, type Client, type ClientPrivate } from "@colyseus/core";
import { StateView } from "@colyseus/schema";
import {
  BOSS_KINDS,
  C2S,
  CLOSE_CODES,
  MATCH,
  PARTY,
  S2C,
  SERVER_TICK_MS,
  WORLD,
  WORLD_JOIN_ERR,
  type BattleState,
  type BossKind,
  type JoinTicket,
  type JoinedMsg,
  type MatchEndReport,
  type MatchSummaryMsg,
  type SpectateEndReason,
  type SpectateMsg,
} from "@extract/shared";
import { registerInventoryHandlers } from "./inventory-handlers.js";
import { IntentLimiter } from "./intent-limit.js";
import { isolateViewPatches } from "./view-patches.js";
import { authenticate, isLaunchKey, releasePendingSeatsOf } from "./room-auth.js";
import { offExitSettled, reportEnd, reportExit, reportWorldEvent } from "../net/web-api.js";
import { buildBatches } from "../sim/audience.js";
import { withNpcSettlement } from "../sim/items.js";
import { Match, expectedMapHash, warmMatchMap } from "../sim/match.js";
import { partyPositions } from "../sim/party.js";
import { spectateEnd, spectateTarget, spectatorBatch } from "../sim/spectate.js";
import type { MatchEvent } from "../sim/types.js";
import { ViewSync } from "../sim/views.js";
import { worldNow } from "../world/clock.js";
import { worldDirectory, type ShardRoom, type WorldCreateOptions } from "../world/directory.js";
import { startShardReplay } from "../world/replay-upload.js";
import type { ReplayRecorder } from "../sim/replay-recorder.js";
import { TickStats, fmtTickSummary, perfLogEnabled } from "./tick-stats.js";

// Process boot (map-boot, WP-M2): this module is imported once by index.ts before the server
// listens, so the static map runtime (MapData, indexes, walk grid, region graph) is built here and
// never inside a room creation or a tick.
const bootMap = warmMatchMap();
if (bootMap) console.log(`[game-server] map ${bootMap.map.id} ${bootMap.hash} ready (${bootMap.buildMs.toFixed(0)} ms, ${bootMap.regions.count} regions)`);

/**
 * BattleJoinOptions.mapHash must equal the server's mapHash of the match map: a client whose
 * generator output differs (another JS engine drifting, a stale bundle) would render walls the
 * server does not have and rubber-band through prediction. Refused before any seat is reserved.
 */
export function checkJoinMapHash(options: unknown): void {
  const expected = expectedMapHash();
  if (expected === null) return; // legacy test map: seed-dependent, no single hash to compare
  const got = (options as { mapHash?: unknown } | null)?.mapHash;
  if (got !== expected) {
    throw new ServerError(409, `${WORLD_JOIN_ERR.MAP_MISMATCH}:${expected}`);
  }
}

interface CreateOptions {
  /** Must equal LAUNCH_KEY: only the WorldDirectory may create battles. */
  launchKey: string;
  world: WorldCreateOptions;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const u32 = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 0xffffffff;

/**
 * The world part of a battle's create options, or null. Create options are plain JSON (and
 * Colyseus forwards client options of /matchmake/* to onCreate), so they are checked again here
 * even though only the directory can pass the launch key.
 */
export function sanitizeWorld(raw: unknown): WorldCreateOptions | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.matchId !== "string" || !UUID_RE.test(o.matchId)) return null;
  if (!Number.isInteger(o.cycleId) || (o.cycleId as number) < 0 || (o.cycleId as number) > 0x7fffffff) return null;
  if (!Number.isInteger(o.shard) || (o.shard as number) < 0 || (o.shard as number) > 64) return null;
  if (!Number.isSafeInteger(o.cycleStartsAt) || (o.cycleStartsAt as number) < 0) return null;
  if (typeof o.entryCloseMs !== "number" || !Number.isFinite(o.entryCloseMs) || o.entryCloseMs < 0 || o.entryCloseMs > WORLD.CYCLE_MS) return null;
  if (!u32(o.matchSeed) || !u32(o.lootSeed) || !u32(o.envSeed)) return null;
  if (o.bossEvent !== null && !(BOSS_KINDS as readonly unknown[]).includes(o.bossEvent)) return null;
  if (o.mode !== "live" && o.mode !== "demo") return null;
  return {
    matchId: o.matchId.toLowerCase(),
    cycleId: o.cycleId as number,
    shard: o.shard as number,
    cycleStartsAt: o.cycleStartsAt as number,
    entryCloseMs: o.entryCloseMs,
    matchSeed: o.matchSeed,
    lootSeed: o.lootSeed,
    envSeed: o.envSeed,
    bossEvent: (o.bossEvent as BossKind | null) ?? null,
    mode: o.mode,
  };
}

/** Most samples accepted in one INPUT message (clients may batch after a hitch). */
const MAX_INPUT_BATCH = 15;
/**
 * Every frame a client sends (INPUT, intents, INV_*, unknown types, protocol frames) spends one token
 * of a per-client bucket before Colyseus even decodes it (security audit "message flooding"): an
 * honest client sends about 35 frames/s (INPUT_HZ 30 + intents and inventory drags). Frames past the
 * bucket are dropped; a client that drops FLOOD_KICK_AFTER frames within one second is disconnected.
 */
export const FRAMES_PER_SEC = 120;
export const FRAME_BURST = 240;
export const FLOOD_KICK_AFTER = 240;
/** Clients get their SETTLED even if the web API is slow; the post keeps retrying in the background. */
const SETTLE_WAIT_MS = 5_000;
/** S2C.PARTY period (PARTY.POS_HZ). */
const PARTY_PERIOD_MS = 1000 / PARTY.POS_HZ;

/**
 * One world shard (WORLD v6, spec §3.3): a thin network wrapper around sim/Match. Messages become
 * intents, drained sim events become per-client `ev` batches, personal sends and web reports. All
 * game rules live in sim/. Created only by the WorldDirectory (launch key); clients reach it only
 * through joinById, whose static onAuth runs the admission before any seat is reserved.
 *
 * Tick order (fog memo §2.4): match.step → syncViews → broadcastPatch → dispatch. Patches are sent
 * by the tick itself (patchRate = null), so a newly visible shooter's Player entry reaches the
 * client in the same tick, before the ShotMsg that references it. Every 1 / PARTY.POS_HZ s the tick
 * also sends S2C.PARTY (sim/party.ts) to each connected party member: their mates' positions only.
 * The admin replay recorder (sim/replay-recorder.ts) reads each tick's drained events right after
 * the step; its chunks go to the web off the tick (world/replay-upload.ts).
 *
 * Spectating (C2S.SPECTATE, sim/spectate.ts): a member whose run ended (dead / extracted) may watch
 * a party mate still on the map over the connection it already has (no seat, no new runtime). Its
 * StateView mirrors the mate's (views.ts), its `ev` batch is the mate's world events plus its own
 * kill feed / XP (spectatorBatch), and every gameplay message it sends is dropped. Checked after
 * each step (spectateEnd): the mate's death / extraction, the wipe or a rejoin ends it.
 */
export class BattleRoom extends Room<BattleState, unknown, unknown, JoinTicket> implements ShardRoom {
  override autoDispose = false;
  // maxClients stays Infinity (D3 / B5): capacity is the directory's, so no seat count can lock the room.
  /** Tick timing samples, only with BATTLE_PERF_LOG=1. */
  private perf: TickStats | null = perfLogEnabled() ? new TickStats() : null;
  // null = no automatic patch interval (Colyseus' typings say number; the setter accepts null).
  override patchRate = null as unknown as number;
  /** The shard's Match (the directory reads it for admission). */
  match!: Match;
  private views!: ViewSync;
  /** userId → client currently controlling that user's runtime (a reconnect replaces the old one). */
  private readonly owners = new Map<string, Client>();
  /** rosterIndex → connected client: all sim routing is by runtime index. */
  private readonly byRoster = new Map<number, Client>();
  private readonly intents = new IntentLimiter();
  /** All frames of a client (see FRAMES_PER_SEC); dropped frames per client for the flood kick. */
  private readonly frames = new IntentLimiter(FRAMES_PER_SEC, FRAME_BURST);
  private readonly dropped = new WeakMap<object, { n: number; since: number }>();
  private finishing = false;
  private summary: MatchSummaryMsg | null = null;
  private disposedFlag = false;
  /** Time since the last S2C.PARTY round. */
  private partyAccMs = 0;
  /** Roster indexes whose client got mates in the last S2C.PARTY round (they get one empty list when that ends). */
  private readonly partyShown = new Set<number>();
  /** Admin replay of this shard-cycle (world/replay-upload.ts); null when recording is off. */
  private replay: ReplayRecorder | null = null;
  /** Spectator rosterIndex → the mate it watches and that mate's Player id as last sent. */
  private readonly spectating = new Map<number, { target: number; id: string }>();

  get disposed(): boolean {
    return this.disposedFlag;
  }

  /** Refuse a create without leaving timers behind (Colyseus starts the room clock before onCreate). */
  private abortCreate(reason: string): never {
    this.patchRate = null as unknown as number;
    this.clock.clear();
    this.clock.stop();
    throw new Error(reason);
  }

  /**
   * Runs before Colyseus reserves anything (joinById → callOnAuth → reserveSeatFor): no valid
   * ticket or map, no seat. The admission puts the raider on the map, so the seat reservation that
   * follows finds a living runtime (D4 / D6).
   */
  static override async onAuth(_token: string, options: unknown): Promise<JoinTicket> {
    const ticket = authenticate(options);
    checkJoinMapHash(options);
    await worldDirectory.admit(ticket);
    return ticket;
  }

  override onCreate(opts: CreateOptions) {
    if (!isLaunchKey(opts?.launchKey)) this.abortCreate("battle: not launched by the world directory");
    const world = sanitizeWorld(opts?.world);
    if (!world) this.abortCreate("battle: invalid world options");
    this.match = new Match({
      roster: [],
      matchId: world.matchId,
      mapSeed: world.matchSeed,
      lootSeed: world.lootSeed,
      envSeed: world.envSeed,
      mode: world.mode,
      now: worldNow,
      world: {
        cycleId: world.cycleId,
        shard: world.shard,
        cycleStartsAt: world.cycleStartsAt,
        entryCloseMs: world.entryCloseMs,
        bossEvent: world.bossEvent,
      },
    });
    this.views = new ViewSync(this.match);
    this.replay = startShardReplay(this.match);
    this.setState(this.match.state);
    // One client's oversized view must never truncate the other clients' patches (view-patches.ts).
    const encoder = (this as unknown as { _serializer?: { encoder?: unknown } })._serializer?.encoder;
    if (!isolateViewPatches(encoder, (view, bytes) => this.onViewOverflow(view, bytes))) {
      console.warn(`[battle ${world.matchId}] view patch isolation unavailable (unexpected @colyseus/schema encoder)`);
    }
    this.setMetadata({ matchId: world.matchId, cycleId: world.cycleId });

    this.onMessage(C2S.INPUT, (client, raw: unknown) => {
      // A spectator steers nothing (its runtime is off the map anyway; this keeps it explicit).
      if (this.watching(client)) return;
      const samples = Array.isArray(raw) ? raw.slice(-MAX_INPUT_BATCH) : [raw];
      for (const s of samples) this.match.enqueueInput(client.sessionId, s);
    });
    // Intent messages share one per-client token bucket (intent-limit.ts): floods are dropped.
    const ok = (client: Client) => !this.watching(client) && this.intents.take(client);
    this.onMessage(C2S.INTERACT, (client) => {
      if (ok(client)) this.match.interact(client.sessionId);
    });
    this.onMessage(C2S.RELOAD, (client) => {
      if (ok(client)) this.match.reload(client.sessionId);
    });
    this.onMessage(C2S.SWITCH, (client, raw: unknown) => {
      if (!ok(client)) return;
      const slot = (raw as { slot?: unknown } | null)?.slot;
      // SwitchMsg is { slot: "w1" | "w2" }; the v1 numeric form is still accepted.
      const key = slot === "w1" || slot === 0 ? "w1" : slot === "w2" || slot === 1 ? "w2" : null;
      if (key) this.match.switchSlot(client.sessionId, key);
    });
    this.onMessage(C2S.HEAL, (client, raw: unknown) => {
      if (!ok(client)) return;
      const kind = (raw as { kind?: unknown } | null)?.kind;
      if (kind === "bandage" || kind === "medkit") this.match.heal(client.sessionId, kind);
    });
    // Weapons v2: ThrowMsg { a: angle, d: 0..1, q: input seq } — the sim validates everything else.
    // The throw joins the input stream (Match.requestThrow): it runs after input q is applied.
    this.onMessage(C2S.THROW, (client, raw: unknown) => {
      if (!ok(client)) return;
      const m = raw as { a?: unknown; d?: unknown; q?: unknown } | null;
      const a = typeof m?.a === "number" && Number.isFinite(m.a) ? m.a : NaN;
      const d = typeof m?.d === "number" && Number.isFinite(m.d) ? m.d : 1;
      const q = typeof m?.q === "number" && Number.isSafeInteger(m.q) ? m.q : undefined;
      if (Number.isFinite(a)) this.match.requestThrow(client.sessionId, a, d, q);
    });
    this.onMessage(C2S.PING, (client, raw: unknown) => {
      if (!ok(client)) return;
      const t = (raw as { t?: unknown } | null)?.t;
      if (typeof t === "number" && Number.isFinite(t)) client.send(S2C.PONG, { t });
    });
    registerInventoryHandlers(this, () => this.match, ok);
    this.onMessage(C2S.SPECTATE, (client, raw: unknown) => {
      if (this.intents.take(client)) this.onSpectate(client, raw);
    });
    // Unknown messages are ignored instead of logged: clients are untrusted.
    this.onMessage("*", () => {});

    this.setSimulationInterval((dt) => this.tick(dt), SERVER_TICK_MS);
  }

  /**
   * A seat counts from the HTTP reservation on, so only a user whose current runtime stands on this
   * map may hold one (the admission in onAuth just put it there, or it is a rejoin), and only one
   * pending seat each.
   */
  protected override async _reserveSeat(
    sessionId: string,
    joinOptions?: unknown,
    authData?: unknown,
    seconds?: number,
    allowReconnection = false,
    devModeReconnection?: boolean,
  ): Promise<boolean> {
    if (!allowReconnection) {
      const userId = (authData as JoinTicket | undefined)?.userId;
      if (!userId || !this.match?.currentOf(userId)?.pub.alive) return false;
      await releasePendingSeatsOf(this, userId);
    }
    return super._reserveSeat(sessionId, joinOptions, authData, seconds, allowReconnection, devModeReconnection);
  }

  /** The frame budget (FRAMES_PER_SEC) runs before Colyseus decodes anything. */
  protected override _onMessage(client: Client & ClientPrivate, buffer: Buffer): void {
    if (this.frames.take(client)) {
      super._onMessage(client, buffer);
      return;
    }
    const now = performance.now();
    let d = this.dropped.get(client);
    if (!d || now - d.since > 1000) {
      d = { n: 0, since: now };
      this.dropped.set(client, d);
    }
    if (++d.n === FLOOD_KICK_AFTER) {
      console.warn(`[battle ${this.match?.state.matchId}] ${client.sessionId}: frame flood, disconnecting`);
      client.leave(CLOSE_CODES.FLOODED, "flooded");
    }
  }

  /** A view patch outgrew the encoder buffer: that client's decoder is out of sync, so it rejoins. */
  private onViewOverflow(view: unknown, bytes: number): void {
    const client = this.clients.find((c) => c.view === view);
    console.error(`[battle ${this.match?.state.matchId}] view patch of ${client?.sessionId ?? "?"} overflowed (${bytes} B): resync`);
    if (client) this.clock.setTimeout(() => client.leave(CLOSE_CODES.RESYNC, "resync"), 0);
  }

  override onJoin(client: Client, options: unknown, ticket: JoinTicket) {
    const prev = this.owners.get(ticket.userId);
    const rt = this.match.attachHuman(ticket.userId, client.sessionId);
    if (!rt) {
      // The runtime died / extracted between the reservation and the WebSocket join.
      client.leave(CLOSE_CODES.NOT_IN_WORLD, "not_in_world");
      return;
    }
    // Alpha Pass "phone" tester task: the client says it runs touch controls (cosmetic only).
    if ((options as { touch?: unknown } | null)?.touch === true) rt.touch = true;
    this.owners.set(ticket.userId, client);
    const old = this.byRoster.get(rt.rosterIndex);
    if (old && old !== client) this.views.detach(rt.rosterIndex, old.view);
    this.byRoster.set(rt.rosterIndex, client);
    if (prev && prev !== client) prev.leave(CLOSE_CODES.JOINED_ELSEWHERE, "joined_elsewhere");

    // Fresh view on every (re)connect: own self entry first, then what this player may see.
    client.view = new StateView();
    this.views.attach(rt.rosterIndex, client.view);

    const joined: JoinedMsg = {
      sessionId: client.sessionId,
      matchId: this.match.state.matchId,
      selfKey: rt.selfKey,
      entryId: rt.entryId,
      cycleId: this.match.world?.cycleId ?? 0,
    };
    client.send(S2C.JOINED, joined);
    if (rt.outcome) client.send(S2C.OUTCOME, rt.outcome);
    if (this.summary && this.finishing) client.send(S2C.SETTLED, this.summary);
  }

  override onLeave(client: Client) {
    // Every runtime this client was routed to (a user's earlier entry keeps its old client until it leaves).
    for (const [r, c] of this.byRoster) {
      if (c !== client) continue;
      this.spectating.delete(r);
      this.byRoster.delete(r);
      this.views.detach(r, client.view);
    }
    const ticket = client.auth as JoinTicket | undefined;
    if (ticket && this.owners.get(ticket.userId) === client) this.owners.delete(ticket.userId);
    // Only a runtime still keyed by this client's sessionId (a reconnect re-keys it to the new one).
    this.match.detach(client.sessionId);
  }

  override onDispose() {
    this.disposedFlag = true;
    this.replay?.close();
    if (this.match) offExitSettled(this.match.state.matchId);
  }

  /** The wipe (directory timer at wipeAt; Match.step is the backstop): MIA for everyone, lock, end report. */
  wipe(): void {
    if (!this.match || this.disposedFlag) return;
    this.match.wipe();
    void this.lock();
  }

  /** Hard stop of a room that outlived its wipe (the directory logs it). */
  async forceDispose(): Promise<void> {
    if (this.disposedFlag) return;
    await this.disconnect(CLOSE_CODES.WIPED);
  }

  private tick(dtMs: number) {
    const t0 = this.perf ? performance.now() : 0;
    if (!this.finishing) {
      try {
        this.match.step(dtMs);
      } catch (e) {
        // One bad tick must not take down the room (and every player's items with it).
        console.error(`[battle ${this.match.state.matchId}] step failed:`, e);
      }
    }
    const t1 = this.perf ? performance.now() : 0;
    const events = this.match.drainEvents();
    // Never throws (a recorder error drops its chunk, not the tick).
    this.replay?.tick(events);
    if (this.spectating.size > 0) this.checkSpectators();
    this.syncViews(events);
    this.broadcastPatch();
    this.dispatch(events);
    this.partyAccMs += dtMs;
    if (this.partyAccMs >= PARTY_PERIOD_MS) {
      this.partyAccMs %= PARTY_PERIOD_MS;
      this.sendParty();
    }
    if (this.perf) {
      this.perf.add(t1 - t0, performance.now() - t0);
      // One line per ~30 s of ticks.
      if (this.perf.size >= 30_000 / SERVER_TICK_MS) {
        const s = this.perf.flush();
        if (s) console.log(`[battle ${this.match.state.matchId}] perf ${fmtTickSummary(s)} (${this.clients.length} clients)`);
      }
    }
  }

  /**
   * StateViews follow the sim (views.ts): players = each client's published vision row, items and
   * corpses = its AOI ring, loot entries = its search sessions (`view` events).
   */
  private syncViews(events: readonly MatchEvent[]) {
    for (const ev of events) if (ev.type === "view") this.views.applyLoot(ev.to, ev.op, ev.key);
    this.views.sync();
  }

  /**
   * One `ev` batch per client (audience.ts: clipped shots, hit / chest audiences, per-listener
   * sounds), then the personal sends and web reports.
   */
  private dispatch(events: readonly MatchEvent[]) {
    const recipients = [...this.byRoster.keys()];
    // Watched mates get a batch built even when they are not connected themselves (spectate.ts).
    for (const { target } of this.spectating.values()) if (!this.byRoster.has(target)) recipients.push(target);
    const batches = buildBatches(this.match, events, recipients);
    for (const [r, client] of this.byRoster) {
      const watched = this.spectating.get(r);
      const batch = watched ? spectatorBatch(batches.get(r), batches.get(watched.target)) : batches.get(r);
      if (batch) client.send(S2C.EV, batch);
    }
    for (const ev of events) {
      switch (ev.type) {
        case "outcome":
          this.byRoster.get(ev.to)?.send(S2C.OUTCOME, ev.msg);
          break;
        case "invErr":
          this.byRoster.get(ev.to)?.send(S2C.INV_ERR, ev.msg);
          break;
        case "exit":
          void reportExit(ev.report);
          break;
        case "world":
          // Lobby "killed by" line and the News feed (fire-and-forget).
          void reportWorldEvent({
            matchId: this.match.state.matchId,
            cycleId: this.match.world?.cycleId ?? 0,
            kind: ev.kind,
            boss: ev.boss,
            by: ev.by.slice(0, 64),
            ...(ev.byUserId ? { byUserId: ev.byUserId } : {}),
            atMs: Math.min(WORLD.CYCLE_MS, this.match.clock),
          });
          break;
        case "ended":
          void this.finish(ev.report, ev.summary);
          break;
        default:
          break;
      }
    }
  }

  /**
   * S2C.PARTY (sim/party.ts): each connected party member gets their mates' positions, and nobody
   * else gets anything. A member whose mates are all gone gets one empty list, then nothing.
   */
  private sendParty() {
    const out = partyPositions(this.match);
    for (const r of this.partyShown) {
      if (!out.has(r)) this.byRoster.get(r)?.send(S2C.PARTY, { mates: [] });
    }
    this.partyShown.clear();
    for (const [r, msg] of out) {
      const client = this.byRoster.get(r);
      if (!client) continue;
      client.send(S2C.PARTY, msg);
      this.partyShown.add(r);
    }
  }

  /** The client is watching a party mate (every gameplay message of it is dropped). */
  private watching(client: Client): boolean {
    if (this.spectating.size === 0) return false;
    const rt = this.match.runtime(client.sessionId);
    return !!rt && this.spectating.has(rt.rosterIndex) && this.byRoster.get(rt.rosterIndex) === client;
  }

  /** C2S.SPECTATE {key}: start watching that party mate (spectate.ts decides), or stop ({key: null}). */
  private onSpectate(client: Client, raw: unknown) {
    const rt = this.match.runtime(client.sessionId);
    if (!rt || this.byRoster.get(rt.rosterIndex) !== client) return;
    const r = rt.rosterIndex;
    const key = (raw as { key?: unknown } | null)?.key;
    if (key === null || key === undefined || key === "") {
      this.stopSpectating(r, "stopped");
      return;
    }
    const check = spectateTarget(this.match, r, key);
    if (!check.ok) {
      client.send(S2C.SPECTATE, { key: null, reason: "refused" } satisfies SpectateMsg);
      return;
    }
    const t = check.target;
    if (!this.views.mirror(r, t.rosterIndex)) return;
    this.spectating.set(r, { target: t.rosterIndex, id: t.id });
    client.send(S2C.SPECTATE, { key: t.selfKey, id: t.id, name: t.nickname } satisfies SpectateMsg);
  }

  private stopSpectating(r: number, reason: SpectateEndReason) {
    if (!this.spectating.delete(r)) return;
    this.views.unmirror(r);
    this.byRoster.get(r)?.send(S2C.SPECTATE, { key: null, reason } satisfies SpectateMsg);
  }

  /**
   * After the step: end what may not go on (mate down / out, wipe, rejoin), and tell a spectator the
   * mate's new Player id when the mate reconnected (attachHuman re-keys the Player).
   */
  private checkSpectators() {
    for (const [r, w] of [...this.spectating]) {
      const end = spectateEnd(this.match, r, w.target);
      if (end) {
        this.stopSpectating(r, end);
        continue;
      }
      const t = this.match.rosterRuntime(w.target);
      if (t && t.id !== w.id) {
        w.id = t.id;
        this.byRoster.get(r)?.send(S2C.SPECTATE, { key: t.selfKey, id: t.id, name: t.nickname } satisfies SpectateMsg);
      }
    }
  }

  private async finish(report: MatchEndReport, summary: MatchSummaryMsg) {
    if (this.finishing) return;
    this.finishing = true;
    this.summary = summary;
    void this.lock();
    // NPCs have no exit report: anything one still lists rides on the end report (leftOnMap).
    const full = withNpcSettlement(report, this.match.allRuntimes());
    await Promise.race([reportEnd(full), new Promise((r) => setTimeout(r, SETTLE_WAIT_MS))]);
    this.broadcast(S2C.SETTLED, summary);
    this.clock.setTimeout(() => void this.disconnect(CLOSE_CODES.WIPED), MATCH.DISPOSE_AFTER_END_MS);
  }
}
