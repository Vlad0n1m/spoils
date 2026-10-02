/**
 * Pure positional-audio math (no Web Audio here, unit-tested in spatial.test.ts).
 *
 * The camera never rotates, so stereo pan follows world dx and "behind" is relative to the aim
 * angle, matching the 180° vision cone. PannerNode/HRTF would cost more and sounds odd top-down.
 *
 * Two kinds of sources (critique.md, "Audio engines" + "Sound contract"):
 *  - visible sources: exact dx/dy is known → `spatialize()` (immersion formulas);
 *  - hidden sources: the server only sends (sector 0..15, band 0..2, occluded) so fog of war does not
 *    leak positions → `spatializeHidden()` (pan = 0.8·cos, band gain, lowpass when behind/occluded).
 *
 * Angles use the screen convention (y down): atan2(dy, dx), so 0 = right, +π/2 = down.
 */

export interface SpatialResult {
  /** Linear gain multiplier, 0..1. */
  gain: number;
  /** StereoPanner value, -1..1. */
  pan: number;
  /** Lowpass cutoff, Hz. */
  cutoff: number;
  /** Use the `_far` take of the sound when one exists. */
  far: boolean;
}

/** Inside this distance a sound plays at full gain and full brightness. */
export const NEAR_PX = 120;
/** dx at which pan reaches full side (before the 0.85 width factor). */
export const PAN_SPAN_PX = 700;
export const PAN_WIDTH = 0.85;
/** Below this distance pan collapses toward centre so a source on top of you is not hard-panned. */
export const PAN_CENTER_PX = 60;
export const MAX_CUTOFF = 20000;
/** Cutoff ratio at the edge of range: 20 kHz · 0.08 = 1.6 kHz. */
export const EDGE_CUTOFF_RATIO = 0.08;
/** Fraction of range beyond which the far sample is used. */
export const FAR_U = 0.4;
/** Each wall between listener and source multiplies gain by this. */
export const WALL_GAIN = 0.55;
export const WALL_CUTOFF = 2200;
export const MIN_CUTOFF = 250;
/** Behind cue strength at 180° (cutoff ×0.55, gain ×0.85). */
export const BEHIND_CUTOFF_K = 0.45;
export const BEHIND_GAIN_K = 0.15;

/**
 * Mirrors packages/shared sound.ts (SOUND.SECTORS, SOUND_BAND_GAIN, bandMid). Kept local because
 * the shared contract is being rewritten in parallel and apps/web compiles against the built dist;
 * WP-A1 can swap these for the shared imports once the v2 dist lands.
 */
export const SECTORS = 16;
export const BAND_GAIN = [1.0, 0.5, 0.22] as const;
const BAND_MID = [0.17, 0.5, 0.83] as const;
/** Hidden pan width: the sector is quantized to 22.5°, so keep it slightly narrower than visible. */
export const HIDDEN_PAN_WIDTH = 0.8;
/** Hidden sources behind the listener are capped at this cutoff (mobility memo). */
export const HIDDEN_BEHIND_CUTOFF = 3500;

/** Stylized speed of sound for thunder delay (px/s); real speed would make it feel laggy. */
export const THUNDER_SPEED_PX_S = 3000;

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Signed smallest difference a - b, in (-π, π]. */
export function angleDiff(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d <= -Math.PI) d += Math.PI * 2;
  return d;
}

/** 0 when the source is inside the forward 180°, ramping to 1 when directly behind. */
export function behindAmount(sourceAngle: number, facing: number | undefined): number {
  if (facing === undefined || !Number.isFinite(facing)) return 0;
  const ang = Math.abs(angleDiff(sourceAngle, facing));
  return ang <= Math.PI / 2 ? 0 : (ang - Math.PI / 2) / (Math.PI / 2);
}

/** Normalized distance: 0 inside NEAR_PX, 1 at the edge of range. */
export function distanceU(d: number, range: number): number {
  if (range <= NEAR_PX) return 0;
  return clamp((d - NEAR_PX) / (range - NEAR_PX), 0, 1);
}

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

export interface SpatializeInput {
  dx: number;
  dy: number;
  /** Audible range (px), already multiplied by env.hear and the surface multiplier. */
  range: number;
  /** Listener aim angle (radians). Omit for no behind cue (e.g. spectating, UI). */
  facing?: number;
  /** Walls between listener and source (0..3). */
  walls?: number;
  /** Shortcut for walls = 1 when only a boolean is known (server occlusion flag). */
  occluded?: boolean;
}

/**
 * Gain/pan/cutoff for a source at a known offset from the listener, or null when it is out of range
 * (the caller then creates no voice at all).
 *   u = (d - 120)/(range - 120); gain = (1-u)²; cutoff = 20 kHz · 0.08^u
 *   pan = clamp(dx/700) · 0.85 · min(1, d/60)
 *   behind: cutoff ·= 1 - 0.45k, gain ·= 1 - 0.15k
 *   walls:  gain ·= 0.55^walls, cutoff ≤ 2200 · 0.4^(walls-1), floor 250 Hz
 */
export function spatialize(i: SpatializeInput): SpatialResult | null {
  const { dx, dy, range } = i;
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || !(range > 0)) return null;
  const d = Math.hypot(dx, dy);
  if (d >= range) return null;
  const u = distanceU(d, range);
  let gain = (1 - u) * (1 - u);
  let cutoff = MAX_CUTOFF * Math.pow(EDGE_CUTOFF_RATIO, u);
  const pan = clamp(dx / PAN_SPAN_PX, -1, 1) * PAN_WIDTH * Math.min(1, d / PAN_CENTER_PX);

  // A source exactly on the listener has no direction: skip the behind cue.
  const k = d > 0 ? behindAmount(Math.atan2(dy, dx), i.facing) : 0;
  cutoff *= 1 - BEHIND_CUTOFF_K * k;
  gain *= 1 - BEHIND_GAIN_K * k;

  const walls = Math.max(0, Math.floor(i.walls ?? (i.occluded ? 1 : 0)));
  if (walls > 0) {
    gain *= Math.pow(WALL_GAIN, walls);
    cutoff = Math.min(cutoff, WALL_CUTOFF * Math.pow(0.4, walls - 1));
  }
  cutoff = Math.max(MIN_CUTOFF, cutoff);
  return { gain, pan, cutoff, far: u > FAR_U };
}

export interface HiddenInput {
  /** Direction sector 0..SECTORS-1 (0 = +x / right, increasing clockwise on screen). */
  sector: number;
  /** Distance band 0 near, 1 mid, 2 far. */
  band: number;
  occluded?: boolean;
  facing?: number;
}

/** Centre angle of a sector, radians (same convention as shared `sectorAngle`). */
export function sectorAngle(sector: number): number {
  return (sector * Math.PI * 2) / SECTORS;
}

/** The wire packs `band | occluded << 2` into one number (critique.md, Sound contract). */
export function unpackBand(packed: number): { band: 0 | 1 | 2; occluded: boolean } {
  const band = packed & 3;
  return { band: (band > 2 ? 2 : band) as 0 | 1 | 2, occluded: ((packed >> 2) & 1) === 1 };
}

/**
 * Hidden source: no coordinates on the wire, only a sector and a distance band. Pan comes from the
 * sector, gain from the band table, brightness from the band's representative distance; behind and
 * occluded both darken it so the "where is it" cue survives the quantization.
 */
export function spatializeHidden(i: HiddenInput): SpatialResult | null {
  if (!Number.isFinite(i.sector) || !Number.isFinite(i.band)) return null;
  const band = clamp(Math.round(i.band), 0, 2) as 0 | 1 | 2;
  const sector = ((Math.round(i.sector) % SECTORS) + SECTORS) % SECTORS;
  const ang = sectorAngle(sector);
  const u = BAND_MID[band];
  let gain: number = BAND_GAIN[band];
  let cutoff = MAX_CUTOFF * Math.pow(EDGE_CUTOFF_RATIO, u);
  const pan = HIDDEN_PAN_WIDTH * Math.cos(ang);
  const k = behindAmount(ang, i.facing);
  if (k > 0) {
    cutoff = Math.min(cutoff, HIDDEN_BEHIND_CUTOFF);
    gain *= 1 - BEHIND_GAIN_K * k;
  }
  if (i.occluded) {
    gain *= WALL_GAIN;
    cutoff = Math.min(cutoff, WALL_CUTOFF);
  }
  cutoff = Math.max(MIN_CUTOFF, cutoff);
  return { gain, pan, cutoff, far: u > FAR_U };
}

/** Thunder rolls in after the flash: delay (ms) for a strike `d` px away. */
export function thunderDelayMs(d: number): number {
  return Math.max(0, (d / THUNDER_SPEED_PX_S) * 1000);
}
