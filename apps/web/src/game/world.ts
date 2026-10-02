/**
 * Static map rendering, built once from generateMap(state.mapSeed).
 * Layers are handed to the renderer so dynamic entities can be interleaved between them
 * (ground → shadows → … → obstacles → walls → players → … → canopy).
 */

import { Container, Graphics, ImageSource, Sprite, Texture, TilingSprite } from "pixi.js";
import { TREE_CANOPY_MULT, type MapData, type Rect } from "@extract/shared";
import { COLORS, type Textures } from "./assets";

interface Cullable {
  obj: Container;
  x: number;
  y: number;
  /** Bounding radius. */
  r: number;
}

interface CoverSprite {
  sprite: Sprite;
  x: number;
  y: number;
  /** Radius within which the local player counts as "inside" (cover becomes see-through). */
  r: number;
  baseAlpha: number;
}

/** View rectangle in world units, already padded by the caller. */
export interface ViewRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export class WorldView {
  /** Grass, dirt, building floors. */
  readonly ground = new Container();
  /** Soft drop shadows under trees, rocks and crates. */
  readonly shadows = new Graphics();
  /** Crates, rocks, tree trunks. */
  readonly obstacles = new Container();
  readonly walls = new Container();
  /** Bushes and tree canopies — drawn above players. */
  readonly canopy = new Container();

  private cullables: Cullable[] = [];
  private ownedTextures: Texture[] = [];
  private bushes: CoverSprite[] = [];
  private canopies: CoverSprite[] = [];

  constructor(
    readonly map: MapData,
    tex: Textures,
  ) {
    this.buildGround(tex);
    this.buildObstacles(tex);
    this.buildWalls();
  }

  private buildGround(tex: Textures) {
    const { map } = this;
    const grass = new TilingSprite({ texture: tex.grass_tile, width: map.width, height: map.height });
    this.ground.addChild(grass);

    // Dirt: each patch is one pre-rendered sprite (a lumpy blob of overlapping soft circles,
    // filled with the dirt tile in world-aligned position). No alpha mask: a map-sized Sprite
    // mask forced an extra full-screen filter pass and broke MSAA batching (measured ~20 ms of
    // GPU per frame). Overlapping patches still merge: canvas source-over of the mask discs and
    // the GPU's blending of two sprites of the same world-aligned dirt give the same pixels.
    const dirtImg = textureImage(tex.dirt_plain);
    if (dirtImg) {
      const patches = map.dirt.map((d) => {
        const lobes = dirtLobes(d);
        return { lobes, bounds: lobesBounds(lobes) };
      });
      const res = dirtBakeRes(patches.map((p) => p.bounds));
      for (const { lobes, bounds: b } of patches) {
        const texture = bakeDirtPatch(lobes, b, dirtImg, res);
        if (!texture) continue;
        this.ownedTextures.push(texture);
        const s = new Sprite(texture);
        s.position.set(b.x, b.y);
        s.width = b.w;
        s.height = b.h;
        this.ground.addChild(s);
        this.addCullable(s, b.x + b.w / 2, b.y + b.h / 2, Math.hypot(b.w, b.h) / 2);
      }
    }

    // Building floors: dark slate tiles.
    const TILE = 48;
    for (const b of map.buildings) {
      const f = b.floor;
      const g = new Graphics();
      g.rect(f.x, f.y, f.w, f.h).fill({ color: COLORS.floorFill });
      // Laid-stone pattern: full row lines, joints offset by half a tile on every other row.
      for (let y = f.y + TILE; y < f.y + f.h; y += TILE) g.moveTo(f.x, y).lineTo(f.x + f.w, y);
      for (let y = f.y, row = 0; y < f.y + f.h; y += TILE, row++) {
        const y1 = Math.min(y + TILE, f.y + f.h);
        for (let x = f.x + (row % 2 ? TILE / 2 : TILE); x < f.x + f.w; x += TILE) g.moveTo(x, y).lineTo(x, y1);
      }
      g.stroke({ width: 2, color: COLORS.floorLine, alpha: 0.9 });
      g.rect(f.x, f.y, f.w, f.h).stroke({ width: 6, color: COLORS.floorEdge, alignment: 1 });
      this.ground.addChild(g);
      this.addCullable(g, f.x + f.w / 2, f.y + f.h / 2, Math.hypot(f.w, f.h) / 2);
    }
  }

  private buildObstacles(tex: Textures) {
    const { map } = this;
    const sh = this.shadows;
    for (const t of map.trees) sh.circle(t.x + 10, t.y + 14, t.r * TREE_CANOPY_MULT * 0.92);
    for (const r of map.rocks) sh.circle(r.x + 6, r.y + 8, r.r);
    for (const c of map.crates) sh.roundRect(c.x + 6, c.y + 8, c.w, c.h, 8);
    sh.fill({ color: COLORS.shadow, alpha: 0.2 });

    for (const c of map.crates) {
      const s = centeredSprite(tex.crate, c.x + c.w / 2, c.y + c.h / 2, c.w + 4, c.h + 4);
      this.obstacles.addChild(s);
      this.addCullable(s, c.x + c.w / 2, c.y + c.h / 2, c.w);
    }
    for (const r of map.rocks) {
      // The rock sprite's outline sits right at the texture edge; a few % larger covers the
      // collision circle completely so bullets never visibly stop in mid-air.
      const size = r.r * 2 * 1.08;
      const s = centeredSprite(tex.rock, r.x, r.y, size, size);
      s.rotation = ((r.x * 7 + r.y * 13) % 628) / 100;
      this.obstacles.addChild(s);
      this.addCullable(s, r.x, r.y, size / 2);
    }
    for (const t of map.trees) {
      const trunk = new Graphics();
      trunk.circle(0, 0, t.r).fill({ color: 0x6b4423 }).stroke({ width: 4, color: COLORS.wallOutline });
      trunk.position.set(t.x, t.y);
      this.obstacles.addChild(trunk);
      this.addCullable(trunk, t.x, t.y, t.r + 4);

      const size = t.r * TREE_CANOPY_MULT * 2;
      const canopy = centeredSprite(tex.tree, t.x, t.y, size, size);
      canopy.rotation = ((t.x * 3 + t.y * 5) % 628) / 100;
      this.canopy.addChild(canopy);
      this.addCullable(canopy, t.x, t.y, size / 2);
      this.canopies.push({ sprite: canopy, x: t.x, y: t.y, r: (size / 2) * 0.85, baseAlpha: 1 });
    }
    for (const b of map.bushes) {
      const size = b.r * 2;
      const s = centeredSprite(tex.bush, b.x, b.y, size, size);
      s.rotation = ((b.x * 11 + b.y * 3) % 628) / 100;
      this.canopy.addChild(s);
      this.addCullable(s, b.x, b.y, b.r);
      this.bushes.push({ sprite: s, x: b.x, y: b.y, r: b.r, baseAlpha: 1 });
    }
  }

  private buildWalls() {
    const { map } = this;
    const border = map.walls.slice(0, 4);
    const borderG = new Graphics();
    drawWallSet(borderG, border, COLORS.borderFill, COLORS.borderHighlight);
    this.walls.addChild(borderG);

    for (const b of map.buildings) {
      const g = new Graphics();
      drawWallSet(g, b.walls, COLORS.wallFill, COLORS.wallHighlight);
      this.walls.addChild(g);
      const f = b.floor;
      this.addCullable(g, f.x + f.w / 2, f.y + f.h / 2, Math.hypot(f.w, f.h) / 2 + 20);
    }
  }

  private addCullable(obj: Container, x: number, y: number, r: number) {
    this.cullables.push({ obj, x, y, r });
  }

  /**
   * Per-frame: hide everything outside the view, and make the cover the local player is
   * standing in see-through so they can see themselves.
   */
  update(view: ViewRect, self: { x: number; y: number } | null) {
    for (const c of this.cullables) {
      c.obj.visible = c.x + c.r >= view.x0 && c.x - c.r <= view.x1 && c.y + c.r >= view.y0 && c.y - c.r <= view.y1;
    }
    for (const list of [this.bushes, this.canopies]) {
      for (const c of list) {
        if (!c.sprite.visible) continue;
        const inside = !!self && Math.hypot(self.x - c.x, self.y - c.y) < c.r;
        const target = inside ? (list === this.bushes ? 0.5 : 0.4) : c.baseAlpha;
        c.sprite.alpha += (target - c.sprite.alpha) * 0.25;
      }
    }
  }

  /** Is the point inside a bush (used to hide other players' labels while they hide)? */
  bushAt(x: number, y: number): { x: number; y: number; r: number } | null {
    for (const b of this.bushes) {
      if (Math.hypot(x - b.x, y - b.y) < b.r * 0.9) return b;
    }
    return null;
  }

  destroy() {
    for (const c of [this.ground, this.shadows, this.obstacles, this.walls, this.canopy]) {
      c.destroy({ children: true });
    }
    for (const t of this.ownedTextures) t.destroy(true);
    this.ownedTextures = [];
    this.cullables = [];
    this.bushes = [];
    this.canopies = [];
  }
}

/** Dirt tile scale in the world (the old TilingSprite's tileScale). */
const DIRT_TILE_SCALE = 0.75;
/**
 * Baked dirt texture pixels per world unit. The 256 px dirt tile covers 192 world px, so 1:1
 * keeps the pattern's detail; today's 4800² map (26 patches) bakes to ~4.6 Mpx (~18 MB).
 */
const DIRT_BAKE_RES = 1;
/**
 * Cap on all baked dirt pixels (~64 MB RGBA). A bigger map with many more patches bakes at a
 * lower resolution instead of eating RAM/VRAM; the chunked ground bake replaces this in v2.
 */
const DIRT_BAKE_MAX_PX = 16_000_000;

/** Resolution to bake dirt patches with, so the total stays under DIRT_BAKE_MAX_PX. */
export function dirtBakeRes(bounds: Array<{ w: number; h: number }>): number {
  let px = 0;
  for (const b of bounds) px += b.w * b.h;
  const fit = px * DIRT_BAKE_RES * DIRT_BAKE_RES > DIRT_BAKE_MAX_PX ? Math.sqrt(DIRT_BAKE_MAX_PX / px) : DIRT_BAKE_RES;
  return Math.max(0.25, fit);
}
/** Extra soft lobes around each patch's core circle. */
const DIRT_LOBES = 5;

/** Deterministic 0..1 noise from a patch and a lobe index (same blobs on every client). */
function hash01(a: number, b: number, c: number): number {
  let h = Math.imul(Math.round(a) | 0, 0x27d4eb2d) ^ Math.imul(Math.round(b) | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 0x1_0000_0000;
}

/** One soft disc of a dirt patch, in world units: opaque up to `core` × r, transparent at r. */
export interface DirtLobe {
  x: number;
  y: number;
  r: number;
  core: number;
  alpha: number;
}

/**
 * The soft discs that make up one dirt patch: a slightly smaller core (so the lobes decide the
 * outline) plus DIRT_LOBES offset lobes. Pure and deterministic, so every client draws the
 * same blob.
 */
export function dirtLobes(d: { x: number; y: number; r: number }): DirtLobe[] {
  const out: DirtLobe[] = [{ x: d.x, y: d.y, r: d.r * 0.8, core: 0.55, alpha: 1 }];
  const turn = hash01(d.x, d.y, 0) * Math.PI * 2;
  for (let i = 0; i < DIRT_LOBES; i++) {
    const a = turn + (i / DIRT_LOBES) * Math.PI * 2 + (hash01(d.x, d.y, i + 1) - 0.5) * 0.9;
    const off = d.r * (0.3 + 0.3 * hash01(d.x, d.y, i + 11));
    const lr = d.r * (0.38 + 0.25 * hash01(d.x, d.y, i + 21));
    out.push({ x: d.x + Math.cos(a) * off, y: d.y + Math.sin(a) * off, r: lr, core: 0.45, alpha: 0.85 });
  }
  return out;
}

/** World-space bounding box of a set of lobes, snapped outward to whole world units. */
export function lobesBounds(lobes: DirtLobe[]): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const l of lobes) {
    x0 = Math.min(x0, l.x - l.r);
    y0 = Math.min(y0, l.y - l.r);
    x1 = Math.max(x1, l.x + l.r);
    y1 = Math.max(y1, l.y + l.r);
  }
  x0 = Math.floor(x0);
  y0 = Math.floor(y0);
  return { x: x0, y: y0, w: Math.ceil(x1) - x0, h: Math.ceil(y1) - y0 };
}

/** A soft disc: opaque up to `core` × radius, fading to transparent at the radius. */
function softDisc(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, core: number, alpha: number) {
  if (r <= 0) return;
  const g = ctx.createRadialGradient(x, y, r * core, x, y, r);
  g.addColorStop(0, `rgba(255,255,255,${alpha})`);
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

/** The decoded image behind a loaded texture (null when the sprite failed to load). */
function textureImage(t: Texture): CanvasImageSource | null {
  if (t === Texture.EMPTY) return null;
  const res = t.source?.resource as unknown;
  if (typeof HTMLImageElement !== "undefined" && res instanceof HTMLImageElement) return res;
  if (typeof ImageBitmap !== "undefined" && res instanceof ImageBitmap) return res;
  if (typeof HTMLCanvasElement !== "undefined" && res instanceof HTMLCanvasElement) return res;
  return null;
}

/**
 * Bakes one dirt patch: the lobes are painted as white soft discs (the alpha shape), then the
 * dirt tile is drawn "source-in" in world-aligned position — the same pixels the old masked
 * map-sized TilingSprite produced inside this patch's bounds.
 */
function bakeDirtPatch(
  lobes: DirtLobe[],
  b: { x: number; y: number; w: number; h: number },
  img: CanvasImageSource,
  res: number,
): Texture | null {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.ceil(b.w * res));
  c.height = Math.max(1, Math.ceil(b.h * res));
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  // World coordinates from here on.
  ctx.setTransform(res, 0, 0, res, -b.x * res, -b.y * res);
  for (const l of lobes) softDisc(ctx, l.x, l.y, l.r, l.core, l.alpha);
  const pattern = ctx.createPattern(img, "repeat");
  if (!pattern) return null;
  // Tiles anchored at the world origin, like the old TilingSprite at (0, 0) with tileScale 0.75.
  pattern.setTransform(new DOMMatrix().scale(DIRT_TILE_SCALE));
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = pattern;
  ctx.fillRect(b.x, b.y, b.w, b.h);
  return new Texture({ source: new ImageSource({ resource: c, scaleMode: "linear" }) });
}

function centeredSprite(texture: Texture, x: number, y: number, w: number, h: number): Sprite {
  const s = new Sprite(texture);
  s.anchor.set(0.5);
  s.position.set(x, y);
  s.width = w;
  s.height = h;
  return s;
}

/**
 * Walls in the cartoon style: thick dark outline, warm fill, lighter top edge.
 * Outlines for the whole set are drawn first and fills second, so walls meeting at a corner
 * merge into one shape instead of showing an outline seam.
 */
function drawWallSet(g: Graphics, walls: Rect[], fill: number, highlight: number) {
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
