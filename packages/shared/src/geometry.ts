/**
 * Collision and ray casting against the static map. Used by the server (movement, bullets,
 * bot line of sight) and by the client (movement prediction, tracer cut-off), so both sides
 * agree on where walls are.
 */

/** Axis-aligned rectangle, top-left origin. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Circle {
  x: number;
  y: number;
  r: number;
}

export interface Solids {
  rects: Rect[];
  circles: Circle[];
}

/** Uniform grid over the solids so queries only touch nearby obstacles. */
export interface CollisionIndex {
  cell: number;
  cols: number;
  rows: number;
  rects: Rect[];
  circles: Circle[];
  /** Per cell: indices into rects / circles. */
  rectCells: number[][];
  circleCells: number[][];
  /** Dedup stamps so an obstacle spanning several cells is visited once per query. */
  rectStamp: Uint32Array;
  circleStamp: Uint32Array;
  stamp: number;
}

export function buildCollisionIndex(
  solids: Solids,
  width: number,
  height: number,
  cell = 256,
): CollisionIndex {
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const rectCells: number[][] = Array.from({ length: cols * rows }, () => []);
  const circleCells: number[][] = Array.from({ length: cols * rows }, () => []);
  const clampC = (v: number) => Math.max(0, Math.min(cols - 1, v));
  const clampR = (v: number) => Math.max(0, Math.min(rows - 1, v));

  solids.rects.forEach((r, i) => {
    for (let cy = clampR(Math.floor(r.y / cell)); cy <= clampR(Math.floor((r.y + r.h) / cell)); cy++)
      for (let cx = clampC(Math.floor(r.x / cell)); cx <= clampC(Math.floor((r.x + r.w) / cell)); cx++)
        rectCells[cy * cols + cx]!.push(i);
  });
  solids.circles.forEach((c, i) => {
    for (let cy = clampR(Math.floor((c.y - c.r) / cell)); cy <= clampR(Math.floor((c.y + c.r) / cell)); cy++)
      for (let cx = clampC(Math.floor((c.x - c.r) / cell)); cx <= clampC(Math.floor((c.x + c.r) / cell)); cx++)
        circleCells[cy * cols + cx]!.push(i);
  });

  return {
    cell, cols, rows,
    rects: solids.rects,
    circles: solids.circles,
    rectCells, circleCells,
    rectStamp: new Uint32Array(solids.rects.length),
    circleStamp: new Uint32Array(solids.circles.length),
    stamp: 0,
  };
}

/** Visit every solid whose cells overlap the box [x0,x1]×[y0,y1]. Return true from a callback to stop. */
export function forEachSolidNear(
  idx: CollisionIndex,
  x0: number, y0: number, x1: number, y1: number,
  onRect: (r: Rect) => boolean | void,
  onCircle: (c: Circle) => boolean | void,
): void {
  idx.stamp = (idx.stamp + 1) >>> 0;
  if (idx.stamp === 0) {
    idx.rectStamp.fill(0);
    idx.circleStamp.fill(0);
    idx.stamp = 1;
  }
  const s = idx.stamp;
  const cxa = Math.max(0, Math.floor(Math.min(x0, x1) / idx.cell));
  const cxb = Math.min(idx.cols - 1, Math.floor(Math.max(x0, x1) / idx.cell));
  const cya = Math.max(0, Math.floor(Math.min(y0, y1) / idx.cell));
  const cyb = Math.min(idx.rows - 1, Math.floor(Math.max(y0, y1) / idx.cell));
  for (let cy = cya; cy <= cyb; cy++) {
    for (let cx = cxa; cx <= cxb; cx++) {
      const k = cy * idx.cols + cx;
      for (const i of idx.rectCells[k]!) {
        if (idx.rectStamp[i] === s) continue;
        idx.rectStamp[i] = s;
        if (onRect(idx.rects[i]!)) return;
      }
      for (const i of idx.circleCells[k]!) {
        if (idx.circleStamp[i] === s) continue;
        idx.circleStamp[i] = s;
        if (onCircle(idx.circles[i]!)) return;
      }
    }
  }
}

/** Push a circle out of one rectangle. Returns the corrected center or null if not overlapping. */
function pushOutOfRect(x: number, y: number, r: number, rect: Rect): { x: number; y: number } | null {
  const nx = Math.max(rect.x, Math.min(x, rect.x + rect.w));
  const ny = Math.max(rect.y, Math.min(y, rect.y + rect.h));
  const dx = x - nx;
  const dy = y - ny;
  const d2 = dx * dx + dy * dy;
  if (d2 >= r * r) return null;
  if (d2 > 1e-9) {
    const d = Math.sqrt(d2);
    return { x: x + (dx / d) * (r - d), y: y + (dy / d) * (r - d) };
  }
  // Center inside the rectangle: leave along the shortest axis.
  const left = x - rect.x;
  const right = rect.x + rect.w - x;
  const top = y - rect.y;
  const bottom = rect.y + rect.h - y;
  const m = Math.min(left, right, top, bottom);
  if (m === left) return { x: rect.x - r, y };
  if (m === right) return { x: rect.x + rect.w + r, y };
  if (m === top) return { x, y: rect.y - r };
  return { x, y: rect.y + rect.h + r };
}

function pushOutOfCircle(x: number, y: number, r: number, c: Circle): { x: number; y: number } | null {
  const dx = x - c.x;
  const dy = y - c.y;
  const min = r + c.r;
  const d2 = dx * dx + dy * dy;
  if (d2 >= min * min) return null;
  const d = Math.sqrt(d2);
  if (d < 1e-6) return { x: c.x + min, y };
  return { x: c.x + (dx / d) * min, y: c.y + (dy / d) * min };
}

/** Resolve overlaps of a circle with nearby solids (a few relaxation passes). */
export function resolveCircle(
  idx: CollisionIndex,
  x: number,
  y: number,
  r: number,
): { x: number; y: number } {
  let px = x;
  let py = y;
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    forEachSolidNear(
      idx, px - r - 1, py - r - 1, px + r + 1, py + r + 1,
      (rect) => {
        const p = pushOutOfRect(px, py, r, rect);
        if (p) { px = p.x; py = p.y; moved = true; }
      },
      (c) => {
        const p = pushOutOfCircle(px, py, r, c);
        if (p) { px = p.x; py = p.y; moved = true; }
      },
    );
    if (!moved) break;
  }
  return { x: px, y: py };
}

/** Move a circle by (dx, dy), sliding along walls. Sub-steps keep fast moves from tunneling. */
export function moveCircle(
  idx: CollisionIndex,
  x: number,
  y: number,
  r: number,
  dx: number,
  dy: number,
): { x: number; y: number } {
  const dist = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(dist / (r * 0.5)));
  let px = x;
  let py = y;
  for (let i = 0; i < steps; i++) {
    const p = resolveCircle(idx, px + dx / steps, py + dy / steps, r);
    px = p.x;
    py = p.y;
  }
  return { x: px, y: py };
}

/** Is a circle at (x, y) free of solids? */
export function circleIsFree(idx: CollisionIndex, x: number, y: number, r: number): boolean {
  let free = true;
  forEachSolidNear(
    idx, x - r, y - r, x + r, y + r,
    (rect) => {
      if (pushOutOfRect(x, y, r, rect)) { free = false; return true; }
    },
    (c) => {
      if (pushOutOfCircle(x, y, r, c)) { free = false; return true; }
    },
  );
  return free;
}

/** Smallest t in [0, 1] where segment p + t·d enters the circle, or Infinity. Starting inside counts as t = 0. */
export function segmentCircleT(
  x0: number, y0: number, dx: number, dy: number,
  cx: number, cy: number, r: number,
): number {
  const fx = x0 - cx;
  const fy = y0 - cy;
  const c = fx * fx + fy * fy - r * r;
  if (c <= 0) return 0;
  const a = dx * dx + dy * dy;
  if (a < 1e-12) return Infinity;
  const b = 2 * (fx * dx + fy * dy);
  const disc = b * b - 4 * a * c;
  if (disc < 0) return Infinity;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return t >= 0 && t <= 1 ? t : Infinity;
}

/** Smallest t in [0, 1] where segment p + t·d enters the rectangle (slab method), or Infinity. */
export function segmentRectT(
  x0: number, y0: number, dx: number, dy: number, rect: Rect,
): number {
  let tmin = 0;
  let tmax = 1;
  const axes: Array<[number, number, number, number]> = [
    [x0, dx, rect.x, rect.x + rect.w],
    [y0, dy, rect.y, rect.y + rect.h],
  ];
  for (const [p, d, lo, hi] of axes) {
    if (Math.abs(d) < 1e-12) {
      if (p < lo || p > hi) return Infinity;
    } else {
      let t1 = (lo - p) / d;
      let t2 = (hi - p) / d;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return Infinity;
    }
  }
  return tmin;
}

/** First solid hit along the segment (x0,y0)→(x1,y1): t in [0, 1], or Infinity when clear. */
export function raycastSolids(
  idx: CollisionIndex,
  x0: number, y0: number, x1: number, y1: number,
): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  let best = Infinity;
  forEachSolidNear(
    idx, x0, y0, x1, y1,
    (rect) => {
      const t = segmentRectT(x0, y0, dx, dy, rect);
      if (t < best) best = t;
    },
    (c) => {
      const t = segmentCircleT(x0, y0, dx, dy, c.x, c.y, c.r);
      if (t < best) best = t;
    },
  );
  return best;
}

/** Clear line of sight between two points (no solid in between). */
export function hasLineOfSight(
  idx: CollisionIndex,
  x0: number, y0: number, x1: number, y1: number,
): boolean {
  return raycastSolids(idx, x0, y0, x1, y1) === Infinity;
}

export function rectsOverlap(a: Rect, b: Rect, margin = 0): boolean {
  return (
    a.x - margin < b.x + b.w &&
    a.x + a.w + margin > b.x &&
    a.y - margin < b.y + b.h &&
    a.y + a.h + margin > b.y
  );
}

export function pointInCircle(x: number, y: number, c: Circle): boolean {
  const dx = x - c.x;
  const dy = y - c.y;
  return dx * dx + dy * dy <= c.r * c.r;
}
