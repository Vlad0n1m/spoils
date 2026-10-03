/**
 * Game tuning shared by the game server (authoritative simulation) and the web client
 * (prediction, rendering, HUD). Units: pixels, milliseconds, radians.
 * See docs/GAME_DESIGN.md for the rules these numbers implement.
 * v2 numbers come from the design critique (scratchpad/design/critique.md) and its memos.
 */

export const SERVER_TICK_HZ = 20;
export const SERVER_TICK_MS = 1000 / SERVER_TICK_HZ;

/** Client samples input at a fixed rate; each input moves the player by exactly INPUT_DT_MS. */
export const INPUT_HZ = 30;
export const INPUT_DT_MS = 1000 / INPUT_HZ;
/** Server-side cap on queued inputs per player (anti speed-hack + memory bound). */
export const MAX_QUEUED_INPUTS = 15;

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
  /**
   * NPC MODEL v5 queue ("mm", humans only; NPCs are never players). A window opens on the first
   * join; the match launches at the first of: queue >= MAX_HUMANS (at once); queue >= MIN_HUMANS
   * and >= MIN_WAIT_MS since the window opened; the window ends with >= 1 human (a solo raid against
   * NPCs is legal, SOLO_START_OK). Joiners beyond MAX_HUMANS open the next window (mmShouldLaunch).
   */
  MAX_HUMANS: 24,
  MIN_HUMANS: 12,
  MIN_WAIT_MS: 10_000,
  QUEUE_WINDOW_MS: 45_000,
  SOLO_START_OK: true,
  /** @deprecated v5: humans + bots per match; use MAX_HUMANS (bots are gone). */
  MAX_PLAYERS: 32,
  /** @deprecated v5: the old bot-fill deadline; use QUEUE_WINDOW_MS. */
  MATCHMAKING_TIMEOUT_MS: 4_000,
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
 * Queue rule (MATCH): should the "mm" queue launch now? `queued` humans, `sinceOpenMs` since the
 * window opened, `windowMs` = the window length (env MM_QUEUE_WINDOW_MS, default
 * MATCH.QUEUE_WINDOW_MS). Never launches an empty queue.
 */
export function mmShouldLaunch(queued: number, sinceOpenMs: number, windowMs: number = MATCH.QUEUE_WINDOW_MS): boolean {
  if (queued < 1) return false;
  if (queued >= MATCH.MAX_HUMANS) return true;
  if (queued >= MATCH.MIN_HUMANS && sinceOpenMs >= MATCH.MIN_WAIT_MS) return true;
  return sinceOpenMs >= windowMs && MATCH.SOLO_START_OK;
}

/**
 * v2 world: 24 × 1024 px blocks. The 20,480 px fallback (critique cut 8) is BLOCK = 853.
 * The v1 4800 px map lives on as LEGACY_WORLD (map/legacy.ts) until the new generator lands —
 * code that clamps to the world must use MapData.width/height, never these constants directly.
 */
export const WORLD = {
  BLOCKS: 24,
  BLOCK: 1024,
  WIDTH: 24 * 1024,
  HEIGHT: 24 * 1024,
  /** Thickness of the boundary walls around the map. */
  BORDER: 40,
  /** Terrain grid resolution (ground tiles, footstep material, speed mult). */
  TERRAIN_CELL: 64,
  /** Client bake / interest-management chunk. */
  CHUNK: 1024,
} as const;

/** v1 map size; only map/legacy.ts uses it. */
export const LEGACY_WORLD = {
  WIDTH: 4800,
  HEIGHT: 4800,
  BORDER: 40,
} as const;

/** Bump on any intentional change to generated geometry (invalidates client caches + golden hash). */
export const MAP_GEN_VERSION = 2;

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

/** Free starter kit: fills empty spots only; FREE items never break, drop or extract. */
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
