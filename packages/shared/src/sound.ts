/**
 * One sound contract (critique "Sound contract"): mobility's quantized format. The server decides
 * per listener whether the source is visible:
 * - hidden sources → [kind, sector 0..15, band | occluded<<2, variant]  (NO coordinates, NO ids)
 * - visible sources → [kind, sessionId, variant]  (the client places it on the entity it renders)
 * Sounds travel as the `snd` field of the per-client batched `ev` message (protocol.ts EventsMsg).
 * Every radius is multiplied by sampleEnv().hear; footsteps also by surfaceOf(terrain).stepRangeMult.
 * Occlusion: one server ray against the walls-only index; an occluded source counts as
 * OCCLUSION_MULT× farther. Audio (immersion) and the sound ring (mobility) both consume decodeSoundMsg.
 */

import { WEAPONS, WEAPON_IDS, type WeaponId } from "./items.js";

export const SoundKind = {
  step: 0,
  stepBush: 1,
  roll: 2,
  shot: 3,
  reload: 4,
  heal: 5,
  loot: 6,
  search: 7,
  extract: 8,
  hurt: 9,
  death: 10,
  bodyFall: 11,
  dryFire: 12,
  switch: 13,
} as const;
export type SoundKind = (typeof SoundKind)[keyof typeof SoundKind];
export const SOUND_KIND_COUNT = 14;

export const SOUND = {
  /** A footstep fires every this many px of non-roll travel (run ≈ 2.2/s, walk ≈ 1.1/s). */
  STEP_EVERY_PX: 120,
  /** Base radii (px) before env.hear (and stepRangeMult for steps). Shots: WEAPONS[w].soundRadius. */
  RADIUS: {
    step: 800,
    stepWalk: 180,
    stepBush: 1100,
    stepBushWalk: 400,
    roll: 900,
    reload: 500,
    heal: 450,
    /** Container opened (chest/loot). */
    loot: 900,
    search: 600,
    extract: 2400,
    hurt: 700,
    death: 1400,
    bodyFall: 750,
    dryFire: 250,
    switch: 300,
  },
  /** Repeat intervals for channelled sounds, ms. */
  SEARCH_REPEAT_MS: 1500,
  EXTRACT_REPEAT_MS: 2500,
  /** A wall between source and listener multiplies the effective distance. */
  OCCLUSION_MULT: 1.6,
  SECTORS: 16,
  /** Band upper bounds as a fraction of the radius. */
  BANDS: [0.33, 0.66, 1] as const,
  /** Per listener per tick, kept by SOUND_PRIORITY. */
  MAX_PER_TICK: 16,
} as const;

/** Gunshot radius of a weapon (variant of shot sounds = WEAPON_IDS index). */
export function shotRadius(w: WeaponId): number {
  return WEAPONS[w].soundRadius;
}
export function weaponVariant(w: WeaponId): number {
  return WEAPON_IDS.indexOf(w);
}

/**
 * Base hearing radius of one emitted sound, before env.hear and (steps only) the surface
 * stepRangeMult. One lookup for the server emitter and the bots' hearing so they cannot drift.
 * `variant` is the weapon index for shots (weaponVariant); `walk` picks the quiet step radii.
 */
export function baseSoundRadius(kind: SoundKind, variant = 0, walk = false): number {
  const R = SOUND.RADIUS;
  switch (kind) {
    case SoundKind.step: return walk ? R.stepWalk : R.step;
    case SoundKind.stepBush: return walk ? R.stepBushWalk : R.stepBush;
    case SoundKind.shot: {
      const w = WEAPON_IDS[variant];
      return w ? WEAPONS[w].soundRadius : WEAPONS.pistol.soundRadius;
    }
    case SoundKind.roll: return R.roll;
    case SoundKind.reload: return R.reload;
    case SoundKind.heal: return R.heal;
    case SoundKind.loot: return R.loot;
    case SoundKind.search: return R.search;
    case SoundKind.extract: return R.extract;
    case SoundKind.hurt: return R.hurt;
    case SoundKind.death: return R.death;
    case SoundKind.bodyFall: return R.bodyFall;
    case SoundKind.dryFire: return R.dryFire;
    case SoundKind.switch: return R.switch;
  }
  return 0;
}

/** Effective radius: base × env hear × surface multiplier (pass 1 for non-step sounds). */
export function effectiveSoundRadius(base: number, envHear: number, stepRangeMult = 1): number {
  return base * envHear * stepRangeMult;
}

/** Higher = kept first when over SOUND.MAX_PER_TICK. */
export const SOUND_PRIORITY: Readonly<Record<SoundKind, number>> = {
  0: 3, 1: 3, 2: 5, 3: 8, 4: 2, 5: 2, 6: 4, 7: 4, 8: 7, 9: 6, 10: 9, 11: 6, 12: 2, 13: 1,
};

/** Client presentation (ring life ms, color). */
export const SOUND_VIZ: Readonly<Record<SoundKind, { lifeMs: number; color: number }>> = {
  0: { lifeMs: 700, color: 0xffffff },
  1: { lifeMs: 800, color: 0xb6f09c },
  2: { lifeMs: 900, color: 0xbfe3ff },
  3: { lifeMs: 1400, color: 0xff5a3c },
  4: { lifeMs: 1200, color: 0xffd54a },
  5: { lifeMs: 1200, color: 0xffd54a },
  6: { lifeMs: 1500, color: 0xffb300 },
  7: { lifeMs: 1500, color: 0xffb300 },
  8: { lifeMs: 3000, color: 0x4cff7a },
  9: { lifeMs: 900, color: 0xff2d55 },
  10: { lifeMs: 2500, color: 0xff2d55 },
  11: { lifeMs: 1200, color: 0xff2d55 },
  12: { lifeMs: 700, color: 0xffd54a },
  13: { lifeMs: 700, color: 0xffd54a },
};
export const SOUND_BAND_GAIN = [1.0, 0.5, 0.22] as const;
export const SOUND_BAND_ALPHA = [1.0, 0.7, 0.45] as const;

export type Band = 0 | 1 | 2;
export interface Heard {
  /** Direction sector 0..SECTORS-1 (sector k centred on angle k·2π/SECTORS). */
  a: number;
  b: Band;
  occluded: boolean;
}

/**
 * Direction sector + distance band of a sound as heard from (lx,ly); null = inaudible.
 * Moving the source anywhere inside one (sector, band) bucket yields identical output.
 */
export function quantizeSound(
  lx: number, ly: number, sx: number, sy: number, radius: number, occluded: boolean,
): Heard | null {
  const dx = sx - lx;
  const dy = sy - ly;
  const d = Math.hypot(dx, dy) * (occluded ? SOUND.OCCLUSION_MULT : 1);
  if (!(radius > 0) || d > radius) return null;
  const q = d / radius;
  const b: Band = q < SOUND.BANDS[0] ? 0 : q < SOUND.BANDS[1] ? 1 : 2;
  const step = (Math.PI * 2) / SOUND.SECTORS;
  const a = ((Math.round(Math.atan2(dy, dx) / step) % SOUND.SECTORS) + SOUND.SECTORS) % SOUND.SECTORS;
  return { a, b, occluded };
}

export function sectorAngle(a: number): number {
  return (a * Math.PI * 2) / SOUND.SECTORS;
}

/** Representative distance fraction of a band (audio placement, bot investigate target). */
export function bandMid(b: Band): number {
  return b === 0 ? 0.17 : b === 1 ? 0.5 : 0.83;
}

/** Outside the forward vision cone (default 180°): the ring draws a behind-you chevron. */
export function isBehind(angle: number, aim: number, halfFov = Math.PI / 2): boolean {
  let d = (angle - aim) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return Math.abs(d) > halfFov;
}

/** `snd` payload. Packed arrays: ~6 B per hidden event with msgpack. */
export interface SoundMsg {
  /** Hidden sources, stride 4: [kind, sector, band | (occluded ? 4 : 0), variant]. */
  h?: number[];
  /** Visible sources, stride 3: [kind, sourceSessionId, variant]. */
  v?: Array<number | string>;
}

export type DecodedSound =
  | { kind: SoundKind; hidden: true; a: number; b: Band; occluded: boolean; variant: number }
  | { kind: SoundKind; hidden: false; id: string; variant: number };

/** Server: append a hidden entry. */
export function pushHiddenSound(m: SoundMsg, kind: SoundKind, heard: Heard, variant: number): void {
  (m.h ??= []).push(kind, heard.a, heard.b | (heard.occluded ? 4 : 0), variant);
}

/** Server: append a visible entry. */
export function pushVisibleSound(m: SoundMsg, kind: SoundKind, sessionId: string, variant: number): void {
  (m.v ??= []).push(kind, sessionId, variant);
}

export function soundMsgEmpty(m: SoundMsg): boolean {
  return !(m.h && m.h.length) && !(m.v && m.v.length);
}

/** Validating decoder (malformed entries are skipped, never thrown on). */
export function decodeSoundMsg(m: SoundMsg | undefined | null): DecodedSound[] {
  const out: DecodedSound[] = [];
  const isKind = (k: unknown): k is SoundKind => typeof k === "number" && Number.isInteger(k) && k >= 0 && k < SOUND_KIND_COUNT;
  const h = Array.isArray(m?.h) ? m!.h : [];
  for (let i = 0; i + 3 < h.length; i += 4) {
    const kind = h[i], a = h[i + 1]!, bo = h[i + 2]!, variant = h[i + 3]!;
    // Integers only: a float sector or band field means a corrupted / forged payload.
    if (!isKind(kind) || !Number.isInteger(a) || !(a >= 0 && a < SOUND.SECTORS)) continue;
    if (!Number.isInteger(bo) || bo < 0 || bo > 7 || (bo & 3) === 3) continue;
    const b = bo & 3;
    out.push({ kind, hidden: true, a, b: b as Band, occluded: (bo & 4) !== 0, variant: typeof variant === "number" ? variant : 0 });
  }
  const v = Array.isArray(m?.v) ? m!.v : [];
  for (let i = 0; i + 2 < v.length; i += 3) {
    const kind = v[i], id = v[i + 1], variant = v[i + 2];
    if (!isKind(kind) || typeof id !== "string") continue;
    out.push({ kind, hidden: false, id, variant: typeof variant === "number" ? variant : 0 });
  }
  return out;
}
