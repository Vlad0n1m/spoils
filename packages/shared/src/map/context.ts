/**
 * Mutable state shared by the generator stages (terrain → POIs → spawns → props → spots →
 * validation). Only the generator touches it; the result is frozen into a MapData.
 *
 * Two placement hashes:
 *  - `taken`: every footprint including road and water bands (props, buildings, spawns);
 *  - `blocks`: everything except road bands — for things that may sit ON a road (car wrecks,
 *    wagons, checkpoint barriers, loose loot) but must not overlap other solids.
 */

import { SOLID, type Circle, type Rect } from "../geometry.js";
import type { Rng } from "../rng.js";
import { ARCH, doorOrder, makeBuilding, type BuiltBuilding } from "./buildings.js";
import { Placement } from "./placement.js";
import { ROAD_MASK, TerrainGrid } from "./terrain.js";
import {
  TERRAIN_INDOOR,
  type AmbientEmitter,
  type BossSpot,
  type Building,
  type BuildingArch,
  type CircleKind,
  type ContainerKind,
  type ContainerSpot,
  type Decal,
  type ExtractSpot,
  type LootSpot,
  type LootTier,
  type MapCircle,
  type MapRect,
  type MapSide,
  type PropKind,
  type Road,
  type SpawnSpot,
  type Zone,
} from "./types.js";
import { grow, rngFor } from "./util.js";

export class GenCtx {
  readonly terrain: TerrainGrid;
  readonly taken: Placement;
  readonly blocks: Placement;

  readonly zones: Zone[] = [];
  readonly roads: Road[] = [];
  /** Template id per entry of `roads` (POI layouts look roads up by id, not by index). */
  readonly roadIds: string[] = [];
  river: number[] = [];
  readonly rects: MapRect[] = [];
  readonly circles: MapCircle[] = [];
  readonly bushes: Circle[] = [];
  readonly decals: Decal[] = [];
  readonly buildings: Building[] = [];
  /** Interior solids per building index (containers keep clear of them). */
  readonly furniture: Rect[][] = [];
  readonly containers: ContainerSpot[] = [];
  readonly lootSpots: LootSpot[] = [];
  readonly spawns: SpawnSpot[] = [];
  readonly extracts: ExtractSpot[] = [];
  readonly bosses: BossSpot[] = [];
  readonly ambient: AmbientEmitter[] = [];

  constructor(
    readonly seed: number,
    readonly width: number,
    readonly height: number,
    readonly block: number,
    readonly border: number,
    terrainCell: number,
  ) {
    this.terrain = new TerrainGrid(width, height, terrainCell);
    this.taken = new Placement(Math.max(width, height));
    this.blocks = new Placement(Math.max(width, height));
  }

  rng(label: string): Rng {
    return rngFor(this.seed, label);
  }

  /** Block units → px (integer). */
  b(v: number): number {
    return Math.round(v * this.block);
  }

  zone(id: string): Zone {
    const z = this.zones.find((q) => q.id === id);
    if (!z) throw new Error(`map: unknown zone ${id}`);
    return z;
  }

  road(id: string): Road {
    const i = this.roadIds.indexOf(id);
    if (i < 0) throw new Error(`map: unknown road ${id}`);
    return this.roads[i]!;
  }

  inBounds(r: Rect, margin: number): boolean {
    const m = this.border + margin;
    return r.x >= m && r.y >= m && r.x + r.w <= this.width - m && r.y + r.h <= this.height - m;
  }

  /** Reserve a footprint. Road bands go into `taken` only. */
  reserve(r: Rect, roadOnly = false): void {
    this.taken.add(r);
    if (!roadOnly) this.blocks.add(r);
  }

  /** Free in `taken` (default) — nothing at all within `margin`. */
  free(r: Rect, margin: number): boolean {
    return this.inBounds(r, 0) && this.taken.free(r, margin);
  }

  /** Free of solids but allowed on roads (no asphalt/dirt road cells either when `keepRoads`). */
  freeOnRoad(r: Rect, margin: number, keepRoads = false): boolean {
    if (!this.inBounds(r, 0) || !this.blocks.free(r, margin)) return false;
    if (keepRoads) {
      let hit = false;
      this.terrain.paintRect(grow(r, 32), (old, i) => {
        const m = this.terrain.roadMask[i]!;
        if (m === ROAD_MASK.ASPHALT || m === ROAD_MASK.DIRT) hit = true;
        return old;
      });
      if (hit) return false;
    }
    return true;
  }

  rect(x: number, y: number, w: number, h: number, f: number, k: PropKind, o?: 0 | 1, reserveMargin = 0): MapRect {
    const r: MapRect = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), f, k };
    if (o !== undefined) r.o = o;
    this.rects.push(r);
    this.reserve(grow(r, reserveMargin));
    return r;
  }

  circle(x: number, y: number, r: number, f: number, k: CircleKind, reserve = r): MapCircle {
    const c: MapCircle = { x: Math.round(x), y: Math.round(y), r: Math.round(r), f, k };
    this.circles.push(c);
    this.reserve({ x: c.x - reserve, y: c.y - reserve, w: 2 * reserve, h: 2 * reserve });
    return c;
  }

  decal(x: number, y: number, r: number, k: Decal["k"]): void {
    this.decals.push({ x: Math.round(x), y: Math.round(y), r: Math.round(r), k });
  }

  bush(x: number, y: number, r: number): void {
    this.bushes.push({ x: Math.round(x), y: Math.round(y), r: Math.round(r) });
  }

  container(x: number, y: number, kind: ContainerKind, tier: LootTier, zone: string | null): void {
    this.containers.push({ x: Math.round(x), y: Math.round(y), kind, tier, zone });
  }

  loot(x: number, y: number, tier: LootTier): void {
    this.lootSpots.push({ x: Math.round(x), y: Math.round(y), tier });
  }

  /**
   * Nearest road side of a footprint (0 N, 1 E, 2 S, 3 W) by marching outward from each side's
   * midpoint; null when no road within `maxPx`. Exterior doors face it.
   */
  roadSide(r: Rect, maxPx = 1536): MapSide | null {
    const cs = this.terrain.cell;
    const mids: Array<[number, number, number, number]> = [
      [r.x + r.w / 2, r.y, 0, -1],
      [r.x + r.w, r.y + r.h / 2, 1, 0],
      [r.x + r.w / 2, r.y + r.h, 0, 1],
      [r.x, r.y + r.h / 2, -1, 0],
    ];
    let best: MapSide | null = null;
    let bestD = Infinity;
    for (let s = 0; s < 4; s++) {
      const [mx, my, dx, dy] = mids[s]!;
      for (let d = cs / 2; d <= maxPx && d < bestD; d += cs) {
        const x = mx + dx * d, y = my + dy * d;
        if (x < 0 || y < 0 || x >= this.width || y >= this.height) break;
        if (this.terrain.roadAt(x, y) !== ROAD_MASK.NONE) {
          bestD = d;
          best = s as MapSide;
          break;
        }
      }
    }
    return best;
  }

  /**
   * Place a BSP building if its footprint (+ `margin`) is free. Paints the floor terrain with the
   * INDOOR bit, reserves the footprint grown by 96 px so props never block a door, and returns the
   * building index (or -1).
   */
  building(
    rng: Rng,
    arch: BuildingArch,
    zone: string,
    floor: Rect,
    opts: { margin?: number; door?: MapSide; force?: boolean } = {},
  ): number {
    const f: Rect = { x: Math.round(floor.x), y: Math.round(floor.y), w: Math.round(floor.w), h: Math.round(floor.h) };
    if (!opts.force && !this.free(f, opts.margin ?? 96)) return -1;
    if (!this.inBounds(f, 64)) return -1;
    const side = opts.door ?? this.roadSide(f) ?? (Math.floor(rng() * 4) as MapSide);
    const built: BuiltBuilding = makeBuilding(rng, arch, zone, f, doorOrder(rng, side));
    for (const w of built.walls) this.rects.push(w);
    for (const w of built.furniture) this.rects.push(w);
    const floorByte = ARCH[arch].floor | TERRAIN_INDOOR;
    this.terrain.paintRect(f, () => floorByte);
    this.reserve(grow(f, 96));
    this.buildings.push(built.building);
    this.furniture.push(built.furniture);
    return this.buildings.length - 1;
  }

  /** Try `tries` random positions for a building of random archetype size inside `area`. */
  scatterBuilding(rng: Rng, arch: BuildingArch, zone: string, area: Rect, tries = 30, margin = 96): number {
    const a = ARCH[arch];
    for (let i = 0; i < tries; i++) {
      const w = Math.round((a.w[0] + rng() * (a.w[1] - a.w[0])) / 32) * 32;
      const h = Math.round((a.h[0] + rng() * (a.h[1] - a.h[0])) / 32) * 32;
      if (w > area.w || h > area.h) continue;
      const x = area.x + Math.floor(rng() * (area.w - w + 1));
      const y = area.y + Math.floor(rng() * (area.h - h + 1));
      const bi = this.building(rng, arch, zone, { x, y, w, h }, { margin });
      if (bi >= 0) return bi;
    }
    return -1;
  }
}

export const ALL = SOLID.ALL;
/** Low cover: you see over it but bullets stop (sandbags, car wrecks, barrels). */
export const LOW = SOLID.MOVE | SOLID.SHOT;
/** Wooden fence: blocks sight, bullets pass (wallbang). */
export const FENCE = SOLID.MOVE | SOLID.SIGHT;
