/**
 * Chunked baked ground (WP-M3, map memo §9, perf memo P1 #5).
 *
 * The 24,576 px map is cut into 1024 px chunks (24 × 24). Each visible chunk is baked once into a
 * RenderTexture holding everything static below the players: terrain tiles with soft edges, roads,
 * rails, floors, decals, static shadows, and all static solids (walls, windows, crates, rocks,
 * trunks, cars, containers, wagons, shelves, sandbags, fences, log piles, barrels). Players never
 * overlap solids and stand above them in z-order, so baking them is invisible to gameplay; only
 * the canopy (canopy.ts) stays live.
 *
 * Budget: an LRU of 16 chunk textures (16 × 4 MB at resolution 1), at most one bake per frame,
 * visible chunks first, then a prefetch in the movement direction. Chunks that are visible but
 * not baked yet show the map overview texture (a blurry but correctly coloured stand-in), never a
 * hole. Per-frame cost is index math over ≤ 16 slots: there is no per-object culling loop.
 */

import {
  CanvasSource,
  Container,
  Graphics,
  Matrix,
  NineSliceSprite,
  RenderTexture,
  Sprite,
  Texture,
  type Renderer,
} from "pixi.js";
import {
  WORLD,
  mapHash,
  type Decal,
  type MapCircle,
  type MapData,
  type MapRect,
  type Rect,
} from "@extract/shared";
import { COLORS, SPRITE_CONTENT, type SpriteName, type Textures } from "./assets";
import { GroundBuilder, makeTileTextures } from "./terrain-tiles";

// ---------------------------------------------------------------------------------------------
// Pure: chunk grid, keys, ranges, LRU, scheduling, buckets
// ---------------------------------------------------------------------------------------------

export interface ChunkGrid {
  /** Chunk size in world px. */
  chunk: number;
  cols: number;
  rows: number;
}

export function chunkGridOf(map: { width: number; height: number }, chunk: number = WORLD.CHUNK): ChunkGrid {
  return { chunk, cols: Math.max(1, Math.ceil(map.width / chunk)), rows: Math.max(1, Math.ceil(map.height / chunk)) };
}

/** Dense numeric key (row-major) — cheap Map/Set keys and array indexes. */
export function chunkKey(g: ChunkGrid, cx: number, cy: number): number {
  return cy * g.cols + cx;
}

export function chunkXY(g: ChunkGrid, key: number): { cx: number; cy: number } {
  const cx = key % g.cols;
  return { cx, cy: (key - cx) / g.cols };
}

/** Inclusive chunk index range covering a world box, clamped to the grid. */
export function chunkSpan(g: ChunkGrid, x0: number, y0: number, x1: number, y1: number) {
  const cx = (v: number) => Math.max(0, Math.min(g.cols - 1, Math.floor(v / g.chunk)));
  const cy = (v: number) => Math.max(0, Math.min(g.rows - 1, Math.floor(v / g.chunk)));
  return { cx0: cx(x0), cy0: cy(y0), cx1: cx(x1), cy1: cy(y1) };
}

/**
 * Keys of the chunks overlapping a world box, nearest to (px, py) first — the bake order when
 * several visible chunks are missing (the one under the player matters most). `out` is reused.
 */
export function chunksInRect(
  g: ChunkGrid,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  px: number,
  py: number,
  out: number[] = [],
): number[] {
  out.length = 0;
  const s = chunkSpan(g, x0, y0, x1, y1);
  for (let cy = s.cy0; cy <= s.cy1; cy++) for (let cx = s.cx0; cx <= s.cx1; cx++) out.push(chunkKey(g, cx, cy));
  const d = (k: number) => {
    const { cx, cy } = chunkXY(g, k);
    const dx = (cx + 0.5) * g.chunk - px;
    const dy = (cy + 0.5) * g.chunk - py;
    return dx * dx + dy * dy;
  };
  // ≤ 16 entries: an insertion sort allocates nothing.
  for (let i = 1; i < out.length; i++) {
    const k = out[i]!;
    const dk = d(k);
    let j = i - 1;
    while (j >= 0 && d(out[j]!) > dk) {
      out[j + 1] = out[j]!;
      j--;
    }
    out[j + 1] = k;
  }
  return out;
}

/**
 * Bake cache key: map identity (id, generator version, layout hash), chunk and resolution. Two
 * different generator outputs can never share a key, which is what makes a persistent cache
 * (IndexedDB, a future CDN of pre-baked chunks) safe.
 */
export function bakeKey(map: Pick<MapData, "id" | "genVersion">, layoutHash: string, cx: number, cy: number, res: number): string {
  return `${map.id}@${map.genVersion}#${layoutHash}/${cx},${cy}x${res}`;
}

/**
 * Least-recently-used set of chunk slots. Map insertion order is the recency order; `touch` moves
 * a key to the newest end. Eviction skips pinned (visible) keys, so a visible chunk is never
 * thrown away to make room for a prefetch.
 */
export class ChunkLRU<V> {
  private readonly map = new Map<number, V>();
  constructor(readonly capacity: number) {}

  get size(): number {
    return this.map.size;
  }

  has(k: number): boolean {
    return this.map.has(k);
  }

  /** Read and mark as most recently used. */
  get(k: number): V | undefined {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }

  peek(k: number): V | undefined {
    return this.map.get(k);
  }

  touch(k: number): void {
    this.get(k);
  }

  set(k: number, v: V): void {
    this.map.delete(k);
    this.map.set(k, v);
  }

  delete(k: number): V | undefined {
    const v = this.map.get(k);
    this.map.delete(k);
    return v;
  }

  /** Oldest key that is not pinned, or undefined when every entry is pinned. */
  victim(pinned: (k: number) => boolean): number | undefined {
    for (const k of this.map.keys()) if (!pinned(k)) return k;
    return undefined;
  }

  keys(): IterableIterator<number> {
    return this.map.keys();
  }

  values(): IterableIterator<V> {
    return this.map.values();
  }

  /** Oldest → newest. */
  entries(): IterableIterator<[number, V]> {
    return this.map.entries();
  }
}

/**
 * Which chunk to bake next: the first missing visible chunk (they come nearest-first), else the
 * first missing prefetch chunk — but a prefetch never evicts a chunk that is visible or itself
 * wanted, and never runs when the cache is full of wanted chunks (no thrash). -1 = nothing to do.
 */
export function nextBake(
  visible: readonly number[],
  prefetch: readonly number[],
  cached: (k: number) => boolean,
  size: number,
  capacity: number,
  victim: (pinned: (k: number) => boolean) => number | undefined,
): number {
  for (const k of visible) if (!cached(k)) return k;
  for (const k of prefetch) {
    if (cached(k)) continue;
    if (size < capacity) return k;
    const wanted = (q: number) => visible.includes(q) || prefetch.includes(q);
    return victim(wanted) === undefined ? -1 : k;
  }
  return -1;
}

/**
 * The chunk cache policy, renderer-free (so tests can drive it frame by frame): which chunks are
 * visible, which to prefetch, which to bake next, which slot to recycle. GroundChunks plugs the
 * Pixi RenderTextures in as the slot values.
 */
export class ChunkCache<V> {
  readonly lru: ChunkLRU<V>;
  /** Visible chunk keys, nearest to the player first. */
  readonly visible: number[] = [];
  /** Chunk keys of the prefetch band (view shifted ahead in the movement direction). */
  readonly prefetch: number[] = [];
  private readonly visibleSet = new Set<number>();
  private readonly wantedSet = new Set<number>();

  constructor(
    readonly grid: ChunkGrid,
    capacity: number,
    readonly prefetchPx: number,
  ) {
    this.lru = new ChunkLRU<V>(capacity);
  }

  /** Recompute the visible / prefetch sets for this frame and refresh the visible chunks' recency. */
  plan(view: ViewRect, px: number, py: number, dirX = 0, dirY = 0): void {
    const g = this.grid;
    chunksInRect(g, view.x0, view.y0, view.x1, view.y1, px, py, this.visible);
    const len = Math.hypot(dirX, dirY);
    if (len > 0.01) {
      const ax = (dirX / len) * this.prefetchPx;
      const ay = (dirY / len) * this.prefetchPx;
      chunksInRect(g, view.x0 + ax, view.y0 + ay, view.x1 + ax, view.y1 + ay, px + ax, py + ay, this.prefetch);
    } else this.prefetch.length = 0;
    this.visibleSet.clear();
    this.wantedSet.clear();
    for (const k of this.visible) {
      this.visibleSet.add(k);
      this.wantedSet.add(k);
      this.lru.touch(k);
    }
    for (const k of this.prefetch) this.wantedSet.add(k);
  }

  isVisible(k: number): boolean {
    return this.visibleSet.has(k);
  }

  /** Next chunk to bake (see nextBake), or -1. */
  next(): number {
    return nextBake(
      this.visible,
      this.prefetch,
      (q) => this.lru.has(q),
      this.lru.size,
      this.lru.capacity,
      (pin) => this.lru.victim(pin),
    );
  }

  /**
   * Make room for one bake: when full, evict the oldest chunk nobody wants (else the oldest
   * invisible one) and return its slot for reuse; undefined when there was free capacity (or
   * everything is visible — the cache then grows past capacity rather than show a hole).
   */
  evict(): V | undefined {
    if (this.lru.size < this.lru.capacity) return undefined;
    const k = this.lru.victim((q) => this.wantedSet.has(q)) ?? this.lru.victim((q) => this.visibleSet.has(q));
    return k === undefined ? undefined : this.lru.delete(k);
  }

  put(k: number, v: V): void {
    this.lru.set(k, v);
  }

  /** Visible chunks that are not baked yet (shown as the overview fallback). */
  missingVisible(): number {
    let n = 0;
    for (const k of this.visible) if (!this.lru.has(k)) n++;
    return n;
  }
}

/** Static objects touching each chunk (grown by a margin covering outlines, shadows, overdraw). */
export interface ChunkBuckets {
  rects: number[][];
  circles: number[][];
  decals: number[][];
  buildings: number[][];
}

/** Outlines, shadow offsets and sprite overdraw reach ≤ ~110 px past a solid (tree canopy shadow). */
export const BUCKET_MARGIN = 160;

function bucketBoxes(
  g: ChunkGrid,
  n: number,
  box: (i: number, out: Rect) => void,
  margin: number,
): number[][] {
  const out: number[][] = Array.from({ length: g.cols * g.rows }, () => []);
  const r: Rect = { x: 0, y: 0, w: 0, h: 0 };
  for (let i = 0; i < n; i++) {
    box(i, r);
    const s = chunkSpan(g, r.x - margin, r.y - margin, r.x + r.w + margin, r.y + r.h + margin);
    for (let cy = s.cy0; cy <= s.cy1; cy++) for (let cx = s.cx0; cx <= s.cx1; cx++) out[chunkKey(g, cx, cy)]!.push(i);
  }
  return out;
}

/** Built once per map (~6k objects, a few ms); bakes then read their chunk's lists. */
export function buildChunkBuckets(map: MapData, g: ChunkGrid, margin = BUCKET_MARGIN): ChunkBuckets {
  const setRect = (out: Rect, x: number, y: number, w: number, h: number) => {
    out.x = x;
    out.y = y;
    out.w = w;
    out.h = h;
  };
  return {
    rects: bucketBoxes(g, map.rects.length, (i, o) => {
      const r = map.rects[i]!;
      setRect(o, r.x, r.y, r.w, r.h);
    }, margin),
    circles: bucketBoxes(g, map.circles.length, (i, o) => {
      const c = map.circles[i]!;
      setRect(o, c.x - c.r, c.y - c.r, 2 * c.r, 2 * c.r);
    }, margin),
    decals: bucketBoxes(g, map.decals.length, (i, o) => {
      const d = map.decals[i]!;
      setRect(o, d.x - d.r, d.y - d.r, 2 * d.r, 2 * d.r);
    }, margin),
    buildings: bucketBoxes(g, map.buildings.length, (i, o) => {
      const f = map.buildings[i]!.floor;
      setRect(o, f.x, f.y, f.w, f.h);
    }, margin),
  };
}

/** Deterministic 0..1 from integer coordinates (prop rotation / flip / colour variety). */
export function propHash(x: number, y: number, salt = 0): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(salt | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 0x1_0000_0000;
}

// ---------------------------------------------------------------------------------------------
// Pixi: generated helper textures
// ---------------------------------------------------------------------------------------------

/** Small textures drawn once per world (soft shadows, tree trunk): owned by the baker. */
export interface BakeTextures {
  /** White radial blob, alpha 1 → 0: circle shadows (tint black). */
  softDisc: Texture;
  /** White rounded rect with a SOFT_EDGE px soft border: 9-slice rect shadows. */
  softRect: Texture;
  /** Tree trunk (anti-aliased, outlined) — Pixi Graphics in a non-MSAA RenderTexture alias. */
  trunk: Texture;
}

const SOFT_EDGE = 24;

/** A texture over a canvas, outside Pixi's global Cache (destroyed with its owner). */
function canvasTexture(c: HTMLCanvasElement): Texture {
  return new Texture({ source: new CanvasSource({ resource: c, scaleMode: "linear" }) });
}

export function makeBakeTextures(): BakeTextures {
  const disc = document.createElement("canvas");
  disc.width = disc.height = 64;
  const d = disc.getContext("2d")!;
  const gr = d.createRadialGradient(32, 32, 6, 32, 32, 32);
  gr.addColorStop(0, "rgba(255,255,255,1)");
  gr.addColorStop(1, "rgba(255,255,255,0)");
  d.fillStyle = gr;
  d.fillRect(0, 0, 64, 64);

  const rect = document.createElement("canvas");
  rect.width = rect.height = SOFT_EDGE * 2 + 8;
  const r = rect.getContext("2d")!;
  r.filter = "none";
  // Soft border via stacked translucent insets (no ctx.filter: Safari < 18 lacks it).
  for (let i = 0; i < SOFT_EDGE; i++) {
    r.fillStyle = `rgba(255,255,255,${1 / SOFT_EDGE})`;
    r.beginPath();
    r.roundRect(i, i, rect.width - 2 * i, rect.height - 2 * i, Math.max(2, SOFT_EDGE - i));
    r.fill();
  }

  const trunk = document.createElement("canvas");
  trunk.width = trunk.height = 64;
  const t = trunk.getContext("2d")!;
  t.beginPath();
  t.arc(32, 32, 28, 0, Math.PI * 2);
  t.fillStyle = "#6b4423";
  t.fill();
  t.lineWidth = 5;
  t.strokeStyle = "#3a2716";
  t.stroke();
  t.beginPath();
  t.arc(32, 32, 15, 0, Math.PI * 2);
  t.lineWidth = 2.5;
  t.strokeStyle = "rgba(58,39,22,0.55)";
  t.stroke();
  t.beginPath();
  t.arc(32, 32, 6, 0, Math.PI * 2);
  t.fillStyle = "rgba(58,39,22,0.5)";
  t.fill();
  return { softDisc: canvasTexture(disc), softRect: canvasTexture(rect), trunk: canvasTexture(trunk) };
}

// ---------------------------------------------------------------------------------------------
// Pixi: drawing static solids into a bake
// ---------------------------------------------------------------------------------------------

const SHADOW_ALPHA = 0.24;
const SHADOW_DX = 6;
const SHADOW_DY = 9;

function discShadow(bt: BakeTextures, x: number, y: number, r: number, alpha = SHADOW_ALPHA): Sprite {
  const s = new Sprite(bt.softDisc);
  s.anchor.set(0.5);
  s.position.set(x, y);
  s.width = s.height = r * 2.3;
  s.tint = 0x000000;
  s.alpha = alpha;
  return s;
}

function rectShadow(bt: BakeTextures, r: Rect, alpha = SHADOW_ALPHA): NineSliceSprite {
  const s = new NineSliceSprite({
    texture: bt.softRect,
    leftWidth: SOFT_EDGE,
    rightWidth: SOFT_EDGE,
    topHeight: SOFT_EDGE,
    bottomHeight: SOFT_EDGE,
  });
  const pad = 10;
  s.position.set(r.x - pad + SHADOW_DX, r.y - pad + SHADOW_DY);
  s.width = r.w + pad * 2;
  s.height = r.h + pad * 2;
  s.tint = 0x000000;
  s.alpha = alpha;
  return s;
}

/**
 * A prop sprite whose opaque content box (SPRITE_CONTENT) covers rect `r` grown by `pad`. Vertical
 * props (MapRect.o = 1) are the horizontal art rotated 90°. `flip` mirrors along the long axis.
 */
export function propSprite(
  texture: Texture,
  name: SpriteName,
  r: Rect,
  vertical: boolean,
  pad: number,
  flip = false,
): Sprite {
  const s = new Sprite(texture);
  const tw = texture.width || 1;
  const th = texture.height || 1;
  const c = SPRITE_CONTENT[name] ?? { x: 0, y: 0, w: tw, h: th };
  const along = vertical ? r.h : r.w;
  const across = vertical ? r.w : r.h;
  s.anchor.set((c.x + c.w / 2) / tw, (c.y + c.h / 2) / th);
  s.scale.set(((along + 2 * pad) / c.w) * (flip ? -1 : 1), (across + 2 * pad) / c.h);
  s.rotation = vertical ? Math.PI / 2 : 0;
  s.position.set(r.x + r.w / 2, r.y + r.h / 2);
  return s;
}

/**
 * Walls in the cartoon style: thick dark outline, warm fill, lighter top edge. Outlines for the
 * whole set are drawn first and fills second, so walls meeting at a corner merge into one shape.
 */
export function drawWallSet(g: Graphics, walls: readonly Rect[], fill: number, highlight: number) {
  if (walls.length === 0) return;
  const O = 4;
  for (const w of walls) g.rect(w.x + 5, w.y + 7, w.w, w.h);
  g.fill({ color: COLORS.shadow, alpha: 0.25 });
  for (const w of walls) g.roundRect(w.x - O, w.y - O, w.w + 2 * O, w.h + 2 * O, 4);
  g.fill({ color: COLORS.wallOutline });
  for (const w of walls) g.rect(w.x, w.y, w.w, w.h);
  g.fill({ color: fill });
  for (const w of walls) {
    if (w.w >= w.h) g.rect(w.x + 3, w.y + 3, w.w - 6, Math.min(6, w.h / 3));
    else g.rect(w.x + 3, w.y + 3, Math.min(6, w.w / 3), w.h - 6);
  }
  g.fill({ color: highlight, alpha: 0.8 });
}

/** Windows: wall-coloured frame with a pale glass pane and a mullion (see-through, not walkable). */
function drawWindows(g: Graphics, wins: readonly Rect[]) {
  if (wins.length === 0) return;
  for (const w of wins) g.rect(w.x - 3, w.y - 3, w.w + 6, w.h + 6);
  g.fill({ color: COLORS.wallOutline });
  for (const w of wins) g.rect(w.x, w.y, w.w, w.h);
  g.fill({ color: COLORS.wallFill });
  for (const w of wins) {
    const horiz = w.w >= w.h;
    if (horiz) g.rect(w.x + 6, w.y + w.h / 2 - 4, w.w - 12, 8);
    else g.rect(w.x + w.w / 2 - 4, w.y + 6, 8, w.h - 12);
  }
  g.fill({ color: 0xa9dcef, alpha: 0.95 });
  for (const w of wins) {
    if (w.w >= w.h) g.rect(w.x + w.w / 2 - 2, w.y + 2, 4, w.h - 4);
    else g.rect(w.x + 2, w.y + w.h / 2 - 2, w.w - 4, 4);
  }
  g.fill({ color: COLORS.wallOutline });
}

const CONCRETE_FILL = 0x9a9d98;
const CONCRETE_HI = 0xc3c6bf;
const WAGON_COLORS = [0x8c3b2a, 0x3c5a78, 0x4f6b3a, 0x7a5a32] as const;

/** Freight wagon (640 × 144): coloured box, darker roof ribs, door outline. */
function drawWagon(g: Graphics, r: MapRect) {
  const color = WAGON_COLORS[Math.floor(propHash(r.x, r.y, 3) * WAGON_COLORS.length)]!;
  const vertical = r.h > r.w;
  g.roundRect(r.x - 4, r.y - 4, r.w + 8, r.h + 8, 8).fill({ color: COLORS.wallOutline });
  g.roundRect(r.x, r.y, r.w, r.h, 5).fill({ color });
  const along = vertical ? r.h : r.w;
  const ribs = Math.floor(along / 40);
  for (let i = 1; i < ribs; i++) {
    const t = (i * along) / ribs;
    if (vertical) g.rect(r.x + 4, r.y + t - 2, r.w - 8, 4);
    else g.rect(r.x + t - 2, r.y + 4, 4, r.h - 8);
  }
  g.fill({ color: 0x000000, alpha: 0.22 });
  // Roof walkway down the middle.
  if (vertical) g.rect(r.x + r.w / 2 - 8, r.y + 10, 16, r.h - 20);
  else g.rect(r.x + 10, r.y + r.h / 2 - 8, r.w - 20, 16);
  g.fill({ color: 0xffffff, alpha: 0.12 });
}

/** Warehouse shelf rack: metal frame, wooden boards, a few coloured boxes. */
function drawShelf(g: Graphics, r: MapRect) {
  g.rect(r.x - 3, r.y - 3, r.w + 6, r.h + 6).fill({ color: 0x2b2f36 });
  g.rect(r.x, r.y, r.w, r.h).fill({ color: 0x8a6a44 });
  const vertical = r.h > r.w;
  const along = vertical ? r.h : r.w;
  const across = vertical ? r.w : r.h;
  const posts = Math.max(2, Math.round(along / 96) + 1);
  for (let i = 0; i < posts; i++) {
    const t = Math.min(along - 6, (i * (along - 6)) / (posts - 1));
    if (vertical) g.rect(r.x, r.y + t, r.w, 6);
    else g.rect(r.x + t, r.y, 6, r.h);
  }
  g.fill({ color: 0x4a515c });
  const boxColors = [0xc49a5c, 0x7a8c5a, 0xb05a3c, 0x5c7aa0];
  const n = Math.floor(along / 44);
  for (let i = 0; i < n; i++) {
    if (propHash(r.x + i, r.y, 7) < 0.35) continue;
    const size = across * (0.5 + propHash(r.x, r.y + i, 9) * 0.3);
    const t = 10 + i * 44;
    const off = (across - size) / 2;
    if (vertical) g.rect(r.x + off, r.y + t, size, size);
    else g.rect(r.x + t, r.y + off, size, size);
    g.fill({ color: boxColors[i % boxColors.length]! }).stroke({ width: 2, color: 0x2b1d10, alpha: 0.8 });
  }
}

/** Ground footprint of a watchtower (its roof is drawn live in the canopy layer). */
function drawTowerBase(g: Graphics, r: MapRect) {
  const p = 18;
  for (const [x, y] of [[r.x, r.y], [r.x + r.w - p, r.y], [r.x, r.y + r.h - p], [r.x + r.w - p, r.y + r.h - p]] as const) {
    g.rect(x, y, p, p);
  }
  g.fill({ color: 0x5a3e24 }).stroke({ width: 3, color: COLORS.wallOutline });
}

/** Base ring of a silo (its top is drawn live in the canopy layer). */
function drawSiloBase(g: Graphics, c: MapCircle) {
  g.circle(c.x, c.y, c.r + 6).fill({ color: 0x6f716c });
  g.circle(c.x, c.y, c.r + 6).stroke({ width: 4, color: 0x2e2f2c });
}

/** Everything static of one chunk, as Pixi objects in world coordinates (destroyed after the bake). */
export function buildChunkProps(
  map: MapData,
  tex: Textures,
  bt: BakeTextures,
  rectIds: readonly number[],
  circleIds: readonly number[],
  decalIds: readonly number[],
): Container {
  const root = new Container();
  const shadows = new Container();
  const decals = new Container();
  const low = new Container();
  const procedural = new Graphics();
  const walls = new Graphics();
  root.addChild(shadows, decals, procedural, low, walls);

  for (const i of decalIds) {
    const d: Decal = map.decals[i]!;
    if (d.k !== "puddle") continue;
    const s = propSprite(tex.puddle, "puddle", { x: d.x - d.r, y: d.y - d.r, w: 2 * d.r, h: 2 * d.r }, false, 0, propHash(d.x, d.y) < 0.5);
    s.rotation = propHash(d.x, d.y, 1) * Math.PI * 2;
    s.alpha = 0.92;
    decals.addChild(s);
  }

  const border: MapRect[] = [];
  const wallList: MapRect[] = [];
  const concrete: MapRect[] = [];
  const windows: MapRect[] = [];
  for (const i of rectIds) {
    const r = map.rects[i]!;
    const vertical = r.o === 1 || (r.o === undefined && r.h > r.w);
    const flip = propHash(r.x, r.y) < 0.5;
    switch (r.k) {
      case "border":
        border.push(r);
        break;
      case "wall":
        wallList.push(r);
        break;
      case "window":
        windows.push(r);
        break;
      case "concrete_wall":
        concrete.push(r);
        break;
      case "water":
        break; // terrain draws the river; water runs are only collision
      case "crate":
        shadows.addChild(rectShadow(bt, r));
        low.addChild(propSprite(tex.crate, "crate", r, false, 2));
        break;
      case "car":
        shadows.addChild(rectShadow(bt, r));
        low.addChild(propSprite(tex.car_wreck, "car_wreck", r, vertical, 3, flip));
        break;
      case "ship_container":
        shadows.addChild(rectShadow(bt, r, 0.3));
        low.addChild(propSprite(tex.shipping_container, "shipping_container", r, vertical, 2, flip));
        break;
      case "sandbags":
        // Map sandbags are straight rect runs: the straight art. The curved `sandbags` sprite stays
        // loaded for arc-shaped placements (none in the current generator).
        shadows.addChild(rectShadow(bt, r, 0.2));
        low.addChild(propSprite(tex.sandbags_straight, "sandbags_straight", r, vertical, 6, flip));
        break;
      case "fence": {
        // Chain-link segments along the fence, posts at both ends of each.
        const along = vertical ? r.h : r.w;
        const n = Math.max(1, Math.round(along / 170));
        const seg = along / n;
        for (let k = 0; k < n; k++) {
          const sr: Rect = vertical
            ? { x: r.x, y: r.y + k * seg, w: r.w, h: seg }
            : { x: r.x + k * seg, y: r.y, w: seg, h: r.h };
          low.addChild(propSprite(tex.fence, "fence", sr, vertical, 4));
        }
        break;
      }
      case "logpile": {
        shadows.addChild(rectShadow(bt, r));
        const along = vertical ? r.h : r.w;
        const across = vertical ? r.w : r.h;
        const n = Math.max(1, Math.round(along / across));
        const seg = along / n;
        for (let k = 0; k < n; k++) {
          const sr: Rect = vertical
            ? { x: r.x, y: r.y + k * seg, w: r.w, h: seg }
            : { x: r.x + k * seg, y: r.y, w: seg, h: r.h };
          // The art is a round stack of log ends: never rotate it, just fit each piece.
          low.addChild(propSprite(tex.log_pile, "log_pile", sr, false, 6, propHash(sr.x, sr.y) < 0.5));
        }
        break;
      }
      case "wagon":
        shadows.addChild(rectShadow(bt, r, 0.3));
        drawWagon(procedural, r);
        break;
      case "shelf":
        drawShelf(procedural, r);
        break;
      case "watchtower":
        shadows.addChild(rectShadow(bt, { x: r.x + 10, y: r.y + 14, w: r.w, h: r.h }, 0.3));
        drawTowerBase(procedural, r);
        break;
      case "silo":
        break; // silos are circles
    }
  }

  for (const i of circleIds) {
    const c = map.circles[i]!;
    switch (c.k) {
      case "tree": {
        // Canopy shadow is static: bake it; the canopy itself is live (canopy.ts).
        shadows.addChild(discShadow(bt, c.x + 12, c.y + 16, c.r * 2.6 * 0.9, 0.2));
        const s = new Sprite(bt.trunk);
        s.anchor.set(0.5);
        s.position.set(c.x, c.y);
        s.width = s.height = c.r * 2 + 6;
        s.rotation = propHash(c.x, c.y) * Math.PI * 2;
        low.addChild(s);
        break;
      }
      case "rock": {
        shadows.addChild(discShadow(bt, c.x + 6, c.y + 8, c.r));
        const size = c.r * 2 * 1.08;
        const s = new Sprite(tex.rock);
        s.anchor.set(0.5);
        s.position.set(c.x, c.y);
        s.width = s.height = size;
        s.rotation = propHash(c.x, c.y, 2) * Math.PI * 2;
        low.addChild(s);
        break;
      }
      case "barrel": {
        shadows.addChild(discShadow(bt, c.x + 4, c.y + 6, c.r));
        const s = propSprite(tex.barrel, "barrel", { x: c.x - c.r, y: c.y - c.r, w: 2 * c.r, h: 2 * c.r }, false, 2);
        s.rotation = propHash(c.x, c.y, 4) * Math.PI * 2;
        low.addChild(s);
        break;
      }
      case "silo":
        shadows.addChild(discShadow(bt, c.x + 18, c.y + 26, c.r * 1.05, 0.32));
        drawSiloBase(procedural, c);
        break;
    }
  }

  drawWallSet(walls, border, COLORS.borderFill, COLORS.borderHighlight);
  drawWallSet(walls, concrete, CONCRETE_FILL, CONCRETE_HI);
  drawWallSet(walls, wallList, COLORS.wallFill, COLORS.wallHighlight);
  drawWindows(walls, windows);
  return root;
}

// ---------------------------------------------------------------------------------------------
// Pixi: the chunk cache
// ---------------------------------------------------------------------------------------------

/** View rectangle in world units (already padded by the caller). */
export interface ViewRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface GroundChunksOptions {
  /** Cached chunk textures (map memo: 16 × 4 MB at resolution 1). */
  lruSize?: number;
  /** Chunk texture pixels per world px (memo fallbacks: 0.75, 0.5). */
  resolution?: number;
  maxBakesPerFrame?: number;
  /** How far ahead (world px) to prefetch in the movement direction. */
  prefetchPx?: number;
  /** Map overview texture shown under chunks that are not baked yet (null = background colour). */
  fallback?: Texture | null;
}

interface Slot {
  key: number;
  rt: RenderTexture;
  sprite: Sprite;
}

export interface ChunkStats {
  cached: number;
  bakes: number;
  lastBakeMs: number;
  /** Split of the last bake: ground build (incl. masks) / prop build / render submit. */
  lastPaintMs: number;
  /** Part of lastPaintMs spent computing kind masks in JS. */
  lastMaskMs: number;
  lastPropsMs: number;
  lastRenderMs: number;
  maxBakeMs: number;
  avgBakeMs: number;
  visible: number;
  missingVisible: number;
}

export class GroundChunks {
  /** Fallback overview + chunk sprites, world coordinates. */
  readonly root = new Container();
  readonly grid: ChunkGrid;
  readonly buckets: ChunkBuckets;
  readonly layoutHash: string;
  private readonly cache: ChunkCache<Slot>;
  private readonly free: Slot[] = [];
  private readonly res: number;
  private readonly maxBakes: number;
  private readonly ground: GroundBuilder;
  private readonly ownedTiles: Texture[];
  private readonly scene = new Container();
  private readonly bt: BakeTextures;
  private readonly fallback: Sprite | null;
  private readonly matrix = new Matrix();
  private stat = { bakes: 0, totalMs: 0, lastMs: 0, maxMs: 0, paintMs: 0, propsMs: 0, renderMs: 0 };
  private destroyed = false;
  private prewarmed = false;
  private readonly contextListener = {
    contextChange: () => {
      // The first emit happens at renderer init, before this object exists; any later one is a
      // restore after a context loss.
      if (this.destroyed) return;
      this.invalidate();
      this.prewarmed = false;
    },
  };

  constructor(
    readonly map: MapData,
    private readonly tex: Textures,
    private readonly renderer: Renderer,
    opts: GroundChunksOptions = {},
  ) {
    this.grid = chunkGridOf(map);
    this.buckets = buildChunkBuckets(map, this.grid);
    this.layoutHash = mapHash(map);
    this.res = opts.resolution ?? 1;
    this.maxBakes = opts.maxBakesPerFrame ?? 1;
    this.cache = new ChunkCache<Slot>(this.grid, opts.lruSize ?? 16, opts.prefetchPx ?? 640);
    this.bt = makeBakeTextures();
    const { tiles, owned } = makeTileTextures(tex);
    this.ownedTiles = owned;
    this.ground = new GroundBuilder(map, tiles, this.bt.softDisc, this.grid.chunk);
    this.root.eventMode = "none";
    this.root.interactiveChildren = false;
    // A lost/restored WebGL context empties every RenderTexture: re-bake on demand (the overview
    // fallback covers the gap). Runner items are called by method name.
    this.renderer.runners.contextChange?.add(this.contextListener);
    if (opts.fallback) {
      this.fallback = new Sprite(opts.fallback);
      this.fallback.width = map.width;
      this.fallback.height = map.height;
      this.root.addChild(this.fallback);
    } else this.fallback = null;
  }

  /** Bake key of a chunk (for debugging / a persistent cache). */
  key(cx: number, cy: number): string {
    return bakeKey(this.map, this.layoutHash, cx, cy, this.res);
  }

  /**
   * Per frame: show the chunks under `view`, bake at most `maxBakesPerFrame` missing ones (visible
   * first, then the prefetch band `dirX/dirY` ahead). `px/py` = the player or camera position.
   */
  update(view: ViewRect, px: number, py: number, dirX = 0, dirY = 0): void {
    if (this.destroyed) return;
    const c = this.cache;
    c.plan(view, px, py, dirX, dirY);
    for (const s of c.lru.values()) s.sprite.visible = c.isVisible(s.key);
    for (let n = 0; n < this.maxBakes; n++) {
      const k = c.next();
      if (k < 0) break;
      this.bakeKeyNow(k);
    }
  }

  /**
   * Upload every texture a bake can use and compile every pipeline it needs (sprite, tiling,
   * alpha mask, nine-slice, textured graphics) by rendering one of each into a 4 × 4 target.
   * Without it the first bake that meets a new prop pays the upload + mipmap + shader compile —
   * measured as a 25–30 ms hitch mid-run.
   */
  prewarm(): void {
    if (this.prewarmed || this.destroyed) return;
    this.prewarmed = true;
    const c = new Container();
    const all = new Set<Texture>([...Object.values(this.tex), ...this.ownedTiles, this.bt.softDisc, this.bt.softRect, this.bt.trunk]);
    for (const t of all) {
      if (t === Texture.EMPTY || t.destroyed) continue;
      const s = new Sprite(t);
      s.width = s.height = 4;
      c.addChild(s);
    }
    const r = { x: 0, y: 0, w: 4, h: 4 };
    c.addChild(rectShadow(this.bt, r));
    const g = new Graphics().rect(0, 0, 4, 4).fill({ color: 0xffffff, texture: this.tex.asphalt_tile, textureSpace: "global" });
    c.addChild(g, this.ground.build(0, 0, { buildings: [], decals: [] }));
    const rt = RenderTexture.create({ width: 4, height: 4 });
    this.renderer.render({ container: c, target: rt, clear: true });
    c.removeChild(this.ground.root);
    c.destroy({ children: true });
    rt.destroy(true);
  }

  /** Bake every chunk overlapping `view` now (loading screen: no fallback flash on spawn). */
  warmup(view: ViewRect, px: number, py: number): void {
    if (this.destroyed) return;
    this.prewarm();
    const c = this.cache;
    c.plan(view, px, py);
    for (const k of [...c.visible]) if (!c.lru.has(k)) this.bakeKeyNow(k);
    for (const s of c.lru.values()) s.sprite.visible = c.isVisible(s.key);
  }

  private bakeKeyNow(k: number) {
    let slot = this.cache.evict() ?? this.free.pop();
    if (!slot) {
      const rt = RenderTexture.create({ width: this.grid.chunk, height: this.grid.chunk, resolution: this.res });
      const sprite = new Sprite(rt);
      sprite.width = sprite.height = this.grid.chunk;
      this.root.addChild(sprite);
      slot = { key: -1, rt, sprite };
    }
    slot.key = k;
    const { cx, cy } = chunkXY(this.grid, k);
    this.bake(cx, cy, slot.rt);
    slot.sprite.position.set(cx * this.grid.chunk, cy * this.grid.chunk);
    slot.sprite.visible = this.cache.isVisible(k);
    this.cache.put(k, slot);
  }

  private bake(cx: number, cy: number, rt: RenderTexture) {
    const t0 = performance.now();
    const k = chunkKey(this.grid, cx, cy);
    const x0 = cx * this.grid.chunk;
    const y0 = cy * this.grid.chunk;
    const ground = this.ground.build(cx, cy, { buildings: this.buckets.buildings[k]!, decals: this.buckets.decals[k]! });
    const t1 = performance.now();
    const props = buildChunkProps(this.map, this.tex, this.bt, this.buckets.rects[k]!, this.buckets.circles[k]!, this.buckets.decals[k]!);
    this.scene.addChild(ground, props);
    const t2 = performance.now();
    this.matrix.set(1, 0, 0, 1, -x0, -y0);
    this.renderer.render({ container: this.scene, target: rt, clear: true, transform: this.matrix });
    this.scene.removeChildren();
    props.destroy({ children: true });
    const t3 = performance.now();
    const ms = t3 - t0;
    this.stat.paintMs = t1 - t0;
    this.stat.propsMs = t2 - t1;
    this.stat.renderMs = t3 - t2;
    this.stat.bakes++;
    this.stat.totalMs += ms;
    this.stat.lastMs = ms;
    this.stat.maxMs = Math.max(this.stat.maxMs, ms);
  }

  stats(): ChunkStats {
    return {
      cached: this.cache.lru.size,
      bakes: this.stat.bakes,
      lastBakeMs: this.stat.lastMs,
      lastPaintMs: this.stat.paintMs,
      lastMaskMs: this.ground.lastMaskMs,
      lastPropsMs: this.stat.propsMs,
      lastRenderMs: this.stat.renderMs,
      maxBakeMs: this.stat.maxMs,
      avgBakeMs: this.stat.bakes ? this.stat.totalMs / this.stat.bakes : 0,
      visible: this.cache.visible.length,
      missingVisible: this.cache.missingVisible(),
    };
  }

  /** Drop every cached chunk (e.g. after a resolution change); they re-bake on demand. */
  invalidate(): void {
    const lru = this.cache.lru;
    for (const s of lru.values()) {
      s.sprite.visible = false;
      this.free.push(s);
    }
    for (const k of [...lru.keys()]) lru.delete(k);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.renderer.runners.contextChange?.remove(this.contextListener);
    this.invalidate();
    for (const s of this.free) s.rt.destroy(true);
    this.free.length = 0;
    this.root.destroy({ children: true });
    this.ground.destroy();
    this.scene.destroy();
    for (const t of this.ownedTiles) t.destroy(true);
    this.bt.softDisc.destroy(true);
    this.bt.softRect.destroy(true);
    this.bt.trunk.destroy(true);
  }
}
