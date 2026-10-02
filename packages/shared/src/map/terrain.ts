/**
 * The 64 px terrain grid (MapData.terrain): ground tiles, footstep material, the ford's speed
 * multiplier and the INDOOR bit. Painting is centre-based (a cell takes a kind when its centre is
 * inside the shape) so shapes snap the same way on every engine. Only + - * / floor/min/max here.
 */

import type { Rect } from "../geometry.js";
import type { Rng } from "../rng.js";
import { TERRAIN, TERRAIN_KIND_MASK } from "./types.js";
import { distSqPointSeg } from "./util.js";

/** roadMask values: which road family stamped a cell (wagons must not block real roads). */
export const ROAD_MASK = { NONE: 0, ASPHALT: 1, DIRT: 2, RAIL: 3 } as const;

export class TerrainGrid {
  readonly cols: number;
  readonly rows: number;
  readonly data: Uint8Array;
  /** Side channel (not exported in MapData): road family per cell, for placement rules. */
  readonly roadMask: Uint8Array;

  constructor(readonly width: number, readonly height: number, readonly cell: number) {
    this.cols = Math.ceil(width / cell);
    this.rows = Math.ceil(height / cell);
    this.data = new Uint8Array(this.cols * this.rows);
    this.roadMask = new Uint8Array(this.cols * this.rows);
  }

  /** Kind (INDOOR stripped) at a world point, clamped to the grid. */
  kindAt(x: number, y: number): number {
    return this.data[this.cellIndex(x, y)]! & TERRAIN_KIND_MASK;
  }

  byteAt(x: number, y: number): number {
    return this.data[this.cellIndex(x, y)]!;
  }

  roadAt(x: number, y: number): number {
    return this.roadMask[this.cellIndex(x, y)]!;
  }

  cellIndex(x: number, y: number): number {
    const c = Math.min(this.cols - 1, Math.max(0, Math.floor(x / this.cell)));
    const r = Math.min(this.rows - 1, Math.max(0, Math.floor(y / this.cell)));
    return r * this.cols + c;
  }

  /**
   * Forest/grass from two-octave value noise (bilinear with smoothstep: multiplications only),
   * biased up near the map edge so the spawn band has cover. The threshold is the exact quantile
   * for `forestFrac`, so retuning the noise never silently changes how much forest there is.
   */
  fillForest(rng: Rng, forestFrac: number, edgeBand: number, edgeBias: number): void {
    const { cols, rows } = this;
    const octaves = [
      { step: 8, amp: 0.65 }, // 512 px lattice: forest blobs
      { step: 32, amp: 0.35 }, // 2048 px lattice: large woodland vs open steppe
    ];
    const v = new Float64Array(cols * rows);
    for (const o of octaves) {
      const ln = Math.floor(cols / o.step) + 2;
      const lat = new Float64Array(ln * ln);
      for (let i = 0; i < lat.length; i++) lat[i] = rng();
      for (let r = 0; r < rows; r++) {
        const fy = r / o.step, iy = Math.floor(fy);
        let ty = fy - iy;
        ty = ty * ty * (3 - 2 * ty);
        for (let c = 0; c < cols; c++) {
          const fx = c / o.step, ix = Math.floor(fx);
          let tx = fx - ix;
          tx = tx * tx * (3 - 2 * tx);
          const a = lat[iy * ln + ix]!, b = lat[iy * ln + ix + 1]!;
          const d = lat[(iy + 1) * ln + ix]!, e = lat[(iy + 1) * ln + ix + 1]!;
          v[r * cols + c] += o.amp * ((a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty);
        }
      }
    }
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const edge = Math.min(c, r, cols - 1 - c, rows - 1 - r);
        if (edge < edgeBand) v[r * cols + c] += (edgeBias * (edgeBand - edge)) / edgeBand;
      }
    }
    const sorted = Float64Array.from(v).sort();
    const thr = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * (1 - forestFrac)))]!;
    for (let i = 0; i < v.length; i++) this.data[i] = v[i]! >= thr ? TERRAIN.FOREST : TERRAIN.GRASS;
  }

  /** Repaint every cell whose centre lies in `r`; `fn(old) → new byte`. */
  paintRect(r: Rect, fn: (old: number, i: number) => number): void {
    const cs = this.cell;
    const c0 = Math.max(0, Math.ceil(r.x / cs - 0.5)), c1 = Math.min(this.cols - 1, Math.ceil((r.x + r.w) / cs - 0.5) - 1);
    const r0 = Math.max(0, Math.ceil(r.y / cs - 0.5)), r1 = Math.min(this.rows - 1, Math.ceil((r.y + r.h) / cs - 0.5) - 1);
    for (let y = r0; y <= r1; y++) {
      for (let x = c0; x <= c1; x++) {
        const i = y * this.cols + x;
        this.data[i] = fn(this.data[i]!, i);
      }
    }
  }

  /**
   * Repaint every cell whose centre is within `half` px of the polyline (a chain of capsules).
   * Exact squared distances, no sampling along the line, so the band has no holes on bends.
   */
  paintPolyline(pts: readonly number[], half: number, fn: (old: number, i: number) => number): void {
    // Segments overlap at joints, so `fn` may see a cell twice: it must be idempotent.
    const cs = this.cell, h2 = half * half;
    for (let s = 0; s + 3 < pts.length; s += 2) {
      const ax = pts[s]!, ay = pts[s + 1]!, bx = pts[s + 2]!, by = pts[s + 3]!;
      const c0 = Math.max(0, Math.floor((Math.min(ax, bx) - half) / cs));
      const c1 = Math.min(this.cols - 1, Math.floor((Math.max(ax, bx) + half) / cs));
      const r0 = Math.max(0, Math.floor((Math.min(ay, by) - half) / cs));
      const r1 = Math.min(this.rows - 1, Math.floor((Math.max(ay, by) + half) / cs));
      for (let y = r0; y <= r1; y++) {
        for (let x = c0; x <= c1; x++) {
          if (distSqPointSeg((x + 0.5) * cs, (y + 0.5) * cs, ax, ay, bx, by) <= h2) {
            const i = y * this.cols + x;
            this.data[i] = fn(this.data[i]!, i);
          }
        }
      }
    }
  }

  /** Merge cells matching `pred` into per-row runs (water solids, placement reservations). */
  runs(pred: (i: number) => boolean): Rect[] {
    const out: Rect[] = [];
    const cs = this.cell;
    for (let y = 0; y < this.rows; y++) {
      let x = 0;
      while (x < this.cols) {
        if (!pred(y * this.cols + x)) {
          x++;
          continue;
        }
        const x0 = x;
        while (x < this.cols && pred(y * this.cols + x)) x++;
        out.push({ x: x0 * cs, y: y * cs, w: (x - x0) * cs, h: cs });
      }
    }
    return out;
  }

  /** Fraction of the cells inside `r` whose kind is `kind`. */
  fraction(r: Rect, kind: number): number {
    let n = 0, hit = 0;
    this.paintRect(r, (old) => {
      n++;
      if ((old & TERRAIN_KIND_MASK) === kind) hit++;
      return old;
    });
    return n > 0 ? hit / n : 0;
  }

  count(kind: number): number {
    let n = 0;
    for (let i = 0; i < this.data.length; i++) if ((this.data[i]! & TERRAIN_KIND_MASK) === kind) n++;
    return n;
  }
}
