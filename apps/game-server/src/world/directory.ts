/**
 * WORLD v6 world directory (spec §3.2): the one place that opens, wipes and admits into the world's
 * shards. One shard = one Colyseus battle room = one Match = one matchId = one web raids row
 * (kind 'world'), per (cycle, shard); launch has one shard per cycle (WORLD.MAX_SHARDS = 1).
 *
 * Timers run on absolute world times (worldNow(), addendum A1) and recompute their delay when they
 * fire:
 * - wipeAt(k) − PREWARM_MS → open the shard of cycle k + 1 (its Match idles until its cycle starts);
 * - wipeAt(k)              → wipe the shard of cycle k (MIA), then schedule cycle k + 1;
 * - wipeAt(k) + 60 s       → a room of cycle k still alive is force-disposed (logged).
 * Boot mid-cycle opens the current cycle's shard at once (a fresh matchId and loot seed, the same
 * boss event; void-orphans has returned the previous process' gear by then).
 *
 * Admission (`admit`, called by BattleRoom's static onAuth before any seat is reserved) runs the
 * checks of §3.2 and the web's raids/enter, then puts the raider on the map (Match.addHuman), so
 * the seat reservation that follows finds a living runtime. Errors are ServerErrors whose message
 * is a WORLD_JOIN_ERR code ("<code>" or "<code>:<detail>").
 */

import { randomInt, randomUUID } from "node:crypto";
import { ServerError, matchMaker } from "@colyseus/core";
import {
  ROOMS,
  WORLD,
  WORLD_JOIN_ERR,
  cycleEnvSeed,
  worldCycleAt,
  worldCycleOf,
  worldPhase,
  type BossKind,
  type EntryRequest,
  type EntryResponse,
  type JoinTicket,
  type MapId,
  type RaidMode,
  type ShardOpenRequest,
  type WorldBossRef,
  type WorldCycle,
} from "@extract/shared";
import { SERVER_INSTANCE, enterRaid, openShard, webApiConfigured, type ShardOpenOutcome } from "../net/web-api.js";
import { LAUNCH_KEY } from "../rooms/room-auth.js";
import type { Match } from "../sim/match.js";
import { bossOf } from "./boss-schedule.js";
import { worldNow } from "./clock.js";

/** The battle room's create options of a world shard (BattleRoom.onCreate sanitizes them again). */
export interface WorldCreateOptions {
  matchId: string;
  cycleId: number;
  shard: number;
  /** Wall ms of the cycle start (Match clock 0). */
  cycleStartsAt: number;
  /** Cycle clock when entry closes (CYCLE_MS − ENTRY_CLOSE_MS). */
  entryCloseMs: number;
  /** Public map seed (BattleState.mapSeed). */
  matchSeed: number;
  /** Server-secret loot / NPC seed (crypto random per shard, never derived from a secret). */
  lootSeed: number;
  envSeed: number;
  bossEvent: BossKind | null;
  mode: RaidMode;
}

/** What the directory needs of a shard's Match. */
export type ShardMatch = Pick<
  Match,
  "ended" | "clock" | "map" | "eventBossSpot" | "currentOf" | "entryById" | "humansOnMap" | "allRuntimes" | "poolTargetCount" | "bossAlive" | "addHuman"
>;

/** What the directory needs of a shard's room (BattleRoom implements it). */
export interface ShardRoom {
  readonly match: ShardMatch;
  /** Wipe the map now (MIA for everyone on it; the room posts the end report and closes). */
  wipe(): void;
  readonly disposed: boolean;
  /** Dispose a room that outlived its wipe. */
  forceDispose(): Promise<void>;
}

export interface Shard {
  cycle: number;
  idx: number;
  wc: WorldCycle;
  matchId: string;
  roomId: string;
  room: ShardRoom;
  mode: RaidMode;
  matchSeed: number;
  /** raids/open succeeded (until then /api/world/join finds no row → nobody joins). */
  registered: boolean;
  /** userId → running admission (a second PLAY of the same user waits for it). */
  inflight: Map<string, Promise<void>>;
}

export interface DirectoryDeps {
  /** World wall clock (worldNow). */
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  createRoom(opts: WorldCreateOptions): Promise<{ roomId: string; room: ShardRoom }>;
  openShard(req: ShardOpenRequest): Promise<ShardOpenOutcome>;
  enterRaid(req: EntryRequest): Promise<EntryResponse | null>;
  /** WEB_API_BASE_URL and GAME_SERVER_HMAC_SECRET are set. */
  webConfigured(): boolean;
  bossOf(cycle: number): BossKind | null;
  mode(): RaidMode;
  serverId: string;
  instanceId: string;
  /** Production refuses admissions without the web; dev runs standalone with free kits. */
  production: boolean;
}

/** ECONOMY_MODE=demo → demo shards (free kits, server-minted uniques); anything else live. */
export function economyMode(): RaidMode {
  return process.env.ECONOMY_MODE === "demo" ? "demo" : "live";
}

/** A room of cycle k still alive this long after its wipe is force-disposed. */
export const HARD_STOP_AFTER_MS = 60_000;
/** raids/open retry period after the fast attempts, until it lands or the wipe. */
export const OPEN_RETRY_MS = 10_000;
/** A failed room creation is retried this often while the cycle lasts. */
const CREATE_RETRY_MS = 10_000;
/** A timer that fires more than this early (clock offset changed, drift) is re-armed. */
const EARLY_FIRE_TOLERANCE_MS = 25;

const joinErr = (status: number, code: string, detail?: string) => new ServerError(status, detail ? `${code}:${detail}` : code);

export function defaultDirectoryDeps(): DirectoryDeps {
  return {
    now: worldNow,
    setTimer: (fn, ms) => {
      const t = setTimeout(fn, ms);
      // The server's listening socket keeps the process alive; the directory's timers never should.
      t.unref();
      return t;
    },
    clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
    createRoom: async (world) => {
      const cache = await matchMaker.createRoom(ROOMS.BATTLE, { launchKey: LAUNCH_KEY, world });
      const room = matchMaker.getLocalRoomById(cache.roomId) as unknown as ShardRoom | undefined;
      if (!room) throw new Error(`battle room ${cache.roomId} is not local`);
      return { roomId: cache.roomId, room };
    },
    openShard: (req) => openShard(req),
    enterRaid: (req) => enterRaid(req),
    webConfigured: webApiConfigured,
    bossOf,
    mode: economyMode,
    serverId: SERVER_INSTANCE.serverId,
    instanceId: SERVER_INSTANCE.instanceId,
    production: process.env.NODE_ENV === "production",
  };
}

export class WorldDirectory {
  private readonly deps: DirectoryDeps;
  private readonly byCycle = new Map<number, Shard>();
  private readonly byMatch = new Map<string, Shard>();
  private readonly opening = new Map<number, Promise<Shard | null>>();
  private readonly scheduled = new Set<number>();
  private readonly timers = new Set<unknown>();
  private stopped = false;
  private warnedStandalone = false;

  constructor(deps: Partial<DirectoryDeps> = {}) {
    this.deps = { ...defaultDirectoryDeps(), ...deps };
  }

  /** Boot: open the current cycle's shard at once (even seconds before its wipe), then run the timers. */
  async start(): Promise<void> {
    this.stopped = false;
    const k = worldCycleAt(this.deps.now()).cycle;
    await this.openShard(k);
    this.schedule(k);
  }

  /** Clear every timer (tests; the process never stops the world otherwise: SIGTERM never wipes). */
  stop(): void {
    this.stopped = true;
    for (const h of this.timers) this.deps.clearTimer(h);
    this.timers.clear();
    this.scheduled.clear();
  }

  shardByMatch(matchId: string): Shard | undefined {
    return this.byMatch.get(matchId);
  }

  shardOfCycle(cycle: number): Shard | undefined {
    return this.byCycle.get(cycle);
  }

  /** The shard of the cycle running now, if open. */
  current(): Shard | undefined {
    return this.byCycle.get(worldCycleAt(this.deps.now()).cycle);
  }

  // ---------------------------------------------------------------- timers

  /** Run `fn` at world time `target` (absolute); the delay is recomputed when the timer fires. */
  private at(target: number, fn: () => unknown, label: string): void {
    if (this.stopped) return;
    const h = this.deps.setTimer(() => {
      this.timers.delete(h);
      if (this.stopped) return;
      if (target - this.deps.now() > EARLY_FIRE_TOLERANCE_MS) {
        this.at(target, fn, label);
        return;
      }
      void (async () => {
        try {
          await fn();
        } catch (e) {
          console.error(`[world] ${label} failed:`, e);
        }
      })();
    }, Math.max(0, target - this.deps.now()));
    this.timers.add(h);
  }

  private sleepUntil(target: number): Promise<void> {
    return new Promise((resolve) => this.at(target, resolve, "sleep"));
  }

  /** Prewarm k + 1, wipe k, hard-stop k (once per cycle). */
  private schedule(k: number): void {
    if (this.scheduled.has(k) || this.stopped) return;
    this.scheduled.add(k);
    const wc = worldCycleOf(k);
    this.at(wc.wipeAt - WORLD.PREWARM_MS, () => this.openShard(k + 1), `prewarm cycle ${k + 1}`);
    this.at(wc.wipeAt, () => this.onWipeTime(k), `wipe cycle ${k}`);
    this.at(wc.wipeAt + HARD_STOP_AFTER_MS, () => this.hardStop(k), `hard stop cycle ${k}`);
  }

  private onWipeTime(k: number): void {
    try {
      this.wipe(k);
    } finally {
      // After a long stall (laptop sleep, debugger) skip the cycles that are already over.
      const cur = worldCycleAt(this.deps.now()).cycle;
      const next = Math.max(k + 1, cur);
      if (next > k + 1) void this.openShard(next);
      this.schedule(next);
    }
  }

  /** Wipe the shard of cycle k now (idempotent: the Match ignores a second wipe). */
  wipe(k: number): void {
    const shard = this.byCycle.get(k);
    if (!shard || shard.room.disposed) return;
    console.log(`[world] wipe cycle ${k} (${shard.matchId}): ${shard.room.match.humansOnMap()} on the map`);
    shard.room.wipe();
  }

  private async hardStop(k: number): Promise<void> {
    this.scheduled.delete(k);
    const shard = this.byCycle.get(k);
    if (!shard) return;
    this.byCycle.delete(k);
    this.byMatch.delete(shard.matchId);
    if (!shard.room.disposed) {
      console.error(`[world] cycle ${k} room ${shard.roomId} (${shard.matchId}) still alive ${HARD_STOP_AFTER_MS / 1000} s after its wipe: disposing`);
      await shard.room.forceDispose();
    }
  }

  // ---------------------------------------------------------------- shards

  /** Open (create + register) the shard of `cycle`; concurrent and repeated calls share one shard. */
  openShard(cycle: number): Promise<Shard | null> {
    const have = this.byCycle.get(cycle);
    if (have) return Promise.resolve(have);
    let p = this.opening.get(cycle);
    if (!p) {
      p = this.createShard(cycle).finally(() => this.opening.delete(cycle));
      this.opening.set(cycle, p);
    }
    return p;
  }

  private async createShard(cycle: number): Promise<Shard | null> {
    const wc = worldCycleOf(cycle);
    if (this.stopped || this.deps.now() >= wc.wipeAt) return null;
    const world: WorldCreateOptions = {
      matchId: randomUUID(),
      cycleId: cycle,
      shard: 0,
      cycleStartsAt: wc.startAt,
      entryCloseMs: WORLD.CYCLE_MS - WORLD.ENTRY_CLOSE_MS,
      matchSeed: randomInt(0, 2 ** 32),
      lootSeed: randomInt(0, 2 ** 32),
      envSeed: cycleEnvSeed(cycle),
      bossEvent: this.deps.bossOf(cycle),
      mode: this.deps.mode(),
    };
    let created: { roomId: string; room: ShardRoom };
    try {
      created = await this.deps.createRoom(world);
    } catch (e) {
      console.error(`[world] cycle ${cycle}: creating the battle room failed (retry in ${CREATE_RETRY_MS / 1000} s):`, e);
      this.at(this.deps.now() + CREATE_RETRY_MS, () => this.openShard(cycle), `reopen cycle ${cycle}`);
      return null;
    }
    const shard: Shard = {
      cycle,
      idx: 0,
      wc,
      matchId: world.matchId,
      roomId: created.roomId,
      room: created.room,
      mode: world.mode,
      matchSeed: world.matchSeed,
      registered: false,
      inflight: new Map(),
    };
    this.byCycle.set(cycle, shard);
    this.byMatch.set(shard.matchId, shard);
    console.log(`[world] cycle ${cycle} shard ${shard.idx} open: room ${shard.roomId}, match ${shard.matchId}, ${world.mode}, boss ${world.bossEvent ?? "none"}`);
    void this.register(shard).catch((e) => console.error(`[world] raids/open ${shard.matchId} failed:`, e));
    return shard;
  }

  /** The raids/open request of a shard (boss = the spot that actually spawned; zone = MapData zone id). */
  shardOpenRequest(shard: Shard): ShardOpenRequest {
    const map = shard.room.match.map;
    const spot = shard.room.match.eventBossSpot;
    const nextKind = this.deps.bossOf(shard.cycle + 1);
    const nextSpot = nextKind ? map.bosses.find((b) => b.kind === nextKind) : undefined;
    const boss: WorldBossRef | null = spot ? { kind: spot.kind, zone: spot.zone } : null;
    const nextBoss: WorldBossRef | null = nextSpot ? { kind: nextSpot.kind, zone: nextSpot.zone } : null;
    return {
      matchId: shard.matchId,
      cycleId: shard.cycle,
      shard: shard.idx,
      roomId: shard.roomId,
      mode: shard.mode,
      mapId: map.id as MapId,
      matchSeed: shard.matchSeed,
      startsAt: shard.wc.startAt,
      entryClosesAt: shard.wc.entryClosesAt,
      endsAt: shard.wc.wipeAt,
      boss,
      nextBoss,
      serverId: this.deps.serverId,
      instanceId: this.deps.instanceId,
    };
  }

  /** raids/open: fast attempts inside openShard, then every OPEN_RETRY_MS until it lands or the wipe. */
  private async register(shard: Shard): Promise<void> {
    if (!this.deps.webConfigured()) return;
    const req = this.shardOpenRequest(shard);
    for (;;) {
      if (this.stopped || shard.room.disposed || this.deps.now() >= shard.wc.wipeAt) return;
      const r = await this.deps.openShard(req);
      if (r === "rejected") return;
      if (r) {
        shard.registered = true;
        return;
      }
      await this.sleepUntil(this.deps.now() + OPEN_RETRY_MS);
    }
  }

  // ---------------------------------------------------------------- admission

  /**
   * BattleRoom.onAuth: admit the ticket's entry into its shard, or throw a ServerError with a
   * WORLD_JOIN_ERR code. Returns once the raider stands on the map (or already did: rejoin).
   */
  async admit(t: JoinTicket): Promise<void> {
    const shard = t.matchId ? this.byMatch.get(t.matchId) : undefined;
    if (!shard) throw joinErr(410, WORLD_JOIN_ERR.MAP_GONE);
    const m = shard.room.match;
    if (m.ended || shard.room.disposed) throw joinErr(410, WORLD_JOIN_ERR.MAP_GONE);
    // Rejoin (reload, second tab): the user's current runtime is still on the map. No web call.
    const cur = m.currentOf(t.userId);
    if (cur?.pub.alive) return;
    if (!t.entryId) throw joinErr(401, WORLD_JOIN_ERR.INVALID_TICKET);
    // That entry already left the map; its exit is not applied on the web yet.
    if (m.entryById(t.entryId)) throw joinErr(409, WORLD_JOIN_ERR.EXIT_SETTLING);
    if (worldPhase(shard.wc, this.deps.now()) !== "open") throw joinErr(409, WORLD_JOIN_ERR.ENTRY_CLOSED);
    const running = shard.inflight.get(t.userId);
    if (running) {
      await running;
      return;
    }
    if (
      m.humansOnMap() + shard.inflight.size >= WORLD.CAPACITY ||
      m.allRuntimes().length >= WORLD.MAX_RUNTIMES_PER_SHARD - WORLD.RUNTIME_HEADROOM
    ) {
      throw joinErr(503, WORLD_JOIN_ERR.WORLD_FULL);
    }
    const p = this.runAdmission(shard, t, t.entryId);
    shard.inflight.set(t.userId, p);
    try {
      await p;
    } finally {
      if (shard.inflight.get(t.userId) === p) shard.inflight.delete(t.userId);
    }
  }

  private async runAdmission(shard: Shard, t: JoinTicket, entryId: string): Promise<void> {
    const m = shard.room.match;
    const req: EntryRequest = {
      matchId: shard.matchId,
      entryId,
      userId: t.userId,
      loadoutId: t.loadoutId,
      // The cycle clock (D7); the wall term covers a room that has not stepped yet (boot mid-cycle).
      atMs: Math.max(0, Math.min(WORLD.CYCLE_MS, Math.max(m.clock, this.deps.now() - shard.wc.startAt))),
      targets: m.poolTargetCount(),
      bossAlive: m.bossAlive(),
    };
    const res = await this.enter(req);
    if (!res) throw joinErr(503, WORLD_JOIN_ERR.WEB_UNAVAILABLE);
    if (res.status === "rejected") {
      switch (res.reason) {
        case "entry_limit":
          throw joinErr(409, WORLD_JOIN_ERR.ENTRY_LIMIT);
        case "already_active":
          throw joinErr(409, WORLD_JOIN_ERR.IN_RAID);
        case "shard_closed":
          throw joinErr(410, WORLD_JOIN_ERR.MAP_GONE);
        default:
          throw joinErr(409, WORLD_JOIN_ERR.LOADOUT_REJECTED, res.reason ?? "rejected");
      }
    }
    // Wiped while the web answered: the web entry is voided by raids/end (not in its entries list).
    if (m.ended || shard.room.disposed) throw joinErr(410, WORLD_JOIN_ERR.MAP_GONE);
    try {
      m.addHuman({
        entryId,
        userId: t.userId,
        nickname: t.nickname,
        loadoutId: res.snapshot ? t.loadoutId : "",
        guest: res.guest,
        level: res.level,
        snapshot: res.snapshot,
        pool: res.pool,
        bossFill: res.bossFill,
      });
    } catch (e) {
      console.error(`[world] admission ${shard.matchId}/${entryId}: addHuman failed:`, e);
      throw joinErr(503, WORLD_JOIN_ERR.WORLD_FULL);
    }
  }

  /** raids/enter, or (web not configured, dev only) a standalone free-kit admission. */
  private enter(req: EntryRequest): Promise<EntryResponse | null> {
    if (this.deps.webConfigured()) return this.deps.enterRaid(req);
    if (this.deps.production) return Promise.resolve(null);
    if (!this.warnedStandalone) {
      this.warnedStandalone = true;
      console.warn("[world] web API not configured: admitting entries standalone with free kits (nothing is settled)");
    }
    return Promise.resolve({ status: "accepted", snapshot: null, level: 0, guest: false, pool: [], bossFill: [], autosellMult: 1 });
  }
}

/** The process' directory (index.ts starts it after void-orphans; BattleRoom.onAuth admits through it). */
export const worldDirectory = new WorldDirectory();
