/**
 * Footstep cadence and material selection (pure, unit-tested in footsteps.test.ts).
 *
 * Cadence: one step every STEP_EVERY_PX of travel, the same rule the server uses to emit `step`
 * sounds (critique.md: "A footstep fires every 120 px"), so what you hear from yourself matches what
 * others hear from you. At 260 px/s that is about 2.2 steps/s; walking (×0.5) about 1.1/s.
 *
 * Material: the map's 64 px terrain grid is the only surface grid. Its code maps to one of the six
 * baked step materials; remote steps arrive with the material as the sound `variant`.
 */
import { STEP_MATERIALS, type SfxId, type StepMaterial } from "./recipes";

/** Mirrors packages/shared SOUND.STEP_EVERY_PX (kept local until the v2 shared dist lands). */
export const STEP_EVERY_PX = 120;
/** A single-frame jump this large is a teleport/reconcile snap, not walking: no step burst. */
export const TELEPORT_PX = 400;
/** After standing still this long, the next movement plays its first step after half a stride. */
export const IDLE_RESET_MS = 300;

/**
 * Accumulates travelled distance and says when a footstep lands. At most one step per call: a
 * frame hitch that moves 300 px must not fire a burst of three steps at the same instant.
 */
export class Stride {
  private acc: number;
  private lastMoveAt = -Infinity;
  /** Alternates 0/1 per step, for a tiny left/right pan offset on your own steps. */
  foot: 0 | 1 = 1;

  constructor(readonly stride = STEP_EVERY_PX) {
    this.acc = stride * 0.5;
  }

  /** Feed the distance moved this frame. Returns 1 when a step lands, else 0. */
  add(dist: number, nowMs: number): 0 | 1 {
    if (!(dist > 0) || !Number.isFinite(dist)) return 0;
    if (dist >= TELEPORT_PX) {
      this.reset(nowMs);
      return 0;
    }
    if (nowMs - this.lastMoveAt > IDLE_RESET_MS) this.acc = this.stride * 0.5;
    this.lastMoveAt = nowMs;
    this.acc += dist;
    if (this.acc < this.stride) return 0;
    // Keep only the sub-stride remainder so a hitch never queues extra steps.
    this.acc %= this.stride;
    this.foot = this.foot === 0 ? 1 : 0;
    return 1;
  }

  /** Rolls and teleports restart the cadence (the roll has its own sound). */
  reset(nowMs: number): void {
    this.acc = this.stride * 0.5;
    this.lastMoveAt = nowMs;
  }
}

/**
 * Map terrain codes (map.md `TERRAIN`) → baked step material. The INDOOR bit (0x80) is masked off.
 * FOREST is grass with litter; BRIDGE is planks; GRAVEL crunches like dirt; SHALLOW is a ford.
 */
export const TERRAIN_STEP_MATERIAL: Readonly<Record<number, StepMaterial>> = {
  0: "grass", // GRASS
  1: "grass", // FOREST
  2: "dirt", // DIRT
  3: "asphalt", // ASPHALT
  4: "concrete", // CONCRETE
  5: "wood", // WOOD
  6: "water", // WATER
  7: "wood", // BRIDGE
  8: "dirt", // GRAVEL
  9: "water", // SHALLOW
};
export const INDOOR_BIT = 0x80;

export function materialOfTerrain(terrain: number): StepMaterial {
  return TERRAIN_STEP_MATERIAL[terrain & ~INDOOR_BIT & 0xff] ?? "grass";
}

export function isIndoorTerrain(terrain: number): boolean {
  return (terrain & INDOOR_BIT) !== 0;
}

/**
 * Material from a wire `variant`. Accepts a material name, or an index into STEP_MATERIALS.
 * Unknown values fall back to dirt (neutral, never silent).
 */
export function materialFromVariant(v: number | string | undefined): StepMaterial {
  if (typeof v === "string") return (STEP_MATERIALS as readonly string[]).includes(v) ? (v as StepMaterial) : "dirt";
  if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v < STEP_MATERIALS.length) return STEP_MATERIALS[v]!;
  return "dirt";
}

export function stepSoundId(m: StepMaterial): SfxId {
  return `step_${m}` as SfxId;
}

/** Hearing-range multiplier per material (immersion memo); harder/wetter surfaces carry further. */
export const STEP_RANGE_MULT: Readonly<Record<StepMaterial, number>> = {
  grass: 0.85,
  dirt: 1,
  asphalt: 1.1,
  wood: 1.25,
  concrete: 1.1,
  water: 1.3,
};

/** Your own steps sit 8 dB under remote ones (-22 vs -14): you know where you are. */
export const SELF_STEP_DB = -8;
/** Shift-walk is the quiet mode; make it audibly softer too. */
export const WALK_STEP_DB = -6;
/** Wet outdoor ground layers a splash under the step. */
export const WET_LAYER_DB = -8;
export const WET_THRESHOLD = 0.5;
/** Bush rustle layered over a step taken inside a bush (stepBush sound kind). */
export const BUSH_LAYER_DB = -2;

export interface StepContext {
  material: StepMaterial;
  /** EnvSample.wetness 0..1. */
  wetness?: number;
  indoor?: boolean;
  bush?: boolean;
  self?: boolean;
  walking?: boolean;
}

export interface Layer {
  id: SfxId;
  /** dB offset on top of the sound's own mix level. */
  db: number;
}

/** Which buffers make up one footstep and at what relative level. First layer is the main step. */
export function footstepLayers(s: StepContext): Layer[] {
  const base = (s.self ? SELF_STEP_DB : 0) + (s.walking ? WALK_STEP_DB : 0);
  const out: Layer[] = [{ id: stepSoundId(s.material), db: base }];
  if ((s.wetness ?? 0) > WET_THRESHOLD && !s.indoor && s.material !== "water") {
    out.push({ id: "step_water", db: base + WET_LAYER_DB });
  }
  if (s.bush) out.push({ id: "rustle", db: base + BUSH_LAYER_DB });
  return out;
}
