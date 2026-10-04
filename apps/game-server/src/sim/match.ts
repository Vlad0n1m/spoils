/**
 * Colyseus-independent simulation of one match. Owns a BattleState and advances it with
 * step(dtMs); the room only feeds intents in and forwards drained events out. All randomness goes
 * through `rng` and all item ids through `newUid`, so tests run whole matches deterministically
 * without a network.
 *
 * NPC MODEL v5: the roster is humans only. NPCs (boss groups at their BossSpots, marauder squads at
 * MapData.npcPosts) are created by the match itself from the match seed (rollBossSpawns /
 * rollNpcSpawns; legacy roster mode, used by tests and the harness) and appended after the
 * roster. They never count as players and never keep a match alive.
 *
 * WORLD v6 (MatchOptions.world, spec §3.4): one shard-cycle of the persistent world. The clock is
 * the cycle clock (injected now() − cycleStartsAt), humans arrive and leave through addHuman /
 * extract / death (re-entries are new runtimes; indexes are never reused), the wipe at
 * WORLD.CYCLE_MS sends everyone left MIA, released pool items are placed by the server
 * (pool-place.ts) and player drops / corpses expire (A6). Legacy roster matches are unchanged.
 *
 * Tick order inside step() (later WPs fill the hooks, never the structure):
 *   NPCs (npc.ts) → reload/heal timers → inputs (stepMovement, fire) → stepSearches → bullets →
 *   grenades (bounces, blasts) → pickups → extraction → velocities → disclosure → vision.update → aoi.update → deliverSounds → counters →
 *   syncPublic → held exit reports
 * The room then runs syncViews → broadcastPatch → per-client `ev` batches (battle-room.ts).
 */

import { randomInt, randomUUID } from "node:crypto";
import {
  BOSSES,
  BOSS_AI,
  BattleState,
  Extract,
  FLOOR_LOOT,
  INPUT_DT_MS,
  MATCH,
  MAX_QUEUED_INPUTS,
  NPC,
  NPC_ROLE,
  bossGroupNpcCount,
  humanSideCap,
  npcLeashPx,
  npcPostsOf,
  rollNpcSpawns,
  PLAYER,
  skinCode,
  Player,
  SOLID,
  SelfState,
  SoundKind,
  WORLD,
  accepts,
  bagKeys,
  bpLevelOf,
  MAP_IDS,
  extractMask,
  generateMap,
  hasLineOfSight,
  healSpeedMult,
  isBagKey,
  ITEM_FLAG,
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
  type BossKind,
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
  type NpcPost,
  type NpcSquadSpawn,
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
import { stepBullets, tryFire } from "./combat.js";
import { hasLiveGrenade, stepGrenades, throwGrenade, type LiveGrenade, type ThrowRefusal } from "./grenade.js";
import { ContainerSystem, closeSearch, invTakeAllOp, invTakeOp, stepSearches } from "./containers.js";
import { envNow, initEnvironment, type EnvRuntime } from "./environment.js";
import { stepExtraction, timeoutPlayer } from "./extraction.js";
import { GROUND_DROPS_PER_USER, GroundStore, autoPickup, dropSpot, findDropPile, groundUniques, mergeIntoPile, nearestGroundItem, pickupGround, spawnGroundItem } from "./inventory.js";
import { Ledger, cloneItem, isTrackedUnique, makeItem, toPlain, toSettled } from "./items.js";
import { NpcSystem, type NpcSpawn } from "./npc.js";
import { leftoverPool, poolTargetCount, poolTick, receiveBossFill, receiveEntryPool, takeUnplaced, type UnplacedPoolItem } from "./pool-place.js";
import { pickDropSpawn, pickEntrySpawn, pickTutorialSpawn, type PartyDropAnchor } from "./spawn.js";
import { deliverSounds, emitSound, footstep } from "./sound.js";
import type { Bullet, EntryInit, LoadoutMap, MatchEvent, PlayerRuntime, RosterEntry } from "./types.js";
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
  /** Match seed: the (public, BattleState.mapSeed) map seed — legacy map layout, environment. */
  mapSeed?: number;
  /**
   * Server-secret seed of everything a client must not be able to predict (v5 review): container
   * contents, boss / marauder spawns, NPC kits and bags. Never synced to clients; the world
   * directory draws a crypto-random one per shard (WORLD v6).
   * Default: mapSeed (tests and benches stay deterministic in one seed).
   */
  lootSeed?: number;
  /** Map to run on (default: defaultMapChoice(), i.e. the Steppe unless EXTRACT_MATCH_MAP says otherwise). */
  mapId?: MatchMapChoice;
  /** Tests: a hand-made map instead of matchMap(mapSeed, mapId). */
  map?: MapData;
  newUid?: () => string;
  now?: () => number;
  /** NPCs get an NpcBrain (default true). Rule tests drive NPC players by hand. */
  npcBrains?: boolean;
  /** @deprecated pre-v5 name of npcBrains (there are no player-bots any more). */
  botBrains?: boolean;
  /** Skip extracts / floor loot from the map (rule tests place their own). */
  emptyWorld?: boolean;
  matchId?: string;
  /** "demo" (default): the server mints container uniques itself. "live": uniques only from loadouts + pool. */
  mode?: RaidMode;
  /** Legacy roster mode (tests, harness): accepted loadouts (by userId, or as an array). World entries bring theirs via addHuman. */
  loadouts?: LoadoutMap | readonly LoadoutSnapshot[];
  /** Legacy roster mode (tests, harness): lost-pool allocation by container key. World shards place pool items themselves (pool-place.ts). */
  containerLoot?: Readonly<Record<string, SettledItem[]>>;
  /** Throw on ledger violations (tests). Production logs them instead. */
  strictLedger?: boolean;
  envSeed?: number;
  weatherOverride?: string;
  /**
   * Spawn the map's bosses and guards (rollBossSpawns(lootSeed, map.bosses), boss.ts). Default: on
   * unless emptyWorld. Pool items for bosses come in containerLoot["boss:<kind>"].
   */
  bosses?: boolean;
  /**
   * Spawn the marauder squads (rollNpcSpawns(lootSeed, map.npcPosts, boss NPCs), npc.ts). Default:
   * on unless emptyWorld (on whenever npcPosts / npcSpawns are given). Carrier pool items come in
   * containerLoot["npc:<post>.<member>"].
   */
  marauders?: boolean;
  /** Tests: these posts instead of MapData.npcPosts. */
  npcPosts?: NpcPost[];
  /** Tests / benches: these squads instead of the rollNpcSpawns roll (forced fills, perf gates). */
  npcSpawns?: NpcSquadSpawn[];
  /**
   * Tests only: until this match clock the match does not end for lack of living humans (an
   * NPC-only world for rule tests). A real match ends with its last human (default 0).
   */
  npcOnlyUntilMs?: number;
  /**
   * WORLD v6 (spec §3.4): this match is one shard-cycle of the persistent world. The clock follows
   * the wall clock (`now() − cycleStartsAt`, so the directory can inject worldNow()), humans arrive
   * through addHuman (roster empty), the map is wiped at WORLD.CYCLE_MS (MIA) and never ends for
   * lack of humans. Only the event boss's spot spawns (boss + guards). Absent = legacy roster match.
   */
  world?: WorldOptions;
}

/** MatchOptions.world. */
export interface WorldOptions {
  cycleId: number;
  shard: number;
  /** Wall ms of the cycle start (clock 0). */
  cycleStartsAt: number;
  /** Cycle clock when entry closes (CYCLE_MS − ENTRY_CLOSE_MS). */
  entryCloseMs: number;
  /** Event boss of this cycle (bossEventOf), or null. */
  bossEvent: BossKind | null;
}

/** Human palette slots (Player.color) handed out least-used first among living humans. */
const HUMAN_COLORS = 16;
/** worldTick period (pool placement, NPC respawn checks, expiry). */
const WORLD_TICK_MS = 1_000;

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
  /** Weapons v2: hand grenades thrown and not exploded yet (grenade.ts). */
  grenades: LiveGrenade[] = [];
  /** Last grenade id handed out (GrenadeMsg.id). */
  grenadeSeq = 0;
  /** MatchOptions.lootSeed (server-only: never in BattleState). */
  readonly lootSeed: number;
  /** Bosses, guards and marauder squads (NPC runtimes after the roster). */
  readonly npcs: NpcSystem;
  /** @deprecated v5 has no player-bots: always empty (pre-v5 benches still read it). */
  readonly bots: ReadonlyArray<{ rt: PlayerRuntime; role: string }> = [];
  /** Exit reports of every participant (humans are also emitted as `exit` events), in exit order. */
  readonly exitReports: PlayerExitReport[] = [];

  // ---- WORLD v6
  /** World mode options plus the backstop (durationMs = WORLD.CYCLE_MS); null = legacy roster match. */
  readonly world: (WorldOptions & { durationMs: number }) | null;
  /** Spawn spots handed out recently (spawn.ts pickEntrySpawn). */
  readonly recentSpawns: Array<{ x: number; y: number; at: number }> = [];
  /** Party drops by dropId: the first member's spot, where later members of the drop land (spawn.ts). */
  readonly partyDrops = new Map<string, PartyDropAnchor>();
  /** Released entry pool items waiting for a valid target (pool-place.ts). */
  readonly unplacedPool: UnplacedPoolItem[] = [];
  /** Boss bag items waiting for the event boss to calm down (pool-place.ts). */
  readonly pendingBossFill: ItemLike[] = [];
  /** BossSpot of the event boss that spawned (world mode), else null. */
  readonly eventBossSpot: BossSpot | null = null;
  /** Latest end of any human's NPC peace window (npc.ts skips the peace pass after it). */
  peaceUntil: number = NPC.PEACE_MS;
  /** A6: uniques that vanished with player corpses / player-dropped ground items (→ treasury). */
  readonly expired: ItemLike[] = [];
  /** A6: pool items that vanished with NPC corpses (→ pool, untaxed). */
  readonly expiredToPool: ItemLike[] = [];
  private readonly byUser = new Map<string, PlayerRuntime>();
  private readonly byEntry = new Map<string, PlayerRuntime>();
  private readonly npcAnchors: NpcAnchor[];
  private entrySpotCache: ReadonlyArray<{ x: number; y: number; side?: MapSide }> | null = null;
  private nextWorldTickAt = 0;

  private readonly runtimes = new Map<string, PlayerRuntime>();
  private readonly ordered: PlayerRuntime[] = [];
  private events: MatchEvent[] = [];
  private readonly npcOnlyUntilMs: number;
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
    this.lootSeed = (opts.lootSeed ?? seed) >>> 0;
    this.world = opts.world ? { ...opts.world, durationMs: WORLD.CYCLE_MS } : null;
    this.state.phase = this.world ? "open" : "drop";
    this.state.startedAt = this.world ? this.world.cycleStartsAt : this.now();
    this.state.clockMs = 0;
    this.state.durationMs = this.world ? this.world.durationMs : MATCH.DURATION_MS;
    this.env = initEnvironment(this, opts.envSeed ?? Math.floor(this.rng() * 2 ** 32) >>> 0, opts.weatherOverride ?? "");
    this.npcOnlyUntilMs = opts.npcOnlyUntilMs ?? 0;
    // Humans only (NPC MODEL v5): a pre-v5 bot entry is skipped, never turned into a player.
    const roster = opts.roster.filter((r) => r.isBot !== true);
    // NPCs are rolled from the secret loot seed alone (legacy roster mode).
    // World mode (D12): only the event boss's spot spawns (boss + guards), no roll; no event, no boss.
    const bossesOn = opts.bosses ?? !opts.emptyWorld;
    const ev = this.world?.bossEvent ?? null;
    const bossSpawns: BossSpot[] = !bossesOn ? [] : this.world
      ? (ev ? this.map.bosses.filter((b) => b.kind === ev).slice(0, 1) : [])
      : rollBossSpawns(this.lootSeed, this.map.bosses);
    const posts = opts.npcPosts ?? npcPostsOf(this.map);
    const marauders = opts.marauders ?? (!opts.emptyWorld || !!opts.npcPosts || !!opts.npcSpawns);
    const squads: NpcSquadSpawn[] = !marauders ? [] : (opts.npcSpawns ?? rollNpcSpawns(this.lootSeed, posts, bossGroupNpcCount(bossSpawns)));
    const npcCount = bossGroupNpcCount(bossSpawns) + squads.reduce((n, q) => n + q.members, 0);
    // World mode: a fixed capacity (D16); indexes are never reused, admission refuses before it is full.
    this.vision = new VisionSystem(this.world ? WORLD.MAX_RUNTIMES_PER_SHARD : roster.length + npcCount);
    if (this.world) {
      const spot = bossSpawns[0] ?? null;
      this.eventBossSpot = spot;
      this.state.cycleId = this.world.cycleId >>> 0;
      this.state.entryCloseMs = this.world.entryCloseMs;
      this.state.bossKind = spot ? spot.kind : "";
      this.state.bossZone = spot ? (this.map.zones.find((z) => z.id === spot.zone)?.name ?? spot.zone) : "";
      this.state.bossState = spot ? 1 : 0;
    }
    this.containers = new ContainerSystem(this);
    this.npcs = new NpcSystem(this);
    if (opts.containerLoot && this.mode === "live") this.containers.allocatePool(opts.containerLoot);

    if (!opts.emptyWorld) this.setupWorld();
    this.npcAnchors = npcAnchorsOf(bossSpawns, squads, posts);
    this.setupPlayers(roster, loadoutMap(opts.loadouts), this.npcAnchors);
    this.setupNpcs(bossSpawns, squads, posts, opts.npcBrains ?? opts.botBrains ?? true);
    this.updateCounters();
  }

  /** Bosses and guards (pre-v5 name; the same NpcSystem as every NPC). */
  get bosses(): NpcSystem {
    return this.npcs;
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
    const mapSchedules = this.world !== null || this.map.extracts.some((e) => e.closesAtMs !== undefined);
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
      if (this.world) {
        // D8: every extract is open from clock 0 (each player arms after their own entry); the
        // map's early-closing ones (N2 / S2) close EXTRACT_EARLY_CLOSE_MS before the wipe.
        e.openAt = 0;
        e.closeAt = spot.closesAtMs !== undefined ? WORLD.CYCLE_MS - WORLD.EXTRACT_EARLY_CLOSE_MS : 0;
      } else {
        e.openAt = MATCH.EXTRACT_OPEN_AT_MS;
        e.closeAt = spot.closesAtMs ?? (closing.has(i) ? Math.round(MATCH.DURATION_MS * MATCH.EXTRACT_CLOSE_EARLY_AT) : 0);
      }
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

  private setupPlayers(roster: RosterEntry[], loadouts: LoadoutMap, npcAnchors: readonly NpcAnchor[] = []): void {
    const spawns = assignSpawns(this.rng, spawnsClearOfNpcs(this.map.spawns, npcAnchors, roster.length), roster.length);
    const colors = shuffle(this.rng, Array.from({ length: Math.max(16, roster.length) }, (_, i) => i));
    const used = new Map<string, number>();
    const allMask = (1 << Math.min(8, this.map.extracts.length)) - 1;
    // Tarkov rule (map memo §6): never your own side's extracts. A map whose extracts leave a side
    // with none (hand-made test maps, the legacy layout) falls back to every extract.
    const maskOf = (side: MapSide) => extractMask(this.map, side) || allMask;
    roster.forEach((entry, i) => {
      const id = `pending${i}`;
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
      s.isBot = false;
      s.side = spawn.side;
      s.extractMask = maskOf(spawn.side);
      const selfKey = selfKeyOf(i);
      this.state.players.set(id, p);
      this.state.self.set(selfKey, s);

      const snap = entry.userId ? loadouts.get(entry.userId) : undefined;
      const rt = newRuntime(id, i, selfKey, entry, false, p, s, snap);
      if (snap) this.loadLoadout(rt, snap);
      giveFreeKit(rt);
      syncPublic(rt);
      this.runtimes.set(id, rt);
      this.ordered.push(rt);
      if (rt.userId && !this.byUser.has(rt.userId)) this.byUser.set(rt.userId, rt);
    });
  }

  // ---------------------------------------------------------------- world entries (WORLD v6)

  /**
   * Put an admitted entry on the map (spec §3.4): the next runtime index (after every NPC and
   * earlier entry), a late-join spawn (spawn.ts), extracts armed EXTRACT_ARM_MS from now, the
   * loadout + free kit, and the entry's released pool items / boss bag (pool-place.ts). The runtime
   * stands idle (not connected) until attachHuman. World mode only.
   */
  addHuman(e: EntryInit): PlayerRuntime {
    if (!this.world) throw new Error("addHuman: world mode only");
    if (this.ended) throw new Error("addHuman: the map was wiped");
    const i = this.ordered.length;
    if (i >= this.vision.n) throw new Error(`addHuman: runtime capacity ${this.vision.n} reached`);
    const clock = this.clock;
    const partyId = e.partyId ?? "";
    const dropId = partyId ? (e.dropId ?? "") : "";
    // A party drop (spawn.ts): the drop's first member picks a normal entry spot, later members of
    // the same drop land 150–300 px from it within PARTY.DROP_TTL_MS.
    // Alpha: a solo first raid lands next to a quiet T1 container with a marauder post nearby.
    const tutorialSpawn = e.tutorial && !dropId ? pickTutorialSpawn(this, e.userId) : null;
    const spawn = tutorialSpawn ?? (dropId ? pickDropSpawn(this, this.rng, e.userId, dropId, partyId) : pickEntrySpawn(this, this.rng, e.userId));
    const id = `e${i}`;
    const p = new Player();
    p.sessionId = id;
    p.nickname = e.nickname;
    p.color = this.leastUsedColor();
    p.skin = skinCode(e.skin);
    p.x = spawn.x;
    p.y = spawn.y;
    p.hp = PLAYER.MAX_HP;
    p.alive = true;
    const s = new SelfState();
    s.userId = e.userId;
    s.isBot = false;
    s.side = spawn.side;
    s.extractMask = this.extractMaskOf(spawn.side);
    s.enteredAt = clock;
    s.extractArmAt = clock + WORLD.EXTRACT_ARM_MS;
    const selfKey = selfKeyOf(i);
    this.state.players.set(id, p);
    this.state.self.set(selfKey, s);
    const rt = newRuntime(id, i, selfKey, { userId: e.userId, nickname: e.nickname }, false, p, s, e.snapshot ?? undefined);
    rt.entryId = e.entryId;
    rt.enteredAtMs = clock;
    rt.guest = e.guest;
    rt.level = e.level;
    rt.loadoutId = e.loadoutId;
    rt.partyId = partyId;
    rt.dropId = dropId;
    rt.tutorial = tutorialSpawn !== null;
    if (e.snapshot) this.loadLoadout(rt, e.snapshot);
    giveFreeKit(rt);
    syncPublic(rt);
    rt.idleSince = this.now();
    this.runtimes.set(id, rt);
    this.ordered.push(rt);
    this.byUser.set(e.userId, rt);
    this.byEntry.set(e.entryId, rt);
    this.peaceUntil = Math.max(this.peaceUntil, clock + NPC.PEACE_MS);
    receiveEntryPool(this, rt, e.pool);
    receiveBossFill(this, e.bossFill);
    this.updateCounters();
    return rt;
  }

  /** The newest runtime of `userId` (alive or not). */
  currentOf(userId: string): PlayerRuntime | undefined {
    return this.byUser.get(userId);
  }

  /** The runtime of entry `entryId` (world mode). */
  entryById(entryId: string): PlayerRuntime | undefined {
    return this.byEntry.get(entryId);
  }

  /** Living human runtimes, connected or not (logs, harness). */
  humansOnMap(): number {
    let n = 0;
    for (const rt of this.ordered) if (!rt.isNpc && rt.pub.alive) n++;
    return n;
  }

  /**
   * Living humans that hold one of the WORLD.CAPACITY seats (admission, D3): connected ones, plus
   * those without a client for less than WORLD.IDLE_SEAT_MS (just admitted, or a short disconnect).
   * A body idle for longer stays on the map (and its owner can rejoin it at any time) but no longer
   * blocks admission: otherwise a few throwaway accounts that join and never connect, or connect and
   * drop, would lock everyone else out of the shard for the whole cycle (security audit).
   */
  seatHolders(): number {
    const now = this.now();
    let n = 0;
    for (const rt of this.ordered) {
      if (rt.isNpc || !rt.pub.alive) continue;
      if (rt.connected || rt.idleSince < 0 || now - rt.idleSince < WORLD.IDLE_SEAT_MS) n++;
    }
    return n;
  }

  /** Valid pool targets now, without the human-distance rule (EntryRequest.targets, D17). */
  poolTargetCount(): number {
    return poolTargetCount(this);
  }

  /** The event boss runtime of this world shard, or null (none this cycle / legacy match). */
  eventBoss(): PlayerRuntime | null {
    if (!this.world || !this.eventBossSpot) return null;
    return this.npcs.groups.find((g) => g.spot === this.eventBossSpot)?.boss ?? null;
  }

  /** The event boss of this shard is alive (EntryRequest.bossAlive). */
  bossAlive(): boolean {
    return this.eventBoss()?.pub.alive ?? false;
  }

  /** Spawn spots for late entries: the map's, minus those inside NPC camps (cached; NPC posts never move). */
  entrySpots(): ReadonlyArray<{ x: number; y: number; side: MapSide }> {
    this.entrySpotCache ??= spawnsClearOfNpcs(this.map.spawns, this.npcAnchors, 1);
    return this.entrySpotCache.map((q) => ({ x: q.x, y: q.y, side: q.side ?? (0 as MapSide) }));
  }

  /** Tarkov rule (map memo §6), as in setupPlayers. */
  private extractMaskOf(side: MapSide): number {
    const allMask = (1 << Math.min(8, this.map.extracts.length)) - 1;
    return extractMask(this.map, side) || allMask;
  }

  /** The palette slot used by the fewest living humans (lowest index on ties). */
  private leastUsedColor(): number {
    const used = new Array<number>(HUMAN_COLORS).fill(0);
    for (const rt of this.ordered) if (!rt.isNpc && rt.pub.alive && rt.pub.color < HUMAN_COLORS) used[rt.pub.color]!++;
    let best = 0;
    for (let c = 1; c < HUMAN_COLORS; c++) if (used[c]! < used[best]!) best = c;
    return best;
  }

  // ---------------------------------------------------------------- NPCs (npc.ts, boss.ts)

  /**
   * Boss groups, then marauder squads, after the roster: each NPC gets the next roster index
   * (vision / sound / views are all by roster index), a Player with role / maxHp (npc.ts / boss.ts
   * equip it; no free kit), no extract mask (NPCs never extract), and an NpcBrain unless brains are
   * off (rule tests drive NPC players by hand).
   */
  private setupNpcs(bosses: readonly BossSpot[], squads: readonly NpcSquadSpawn[], posts: readonly NpcPost[], brains: boolean): void {
    this.npcs.spawnBosses(bosses);
    this.npcs.spawnSquads(squads, posts);
    if (brains) this.npcs.startBrains();
  }

  /** Runtime indexes this match can hold (the vision capacity; world mode WORLD.MAX_RUNTIMES_PER_SHARD). */
  get runtimeCapacity(): number {
    return this.vision.n;
  }

  /**
   * One NPC runtime at the next roster index (spec §3.6): a Player at (x, y) with the fixed NPC
   * palette slot, a bot SelfState without extract mask; npc.ts / boss.ts equip it. Used at match
   * creation and by world respawns (NpcSystem.respawnTick). Throws at the runtime capacity
   * (indexes are never reused, D16).
   */
  addNpc(n: NpcSpawn): PlayerRuntime {
    const i = this.ordered.length;
    if (i >= this.runtimeCapacity) throw new Error(`addNpc: runtime capacity ${this.runtimeCapacity} reached`);
    const id = `npc${i}`;
    const p = new Player();
    p.sessionId = id;
    p.nickname = n.nickname;
    // A fixed NPC palette slot (never a player color index; the client tints by role).
    p.color = 255;
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
    const rt = newRuntime(id, i, selfKey, { userId: null, nickname: n.nickname }, true, p, s, undefined);
    this.runtimes.set(id, rt);
    this.ordered.push(rt);
    return rt;
  }

  /**
   * Put an accepted loadout into the slots (equipment first so the bag level is known). The web
   * (raids/enter) already validated it; entries that still do not fit are logged and skipped, never invented.
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
      // A uid that is on the map right now (non-strict ledger anomaly) is never duplicated.
      if (d.unique && !this.ledger.register(it, "loadout")) continue;
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
    // World mode: only the user's current (newest) runtime, and only while it is on the map.
    const rt = this.world ? this.currentOf(userId) : this.ordered.find((r) => !r.isNpc && r.userId === userId);
    if (!rt || (this.world && !rt.pub.alive)) return null;
    if (rt.id !== sessionId) {
      this.state.players.delete(rt.id);
      this.runtimes.delete(rt.id);
      rt.pub.sessionId = sessionId;
      rt.id = sessionId;
      this.state.players.set(sessionId, rt.pub);
      this.runtimes.set(sessionId, rt);
    }
    rt.connected = true;
    rt.idleSince = -1;
    rt.queue.length = 0;
    rt.pendingThrow = null;
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
    if (!rt.isNpc) rt.idleSince = this.now();
    rt.queue.length = 0;
    rt.pendingThrow = null;
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
   * F on one specific ground item (range + line of sight as for F), never on whatever else happens
   * to be nearest (Match.interact prefers containers). Scripted test / bench humans; NPCs never loot.
   */
  pickupItem(id: string, groundId: string): boolean {
    const rt = this.actor(id);
    const g = this.ground.byId.get(groundId);
    if (!rt || !g || rt.isNpc) return false;
    const p = rt.pub;
    if ((g.schema.x - p.x) ** 2 + (g.schema.y - p.y) ** 2 > PLAYER.INTERACT_RADIUS ** 2) return false;
    if (!hasLineOfSight(this.idx, p.x, p.y, g.schema.x, g.schema.y, SOLID.MOVE)) return false;
    return pickupGround(this, rt, g);
  }

  /** Open one specific search target (loot key c<idx> / k<corpse>) if it is in reach (scripted humans). */
  openSearch(id: string, key: string): boolean {
    const rt = this.actor(id);
    return rt && !rt.isNpc ? this.containers.openKey(rt, key) : false;
  }

  /** F: the nearest untouched container wins over loose items (inventory memo §2.2). */
  interact(id: string): boolean {
    const rt = this.actor(id);
    if (!rt || rt.isNpc) return false;
    const c = this.containers.nearestOpenable(rt);
    if (c >= 0) {
      this.containers.open(rt, c);
      return true;
    }
    const g = nearestGroundItem(this, rt);
    if (!g) {
      // D11: F next to the body of your own earlier entry (skipped by nearestOpenable).
      if (this.containers.ownBodyNear(rt)) this.invErr(rt, "own_body");
      return false;
    }
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

  /** Throw a hand grenade now toward `angle`, `frac` 0..1 of the throw range (tests, scripted humans). */
  throwGrenade(id: string, angle: number, frac: number): LiveGrenade | ThrowRefusal {
    const rt = this.actor(id);
    return rt ? throwGrenade(this, rt, angle, frac) : "dead";
  }

  /**
   * C2S.THROW (Weapons v2) in input order: the client throws right after its input `seq` (ThrowMsg.q,
   * default: the newest input queued so far), so the throw waits until the server has applied that
   * input (applyInputs) and starts from the post-input position. Without this a throw right after a
   * predicted roll end met the server one tick behind (still rolling) and was refused. Nothing is
   * pending → thrown at once. A newer request replaces an older pending one.
   */
  requestThrow(id: string, angle: number, frac: number, seq?: number): LiveGrenade | ThrowRefusal | "queued" {
    const rt = this.actor(id);
    if (!rt || !rt.pub.alive) return "dead";
    // The client cannot wait for an input it never sent: clamp to what has arrived.
    const after = Math.min(seq !== undefined && Number.isFinite(seq) ? seq : rt.lastQueuedSeq, rt.lastQueuedSeq);
    rt.pendingThrow = { a: angle, d: frac, seq: after };
    if (this.throwDue(rt)) {
      rt.pendingThrow = null;
      return throwGrenade(this, rt, angle, frac);
    }
    return "queued";
  }

  /** No queued input comes before the pending throw any more (the queue is ordered by seq). */
  private throwDue(rt: PlayerRuntime): boolean {
    const t = rt.pendingThrow;
    return !!t && (rt.queue.length === 0 || rt.queue[0]!.seq > t.seq);
  }

  /** Run the pending throw once every input before it is applied. */
  private runPendingThrow(rt: PlayerRuntime): void {
    const t = rt.pendingThrow;
    if (!t || !this.throwDue(rt)) return;
    rt.pendingThrow = null;
    throwGrenade(this, rt, t.a, t.d);
  }

  searchClose(id: string): void {
    const rt = this.actor(id);
    if (rt) closeSearch(this, rt, "close");
  }

  /** INV_MOVE. Returns the error code (also sent as INV_ERR) or null on success. */
  invMove(id: string, msg: InvMoveMsg): InvErrCode | null {
    // Takes from a search session live in containers.ts (one API for the room, scripted humans and tests).
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
    // Bounded ground (security audit): past GROUND_DROPS_PER_USER only a drop that joins one of the
    // user's own piles is accepted (FREE items vanish and never count).
    const src = isSlotKey(msg.key) ? rt.self.slots.get(msg.key) : undefined;
    if (src && !(src.flags & ITEM_FLAG.FREE) && this.ground.dropsOf(rt) >= GROUND_DROPS_PER_USER && !findDropPile(this, rt, src, msg.qty ?? src.qty)) {
      return this.invErr(rt, "ground_full", msg.key);
    }
    const r = removeForDrop(rt, msg);
    if ("code" in r) return this.invErr(rt, r.code, msg.key);
    if (r.touchedActive) cancelReload(rt);
    if (r.item) {
      const n = Math.floor(this.rng() * 12);
      // A fungible drop joins the dropper's own pile nearby instead of becoming one more entity.
      const pile = findDropPile(this, rt, r.item, r.item.qty);
      if (pile) {
        mergeIntoPile(this, pile, r.item.qty, rt);
      } else {
        const at = dropSpot(this, rt.pub.x, rt.pub.y, n);
        spawnGroundItem(this, r.item, at.x, at.y, rt);
      }
    }
    syncPublic(rt);
    return null;
  }

  private invErr(rt: PlayerRuntime, code: InvErrCode, key?: string): InvErrCode {
    // A flood of INV_* past the op bucket gets one "rate" reply per second, not one per message.
    if (code === "rate") {
      if (this.clock - rt.rateErrAt < 1000) return code;
      rt.rateErrAt = this.clock;
    }
    if (!rt.isNpc) this.emit({ type: "invErr", to: rt.rosterIndex, msg: key === undefined ? { code } : { code, key } });
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
    if (this.world) {
      // D7: the clock is the cycle clock (wall time since the cycle start, monotonic, clamped);
      // a prewarmed room does nothing before its cycle starts. Physics keeps the clamped dt.
      const wall = this.now() - this.world.cycleStartsAt;
      if (wall < 0) return;
      this.state.clockMs = Math.min(this.world.durationMs, Math.max(this.clock, wall));
    } else {
      this.state.clockMs = Math.min(this.clock + dt, MATCH.DURATION_MS);
      const phase = this.clock >= MATCH.EXTRACT_OPEN_AT_MS ? "open" : "drop";
      if (this.state.phase !== phase) this.state.phase = phase;
    }
    // Sample the environment once per tick; vision / sound / audience read the cached sample.
    envNow(this);

    for (const rt of this.ordered) {
      rt.prevX = rt.pub.x;
      rt.prevY = rt.pub.y;
    }
    this.npcs.update(dt);

    for (const rt of this.ordered) {
      if (!rt.pub.alive) continue;
      finishReloadIfDue(this, rt);
      finishHealIfDue(this, rt);
      this.applyInputs(rt, dt);
    }

    stepSearches(this);
    stepBullets(this, dt);
    stepGrenades(this);

    for (const rt of this.ordered) if (rt.pub.alive) autoPickup(this, rt);

    stepExtraction(this);
    if (this.world && this.clock >= this.nextWorldTickAt) {
      this.nextWorldTickAt = this.clock + WORLD_TICK_MS;
      this.worldTick();
    }

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

    // World: never ends for lack of humans; the backstop at the cycle end is the wipe (MIA), never a timeout.
    if (this.world) {
      if (this.clock >= this.world.durationMs) this.wipe();
      return;
    }
    // NPCs never keep a match alive: it ends at 30:00 or once every human left (extract / death /
    // timeout). npcOnlyUntilMs: rule tests that need an NPC-only world for a while.
    let humansAlive = false;
    for (const rt of this.ordered) {
      if (rt.pub.alive && !rt.isNpc) {
        humansAlive = true;
        break;
      }
    }
    if (this.clock >= MATCH.DURATION_MS || (!humansAlive && this.clock >= this.npcOnlyUntilMs)) this.end();
  }

  /**
   * Once a second in world mode: pool placement / boss bag (pool-place.ts), marauder respawns
   * (npc.ts, every RESPAWN_CHECK_MS, spec §3.6), then ground and corpse expiry (A6). The event
   * boss's HP reset runs in NpcSystem.update.
   */
  private worldTick(): void {
    poolTick(this);
    this.npcs.respawnTick();
    this.expireTick();
  }

  /**
   * A6: player-dropped ground items older than GROUND_EXPIRE_MS and corpses older than
   * CORPSE_EXPIRE_MS vanish. Player valuables → expired (treasury), NPC-corpse pool items →
   * expiredToPool (pool, untaxed); fungibles are destroyed. Time-ordered queues: no scan of all items.
   */
  private expireTick(): void {
    const ground = this.ground.expire(this, this.clock);
    const corpses = this.containers.expireCorpses(this.clock);
    for (const it of [...ground, ...corpses.treasury]) {
      this.ledger.resolve(it, "expired");
      this.expired.push(toPlain(it));
    }
    for (const it of corpses.pool) {
      this.ledger.resolve(it, "expired_pool");
      this.expiredToPool.push(toPlain(it));
    }
  }

  /** HUD player counts: humans only (NPCs are not players, and their numbers must not leak). */
  private updateCounters(): void {
    let alive = 0;
    let total = 0;
    for (const rt of this.ordered) {
      if (rt.isNpc) continue;
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
      // Players' rolls vault windows (the client predicts the same); NPCs never vault: their roll
      // treats windows as walls, like their nav and walk grid.
      const r = stepMovement(this.idx, p.x, p.y, readRoll(s), input, healMult, terrainMult, !rt.isNpc);
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
      if (rt.pendingThrow) this.runPendingThrow(rt);
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
        const v = this.ordered.find((r) => r.selfKey === it.ref);
        if (v?.userId) out.victim = v.userId;
        // D22: the killer's userId (full tag price only for them; the web applies NON_KILLER_MULT).
        if (v?.killerUserId) out.by = v.killerUserId;
      }
      return out;
    };
    // World: pool items of this entry never placed go back with the exit (extract only; a death
    // places them at once, the wipe leaves them on the map).
    const unplaced = exit === "extract" ? takeUnplaced(this, rt) : [];
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
    if (rt.entryId) {
      report.entryId = rt.entryId;
      report.enteredAtMs = rt.enteredAtMs;
      report.victims = [...rt.victims];
      report.unplaced = unplaced.map(toSettled);
    }
    if (rt.touch) report.touch = true;
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
      guest: rt.guest,
    };
    rt.outcome = msg;
    this.vision.clearRow(rt.rosterIndex);
    if (!rt.isNpc) {
      this.emit({ type: "outcome", to: rt.rosterIndex, msg });
      // A bullet of theirs still in flight may yet kill (death.ts updates report.kills): the web
      // report goes out once the last one is gone, so the posted kills (XP) are final.
      if (this.bullets.some((b) => b.owner === rt) || hasLiveGrenade(this, rt)) rt.exitHeld = true;
      else this.emit({ type: "exit", report });
    }
  }

  /** Emit the exit reports held for bullets in flight once those bullets are gone. */
  private releaseHeldExits(): void {
    for (const rt of this.ordered) {
      if (!rt.exitHeld || !rt.exitReport || this.bullets.some((b) => b.owner === rt) || hasLiveGrenade(this, rt)) continue;
      rt.exitHeld = false;
      this.emit({ type: "exit", report: rt.exitReport });
    }
  }

  /** Known uids that are not resolved (must be empty once the match ended). */
  ledgerGaps(): string[] {
    return [...this.ledger.known.keys()].filter((uid) => !this.ledger.resolved.has(uid));
  }

  /** Legacy roster match over (30:00 or no human left): whoever is still on the map times out. */
  private end(): void {
    this.close("timeout");
  }

  /**
   * WORLD v6 wipe (D9): every human still on the map leaves with "mia" (everything carried → lost
   * pool, no wear); pending pool items and the boss bag stay on the map (leftOnMap, untaxed); the
   * end report lists every entry. The room calls it at the wipe time; step() is the backstop.
   */
  wipe(): void {
    if (!this.world || this.ended) return;
    this.close("mia");
  }

  private close(exit: "timeout" | "mia"): void {
    // NPCs still standing hold what they carry until the map is gone: their pool uniques (boss bag,
    // carrier) go back to the pool with no wear (leftOnMap), never "lost"; FREE gear just vanishes.
    // (Their fungibles end in the NPC's own exit report, which is never posted.)
    const npcLeft: ItemLike[] = [];
    for (const rt of this.ordered) {
      if (!rt.pub.alive || !rt.isNpc) continue;
      for (const [k, it] of [...rt.self.slots.entries()]) {
        if (!isTrackedUnique(it)) continue;
        npcLeft.push(toPlain(it));
        rt.self.slots.delete(k);
      }
      timeoutPlayer(this, rt);
    }
    for (const rt of this.ordered) if (rt.pub.alive) timeoutPlayer(this, rt, exit);
    this.bullets = [];
    this.grenades = [];
    // Every exit report goes out before the end report (the web's end sweep relies on it).
    this.releaseHeldExits();
    this.state.phase = "ended";
    this.updateCounters();
    const leftOnMap = [...groundUniques(this), ...this.containers.leftInside(), ...npcLeft, ...(this.world ? leftoverPool(this) : [])];
    for (const it of leftOnMap) this.ledger.resolve(it, "left");
    const gaps = this.ledgerGaps();
    if (gaps.length) {
      const msg = `[ledger] match ${this.state.matchId}: ${gaps.length} unresolved uids (${gaps.slice(0, 5).join(", ")})`;
      if (this.ledger.strict) throw new Error(msg);
      console.error(msg);
    }
    // Participants are humans only (v5); NPC totals ride in npcSummary.
    const participants = this.ordered.filter((rt) => !rt.isNpc).map((rt) => ({
      userId: rt.userId,
      nickname: rt.nickname,
      isBot: false,
      exitType: rt.exitReport?.exit ?? (exit as ExitType),
      kills: rt.self.kills,
    }));
    const npcSummary = this.npcs.summary();
    const report: MatchEndReport = {
      matchId: this.state.matchId,
      mapId: this.map.id,
      matchSeed: this.state.mapSeed,
      startedAt: this.state.startedAt,
      endedAt: this.now(),
      participants,
      leftOnMap: leftOnMap.map(toSettled),
      minted: this.mode === "demo" ? [...this.ledger.minted] : [],
      npcSummary,
    };
    if (this.world) {
      report.cycleId = this.world.cycleId;
      report.shard = this.world.shard;
      report.entries = this.ordered.filter((rt) => !rt.isNpc && rt.entryId).map((rt) => rt.entryId);
      report.expired = this.expired.map(toSettled);
      report.expiredToPool = this.expiredToPool.map(toSettled);
    }
    this.report = report;
    this.emit({
      type: "ended",
      report,
      summary: {
        matchId: report.matchId,
        participants: participants.map(({ nickname, isBot, exitType, kills }) => ({ nickname, isBot, exitType, kills })),
        npcSummary,
      },
    });
  }
}

/** Fresh server-side bookkeeping of one participant (roster human or NPC). */
function newRuntime(
  id: string,
  rosterIndex: number,
  selfKey: string,
  entry: Pick<RosterEntry, "userId" | "nickname">,
  npc: boolean,
  p: Player,
  s: SelfState,
  snap: LoadoutSnapshot | undefined,
): PlayerRuntime {
  return {
    id,
    rosterIndex,
    selfKey,
    userId: npc ? null : entry.userId,
    nickname: entry.nickname,
    isNpc: npc,
    isBot: npc,
    dormant: false,
    viewCap: NPC.VIEW_RANGE_CAP,
    connected: false,
    idleSince: -1,
    rateErrAt: -Infinity,
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
    nextThrowAt: 0,
    pendingThrow: null,
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
    stats: { shotsFired: 0, dmgDealt: 0, containersSearched: 0, corpsesSearched: 0, bossKills: 0, npcKills: 0, guardKills: 0 },
    killedBy: "",
    exitReport: null,
    outcome: null,
    entryId: "",
    enteredAtMs: 0,
    guest: false,
    victims: [],
    killerUserId: null,
    pendingPool: [],
    poolApplyAt: 0,
    exitSettled: false,
    partyId: "",
    dropId: "",
    tutorial: false,
    touch: false,
  };
}

function loadoutMap(l: MatchOptions["loadouts"]): LoadoutMap {
  if (!l) return new Map();
  if (Array.isArray(l)) return new Map((l as readonly LoadoutSnapshot[]).map((s) => [s.userId, s]));
  return l as LoadoutMap;
}

/**
 * Spawn spot per human (NPC MODEL v5 §1.2), side-aware (map memo §6): farthest-point sampling over
 * the side spawns. The first spot is random; each next one maximizes its minimum distance to the
 * spots already taken, picked at random among the candidates within 10% of the best, on a side that
 * holds fewer than humanSideCap(n) = ceil(n/4) + 1 humans so far (so humans spread over N/E/S/W).
 * SPAWN_RULES.HUMAN_MIN_SEP_PX (3000 px) then holds for n ≤ 16 on the Steppe. More humans than
 * spots: the extra ones reuse spots in the same order. Spots without a side (hand-made test maps)
 * all count as one side.
 */
export function assignSpawns<T extends { x: number; y: number; side?: MapSide }>(rng: Rng, spots: readonly T[], n: number): T[] {
  if (spots.length === 0 || n <= 0) return [];
  const count = Math.min(n, spots.length);
  // A few random restarts; keep the layout whose closest pair is farthest apart.
  let best: number[] = [];
  let bestScore = -Infinity;
  for (let attempt = 0; attempt < SPAWN_ATTEMPTS; attempt++) {
    const taken = sampleSpawns(rng, spots, n, count);
    let worst = Infinity;
    for (let a = 0; a < taken.length; a++) {
      for (let b = a + 1; b < taken.length; b++) worst = Math.min(worst, Math.hypot(spots[taken[a]!]!.x - spots[taken[b]!]!.x, spots[taken[a]!]!.y - spots[taken[b]!]!.y));
    }
    if (worst > bestScore) {
      bestScore = worst;
      best = taken;
    }
    if (count <= 1) break;
  }
  return Array.from({ length: n }, (_, k) => spots[best[k % best.length]!]!);
}

/** An NPC anchor a human must not spawn next to: a post / BossSpot / guard post and its leash. */
export interface NpcAnchor {
  x: number;
  y: number;
  leash: number;
}

/**
 * Spawn spots clear of the NPCs that spawned (v5 review: a Commander guard post stood 1882 px from a
 * side spawn, and nobody may spawn into a camp: the peace window does not cover a human standing in
 * a post). Preferred: every spot NPC.SPAWN_CLEAR_PX from every anchor (the Steppe generator already
 * keeps marauder posts that far; this adds the boss groups). Too few of those (small test maps):
 * spots outside every anchor's leash + NPC.PEACE_CLOSE_PX. Still too few: every spot.
 */
export function spawnsClearOfNpcs<T extends { x: number; y: number }>(spots: readonly T[], anchors: readonly NpcAnchor[], n: number): readonly T[] {
  if (anchors.length === 0) return spots;
  const need = Math.min(n, spots.length);
  const far = spots.filter((s) => anchors.every((q) => Math.hypot(q.x - s.x, q.y - s.y) >= NPC.SPAWN_CLEAR_PX));
  if (far.length >= need) return far;
  const outside = spots.filter((s) => anchors.every((q) => Math.hypot(q.x - s.x, q.y - s.y) >= q.leash + NPC.PEACE_CLOSE_PX));
  return outside.length >= need ? outside : spots;
}

/** Anchors of the NPCs that spawned: BossSpots and their used guard posts, marauder posts (with leash). */
function npcAnchorsOf(bosses: readonly BossSpot[], squads: readonly NpcSquadSpawn[], posts: readonly NpcPost[]): NpcAnchor[] {
  const out: NpcAnchor[] = [];
  for (const b of bosses) {
    out.push({ x: b.x, y: b.y, leash: BOSS_AI.LEASH_BOSS_PX });
    for (const g of b.guards.slice(0, BOSSES[b.kind].guards.length)) out.push({ x: g.x, y: g.y, leash: BOSS_AI.LEASH_GUARD_PX });
  }
  const byId = new Map(posts.map((p) => [p.id, p]));
  for (const sq of squads) {
    const p = byId.get(sq.postId);
    if (p && sq.members > 0) out.push({ x: p.x, y: p.y, leash: npcLeashPx(p) });
  }
  return out;
}

/** Farthest-point restarts of assignSpawns. */
const SPAWN_ATTEMPTS = 6;

/** One farthest-point sampling pass (assignSpawns): spot indexes in pick order. */
function sampleSpawns<T extends { x: number; y: number; side?: MapSide }>(rng: Rng, spots: readonly T[], n: number, count: number): number[] {
  const dist = (a: T, b: T) => Math.hypot(a.x - b.x, a.y - b.y);
  const sideOf = (i: number) => spots[i]!.side ?? 0;
  const sides = new Set(spots.map((_, i) => sideOf(i))).size;
  const cap = sides > 1 ? humanSideCap(n) : Infinity;
  const taken: number[] = [];
  const used = new Uint8Array(spots.length);
  const near = new Float64Array(spots.length).fill(Infinity);
  const perSide = new Map<number, number>();
  const take = (i: number) => {
    taken.push(i);
    used[i] = 1;
    perSide.set(sideOf(i), (perSide.get(sideOf(i)) ?? 0) + 1);
    for (let j = 0; j < spots.length; j++) near[j] = Math.min(near[j]!, dist(spots[i]!, spots[j]!));
  };
  take(Math.floor(rng() * spots.length));
  while (taken.length < count) {
    const cands: number[] = [];
    // Pass 0 honours the side cap; pass 1 only runs when the capped sides ran out of spots.
    for (let pass = 0; pass < 2 && cands.length === 0; pass++) {
      const ok = (i: number) => !used[i] && (pass === 1 || (perSide.get(sideOf(i)) ?? 0) < cap);
      let top = -Infinity;
      for (let i = 0; i < spots.length; i++) if (ok(i)) top = Math.max(top, near[i]!);
      for (let i = 0; i < spots.length; i++) if (ok(i) && near[i]! >= top * 0.9) cands.push(i);
    }
    take(cands[Math.floor(rng() * cands.length)]!);
  }
  return taken;
}

export function shuffle<T>(rng: Rng, arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}
