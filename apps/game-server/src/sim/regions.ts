/**
 * Region graph over the 32 px walk grid (map memo §8). Flat A* on the 24,576 px Steppe (590k cells)
 * costs up to 60 ms per long query and fails 44% of the time under an expansion cap, so long paths
 * are found in two levels:
 *
 *   1. Regions: the grid is cut into B×B-cell blocks (B = 16 → 512 px); every 4-connected component
 *      of walkable cells inside a block is one region. Regions that touch across a block border are
 *      neighbours (CSR adjacency). A* over regions (~2.6k nodes) costs ~0.1 ms.
 *   2. Corridor refinement: fine A* on the grid, restricted to the cells of a run of path regions
 *      plus a 1-region ring. Consecutive path regions touch and each region is connected inside, so
 *      a fine path always exists inside the corridor (complete), and the ring keeps it near-optimal.
 *
 * Built once per MapData at process boot (~25 ms on the Steppe) and shared by every room: the
 * scratch arrays below are mutated by queries, which is safe only because Node runs the whole
 * simulation on one thread (never move sims to worker_threads without per-worker copies).
 */

import { nearestWalkCell, type WalkGrid } from "@extract/shared";

/** Fine cells per region block side: 16 × 32 px = 512 px (map memo: 2.6k regions on the Steppe). */
export const REGION_BLOCK = 16;

const SQRT2 = Math.SQRT2;

export class RegionGraph {
  readonly cols: number;
  readonly rows: number;
  readonly cell: number;
  readonly blocked: Uint8Array;
  /** Region id per fine cell; -1 for blocked cells. */
  readonly region: Int32Array;
  readonly count: number;
  /** Region centroid in world px (may fall outside a non-convex region; use repCell for a target). */
  readonly cx: Float32Array;
  readonly cy: Float32Array;
  /** The region's own cell nearest its centroid: a safe fine target inside the region. */
  readonly repCell: Int32Array;
  /** Connected component per region: different components → unreachable without any search. */
  readonly comp: Int32Array;
  /** CSR adjacency: neighbours of r are adj[adjStart[r] .. adjStart[r + 1]). */
  readonly adjStart: Int32Array;
  readonly adj: Int32Array;
  /** Centroid distance per adjacency entry (coarse edge cost). */
  readonly adjCost: Float32Array;
  /**
   * Node expansions done so far (coarse + fine). The planner budgets in these units instead of
   * wall-clock time, so a seeded match stays deterministic whatever the machine load.
   */
  work = 0;

  // Query scratch (stamped, never cleared in full except on stamp wrap).
  // Float64 on purpose: the stale-entry check compares g with the heap priority exactly.
  private readonly rg: Float64Array;
  private readonly rcame: Int32Array;
  private readonly rseen: Uint32Array;
  private readonly allow: Uint32Array;
  private readonly fg: Float64Array;
  private readonly fcame: Int32Array;
  private readonly fseen: Uint32Array;
  private stamp = 0;
  private readonly heap = new TypedHeap(1024);

  constructor(grid: WalkGrid, readonly block = REGION_BLOCK) {
    const { cols, rows, blocked } = grid;
    this.cols = cols;
    this.rows = rows;
    this.cell = grid.cell;
    this.blocked = blocked;
    const n = cols * rows;
    const region = new Int32Array(n).fill(-1);
    this.region = region;

    // 1. Components per block (iterative flood fill with a typed stack).
    const stack = new Int32Array(block * block);
    const sx: number[] = [];
    const sy: number[] = [];
    const cnt: number[] = [];
    let id = 0;
    for (let i = 0; i < n; i++) {
      if (blocked[i] || region[i] !== -1) continue;
      const x0 = i % cols;
      const y0 = (i - x0) / cols;
      const bx0 = Math.floor(x0 / block) * block;
      const by0 = Math.floor(y0 / block) * block;
      const bx1 = Math.min(cols, bx0 + block);
      const by1 = Math.min(rows, by0 + block);
      let top = 0;
      stack[top++] = i;
      region[i] = id;
      let sumX = 0, sumY = 0, k = 0;
      while (top > 0) {
        const c = stack[--top]!;
        const x = c % cols;
        const y = (c - x) / cols;
        sumX += x;
        sumY += y;
        k++;
        if (x > bx0 && !blocked[c - 1] && region[c - 1] === -1) { region[c - 1] = id; stack[top++] = c - 1; }
        if (x + 1 < bx1 && !blocked[c + 1] && region[c + 1] === -1) { region[c + 1] = id; stack[top++] = c + 1; }
        if (y > by0 && !blocked[c - cols] && region[c - cols] === -1) { region[c - cols] = id; stack[top++] = c - cols; }
        if (y + 1 < by1 && !blocked[c + cols] && region[c + cols] === -1) { region[c + cols] = id; stack[top++] = c + cols; }
      }
      sx.push(sumX);
      sy.push(sumY);
      cnt.push(k);
      id++;
    }
    this.count = id;
    this.cx = new Float32Array(id);
    this.cy = new Float32Array(id);
    for (let r = 0; r < id; r++) {
      this.cx[r] = (sx[r]! / cnt[r]! + 0.5) * this.cell;
      this.cy[r] = (sy[r]! / cnt[r]! + 0.5) * this.cell;
    }

    // 2. Representative cell: the region's cell nearest its centroid (one pass over the grid).
    this.repCell = new Int32Array(id).fill(-1);
    const repD = new Float32Array(id).fill(Infinity);
    for (let i = 0; i < n; i++) {
      const r = region[i]!;
      if (r < 0) continue;
      const x = i % cols;
      const dx = (x + 0.5) * this.cell - this.cx[r]!;
      const dy = ((i - x) / cols + 0.5) * this.cell - this.cy[r]!;
      const d = dx * dx + dy * dy;
      if (d < repD[r]!) { repD[r] = d; this.repCell[r] = i; }
    }

    // 3. Adjacency: regions touching across a block border (4-neighbourhood, like the fill).
    const pairs = new Set<number>();
    const key = (a: number, b: number) => (a < b ? a * id + b : b * id + a);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x;
        const a = region[i]!;
        if (a < 0) continue;
        if (x + 1 < cols) { const b = region[i + 1]!; if (b >= 0 && b !== a) pairs.add(key(a, b)); }
        if (y + 1 < rows) { const b = region[i + cols]!; if (b >= 0 && b !== a) pairs.add(key(a, b)); }
      }
    }
    const deg = new Int32Array(id + 1);
    for (const k of pairs) {
      const a = Math.floor(k / id);
      deg[a]!++;
      deg[k - a * id]!++;
    }
    this.adjStart = new Int32Array(id + 1);
    for (let r = 0; r < id; r++) this.adjStart[r + 1] = this.adjStart[r]! + deg[r]!;
    this.adj = new Int32Array(this.adjStart[id]!);
    this.adjCost = new Float32Array(this.adjStart[id]!);
    const fill = this.adjStart.slice(0, id);
    // Sorted keys → deterministic neighbour order independent of Set insertion details.
    for (const k of [...pairs].sort((p, q) => p - q)) {
      const a = Math.floor(k / id);
      const b = k - a * id;
      const d = Math.sqrt((this.cx[a]! - this.cx[b]!) ** 2 + (this.cy[a]! - this.cy[b]!) ** 2);
      this.adj[fill[a]!] = b;
      this.adjCost[fill[a]!++] = d;
      this.adj[fill[b]!] = a;
      this.adjCost[fill[b]!++] = d;
    }

    // 4. Connected components over regions.
    this.comp = new Int32Array(id).fill(-1);
    const q = new Int32Array(id);
    let c = 0;
    for (let r = 0; r < id; r++) {
      if (this.comp[r] !== -1) continue;
      let head = 0, tail = 0;
      q[tail++] = r;
      this.comp[r] = c;
      while (head < tail) {
        const u = q[head++]!;
        for (let k = this.adjStart[u]!; k < this.adjStart[u + 1]!; k++) {
          const v = this.adj[k]!;
          if (this.comp[v] === -1) { this.comp[v] = c; q[tail++] = v; }
        }
      }
      c++;
    }

    this.rg = new Float64Array(id);
    this.rcame = new Int32Array(id);
    this.rseen = new Uint32Array(id);
    this.allow = new Uint32Array(id);
    this.fg = new Float64Array(n);
    this.fcame = new Int32Array(n);
    this.fseen = new Uint32Array(n);
  }

  get edgeCount(): number {
    return this.adj.length / 2;
  }

  /** Walkable cell nearest (x, y) within maxPx (player centres often sit in clearance-blocked cells). */
  cellAt(x: number, y: number, maxPx = 96): number {
    return nearestWalkCell({ cell: this.cell, cols: this.cols, rows: this.rows, blocked: this.blocked }, x, y, maxPx);
  }

  cellX(i: number): number {
    return ((i % this.cols) + 0.5) * this.cell;
  }

  cellY(i: number): number {
    return (Math.floor(i / this.cols) + 0.5) * this.cell;
  }

  connected(ra: number, rb: number): boolean {
    return ra >= 0 && rb >= 0 && this.comp[ra] === this.comp[rb];
  }

  private nextStamp(): number {
    this.stamp = (this.stamp + 1) >>> 0;
    if (this.stamp === 0) {
      this.rseen.fill(0);
      this.allow.fill(0);
      this.fseen.fill(0);
      this.stamp = 1;
    }
    return this.stamp;
  }

  /** A* over regions: region ids from ra to rb inclusive, or null when not connected. */
  coarse(ra: number, rb: number): number[] | null {
    if (!this.connected(ra, rb)) return null;
    if (ra === rb) return [ra];
    const s = this.nextStamp();
    const { cx, cy, adjStart, adj, adjCost, rg, rcame, rseen } = this;
    const gx = cx[rb]!, gy = cy[rb]!;
    const h = (r: number) => Math.sqrt((cx[r]! - gx) ** 2 + (cy[r]! - gy) ** 2);
    const heap = this.heap;
    heap.clear();
    rseen[ra] = s;
    rg[ra] = 0;
    rcame[ra] = -1;
    heap.push(ra, h(ra));
    let exp = 0;
    let found = false;
    while (heap.size > 0) {
      const pr = heap.topPrio();
      const c = heap.pop();
      // Stale duplicate: a cheaper entry for c was already expanded.
      if (pr - h(c) > rg[c]! + 1e-3) continue;
      exp++;
      if (c === rb) { found = true; break; }
      const gc = rg[c]!;
      for (let k = adjStart[c]!; k < adjStart[c + 1]!; k++) {
        const nb = adj[k]!;
        const ng = gc + adjCost[k]!;
        if (rseen[nb] === s && ng >= rg[nb]!) continue;
        rseen[nb] = s;
        rg[nb] = ng;
        rcame[nb] = c;
        heap.push(nb, ng + h(nb));
      }
    }
    this.work += exp;
    if (!found) return null;
    const out: number[] = [];
    for (let r = rb; r !== -1; r = rcame[r]!) out.push(r);
    return out.reverse();
  }

  /**
   * Fine A* (8-neighbour, no corner cutting) from cell `start` to cell `goal`, allowed only on the
   * cells of `corridor` (region ids) and, with `ring`, their direct neighbours. Returns the cell
   * sequence start..goal, or null (cannot happen for a corridor taken from a coarse path that
   * contains both cells' regions — see the header).
   */
  fine(start: number, goal: number, corridor: readonly number[], ring = true): number[] | null {
    if (start < 0 || goal < 0 || this.blocked[start] || this.blocked[goal]) return null;
    if (start === goal) return [start];
    const s = this.nextStamp();
    const { allow, adjStart, adj, region, blocked, fg, fcame, fseen, cols, rows } = this;
    for (const r of corridor) {
      allow[r] = s;
      if (ring) for (let k = adjStart[r]!; k < adjStart[r + 1]!; k++) allow[adj[k]!] = s;
    }
    if (allow[region[start]!] !== s || allow[region[goal]!] !== s) return null;
    const gc = goal % cols;
    const gr = (goal - gc) / cols;
    const h = (i: number) => {
      const x = i % cols;
      const dc = Math.abs(x - gc);
      const dr = Math.abs((i - x) / cols - gr);
      return dc > dr ? dc + (SQRT2 - 1) * dr : dr + (SQRT2 - 1) * dc;
    };
    const heap = this.heap;
    heap.clear();
    fseen[start] = s;
    fg[start] = 0;
    fcame[start] = -1;
    heap.push(start, h(start));
    let exp = 0;
    let found = false;
    while (heap.size > 0) {
      const pr = heap.topPrio();
      const cur = heap.pop();
      if (pr - h(cur) > fg[cur]! + 1e-3) continue;
      exp++;
      if (cur === goal) { found = true; break; }
      const cc = cur % cols;
      const cr = (cur - cc) / cols;
      const gcur = fg[cur]!;
      for (let dr = -1; dr <= 1; dr++) {
        const nr = cr + dr;
        if (nr < 0 || nr >= rows) continue;
        for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          const nc = cc + dc;
          if (nc < 0 || nc >= cols) continue;
          const ni = nr * cols + nc;
          if (blocked[ni] || allow[region[ni]!] !== s) continue;
          // No corner cutting: a diagonal needs both orthogonal neighbours free (same rule as v1 nav).
          if (dr && dc && (blocked[cr * cols + nc] || blocked[nr * cols + cc])) continue;
          const ng = gcur + (dr && dc ? SQRT2 : 1);
          if (fseen[ni] === s && ng >= fg[ni]!) continue;
          fseen[ni] = s;
          fg[ni] = ng;
          fcame[ni] = cur;
          heap.push(ni, ng + h(ni));
        }
      }
    }
    this.work += exp;
    if (!found) return null;
    const out: number[] = [];
    for (let i = goal; i !== -1; i = fcame[i]!) out.push(i);
    return out.reverse();
  }
}

/** Binary min-heap over typed arrays (duplicates allowed; callers skip stale entries). */
class TypedHeap {
  private nodes: Int32Array;
  private prio: Float64Array;
  size = 0;

  constructor(cap: number) {
    this.nodes = new Int32Array(cap);
    this.prio = new Float64Array(cap);
  }

  clear(): void {
    this.size = 0;
  }

  topPrio(): number {
    return this.prio[0]!;
  }

  push(node: number, p: number): void {
    if (this.size === this.nodes.length) {
      const n = new Int32Array(this.size * 2);
      n.set(this.nodes);
      const q = new Float64Array(this.size * 2);
      q.set(this.prio);
      this.nodes = n;
      this.prio = q;
    }
    const n = this.nodes;
    const q = this.prio;
    let i = this.size++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (q[parent]! <= p) break;
      n[i] = n[parent]!;
      q[i] = q[parent]!;
      i = parent;
    }
    n[i] = node;
    q[i] = p;
  }

  pop(): number {
    const n = this.nodes;
    const q = this.prio;
    const top = n[0]!;
    const len = --this.size;
    if (len > 0) {
      const lastN = n[len]!;
      const lastP = q[len]!;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= len) break;
        const r = l + 1;
        const c = r < len && q[r]! < q[l]! ? r : l;
        if (q[c]! >= lastP) break;
        n[i] = n[c]!;
        q[i] = q[c]!;
        i = c;
      }
      n[i] = lastN;
      q[i] = lastP;
    }
    return top;
  }
}
