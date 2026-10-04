/**
 * Collision and ray casting against the static map. Used by the server (movement, bullets,
 * bot line of sight) and by the client (movement prediction, tracer cut-off), so both sides
 * agree on where walls are.
 */

/**
 * Collision flags: one index, three masks (map memo §5). Every solid carries `f`:
 * movement (shared prediction) queries MOVE, bullets SHOT, fog-of-war rays and bot sight SIGHT.
 * Windows are MOVE|VAULT (SOLID.WINDOW), sandbags/barrels MOVE|SHOT, wooden fences MOVE|SIGHT
 * (wallbang), water MOVE.
 *
 * VAULT is not a query mask but an exemption: a MOVE solid that also carries VAULT is an opening a
 * player's dodge roll passes through (a window). Walking, NPC nav and every other MOVE query still
 * treat it as a wall; only stepMovement's roll ticks skip it (moveCircle `ignore` = VAULT) and
 * leaveVault puts a roll that ended inside it back on one side. Bullets (no SHOT) and sight (no
 * SIGHT) pass a window as open space; sound treats it as an opening in a wall (sound.ts).
 */
export const SOLID = { MOVE: 1, SHOT: 2, SIGHT: 4, ALL: 7, VAULT: 8, WINDOW: 9 } as const;
export type SolidMask = number;

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

export interface SolidRect extends Rect {
  f: SolidMask;
}
export interface SolidCircle extends Circle {
  f: SolidMask;
}

/**
 * Input to buildCollisionIndex. `f` may be omitted (v1 legacy solids): it then means SOLID.ALL,
 * which reproduces the v1 behaviour where everything blocked everything.
 */
export interface Solids {
  rects: ReadonlyArray<Rect & { f?: SolidMask }>;
  circles: ReadonlyArray<Circle & { f?: SolidMask }>;
}

/** Uniform grid over the solids so queries only touch nearby obstacles. */
export interface CollisionIndex {
  cell: number;
  cols: number;
  rows: number;
  rects: ReadonlyArray<Rect>;
  circles: ReadonlyArray<Circle>;
  /** Flags per rect / circle (SOLID bits): one typed-array lookup per candidate, so masks are free. */
  rectFlags: Uint8Array;
  circleFlags: Uint8Array;
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
    rectFlags: Uint8Array.from(solids.rects, (r) => r.f ?? SOLID.ALL),
    circleFlags: Uint8Array.from(solids.circles, (c) => c.f ?? SOLID.ALL),
    rectCells, circleCells,
    rectStamp: new Uint32Array(solids.rects.length),
    circleStamp: new Uint32Array(solids.circles.length),
    stamp: 0,
  };
}

/**
 * Visit every solid with (f & mask) !== 0 and (f & ignore) === 0 whose cells overlap the box
 * [x0,x1]×[y0,y1]. Return true from a callback to stop.
 */
export function forEachSolidNear(
  idx: CollisionIndex,
  x0: number, y0: number, x1: number, y1: number,
  mask: SolidMask,
  onRect: (r: Rect) => boolean | void,
  onCircle: (c: Circle) => boolean | void,
  ignore: SolidMask = 0,
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
        const f = idx.rectFlags[i]!;
        if ((f & mask) === 0 || (f & ignore) !== 0) continue;
        if (onRect(idx.rects[i]!)) return;
      }
      for (const i of idx.circleCells[k]!) {
        if (idx.circleStamp[i] === s) continue;
        idx.circleStamp[i] = s;
        const f = idx.circleFlags[i]!;
        if ((f & mask) === 0 || (f & ignore) !== 0) continue;
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

/**
 * Resolve overlaps of a circle with nearby MOVE solids (a few relaxation passes). Solids carrying
 * any `ignore` bit are skipped (the roll passes SOLID.VAULT: windows).
 */
export function resolveCircle(
  idx: CollisionIndex,
  x: number,
  y: number,
  r: number,
  ignore: SolidMask = 0,
): { x: number; y: number } {
  let px = x;
  let py = y;
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    forEachSolidNear(
      idx, px - r - 1, py - r - 1, px + r + 1, py + r + 1, SOLID.MOVE,
      (rect) => {
        const p = pushOutOfRect(px, py, r, rect);
        if (p) { px = p.x; py = p.y; moved = true; }
      },
      (c) => {
        const p = pushOutOfCircle(px, py, r, c);
        if (p) { px = p.x; py = p.y; moved = true; }
      },
      ignore,
    );
    if (!moved) break;
  }
  return { x: px, y: py };
}

/**
 * Move a circle by (dx, dy), sliding along MOVE solids. Sub-steps keep fast moves from tunneling.
 * `ignore` skips solids with those bits (SOLID.VAULT while rolling: the roll passes windows).
 */
export function moveCircle(
  idx: CollisionIndex,
  x: number,
  y: number,
  r: number,
  dx: number,
  dy: number,
  ignore: SolidMask = 0,
): { x: number; y: number } {
  const dist = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(dist / (r * 0.5)));
  let px = x;
  let py = y;
  for (let i = 0; i < steps; i++) {
    const p = resolveCircle(idx, px + dx / steps, py + dy / steps, r, ignore);
    px = p.x;
    py = p.y;
  }
  return { x: px, y: py };
}

/** Step of leaveVault's search along the roll axis (px). */
export const VAULT_EXIT_STEP = 2;
/** leaveVault gives up on a direction after this far (window 24 px + a 48 px body + slack). */
export const VAULT_EXIT_MAX = 96;
/**
 * Overlap below this (px) is not "inside a window": a body slid flush against the wall face next
 * to a window may sit 1e-13 px into it from float rounding, which must not trigger a vault exit.
 */
export const VAULT_SLACK = 1e-6;

/**
 * A body that overlaps a VAULT solid (a dodge roll that ended inside a window) leaves it along its
 * roll axis (dx, dy) on the NEARER side: it is walked in VAULT_EXIT_STEP px steps forward and
 * backward at once (sliding along every other MOVE solid like the roll did) and the first position
 * that overlaps no VAULT solid wins; forward wins a tie, so a body centred in the opening finishes
 * the vault. If neither side frees it within VAULT_EXIT_MAX px (or the axis is zero), the plain
 * MOVE push-out (shortest axis) is the fallback. Not overlapping (beyond VAULT_SLACK): returned
 * unchanged.
 * Pure and deterministic: the server and the client prediction call it through stepMovement.
 */
export function leaveVault(
  idx: CollisionIndex,
  x: number,
  y: number,
  r: number,
  dx: number,
  dy: number,
): { x: number; y: number } {
  const rr = r - VAULT_SLACK;
  if (circleIsFree(idx, x, y, rr, SOLID.VAULT)) return { x, y };
  const len = Math.hypot(dx, dy);
  if (len > 1e-9) {
    const ux = (dx / len) * VAULT_EXIT_STEP;
    const uy = (dy / len) * VAULT_EXIT_STEP;
    let fx = x, fy = y, bx = x, by = y;
    for (let s = VAULT_EXIT_STEP; s <= VAULT_EXIT_MAX; s += VAULT_EXIT_STEP) {
      const f = resolveCircle(idx, fx + ux, fy + uy, r, SOLID.VAULT);
      fx = f.x;
      fy = f.y;
      if (circleIsFree(idx, fx, fy, rr, SOLID.VAULT)) return { x: fx, y: fy };
      const b = resolveCircle(idx, bx - ux, by - uy, r, SOLID.VAULT);
      bx = b.x;
      by = b.y;
      if (circleIsFree(idx, bx, by, rr, SOLID.VAULT)) return { x: bx, y: by };
    }
  }
  return resolveCircle(idx, x, y, r);
}

/** Is a circle at (x, y) free of solids (default: MOVE solids)? */
export function circleIsFree(
  idx: CollisionIndex, x: number, y: number, r: number, mask: SolidMask = SOLID.MOVE,
): boolean {
  let free = true;
  forEachSolidNear(
    idx, x - r, y - r, x + r, y + r, mask,
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

/**
 * First solid hit along the segment (x0,y0)→(x1,y1): t in [0, 1], or Infinity when clear.
 * Default mask SHOT (bullets). Visits the segment's bounding box; for long rays prefer
 * raycastSolidsDDA, which returns the same t.
 */
export function raycastSolids(
  idx: CollisionIndex,
  x0: number, y0: number, x1: number, y1: number,
  mask: SolidMask = SOLID.SHOT,
): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  let best = Infinity;
  forEachSolidNear(
    idx, x0, y0, x1, y1, mask,
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

/**
 * Same result as raycastSolids (same mask semantics) but walks only the cells the segment crosses
 * (Amanatides–Woo DDA): ~2.6× faster for 1000 px rays (fog memo, 0/20000 mismatches).
 * Default mask SIGHT: this is the vision ray.
 */
export function raycastSolidsDDA(
  idx: CollisionIndex,
  x0: number, y0: number, x1: number, y1: number,
  mask: SolidMask = SOLID.SIGHT,
): number {
  const dx = x1 - x0, dy = y1 - y0, cell = idx.cell;
  idx.stamp = (idx.stamp + 1) >>> 0;
  if (idx.stamp === 0) {
    idx.rectStamp.fill(0);
    idx.circleStamp.fill(0);
    idx.stamp = 1;
  }
  const s = idx.stamp;
  let cx = Math.floor(x0 / cell), cy = Math.floor(y0 / cell);
  const ex = Math.floor(x1 / cell), ey = Math.floor(y1 / cell);
  const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1;
  const tDX = dx !== 0 ? Math.abs(cell / dx) : Infinity;
  const tDY = dy !== 0 ? Math.abs(cell / dy) : Infinity;
  let tMX = dx !== 0 ? ((dx > 0 ? (cx + 1) * cell : cx * cell) - x0) / dx : Infinity;
  let tMY = dy !== 0 ? ((dy > 0 ? (cy + 1) * cell : cy * cell) - y0) / dy : Infinity;
  let best = Infinity;
  // Guard bounds the walk for degenerate input (NaN) — a 24k map is 96 cells wide at 256 px.
  for (let guard = 0; guard < 4096; guard++) {
    if (cx >= 0 && cy >= 0 && cx < idx.cols && cy < idx.rows) {
      const k = cy * idx.cols + cx;
      for (const i of idx.rectCells[k]!) {
        if (idx.rectStamp[i] === s) continue;
        idx.rectStamp[i] = s;
        if ((idx.rectFlags[i]! & mask) === 0) continue;
        const t = segmentRectT(x0, y0, dx, dy, idx.rects[i]!);
        if (t < best) best = t;
      }
      for (const i of idx.circleCells[k]!) {
        if (idx.circleStamp[i] === s) continue;
        idx.circleStamp[i] = s;
        if ((idx.circleFlags[i]! & mask) === 0) continue;
        const c = idx.circles[i]!;
        const t = segmentCircleT(x0, y0, dx, dy, c.x, c.y, c.r);
        if (t < best) best = t;
      }
      // A hit before the ray leaves this cell cannot be beaten by solids in later cells.
      if (best <= Math.min(tMX, tMY)) return best;
    }
    if (cx === ex && cy === ey) break;
    // The segment ends inside this cell. Checked in addition to the end-cell test because
    // accumulated float error in tMX/tMY can step past (ex, ey) diagonally, which would otherwise
    // walk empty cells until the guard.
    if (tMX > 1 && tMY > 1) break;
    if (tMX < tMY) { tMX += tDX; cx += stepX; } else { tMY += tDY; cy += stepY; }
  }
  return best;
}

/** Clear line of sight between two points (default: no SIGHT solid in between). */
export function hasLineOfSight(
  idx: CollisionIndex,
  x0: number, y0: number, x1: number, y1: number,
  mask: SolidMask = SOLID.SIGHT,
): boolean {
  return raycastSolidsDDA(idx, x0, y0, x1, y1, mask) === Infinity;
}

/**
 * Number of rect solids the segment crosses, capped at `max` — sound occlusion. Pass the server's
 * walls-only index (critique: one ray against walls, so crates and trees do not muffle).
 */
export function countOccluders(
  idx: CollisionIndex,
  x0: number, y0: number, x1: number, y1: number,
  max = 3,
  mask: SolidMask = SOLID.SIGHT,
): number {
  const dx = x1 - x0, dy = y1 - y0;
  let n = 0;
  forEachSolidNear(idx, x0, y0, x1, y1, mask, (r) => {
    if (segmentRectT(x0, y0, dx, dy, r) <= 1) n++;
    return n >= max;
  }, () => false);
  return n;
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
