/**
 * Props (map memo §4.7 + §5 flags). Every solid carries SOLID flags:
 *   ALL (walls, crates, shipping containers, log piles, rocks, tree trunks, watchtowers, silos);
 *   MOVE|SHOT low cover (sandbags, car wrecks, barrels): you see over it, bullets stop;
 *   MOVE|SIGHT wooden fences: block sight, bullets pass (wallbang);
 *   bushes are NOT solids (fog-of-war concealment only); puddles are decals.
 * Sprites: car_wreck→"car", shipping_container→"ship_container", barrel, sandbags, fence,
 * watchtower, log_pile→"logpile", puddle (decal), tree (trunk circle + canopy), bush, rock, crate.
 */

import type { Rect } from "../geometry.js";
import type { Rng } from "../rng.js";
import { ALL, FENCE, LOW, type GenCtx } from "./context.js";
import { ROAD_MASK } from "./terrain.js";
import { TERRAIN } from "./types.js";
import { chance, pickW, ri } from "./util.js";

// ───────────────────────── primitives (each checks placement, returns false when blocked)

export function crate(ctx: GenCtx, x: number, y: number, margin = 32): boolean {
  const r = { x: Math.round(x) - 32, y: Math.round(y) - 32, w: 64, h: 64 };
  if (!ctx.free(r, margin)) return false;
  ctx.rect(r.x, r.y, 64, 64, ALL, "crate");
  return true;
}

export function barrel(ctx: GenCtx, x: number, y: number, margin = 28): boolean {
  const r = { x: Math.round(x) - 24, y: Math.round(y) - 24, w: 48, h: 48 };
  if (!ctx.free(r, margin)) return false;
  ctx.circle(x, y, 22, LOW, "barrel", 24);
  return true;
}

export function logpile(ctx: GenCtx, x: number, y: number, vert: boolean, margin = 56): boolean {
  const w = vert ? 80 : 200, h = vert ? 200 : 80;
  const r = { x: Math.round(x - w / 2), y: Math.round(y - h / 2), w, h };
  if (!ctx.free(r, margin)) return false;
  ctx.rect(r.x, r.y, w, h, ALL, "logpile", vert ? 1 : 0);
  return true;
}

export function sandbags(ctx: GenCtx, x: number, y: number, vert: boolean, margin = 24, onRoad = false): boolean {
  const w = vert ? 48 : 192, h = vert ? 192 : 48;
  const r = { x: Math.round(x), y: Math.round(y), w, h };
  if (onRoad ? !ctx.freeOnRoad(r, margin) : !ctx.free(r, margin)) return false;
  ctx.rect(r.x, r.y, w, h, LOW, "sandbags", vert ? 1 : 0);
  return true;
}

export function shipContainer(ctx: GenCtx, x: number, y: number, vert: boolean, margin = 0): boolean {
  const w = vert ? 160 : 384, h = vert ? 384 : 160;
  const r = { x: Math.round(x), y: Math.round(y), w, h };
  if (!ctx.free(r, margin)) return false;
  ctx.rect(r.x, r.y, w, h, ALL, "ship_container", vert ? 1 : 0);
  return true;
}

/** Car wreck 224×112 (MOVE|SHOT cover). `onRoad` allows the road band. */
export function car(ctx: GenCtx, cx: number, cy: number, vert: boolean, onRoad: boolean, margin = 40): boolean {
  const w = vert ? 112 : 224, h = vert ? 224 : 112;
  const r = { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w, h };
  if (onRoad ? !ctx.freeOnRoad(r, margin) : !ctx.free(r, margin)) return false;
  ctx.rect(r.x, r.y, w, h, LOW, "car", vert ? 1 : 0);
  return true;
}

export function tree(ctx: GenCtx, x: number, y: number, r: number, margin = 40): boolean {
  // Footprint is the trunk box (+ margin): canopies may overlap, trunks keep a walkable gap.
  const fr = { x: Math.round(x) - 44, y: Math.round(y) - 44, w: 88, h: 88 };
  if (!ctx.free(fr, margin)) return false;
  ctx.circle(x, y, r, ALL, "tree", 44);
  return true;
}

export function rock(ctx: GenCtx, x: number, y: number, r: number, margin = 48): boolean {
  const fr = { x: Math.round(x - r), y: Math.round(y - r), w: Math.round(2 * r), h: Math.round(2 * r) };
  if (!ctx.free(fr, margin)) return false;
  ctx.circle(x, y, r, ALL, "rock", Math.round(r));
  return true;
}

/** Bushes are sight-only: they never reserve space, but avoid sitting on solids, roads and water. */
export function bush(ctx: GenCtx, x: number, y: number, r: number): boolean {
  const fr = { x: Math.round(x) - 24, y: Math.round(y) - 24, w: 48, h: 48 };
  if (!ctx.free(fr, 8)) return false;
  ctx.bush(x, y, r);
  return true;
}

/**
 * Axis-aligned fence line from (x0,y0) to (x1,y1) (one of the axes must match), 16 px thick, with
 * gaps given as [start, length] offsets along the line. Segments that would hit anything are
 * dropped (a missing fence panel never breaks reachability; an extra one could).
 */
export function fenceLine(ctx: GenCtx, x0: number, y0: number, x1: number, y1: number, gaps: Array<[number, number]>): void {
  const horiz = y0 === y1;
  const len = horiz ? x1 - x0 : y1 - y0;
  const sorted = gaps.slice().sort((a, b) => a[0] - b[0]);
  let cur = 0;
  const emit = (a: number, b: number) => {
    if (b - a < 48) return;
    const r: Rect = horiz ? { x: x0 + a, y: y0 - 8, w: b - a, h: 16 } : { x: x0 - 8, y: y0 + a, w: 16, h: b - a };
    if (!ctx.free(r, 4)) return;
    ctx.rect(r.x, r.y, r.w, r.h, FENCE, "fence", horiz ? 0 : 1);
  };
  for (const [at, gl] of sorted) {
    emit(cur, at);
    cur = Math.max(cur, at + gl);
  }
  emit(cur, len);
}

/** Random point in `area`. */
export function pointIn(rng: Rng, area: Rect): [number, number] {
  return [Math.round(area.x + rng() * area.w), Math.round(area.y + rng() * area.h)];
}

/** Try `n` placements of `make` at random points in `area` (n × triesPer attempts). */
export function scatter(rng: Rng, area: Rect, n: number, make: (x: number, y: number) => boolean, triesPer = 8): number {
  let placed = 0;
  for (let t = 0; t < n * triesPer && placed < n; t++) {
    const [x, y] = pointIn(rng, area);
    if (make(x, y)) placed++;
  }
  return placed;
}

// ───────────────────────── global passes

/** Car wrecks along asphalt and dirt roads every ~900 px with 40% (not on bridges, not in POIs' cores). */
export function roadCars(ctx: GenCtx): void {
  const rng = ctx.rng("cars");
  for (const road of ctx.roads) {
    if (road.kind === "rail") continue;
    const p = road.pts;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const x0 = p[i]!, y0 = p[i + 1]!, x1 = p[i + 2]!, y1 = p[i + 3]!;
      const dx = x1 - x0, dy = y1 - y0;
      const len = Math.sqrt(dx * dx + dy * dy);
      const vert = Math.abs(dy) > Math.abs(dx);
      for (let s = 450; s < len - 450; s += 900) {
        if (!chance(rng, 0.4)) continue;
        const px = x0 + (dx * s) / len, py = y0 + (dy * s) / len;
        const t = ctx.terrain.kindAt(px, py);
        if (t === TERRAIN.BRIDGE || t === TERRAIN.SHALLOW || t === TERRAIN.WATER) continue;
        // Off-centre so a lane stays open: shift across the road by ±(road.width/2 − 64).
        const off = (chance(rng, 0.5) ? 1 : -1) * Math.max(0, road.width / 2 - 64 + ri(rng, -16, 16));
        const cx = vert ? px + off : px, cy = vert ? py : py + off;
        car(ctx, cx, cy, vert, true, 64);
      }
    }
  }
}

/**
 * Wilderness props by terrain. Densities are per block² of valid terrain (memo §4.7, "dense
 * forest" variant: the forest has to hide a 32-player raid). Each kind samples its own count from
 * the matching terrain area and rejects points the predicate or the placement hash refuse.
 */
export function wildProps(ctx: GenCtx): void {
  const rng = ctx.rng("wild-props");
  const B2 = ctx.block * ctx.block;
  const t = ctx.terrain;
  const inZone = (x: number, y: number) => ctx.zones.some((z) => x >= z.rect.x && x < z.rect.x + z.rect.w && y >= z.rect.y && y < z.rect.y + z.rect.h);
  const forestCells = t.count(TERRAIN.FOREST);
  const grassCells = t.count(TERRAIN.GRASS);
  const cellArea = t.cell * t.cell;
  const forestB = (forestCells * cellArea) / B2;
  const grassB = (grassCells * cellArea) / B2;
  const all: Rect = { x: ctx.border + 96, y: ctx.border + 96, w: ctx.width - 2 * (ctx.border + 96), h: ctx.height - 2 * (ctx.border + 96) };
  const isForest = (x: number, y: number) => t.kindAt(x, y) === TERRAIN.FOREST && t.roadAt(x, y) === ROAD_MASK.NONE && !inZone(x, y);
  const isGrass = (x: number, y: number) => t.kindAt(x, y) === TERRAIN.GRASS && t.roadAt(x, y) === ROAD_MASK.NONE && !inZone(x, y);
  const forestFrac = forestCells / (t.cols * t.rows);
  const grassFrac = grassCells / (t.cols * t.rows);

  // Trees: dense in forest, a sprinkle on the open steppe.
  scatter(rng, all, Math.round(15 * forestB), (x, y) => isForest(x, y) && tree(ctx, x, y, ri(rng, 26, 36)), Math.ceil(3 / forestFrac));
  scatter(rng, all, Math.round(0.6 * grassB), (x, y) => isGrass(x, y) && tree(ctx, x, y, ri(rng, 26, 36), 60), Math.ceil(3 / grassFrac));
  // Rocks.
  scatter(rng, all, Math.round(0.7 * (forestB + grassB)), (x, y) => (isForest(x, y) || isGrass(x, y)) && rock(ctx, x, y, ri(rng, 38, 66)), 4);
  // Wild log piles (forestry) and lone crates.
  scatter(rng, all, Math.round(0.12 * forestB), (x, y) => isForest(x, y) && logpile(ctx, x, y, chance(rng, 0.5)), Math.ceil(3 / forestFrac));
  scatter(rng, all, Math.round(0.06 * (forestB + grassB)), (x, y) => (isForest(x, y) || isGrass(x, y)) && crate(ctx, x, y, 48), 4);
  // Bushes (sight cover): denser in forest edges and on the steppe than POIs.
  scatter(rng, all, Math.round(4.5 * (forestB + grassB)), (x, y) => (isForest(x, y) || isGrass(x, y)) && bush(ctx, x, y, ri(rng, 52, 74)), 4);
  // Puddles (cosmetic decal; louder steps come from terrain, not from the decal).
  scatter(rng, all, Math.round(0.6 * (ctx.width * ctx.height) / B2), (x, y) => {
    const k = t.kindAt(x, y);
    if (k === TERRAIN.WATER || k === TERRAIN.SHALLOW || k === TERRAIN.BRIDGE || (t.byteAt(x, y) & 0x80) !== 0) return false;
    ctx.decal(x, y, ri(rng, 48, 112), "puddle");
    return true;
  }, 2);
}

/** Generic POI clutter inside `area`: crates, barrels, extra decals. */
export function clutter(
  ctx: GenCtx,
  rng: Rng,
  area: Rect,
  n: { crates?: number; barrels?: number; logpiles?: number; decals?: number; decal?: "oil" | "dirt" | "debris" },
): void {
  if (n.crates) scatter(rng, area, n.crates, (x, y) => crate(ctx, x, y, 40));
  if (n.barrels) scatter(rng, area, n.barrels, (x, y) => barrel(ctx, x, y, 32));
  if (n.logpiles) scatter(rng, area, n.logpiles, (x, y) => logpile(ctx, x, y, chance(rng, 0.5)));
  if (n.decals && n.decal) {
    const k = n.decal;
    scatter(rng, area, n.decals, (x, y) => {
      ctx.decal(x, y, ri(rng, 64, 160), k);
      return true;
    }, 1);
  }
}

/** Weighted outdoor container kind by tier (yards, nests, quarry). */
export function outdoorKind(rng: Rng, tier: number): "crate" | "toolbox" | "weapon_box" | "med_case" {
  return tier >= 4
    ? pickW(rng, [["weapon_box", 4], ["med_case", 2], ["crate", 1]] as const)
    : tier >= 3
      ? pickW(rng, [["weapon_box", 2], ["crate", 3], ["toolbox", 2], ["med_case", 1]] as const)
      : pickW(rng, [["crate", 5], ["toolbox", 3], ["med_case", 1]] as const);
}

/**
 * Outdoor container spots inside `area`: on open ground (not inside solids), 48 px clear of
 * anything so the sprite never overlaps a prop.
 */
export function outdoorContainers(ctx: GenCtx, rng: Rng, area: Rect, n: number, tier: 0 | 1 | 2 | 3 | 4, zone: string | null): void {
  let placed = 0;
  for (let t = 0; t < n * 20 && placed < n; t++) {
    const x = Math.round(area.x + rng() * area.w), y = Math.round(area.y + rng() * area.h);
    const r = { x: x - 28, y: y - 28, w: 56, h: 56 };
    if (!ctx.free(r, 40)) continue;
    if (ctx.containers.some((c) => Math.abs(c.x - x) < 200 && Math.abs(c.y - y) < 200)) continue;
    ctx.container(x, y, outdoorKind(rng, tier), tier, zone);
    ctx.reserve(r); // nothing spawns on top of it later
    placed++;
  }
}
