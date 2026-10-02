/**
 * Bot pathfinding: A* over a coarse walkability grid of the static map (built once per map and
 * cached). Bots string-pull along the result lazily (see BotBrain.navigate), so the grid only has
 * to get them around buildings and obstacle clusters, not produce pretty paths.
 */

import { PLAYER, circleIsFree, type CollisionIndex, type MapData } from "@extract/shared";

export interface Pt { x: number; y: number }

/**
 * 32 px cells with a clearance of RADIUS + 4: a 96 px door leaves a 40 px band of valid centers,
 * so at least one cell column always passes through it.
 */
const CELL = 32;
const CLEARANCE = PLAYER.RADIUS + 4;
/** Hard cap on expanded nodes so a pathological query cannot stall a tick. */
const MAX_EXPANSIONS = 30_000;

export class NavGrid {
  readonly cols: number;
  readonly rows: number;
  readonly blocked: Uint8Array;
  private readonly g: Float64Array;
  private readonly came: Int32Array;
  private readonly seen: Uint32Array;
  private stamp = 0;

  constructor(map: MapData, idx: CollisionIndex) {
    this.cols = Math.ceil(map.width / CELL);
    this.rows = Math.ceil(map.height / CELL);
    const n = this.cols * this.rows;
    this.blocked = new Uint8Array(n);
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const x = (c + 0.5) * CELL;
        const y = (r + 0.5) * CELL;
        if (!circleIsFree(idx, x, y, CLEARANCE)) this.blocked[r * this.cols + c] = 1;
      }
    }
    this.g = new Float64Array(n);
    this.came = new Int32Array(n);
    this.seen = new Uint32Array(n);
  }

  private cellOf(p: Pt): number {
    const c = Math.max(0, Math.min(this.cols - 1, Math.floor(p.x / CELL)));
    const r = Math.max(0, Math.min(this.rows - 1, Math.floor(p.y / CELL)));
    return r * this.cols + c;
  }

  private center(i: number): Pt {
    return { x: ((i % this.cols) + 0.5) * CELL, y: (Math.floor(i / this.cols) + 0.5) * CELL };
  }

  /** Nearest walkable cell (small spiral search): targets like chests often sit next to walls. */
  private nearestFree(i: number): number {
    if (!this.blocked[i]) return i;
    const c0 = i % this.cols;
    const r0 = Math.floor(i / this.cols);
    for (let rad = 1; rad <= 4; rad++) {
      let best = -1;
      let bestD = Infinity;
      for (let dr = -rad; dr <= rad; dr++) {
        for (let dc = -rad; dc <= rad; dc++) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== rad) continue;
          const r = r0 + dr;
          const c = c0 + dc;
          if (r < 0 || c < 0 || r >= this.rows || c >= this.cols) continue;
          const j = r * this.cols + c;
          const d = dr * dr + dc * dc;
          if (!this.blocked[j] && d < bestD) { bestD = d; best = j; }
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  /** Waypoints from `from` to `to` (ending exactly at `to`), or null when unreachable. */
  findPath(from: Pt, to: Pt): Pt[] | null {
    const start = this.nearestFree(this.cellOf(from));
    const goal = this.nearestFree(this.cellOf(to));
    if (start < 0 || goal < 0) return null;
    if (start === goal) return [to];

    this.stamp = (this.stamp + 1) >>> 0;
    if (this.stamp === 0) {
      this.seen.fill(0);
      this.stamp = 1;
    }
    const s = this.stamp;
    const cols = this.cols;
    const gc = goal % cols;
    const gr = Math.floor(goal / cols);
    const h = (i: number) => {
      const dc = Math.abs((i % cols) - gc);
      const dr = Math.abs(Math.floor(i / cols) - gr);
      return Math.max(dc, dr) + 0.4142 * Math.min(dc, dr);
    };

    const heap = new MinHeap();
    this.seen[start] = s;
    this.g[start] = 0;
    this.came[start] = -1;
    heap.push(start, h(start));
    let expansions = 0;
    let found = false;

    while (heap.size > 0) {
      const cur = heap.pop();
      if (cur === goal) { found = true; break; }
      if (++expansions > MAX_EXPANSIONS) break;
      const cc = cur % cols;
      const cr = Math.floor(cur / cols);
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          const nr = cr + dr;
          const nc = cc + dc;
          if (nr < 0 || nc < 0 || nr >= this.rows || nc >= cols) continue;
          const ni = nr * cols + nc;
          if (this.blocked[ni]) continue;
          // No corner cutting: a diagonal needs both orthogonal neighbours free.
          if (dr && dc && (this.blocked[cr * cols + nc] || this.blocked[nr * cols + cc])) continue;
          const ng = this.g[cur]! + (dr && dc ? 1.4142 : 1);
          if (this.seen[ni] === s && ng >= this.g[ni]!) continue;
          this.seen[ni] = s;
          this.g[ni] = ng;
          this.came[ni] = cur;
          heap.push(ni, ng + h(ni));
        }
      }
    }
    if (!found) return null;

    const cells: number[] = [];
    for (let i = goal; i !== -1 && i !== start; i = this.came[i]!) cells.push(i);
    cells.reverse();
    const pts = cells.map((i) => this.center(i));
    pts[pts.length - 1] = to;
    return pts;
  }
}

/** Binary min-heap of (node, priority); duplicates are fine (stale entries are re-expanded cheaply). */
class MinHeap {
  private nodes: number[] = [];
  private prio: number[] = [];

  get size(): number {
    return this.nodes.length;
  }

  push(node: number, p: number): void {
    const n = this.nodes;
    const q = this.prio;
    let i = n.length;
    n.push(node);
    q.push(p);
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
    const lastN = n.pop()!;
    const lastP = q.pop()!;
    if (n.length > 0) {
      let i = 0;
      const len = n.length;
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

const gridCache = new WeakMap<MapData, NavGrid>();

export function navGridFor(map: MapData, idx: CollisionIndex): NavGrid {
  let g = gridCache.get(map);
  if (!g) {
    g = new NavGrid(map, idx);
    gridCache.set(map, g);
  }
  return g;
}
