/**
 * Live canopy layer (WP-M3): bushes, tree crowns, watchtower roofs and silo tops — the only map
 * objects drawn ABOVE players, so they cannot be baked into the ground chunks.
 *
 * Objects are grouped into per-chunk containers created lazily the first time a chunk comes into
 * view; per frame only the containers of the visible chunk range are toggled (no per-object
 * culling loop). The see-through fade when the local player stands under a crown or inside a bush
 * looks only at objects near the player through a UniformGrid. bushAt goes through the shared bush
 * index (the same rule the server's vision uses), not a scan over ~1800 bushes.
 */

import { Container, Graphics, Sprite, type Texture } from "pixi.js";
import {
  SEARCH,
  TREE_CANOPY_MULT,
  UniformGrid,
  buildBushIndex,
  bushIndexAt,
  type BushIndex,
  type Circle,
  type MapData,
} from "@extract/shared";
import type { Textures } from "./assets";
import { chunkKey, chunkSpan, propHash, propSprite, type ChunkGrid, type ViewRect } from "./ground-chunks";

/** Alpha of a crown / bush while the local player is under it (they must see themselves). */
export const CANOPY_INSIDE_ALPHA = { tree: 0.4, bush: 0.5, roof: 0.55 } as const;
/** Fade time constant, ms (≈ the old 0.25-per-frame lerp at 60 fps). */
const FADE_TAU_MS = 55;
/**
 * A tree crown over a container fades while the local player is this close to the container
 * (≈ the search range plus a step), so the crate is not hidden under the leaves when it matters.
 */
export const CONTAINER_REVEAL_R = SEARCH.OPEN_RANGE * 1.5;
/** A container sprite reaches about this far from its centre (the widest is ~76 px). */
const BOX_HALF = 40;
/** Crowns reach this far past their chunk; the visible range is grown by it. */
const CANOPY_REACH = 160;

type CanopyKind = "tree" | "bush" | "roof" | "silo";

interface CanopyItem {
  kind: CanopyKind;
  x: number;
  y: number;
  /** Radius within which the player counts as "under" it (0 = never fades). */
  fadeR: number;
  /** Drawn crown radius (trees; 0 otherwise): a container touching it fades the crown. */
  crownR: number;
  chunk: number;
  /** Index into the MapData array the item came from (bushes / circles / rects by kind). */
  src: number;
  obj: Container | null;
}

/** Per chunk: one container per sub-layer (bushes under crowns under roofs). */
interface ChunkNodes {
  bush: Container;
  tree: Container;
  roof: Container;
}

export class CanopyLayer {
  readonly root = new Container();
  private readonly bushRoot = new Container();
  private readonly treeRoot = new Container();
  private readonly roofRoot = new Container();
  private readonly items: CanopyItem[] = [];
  private readonly byChunk: number[][];
  private readonly nodes = new Map<number, ChunkNodes>();
  private readonly near: UniformGrid;
  private readonly nearScratch: number[] = [];
  private readonly fading = new Set<number>();
  private readonly shown = new Set<number>();
  private readonly nextShown = new Set<number>();
  private readonly bushIdx: BushIndex;
  private maxFadeR = 0;
  private maxCrownR = 0;
  /** Containers by position (MapData.containers index), for the crown-over-container fade. */
  private readonly boxes: UniformGrid;
  private readonly boxScratch: number[] = [];
  /** Tree crowns over a container near the player this frame. */
  private readonly revealed = new Set<number>();

  constructor(
    readonly map: MapData,
    private readonly tex: Textures,
    readonly grid: ChunkGrid,
  ) {
    this.root.addChild(this.bushRoot, this.treeRoot, this.roofRoot);
    this.root.eventMode = "none";
    this.root.interactiveChildren = false;
    this.byChunk = Array.from({ length: grid.cols * grid.rows }, () => []);
    this.near = new UniformGrid(map.width, map.height, 256);
    this.bushIdx = buildBushIndex(map.bushes, map.width, map.height);
    this.boxes = new UniformGrid(map.width, map.height, 256);
    map.containers.forEach((c, i) => this.boxes.set(i, c.x, c.y));

    map.bushes.forEach((b, i) => this.add("bush", b.x, b.y, b.r, i));
    map.circles.forEach((c, i) => {
      if (c.k === "tree") this.add("tree", c.x, c.y, c.r * TREE_CANOPY_MULT * 0.85, i, c.r * TREE_CANOPY_MULT);
      else if (c.k === "silo") this.add("silo", c.x, c.y, 0, i);
    });
    map.rects.forEach((r, i) => {
      if (r.k === "watchtower") this.add("roof", r.x + r.w / 2, r.y + r.h / 2, 0, i);
    });
  }

  private add(kind: CanopyKind, x: number, y: number, fadeR: number, src: number, crownR = 0) {
    const s = chunkSpan(this.grid, x, y, x, y);
    const chunk = chunkKey(this.grid, s.cx0, s.cy0);
    const id = this.items.length;
    this.items.push({ kind, x, y, fadeR, crownR, chunk, src, obj: null });
    this.byChunk[chunk]!.push(id);
    if (fadeR > 0) {
      this.near.set(id, x, y);
      this.maxFadeR = Math.max(this.maxFadeR, fadeR);
      this.maxCrownR = Math.max(this.maxCrownR, crownR);
    }
  }

  /** Create the display objects of one chunk (first time it is visible). */
  private nodesOf(chunk: number): ChunkNodes {
    let n = this.nodes.get(chunk);
    if (n) return n;
    n = { bush: new Container(), tree: new Container(), roof: new Container() };
    this.bushRoot.addChild(n.bush);
    this.treeRoot.addChild(n.tree);
    this.roofRoot.addChild(n.roof);
    for (const id of this.byChunk[chunk]!) {
      const it = this.items[id]!;
      const obj = this.makeObject(it, id);
      it.obj = obj;
      (it.kind === "bush" ? n.bush : it.kind === "tree" ? n.tree : n.roof).addChild(obj);
    }
    this.nodes.set(chunk, n);
    return n;
  }

  private makeObject(it: CanopyItem, id: number): Container {
    const { map, tex } = this;
    switch (it.kind) {
      case "bush":
        return centered(tex.bush, it.x, it.y, map.bushes[it.src]!.r * 2, ((it.x * 11 + it.y * 3) % 628) / 100);
      case "tree": {
        const size = map.circles[it.src]!.r * TREE_CANOPY_MULT * 2;
        return centered(tex.tree, it.x, it.y, size, ((it.x * 3 + it.y * 5) % 628) / 100);
      }
      case "roof": {
        const rect = map.rects[it.src]!;
        // Platform square of the art ≈ the top 225 px of 288: centre it on the footprint.
        const s = propSprite(tex.watchtower, "watchtower", { x: rect.x - 12, y: rect.y - 12, w: rect.w + 24, h: (rect.h + 24) * (288 / 225) }, false, 0);
        s.position.set(rect.x + rect.w / 2, rect.y + rect.h / 2 + (rect.h + 24) * (288 / 225 - 1) / 2);
        return s;
      }
      case "silo":
        return siloTop(it.x, it.y, map.circles[it.src]!.r, id);
    }
  }

  /**
   * Per frame. `view` is the padded camera rect in world px; `self` the local player (null when
   * dead/spectating: nothing fades). Cost: chunk-range diff + a grid query around the player.
   */
  update(view: ViewRect, self: { x: number; y: number } | null, dtMs = 16.7): void {
    const s = chunkSpan(this.grid, view.x0 - CANOPY_REACH, view.y0 - CANOPY_REACH, view.x1 + CANOPY_REACH, view.y1 + CANOPY_REACH);
    this.nextShown.clear();
    for (let cy = s.cy0; cy <= s.cy1; cy++) {
      for (let cx = s.cx0; cx <= s.cx1; cx++) {
        const k = chunkKey(this.grid, cx, cy);
        this.nextShown.add(k);
        if (!this.shown.has(k)) setVisible(this.nodesOf(k), true);
      }
    }
    for (const k of this.shown) if (!this.nextShown.has(k)) setVisible(this.nodes.get(k)!, false);
    this.shown.clear();
    for (const k of this.nextShown) this.shown.add(k);

    // Fade targets: items the player is under now join the fading set; everything in the set
    // eases toward its target and leaves the set once back at full alpha.
    if (self) {
      for (const id of this.near.queryCircle(self.x, self.y, this.maxFadeR, this.nearScratch)) {
        const it = this.items[id]!;
        if (it.obj && (self.x - it.x) ** 2 + (self.y - it.y) ** 2 < it.fadeR * it.fadeR) this.fading.add(id);
      }
    }
    // Tree crowns over a container the player is next to fade like the one they stand under.
    this.revealed.clear();
    if (self) {
      for (const b of this.boxes.queryCircle(self.x, self.y, CONTAINER_REVEAL_R, this.boxScratch)) {
        const c = this.map.containers[b]!;
        if ((self.x - c.x) ** 2 + (self.y - c.y) ** 2 > CONTAINER_REVEAL_R * CONTAINER_REVEAL_R) continue;
        for (const id of this.near.queryCircle(c.x, c.y, this.maxCrownR + BOX_HALF, this.nearScratch)) {
          const it = this.items[id]!;
          const reach = it.crownR + BOX_HALF;
          if (it.kind !== "tree" || !it.obj || (c.x - it.x) ** 2 + (c.y - it.y) ** 2 >= reach * reach) continue;
          this.revealed.add(id);
          this.fading.add(id);
        }
      }
    }
    const k = 1 - Math.exp(-dtMs / FADE_TAU_MS);
    for (const id of this.fading) {
      const it = this.items[id]!;
      const obj = it.obj;
      if (!obj) {
        this.fading.delete(id);
        continue;
      }
      const inside = (!!self && (self.x - it.x) ** 2 + (self.y - it.y) ** 2 < it.fadeR * it.fadeR) || this.revealed.has(id);
      const target = inside ? CANOPY_INSIDE_ALPHA[it.kind === "bush" ? "bush" : it.kind === "tree" ? "tree" : "roof"] : 1;
      obj.alpha += (target - obj.alpha) * k;
      if (!inside && obj.alpha > 0.995) {
        obj.alpha = 1;
        this.fading.delete(id);
      }
    }
  }

  /** The bush containing the point (0.9 r, same rule as server vision), or null. */
  bushAt(x: number, y: number): Circle | null {
    const i = bushIndexAt(this.bushIdx, x, y);
    return i < 0 ? null : this.map.bushes[i]!;
  }

  /** Index into MapData.bushes of the bush containing the point, or -1. */
  bushIndexAt(x: number, y: number): number {
    return bushIndexAt(this.bushIdx, x, y);
  }

  /** Number of canopy display objects created so far (lazy per chunk). */
  get createdCount(): number {
    let n = 0;
    for (const it of this.items) if (it.obj) n++;
    return n;
  }

  destroy(): void {
    this.root.destroy({ children: true });
    this.nodes.clear();
    this.fading.clear();
    this.shown.clear();
    for (const it of this.items) it.obj = null;
  }
}

function setVisible(n: ChunkNodes, v: boolean) {
  n.bush.visible = v;
  n.tree.visible = v;
  n.roof.visible = v;
}

function centered(texture: Texture, x: number, y: number, size: number, rotation: number): Sprite {
  const s = new Sprite(texture);
  s.anchor.set(0.5);
  s.position.set(x, y);
  s.width = s.height = size;
  s.rotation = rotation;
  return s;
}

/** Grain-silo roof seen from above: steel cone with radial seams, a rim and a hatch. */
function siloTop(x: number, y: number, r: number, id: number): Graphics {
  const g = new Graphics();
  g.circle(0, 0, r).fill({ color: 0xb4b8b6 }).stroke({ width: 6, color: 0x2e2f2c });
  g.circle(0, 0, r * 0.72).fill({ color: 0xc6cac7 });
  g.circle(0, 0, r * 0.42).fill({ color: 0xd3d6d2 });
  const seams = 12;
  const turn = propHash(x, y, id) * Math.PI;
  for (let i = 0; i < seams; i++) {
    const a = turn + (i / seams) * Math.PI * 2;
    g.moveTo(Math.cos(a) * r * 0.16, Math.sin(a) * r * 0.16).lineTo(Math.cos(a) * r * 0.97, Math.sin(a) * r * 0.97);
  }
  g.stroke({ width: 2, color: 0x7d817f, alpha: 0.8 });
  g.circle(0, 0, r * 0.16).fill({ color: 0x8b8f8c }).stroke({ width: 3, color: 0x2e2f2c });
  g.rect(r * 0.3, -6, r * 0.5, 12).fill({ color: 0x9c6b3c }).stroke({ width: 2, color: 0x2e2f2c });
  g.position.set(x, y);
  g.rotation = turn * 2;
  return g;
}
