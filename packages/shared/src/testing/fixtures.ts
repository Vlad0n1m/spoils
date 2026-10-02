/**
 * Hand-built MapData for shared unit tests. Tests must not depend on the map generator (owned and
 * changed by the map agent), so vision / occluder / sound tests build their geometry here.
 * Test-only: src/testing/** is excluded from the build (tsconfig) and never exported from index.ts.
 */

import { MAP_GEN_VERSION } from "../constants.js";
import type { SolidMask } from "../geometry.js";
import type { CircleKind, MapCircle, MapData, MapRect, PropKind } from "../map/types.js";

export interface FixtureRect {
  x: number;
  y: number;
  w: number;
  h: number;
  f: SolidMask;
  k?: PropKind;
}
export interface FixtureCircle {
  x: number;
  y: number;
  r: number;
  f: SolidMask;
  k?: CircleKind;
}

export function fixtureMap(
  width: number,
  height: number,
  rects: readonly FixtureRect[],
  circles: readonly FixtureCircle[] = [],
  bushes: ReadonlyArray<{ x: number; y: number; r: number }> = [],
): MapData {
  const cell = 64;
  const cols = Math.ceil(width / cell), rows = Math.ceil(height / cell);
  return {
    id: "steppe",
    genVersion: MAP_GEN_VERSION,
    seed: 0,
    width,
    height,
    terrain: new Uint8Array(cols * rows),
    terrainCols: cols,
    terrainRows: rows,
    terrainCell: cell,
    zones: [],
    roads: [],
    river: [],
    rects: rects.map((r): MapRect => ({ x: r.x, y: r.y, w: r.w, h: r.h, f: r.f, k: r.k ?? "wall" })),
    circles: circles.map((c): MapCircle => ({ x: c.x, y: c.y, r: c.r, f: c.f, k: c.k ?? "rock" })),
    bushes: bushes.map((b) => ({ ...b })),
    decals: [],
    buildings: [],
    containers: [],
    lootSpots: [],
    spawns: [],
    extracts: [],
    bosses: [],
    ambient: [],
  };
}
