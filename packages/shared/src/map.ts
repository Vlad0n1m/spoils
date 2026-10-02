/**
 * Deterministic map generation. The server picks a seed per match and puts it into the state
 * (BattleState.mapSeed); server and client both call generateMap(seed) and get identical
 * geometry, so the static map never goes over the network.
 */

import { WORLD } from "./constants.js";
import {
  buildCollisionIndex,
  type Circle,
  type CollisionIndex,
  type Rect,
  rectsOverlap,
} from "./geometry.js";
import type { Rarity } from "./items.js";
import { mulberry32, pickWeighted, randInt, randRange, type Rng } from "./rng.js";

export const WALL_THICKNESS = 24;
export const DOOR_WIDTH = 96;
export const CRATE_SIZE = 64;
/** Trees collide with their trunk; the canopy drawn around it is this many times bigger. */
export const TREE_CANOPY_MULT = 2.6;
export const EXTRACT_RADIUS = 110;

export interface Building {
  floor: Rect;
  walls: Rect[];
}

export interface ChestSpot {
  x: number;
  y: number;
  rarity: Rarity;
}

export interface MapData {
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
  buildings: Building[];
  chestSpots: ChestSpot[];
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

export function generateMap(seed: number): MapData {
  const rng = mulberry32(seed);
  const W = WORLD.WIDTH;
  const H = WORLD.HEIGHT;
  const B = WORLD.BORDER;

  const map: MapData = {
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

/** Collision index over everything solid on the map (walls, crates, rocks, tree trunks). Cached per seed. */
export function getCollisionIndex(map: MapData): CollisionIndex {
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
