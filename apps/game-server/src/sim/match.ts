/**
 * Colyseus-independent simulation of one match. Owns a BattleState and advances it with
 * step(dtMs); the room only feeds intents in and forwards drained events out. All randomness goes
 * through `rng` and all item ids through `newUid`, so tests run whole matches deterministically
 * without a network.
 *
 * Tick order inside step() (later WPs fill the hooks, never the structure):
 *   bots → reload/heal timers → inputs (stepMovement, fire) → stepSearches → bullets → pickups →
 *   extraction → velocities → disclosure → vision.update → aoi.update → deliverSounds → counters →
 *   syncPublic → held exit reports
 * The room then runs syncViews → broadcastPatch → per-client `ev` batches (battle-room.ts).
 */

import { randomInt, randomUUID } from "node:crypto";
import {
  BattleState,
  Extract,
  FLOOR_LOOT,
  INPUT_DT_MS,
  MATCH,
  MAX_QUEUED_INPUTS,
  NPC_ROLE,
  PLAYER,
  Player,
  SOLID,
  SelfState,
  SoundKind,
  accepts,
  bagKeys,
  bpLevelOf,
  MAP_IDS,
  extractMask,
  generateMap,
  hasLineOfSight,
  healSpeedMult,
  isBagKey,
  isSlotKey,
  itemDef,
  junkCredits,
  legacyMapData,
  mulberry32,
  readRoll,
  pickWeighted,
  rollBossSpawns,
  rollFloorLoot,
  sanitizeInput,
  selfKeyOf,
  stepMovement,
  terrainAt,
  terrainSpeedMult,
  writeRoll,
  dogTagCr,
  type BushIndex,
  type CollisionIndex,
  type BossSpot,
  type ExitType,
  type HealKind,
  type InvDropMsg,
  type InvErrCode,
  type InvMoveMsg,
  type ItemLike,
  type LoadoutSnapshot,
  type MapData,
  type MapId,
  type MapSide,
  type MatchEndReport,
  type OutcomeMsg,
  type PlayerExitReport,
  type RaidMode,
  type Rng,
  type SettledItem,
  type SoldLine,
} from "@extract/shared";
import { cancelHeal, cancelReload, finishHealIfDue, finishReloadIfDue, startHeal, startReload, switchSlot } from "./actions.js";
import { AoiSystem } from "./aoi.js";
import { Disclosure } from "./disclosure.js";
import { fixActive, giveFreeKit, moveOwn, removeForDrop, syncPublic, takeOpToken } from "./bag.js";
import { BotBrain } from "./bot.js";
import { BossSystem, bossNpcCount, type NpcSpawn } from "./boss.js";
import { stepBullets, tryFire } from "./combat.js";
import { ContainerSystem, closeSearch, invTakeAllOp, invTakeOp, stepSearches } from "./containers.js";
import { envNow, initEnvironment, type EnvRuntime } from "./environment.js";
import { stepExtraction, timeoutPlayer } from "./extraction.js";
import { GroundStore, autoPickup, dropSpot, groundUniques, nearestGroundItem, pickupGround, spawnGroundItem } from "./inventory.js";
import { Ledger, cloneItem, makeItem, toSettled } from "./items.js";
import { deliverSounds, emitSound, footstep } from "./sound.js";
import type { Bullet, LoadoutMap, MatchEvent, PlayerRuntime, RosterEntry } from "./types.js";
import { VisionSystem, followAim } from "./vision.js";
import { mapRuntime, warmMap, type MapRuntime } from "./nav.js";
import { PathPlanner } from "./planner.js";

// ---------------------------------------------------------------- map boot (WP-M2 owns this section)

/**
 * Which map matches run on. "steppe" (default) is the fixed v2 layout, built once per process at
 * boot (warmMatchMap) and shared by every room. "legacy" is the v1 4800 px seed-driven layout in
 * the v2 MapData shape, kept for tests and tooling that need a small map: pick it per match with
 * MatchOptions.mapId or process-wide with EXTRACT_MATCH_MAP=legacy (never in production — the web
 * client only knows the Steppe and its join would be refused by the mapHash check).
 */
export type MatchMapChoice = MapId | "legacy";

export function defaultMapChoice(): MatchMapChoice {
  const env = process.env.EXTRACT_MATCH_MAP;
  if (env === "legacy") return "legacy";
  return env && (MAP_IDS as readonly string[]).includes(env) ? (env as MapId) : "steppe";
}

/** The map of a match: the fixed layout for a MapId, or the legacy layout of `matchSeed`. */
export function matchMap(matchSeed: number, choice: MatchMapChoice = defaultMapChoice()): MapData {
  return choice === "legacy" ? legacyMapData(matchSeed) : generateMap(choice);
}

/**
 * Process boot: build everything static of the configured map (MapData, collision + walls index,
 * walk grid, region graph, bush index) so no room creation or tick ever pays for it. Returns null
 * for "legacy" (its layout depends on the match seed; it is small and built at room creation).
 */
export function warmMatchMap(choice: MatchMapChoice = defaultMapChoice()): MapRuntime | null {
  if (choice === "legacy") return null;
  return warmMap(choice);
}

/**
 * mapHash the clients of this process must send on join (BattleJoinOptions.mapHash), or null when
 * matches run the seed-dependent legacy map (no single hash; the check is skipped).
 */
export function expectedMapHash(choice: MatchMapChoice = defaultMapChoice()): string | null {
  return warmMatchMap(choice)?.hash ?? null;
}

/** Players per match (humans + bots): the Steppe has 40 side spawns for MATCH.MAX_PLAYERS. */
export const MATCH_PLAYERS = MATCH.MAX_PLAYERS;
/** v1 count for whole-match tests on the legacy map (≤ 24 spawn spots on 4800 px). */
export const LEGACY_MATCH_PLAYERS = 16;

// ---------------------------------------------------------------- match

/**
 * Most movement time a player can bank while sending nothing. Spending is capped by real time
 * elapsed, so on average nobody moves faster than PLAYER.SPEED; this bounds the catch-up burst
 * after a network hiccup to ~6 inputs.
 */
export const MAX_ALLOWANCE_MS = 200;
/** A frozen event loop must not turn into one giant simulation step. */
const MAX_STEP_MS = 250;


/** v1 floor loot of maps without zones (the legacy 4800 px test layout; its whole-match tests are tuned to it). */
const LEGACY_FLOOR_LOOT = [
  { def: "ammo_light", qty: 30, weight: 36 },
  { def: "ammo_shell", qty: 10, weight: 18 },
  { def: "ammo_heavy", qty: 10, weight: 8 },
  { def: "bandage", qty: 2, weight: 22 },
  { def: "medkit", qty: 1, weight: 6 },
];

export interface MatchOptions {
  roster: RosterEntry[];
  rng?: Rng;
  /** Match seed: loot rolls (and the legacy map layout). */
  mapSeed?: number;
  /** Map to run on (default: defaultMapChoice(), i.e. the Steppe unless EXTRACT_MATCH_MAP says otherwise). */
  mapId?: MatchMapChoice;
  /** Tests: a hand-made map instead of matchMap(mapSeed, mapId). */
  map?: MapData;
  newUid?: () => string;
  now?: () => number;
  /** Bots get a BotBrain (default true). Rule tests drive bot players by hand. */
  botBrains?: boolean;
  /** Skip extracts / floor loot from the map (rule tests place their own). */
  emptyWorld?: boolean;
  matchId?: string;
  /** "demo" (default): the server mints container uniques itself. "live": uniques only from loadouts + pool. */
  mode?: RaidMode;
  /** raids/start accepted loadouts (by userId, or as the response array). */
  loadouts?: LoadoutMap | readonly LoadoutSnapshot[];
  /** raids/start lost-pool allocation by container index. */
  containerLoot?: Readonly<Record<string, SettledItem[]>>;
  /** Throw on ledger violations (tests). Production logs them instead. */
  strictLedger?: boolean;
  envSeed?: number;
  weatherOverride?: string;
  /**
   * Spawn the map's bosses and guards (rollBossSpawns(mapSeed, map.bosses), boss.ts). Default: on
   * unless emptyWorld. Pool items for bosses come in containerLoot["boss:<kind>"].
   */
  bosses?: boolean;
}

export class Match {
  readonly state = new BattleState();
  readonly map: MapData;
  readonly idx: CollisionIndex;
  readonly bushIndex: BushIndex;
  /** Static map runtime shared by every room on this map (walk grid, regions, indexes). */
  readonly mapRt: MapRuntime;
  /** Bot path planning (region graph, 2 ms per tick budget). */
  readonly planner: PathPlanner;
  rng: Rng;
  readonly newUid: () => string;
  readonly now: () => number;
  readonly mode: RaidMode;
  readonly ledger: Ledger;
  readonly ground: GroundStore;
  readonly containers: ContainerSystem;
  readonly vision: VisionSystem;
  readonly aoi = new AoiSystem();
  /** Player-made world changes waiting to go public (disclosure.ts). */
  readonly disclosure: Disclosure = new Disclosure(this);
  readonly env: EnvRuntime;
  /** Extract id → bit index in SelfState.extractMask (MapData.extracts order). */
  readonly extractBit = new Map<string, number>();
  bullets: Bullet[] = [];
  readonly bots: BotBrain[] = [];
  /** Bosses and their guards (NPC runtimes after the roster; their brains are not in `bots`). */
  readonly bosses: BossSystem;
  /** Exit reports of every participant (humans are also emitted as `exit` events), in exit order. */
  readonly exitReports: PlayerExitReport[] = [];

  private readonly runtimes = new Map<string, PlayerRuntime>();
  private readonly ordered: PlayerRuntime[] = [];
  private events: MatchEvent[] = [];
  private readonly hasHumans: boolean;
  report: MatchEndReport | null = null;

  constructor(opts: MatchOptions) {
    this.rng = opts.rng ?? mulberry32(randomInt(0, 2 ** 32 - 1));
    this.newUid = opts.newUid ?? randomUUID;
    this.now = opts.now ?? Date.now;
    this.mode = opts.mode ?? "demo";
    this.ledger = new Ledger(opts.strictLedger ?? false);
    const seed = (opts.mapSeed ?? Math.floor(this.rng() * 2 ** 32)) >>> 0;

    this.map = opts.map ?? matchMap(seed, opts.mapId);
    // Room creation at the latest (process boot for the Steppe): nothing static is built in a tick.
    this.mapRt = mapRuntime(this.map);
    this.idx = this.mapRt.idx;
    this.bushIndex = this.mapRt.bushIndex;
    this.planner = new PathPlanner(this.mapRt.regions, () => this.state.clockMs);
    this.ground = new GroundStore(this.map.width, this.map.height);
    this.map.extracts.forEach((e, i) => this.extractBit.set(e.id, i));

    this.state.matchId = opts.matchId ?? this.newUid();
    this.state.mapId = this.map.id;
    this.state.mapSeed = seed;
    this.state.phase = "drop";
    this.state.startedAt = this.now();
    this.state.clockMs = 0;
    this.state.durationMs = MATCH.DURATION_MS;
    this.env = initEnvironment(this, opts.envSeed ?? Math.floor(this.rng() * 2 ** 32) >>> 0, opts.weatherOverride ?? "");
    this.hasHumans = opts.roster.some((r) => !r.isBot);
    // Bosses are rolled from the match seed alone (the matchmaking room made the same roll for raids/start).
    const bossSpawns: BossSpot[] = (opts.bosses ?? !opts.emptyWorld) ? rollBossSpawns(seed, this.map.bosses) : [];
    this.vision = new VisionSystem(opts.roster.length + bossNpcCount(bossSpawns));
    this.containers = new ContainerSystem(this);
    this.bosses = new BossSystem(this);
    if (opts.containerLoot && this.mode === "live") this.containers.allocatePool(opts.containerLoot);

    if (!opts.emptyWorld) this.setupWorld();
    this.setupPlayers(opts.roster, opts.botBrains ?? true, loadoutMap(opts.loadouts));
    this.setupBosses(bossSpawns, opts.botBrains ?? true);
    this.updateCounters();
  }

  get clock(): number {
    return this.state.clockMs;
  }

  get ended(): boolean {
    return this.report !== null;
  }

  emit(e: MatchEvent): void {
    this.events.push(e);
  }

  drainEvents(): MatchEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  runtime(id: string): PlayerRuntime | undefined {
    return this.runtimes.get(id);
  }

  rosterRuntime(rosterIndex: number): PlayerRuntime | undefined {
    return this.ordered[rosterIndex];
  }

  allRuntimes(): readonly PlayerRuntime[] {
    return this.ordered;
  }

  player(id: string): Player | undefined {
    return this.state.players.get(id);
  }

  // ---------------------------------------------------------------- setup

  private setupWorld(): void {
    // A map that schedules its own closes (the Steppe: N2 / S2 at 25:00) is authoritative, so every
    // side keeps an always-open allowed extract; only maps without any (legacy) get a random half.
    const mapSchedules = this.map.extracts.some((e) => e.closesAtMs !== undefined);
    const closing = new Set(
      mapSchedules ? [] : shuffle(this.rng, this.map.extracts.map((_, i) => i)).slice(
        0,
        Math.floor(this.map.extracts.length * MATCH.EXTRACT_CLOSE_EARLY_FRACTION),
      ),
    );
    this.map.extracts.forEach((spot, i) => {
      const e = new Extract();
      e.id = spot.id;
      e.x = spot.x;
      e.y = spot.y;
      e.r = spot.r;
      e.openAt = MATCH.EXTRACT_OPEN_AT_MS;
      e.closeAt = spot.closesAtMs ?? (closing.has(i) ? Math.round(MATCH.DURATION_MS * MATCH.EXTRACT_CLOSE_EARLY_AT) : 0);
      this.state.extracts.set(e.id, e);
    });

    for (const spot of this.map.lootSpots) {
      const it = this.rollFloorLoot(spot.tier);
      if (it) spawnGroundItem(this, it, spot.x, spot.y);
    }
  }

  /**
   * Floor loot of one loot spot (v4 zoning, shared FLOOR_LOOT): most spots stay empty, the rest roll
   * their tier's table (wilds almost nothing, medkits only on T3/T4 spots). Demo mode: a common gun
   * with DEMO_GUN_CHANCE, only on spots of tier >= DEMO_GUN_MIN_TIER. Maps without zones (the v1
   * legacy test layout) keep the v1 flat table and demo gun.
   */
  private rollFloorLoot(tier: number): ItemLike | null {
    // A map without zones (the v1 legacy test layout, every spot "tier 1") has no zoning: v1 rules.
    const zoneless = this.map.zones.length === 0;
    if (this.mode === "demo" && (zoneless || tier >= FLOOR_LOOT.DEMO_GUN_MIN_TIER) && this.rng() < FLOOR_LOOT.DEMO_GUN_CHANCE) {
      const it = makeItem(this.rng() < 0.55 ? "rifle" : "shotgun", { uid: this.newUid(), rarity: 0 });
      this.ledger.register(it, "minted");
      return it;
    }
    const roll = zoneless ? pickWeighted(this.rng, LEGACY_FLOOR_LOOT) : rollFloorLoot(this.rng, tier);
    return roll ? makeItem(roll.def, { qty: roll.qty }) : null;
  }

  private setupPlayers(roster: RosterEntry[], botBrains: boolean, loadouts: LoadoutMap): void {
    const spawns = assignSpawns(this.rng, this.map.spawns, roster.map((r) => !r.isBot));
    const colors = shuffle(this.rng, Array.from({ length: Math.max(16, roster.length) }, (_, i) => i));
    const used = new Map<string, number>();
    const allMask = (1 << Math.min(8, this.map.extracts.length)) - 1;
    // Tarkov rule (map memo §6): never your own side's extracts. A map whose extracts leave a side
    // with none (hand-made test maps, the legacy layout) falls back to every extract.
    const maskOf = (side: MapSide) => extractMask(this.map, side) || allMask;
    roster.forEach((entry, i) => {
      const id = entry.isBot ? `bot${i}` : `pending${i}`;
      const spawn = spawns[i] ?? { x: this.map.width / 2, y: this.map.height / 2, side: 0 as MapSide };
      // More players than spawn spots: spread the ones sharing a spot out a little.
      const k = `${spawn.x},${spawn.y}`;
      const lap = used.get(k) ?? 0;
      used.set(k, lap + 1);
      const p = new Player();
      p.sessionId = id;
      p.nickname = entry.nickname;
      p.color = colors[i]! % 256;
      p.x = spawn.x + lap * 60;
      p.y = spawn.y;
      p.hp = PLAYER.MAX_HP;
      p.alive = true;
      const s = new SelfState();
      s.userId = entry.userId ?? "";
      s.isBot = entry.isBot;
      s.side = spawn.side;
      s.extractMask = maskOf(spawn.side);
      const selfKey = selfKeyOf(i);
      this.state.players.set(id, p);
      this.state.self.set(selfKey, s);

      const snap = entry.userId ? loadouts.get(entry.userId) : undefined;
      const rt = newRuntime(id, i, selfKey, entry, p, s, snap);
      if (snap) this.loadLoadout(rt, snap);
      giveFreeKit(rt);
      syncPublic(rt);
      this.runtimes.set(id, rt);
      this.ordered.push(rt);
      if (entry.isBot && botBrains) this.bots.push(new BotBrain(this, rt));
    });
  }

  // ---------------------------------------------------------------- bosses (loot economy v4, boss.ts)

  /**
   * Boss groups after the roster: each NPC gets the next roster index (vision / sound / views are
   * all by roster index), a Player with role / maxHp, no free kit (boss.ts equips it), no extract
   * mask (NPCs never extract), and a BotBrain with its NpcInfo (kept in bosses.brains).
   */
  private setupBosses(spawned: readonly BossSpot[], botBrains: boolean): void {
    if (spawned.length === 0) return;
    const add = (n: NpcSpawn): PlayerRuntime => {
      const i = this.ordered.length;
      const id = `bot${i}`;
      const p = new Player();
      p.sessionId = id;
      p.nickname = n.nickname;
      p.color = i % 256;
      p.x = n.x;
      p.y = n.y;
      p.hp = PLAYER.MAX_HP;
      p.alive = true;
      const s = new SelfState();
      s.isBot = true;
      s.extractMask = 0;
      const selfKey = selfKeyOf(i);
      this.state.players.set(id, p);
      this.state.self.set(selfKey, s);
      const rt = newRuntime(id, i, selfKey, { userId: null, nickname: n.nickname, isBot: true }, p, s, undefined);
      this.runtimes.set(id, rt);
      this.ordered.push(rt);
      return rt;
    };
    this.bosses.spawn(spawned, add, botBrains ? (rt, info) => new BotBrain(this, rt, info) : null);
  }

  /**
   * Put an accepted loadout into the slots (equipment first so the bag level is known). raids/start
   * already validated it; entries that still do not fit are logged and skipped, never invented.
   */
  private loadLoadout(rt: PlayerRuntime, snap: LoadoutSnapshot): void {
    const s = rt.self.slots;
    const equipFirst = [...snap.entries].sort((a, b) => Number(isBagKey(a.key) || a.key.startsWith("p")) - Number(isBagKey(b.key) || b.key.startsWith("p")));
    for (const e of equipFirst) {
      const d = itemDef(e.def);
      const ok = d && isSlotKey(e.key) && accepts(e.key, d) && !s.get(e.key) &&
        (!isBagKey(e.key) || bagKeys(bpLevelOf(s)).includes(e.key)) && (!d.unique || !!e.uid);
      if (!ok) {
        console.error(`[match ${this.state.matchId}] loadout ${snap.loadoutId}: skipped ${e.def} at ${e.key}`);
        continue;
      }
      const it = makeItem(e.def, { uid: e.uid, qty: e.qty, rarity: e.rarity, dur: e.dur, label: e.label, lvl: e.lvl });
      if (d.unique) this.ledger.register(it, "loadout");
      s.set(e.key, cloneItem(it));
    }
    fixActive(rt);
  }

  // ---------------------------------------------------------------- connections

  /**
   * A human (re)connects: their roster player is re-keyed to the client's sessionId (the same
   * Player instance; the self entry key p<rosterIndex> never changes). The input seq restarts.
   */
  attachHuman(userId: string, sessionId: string): PlayerRuntime | null {
    const rt = this.ordered.find((r) => !r.isBot && r.userId === userId);
    if (!rt) return null;
    if (rt.id !== sessionId) {
      this.state.players.delete(rt.id);
      this.runtimes.delete(rt.id);
      rt.pub.sessionId = sessionId;
      rt.id = sessionId;
      this.state.players.set(sessionId, rt.pub);
      this.runtimes.set(sessionId, rt);
    }
    rt.connected = true;
    rt.queue.length = 0;
    rt.lastQueuedSeq = -1;
    rt.triggerHeld = false;
    rt.pressPending = false;
    rt.self.lastSeq = 0;
    return rt;
  }

  /** Disconnected players stay on the map, idle and vulnerable (their search closes). */
  detach(sessionId: string): void {
    const rt = this.runtimes.get(sessionId);
    if (!rt) return;
    rt.connected = false;
    rt.queue.length = 0;
    rt.triggerHeld = false;
    rt.pressPending = false;
    closeSearch(this, rt, "disconnect");
  }

  // ---------------------------------------------------------------- intents

  enqueueInput(id: string, raw: unknown): boolean {
    const rt = this.runtimes.get(id);
    if (!rt || !rt.pub.alive || this.ended) return false;
    const input = sanitizeInput(raw);
    if (!input || input.seq <= rt.lastQueuedSeq) return false;
    rt.lastQueuedSeq = input.seq;
    rt.queue.push(input);
    if (rt.queue.length > MAX_QUEUED_INPUTS) rt.queue.splice(0, rt.queue.length - MAX_QUEUED_INPUTS);
    return true;
  }

  /**
   * Bots: F on one specific ground item (range + line of sight as for F), never on whatever else
   * happens to be nearest (Match.interact prefers containers and would open one instead).
   */
  pickupItem(id: string, groundId: string): boolean {
    const rt = this.actor(id);
    const g = this.ground.byId.get(groundId);
    if (!rt || !g) return false;
    const p = rt.pub;
    if ((g.schema.x - p.x) ** 2 + (g.schema.y - p.y) ** 2 > PLAYER.INTERACT_RADIUS ** 2) return false;
    if (!hasLineOfSight(this.idx, p.x, p.y, g.schema.x, g.schema.y, SOLID.MOVE)) return false;
    return pickupGround(this, rt, g);
  }

  /** Bots: open one specific search target (loot key c<idx> / k<corpse>) if it is in reach. */
  openSearch(id: string, key: string): boolean {
    const rt = this.actor(id);
    return rt ? this.containers.openKey(rt, key) : false;
  }

  /** F: the nearest untouched container wins over loose items (inventory memo §2.2). */
  interact(id: string): boolean {
    const rt = this.actor(id);
    if (!rt) return false;
    const c = this.containers.nearestOpenable(rt);
    if (c >= 0) {
      this.containers.open(rt, c);
      return true;
    }
    const g = nearestGroundItem(this, rt);
    if (!g) return false;
    if (pickupGround(this, rt, g)) return true;
    this.invErr(rt, "full");
    return false;
  }

  reload(id: string): boolean {
    const rt = this.actor(id);
    return rt ? startReload(this, rt) : false;
  }

  switchSlot(id: string, slot: "w1" | "w2"): boolean {
    const rt = this.actor(id);
    return rt ? switchSlot(rt, slot, this) : false;
  }

  heal(id: string, kind: HealKind): boolean {
    const rt = this.actor(id);
    return rt ? startHeal(this, rt, kind) : false;
  }

  searchClose(id: string): void {
    const rt = this.actor(id);
    if (rt) closeSearch(this, rt, "close");
  }

  /** INV_MOVE. Returns the error code (also sent as INV_ERR) or null on success. */
  invMove(id: string, msg: InvMoveMsg): InvErrCode | null {
    // Takes from a search session live in containers.ts (one API for the room, bots and tests).
    if (msg.from === "loot") return invTakeOp(this, id, msg);
    const rt = this.actor(id);
    if (!rt) return "dead";
    if (!takeOpToken(rt, this.clock)) return this.invErr(rt, "rate");
    const r = moveOwn(rt, msg);
    if (r.code) return this.invErr(rt, r.code, msg.key);
    if (r.touchedActive) cancelReload(rt);
    syncPublic(rt);
    return null;
  }

  /** INV_TAKE_ALL from the current search session (one rate token for the whole batch). */
  invTakeAll(id: string): InvErrCode | null {
    return invTakeAllOp(this, id);
  }

  /** INV_DROP: own item → ground at the feet (FREE items just vanish). */
  invDrop(id: string, msg: InvDropMsg): InvErrCode | null {
    const rt = this.actor(id);
    if (!rt) return "dead";
    if (!takeOpToken(rt, this.clock)) return this.invErr(rt, "rate");
    const r = removeForDrop(rt, msg);
    if ("code" in r) return this.invErr(rt, r.code, msg.key);
    if (r.touchedActive) cancelReload(rt);
    if (r.item) {
      const at = dropSpot(this, rt.pub.x, rt.pub.y, Math.floor(this.rng() * 12));
      spawnGroundItem(this, r.item, at.x, at.y, rt);
    }
    syncPublic(rt);
    return null;
  }

  private invErr(rt: PlayerRuntime, code: InvErrCode, key?: string): InvErrCode {
    if (!rt.isBot) this.emit({ type: "invErr", to: rt.rosterIndex, msg: key === undefined ? { code } : { code, key } });
    return code;
  }

  private actor(id: string): PlayerRuntime | undefined {
    if (this.ended) return undefined;
    const rt = this.runtimes.get(id);
    return rt?.pub.alive ? rt : undefined;
  }

  // ---------------------------------------------------------------- simulation

  step(dtMs: number): void {
    if (this.ended) return;
    const dt = Math.max(0, Math.min(MAX_STEP_MS, dtMs));
    this.state.clockMs = Math.min(this.clock + dt, MATCH.DURATION_MS);
    const phase = this.clock >= MATCH.EXTRACT_OPEN_AT_MS ? "open" : "drop";
    if (this.state.phase !== phase) this.state.phase = phase;
    // Sample the environment once per tick; vision / sound / audience read the cached sample.
    envNow(this);

    for (const rt of this.ordered) {
      rt.prevX = rt.pub.x;
      rt.prevY = rt.pub.y;
    }
    for (const bot of this.bots) bot.update(dt);
    this.bosses.update(dt);

    for (const rt of this.ordered) {
      if (!rt.pub.alive) continue;
      finishReloadIfDue(this, rt);
      finishHealIfDue(this, rt);
      this.applyInputs(rt, dt);
    }

    stepSearches(this);
    stepBullets(this, dt);

    for (const rt of this.ordered) if (rt.pub.alive) autoPickup(this, rt);

    stepExtraction(this);

    for (const rt of this.ordered) {
      rt.vx = dt > 0 ? ((rt.pub.x - rt.prevX) * 1000) / dt : 0;
      rt.vy = dt > 0 ? ((rt.pub.y - rt.prevY) * 1000) / dt : 0;
    }
    this.disclosure.step();
    this.vision.update(this);
    this.aoi.update(this);
    deliverSounds(this);
    this.updateCounters();
    for (const rt of this.ordered) syncPublic(rt);
    this.releaseHeldExits();

    let humansAlive = false;
    let anyAlive = false;
    for (const rt of this.ordered) {
      // Bosses and guards never leave: they do not keep a bots-only match running.
      if (!rt.pub.alive || rt.pub.role !== NPC_ROLE.NONE) continue;
      anyAlive = true;
      if (!rt.isBot) humansAlive = true;
    }
    // A bots-only match (tests, demo) runs until nobody is left; otherwise it ends with the last human.
    if (this.clock >= MATCH.DURATION_MS || (this.hasHumans ? !humansAlive : !anyAlive)) this.end();
  }

  /** HUD player counts: roster players only (bosses and guards are not players, and must not leak). */
  private updateCounters(): void {
    let alive = 0;
    let total = 0;
    for (const rt of this.ordered) {
      if (rt.pub.role !== NPC_ROLE.NONE) continue;
      total++;
      if (rt.pub.alive) alive++;
    }
    if (this.state.aliveCount !== alive) this.state.aliveCount = alive;
    if (this.state.totalPlayers !== total) this.state.totalPlayers = total;
  }

  private applyInputs(rt: PlayerRuntime, dt: number): void {
    const p = rt.pub;
    const s = rt.self;
    rt.allowanceMs = Math.min(rt.allowanceMs + dt, MAX_ALLOWANCE_MS);
    while (rt.queue.length > 0 && rt.allowanceMs + 1e-6 >= INPUT_DT_MS) {
      const input = rt.queue.shift()!;
      rt.allowanceMs -= INPUT_DT_MS;
      // finishHealIfDue already ran this step, so this equals the client prediction's rule.
      const healMult = healSpeedMult(s.healUntil, this.clock);
      const terrainMult = terrainSpeedMult(terrainAt(this.map, p.x, p.y));
      const r = stepMovement(this.idx, p.x, p.y, readRoll(s), input, healMult, terrainMult);
      if (r.started) {
        // A roll cancels heal and search (mobility memo); reload keeps running.
        cancelHeal(rt);
        closeSearch(this, rt, "roll");
        emitSound(this, rt, SoundKind.roll, p.x, p.y);
      }
      const moved = Math.hypot(r.x - p.x, r.y - p.y);
      if (r.rolling) {
        rt.stepAcc = 0;
        rt.stepRunAcc = 0;
      }
      if (moved > 0) rt.movedAt = this.clock;
      p.x = r.x;
      p.y = r.y;
      if (!r.rolling) footstep(this, rt, moved, input.walk === true);
      // Roll state and lastSeq in the same iteration: prediction reconciles a consistent snapshot.
      writeRoll(s, r.roll);
      const walking = input.walk === true;
      if (s.walking !== walking) s.walking = walking;
      p.aim = input.aim;
      followAim(rt, input.aim);
      if (input.fire && !rt.triggerHeld) {
        rt.pressPending = true;
        rt.pressAt = this.clock;
      }
      rt.triggerHeld = input.fire;
      s.lastSeq = input.seq;
      // No firing while rolling; a held auto trigger fires on the first input after the roll.
      if (!r.rolling) tryFire(this, rt);
      if (!p.alive) break;
    }
  }

  /**
   * The player left the map: resolve their uniques in the ledger, build the exit report (every
   * participant; humans are also emitted for the web) and the personal outcome.
   */
  finishPlayer(
    rt: PlayerRuntime,
    exit: ExitType,
    parts: { extracted?: ItemLike[]; lost?: ItemLike[]; dropped?: ItemLike[] } = {},
  ): void {
    const extracted = parts.extracted ?? [];
    const lost = parts.lost ?? [];
    rt.dropped = parts.dropped ?? [];
    for (const it of extracted) this.ledger.resolve(it, "extract");
    for (const it of lost) this.ledger.resolve(it, "lost");
    const settle = (it: ItemLike): SettledItem => {
      const out = toSettled(it);
      if (it.def === "junk_dogtag" && it.ref) {
        const victim = this.ordered.find((r) => r.selfKey === it.ref)?.userId;
        if (victim) out.victim = victim;
      }
      return out;
    };
    const report: PlayerExitReport = {
      matchId: this.state.matchId,
      userId: rt.userId ?? "",
      exit,
      atMs: this.clock,
      kills: rt.self.kills,
      level: rt.level,
      extracted: extracted.map(settle),
      lost: lost.map(settle),
      destroyed: rt.destroyed.map(settle),
      stats: { ...rt.stats },
    };
    rt.exitReport = report;
    this.exitReports.push(report);

    const sold: SoldLine[] = [];
    for (const it of extracted) {
      const d = itemDef(it.def);
      if (d?.cat !== "junk") continue;
      const unit = d.id === "junk_dogtag" ? dogTagCr(it.lvl ?? 0) : (d.value ?? 0);
      sold.push(it.label ? { def: it.def, qty: it.qty, cr: unit * it.qty, label: it.label } : { def: it.def, qty: it.qty, cr: unit * it.qty });
    }
    const msg: OutcomeMsg = {
      matchId: this.state.matchId,
      exit,
      extracted: report.extracted,
      lost: report.lost,
      dropped: rt.dropped.map(settle),
      destroyed: report.destroyed,
      kills: rt.self.kills,
      killedBy: rt.killedBy,
      atMs: this.clock,
      credits: junkCredits(extracted),
      sold,
      guest: false,
    };
    rt.outcome = msg;
    this.vision.clearRow(rt.rosterIndex);
    if (!rt.isBot) {
      this.emit({ type: "outcome", to: rt.rosterIndex, msg });
      // A bullet of theirs still in flight may yet kill (death.ts updates report.kills): the web
      // report goes out once the last one is gone, so the posted kills (XP) are final.
      if (this.bullets.some((b) => b.owner === rt)) rt.exitHeld = true;
      else this.emit({ type: "exit", report });
    }
  }

  /** Emit the exit reports held for bullets in flight once those bullets are gone. */
  private releaseHeldExits(): void {
    for (const rt of this.ordered) {
      if (!rt.exitHeld || !rt.exitReport || this.bullets.some((b) => b.owner === rt)) continue;
      rt.exitHeld = false;
      this.emit({ type: "exit", report: rt.exitReport });
    }
  }

  /** Known uids that are not resolved (must be empty once the match ended). */
  ledgerGaps(): string[] {
    return [...this.ledger.known.keys()].filter((uid) => !this.ledger.resolved.has(uid));
  }

  private end(): void {
    for (const rt of this.ordered) if (rt.pub.alive) timeoutPlayer(this, rt);
    this.bullets = [];
    // Every exit report goes out before the end report (the web's end sweep relies on it).
    this.releaseHeldExits();
    this.state.phase = "ended";
    this.updateCounters();
    const leftOnMap = [...groundUniques(this), ...this.containers.leftInside()];
    for (const it of leftOnMap) this.ledger.resolve(it, "left");
    const gaps = this.ledgerGaps();
    if (gaps.length) {
      const msg = `[ledger] match ${this.state.matchId}: ${gaps.length} unresolved uids (${gaps.slice(0, 5).join(", ")})`;
      if (this.ledger.strict) throw new Error(msg);
      console.error(msg);
    }
    const participants = this.ordered.map((rt) => ({
      userId: rt.isBot ? null : rt.userId,
      nickname: rt.nickname,
      isBot: rt.isBot,
      exitType: rt.exitReport?.exit ?? ("timeout" as ExitType),
      kills: rt.self.kills,
    }));
    const report: MatchEndReport = {
      matchId: this.state.matchId,
      mapId: this.map.id,
      matchSeed: this.state.mapSeed,
      startedAt: this.state.startedAt,
      endedAt: this.now(),
      participants,
      leftOnMap: leftOnMap.map(toSettled),
      minted: this.mode === "demo" ? [...this.ledger.minted] : [],
    };
    this.report = report;
    this.emit({
      type: "ended",
      report,
      summary: {
        matchId: report.matchId,
        participants: participants.map(({ nickname, isBot, exitType, kills }) => ({ nickname, isBot, exitType, kills })),
      },
    });
  }
}

/** Fresh server-side bookkeeping of one participant (roster player or boss NPC). */
function newRuntime(
  id: string,
  rosterIndex: number,
  selfKey: string,
  entry: RosterEntry,
  p: Player,
  s: SelfState,
  snap: LoadoutSnapshot | undefined,
): PlayerRuntime {
  return {
    id,
    rosterIndex,
    selfKey,
    userId: entry.isBot ? null : entry.userId,
    nickname: entry.nickname,
    isBot: entry.isBot,
    connected: false,
    loadoutId: snap?.loadoutId ?? "",
    level: snap?.level ?? 0,
    pub: p,
    self: s,
    queue: [],
    lastQueuedSeq: -1,
    allowanceMs: 0,
    triggerHeld: false,
    pressPending: false,
    pressAt: 0,
    nextFireAt: 0,
    lastShotAt: -Infinity,
    movedAt: 0,
    prevX: p.x,
    prevY: p.y,
    vx: 0,
    vy: 0,
    stepAcc: 0,
    stepRunAcc: 0,
    viewAim: p.aim,
    viewAimSrc: p.aim,
    exitHeld: false,
    lastHitBy: null,
    lastHitAt: -Infinity,
    reloadKey: "",
    nextExtractSoundAt: 0,
    nextSearchSoundAt: 0,
    search: null,
    opsBucket: { tokens: 20, at: 0 },
    destroyed: [],
    dropped: [],
    stats: { shotsFired: 0, dmgDealt: 0, containersSearched: 0, corpsesSearched: 0, bossKills: 0 },
    killedBy: "",
    exitReport: null,
    outcome: null,
  };
}

function loadoutMap(l: MatchOptions["loadouts"]): LoadoutMap {
  if (!l) return new Map();
  if (Array.isArray(l)) return new Map((l as readonly LoadoutSnapshot[]).map((s) => [s.userId, s]));
  return l as LoadoutMap;
}

/**
 * Spawn spot per roster entry (same order), side-aware (map memo §6).
 *
 * Humans are placed first, one at a time. Each may only take a spot on a side that holds fewer
 * than ceil(humans / sides) humans so far — so humans spread round-robin over N/E/S/W and every
 * side's extract mask gets used — and among those it takes the spot that maximizes the minimum
 * distance from any human to every other assigned spawn (other humans and the bots that will fill
 * in around them). Bots then take the remaining spots farthest from the humans. More players than
 * spots: the extra bots reuse spots, farthest from the humans first. Spots without a side (hand-made
 * test maps) all count as one side.
 */
export function assignSpawns<T extends { x: number; y: number; side?: MapSide }>(
  rng: Rng,
  spots: readonly T[],
  isHuman: readonly boolean[],
): T[] {
  const n = isHuman.length;
  if (spots.length === 0) return [];
  const pool = shuffle(rng, [...spots]);
  const dist = (a: T, b: T) => Math.hypot(a.x - b.x, a.y - b.y);
  const humanCount = Math.min(isHuman.filter(Boolean).length, pool.length);
  const botCount = n - isHuman.filter(Boolean).length;
  const sideOf = (i: number) => pool[i]!.side ?? 0;
  const sideCount = new Set(pool.map((_, i) => sideOf(i))).size;
  const sideCap = Math.ceil(humanCount / sideCount);

  /** Free spots ordered farthest-from-humans first (stable over the shuffled order). */
  const botOrder = (humanSpots: number[]): number[] => {
    const taken = new Set(humanSpots);
    const free = pool.map((_, i) => i).filter((i) => !taken.has(i));
    const near = (i: number) => {
      let d = Infinity;
      for (const h of humanSpots) d = Math.min(d, dist(pool[i]!, pool[h]!));
      return d;
    };
    const score = new Map(free.map((i) => [i, near(i)]));
    free.sort((a, b) => score.get(b)! - score.get(a)!);
    return free;
  };
  /** Smallest distance from any human spawn to any other assigned spawn. */
  const worst = (humanSpots: number[], botSpots: number[]): number => {
    let w = Infinity;
    for (const h of humanSpots) {
      for (const o of humanSpots) if (o !== h) w = Math.min(w, dist(pool[h]!, pool[o]!));
      for (const o of botSpots) w = Math.min(w, dist(pool[h]!, pool[o]!));
    }
    return w;
  };

  const humanSpots: number[] = [];
  const perSide = new Map<number, number>();
  for (let k = 0; k < humanCount; k++) {
    // Humans still to place count as occupants too: the bots of this layout stand in for them.
    const restCount = Math.min(pool.length - k - 1, botCount + (humanCount - k - 1));
    let best = -1;
    let bestScore = -Infinity;
    // Pass 0 honours the side cap; pass 1 only runs when the capped sides ran out of spots.
    for (let pass = 0; pass < 2 && best < 0; pass++) {
      for (let i = 0; i < pool.length; i++) {
        if (humanSpots.includes(i)) continue;
        if (pass === 0 && (perSide.get(sideOf(i)) ?? 0) >= sideCap) continue;
        const hs = [...humanSpots, i];
        const score = worst(hs, botOrder(hs).slice(0, restCount));
        if (score > bestScore) { bestScore = score; best = i; }
      }
    }
    humanSpots.push(best);
    perSide.set(sideOf(best), (perSide.get(sideOf(best)) ?? 0) + 1);
  }
  const order = botOrder(humanSpots);
  const firstLap = shuffle(rng, order.slice(0, Math.min(botCount, order.length)));
  const botSpots: number[] = [];
  for (let b = 0; b < botCount; b++) {
    const lapList = order.length > 0 ? order : humanSpots;
    botSpots.push(b < firstLap.length ? firstLap[b]! : lapList[(b - firstLap.length) % lapList.length]!);
  }

  const out: T[] = [];
  let h = 0;
  let b = 0;
  for (const human of isHuman) {
    if (human) out.push(pool[humanSpots[h++ % humanSpots.length]!]!);
    else out.push(pool[botSpots[b++]!]!);
  }
  return out;
}

export function shuffle<T>(rng: Rng, arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}
