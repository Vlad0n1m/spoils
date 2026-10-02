/**
 * Static map rendering (v2, WP-M3): the facade the renderer talks to.
 *
 *  - `ground`: chunked baked ground (ground-chunks.ts) — terrain, roads, floors, decals, static
 *    shadows and every static solid, baked into 1024 px RenderTextures (LRU 16, ≤ 1 bake/frame);
 *  - `canopy`: live bushes, tree crowns, watchtower roofs, silo tops above players (canopy.ts).
 *
 * `shadows`, `obstacles` and `walls` are kept as (empty) containers so the v1 layer slots in the
 * renderer keep working; everything they used to hold is now inside the ground bake.
 *
 * Per frame the cost is index math over ≤ 16 chunk slots plus a grid query around the player —
 * there is no per-object culling loop (v1 iterated 8k cullables per frame at this map size).
 */

import { Container, type Renderer, type Texture } from "pixi.js";
import type { Circle, MapData } from "@extract/shared";
import type { Textures } from "./assets";
import { CanopyLayer } from "./canopy";
import { GroundChunks, type ChunkStats, type GroundChunksOptions, type ViewRect } from "./ground-chunks";
import { acquireOverview, releaseOverview } from "./minimap";

export type { ViewRect } from "./ground-chunks";

export interface WorldViewOptions extends Omit<GroundChunksOptions, "fallback"> {
  /** Show the map overview under chunks that are not baked yet (default true). */
  overviewFallback?: boolean;
}

/** Velocity smoothing for the prefetch direction (per frame, 0..1). */
const DIR_SMOOTH = 0.15;

export class WorldView {
  /** Baked chunks (and the overview fallback under them). World space, below everything dynamic. */
  readonly ground: Container;
  /** @deprecated v1 slot: shadows are baked into `ground`. Always empty. */
  readonly shadows = new Container();
  /** @deprecated v1 slot: obstacles are baked into `ground`. Always empty. */
  readonly obstacles = new Container();
  /** @deprecated v1 slot: walls are baked into `ground`. Always empty. */
  readonly walls = new Container();
  /** Bushes, tree crowns, roofs — drawn above players. */
  readonly canopy: Container;

  readonly chunks: GroundChunks;
  readonly canopyLayer: CanopyLayer;
  private readonly overview: Texture | null;
  private lastX = NaN;
  private lastY = NaN;
  private dirX = 0;
  private dirY = 0;
  private destroyed = false;

  /**
   * @param renderer `app.renderer` — chunk bakes render into RenderTextures with it.
   */
  constructor(
    readonly map: MapData,
    tex: Textures,
    renderer: Renderer,
    opts: WorldViewOptions = {},
  ) {
    this.overview = opts.overviewFallback === false ? null : acquireOverview(map);
    this.chunks = new GroundChunks(map, tex, renderer, { ...opts, fallback: this.overview });
    this.canopyLayer = new CanopyLayer(map, tex, this.chunks.grid);
    this.ground = this.chunks.root;
    this.canopy = this.canopyLayer.root;
  }

  /**
   * Bake every chunk under a view centred on (x, y) right now — call on the loading screen / on
   * spawn so the first frames never show the overview fallback. ~3–6 ms per chunk.
   */
  warmup(x: number, y: number, halfW = 960, halfH = 610): void {
    const view = { x0: x - halfW, y0: y - halfH, x1: x + halfW, y1: y + halfH };
    this.chunks.warmup(view, x, y);
    this.canopyLayer.update(view, null);
    this.lastX = x;
    this.lastY = y;
  }

  /**
   * Per frame. `view` = padded camera rect in world px (the renderer already pads it by
   * CULL_MARGIN). `self` = local player (crowns/bushes fade while they are under them; null when
   * dead or spectating). `dtMs` = frame delta for frame-rate independent fades.
   */
  update(view: ViewRect, self: { x: number; y: number } | null, dtMs = 16.7): void {
    if (this.destroyed) return;
    const cx = (view.x0 + view.x1) / 2;
    const cy = (view.y0 + view.y1) / 2;
    if (Number.isFinite(this.lastX)) {
      const dx = cx - this.lastX;
      const dy = cy - this.lastY;
      // A teleport (spawn, spectate switch) must not point the prefetch across the map.
      if (Math.abs(dx) + Math.abs(dy) < 400) {
        this.dirX += (dx - this.dirX) * DIR_SMOOTH;
        this.dirY += (dy - this.dirY) * DIR_SMOOTH;
      } else {
        this.dirX = 0;
        this.dirY = 0;
      }
    }
    this.lastX = cx;
    this.lastY = cy;
    const moving = Math.hypot(this.dirX, this.dirY) > 0.5;
    this.chunks.update(view, cx, cy, moving ? this.dirX : 0, moving ? this.dirY : 0);
    this.canopyLayer.update(view, self, dtMs);
  }

  /** The bush containing the point (used to hide other players' labels while they hide). */
  bushAt(x: number, y: number): Circle | null {
    return this.canopyLayer.bushAt(x, y);
  }

  /** Index into MapData.bushes of the bush containing the point, or -1 (fog/vision helpers). */
  bushIndexAt(x: number, y: number): number {
    return this.canopyLayer.bushIndexAt(x, y);
  }

  /** Chunk cache counters for the F3 perf overlay. */
  stats(): ChunkStats & { canopyObjects: number } {
    return { ...this.chunks.stats(), canopyObjects: this.canopyLayer.createdCount };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.chunks.destroy();
    this.canopyLayer.destroy();
    for (const c of [this.shadows, this.obstacles, this.walls]) c.destroy({ children: true });
    if (this.overview) releaseOverview(this.map);
  }
}
