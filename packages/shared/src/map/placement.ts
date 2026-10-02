/**
 * Spatial hash of taken footprints for the generator (replaces v1's O(n²) `taken.some()`).
 * Owned by the map agent after WP0; this is the map memo's version so the generator can start.
 */

import type { Rect } from "../geometry.js";

export class Placement {
  private readonly cell = 512;
  private readonly cols: number;
  private readonly buckets: number[][];
  private readonly rects: Rect[] = [];

  constructor(size: number) {
    this.cols = Math.ceil(size / this.cell);
    this.buckets = Array.from({ length: this.cols * this.cols }, () => []);
  }

  add(r: Rect): void {
    const i = this.rects.push(r) - 1;
    this.each(r, 0, (b) => {
      this.buckets[b]!.push(i);
    });
  }

  /** True when `r` grown by `margin` overlaps no added footprint. */
  free(r: Rect, margin: number): boolean {
    let ok = true;
    this.each(r, margin, (b) => {
      for (const i of this.buckets[b]!) {
        const t = this.rects[i]!;
        if (r.x - margin < t.x + t.w && r.x + r.w + margin > t.x && r.y - margin < t.y + t.h && r.y + r.h + margin > t.y) {
          ok = false;
          return true;
        }
      }
      return false;
    });
    return ok;
  }

  private each(r: Rect, m: number, f: (bucket: number) => boolean | void): void {
    const c = this.cell, n = this.cols;
    for (let y = Math.max(0, Math.floor((r.y - m) / c)); y <= Math.min(n - 1, Math.floor((r.y + r.h + m) / c)); y++) {
      for (let x = Math.max(0, Math.floor((r.x - m) / c)); x <= Math.min(n - 1, Math.floor((r.x + r.w + m) / c)); x++) {
        if (f(y * n + x)) return;
      }
    }
  }
}
