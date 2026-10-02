/**
 * Uniform bucket grid over points with dense numeric ids (perf memo). Used by server pickups, AOI,
 * bot goals and bushes, and by the client interact hint and bushAt. autoPickup over every item was
 * measured at 50% of the tick on the big map; a grid query touches only nearby cells.
 * Ids are numbers (entity indexes), not strings, so cells stay small int arrays.
 */
export class UniformGrid {
  readonly cols: number;
  readonly rows: number;
  private readonly cells: number[][];
  private readonly cellOf = new Map<number, number>();

  constructor(readonly width: number, readonly height: number, readonly cell = 256) {
    this.cols = Math.max(1, Math.ceil(width / cell));
    this.rows = Math.max(1, Math.ceil(height / cell));
    this.cells = Array.from({ length: this.cols * this.rows }, () => []);
  }

  private key(x: number, y: number): number {
    const c = Math.max(0, Math.min(this.cols - 1, Math.floor(x / this.cell)));
    const r = Math.max(0, Math.min(this.rows - 1, Math.floor(y / this.cell)));
    return r * this.cols + c;
  }

  get size(): number {
    return this.cellOf.size;
  }

  has(id: number): boolean {
    return this.cellOf.has(id);
  }

  /** Insert or move. Cheap when the point stays in its cell (the common per-tick case). */
  set(id: number, x: number, y: number): void {
    const k = this.key(x, y);
    const old = this.cellOf.get(id);
    if (old === k) return;
    if (old !== undefined) this.drop(old, id);
    this.cells[k]!.push(id);
    this.cellOf.set(id, k);
  }

  delete(id: number): void {
    const old = this.cellOf.get(id);
    if (old === undefined) return;
    this.drop(old, id);
    this.cellOf.delete(id);
  }

  clear(): void {
    for (const c of this.cells) c.length = 0;
    this.cellOf.clear();
  }

  /**
   * Candidate ids whose cell overlaps the circle's bounding box; callers do the exact distance
   * test. `out` is reused (cleared first) so hot loops do not allocate.
   */
  queryCircle(x: number, y: number, r: number, out: number[] = []): number[] {
    out.length = 0;
    const c0 = Math.max(0, Math.floor((x - r) / this.cell));
    const c1 = Math.min(this.cols - 1, Math.floor((x + r) / this.cell));
    const r0 = Math.max(0, Math.floor((y - r) / this.cell));
    const r1 = Math.min(this.rows - 1, Math.floor((y + r) / this.cell));
    for (let rr = r0; rr <= r1; rr++) {
      for (let cc = c0; cc <= c1; cc++) {
        const cell = this.cells[rr * this.cols + cc]!;
        for (let i = 0; i < cell.length; i++) out.push(cell[i]!);
      }
    }
    return out;
  }

  /** Ids in one cell by (col, row) — AOI rings iterate cells directly. */
  cellIds(col: number, row: number): readonly number[] {
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return EMPTY;
    return this.cells[row * this.cols + col]!;
  }

  private drop(k: number, id: number): void {
    const cell = this.cells[k]!;
    const i = cell.indexOf(id);
    if (i >= 0) {
      cell[i] = cell[cell.length - 1]!;
      cell.pop();
    }
  }
}

const EMPTY: readonly number[] = Object.freeze([]);
