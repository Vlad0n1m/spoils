/**
 * In-raid META GOALS (GAME_DESIGN §7d): objectives beyond loot-and-extract. Rules and pure helpers
 * shared by the game server (sim/objectives.ts runs them), the client and the tests.
 *
 * - LOCKED ROOMS (map/locks.ts): one room per T2–T4 POI behind a gate that needs that POI's key
 *   (ROOM_KEYS, CR-economy junk). Keys come from the shard's secret loot seed: per cycle each lock's
 *   key spawns with KEY.SPAWN_CHANCE in ONE holder — a container of its POI (outside the room), a
 *   marauder of a post in it, or its boss when that boss is this cycle's event boss. Unlocking is
 *   an LOCK.UNLOCK_MS channel at the gate (damage or moving away breaks it); the key is consumed and
 *   the gate stays open for everyone until the wipe. Inside: the room's own containers roll as usual
 *   plus STRONGROOM rolls (charged to OBJ_BUDGET), and pool-eligible ones (T3/T4, pool kinds) get
 *   × LOCK.POOL_WEIGHT_MULT pool placement weight — the release count stays the risk rule's
 *   (POOL), nothing is ever minted.
 * - SAFE CRACKING: the safes of crackSafes(map) take a CRACK.MS channel before their first opening
 *   (damage or moving breaks it, progress is lost); a loud dial tick is heard every TICK_MS. Once
 *   cracked the safe opens as usual for everyone, contents = the ordinary safe table.
 * - HIDDEN CACHES: CACHE.COUNT secret points per cycle (secret seed), each a small stash nobody sees
 *   from farther than CACHE.FIND_PX (the server never sends it before). Clue notes (CACHE_NOTE_DEF)
 *   in CACHE.NOTES_PER_CACHE seeded containers name the spot ("By the silo, Grain Elevator") and
 *   carry a fuzzy circle (CACHE.CLUE_R, centre offset up to CLUE_OFFSET_MAX × R) drawn on the
 *   holder's own full map. Contents: CACHE_LOOT, junk charged to OBJ_BUDGET.
 * - XP: unlocking, cracking and opening a cache each count one objective (XP.OBJECTIVE, at most
 *   XP.OBJECTIVE_MAX per entry; RaidStats.objectives → xpForExit "objectives" line).
 * - ECONOMY: the junk CR these add per cycle is capped at OBJ_BUDGET.JUNK_CR (shared by strongroom
 *   rolls and caches; past it they roll consumables only), plus at most one key per lock (KEY_VALUE_CR,
 *   sold only when carried out unused). Notes are worth 0.
 */

import { CACHE_NOTE_DEF } from "./item-defs.js";
import { lockedRooms, lockOfContainer } from "./map/locks.js";
import type { MapData } from "./map/types.js";
import { mulberry32 } from "./rng.js";
import { eventSeed, type EventLootEntry } from "./world-events.js";

export const LOCK = {
  /** Unlock channel at the gate (key in the bag). */
  UNLOCK_MS: 3_000,
  /** F range: player centre to the nearest point of a gate. */
  INTERACT_PX: 110,
  /** A channel (unlock / crack) breaks when the player moves this far from where it started. */
  MOVE_TOL_PX: 24,
  /** An unlocked gate whose public flag is still deferred is told at once to humans this close. */
  NEAR_REVEAL_PX: 420,
  /** Pool placement weight multiplier of an eligible (T3/T4, pool kind) container in a locked room. */
  POOL_WEIGHT_MULT: 3,
  /** Extra STRONGROOM_LOOT rolls per locked-room container (junk charged to OBJ_BUDGET). */
  STRONGROOM_ROLLS: 1,
} as const;

export const KEY = {
  /** Chance a lock's key exists this cycle. */
  SPAWN_CHANCE: 0.7,
  /** Holder weights (renormalised over the holders the POI has). */
  HOLDER_WEIGHT: { container: 6, marauder: 3, boss: 3 },
} as const;

export const CRACK = {
  MS: 12_000,
  /** Dial tick every this many ms while cracking: a search sound × SOUND_RANGE_MULT (600 → 1 500 px). */
  TICK_MS: 1_000,
  SOUND_RANGE_MULT: 2.5,
  /** SoundKind.search variant of the dial tick (0 = the ordinary rummage). */
  SOUND_VARIANT: 1,
  /** Safes of at least this tier, outside locked rooms, every other one in index order (crackSafes). */
  MIN_TIER: 3,
} as const;

export const CACHE = {
  COUNT: 3,
  /** Rolls of CACHE_LOOT per cache (no empty rolls). */
  ROLLS: 3,
  /** Open delay of a cache (corpse-like target "hc<n>"). */
  OPEN_MS: 2_500,
  /** A human sees (and may open) a cache only within this distance and line of sight. */
  FIND_PX: 200,
  /** Clue circle radius on the full map, and the centre's max offset from the cache (× R). */
  CLUE_R: 700,
  CLUE_OFFSET_MAX: 0.55,
  /** Notes per cache, each in a different seeded container (T1–T3, outside locked rooms). */
  NOTES_PER_CACHE: 2,
  NOTE_MIN_TIER: 1,
  NOTE_MAX_TIER: 3,
  /** Point samples tried per cache. */
  TRIES: 60,
  /** Landmark search radius around a cache point (clue wording). */
  LANDMARK_PX: 260,
} as const;

/** Junk CR strongroom rolls and caches may add to one cycle; past it they roll consumables only. */
export const OBJ_BUDGET = {
  JUNK_CR: 400,
} as const;

/** Extra roll of a locked-room container: mid junk, meds, ammo. EV ≈ 95 junk CR + 55 CR-eq per roll. */
export const STRONGROOM_LOOT: readonly EventLootEntry[] = [
  { def: "junk_battery", weight: 14, qty: 1 },
  { def: "junk_fuel", weight: 10, qty: 1 },
  { def: "junk_circuit", weight: 8, qty: 1 },
  { def: "junk_hdd", weight: 5, qty: 1 },
  { def: "ammo_light", weight: 18, qty: 30 },
  { def: "ammo_shell", weight: 10, qty: 10 },
  { def: "bandage", weight: 14, qty: 2 },
  { def: "medkit", weight: 6, qty: 1 },
  { def: "grenade", weight: 6, qty: 1 },
];

/** Hidden cache: survival consumables and cheap junk. EV ≈ 30 junk CR + 60 CR-eq per roll. */
export const CACHE_LOOT: readonly EventLootEntry[] = [
  { def: "junk_canned", weight: 16, qty: 2 },
  { def: "junk_water", weight: 14, qty: 2 },
  { def: "junk_pills", weight: 8, qty: 1 },
  { def: "junk_battery", weight: 6, qty: 1 },
  { def: "ammo_light", weight: 22, qty: 30 },
  { def: "ammo_shell", weight: 12, qty: 10 },
  { def: "bandage", weight: 16, qty: 2 },
  { def: "medkit", weight: 6, qty: 1 },
  { def: "grenade", weight: 6, qty: 1 },
];

// ---------------------------------------------------------------- crack safes

const crackCache = new WeakMap<MapData, ReadonlySet<number>>();

/**
 * Safes that need cracking (deterministic per map, public knowledge like the layout): kind "safe",
 * tier >= CRACK.MIN_TIER, not inside a locked room, every other one of those in index order.
 */
export function crackSafes(map: MapData): ReadonlySet<number> {
  let s = crackCache.get(map);
  if (s) return s;
  const out = new Set<number>();
  let k = 0;
  map.containers.forEach((c, i) => {
    if (c.kind !== "safe" || c.tier < CRACK.MIN_TIER || lockOfContainer(map, i)) return;
    if (k++ % 2 === 0) out.add(i);
  });
  s = out;
  crackCache.set(map, s);
  return s;
}

// ---------------------------------------------------------------- hidden caches

/** Corpse id of hidden cache n (1-based). Never public before a human is within CACHE.FIND_PX. */
export function cacheId(n: number): string {
  return `hc${n}`;
}

export function isCacheId(id: string): boolean {
  return /^hc\d+$/.test(id);
}

/** Loot key ("k" + Corpse id) of a hidden cache. */
export function isCacheKey(key: string): boolean {
  return key.startsWith("k") && isCacheId(key.slice(1));
}

/** InvItem.ref of a clue note: the fuzzy circle (integers). */
export function encodeClueRef(n: number, x: number, y: number, r: number): string {
  return `cache:${n}:${Math.round(x)}:${Math.round(y)}:${Math.round(r)}`;
}

export function decodeClueRef(ref: string): { n: number; x: number; y: number; r: number } | null {
  const m = /^cache:(\d+):(-?\d+):(-?\d+):(\d+)$/.exec(ref);
  if (!m) return null;
  return { n: Number(m[1]), x: Number(m[2]), y: Number(m[3]), r: Number(m[4]) };
}

/** Is this item a clue note? */
export function isClueNote(it: { def: string }): boolean {
  return it.def === CACHE_NOTE_DEF;
}

/** Landmark phrase of a prop kind (clue wording), null when the kind is no landmark. */
export function landmarkPhrase(kind: string): string | null {
  switch (kind) {
    case "watchtower": return "Under the watchtower";
    case "silo": return "By the silo";
    case "ship_container": return "Behind the container";
    case "wagon": return "By the rail wagon";
    case "car": return "By the wrecked car";
    case "logpile": return "By the log pile";
    case "sandbags": return "Behind the sandbags";
    case "water": return "By the water";
    case "barrel": return "By the barrels";
    case "rock": return "By the big rock";
    case "crate": return "Among the crates";
    case "tree": return "Under a tree";
    default: return null;
  }
}

/** Clue text (≤ 64 chars, the exit report's label bound). */
export function clueText(phrase: string, place: string): string {
  const s = `${phrase}, ${place}`;
  return s.length <= 64 ? s : s.slice(0, 64);
}

/** Fuzzy circle centre of cache n at (x, y) from the secret seed: within CLUE_OFFSET_MAX × CLUE_R. */
export function clueCircle(lootSeed: number, n: number, x: number, y: number): { x: number; y: number; r: number } {
  const rng = mulberry32(eventSeed(lootSeed, CLUE_SALT, n));
  const a = rng() * Math.PI * 2;
  const d = CACHE.CLUE_R * CACHE.CLUE_OFFSET_MAX * (0.3 + 0.7 * rng());
  return { x: Math.round(x + Math.cos(a) * d), y: Math.round(y + Math.sin(a) * d), r: CACHE.CLUE_R };
}

const CLUE_SALT = 0xc1_0e5a17;

// ---------------------------------------------------------------- public lock state

/** BattleState.lockState values per lockedRooms(map) index (empty array = objectives off). */
export const LOCK_STATE = { LOCKED: 0, OPEN: 1 } as const;

/** The key def a lock needs (ROOM_KEYS name via itemDef). */
export function lockKeyDef(map: MapData, id: number): string | null {
  return lockedRooms(map)[id]?.key ?? null;
}
