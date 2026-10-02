/**
 * Terrain byte → footstep material and hearing-range multiplier. The terrain grid (MapData.terrain,
 * 64 px) is the ONLY surface grid (critique: immersion's surfaces.ts is dropped). Used by the
 * server footstep emitter (sound variant = material index) and by client audio.
 * Lives in its own file (contract owner) so map/query.ts can be replaced by the map agent freely.
 */

import { STEP_MATERIALS, TERRAIN, TERRAIN_INDOOR, TERRAIN_KIND_MASK, type StepMaterial, type Terrain } from "./types.js";

export interface SurfaceInfo {
  material: StepMaterial;
  /** Index into STEP_MATERIALS: the `variant` of step sounds. */
  variant: number;
  /** Multiplies the step hearing radius (wood and water are loud, grass is soft). */
  stepRangeMult: number;
}

const mat = (m: StepMaterial, stepRangeMult: number): SurfaceInfo =>
  Object.freeze({ material: m, variant: STEP_MATERIALS.indexOf(m), stepRangeMult });

/** Indexed by Terrain kind. Numbers from the immersion memo's SURFACE_STEP_RANGE (+ gravel). */
const SURFACES: readonly SurfaceInfo[] = (() => {
  const t: SurfaceInfo[] = [];
  t[TERRAIN.GRASS] = mat("grass", 0.85);
  t[TERRAIN.FOREST] = mat("forest", 1.0);
  t[TERRAIN.DIRT] = mat("dirt", 1.0);
  t[TERRAIN.ASPHALT] = mat("asphalt", 1.1);
  t[TERRAIN.CONCRETE] = mat("concrete", 1.1);
  t[TERRAIN.WOOD] = mat("wood", 1.25);
  t[TERRAIN.WATER] = mat("water", 1.3);
  t[TERRAIN.BRIDGE] = mat("wood", 1.25);
  t[TERRAIN.GRAVEL] = mat("gravel", 1.15);
  t[TERRAIN.SHALLOW] = mat("water", 1.3);
  return Object.freeze(t);
})();

/** Accepts a raw terrain byte (the INDOOR bit is ignored). Unknown kinds fall back to grass. */
export function surfaceOf(terrainByte: number): SurfaceInfo {
  return SURFACES[terrainByte & TERRAIN_KIND_MASK] ?? SURFACES[TERRAIN.GRASS]!;
}

export function terrainKind(terrainByte: number): Terrain {
  return (terrainByte & TERRAIN_KIND_MASK) as Terrain;
}

export function isIndoorByte(terrainByte: number): boolean {
  return (terrainByte & TERRAIN_INDOOR) !== 0;
}
