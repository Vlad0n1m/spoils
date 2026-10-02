/**
 * Static navigation data of a map and the flat grid A* used for short hops and as the test oracle
 * of the region planner (regions.ts / planner.ts).
 *
 * Everything static about a map — MapData, collision index, walls-only index, 32 px walk grid,
 * region graph, bush index — is built ONCE per MapData by mapRuntime() and shared by every room.
 * warmMap(id) runs it at process boot: the 60 ms tick spike measured in the map memo came from a
 * NavGrid built lazily inside a tick, so nothing here may be first touched by step().
 */

import {
  buildBushIndex,
  generateMap,
  getCollisionIndex,
  getWalkGrid,
  getWallIndex,
  mapHash,
  type BushIndex,
  type CollisionIndex,
  type MapData,
  type MapId,
  type WalkGrid,
} from "@extract/shared";
import { RegionGraph } from "./regions.js";

export interface Pt { x: number; y: number }

/** Hard cap on expanded nodes so a pathological flat query cannot stall a tick. */
const MAX_EXPANSIONS = 30_000;

/**
 * Flat A* over the shared walk grid (32 px cells, clearance RADIUS + 4: a 96 px door leaves a
 * 40 px band of valid centres, so at least one cell column always passes through it).
 */
export class NavGrid {
  readonly cols: number;
  readonly rows: number;
  readonly cell: number;
  readonly blocked: Uint8Array;
  private readonly g: Float64Array;
  private readonly came: Int32Array;
  private readonly seen: Uint32Array;
  private stamp = 0;

  constructor(grid: WalkGrid) {
    this.cols = grid.cols;
    this.rows = grid.rows;
    this.cell = grid.cell;
    this.blocked = grid.blocked;
    const n = this.cols * this.rows;
    this.g = new Float64Array(n);
    this.came = new Int32Array(n);
    this.seen = new Uint32Array(n);
  }

  private cellOf(p: Pt): number {
    const c = Math.max(0, Math.min(this.cols - 1, Math.floor(p.x / this.cell)));
    const r = Math.max(0, Math.min(this.rows - 1, Math.floor(p.y / this.cell)));
    return r * this.cols + c;
  }

  private center(i: number): Pt {
    return { x: ((i % this.cols) + 0.5) * this.cell, y: (Math.floor(i / this.cols) + 0.5) * this.cell };
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

// ---------------------------------------------------------------- static map runtime

/** Everything static about one map, built once per process and shared by all rooms. */
export interface MapRuntime {
  map: MapData;
  /** mapHash(map): compared with the client's join option (generator drift / stale bundle). */
  hash: string;
  idx: CollisionIndex;
  /** Walls-only index (sound occlusion). */
  walls: CollisionIndex;
  walk: WalkGrid;
  regions: RegionGraph;
  bushIndex: BushIndex;
  /** Wall-clock build time of the parts built by this call (0 when everything was cached). */
  buildMs: number;
}

const runtimeCache = new WeakMap<MapData, MapRuntime>();

/**
 * Static runtime of a MapData (cached per object). Call it at process boot (warmMap) or at room
 * creation for test maps — never from inside a tick.
 */
export function mapRuntime(map: MapData): MapRuntime {
  let rt = runtimeCache.get(map);
  if (!rt) {
    const t0 = performance.now();
    const idx = getCollisionIndex(map);
    const walk = getWalkGrid(map);
    rt = {
      map,
      hash: mapHash(map),
      idx,
      walls: getWallIndex(map),
      walk,
      regions: new RegionGraph(walk),
      bushIndex: buildBushIndex(map.bushes, map.width, map.height),
      buildMs: 0,
    };
    rt.buildMs = performance.now() - t0;
    runtimeCache.set(map, rt);
  }
  return rt;
}

/** Process boot: generate map `id` (memoized in shared) and build its whole static runtime. */
export function warmMap(id: MapId): MapRuntime {
  return mapRuntime(generateMap(id));
}

const gridCache = new WeakMap<MapData, NavGrid>();

/** Flat-A* grid of a map (shares the walk grid of mapRuntime). */
export function navGridFor(map: MapData): NavGrid {
  let g = gridCache.get(map);
  if (!g) {
    g = new NavGrid(mapRuntime(map).walk);
    gridCache.set(map, g);
  }
  return g;
}
