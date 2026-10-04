/**
 * Map data types ("Steppe" layout, map memo + critique; MAP_GEN_VERSION 4 = the 28-block "map v2"). The layout is FIXED per map version
 * (generateMap(id), memoized); the match seed drives only loot, bosses and weather. Server and
 * client build the same MapData locally, so static geometry never goes over the network — the
 * client sends mapHash(map) on join to catch generator drift.
 *
 * Generator determinism rules (enforced by a source-grep test owned by the map agent): only
 * mulberry32, + - * /, Math.floor/round/min/max/abs/sqrt; integer coordinates; no trig/hypot/pow.
 */

import type { Circle, Rect, SolidCircle, SolidRect } from "../geometry.js";

/**
 * Terrain kinds stored in MapData.terrain (one byte per TERRAIN_CELL² cell). The high bit
 * TERRAIN_INDOOR is OR-ed in under building floors (indoor ambience, rain on roof); always mask
 * with TERRAIN_KIND_MASK before comparing kinds.
 */
export const TERRAIN = {
  GRASS: 0, FOREST: 1, DIRT: 2, ASPHALT: 3, CONCRETE: 4, WOOD: 5, WATER: 6, BRIDGE: 7, GRAVEL: 8, SHALLOW: 9,
} as const;
export type Terrain = (typeof TERRAIN)[keyof typeof TERRAIN];
export const TERRAIN_INDOOR = 0x80;
export const TERRAIN_KIND_MASK = 0x7f;

export type MapId = "steppe";
export const MAP_IDS: readonly MapId[] = ["steppe"];
export const MAPS: Record<MapId, { layoutSeed: number; name: string }> = {
  steppe: { layoutSeed: 0x5eed_2026, name: "The Outskirts" },
};

export type ZoneKind =
  | "village" | "farm" | "lumber" | "industrial" | "gas" | "rail" | "military" | "checkpoint" | "quarry";
/** 0 = wilderness … 4 = the best POI cores. Drives container fill chance and pool placement. */
export type LootTier = 0 | 1 | 2 | 3 | 4;
/** Bosses (economy BOSSES): Foreman holds the Grain Elevator, Commander the Radar Base, Warden the Rail Depot. */
export type BossKind = "foreman" | "commander" | "warden";
/** Fixed order (boss rng streams index it): never reorder, only append. */
export const BOSS_KINDS: readonly BossKind[] = ["foreman", "commander", "warden"];

export interface Zone {
  id: string;
  name: string;
  kind: ZoneKind;
  tier: LootTier;
  rect: Rect;
  boss?: BossKind;
}

export interface Road {
  kind: "asphalt" | "dirt" | "rail";
  width: number;
  /** Polyline, flat [x0, y0, x1, y1, …], integers. */
  pts: number[];
}

export type PropKind =
  | "border" | "wall" | "window" | "concrete_wall" | "fence" | "crate" | "ship_container" | "shelf" | "wagon"
  | "sandbags" | "car" | "logpile" | "watchtower" | "silo" | "water"
  // MAP_GEN_VERSION 4 interiors (BuiltBuilding.furniture): low cover (MOVE|SHOT) unless noted.
  | "table" | "desk" | "sofa" | "armchair" | "bed" | "counter"
  /** Tall locker bank (ALL). */
  | "lockers";

/** A solid rectangle with collision flags `f` (SOLID bits) and a render kind. */
export interface MapRect extends SolidRect {
  k: PropKind;
  /** 0 = horizontal, 1 = vertical sprite orientation. */
  o?: 0 | 1;
  /**
   * Render variant (art only, never collision; not part of mapHash): see PROP_VARIANTS. Absent = 0.
   */
  v?: number;
}

/**
 * Render variants per prop kind (MapRect.v indexes these lists; the client maps them to sprites).
 * fence: chain-link / wooden / corrugated / barbed; car: wreck / burnt / pickup; crate: plain /
 * small / open / military; shelf: warehouse rack / metal / wooden; table: square / round.
 */
export const PROP_VARIANTS = {
  fence: ["chain", "wood", "corrugated", "barbed"],
  car: ["wreck", "burnt", "pickup"],
  crate: ["plain", "small", "open", "military"],
  shelf: ["rack", "metal", "wood"],
  table: ["square", "round"],
} as const;

/** Trees collide with their trunk (MapCircle r); the canopy drawn around it is this many times bigger. */
export const TREE_CANOPY_MULT = 2.6;

export type CircleKind = "tree" | "rock" | "barrel" | "silo";
/** A solid circle (trunk / rock / barrel) with collision flags `f`. Tree canopies are cosmetic. */
export interface MapCircle extends SolidCircle {
  k: CircleKind;
}

/**
 * Cosmetic decal (render only, never collision, not hashed; footstep material comes from the
 * terrain grid). Ground stains: puddle, oil, dirt, debris. MAP_GEN_VERSION 4 decor drawn above
 * floors: rugs, paper litter, brick / plank rubble, and street furniture without collision (lamp
 * posts, sign posts, notice boards — a top-down post is mostly overhang).
 */
export type DecalKind =
  | "puddle" | "oil" | "dirt" | "debris"
  | "rug" | "rug_round" | "papers" | "bricks" | "planks" | "lamp" | "sign" | "board";

export interface Decal {
  x: number;
  y: number;
  /** Half extent (px): the sprite covers x ± r, y ± r. */
  r: number;
  k: DecalKind;
  /** Quarter turns (0–3) for decor that has a direction (lamp arm, rug, board). Absent = 0. */
  a?: 0 | 1 | 2 | 3;
}

export type BuildingArch =
  | "houseS" | "houseM" | "barn" | "shed" | "warehouse" | "office" | "shop" | "barracks" | "bunker"
  // MAP_GEN_VERSION 4: town and roadside buildings.
  | "clinic" | "garage" | "diner";

/**
 * A building footprint. Its walls/windows are ordinary entries of MapData.rects (k "wall" /
 * "window"); doors are gaps listed here for nav and rendering. No openable doors in v2: they would
 * break the static collision index and client prediction.
 */
export interface Building {
  arch: BuildingArch;
  /** Zone id, "" when outside any zone. */
  zone: string;
  floor: Rect;
  /** BSP rooms (interior, excluding walls). */
  rooms: Rect[];
  /** Door gaps (in walls). */
  doors: Rect[];
  floorTerrain: Terrain;
}

export type ContainerKind = "crate" | "toolbox" | "fridge" | "pc" | "med_case" | "weapon_box" | "safe" | "stash";
export const CONTAINER_KINDS: readonly ContainerKind[] = [
  "crate", "toolbox", "fridge", "pc", "med_case", "weapon_box", "safe", "stash",
];

/**
 * Static container, identified by its index in MapData.containers. Never a schema entity: state
 * only carries BattleState.containerState[i] (CONTAINER_STATE) and the revealed contents go in the
 * `loot` view map keyed `c<i>`.
 */
export interface ContainerSpot {
  x: number;
  y: number;
  kind: ContainerKind;
  tier: LootTier;
  /** Zone id or null in the wilderness. */
  zone: string | null;
}

/** Loose floor loot position (ammo / meds / junk rolled per match). */
export interface LootSpot {
  x: number;
  y: number;
  tier: LootTier;
}

/** 0 = N, 1 = E, 2 = S, 3 = W. */
export type MapSide = 0 | 1 | 2 | 3;

export interface SpawnSpot {
  x: number;
  y: number;
  side: MapSide;
}

/** v2 ships always-open side-based extracts only (paid / switch / timed are cut). */
export type ExtractKind = "always";

export interface ExtractSpot {
  id: string;
  name: string;
  x: number;
  y: number;
  r: number;
  side: MapSide;
  kind: ExtractKind;
  /** Optional timed close (critique: "timed close at 25:00 if time allows"); undefined = open to the end. */
  closesAtMs?: number;
}

/** Boss spawn (cut 3 may drop bosses; the array is then empty). */
export interface BossSpot {
  kind: BossKind;
  zone: string;
  x: number;
  y: number;
  guards: Array<{ x: number; y: number }>;
  /** Spawn chance per match, rolled from the match seed. */
  chance: number;
}

/** NpcPost.kind: a yard in front of a POI building, a road entering a zone, or a wild road camp. */
export type NpcPostKind = "poi" | "gate" | "road";

/**
 * A marauder squad post (NPC MODEL v5, placeNpcPosts). Not part of mapHash: posts are generated
 * from their own rng stream after everything else and reserve nothing, so they never move geometry.
 * The squad holds `x/y` (or walks `patrol`, 0–3 points within leash/2) and leashes to it.
 */
export interface NpcPost {
  /** Index in MapData.npcPosts (stable: rollNpcSpawns / carrier keys "npc:<id>.<member>" use it). */
  id: number;
  /** Zone id, null for road camps in the wilds. */
  zone: string | null;
  /** Zone tier (marauder class via npcClassOfPost); road camps are 0. */
  tier: LootTier;
  kind: NpcPostKind;
  x: number;
  y: number;
  /** Patrol points (empty = the squad holds the post). */
  patrol: Array<{ x: number; y: number }>;
  /** Squad size [min, max], uniform. */
  size: [number, number];
  /** Spawn chance per match (one draw per post, rollNpcSpawns). */
  chance: number;
}

export type AmbientKind = "river" | "sawmill" | "generator" | "forest" | "wind";
/** Positional ambient sound source for the client audio. */
export interface AmbientEmitter {
  x: number;
  y: number;
  r: number;
  k: AmbientKind;
}

export interface MapData {
  id: MapId;
  /** MAP_GEN_VERSION at generation time. */
  genVersion: number;
  /** Layout seed (MAPS[id].layoutSeed), NOT the match seed. */
  seed: number;
  width: number;
  height: number;
  /** One byte per cell: Terrain | TERRAIN_INDOOR. Row-major, terrainCols × terrainRows. */
  terrain: Uint8Array;
  terrainCols: number;
  terrainRows: number;
  terrainCell: number;
  zones: Zone[];
  roads: Road[];
  /** River centre line, flat [x0, y0, …]. */
  river: number[];
  /** Every solid rectangle (border, walls, windows, props, water runs) with flags. */
  rects: MapRect[];
  /** Every solid circle (trunks, rocks, barrels) with flags. */
  circles: MapCircle[];
  /** Sight-only concealment (fog of war); NOT in the collision index. */
  bushes: Circle[];
  decals: Decal[];
  buildings: Building[];
  /** Static containers; the index is the container id everywhere (containerState, loot key c<i>). */
  containers: ContainerSpot[];
  lootSpots: LootSpot[];
  spawns: SpawnSpot[];
  /** At most 8 (extractMask is a uint8 bit set over this array). */
  extracts: ExtractSpot[];
  bosses: BossSpot[];
  ambient: AmbientEmitter[];
  /**
   * Marauder posts (NPC MODEL v5). Always set by generateMap; optional only so hand-built test
   * maps still type-check (read it through npcPostsOf). Not hashed.
   */
  npcPosts?: NpcPost[];
}

/** Walkability grid (shared so tests and server nav use the same definition). */
export interface WalkGrid {
  cell: number;
  cols: number;
  rows: number;
  /** 1 = a player circle centred in this cell would overlap a MOVE solid. */
  blocked: Uint8Array;
}

/** Footstep material (sound variant for steps, audio sample choice). Index = variant number. */
export const STEP_MATERIALS = ["grass", "dirt", "asphalt", "wood", "concrete", "water", "forest", "gravel"] as const;
export type StepMaterial = (typeof STEP_MATERIALS)[number];
