/**
 * LEGACY v1 map (4800 px, seed-driven layout). Kept so the server migration (WP1) can run on the
 * small map until the v2 generator (generateMap("steppe")) lands in WP-M2. Delete after WP-M2.
 *
 * legacyMap(seed) is the untouched v1 generator (same seed → same geometry as v1 clients).
 * legacyMapData(seed) adapts it to the v2 MapData shape so all v2 code paths (collision masks,
 * containers by index, spawns by side, extracts, terrain) can run on it unchanged.
 */

import { LEGACY_WORLD } from "../constants.js";
import {
  buildCollisionIndex,
  SOLID,
  type Circle,
  type CollisionIndex,
  type Rect,
  rectsOverlap,
} from "../geometry.js";
import type { Rarity } from "../items.js";
import { mulberry32, pickWeighted, randInt, randRange, type Rng } from "../rng.js";
import {
  TERRAIN,
  TERRAIN_INDOOR,
  type ContainerSpot,
  type ExtractSpot,
  type LootTier,
  type MapCircle,
  type MapData,
  type MapRect,
  type MapSide,
} from "./types.js";

export const LEGACY_WALL_THICKNESS = 24;
export const LEGACY_DOOR_WIDTH = 96;
export const LEGACY_CRATE_SIZE = 64;
export const LEGACY_EXTRACT_RADIUS = 110;
const WALL_THICKNESS = LEGACY_WALL_THICKNESS;
const DOOR_WIDTH = LEGACY_DOOR_WIDTH;
const CRATE_SIZE = LEGACY_CRATE_SIZE;
const EXTRACT_RADIUS = LEGACY_EXTRACT_RADIUS;
/** Trees collide with their trunk; the canopy drawn around it is this many times bigger. */
const TREE_CANOPY_MULT = 2.6;

export interface LegacyBuilding {
  floor: Rect;
  walls: Rect[];
}

export interface LegacyChestSpot {
  x: number;
  y: number;
  rarity: Rarity;
}

export interface LegacyMapData {
  seed: number;
  width: number;
  height: number;
  /** Border walls + building walls. Block movement and bullets. */
  walls: Rect[];
  /** Block movement and bullets. */
  crates: Rect[];
  /** Block movement and bullets. */
  rocks: Circle[];
  /** Trunk circles: block movement and bullets. Canopy is cosmetic (TREE_CANOPY_MULT). */
  trees: Circle[];
  /** Cover only: drawn over players, do not block anything. */
  bushes: Circle[];
  /** Decorative dirt patches for the ground layer. */
  dirt: Circle[];
  buildings: LegacyBuilding[];
  chestSpots: LegacyChestSpot[];
  extractSpots: Circle[];
  spawnSpots: Array<{ x: number; y: number }>;
  /** Floor loot positions (ammo, meds, occasional weapon). */
  lootSpots: Array<{ x: number; y: number }>;
}

/** Weights for chests placed in the open and in buildings (legendary is placed separately). */
const OPEN_CHEST_RARITY = [
  { rarity: 0 as Rarity, weight: 70 },
  { rarity: 1 as Rarity, weight: 30 },
];
const BUILDING_CHEST_RARITY = [
  { rarity: 0 as Rarity, weight: 30 },
  { rarity: 1 as Rarity, weight: 52 },
  { rarity: 2 as Rarity, weight: 18 },
];

const COUNTS = {
  buildings: 11,
  crates: 46,
  rocks: 34,
  trees: 56,
  bushes: 70,
  dirt: 26,
  openChests: 16,
  extracts: 4,
  spawns: 24,
  loot: 70,
};

export function legacyMap(seed: number): LegacyMapData {
  const rng = mulberry32(seed);
  const W = LEGACY_WORLD.WIDTH;
  const H = LEGACY_WORLD.HEIGHT;
  const B = LEGACY_WORLD.BORDER;

  const map: LegacyMapData = {
    seed, width: W, height: H,
    walls: [
      { x: 0, y: 0, w: W, h: B },
      { x: 0, y: H - B, w: W, h: B },
      { x: 0, y: 0, w: B, h: H },
      { x: W - B, y: 0, w: B, h: H },
    ],
    crates: [], rocks: [], trees: [], bushes: [], dirt: [], buildings: [],
    chestSpots: [], extractSpots: [], spawnSpots: [], lootSpots: [],
  };

  /** Footprints already taken (as rectangles) — new things must not overlap them. */
  const taken: Rect[] = [];
  const isFree = (r: Rect, margin: number) =>
    r.x >= B + margin && r.y >= B + margin &&
    r.x + r.w <= W - B - margin && r.y + r.h <= H - B - margin &&
    !taken.some((t) => rectsOverlap(t, r, margin));
  const circleRect = (x: number, y: number, r: number): Rect => ({ x: x - r, y: y - r, w: r * 2, h: r * 2 });

  /** Try random positions until one is free; returns the center or null. */
  const place = (w: number, h: number, margin: number, tries = 60, area?: Rect) => {
    for (let i = 0; i < tries; i++) {
      const ax = area?.x ?? B;
      const ay = area?.y ?? B;
      const aw = area?.w ?? W - 2 * B;
      const ah = area?.h ?? H - 2 * B;
      const x = randRange(rng, ax + w / 2, ax + aw - w / 2);
      const y = randRange(rng, ay + h / 2, ay + ah - h / 2);
      const r = { x: x - w / 2, y: y - h / 2, w, h };
      if (isFree(r, margin)) return { x, y, rect: r };
    }
    return null;
  };

  // 1. Extraction points: one per edge, inset from the border, with a clear area around them.
  const inset = 340;
  const edgeAreas: Rect[] = [
    { x: 600, y: B + inset - 150, w: W - 1200, h: 300 },
    { x: 600, y: H - B - inset - 150, w: W - 1200, h: 300 },
    { x: B + inset - 150, y: 600, w: 300, h: H - 1200 },
    { x: W - B - inset - 150, y: 600, w: 300, h: H - 1200 },
  ];
  for (const area of edgeAreas.slice(0, COUNTS.extracts)) {
    const p = place(EXTRACT_RADIUS * 2, EXTRACT_RADIUS * 2, 0, 80, area);
    if (!p) continue;
    map.extractSpots.push({ x: p.x, y: p.y, r: EXTRACT_RADIUS });
    taken.push(circleRect(p.x, p.y, EXTRACT_RADIUS + 60));
  }

  // 2. Buildings: walled rooms with 1–2 doors and a chest inside.
  for (let i = 0; i < COUNTS.buildings; i++) {
    const w = Math.round(randRange(rng, 380, 660));
    const h = Math.round(randRange(rng, 320, 540));
    const p = place(w, h, 140);
    if (!p) continue;
    const floor = p.rect;
    taken.push(floor);
    const walls = buildingWalls(rng, floor);
    map.buildings.push({ floor, walls });
    map.walls.push(...walls);

    const inner = { x: floor.x + WALL_THICKNESS + 40, y: floor.y + WALL_THICKNESS + 40,
      w: floor.w - 2 * WALL_THICKNESS - 80, h: floor.h - 2 * WALL_THICKNESS - 80 };
    const chest = {
      x: randRange(rng, inner.x, inner.x + inner.w),
      y: randRange(rng, inner.y, inner.y + inner.h),
      rarity: pickWeighted(rng, BUILDING_CHEST_RARITY).rarity,
    };
    const loot = {
      x: randRange(rng, inner.x, inner.x + inner.w),
      y: randRange(rng, inner.y, inner.y + inner.h),
    };
    map.chestSpots.push(chest);
    map.lootSpots.push(loot);
    // One or two crates inside as cover, kept clear of the chest and the floor loot.
    for (let c = randInt(rng, 1, 2), tries = 0; c > 0 && tries < 20; tries++) {
      const crate = {
        x: randRange(rng, inner.x, inner.x + inner.w - CRATE_SIZE),
        y: randRange(rng, inner.y, inner.y + inner.h - CRATE_SIZE),
        w: CRATE_SIZE, h: CRATE_SIZE,
      };
      const near = (p: { x: number; y: number }) =>
        rectsOverlap(crate, { x: p.x - 60, y: p.y - 60, w: 120, h: 120 });
      if (near(chest) || near(loot)) continue;
      map.crates.push(crate);
      c--;
    }
  }

  // 3. The single legendary chest goes into the building closest to the map center.
  if (map.buildings.length) {
    const center = { x: W / 2, y: H / 2 };
    let bestI = 0;
    let bestD = Infinity;
    map.buildings.forEach((b, i) => {
      const d = Math.hypot(b.floor.x + b.floor.w / 2 - center.x, b.floor.y + b.floor.h / 2 - center.y);
      if (d < bestD) { bestD = d; bestI = i; }
    });
    map.chestSpots[bestI]!.rarity = 3;
  }

  // 4. Outdoor obstacles.
  for (let i = 0; i < COUNTS.crates; i++) {
    const p = place(CRATE_SIZE, CRATE_SIZE, 50);
    if (!p) continue;
    map.crates.push(p.rect);
    taken.push(p.rect);
    // Sometimes a second crate right next to it.
    if (rng() < 0.45) {
      const r2 = { x: p.rect.x + CRATE_SIZE + 4, y: p.rect.y + randRange(rng, -20, 20), w: CRATE_SIZE, h: CRATE_SIZE };
      if (isFree(r2, 4)) { map.crates.push(r2); taken.push(r2); }
    }
  }
  for (let i = 0; i < COUNTS.rocks; i++) {
    const r = randRange(rng, 38, 66);
    const p = place(r * 2, r * 2, 50);
    if (!p) continue;
    map.rocks.push({ x: p.x, y: p.y, r });
    taken.push(circleRect(p.x, p.y, r));
  }
  for (let i = 0; i < COUNTS.trees; i++) {
    const r = randRange(rng, 30, 40);
    const canopy = r * TREE_CANOPY_MULT;
    const p = place(canopy * 1.6, canopy * 1.6, 30);
    if (!p) continue;
    map.trees.push({ x: p.x, y: p.y, r });
    taken.push(circleRect(p.x, p.y, r + 30));
  }
  for (let i = 0; i < COUNTS.bushes; i++) {
    const r = randRange(rng, 52, 74);
    const p = place(r * 2, r * 2, 20);
    if (!p) continue;
    map.bushes.push({ x: p.x, y: p.y, r });
    taken.push(circleRect(p.x, p.y, r));
  }
  for (let i = 0; i < COUNTS.dirt; i++) {
    map.dirt.push({ x: randRange(rng, B, W - B), y: randRange(rng, B, H - B), r: randRange(rng, 90, 240) });
  }

  // 5. Outdoor chests, spawns and floor loot.
  for (let i = 0; i < COUNTS.openChests; i++) {
    const p = place(70, 70, 40);
    if (!p) continue;
    map.chestSpots.push({ x: p.x, y: p.y, rarity: pickWeighted(rng, OPEN_CHEST_RARITY).rarity });
    taken.push(p.rect);
  }
  for (let i = 0; i < COUNTS.spawns * 4 && map.spawnSpots.length < COUNTS.spawns; i++) {
    const p = place(80, 80, 30);
    if (!p) continue;
    if (map.spawnSpots.some((s) => Math.hypot(s.x - p.x, s.y - p.y) < 650)) continue;
    map.spawnSpots.push({ x: p.x, y: p.y });
  }
  for (let i = 0; i < COUNTS.loot; i++) {
    const p = place(40, 40, 20);
    if (!p) continue;
    map.lootSpots.push({ x: p.x, y: p.y });
  }

  return map;
}

/** Four walls around the floor with 1–2 door gaps. */
function buildingWalls(rng: Rng, f: Rect): Rect[] {
  const T = WALL_THICKNESS;
  const sides = ["top", "bottom", "left", "right"] as const;
  const doors = new Set<(typeof sides)[number]>();
  doors.add(sides[randInt(rng, 0, 3)]!);
  if (rng() < 0.6) doors.add(sides[randInt(rng, 0, 3)]!);

  const walls: Rect[] = [];
  const horizontal = (y: number, door: boolean) => {
    if (!door) return walls.push({ x: f.x, y, w: f.w, h: T });
    const dx = randRange(rng, f.x + 60, f.x + f.w - 60 - DOOR_WIDTH);
    walls.push({ x: f.x, y, w: dx - f.x, h: T });
    walls.push({ x: dx + DOOR_WIDTH, y, w: f.x + f.w - dx - DOOR_WIDTH, h: T });
  };
  const vertical = (x: number, door: boolean) => {
    if (!door) return walls.push({ x, y: f.y, w: T, h: f.h });
    const dy = randRange(rng, f.y + 60, f.y + f.h - 60 - DOOR_WIDTH);
    walls.push({ x, y: f.y, w: T, h: dy - f.y });
    walls.push({ x, y: dy + DOOR_WIDTH, w: T, h: f.y + f.h - dy - DOOR_WIDTH });
  };
  horizontal(f.y, doors.has("top"));
  horizontal(f.y + f.h - T, doors.has("bottom"));
  vertical(f.x, doors.has("left"));
  vertical(f.x + f.w - T, doors.has("right"));
  return walls;
}

const indexCache = new Map<number, CollisionIndex>();

/** v1 collision index (everything blocks everything). Cached per seed. */
export function getLegacyCollisionIndex(map: LegacyMapData): CollisionIndex {
  let idx = indexCache.get(map.seed);
  if (!idx) {
    idx = buildCollisionIndex(
      { rects: [...map.walls, ...map.crates], circles: [...map.rocks, ...map.trees] },
      map.width,
      map.height,
    );
    indexCache.set(map.seed, idx);
    if (indexCache.size > 8) indexCache.delete(indexCache.keys().next().value!);
  }
  return idx;
}

/** Nearest map edge of a point → spawn/extract side (N E S W). */
function sideOf(x: number, y: number, w: number, h: number): MapSide {
  const d = [y, w - x, h - y, x];
  let best = 0;
  for (let i = 1; i < 4; i++) if (d[i]! < d[best]!) best = i;
  return best as MapSide;
}

const legacyDataCache = new Map<number, MapData>();

/**
 * v1 geometry in the v2 MapData shape. Everything is SOLID.ALL (as in v1), terrain is grass with
 * building floors marked wood + TERRAIN_INDOOR, chests become containers (tier = rarity + 1),
 * spawns and extracts get a side from the nearest edge. Cached per seed (≤ 8 entries).
 * Its collision index equals getCollisionIndex(legacyMapData(seed)) from map/query.ts.
 */
export function legacyMapData(seed: number): MapData {
  const hit = legacyDataCache.get(seed);
  if (hit) return hit;
  const m = legacyMap(seed);
  const rects: MapRect[] = [
    ...m.walls.map((r, i): MapRect => ({ ...r, f: SOLID.ALL, k: i < 4 ? "border" : "wall" })),
    ...m.crates.map((r): MapRect => ({ ...r, f: SOLID.ALL, k: "crate" })),
  ];
  const circles: MapCircle[] = [
    ...m.rocks.map((c): MapCircle => ({ ...c, f: SOLID.ALL, k: "rock" })),
    ...m.trees.map((c): MapCircle => ({ ...c, f: SOLID.ALL, k: "tree" })),
  ];
  const cell = 64;
  const cols = Math.ceil(m.width / cell);
  const rows = Math.ceil(m.height / cell);
  const terrain = new Uint8Array(cols * rows); // TERRAIN.GRASS = 0
  for (const b of m.buildings) {
    const f = b.floor;
    for (let r = Math.floor(f.y / cell); r <= Math.min(rows - 1, Math.floor((f.y + f.h) / cell)); r++) {
      for (let c = Math.floor(f.x / cell); c <= Math.min(cols - 1, Math.floor((f.x + f.w) / cell)); c++) {
        const cx = (c + 0.5) * cell, cy = (r + 0.5) * cell;
        if (cx >= f.x && cx < f.x + f.w && cy >= f.y && cy < f.y + f.h) terrain[r * cols + c] = TERRAIN.WOOD | TERRAIN_INDOOR;
      }
    }
  }
  const containers: ContainerSpot[] = m.chestSpots.map((c) => ({
    x: c.x, y: c.y, kind: c.rarity >= 2 ? "weapon_box" : "crate", tier: (c.rarity + 1) as LootTier, zone: null,
  }));
  const extracts: ExtractSpot[] = m.extractSpots.map((e, i) => ({
    id: `X${i + 1}`, name: `Extract ${i + 1}`, x: e.x, y: e.y, r: e.r,
    side: sideOf(e.x, e.y, m.width, m.height), kind: "always",
  }));
  const data: MapData = {
    id: "steppe", genVersion: 1, seed, width: m.width, height: m.height,
    terrain, terrainCols: cols, terrainRows: rows, terrainCell: cell,
    zones: [], roads: [], river: [],
    rects, circles,
    bushes: m.bushes,
    decals: m.dirt.map((d) => ({ ...d, k: "dirt" as const })),
    buildings: m.buildings.map((b) => ({
      arch: "houseS" as const, zone: "", floor: b.floor, rooms: [b.floor], doors: [], floorTerrain: TERRAIN.WOOD,
    })),
    containers,
    lootSpots: m.lootSpots.map((p) => ({ x: p.x, y: p.y, tier: 1 as LootTier })),
    spawns: m.spawnSpots.map((p) => ({ x: p.x, y: p.y, side: sideOf(p.x, p.y, m.width, m.height) })),
    extracts,
    bosses: [],
    ambient: [],
  };
  legacyDataCache.set(seed, data);
  if (legacyDataCache.size > 8) legacyDataCache.delete(legacyDataCache.keys().next().value!);
  return data;
}

/** Canopy multiplier of v1 trees (kept for the legacy renderer). */
export const LEGACY_TREE_CANOPY_MULT = TREE_CANOPY_MULT;
