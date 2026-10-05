/**
 * Game tuning shared by the game server (authoritative simulation) and the web client
 * (prediction, rendering, HUD). Units: pixels, milliseconds, radians.
 * See docs/GAME_DESIGN.md for the rules these numbers implement.
 * v2 numbers come from the design critique (scratchpad/design/critique.md) and its memos.
 */

// 20 Hz keeps the match clock on whole 50 ms steps; the sim's timings (search reveal, extract channel,
// sound repeats, throw cooldowns) are written against that. 30 Hz was tried on 05.10.2026: 13 sim tests
// broke on the fractional 33.3 ms clock, so a faster tick needs its own pass (docs/SCALING.md §9).
export const SERVER_TICK_HZ = 20;
export const SERVER_TICK_MS = 1000 / SERVER_TICK_HZ;

/** Client samples input at a fixed rate; each input moves the player by exactly INPUT_DT_MS. */
export const INPUT_HZ = 30;
export const INPUT_DT_MS = 1000 / INPUT_HZ;
/** Server-side cap on queued inputs per player (anti speed-hack + memory bound). */
export const MAX_QUEUED_INPUTS = 15;

/**
 * Legacy roster matches (sim tests, the loot-yield harness). WORLD v6 maps use the WORLD cycle fields
 * below: 45-minute maps, personal extract arm, no queue (one always-live world, joined by id).
 */
export const MATCH = {
  /** Total match length; players still on the map at the end lose what they carry. */
  DURATION_MS: 30 * 60_000,
  /** Extraction points open after this. 3 min stops spawn-and-extract farming of free kits. */
  EXTRACT_OPEN_AT_MS: 3 * 60_000,
  /** Standing inside an open extraction circle this long extracts the player. */
  EXTRACT_CHANNEL_MS: 10_000,
  /** Fraction of extraction points that close early (at CLOSE_EARLY_AT of the match). */
  EXTRACT_CLOSE_EARLY_FRACTION: 0.5,
  /** 0.83 × 30 min ≈ 25:00. */
  EXTRACT_CLOSE_EARLY_AT: 0.83,
  /** Room stays alive this long after the end so clients receive the final messages. */
  DISPOSE_AFTER_END_MS: 8_000,
} as const;

/**
 * Human spawn rules (NPC MODEL v5, game-server assignSpawns): farthest-point sampling over the side
 * spawns, at most ceil(n / 4) + SIDE_CAP_EXTRA humans per side, HUMAN_MIN_SEP_PX soft (always holds
 * for n <= 16 on the Steppe, best effort above). NPC posts keep NPC.SPAWN_CLEAR_PX from every spawn.
 */
export const SPAWN_RULES = { HUMAN_MIN_SEP_PX: 3000, SIDE_CAP_EXTRA: 1 } as const;

/** Humans allowed on one side for a match of `n` humans: ceil(n / 4) + SPAWN_RULES.SIDE_CAP_EXTRA. */
export function humanSideCap(n: number): number {
  return Math.ceil(Math.max(0, n) / 4) + SPAWN_RULES.SIDE_CAP_EXTRA;
}

/**
 * MAP_GEN_VERSION 4 ("map v2" of the plan): 28 × 1024 px blocks = 28,672 px (+36 % area over the
 * 24-block layout of versions 2–3).
 * The fallback for weak devices (critique cut 8) is BLOCK = 853 (23,884 px).
 * The v1 4800 px map lives on as LEGACY_WORLD (map/legacy.ts) until the new generator lands —
 * code that clamps to the world must use MapData.width/height, never these constants directly.
 */
export const WORLD = {
  BLOCKS: 28,
  BLOCK: 1024,
  WIDTH: 28 * 1024,
  HEIGHT: 28 * 1024,
  /** Thickness of the boundary walls around the map. */
  BORDER: 40,
  /** Terrain grid resolution (ground tiles, footstep material, speed mult). */
  TERRAIN_CELL: 64,
  /** Client bake / interest-management chunk. */
  CHUNK: 1024,
  // ---- WORLD v6: always-live maps aligned to the UTC wall clock (spec D1–D21), overlapping (World v7).
  /**
   * Cycle grid: one cycle every CYCLE_MS, wipes at :00 :45 :30 :15 UTC, 32 maps a day. Cycle k wipes
   * at (k + 1) × CYCLE_MS whatever else changes; the grid never moves.
   */
  CYCLE_MS: 45 * 60_000,
  /**
   * Entry to a map closes this long before its wipe — and at that very moment the next cycle's map
   * opens (overlapping maps, owner 05.10: nobody ever waits for a map). So exactly one cycle accepts
   * entries at any instant, and for these ENTRY_CLOSE_MS two cycles run at once (the closing one
   * finishes for those already on it).
   */
  ENTRY_CLOSE_MS: 10 * 60_000,
  /**
   * A map's whole life, from its opening (the previous cycle's entry close) to its own wipe:
   * CYCLE_MS + ENTRY_CLOSE_MS = 55 min. The match clock (BattleState.clockMs) runs from the opening,
   * so every map timer (time of day, weather, supply drops, hot zones, NPC respawns, the early extract
   * close, the pool's late taper) counts over this span; the first raiders get up to 55 minutes.
   */
  MAP_MS: 55 * 60_000,
  /** Wipe warnings (time left), derived from the clock by the client. */
  WARN_AT_MS: [600_000, 300_000, 60_000] as const,
  /** A map's room is created this long before it opens (its Match idles until its clock 0). */
  PREWARM_MS: 30_000,
  /** Humans on one map (shard). A full map answers world_full. */
  CAPACITY: 24,
  /**
   * A living human without a client (never attached after admission, or disconnected) holds one of
   * the CAPACITY seats only this long (security audit: idle bodies of throwaway accounts locked the
   * world for a whole cycle). The body stays on the map and its owner can always rejoin it.
   */
  IDLE_SEAT_MS: 90_000,
  /**
   * Disconnect shelter (page reload protection, game server Match.detach): a raider who drops out of
   * combat — no damage dealt or taken and no shot fired for SHELTER_COMBAT_MS — is hidden for up to
   * this long: invisible to everyone (players and NPCs), untargetable, takes no damage, doesn't block
   * bullets, and its extraction channel pauses. Rejoining within the window, or the window running
   * out, puts it back on the same spot (vulnerable again). In combat at the drop it stays as it was:
   * visible and killable (no combat logging). A sheltered raider still holds its place for the wipe
   * (MIA counts as usual).
   */
  DISCONNECT_SHELTER_MS: 180_000,
  SHELTER_COMBAT_MS: 10_000,
  /**
   * Shards (copies of the map, one battle room each, all in the one game-server process) a cycle may
   * run. Shard 0 opens with the cycle; another one opens on demand while the cycle accepts entries,
   * once every shard of it has fewer than SPARE_SEATS free seats (WorldDirectory). world_full only
   * when all MAX_SHARDS are full. Every shard wipes with its cycle.
   */
  MAX_SHARDS: 4,
  /**
   * Free seats under which a shard counts as full for the on-demand open (= PARTY.MAX_SIZE, so a
   * whole party always finds one shard with room while the next one is starting).
   */
  SPARE_SEATS: 4,
  /** Vision is allocated for this many runtimes (humans + NPCs, never reused) per shard. */
  MAX_RUNTIMES_PER_SHARD: 256,
  /** Admission refuses at MAX_RUNTIMES_PER_SHARD − this (kept for NPC respawns). */
  RUNTIME_HEADROOM: 24,
  /** Entries of one user per cycle (web check). */
  MAX_ENTRIES_PER_CYCLE: 4,
  /** A player's extracts arm this long after their own entry. */
  EXTRACT_ARM_MS: 3 * 60_000,
  /** Early-closing extracts (MapData closesAtMs) close this long before the wipe. */
  EXTRACT_EARLY_CLOSE_MS: 5 * 60_000,
  /** An entry must stay this long on the map to burn a giveaway lock (bind rule, D21). */
  MIN_EXPOSURE_MS: 8 * 60_000,
  /** Late-join spawn tier 1: at least this far from every living human. */
  LATE_SPAWN_MIN_HUMAN_PX: 3000,
  /** Late-join spawn tier 2. */
  LATE_SPAWN_FALLBACK_PX: 2000,
  /** Client: armed auto-enter waits rand(0..this) after openAt. */
  AUTO_ENTER_JITTER_MS: 4_000,
  /** Map #1 = the cycle whose grid slot starts at this instant (planned v6 launch, a UTC midnight; it wipes 45 min later). */
  NUMBER_EPOCH_MS: Date.UTC(2026, 9, 6),
  // ---- Ground and corpse expiry (addendum A6, world mode only; legacy roster matches unchanged).
  /**
   * A loose ground item vanishes this long after it hit the ground (a pick-up and re-drop starts a
   * new timer). Player valuables (DB uniques) → treasury (MatchEndReport.expired), fungibles destroyed.
   */
  GROUND_EXPIRE_MS: 10 * 60_000,
  /**
   * A corpse and everything still in it vanish this long after the death. Player corpse uniques →
   * treasury (expired); NPC-corpse pool items → lost pool untaxed (expiredToPool); the rest destroyed.
   */
  CORPSE_EXPIRE_MS: 15 * 60_000,
  /** Client: the item / corpse blinks during its last this-many ms (GroundItem / Corpse.expiresAt). */
  EXPIRE_WARN_MS: 60_000,
} as const;

/**
 * One world cycle (wall-clock ms). `startAt` = `openAt` = the map opens (the previous cycle's entry
 * close: wipeAt − MAP_MS), and is the match clock 0; entry closes at entryClosesAt; it wipes at wipeAt.
 */
export interface WorldCycle {
  cycle: number;
  startAt: number;
  openAt: number;
  entryClosesAt: number;
  wipeAt: number;
}
/**
 * resetting: before openAt (a prewarmed room, never the cycle worldCycleAt returns); open:
 * [openAt, entryClosesAt); closing: [entryClosesAt, wipeAt) — the next cycle is open meanwhile.
 */
export type WorldPhase = "resetting" | "open" | "closing";

/**
 * Cycle k on the grid: wipeAt = (k + 1) × CYCLE_MS; entryClosesAt = wipeAt − ENTRY_CLOSE_MS;
 * startAt = openAt = wipeAt − MAP_MS (= the entry close of cycle k − 1).
 */
export function worldCycleOf(cycle: number): WorldCycle {
  const c = Math.floor(cycle);
  const wipeAt = (c + 1) * WORLD.CYCLE_MS;
  const startAt = wipeAt - WORLD.MAP_MS;
  return { cycle: c, startAt, openAt: startAt, entryClosesAt: wipeAt - WORLD.ENTRY_CLOSE_MS, wipeAt };
}

/**
 * The cycle accepting entries at wall-clock `nowMs` (exactly one at any instant, so its phase is
 * always "open"): floor((nowMs + ENTRY_CLOSE_MS) / CYCLE_MS). Pure: callers pass their own clock.
 */
export function worldCycleAt(nowMs: number): WorldCycle {
  return worldCycleOf(Math.floor((nowMs + WORLD.ENTRY_CLOSE_MS) / WORLD.CYCLE_MS));
}

/**
 * The cycles whose maps run at `nowMs`, oldest first: the open one, preceded by the previous cycle
 * during its last ENTRY_CLOSE_MS (closing, still on the map for those who entered it).
 */
export function worldCyclesLive(nowMs: number): WorldCycle[] {
  const open = worldCycleAt(nowMs);
  const prev = worldCycleOf(open.cycle - 1);
  return nowMs < prev.wipeAt ? [prev, open] : [open];
}

/** resetting: before openAt; open: [openAt, entryClosesAt); closing: from entryClosesAt on. */
export function worldPhase(c: WorldCycle, nowMs: number): WorldPhase {
  if (nowMs < c.openAt) return "resetting";
  if (nowMs < c.entryClosesAt) return "open";
  return "closing";
}

/**
 * The shard a join goes to, among the running shards of the open cycle (`humans` = raiders on it,
 * `need` = seats the join takes: 1, or a new party drop's size): the fullest one that still has room
 * for `need` (players packed together so maps feel alive; ties → the lower shard index), else the
 * emptiest one — the game server then decides (seats of idle bodies count as free there) and answers
 * world_full when it really is full, opening another shard if MAX_SHARDS allows. null = no shard.
 */
export function pickWorldShard<T extends { shard: number; humans: number }>(shards: readonly T[], need = 1): T | null {
  let best: T | null = null;
  for (const s of shards) {
    if (s.humans + need > WORLD.CAPACITY) continue;
    if (!best || s.humans > best.humans || (s.humans === best.humans && s.shard < best.shard)) best = s;
  }
  if (best) return best;
  for (const s of shards) {
    if (!best || s.humans < best.humans || (s.humans === best.humans && s.shard < best.shard)) best = s;
  }
  return best;
}

/** Public map number: cycle − floor(NUMBER_EPOCH_MS / CYCLE_MS) + 1 (may be ≤ 0 before the epoch). */
export function mapNumber(cycle: number): number {
  return Math.floor(cycle) - Math.floor(WORLD.NUMBER_EPOCH_MS / WORLD.CYCLE_MS) + 1;
}

/** Public per-cycle environment seed (every shard of a cycle has the same weather / time of day). */
export function cycleEnvSeed(cycle: number): number {
  return (Math.imul(cycle, 0x9e3779b1) ^ 0x5f0f1a2b) >>> 0;
}

/** When extract `e` opens for this player: max(e.openAt, self.extractArmAt ?? 0). */
export function extractOpenAtFor(
  e: { openAt: number },
  self: { extractArmAt?: number } | null | undefined,
): number {
  return Math.max(e.openAt, self?.extractArmAt ?? 0);
}

/** v1 map size; only map/legacy.ts uses it. */
export const LEGACY_WORLD = {
  WIDTH: 4800,
  HEIGHT: 4800,
  BORDER: 40,
} as const;

/**
 * Bump on any intentional change to generated geometry or collision flags (invalidates client
 * caches + golden hash). 3: windows became SOLID.WINDOW (the dodge roll vaults them), same layout.
 * 4: map v2 — 28 blocks, new POIs, furnished interiors, more windows, cover and decor.
 */
export const MAP_GEN_VERSION = 4;

export const PLAYER = {
  RADIUS: 24,
  MAX_HP: 100,
  SPEED: 260,
  /** Speed multiplier while healing. */
  HEAL_SPEED_MULT: 0.45,
  /** Speed multiplier while holding Shift (quiet walk). */
  WALK_SPEED_MULT: 0.5,
  /** Pick up ground items / open containers within this distance from the player center. */
  INTERACT_RADIUS: 80,
  /** Ammo and meds are picked up automatically within this distance. */
  AUTO_PICKUP_RADIUS: 40,
} as const;

/**
 * Dodge roll. Lives in the input stream (advanced once per applied input on server and client),
 * not on the clock, so prediction replays it exactly (mobility memo).
 */
export const ROLL = {
  /** Roll length in applied inputs (INPUT_DT_MS each): 10 → 333 ms. */
  TICKS: 10,
  /** Total roll travel in open space, px. */
  DISTANCE: 200,
  /** Inputs from roll START until the next roll may start: 150 → 5.0 s. */
  COOLDOWN_TICKS: 150,
  /** The client repeats roll:true on this many consecutive samples after a Space press. */
  BUFFER_SAMPLES: 6,
} as const;

/** On death every non-free unique breaks with this chance (decided by Vlad, 50%). */
export const BREAK_CHANCE_ON_DEATH = 0.5;

/**
 * Heals are channels: all HP lands when the channel completes (SelfState.healUntil). Firing,
 * switching weapons or rolling cancels the heal and the item is NOT consumed — so HP must not
 * trickle in during the channel, or cancelling would give free healing.
 * MAX_CARRY is v1 only (v2 capacity = stack size × slots).
 */
export const HEAL = {
  bandage: { HP: 25, MS: 3_000, MAX_CARRY: 10 },
  medkit: { HP: 75, MS: 6_000, MAX_CARRY: 3 },
} as const;

/**
 * FREE fallback loadout, shown to players as "Basic gear" (not the paid STARTER_KIT): fills empty spots
 * only; FREE items never break, drop or extract. Anyone can always play with it.
 */
export const FREE_KIT = {
  WEAPON: "pistol",
  AMMO_LIGHT: 36,
  BANDAGES: 1,
  /**
   * v5 review: junk extracted from a live raid entered with no unique at all (the free kit) autosells
   * at this × the day's multiplier. A free-kit full raid made ≈ 1.1k CR (62 CR/min at zero gear risk)
   * — more CR per minute than a geared T2 looter — and alt accounts farm it. Geared raids pay × 1.
   */
  AUTOSELL_MULT: 0.5,
} as const;

/**
 * Container search (inventory memo §2). Opening has a delay, then items reveal one by one
 * (revealMs in inventory.ts). Movement is never gated; the search closes beyond CANCEL_RANGE.
 */
export const SEARCH = {
  OPEN_RANGE: 96,
  /** Hysteresis vs OPEN_RANGE so standing on the edge does not flicker the panel. */
  CANCEL_RANGE: 128,
  OPEN_MS: {
    /** Static containers by MapData tier 0..4 (tier 0 = wilderness stash / small cache). */
    tier: [600, 800, 1000, 1300, 1600] as readonly number[],
    /** Safes and boss stashes take longer on top of the tier delay. */
    safeExtra: 1000,
    cache: 600,
    corpse: 1500,
  },
  REVEAL_UNIQUE_MS: 450,
  REVEAL_PER_RARITY_MS: 200,
  REVEAL_STACK_MS: 350,
  REVEAL_JUNK_MS: 300,
  REVEAL_JUNK_PER_RARITY_MS: 150,
  REVEAL_BROKEN_MS: 250,
  /** Inventory ops token bucket per client. */
  OPS_PER_SEC: 15,
  OPS_BURST: 20,
} as const;

/** Out-of-raid loadout lifecycle (web API). */
export const LOADOUT = {
  LOCK_TTL_MS: 10 * 60_000,
  VOID_GRACE_MS: 10 * 60_000,
} as const;

export const NET = {
  /**
   * Colyseus Encoder.BUFFER_SIZE. Must be set as the first statement of the game server entry,
   * before any room import: the full state of 30 players + containers overflowed the 8 KB default.
   */
  ENCODER_BUFFER_BYTES: 128 * 1024,
} as const;

/** Budgets asserted by perf tests and the F3 overlay (perf memo §5). */
export const PERF_BUDGET = {
  SERVER_STEP_AVG_MS: 3,
  SERVER_STEP_P99_MS: 10,
  SERVER_STEP_MAX_MS: 25,
  ENCODE_ALL_VIEWS_MS: 1,
  /** Bot path planning budget per tick (region graph + PathPlanner). */
  PATH_PLAN_MS_PER_TICK: 2,
  ROOM_HEAP_MB: 60,
  NET_DOWN_AVG_BPS: 6 * 1024,
  NET_DOWN_BRAWL_BPS: 12 * 1024,
  NET_TICK_P99_BYTES: 2048,
  JOIN_SNAPSHOT_BYTES: 16 * 1024,
  NET_UP_BPS: 2 * 1024,
  CLIENT_JS_FRAME_P95_MS: 5,
  CLIENT_GPU_FRAME_MS: 8,
  HUD_COMMITS_PER_S: 10,
  MAP_BUILD_MS: 300,
  CHUNK_BAKE_MS: 4,
} as const;

/** Shared HTTP headers between game server and web API. */
export const HEADERS = {
  GAME_SERVER_SIG: "x-game-server-signature",
  GAME_SERVER_TS: "x-game-server-timestamp",
} as const;

/** Join tickets older than this are rejected by the game server. */
export const JOIN_TICKET_TTL_MS = 5 * 60_000;
