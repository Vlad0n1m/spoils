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

    // Dirt: one map-sized dirt tiling sprite under a soft alpha mask painted from the patch
    // circles (low-res canvas, upscaled), so patches fade into the grass and merge when they overlap.
    const dirt = new TilingSprite({ texture: tex.dirt_tile, width: map.width, height: map.height });
    dirt.tileScale.set(0.75);
    const maskTex = dirtMaskTexture(map);
    if (maskTex) {
      this.ownedTextures.push(maskTex);
      const mask = new Sprite(maskTex);
      mask.width = map.width;
      mask.height = map.height;
      dirt.mask = mask;
      this.ground.addChild(dirt, mask);
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

/** World units per mask pixel: patches are 90–240 px wide, so soft edges survive the upscale. */
const DIRT_MASK_SCALE = 8;

function dirtMaskTexture(map: MapData): Texture | null {
  const c = document.createElement("canvas");
  c.width = Math.ceil(map.width / DIRT_MASK_SCALE);
  c.height = Math.ceil(map.height / DIRT_MASK_SCALE);
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  for (const d of map.dirt) {
    const x = d.x / DIRT_MASK_SCALE;
    const y = d.y / DIRT_MASK_SCALE;
    const r = d.r / DIRT_MASK_SCALE;
    const g = ctx.createRadialGradient(x, y, r * 0.55, x, y, r);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
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
