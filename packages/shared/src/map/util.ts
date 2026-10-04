/**
 * Small deterministic helpers for the map generator.
 *
 * Determinism rule (map/types.ts header, enforced by determinism.test.ts): the generator may only
 * use mulberry32, + - * /, Math.floor/ceil/round/min/max/abs/sqrt/imul. Those are IEEE-exact in
 * every JS engine, so Safari, Firefox and Node build bit-identical maps. Trig, hypot, pow, exp and
 * log are NOT guaranteed identical across engines, and Array.sort with a random comparator depends
 * on the engine's sort algorithm — both would give the client walls in different places.
 */

import type { Rect } from "../geometry.js";
import { mulberry32, type Rng } from "../rng.js";

/** Integer in [lo, hi] inclusive. */
export function ri(rng: Rng, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

/** Float in [lo, hi). */
export function rf(rng: Rng, lo: number, hi: number): number {
  return lo + rng() * (hi - lo);
}

/** Random value in [lo, hi] snapped to `step` (building sizes on a 32 px grid look tidy). */
export function rs(rng: Rng, lo: number, hi: number, step: number): number {
  return Math.round(rf(rng, lo, hi) / step) * step;
}

export function chance(rng: Rng, p: number): boolean {
  return rng() < p;
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

/** Weighted pick over [value, weight] pairs. */
export function pickW<T>(rng: Rng, items: ReadonlyArray<readonly [T, number]>): T {
  let total = 0;
  for (const it of items) total += it[1];
  let roll = rng() * total;
  for (const it of items) {
    roll -= it[1];
    if (roll < 0) return it[0];
  }
  return items[items.length - 1]![0];
}

/** Fisher–Yates. Never `arr.sort(() => rng() - 0.5)`: its result depends on the engine's sort. */
export function shuffle<T>(rng: Rng, arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = t;
  }
  return arr;
}

/**
 * Independent rng stream per generator stage / POI. Tweaking one POI then does not reshuffle the
 * rest of the map, which keeps layout iterations reviewable (the golden hash still changes).
 */
export function rngFor(seed: number, label: string): Rng {
  let h = 0x811c9dc5 ^ (seed >>> 0);
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return mulberry32(h >>> 0);
}

/**
 * Deterministic 0..n-1 from integer coordinates (art variants): no rng draw, so choosing a variant
 * never shifts the rest of the layout.
 */
export function vhash(x: number, y: number, n: number): number {
  let h = Math.imul(Math.round(x) | 0, 0x27d4eb2d) ^ Math.imul(Math.round(y) | 0, 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) % n;
}

export function grow(r: Rect, m: number): Rect {
  return { x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m };
}

export function overlaps(a: Rect, b: Rect, m = 0): boolean {
  return a.x - m < b.x + b.w && a.x + a.w + m > b.x && a.y - m < b.y + b.h && a.y + a.h + m > b.y;
}

export function inRect(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

export function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx, dy = ay - by;
  return dx * dx + dy * dy;
}

/** Squared distance from point p to segment a–b (dot products only; no trig). */
export function distSqPointSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + dx * t - px, qy = ay + dy * t - py;
  return qx * qx + qy * qy;
}

/** Squared distance from a point to a flat polyline [x0, y0, x1, y1, …]. */
export function distSqPointPolyline(px: number, py: number, pts: readonly number[]): number {
  let best = Infinity;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const d = distSqPointSeg(px, py, pts[i]!, pts[i + 1]!, pts[i + 2]!, pts[i + 3]!);
    if (d < best) best = d;
  }
  return best;
}

/**
 * X of a flat polyline at height y (first segment spanning y), for roughly N–S roads/rivers.
 * Clamps to the nearest endpoint outside the polyline's y range.
 */
export function polyXAtY(pts: readonly number[], y: number): number {
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const y0 = pts[i + 1]!, y1 = pts[i + 3]!;
    const lo = Math.min(y0, y1), hi = Math.max(y0, y1);
    if (y >= lo && y <= hi && hi > lo) return pts[i]! + ((pts[i + 2]! - pts[i]!) * (y - y0)) / (y1 - y0);
  }
  const first = pts[1]!, last = pts[pts.length - 1]!;
  return Math.abs(y - first) <= Math.abs(y - last) ? pts[0]! : pts[pts.length - 2]!;
}

/** Y of a flat polyline at x (for roughly W–E roads). */
export function polyYAtX(pts: readonly number[], x: number): number {
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const x0 = pts[i]!, x1 = pts[i + 2]!;
    const lo = Math.min(x0, x1), hi = Math.max(x0, x1);
    if (x >= lo && x <= hi && hi > lo) return pts[i + 1]! + ((pts[i + 3]! - pts[i + 1]!) * (x - x0)) / (x1 - x0);
  }
  const first = pts[0]!, last = pts[pts.length - 2]!;
  return Math.abs(x - first) <= Math.abs(x - last) ? pts[1]! : pts[pts.length - 1]!;
}
