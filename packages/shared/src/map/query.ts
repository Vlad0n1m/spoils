/**
 * Pure map queries shared by server and client (map memo §4, critique contract outline).
 * Everything here is deterministic integer/IEEE-exact math, like the generator.
 */

import { PLAYER, WORLD } from "../constants.js";
import { buildCollisionIndex, SOLID, type CollisionIndex } from "../geometry.js";
import { isIndoorByte, surfaceOf, type SurfaceInfo } from "./surface.js";
import {
  CONTAINER_KINDS,
  TERRAIN,
  TERRAIN_KIND_MASK,
  type ExtractSpot,
  type MapData,
  type MapRect,
  type MapSide,
  type PropKind,
  type Terrain,
  type WalkGrid,
  type Zone,
} from "./types.js";

/** Raw terrain byte (kind | INDOOR bit) at a world point; clamps to the grid. */
export function terrainByteAt(m: MapData, x: number, y: number): number {
  const c = Math.min(m.terrainCols - 1, Math.max(0, Math.floor(x / m.terrainCell)));
  const r = Math.min(m.terrainRows - 1, Math.max(0, Math.floor(y / m.terrainCell)));
  return m.terrain[r * m.terrainCols + c]!;
}

/** Terrain kind at a world point (INDOOR bit stripped). */
export function terrainAt(m: MapData, x: number, y: number): Terrain {
  return (terrainByteAt(m, x, y) & TERRAIN_KIND_MASK) as Terrain;
}

/** Used by stepMovement on BOTH server and client prediction (pass as terrainMult). */
export function terrainSpeedMult(t: Terrain): number {
  return t === TERRAIN.SHALLOW ? 0.6 : 1;
}

export function isIndoor(m: MapData, x: number, y: number): boolean {
  return isIndoorByte(terrainByteAt(m, x, y));
}

/**
 * Footstep material + step range multiplier under a world point. The server footstep emitter
 * (sound variant = SurfaceInfo.variant) and client audio both call this, so they cannot disagree.
 */
export function surfaceAt(m: MapData, x: number, y: number): SurfaceInfo {
  return surfaceOf(terrainByteAt(m, x, y));
}

/** Zones never overlap, so the first hit is the only one. ~10 zones: a linear scan is fine. */
export function zoneAt(m: MapData, x: number, y: number): Zone | undefined {
  return m.zones.find((z) => x >= z.rect.x && x < z.rect.x + z.rect.w && y >= z.rect.y && y < z.rect.y + z.rect.h);
}

/** Tarkov rule: never your own side; both extracts of the opposite side + one per adjacent side. */
export function allowedExtracts(m: MapData, side: MapSide): ExtractSpot[] {
  const opp = (side + 2) % 4;
  const opposite = m.extracts.filter((e) => e.side === opp);
  const adjacent = [(side + 1) % 4, (side + 3) % 4]
    .map((s) => m.extracts.find((e) => e.side === s))
    .filter((e): e is ExtractSpot => !!e);
  return [...opposite, ...adjacent];
}

/** Bit i = m.extracts[i] allowed for `side` (SelfState.extractMask). */
export function extractMask(m: MapData, side: MapSide): number {
  const allowed = new Set(allowedExtracts(m, side).map((e) => e.id));
  return m.extracts.reduce((mask, e, i) => (allowed.has(e.id) ? mask | (1 << i) : mask), 0);
}

/**
 * Chunk index range covering a world box (client chunk baking, AOI). Pass `n` =
 * ceil(map.width / chunk) for the 20,480 px fallback map; the default covers WORLD.
 */
export function chunkRange(
  x0: number, y0: number, x1: number, y1: number,
  chunk: number = WORLD.CHUNK, n: number = Math.ceil(WORLD.WIDTH / chunk),
) {
  const c = (v: number) => Math.max(0, Math.min(n - 1, Math.floor(v / chunk)));
  return { cx0: c(x0), cy0: c(y0), cx1: c(x1), cy1: c(y1) };
}

/**
 * FNV-1a over the integer layout: solids, bushes, every terrain byte, containers, loot, spawns and
 * extracts. Golden value in map tests; the client sends it on join so a generator drift between
 * engines (or a stale client bundle) is caught before anyone rubber-bands into a wall.
 */
export function mapHash(m: MapData): string {
  let h = 0x811c9dc5;
  const mix = (v: number) => {
    h ^= v | 0;
    h = Math.imul(h, 0x01000193);
  };
  mix(m.genVersion);
  mix(m.width);
  mix(m.height);
  mix(m.rects.length);
  for (const r of m.rects) { mix(r.x); mix(r.y); mix(r.w); mix(r.h); mix(r.f); }
  mix(m.circles.length);
  for (const c of m.circles) { mix(c.x); mix(c.y); mix(c.r); mix(c.f); }
  mix(m.bushes.length);
  for (const b of m.bushes) { mix(b.x); mix(b.y); mix(b.r); }
  mix(m.containers.length);
  // Kind is gameplay (loot table, open delay), so a kind drift must change the hash too.
  for (const s of m.containers) { mix(s.x); mix(s.y); mix(s.tier); mix(CONTAINER_KINDS.indexOf(s.kind)); }
  mix(m.lootSpots.length);
  for (const s of m.lootSpots) { mix(s.x); mix(s.y); mix(s.tier); }
  mix(m.spawns.length);
  for (const s of m.spawns) { mix(s.x); mix(s.y); mix(s.side); }
  // extractMask is a bit set over this array's order, so order + count are part of the contract.
  mix(m.extracts.length);
  for (const e of m.extracts) { mix(e.x); mix(e.y); mix(e.r); mix(e.side); }
  // Terrain: 4 bytes per mix (147 KB → 37k mixes, ~0.1 ms).
  const t = m.terrain;
  let i = 0;
  for (; i + 3 < t.length; i += 4) mix(t[i]! | (t[i + 1]! << 8) | (t[i + 2]! << 16) | (t[i + 3]! << 24));
  for (; i < t.length; i++) mix(t[i]!);
  return (h >>> 0).toString(16).padStart(8, "0");
}

const indexCache = new WeakMap<MapData, CollisionIndex>();

/**
 * Collision index over every solid with its flags (query with a SOLID mask). Built once per
 * MapData object — warm it at process boot, never lazily inside a tick (critique).
 */
export function getCollisionIndex(m: MapData): CollisionIndex {
  let idx = indexCache.get(m);
  if (!idx) {
    idx = buildCollisionIndex({ rects: m.rects, circles: m.circles }, m.width, m.height);
    indexCache.set(m, idx);
  }
  return idx;
}

/** Rect kinds that muffle sound (critique: occlusion = one ray against a walls-only index). */
export const WALL_KINDS: readonly PropKind[] = ["border", "wall", "window", "concrete_wall"];

const wallCache = new WeakMap<MapData, CollisionIndex>();

/**
 * Walls-only index for sound occlusion (soundOcclusion / countOccluders), so crates, cars and trees
 * never muffle. Windows are in it but carry no SIGHT flag: SOLID.MOVE counts every wall and window,
 * SOLID.SIGHT solid walls only; soundOcclusion uses both to tell a window from a wall. Built once
 * per MapData, like getCollisionIndex.
 */
export function getWallIndex(m: MapData): CollisionIndex {
  let idx = wallCache.get(m);
  if (!idx) {
    const rects: MapRect[] = m.rects.filter((r) => WALL_KINDS.includes(r.k));
    idx = buildCollisionIndex({ rects, circles: [] }, m.width, m.height);
    wallCache.set(m, idx);
  }
  return idx;
}

export const WALK_CELL = 32;
/** Player radius + 4 px slack, so a cell marked walkable really fits a player (doors stay open). */
export const WALK_CLEARANCE = PLAYER.RADIUS + 4;

/**
 * Walkability grid at `cell` px with a player clearance (MOVE solids). A cell is blocked exactly
 * when circleIsFree(idx, centre, clearance, MOVE) would be false — but computed by rasterising
 * each solid over the cells it can touch instead of querying 590k cells (5–10× faster; the
 * equivalence is asserted in query.test.ts). Used by the reachability validation and server nav.
 */
export function buildWalkGrid(
  m: Pick<MapData, "width" | "height">,
  idx: CollisionIndex,
  cell = WALK_CELL,
  clearance = WALK_CLEARANCE,
): WalkGrid {
  const cols = Math.ceil(m.width / cell);
  const rows = Math.ceil(m.height / cell);
  const blocked = new Uint8Array(cols * rows);
  const c2 = clearance * clearance;
  const range = (lo: number, hi: number, n: number): [number, number] => [
    Math.max(0, Math.floor(lo / cell)),
    Math.min(n - 1, Math.floor(hi / cell)),
  ];
  for (let i = 0; i < idx.rects.length; i++) {
    if ((idx.rectFlags[i]! & SOLID.MOVE) === 0) continue;
    const r = idx.rects[i]!;
    const [ca, cb] = range(r.x - clearance, r.x + r.w + clearance, cols);
    const [ra, rb] = range(r.y - clearance, r.y + r.h + clearance, rows);
    for (let y = ra; y <= rb; y++) {
      const cy = (y + 0.5) * cell;
      const ny = cy < r.y ? r.y : cy > r.y + r.h ? r.y + r.h : cy;
      const dy = cy - ny;
      const dy2 = dy * dy;
      if (dy2 >= c2) continue;
      const row = y * cols;
      for (let x = ca; x <= cb; x++) {
        if (blocked[row + x]) continue;
        const cx = (x + 0.5) * cell;
        const nx = cx < r.x ? r.x : cx > r.x + r.w ? r.x + r.w : cx;
        const dx = cx - nx;
        if (dx * dx + dy2 < c2) blocked[row + x] = 1;
      }
    }
  }
  for (let i = 0; i < idx.circles.length; i++) {
    if ((idx.circleFlags[i]! & SOLID.MOVE) === 0) continue;
    const c = idx.circles[i]!;
    const rr = c.r + clearance;
    const rr2 = rr * rr;
    const [ca, cb] = range(c.x - rr, c.x + rr, cols);
    const [ra, rb] = range(c.y - rr, c.y + rr, rows);
    for (let y = ra; y <= rb; y++) {
      const dy = (y + 0.5) * cell - c.y;
      for (let x = ca; x <= cb; x++) {
        const dx = (x + 0.5) * cell - c.x;
        if (dx * dx + dy * dy < rr2) blocked[y * cols + x] = 1;
      }
    }
  }
  return { cell, cols, rows, blocked };
}

const walkCache = new WeakMap<MapData, WalkGrid>();

/** buildWalkGrid(m, getCollisionIndex(m)) with default cell/clearance, cached per MapData. */
export function getWalkGrid(m: MapData): WalkGrid {
  let g = walkCache.get(m);
  if (!g) {
    g = buildWalkGrid(m, getCollisionIndex(m));
    walkCache.set(m, g);
  }
  return g;
}

export function walkCellOf(g: WalkGrid, x: number, y: number): number {
  const c = Math.min(g.cols - 1, Math.max(0, Math.floor(x / g.cell)));
  const r = Math.min(g.rows - 1, Math.max(0, Math.floor(y / g.cell)));
  return r * g.cols + c;
}

/**
 * Nearest cell (by centre distance, ≤ maxPx) that is set in `mask` — or, without a mask, simply
 * not blocked. Returns -1 when none. Ties break by scan order, so the result is deterministic.
 */
export function nearestWalkCell(g: WalkGrid, x: number, y: number, maxPx: number, mask?: Uint8Array): number {
  const ok = (i: number) => (mask ? mask[i] === 1 : g.blocked[i] === 0);
  const r = Math.ceil(maxPx / g.cell);
  const c0 = Math.floor(x / g.cell), r0 = Math.floor(y / g.cell);
  let best = -1, bestD = maxPx * maxPx;
  for (let dy = -r; dy <= r; dy++) {
    const ry = r0 + dy;
    if (ry < 0 || ry >= g.rows) continue;
    for (let dx = -r; dx <= r; dx++) {
      const cx = c0 + dx;
      if (cx < 0 || cx >= g.cols) continue;
      const i = ry * g.cols + cx;
      if (!ok(i)) continue;
      const ex = (cx + 0.5) * g.cell - x, ey = (ry + 0.5) * g.cell - y;
      const d = ex * ex + ey * ey;
      if (d <= bestD) {
        if (d < bestD || best < 0) best = i;
        bestD = d;
      }
    }
  }
  return best;
}

/**
 * 4-connected flood fill over walkable cells from the cell nearest (x, y). 4-connectivity is the
 * conservative choice: a diagonal step between two blocked orthogonal cells may not fit a player.
 * Returns 1 per reached cell (all zeros when the start has no walkable cell within 96 px).
 */
export function floodWalk(g: WalkGrid, x: number, y: number): Uint8Array {
  const seen = new Uint8Array(g.cols * g.rows);
  const start = nearestWalkCell(g, x, y, 96);
  if (start < 0) return seen;
  const q = new Int32Array(g.cols * g.rows);
  let head = 0, tail = 0;
  q[tail++] = start;
  seen[start] = 1;
  const { cols, rows, blocked } = g;
  while (head < tail) {
    const i = q[head++]!;
    const cx = i % cols;
    if (cx > 0 && !seen[i - 1] && !blocked[i - 1]) { seen[i - 1] = 1; q[tail++] = i - 1; }
    if (cx < cols - 1 && !seen[i + 1] && !blocked[i + 1]) { seen[i + 1] = 1; q[tail++] = i + 1; }
    if (i >= cols && !seen[i - cols] && !blocked[i - cols]) { seen[i - cols] = 1; q[tail++] = i - cols; }
    if (i < (rows - 1) * cols && !seen[i + cols] && !blocked[i + cols]) { seen[i + cols] = 1; q[tail++] = i + cols; }
  }
  return seen;
}

/** True when a reached cell centre lies within `px` of (x, y) (e.g. 80 = interact range). */
export function reachedNear(g: WalkGrid, reached: Uint8Array, x: number, y: number, px: number): boolean {
  return nearestWalkCell(g, x, y, px, reached) >= 0;
}
