/**
 * Client fog-of-war occluders (fog memo §3.2–3.3): every SIGHT solid as outward-facing segments,
 * bucketed in a grid, plus the per-frame shadow-quad builder.
 * - Rect edges use y-down clockwise winding, so the top edge's outward normal is (0, -1).
 * - Circles become CIRCUMSCRIBED octagons (R = r / cos(π/8)): the client blocker is a superset of
 *   the server's exact circle, so the client never shows something the server hid.
 * Pure; also used by tests (pointShadowed is the oracle).
 */

import { SOLID, type Circle, type Rect, type SolidMask } from "./geometry.js";

export interface OccluderGrid {
  cell: number;
  cols: number;
  rows: number;
  /** Packed segments, stride 6: ax, ay, bx, by, nx, ny (outward unit normal). */
  seg: Float32Array;
  count: number;
  /** Per cell: segment indices. */
  cells: Uint32Array[];
  /** Dedup stamps (a segment spanning several cells is visited once per query). */
  stamp: Uint32Array;
  stampN: number;
}

/** The subset of MapData (or legacyMapData) occluders need. */
export interface OccluderSource {
  width: number;
  height: number;
  rects: ReadonlyArray<Rect & { f?: SolidMask }>;
  circles: ReadonlyArray<Circle & { f?: SolidMask }>;
}

const OCT = 8;
const OCT_R = 1 / Math.cos(Math.PI / OCT);

/** Builds the segment grid from SIGHT solids. Once per map (client boot). */
export function buildOccluderGrid(map: OccluderSource, cell = 512): OccluderGrid {
  const segs: number[] = [];
  const push = (ax: number, ay: number, bx: number, by: number) => {
    // Outward normal of a clockwise (y-down) edge a→b is (dy, -dx) normalised.
    const ex = bx - ax, ey = by - ay;
    const len = Math.hypot(ex, ey) || 1;
    segs.push(ax, ay, bx, by, ey / len, -ex / len);
  };
  for (const r of map.rects) {
    if (((r.f ?? SOLID.ALL) & SOLID.SIGHT) === 0) continue;
    const x0 = r.x, y0 = r.y, x1 = r.x + r.w, y1 = r.y + r.h;
    push(x0, y0, x1, y0); // top, normal (0,-1)
    push(x1, y0, x1, y1); // right, normal (1,0)
    push(x1, y1, x0, y1); // bottom, normal (0,1)
    push(x0, y1, x0, y0); // left, normal (-1,0)
  }
  for (const c of map.circles) {
    if (((c.f ?? SOLID.ALL) & SOLID.SIGHT) === 0) continue;
    const R = c.r * OCT_R;
    for (let k = 0; k < OCT; k++) {
      // Increasing angle is clockwise on screen in y-down coordinates.
      const a0 = (k * 2 * Math.PI) / OCT, a1 = ((k + 1) * 2 * Math.PI) / OCT;
      push(c.x + Math.cos(a0) * R, c.y + Math.sin(a0) * R, c.x + Math.cos(a1) * R, c.y + Math.sin(a1) * R);
    }
  }
  const count = segs.length / 6;
  const seg = Float32Array.from(segs);
  const cols = Math.max(1, Math.ceil(map.width / cell));
  const rows = Math.max(1, Math.ceil(map.height / cell));
  const lists: number[][] = Array.from({ length: cols * rows }, () => []);
  const cl = (v: number, n: number) => Math.max(0, Math.min(n - 1, Math.floor(v / cell)));
  for (let i = 0; i < count; i++) {
    const o = i * 6;
    const ax = seg[o]!, ay = seg[o + 1]!, bx = seg[o + 2]!, by = seg[o + 3]!;
    for (let cy = cl(Math.min(ay, by), rows); cy <= cl(Math.max(ay, by), rows); cy++) {
      for (let cx = cl(Math.min(ax, bx), cols); cx <= cl(Math.max(ax, bx), cols); cx++) lists[cy * cols + cx]!.push(i);
    }
  }
  return {
    cell, cols, rows, seg, count,
    cells: lists.map((l) => Uint32Array.from(l)),
    stamp: new Uint32Array(count),
    stampN: 0,
  };
}

/** Visit each segment in cells overlapping [ex±R, ey±R] once. */
function forEachSegNear(g: OccluderGrid, ex: number, ey: number, R: number, f: (i: number) => boolean | void): void {
  g.stampN = (g.stampN + 1) >>> 0;
  if (g.stampN === 0) {
    g.stamp.fill(0);
    g.stampN = 1;
  }
  const s = g.stampN;
  const c0 = Math.max(0, Math.floor((ex - R) / g.cell)), c1 = Math.min(g.cols - 1, Math.floor((ex + R) / g.cell));
  const r0 = Math.max(0, Math.floor((ey - R) / g.cell)), r1 = Math.min(g.rows - 1, Math.floor((ey + R) / g.cell));
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const list = g.cells[r * g.cols + c]!;
      for (let k = 0; k < list.length; k++) {
        const i = list[k]!;
        if (g.stamp[i] === s) continue;
        g.stamp[i] = s;
        if (f(i)) return;
      }
    }
  }
}

/**
 * Writes shadow quads (8 floats each: a, b, b', a') for BACK-facing edges within R of the eye and
 * returns the quad count (≤ maxQuads). Back-facing edges are the far side of each solid, so the wall
 * face you look at stays lit and everything behind it goes dark. Far points are projected to 3R.
 * Allocation-free: `out` is reused every frame.
 *
 * Coverage: the far chord b'a' is at least 3R·cos(θ/2) from the eye, θ = angle a-eye-b. For a
 * player hugging a long wall θ approaches 180° and the chord would come closer than R, leaving the
 * middle of the area behind the wall lit. Edges with θ > 90° are therefore split at the foot of the
 * perpendicular from the eye (each half < 90°, chord ≥ 3R·cos 45° ≈ 2.1R), costing one extra quad.
 */
export function shadowQuads(
  g: OccluderGrid, ex: number, ey: number, R: number, out: Float32Array, maxQuads: number,
): number {
  const FAR = 3 * R;
  const seg = g.seg;
  let n = 0;
  const cap = Math.min(maxQuads, Math.floor(out.length / 8));
  const emit = (ax: number, ay: number, bx: number, by: number) => {
    const da = Math.hypot(ax - ex, ay - ey) || 1e-6, db = Math.hypot(bx - ex, by - ey) || 1e-6;
    const q = n * 8;
    out[q] = ax; out[q + 1] = ay;
    out[q + 2] = bx; out[q + 3] = by;
    out[q + 4] = ex + ((bx - ex) * FAR) / db; out[q + 5] = ey + ((by - ey) * FAR) / db;
    out[q + 6] = ex + ((ax - ex) * FAR) / da; out[q + 7] = ey + ((ay - ey) * FAR) / da;
    n++;
  };
  forEachSegNear(g, ex, ey, R, (i) => {
    const o = i * 6;
    const ax = seg[o]!, ay = seg[o + 1]!, bx = seg[o + 2]!, by = seg[o + 3]!, nx = seg[o + 4]!, ny = seg[o + 5]!;
    if ((ex - ax) * nx + (ey - ay) * ny >= 0) return false; // front-facing
    if ((ax - ex) * (bx - ex) + (ay - ey) * (by - ey) < 0 && n + 2 <= cap) {
      // θ > 90°: split at the foot of the perpendicular (strictly inside the edge in this case).
      const sx = bx - ax, sy = by - ay;
      const t = ((ex - ax) * sx + (ey - ay) * sy) / (sx * sx + sy * sy);
      const fx = ax + sx * t, fy = ay + sy * t;
      emit(ax, ay, fx, fy);
      emit(fx, fy, bx, by);
    } else {
      emit(ax, ay, bx, by);
    }
    return n >= cap;
  });
  return n;
}

/** Proper segment intersection p→q vs a→b (shared endpoints and collinear touches do not count). */
function segCross(px: number, py: number, qx: number, qy: number, ax: number, ay: number, bx: number, by: number): boolean {
  const d1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  const d2 = (bx - ax) * (qy - ay) - (by - ay) * (qx - ax);
  const d3 = (qx - px) * (ay - py) - (qy - py) * (ax - px);
  const d4 = (qx - px) * (by - py) - (qy - py) * (bx - px);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/**
 * Test oracle: is P hidden from the eye by any occluder segment within R (P is NOT visible)?
 * Slow path (exact segment crossings), never used per frame.
 */
export function pointShadowed(g: OccluderGrid, ex: number, ey: number, px: number, py: number, R: number): boolean {
  let hidden = false;
  const seg = g.seg;
  forEachSegNear(g, ex, ey, R, (i) => {
    const o = i * 6;
    if (segCross(ex, ey, px, py, seg[o]!, seg[o + 1]!, seg[o + 2]!, seg[o + 3]!)) {
      hidden = true;
      return true;
    }
    return false;
  });
  return hidden;
}
