/**
 * Ground terrain for the chunked world (WP-M3): which tile each 64 px terrain cell shows, the soft
 * blend masks between kinds, the procedural tiles for kinds without a sprite, and the canvas
 * painter that turns one 1024 px chunk of MapData.terrain into ground pixels.
 *
 * Everything is drawn on the GPU inside the chunk bake: one world-aligned TilingSprite per kind,
 * masked by a tiny per-kind coverage texture (20 × 20 cells at 8 px per cell, computed here in JS).
 * Sprite masks cost an extra pass each — that is what made v1 GPU-bound when it ran EVERY frame
 * over the whole map, but here it runs once per chunk bake (≤ 1 per frame) over 1024², ~0.1 ms.
 * (A 2D-canvas version measured 15–25 ms per bake: canvas → GL uploads stall the pipeline.)
 *
 * The mask math is pure (node-testable) and uses only global coordinates, so two neighbouring
 * chunks compute identical mask values along their shared edge — no seams.
 */

import {
  TERRAIN,
  TERRAIN_INDOOR,
  TERRAIN_KIND_MASK,
  mulberry32,
  type Decal,
  type MapData,
  type Terrain,
} from "@extract/shared";
import {
  BufferImageSource,
  CanvasSource,
  Container,
  Graphics,
  Matrix,
  Sprite,
  Texture,
  TilingSprite,
} from "pixi.js";
import type { SpriteName, Textures } from "./assets";

/** Mask pixels per terrain cell (64 px cells → one mask px = 8 world px, bilinear-upscaled). */
export const MASK_RES = 8;
/** Terrain cells of context around a chunk for the mask: covers blur + noise + dilation reach. */
export const MASK_RING = 2;

/**
 * How a kind's edge looks. `blur` (mask px) softens the 64 px cell staircase, `noise` (0..1)
 * wobbles it, and smoothstep(lo, hi) re-sharpens the blurred ramp into a clean organic edge.
 * Invariant (tested): noise / 2 ≤ lo and noise / 2 ≤ 1 − hi, so cells far from any edge stay
 * exactly 0 or 1 and the expensive noise is only evaluated on the edge band.
 */
export interface EdgeStyle {
  blur: number;
  noise: number;
  lo: number;
  hi: number;
}

/** Natural ground (forest, dirt): wide wobbly edge. */
const SOFT: EdgeStyle = { blur: 3, noise: 0.5, lo: 0.38, hi: 0.62 };
/** Gravel, asphalt: rounded staircase, a little wear. */
const MEDIUM: EdgeStyle = { blur: 2, noise: 0.24, lo: 0.36, hi: 0.64 };
/** Water: must match the cell-aligned collision closely (MOVE solids are cell runs). */
const TIGHT: EdgeStyle = { blur: 1, noise: 0.1, lo: 0.4, hi: 0.6 };
/** Man-made pads and planks: the cell edge itself, only softened by the bilinear upscale. */
const HARD: EdgeStyle = { blur: 0, noise: 0, lo: 0.5, hi: 0.5 };

export interface GroundLayer {
  kind: Terrain;
  edge: EdgeStyle;
}

/** Drawn first over the whole chunk; every other kind is layered on top of it. */
export const GROUND_BASE: Terrain = TERRAIN.GRASS;

/**
 * Paint order (bottom → top). Roads (asphalt strokes) go in between gravel and asphalt cells, and
 * water comes after them so a road polyline can never paint over a river cell. Wood is only
 * indoors (floors are drawn from Building.floor), kept as a layer for safety.
 */
export const GROUND_LAYERS: readonly GroundLayer[] = [
  { kind: TERRAIN.FOREST, edge: SOFT },
  { kind: TERRAIN.DIRT, edge: SOFT },
  { kind: TERRAIN.GRAVEL, edge: MEDIUM },
  { kind: TERRAIN.ASPHALT, edge: MEDIUM },
  { kind: TERRAIN.CONCRETE, edge: HARD },
  { kind: TERRAIN.WATER, edge: TIGHT },
  { kind: TERRAIN.SHALLOW, edge: TIGHT },
  { kind: TERRAIN.BRIDGE, edge: HARD },
  { kind: TERRAIN.WOOD, edge: HARD },
];

/** Sprite tile per kind (null = procedural, see makeTileImages). */
export const TILE_SPRITE: Record<Terrain, SpriteName | null> = {
  [TERRAIN.GRASS]: "grass_tile",
  [TERRAIN.FOREST]: "forest_tile",
  [TERRAIN.DIRT]: "dirt_plain",
  [TERRAIN.ASPHALT]: "asphalt_tile",
  [TERRAIN.CONCRETE]: "concrete_tile",
  [TERRAIN.WOOD]: "wood_floor_tile",
  [TERRAIN.WATER]: null,
  [TERRAIN.BRIDGE]: null,
  [TERRAIN.GRAVEL]: null,
  [TERRAIN.SHALLOW]: null,
};

/** World px per tile px. Dirt keeps v1's 0.75 so patches look the same as before. */
export const TILE_SCALE: Record<Terrain, number> = {
  [TERRAIN.GRASS]: 1,
  [TERRAIN.FOREST]: 1,
  [TERRAIN.DIRT]: 0.75,
  [TERRAIN.ASPHALT]: 1,
  [TERRAIN.CONCRETE]: 0.75,
  [TERRAIN.WOOD]: 0.75,
  [TERRAIN.WATER]: 1,
  [TERRAIN.BRIDGE]: 1,
  [TERRAIN.GRAVEL]: 1,
  [TERRAIN.SHALLOW]: 1,
};

/** Flat colour per kind: minimap, full map, and the fallback when a sprite failed to load. */
export const TERRAIN_COLOR: Record<Terrain, number> = {
  [TERRAIN.GRASS]: 0x5d9a3c,
  [TERRAIN.FOREST]: 0x2f5a2a,
  [TERRAIN.DIRT]: 0x9a7448,
  [TERRAIN.ASPHALT]: 0x4a4f5a,
  [TERRAIN.CONCRETE]: 0xa3a39c,
  [TERRAIN.WOOD]: 0x7a4f2c,
  [TERRAIN.WATER]: 0x2e6aa3,
  [TERRAIN.BRIDGE]: 0x8a6034,
  [TERRAIN.GRAVEL]: 0x8b8478,
  [TERRAIN.SHALLOW]: 0x5aa0b8,
};

/** Bit set of the kinds painted after `kind` in GROUND_LAYERS. */
export function underBits(kind: Terrain): number {
  const i = GROUND_LAYERS.findIndex((l) => l.kind === kind);
  let bits = 0;
  for (let j = i + 1; j < GROUND_LAYERS.length; j++) bits |= 1 << GROUND_LAYERS[j]!.kind;
  return bits;
}

// ---------------------------------------------------------------------------------------------
// Pure: ground kinds and masks
// ---------------------------------------------------------------------------------------------

const groundCache = new WeakMap<MapData, Uint8Array>();

/**
 * Terrain kinds as the ground shows them: INDOOR cells take the kind of the nearest outdoor cell
 * (BFS), because the floor itself is drawn crisp from Building.floor. Otherwise the cell-snapped
 * floor kind would stick out up to half a cell past the walls. Memoized per MapData.
 */
export function groundKinds(map: MapData): Uint8Array {
  const hit = groundCache.get(map);
  if (hit) return hit;
  const { terrain, terrainCols: cols, terrainRows: rows } = map;
  const out = new Uint8Array(terrain.length);
  const done = new Uint8Array(terrain.length);
  const queue = new Int32Array(terrain.length);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < terrain.length; i++) {
    const b = terrain[i]!;
    if (b & TERRAIN_INDOOR) continue;
    out[i] = b & TERRAIN_KIND_MASK;
    done[i] = 1;
    queue[tail++] = i;
  }
  while (head < tail) {
    const i = queue[head++]!;
    const c = i % cols;
    const r = (i - c) / cols;
    // Fixed neighbour order keeps the fill deterministic.
    const nb = [r > 0 ? i - cols : -1, c < cols - 1 ? i + 1 : -1, r < rows - 1 ? i + cols : -1, c > 0 ? i - 1 : -1];
    for (const j of nb) {
      if (j < 0 || done[j]) continue;
      done[j] = 1;
      out[j] = out[i]!;
      queue[tail++] = j;
    }
  }
  // A map that is indoor everywhere (never in practice) falls back to the raw kinds.
  for (let i = 0; i < out.length; i++) if (!done[i]) out[i] = terrain[i]! & TERRAIN_KIND_MASK;
  groundCache.set(map, out);
  return out;
}

/** A block of terrain cells (may extend past the map: reads clamp to the edge). */
export interface CellRegion {
  c0: number;
  r0: number;
  cols: number;
  rows: number;
}

/** Cell region a chunk's mask needs: the chunk's cells plus MASK_RING on every side. */
export function chunkMaskRegion(cx: number, cy: number, chunk: number, cell: number): CellRegion {
  const per = Math.ceil(chunk / cell);
  return { c0: cx * per - MASK_RING, r0: cy * per - MASK_RING, cols: per + 2 * MASK_RING, rows: per + 2 * MASK_RING };
}

/**
 * Bit sets over kinds (bit = 1 << kind): which kinds appear in the region at all, and which cover
 * every cell (those are filled without a mask).
 */
export function regionKinds(
  kinds: Uint8Array,
  mapCols: number,
  mapRows: number,
  reg: CellRegion,
): { present: number; full: number } {
  let present = 0;
  const counts = new Int32Array(16);
  for (let r = 0; r < reg.rows; r++) {
    const rr = Math.min(mapRows - 1, Math.max(0, reg.r0 + r));
    for (let c = 0; c < reg.cols; c++) {
      const cc = Math.min(mapCols - 1, Math.max(0, reg.c0 + c));
      const k = kinds[rr * mapCols + cc]!;
      present |= 1 << k;
      counts[k]!++;
    }
  }
  let full = 0;
  const total = reg.cols * reg.rows;
  for (let k = 0; k < 16; k++) if (counts[k] === total) full |= 1 << k;
  return { present, full };
}

/** Integer hash → [0, 1). Global coordinates only, so chunks agree on shared edges. */
function hash01(x: number, y: number, salt: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(salt | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 0x1_0000_0000;
}

function valueNoise(x: number, y: number, lattice: number, salt: number): number {
  const fx = x / lattice;
  const fy = y / lattice;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  let tx = fx - ix;
  let ty = fy - iy;
  tx = tx * tx * (3 - 2 * tx);
  ty = ty * ty * (3 - 2 * ty);
  const a = hash01(ix, iy, salt);
  const b = hash01(ix + 1, iy, salt);
  const c = hash01(ix, iy + 1, salt);
  const d = hash01(ix + 1, iy + 1, salt);
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

/** Edge wobble at a global mask pixel, in [0, 1). Two octaves: ~48 px lumps + ~16 px grain. */
export function edgeNoise(gx: number, gy: number, kind: number): number {
  return 0.7 * valueNoise(gx, gy, 6, kind * 7 + 1) + 0.3 * valueNoise(gx, gy, 2, kind * 7 + 2);
}

/** Separable box blur with clamped edges (src → dst along x). */
function boxBlurX(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[row + Math.min(w - 1, Math.max(0, k))]!;
    for (let x = 0; x < w; x++) {
      dst[row + x] = acc / n;
      acc += src[row + Math.min(w - 1, x + r + 1)]! - src[row + Math.max(0, x - r)]!;
    }
  }
}

function boxBlurY(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const n = 2 * r + 1;
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[Math.min(h - 1, Math.max(0, k)) * w + x]!;
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = acc / n;
      acc += src[Math.min(h - 1, y + r + 1) * w + x]! - src[Math.max(0, y - r) * w + x]!;
    }
  }
}

/** Scratch buffers for kindMask (reused across bakes: no per-bake allocation). */
export class MaskScratch {
  a = new Float32Array(0);
  b = new Float32Array(0);
  ensure(n: number) {
    if (this.a.length < n) {
      this.a = new Float32Array(n);
      this.b = new Float32Array(n);
    }
  }
}

/**
 * Coverage mask of one kind over a cell region at MASK_RES px per cell, written as opaque grey RGBA
 * (r = g = b = coverage, a = 255) into `out` (length ≥ w·h·4): Pixi's sprite mask reads the red
 * channel, and an opaque texture is immune to premultiplied-alpha upload differences. `under` =
 * bit set of kinds this layer may extend one cell beneath (the kinds painted after it). Returns the
 * mask size. Pure and deterministic: global mask coordinates drive the noise.
 */
export function kindMask(
  kinds: Uint8Array,
  mapCols: number,
  mapRows: number,
  reg: CellRegion,
  kind: number,
  edge: EdgeStyle,
  out: Uint8Array | Uint8ClampedArray,
  scratch: MaskScratch = new MaskScratch(),
  under = 0,
): { w: number; h: number } {
  const w = reg.cols * MASK_RES;
  const h = reg.rows * MASK_RES;
  scratch.ensure(w * h);
  const a = scratch.a;
  const b = scratch.b;
  const at = (r: number, c: number) =>
    kinds[Math.min(mapRows - 1, Math.max(0, r)) * mapCols + Math.min(mapCols - 1, Math.max(0, c))]!;
  for (let r = 0; r < reg.rows; r++) {
    const rr = reg.r0 + r;
    for (let c = 0; c < reg.cols; c++) {
      const cc = reg.c0 + c;
      const k = at(rr, cc);
      let v = k === kind ? 1 : 0;
      // Extend one cell under kinds painted later (`under`): their soft inner edge then blends
      // into this kind instead of letting the base grass peek through between two soft layers.
      if (!v && under & (1 << k)) {
        for (let dr = -1; dr <= 1 && !v; dr++) for (let dc = -1; dc <= 1; dc++) if (at(rr + dr, cc + dc) === kind) { v = 1; break; }
      }
      for (let y = 0; y < MASK_RES; y++) {
        const row = (r * MASK_RES + y) * w + c * MASK_RES;
        for (let x = 0; x < MASK_RES; x++) a[row + x] = v;
      }
    }
  }
  if (edge.blur > 0) {
    // Two box passes ≈ a tent/gaussian: no visible square corners on the rounded staircase.
    boxBlurX(a, b, w, h, edge.blur);
    boxBlurY(b, a, w, h, edge.blur);
    boxBlurX(a, b, w, h, edge.blur);
    boxBlurY(b, a, w, h, edge.blur);
  }
  const gx0 = reg.c0 * MASK_RES;
  const gy0 = reg.r0 * MASK_RES;
  const span = edge.hi - edge.lo;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = a[i]!;
      if (v > 0.0001 && v < 0.9999) {
        if (edge.noise > 0) v += (edgeNoise(gx0 + x, gy0 + y, kind) - 0.5) * edge.noise;
        if (span <= 0) v = v >= edge.lo ? 1 : 0;
        else {
          const t = Math.min(1, Math.max(0, (v - edge.lo) / span));
          v = t * t * (3 - 2 * t);
        }
      } else v = v >= 0.5 ? 1 : 0;
      const o = i * 4;
      const c = Math.round(v * 255);
      out[o] = c;
      out[o + 1] = c;
      out[o + 2] = c;
      out[o + 3] = 255;
    }
  }
  return { w, h };
}

// ---------------------------------------------------------------------------------------------
// Browser: tile textures and the GPU ground builder (nothing here runs at import time)
// ---------------------------------------------------------------------------------------------

/** One repeatable texture per terrain kind. */
export type TileTextures = Record<Terrain, Texture>;

const TILE_PX = 256;

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function hex(c: number, a = 1): string {
  return `rgba(${(c >> 16) & 255},${(c >> 8) & 255},${c & 255},${a})`;
}

/** Draw `fn` 9 times shifted by ±TILE_PX so anything crossing the tile edge wraps seamlessly. */
function wrapped(fn: (dx: number, dy: number) => void) {
  for (const dx of [-TILE_PX, 0, TILE_PX]) for (const dy of [-TILE_PX, 0, TILE_PX]) fn(dx, dy);
}

function gravelTile(): HTMLCanvasElement {
  const c = canvas(TILE_PX, TILE_PX);
  const g = c.getContext("2d")!;
  g.fillStyle = hex(0x8b8478);
  g.fillRect(0, 0, TILE_PX, TILE_PX);
  const rng = mulberry32(0x67a7e1);
  const tones = [0x6f6a62, 0x9d968a, 0xb2aa9c, 0x7c7468, 0x5f5a53];
  for (let i = 0; i < 420; i++) {
    const x = rng() * TILE_PX;
    const y = rng() * TILE_PX;
    const r = 1.5 + rng() * (i < 60 ? 5 : 2.5);
    const col = tones[Math.floor(rng() * tones.length)]!;
    const sq = 0.6 + rng() * 0.4;
    const rot = rng() * 3;
    wrapped((dx, dy) => {
      g.beginPath();
      g.ellipse(x + dx, y + dy, r, r * sq, rot, 0, Math.PI * 2);
      g.fillStyle = hex(col, 0.9);
      g.fill();
      if (r > 4) {
        g.strokeStyle = hex(0x3f3a33, 0.6);
        g.lineWidth = 1.2;
        g.stroke();
      }
    });
  }
  return c;
}

function waterTile(base: number, ripple: number, pebbles: boolean, seed: number): HTMLCanvasElement {
  const c = canvas(TILE_PX, TILE_PX);
  const g = c.getContext("2d")!;
  g.fillStyle = hex(base);
  g.fillRect(0, 0, TILE_PX, TILE_PX);
  const rng = mulberry32(seed);
  if (pebbles) {
    for (let i = 0; i < 70; i++) {
      const x = rng() * TILE_PX;
      const y = rng() * TILE_PX;
      const r = 2 + rng() * 4;
      const rot = rng() * 3;
      wrapped((dx, dy) => {
        g.beginPath();
        g.ellipse(x + dx, y + dy, r, r * 0.7, rot, 0, Math.PI * 2);
        g.fillStyle = hex(0x7d9aa0, 0.55);
        g.fill();
      });
    }
  }
  // Cartoon ripples: short light arcs, a few with a bright highlight.
  g.lineCap = "round";
  for (let i = 0; i < 26; i++) {
    const x = rng() * TILE_PX;
    const y = rng() * TILE_PX;
    const len = 14 + rng() * 26;
    const bright = rng() < 0.25;
    wrapped((dx, dy) => {
      g.beginPath();
      g.moveTo(x + dx - len / 2, y + dy);
      g.quadraticCurveTo(x + dx, y + dy - 5, x + dx + len / 2, y + dy);
      g.strokeStyle = bright ? "rgba(235,248,255,0.55)" : hex(ripple, 0.55);
      g.lineWidth = bright ? 2.5 : 3;
      g.stroke();
    });
  }
  return c;
}

function bridgeTile(): HTMLCanvasElement {
  // Planks run N–S: traffic crosses the (N–S) river going E–W, so boards lie across it.
  const c = canvas(TILE_PX, TILE_PX);
  const g = c.getContext("2d")!;
  const rng = mulberry32(0xb41d6e);
  const PLANK = 32;
  for (let x = 0; x < TILE_PX; x += PLANK) {
    const tone = [0x8a6034, 0x956b3c, 0x7f5730, 0x9a7244][Math.floor(rng() * 4)]!;
    g.fillStyle = hex(tone);
    g.fillRect(x, 0, PLANK, TILE_PX);
    const j = Math.floor(rng() * TILE_PX);
    g.fillStyle = hex(0x3a2716, 0.8);
    g.fillRect(x, j, PLANK, 2);
    g.strokeStyle = hex(0x5e3f20, 0.35);
    g.lineWidth = 1;
    for (let k = 0; k < 3; k++) {
      const gx = x + 6 + rng() * (PLANK - 12);
      g.beginPath();
      g.moveTo(gx, 0);
      g.lineTo(gx + (rng() - 0.5) * 4, TILE_PX);
      g.stroke();
    }
    g.fillStyle = hex(0x2b2b2b, 0.8);
    g.fillRect(x + 6, (j + 8) % TILE_PX, 3, 3);
    g.fillRect(x + PLANK - 9, (j + 8) % TILE_PX, 3, 3);
    g.fillStyle = hex(0x3a2716);
    g.fillRect(x + PLANK - 3, 0, 3, TILE_PX);
  }
  return c;
}

function solidTile(color: number): HTMLCanvasElement {
  const c = canvas(8, 8);
  const g = c.getContext("2d")!;
  g.fillStyle = hex(color);
  g.fillRect(0, 0, 8, 8);
  return c;
}

function repeatTexture(c: HTMLCanvasElement): Texture {
  return new Texture({ source: new CanvasSource({ resource: c, addressMode: "repeat", scaleMode: "linear", autoGenerateMipmaps: true }) });
}

/**
 * Repeatable texture per terrain kind: the sprite where one exists (public/sprites/*_tile.png,
 * loaded with addressMode repeat by assets.ts), a procedural canvas tile otherwise (gravel, water,
 * ford, bridge), a flat colour if a sprite failed to load. `owned` lists the generated textures
 * the caller must destroy.
 */
export function makeTileTextures(tex: Textures): { tiles: TileTextures; owned: Texture[] } {
  const tiles = {} as TileTextures;
  const owned: Texture[] = [];
  for (const k of Object.values(TERRAIN) as Terrain[]) {
    const sprite = TILE_SPRITE[k];
    const t = sprite ? tex[sprite] : undefined;
    if (t && t !== Texture.EMPTY) {
      tiles[k] = t;
      continue;
    }
    const c =
      k === TERRAIN.GRAVEL ? gravelTile()
      : k === TERRAIN.WATER ? waterTile(0x2e6aa3, 0x4f8fc4, false, 0x3a7e12)
      : k === TERRAIN.SHALLOW ? waterTile(0x4f95ae, 0x8cc6d6, true, 0x5a11f0)
      : k === TERRAIN.BRIDGE ? bridgeTile()
      : solidTile(TERRAIN_COLOR[k]);
    tiles[k] = repeatTexture(c);
    owned.push(tiles[k]);
  }
  return { tiles, owned };
}

/** Rail line look (sleepers + two rails), world px. */
const RAIL = { GAUGE: 56, SLEEPER_LEN: 92, SLEEPER_W: 14, SLEEPER_EVERY: 40 } as const;
/** Asphalt centre-line dashes, world px. */
const DASH = { ON: 56, OFF: 48, W: 6 } as const;

/** Inputs for one chunk's ground (indices into MapData arrays, from ground-chunks buckets). */
export interface GroundPaintList {
  buildings: readonly number[];
  decals: readonly number[];
}

interface MaskedLayer {
  layer: GroundLayer;
  /** Kinds painted after this layer (it extends one cell under them). */
  under: number;
  tiling: TilingSprite;
  mask: Sprite;
  data: Uint8Array;
  source: BufferImageSource;
}

/**
 * Builds one chunk's ground as GPU display objects (world coordinates): base tile, masked kind
 * layers, roads/rails, decals and floors. Display objects and mask textures are pooled and reused
 * by every bake (only their positions, visibility and the 100 KB mask buffers change), so a bake
 * allocates nothing on the GPU. ground-chunks.ts renders `root` + props into the chunk texture.
 */
export class GroundBuilder {
  readonly root = new Container();
  private readonly base: TilingSprite;
  private readonly layers: MaskedLayer[] = [];
  /** Asphalt strokes (between gravel and the asphalt cell layer, so cells and stroke merge). */
  private readonly roads = new Graphics();
  /** Asphalt centre dashes (above the asphalt cell layer). */
  private readonly dashes = new Graphics();
  /** Rails over the bridge layer. */
  private readonly rails = new Graphics();
  /** Ground decals (dirt / oil blobs, debris) and building floors. */
  private readonly decalRoot = new Container();
  private readonly floors = new Graphics();
  private readonly scratch = new MaskScratch();
  private readonly kinds: Uint8Array;
  private readonly matrices = new Map<Terrain, Matrix>();
  /** Debug: ms of the last build() spent computing masks (perf harness / F3 overlay). */
  lastMaskMs = 0;

  constructor(
    readonly map: MapData,
    private readonly tiles: TileTextures,
    private readonly softDisc: Texture,
    readonly chunk: number,
  ) {
    this.kinds = groundKinds(map);
    this.base = this.tiling(GROUND_BASE);
    this.root.addChild(this.base);
    const per = Math.ceil(chunk / map.terrainCell) + 2 * MASK_RING;
    const mw = per * MASK_RES;
    for (const layer of GROUND_LAYERS) {
      if (layer.kind === TERRAIN.ASPHALT) this.root.addChild(this.roads);
      const data = new Uint8Array(mw * mw * 4);
      const source = new BufferImageSource({ resource: data, width: mw, height: mw, scaleMode: "linear", alphaMode: "no-premultiply-alpha" });
      const mask = new Sprite(new Texture({ source }));
      const tiling = this.tiling(layer.kind);
      // The mask sprite lives in the tree (so its transform updates) but is never drawn itself.
      this.root.addChild(mask, tiling);
      if (layer.kind === TERRAIN.ASPHALT) this.root.addChild(this.dashes);
      tiling.mask = mask;
      this.layers.push({ layer, under: underBits(layer.kind), tiling, mask, data, source });
    }
    this.root.addChild(this.rails, this.decalRoot, this.floors);
  }

  private tiling(kind: Terrain): TilingSprite {
    const t = new TilingSprite({ texture: this.tiles[kind], width: this.chunk, height: this.chunk });
    t.tileScale.set(TILE_SCALE[kind]);
    return t;
  }

  private fillMatrix(kind: Terrain): Matrix {
    let m = this.matrices.get(kind);
    if (!m) {
      m = new Matrix().scale(TILE_SCALE[kind], TILE_SCALE[kind]);
      this.matrices.set(kind, m);
    }
    return m;
  }

  /** World-aligned tiling: the pattern is anchored at world (0, 0) whatever the chunk. */
  private place(t: TilingSprite, x0: number, y0: number) {
    t.position.set(x0, y0);
    t.tilePosition.set(-x0, -y0);
  }

  /** Prepare `root` for chunk (cx, cy). Call right before rendering it. */
  build(cx: number, cy: number, list: GroundPaintList): Container {
    const { map, chunk } = this;
    const x0 = cx * chunk;
    const y0 = cy * chunk;
    this.place(this.base, x0, y0);
    const reg = chunkMaskRegion(cx, cy, chunk, map.terrainCell);
    const { present, full } = regionKinds(this.kinds, map.terrainCols, map.terrainRows, reg);
    const cell = map.terrainCell;
    let maskMs = 0;
    for (const L of this.layers) {
      const bit = 1 << L.layer.kind;
      if (!(present & bit)) {
        L.tiling.visible = false;
        continue;
      }
      L.tiling.visible = true;
      this.place(L.tiling, x0, y0);
      if (full & bit) {
        L.tiling.mask = null;
        L.mask.visible = false;
        continue;
      }
      const t = performance.now();
      kindMask(this.kinds, map.terrainCols, map.terrainRows, reg, L.layer.kind, L.layer.edge, L.data, this.scratch, L.under);
      maskMs += performance.now() - t;
      L.source.update();
      L.mask.visible = true;
      L.mask.position.set(reg.c0 * cell, reg.r0 * cell);
      L.mask.width = reg.cols * cell;
      L.mask.height = reg.rows * cell;
      L.tiling.mask = L.mask;
    }
    this.lastMaskMs = maskMs;
    this.drawRoads(x0, y0);
    this.drawDecals(list.decals);
    this.drawFloors(list.buildings);
    return this.root;
  }

  /** Road polylines whose bounding box (+ margin) touches the chunk. */
  private touches(pts: readonly number[], margin: number, x0: number, y0: number): boolean {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      minX = Math.min(minX, pts[i]!);
      maxX = Math.max(maxX, pts[i]!);
      minY = Math.min(minY, pts[i + 1]!);
      maxY = Math.max(maxY, pts[i + 1]!);
    }
    return maxX + margin >= x0 && minX - margin <= x0 + this.chunk && maxY + margin >= y0 && minY - margin <= y0 + this.chunk;
  }

  /**
   * Asphalt: a crisp textured stroke along the polyline (the 64 px cell staircase alone looks
   * jagged on diagonals) plus centre dashes. Rail: sleepers and two steel rails over the gravel
   * bed. Only segments near this chunk are emitted (a road is up to 24k px long).
   */
  private drawRoads(x0: number, y0: number) {
    const roads = this.roads.clear();
    const dashes = this.dashes.clear();
    const rails = this.rails.clear();
    const near = (x: number, y: number, m: number) =>
      x >= x0 - m && x <= x0 + this.chunk + m && y >= y0 - m && y <= y0 + this.chunk + m;
    for (const road of this.map.roads) {
      const pts = road.pts;
      if (pts.length < 4 || road.kind === "dirt" || !this.touches(pts, road.width, x0, y0)) continue;
      if (road.kind === "asphalt") {
        roads.moveTo(pts[0]!, pts[1]!);
        for (let i = 2; i < pts.length; i += 2) roads.lineTo(pts[i]!, pts[i + 1]!);
        roads.stroke({
          width: road.width - 8,
          texture: this.tiles[TERRAIN.ASPHALT],
          textureSpace: "global",
          matrix: this.fillMatrix(TERRAIN.ASPHALT),
          join: "round",
          cap: "butt",
          color: 0xffffff,
        });
      }
      // Walk the polyline once: dashes (asphalt) or sleepers (rail) at a fixed pitch.
      let carried = 0;
      for (let i = 0; i + 3 < pts.length; i += 2) {
        const ax = pts[i]!, ay = pts[i + 1]!, bx = pts[i + 2]!, by = pts[i + 3]!;
        const len = Math.hypot(bx - ax, by - ay);
        if (len < 1) continue;
        const ux = (bx - ax) / len, uy = (by - ay) / len;
        const nx = -uy, ny = ux;
        if (road.kind === "asphalt") {
          const pitch = DASH.ON + DASH.OFF;
          for (let t = -carried; t < len; t += pitch) {
            const s = Math.max(0, t), e = Math.min(len, t + DASH.ON);
            if (e <= s) continue;
            const sx = ax + ux * s, sy = ay + uy * s;
            if (!near(sx, sy, 128)) continue;
            dashes.moveTo(sx, sy).lineTo(ax + ux * e, ay + uy * e);
          }
          carried = (carried + len) % pitch;
          continue;
        }
        const hl = RAIL.SLEEPER_LEN / 2, hw = RAIL.SLEEPER_W / 2;
        for (let t = 0; t <= len; t += RAIL.SLEEPER_EVERY) {
          const px = ax + ux * t, py = ay + uy * t;
          if (!near(px, py, 64)) continue;
          rails.poly([
            px - ux * hw - nx * hl, py - uy * hw - ny * hl,
            px + ux * hw - nx * hl, py + uy * hw - ny * hl,
            px + ux * hw + nx * hl, py + uy * hw + ny * hl,
            px - ux * hw + nx * hl, py - uy * hw + ny * hl,
          ]);
        }
        rails.fill({ color: 0x5a3e24 }).stroke({ width: 2, color: 0x2e1f12, alpha: 0.8 });
        for (const side of [-1, 1]) {
          const ox = nx * side * (RAIL.GAUGE / 2), oy = ny * side * (RAIL.GAUGE / 2);
          rails.moveTo(ax + ox, ay + oy).lineTo(bx + ox, by + oy);
        }
        rails.stroke({ width: 9, color: 0x3b3b3e, cap: "butt" });
        for (const side of [-1, 1]) {
          const ox = nx * side * (RAIL.GAUGE / 2), oy = ny * side * (RAIL.GAUGE / 2);
          rails.moveTo(ax + ox, ay + oy).lineTo(bx + ox, by + oy);
        }
        rails.stroke({ width: 3, color: 0xc9ccd2, cap: "butt" });
      }
      if (road.kind === "asphalt") dashes.stroke({ width: DASH.W, color: 0xecd680, alpha: 0.7, cap: "butt" });
    }
  }

  /** Dirt / oil blobs (soft disc sprites), debris (small outlined chips). Puddles are props. */
  private drawDecals(ids: readonly number[]) {
    const root = this.decalRoot;
    for (const c of root.removeChildren()) c.destroy();
    const debris = new Graphics();
    for (const i of ids) {
      const d: Decal = this.map.decals[i]!;
      if (d.k === "dirt" || d.k === "oil") {
        const s = new Sprite(this.softDisc);
        s.anchor.set(0.5);
        s.position.set(d.x, d.y);
        s.width = d.r * 2;
        s.height = d.r * (d.k === "oil" ? 1.4 : 2);
        s.rotation = (d.x % 7) * 0.4;
        s.tint = d.k === "dirt" ? 0x7a5834 : 0x15131c;
        s.alpha = d.k === "dirt" ? 0.55 : 0.7;
        root.addChild(s);
      } else if (d.k === "debris") {
        const rng = mulberry32((d.x * 73856093) ^ (d.y * 19349663));
        for (let k = 0; k < 9; k++) {
          const a = rng() * Math.PI * 2;
          const r = rng() * d.r;
          const s = 6 + rng() * 12;
          const rot = rng() * 3;
          const cx = d.x + Math.cos(a) * r, cy = d.y + Math.sin(a) * r;
          const c = Math.cos(rot), sn = Math.sin(rot);
          const hx = s / 2, hy = s / 3;
          debris
            .poly([
              cx - c * hx + sn * hy, cy - sn * hx - c * hy,
              cx + c * hx + sn * hy, cy + sn * hx - c * hy,
              cx + c * hx - sn * hy, cy + sn * hx + c * hy,
              cx - c * hx - sn * hy, cy - sn * hx + c * hy,
            ])
            .fill({ color: [0x6d6a66, 0x8a7a64, 0x55524e, 0x9a8f80][k % 4]! })
            .stroke({ width: 2, color: 0x2a2622, alpha: 0.8 });
        }
      }
    }
    root.addChild(debris);
  }

  /** Building floors: crisp rect in the floor's tile, darker inner edge, worn door thresholds. */
  private drawFloors(ids: readonly number[]) {
    const g = this.floors.clear();
    for (const i of ids) {
      const b = this.map.buildings[i]!;
      const f = b.floor;
      g.rect(f.x, f.y, f.w, f.h).fill({
        texture: this.tiles[b.floorTerrain],
        textureSpace: "global",
        matrix: this.fillMatrix(b.floorTerrain),
        color: 0xffffff,
      });
      g.rect(f.x + 8, f.y + 8, f.w - 16, f.h - 16).stroke({ width: 16, color: 0x140e08, alpha: 0.3 });
      for (const d of b.doors) g.rect(d.x, d.y, d.w, d.h);
      if (b.doors.length) g.fill({ color: 0x281c10, alpha: 0.45 });
    }
  }

  destroy() {
    this.root.destroy({ children: true });
    for (const L of this.layers) L.source.destroy();
  }
}
