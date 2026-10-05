/**
 * WORLD v6 world directory (spec §3.2): the one place that opens, wipes and admits into the world's
 * shards. One shard = one Colyseus battle room = one Match = one matchId = one web raids row
 * (kind 'world'), per (cycle, shard index). All shards live in this one process (SCALING.md §9: a
 * shard costs ≈ 20–50 % of a vCPU at 20 Hz, so WORLD.MAX_SHARDS = 4 fit one game server).
 *
 * Overlapping maps (owner 05.10: nobody ever waits for a map). Cycle k's map opens at the entry close
 * of cycle k − 1 (worldCycleOf(k).openAt = wipeAt(k) − WORLD.MAP_MS) and wipes at its own wipeAt(k) on
 * the unchanged UTC grid, so exactly one cycle accepts entries at any instant and for ENTRY_CLOSE_MS
 * two cycles run side by side: k − 1 finishing for those already on it, k filling up. Timers run on
 * absolute world times (worldNow(), addendum A1) and recompute their delay when they fire:
 * - openAt(k + 1) − PREWARM_MS → open shard 0 of cycle k + 1 (its Match idles until its clock 0,
 *   the opening; entry to it opens exactly when entry to k closes);
 * - wipeAt(k)               → wipe every shard of cycle k (MIA, each its own report), then schedule
 *   cycle k + 1;
 * - wipeAt(k) + 60 s        → a room of cycle k still alive is force-disposed (logged).
 * Boot opens shard 0 of the cycle accepting entries at once (a fresh matchId and loot seed, the same
 * boss event; void-orphans has returned the previous process' gear by then). A cycle that was closing
 * at boot is not reopened (nobody could enter it).
 *
 * Several shards per cycle (on demand). While a cycle accepts entries, another shard of it opens as
 * soon as every shard it has is nearly full — fewer than WORLD.SPARE_SEATS free seats counting the
 * raiders on the map, admissions in flight and seats held for party drops — up to WORLD.MAX_SHARDS.
 * Opening a little before the last seat goes means the room and its raids/open row are ready when the
 * next player (or a whole party) arrives. The web's /api/world/join picks the shard (shared
 * pickWorldShard: the fullest one with room, players packed together); a world_full refusal here
 * also triggers the open, so the player's retry finds the new shard. Every shard of a cycle runs the
 * cycle's boss event on its own (same kind, its own instance and boss bag) and wipes with the cycle.
 *
 * Admission (`admit`, called by BattleRoom's static onAuth before any seat is reserved) runs the
 * checks of §3.2 and the web's raids/enter, then puts the raider on the map (Match.addHuman), so
 * the seat reservation that follows finds a living runtime. Errors are ServerErrors whose message
 * is a WORLD_JOIN_ERR code ("<code>" or "<code>:<detail>"). Capacity counts seat holders
 * (Match.seatHolders): connected humans and bodies without a client for less than WORLD.IDLE_SEAT_MS,
 * plus admissions in flight; a longer idle body stays on the map (rejoin always works) but frees its seat.
 * A rejoin goes to the ticket's own shard, whichever cycle it belongs to (a raider on the closing map
 * keeps playing it until its wipe).
 *
 * Party drops (shared party.ts, JoinTicket.dropId): the first admission of a dropId on a shard needs
 * room for the whole drop (its signed JoinTicket.dropSize; PARTY.MAX_SIZE for an older ticket without
 * one) and holds those seats for PARTY.DROP_TTL_MS, so a pair never blocks four seats; it is refused with "world_full:party" (PARTY_FULL_DETAIL) when the
 * shard cannot take them all. Later members of that drop take a held seat (no capacity refusal),
 * and every other admission counts the held seats as taken. Spawning together is the Match's
 * (spawn.ts pickDropSpawn). The web puts a new drop on a shard with room for the whole party.
 */

import { randomInt, randomUUID } from "node:crypto";
import { ServerError, matchMaker } from "@colyseus/core";
import {
  ALPHA_LOOT,
  PARTY,
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
  /** Wall ms of the map's opening (Match clock 0): worldCycleOf(cycle).startAt. */
  cycleStartsAt: number;
  /** Map clock when entry closes (MAP_MS − ENTRY_CLOSE_MS). */
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
  "ended" | "clock" | "map" | "eventBossSpot" | "currentOf" | "entryById" | "humansOnMap" | "seatHolders" | "allRuntimes" | "poolTargetCount" | "bossAlive" | "addHuman"
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
  /** Party drops admitted on this shard, by dropId (seats held for their members, see the module comment). */
  drops: Map<string, DropSeats>;
}

/** One party drop's seats on a shard. */
export interface DropSeats {
  partyId: string;
  /** World time of the drop's first admission: seats are held until firstAt + PARTY.DROP_TTL_MS. */
  firstAt: number;
  /** Members that took a seat of this drop (first member included). */
  users: Set<string>;
  /** Seats held for the drop: its signed JoinTicket.dropSize, PARTY.MAX_SIZE for a ticket without one. */
  size: number;
}

/** Seats a drop holds (JoinTicket.dropSize, clamped; PARTY.MAX_SIZE when the ticket has none). */
export function dropSeatCount(t: Pick<JoinTicket, "dropSize">): number {
  const n = t.dropSize;
  return typeof n === "number" && Number.isSafeInteger(n) ? Math.max(1, Math.min(PARTY.MAX_SIZE, n)) : PARTY.MAX_SIZE;
}

/** WORLD_JOIN_ERR.WORLD_FULL detail when the shard cannot take a whole party drop ("world_full:party"). */
export const PARTY_FULL_DETAIL = "party";

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

/**
 * ALPHA LOOT layer (packages/shared alpha-loot.ts) on world shards, either economy mode: on unless
 * ALPHA_LOOT is 0 / false / off / no; unset = ALPHA_LOOT.ENABLED (true). Off = the v4 loot exactly.
 */
export function alphaLootEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = env.ALPHA_LOOT?.trim().toLowerCase();
  if (!v) return ALPHA_LOOT.ENABLED;
  return !["0", "false", "off", "no"].includes(v);
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
  /** Shards of each cycle, by shard index (on-demand shards are appended). */
  private readonly byCycle = new Map<number, Shard[]>();
  private readonly byMatch = new Map<string, Shard>();
  /** Shards being created, keyed "cycle:idx". */
  private readonly opening = new Map<string, Promise<Shard | null>>();
  private readonly scheduled = new Set<number>();
  private readonly timers = new Set<unknown>();
  private stopped = false;
  private warnedStandalone = false;

  constructor(deps: Partial<DirectoryDeps> = {}) {
    this.deps = { ...defaultDirectoryDeps(), ...deps };
  }

  /** Boot: open shard 0 of the cycle accepting entries at once (even seconds before its entry closes), then run the timers. */
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

  /** Shard `idx` (default 0) of `cycle`, if open. */
  shardOfCycle(cycle: number, idx = 0): Shard | undefined {
    return this.byCycle.get(cycle)?.find((s) => s.idx === idx);
  }

  /** Every open shard of `cycle`, by index. */
  shardsOfCycle(cycle: number): readonly Shard[] {
    return this.byCycle.get(cycle) ?? [];
  }

  /** Shard 0 of the cycle accepting entries now, if open. */
  current(): Shard | undefined {
    return this.shardOfCycle(worldCycleAt(this.deps.now()).cycle);
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

  /**
   * Open cycle k + 1 (prewarmed PREWARM_MS before it opens, i.e. before entry to k closes), wipe k,
   * hard-stop k (once per cycle).
   */
  private schedule(k: number): void {
    if (this.scheduled.has(k) || this.stopped) return;
    this.scheduled.add(k);
    const wc = worldCycleOf(k);
    const next = worldCycleOf(k + 1);
    this.at(next.openAt - WORLD.PREWARM_MS, () => this.openShard(k + 1), `prewarm cycle ${k + 1}`);
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

  /** Wipe every shard of cycle k now (idempotent: the Match ignores a second wipe). */
  wipe(k: number): void {
    for (const shard of this.shardsOfCycle(k)) {
      if (shard.room.disposed) continue;
      console.log(`[world] wipe cycle ${k} shard ${shard.idx} (${shard.matchId}): ${shard.room.match.humansOnMap()} on the map`);
      shard.room.wipe();
    }
  }

  private async hardStop(k: number): Promise<void> {
    this.scheduled.delete(k);
    const shards = this.shardsOfCycle(k);
    this.byCycle.delete(k);
    for (const shard of shards) {
      this.byMatch.delete(shard.matchId);
      if (!shard.room.disposed) {
        console.error(`[world] cycle ${k} shard ${shard.idx} room ${shard.roomId} (${shard.matchId}) still alive ${HARD_STOP_AFTER_MS / 1000} s after its wipe: disposing`);
        await shard.room.forceDispose();
      }
    }
  }

  // ---------------------------------------------------------------- shards

  /** Open (create + register) shard `idx` of `cycle`; concurrent and repeated calls share one shard. */
  openShard(cycle: number, idx = 0): Promise<Shard | null> {
    const have = this.shardOfCycle(cycle, idx);
    if (have) return Promise.resolve(have);
    const key = `${cycle}:${idx}`;
    let p = this.opening.get(key);
    if (!p) {
      p = this.createShard(cycle, idx).finally(() => this.opening.delete(key));
      this.opening.set(key, p);
    }
    return p;
  }

  private async createShard(cycle: number, idx: number): Promise<Shard | null> {
    const wc = worldCycleOf(cycle);
    if (this.stopped || this.deps.now() >= wc.wipeAt) return null;
    const world: WorldCreateOptions = {
      matchId: randomUUID(),
      cycleId: cycle,
      shard: idx,
      cycleStartsAt: wc.startAt,
      entryCloseMs: WORLD.MAP_MS - WORLD.ENTRY_CLOSE_MS,
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
      // Shard 0 is the cycle's map: retried while the cycle lasts. An on-demand shard is opened again
      // by the next admission that finds the cycle full.
      console.error(`[world] cycle ${cycle} shard ${idx}: creating the battle room failed${idx === 0 ? ` (retry in ${CREATE_RETRY_MS / 1000} s)` : ""}:`, e);
      if (idx === 0) this.at(this.deps.now() + CREATE_RETRY_MS, () => this.openShard(cycle), `reopen cycle ${cycle}`);
      return null;
    }
    const shard: Shard = {
      cycle,
      idx,
      wc,
      matchId: world.matchId,
      roomId: created.roomId,
      room: created.room,
      mode: world.mode,
      matchSeed: world.matchSeed,
      registered: false,
      inflight: new Map(),
      drops: new Map(),
    };
    const list = [...this.shardsOfCycle(cycle), shard].sort((a, b) => a.idx - b.idx);
    this.byCycle.set(cycle, list);
    this.byMatch.set(shard.matchId, shard);
    console.log(`[world] cycle ${cycle} shard ${shard.idx} open: room ${shard.roomId}, match ${shard.matchId}, ${world.mode}, boss ${world.bossEvent ?? "none"}`);
    void this.register(shard).catch((e) => console.error(`[world] raids/open ${shard.matchId} failed:`, e));
    return shard;
  }

  /**
   * Seats a shard counts as taken for the on-demand open: raiders on the map (idle bodies too, like
   * the web's active-entry count that picks shards), admissions in flight, seats held for party drops.
   */
  shardLoad(shard: Shard): number {
    return shard.room.match.humansOnMap() + shard.inflight.size + this.heldSeats(shard, this.deps.now());
  }

  /**
   * On-demand shards (module comment): while `cycle` accepts entries and fewer than MAX_SHARDS of it
   * exist, open the next one once every live shard of it has fewer than SPARE_SEATS free seats. One
   * open at a time per cycle. Returns that opening (tests), or null when nothing was opened.
   */
  ensureRoom(cycle: number): Promise<Shard | null> | null {
    if (this.stopped || worldPhase(worldCycleOf(cycle), this.deps.now()) !== "open") return null;
    const shards = this.shardsOfCycle(cycle);
    if (shards.length === 0 || shards.length >= WORLD.MAX_SHARDS) return null;
    for (const key of this.opening.keys()) if (key.startsWith(`${cycle}:`)) return null;
    for (const s of shards) {
      if (s.room.disposed || s.room.match.ended) continue;
      if (WORLD.CAPACITY - this.shardLoad(s) >= WORLD.SPARE_SEATS) return null;
    }
    const idx = shards[shards.length - 1]!.idx + 1;
    if (idx >= WORLD.MAX_SHARDS) return null;
    console.log(`[world] cycle ${cycle}: every shard is nearly full, opening shard ${idx}`);
    return this.openShard(cycle, idx);
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
    let seat: DropSeats | null;
    try {
      seat = this.takeSeat(shard, t);
    } catch (e) {
      // world_full: open another shard of the cycle when allowed, so the retry finds room there.
      void this.ensureRoom(shard.cycle);
      throw e;
    }
    const p = this.runAdmission(shard, t, t.entryId);
    shard.inflight.set(t.userId, p);
    // Counted with the admission in flight: the next shard opens while this player is still entering.
    void this.ensureRoom(shard.cycle);
    try {
      await p;
    } catch (e) {
      // A refused member gives the drop's seat back (a refused first member: the whole drop).
      if (seat) {
        seat.users.delete(t.userId);
        if (seat.users.size === 0) shard.drops.delete(t.dropId!);
      }
      throw e;
    } finally {
      if (shard.inflight.get(t.userId) === p) shard.inflight.delete(t.userId);
    }
  }

  /** Seats held for party drops on a shard (expired drops are forgotten). */
  private heldSeats(shard: Shard, now: number): number {
    let held = 0;
    for (const [id, d] of shard.drops) {
      if (now - d.firstAt > PARTY.DROP_TTL_MS) shard.drops.delete(id);
      else held += Math.max(0, d.size - d.users.size);
    }
    return held;
  }

  /**
   * Capacity of one admission (module comment): throws world_full / world_full:party, or returns the
   * drop whose seat this admission took (null: a solo seat or a member already counted in the drop).
   */
  private takeSeat(shard: Shard, t: JoinTicket): DropSeats | null {
    const m = shard.room.match;
    const now = this.deps.now();
    const held = this.heldSeats(shard, now);
    // Seat holders, not every living body: a body idle past WORLD.IDLE_SEAT_MS no longer blocks entry.
    const humans = m.seatHolders() + shard.inflight.size;
    const runtimes = m.allRuntimes().length;
    const runtimeCap = WORLD.MAX_RUNTIMES_PER_SHARD - WORLD.RUNTIME_HEADROOM;
    const dropId = t.partyId ? t.dropId : undefined;
    const drop = dropId ? shard.drops.get(dropId) : undefined;
    if (dropId && drop && drop.partyId === t.partyId && !drop.users.has(t.userId) && drop.users.size < drop.size) {
      // A seat held for this drop since its first member: only the hard runtime cap still applies.
      if (runtimes >= runtimeCap) throw joinErr(503, WORLD_JOIN_ERR.WORLD_FULL);
      drop.users.add(t.userId);
      return drop;
    }
    if (dropId && !drop) {
      // The drop's first member: the whole party has to fit, or nobody of it is admitted here.
      const size = dropSeatCount(t);
      if (humans + held + size > WORLD.CAPACITY || runtimes + held + size > runtimeCap) {
        throw joinErr(503, WORLD_JOIN_ERR.WORLD_FULL, PARTY_FULL_DETAIL);
      }
      const seats: DropSeats = { partyId: t.partyId!, firstAt: now, users: new Set([t.userId]), size };
      shard.drops.set(dropId, seats);
      return seats;
    }
    if (humans + held >= WORLD.CAPACITY || runtimes + held >= runtimeCap) {
      throw joinErr(503, WORLD_JOIN_ERR.WORLD_FULL);
    }
    return null;
  }

  private async runAdmission(shard: Shard, t: JoinTicket, entryId: string): Promise<void> {
    const m = shard.room.match;
    const req: EntryRequest = {
      matchId: shard.matchId,
      entryId,
      userId: t.userId,
      loadoutId: t.loadoutId,
      // The map clock (D7, 0 = the map's opening); the wall term covers a room that has not stepped yet.
      atMs: Math.max(0, Math.min(WORLD.MAP_MS, Math.max(m.clock, this.deps.now() - shard.wc.startAt))),
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
        ...(t.partyId ? { partyId: t.partyId, ...(t.dropId ? { dropId: t.dropId } : {}) } : {}),
        ...(t.tutorial ? { tutorial: true } : {}),
        ...(t.skin ? { skin: t.skin } : {}),
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
