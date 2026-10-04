/**
 * Sound ring model (WP-S, mobility memo part 5): the pure, Pixi-free half of the Fortnite-style
 * sound visualization. sound-viz.ts feeds it decoded `snd` entries and draws what `list` holds.
 *
 * Kept separate from drawing so placement, merging, the cap, fading and the behind-you test are
 * unit-testable without a GPU (sound-viz.test.ts).
 *
 * Privacy note: hidden sources arrive as (sector, band) only — the ring never knows more than the
 * server chose to reveal, so drawing the exact sector centre leaks nothing.
 */

import {
  SOUND_BAND_ALPHA,
  SOUND_PRIORITY,
  SOUND_VIZ,
  SOUND,
  SoundKind,
  VISION,
  baseSoundRadius,
  isBehind,
  sectorAngle,
  type Band,
  type DecodedSound,
} from "@extract/shared";

const DEG = Math.PI / 180;

export const RING = {
  /** Ring radius = clamp(FRAC · min(screenW, screenH), MIN, MAX) css px. */
  RADIUS_FRAC: 0.18,
  RADIUS_MIN: 110,
  RADIUS_MAX: 190,
  /** Angular width of one arc (sector width is 22.5°, so neighbours stay distinct). */
  ARC_SPAN: 18 * DEG,
  /** Stroke width per band (near → far). */
  BAND_WIDTH: [9, 6, 4] as const,
  /** Behind-you arcs are this much thicker (plus the chevron). */
  BEHIND_WIDTH_MULT: 1.3,
  /** Half-angle of the "you can see it" cone: isBehind's default 90° matches the client cone. */
  BEHIND_HALF_FOV: Math.PI / 2,
  /**
   * A visible source inside this half-cone and on screen gets no marker — you already see it.
   * Slightly inside the client cone (90°) because the cone edge is faded (CONE_FADE_DEG).
   */
  SEEN_HALF_FOV: (VISION.CONE_HALF_DEG - VISION.CONE_FADE_DEG / 2) * DEG,
  /** Pop-in: scale POP_SCALE → 1 over POP_MS (also re-triggered by a merge, so steps pulse). */
  POP_MS: 120,
  POP_SCALE: 1.25,
  /** Fade exponent: alpha = bandAlpha · (1 − age/life)^FADE_POW. */
  FADE_POW: 1.5,
  /** Muffled (through a wall) markers are dimmer and drawn dashed. */
  OCCLUDED_ALPHA: 0.6,
  /** Hard cap of simultaneous markers; the least important is evicted. */
  MAX_MARKERS: 12,
  /** Chevron pulse period (ms). */
  CHEVRON_PERIOD_MS: 450,
  /**
   * The behind-you chevron pulses only right after the marker (re)triggers, then holds steady:
   * a dozen markers blinking forever read as noise (playtest).
   */
  CHEVRON_PULSE_MS: 900,
  /** Glyph box (css px); the glyph sits on a dark round badge of BADGE_R with a coloured rim. */
  ICON_PX: 22,
  BADGE_R: 15,
  /**
   * Icons carry WHAT was heard and must stay readable for far / muffled sounds; the arc carries
   * how far (width, alpha) and muffling (dashes). Icon alpha = max(ICON_MIN_ALPHA, band alpha ·
   * occlusion), held for the first ICON_HOLD of the life, then fading linearly to 0.
   */
  ICON_MIN_ALPHA: 0.75,
  ICON_HOLD: 0.45,
} as const;

/** Glyph drawn just outside the arc. Kinds sharing a glyph also share a merge bucket. */
export type RingIcon = "steps" | "burst" | "swirl" | "cross" | "mag" | "chest" | "flag" | "drop" | "skull";

export const ICON_OF: Readonly<Record<SoundKind, RingIcon>> = {
  [SoundKind.step]: "steps",
  [SoundKind.stepBush]: "steps",
  [SoundKind.roll]: "swirl",
  [SoundKind.shot]: "burst",
  [SoundKind.reload]: "mag",
  [SoundKind.heal]: "cross",
  [SoundKind.loot]: "chest",
  [SoundKind.search]: "chest",
  [SoundKind.extract]: "flag",
  [SoundKind.hurt]: "drop",
  [SoundKind.death]: "skull",
  [SoundKind.bodyFall]: "skull",
  [SoundKind.dryFire]: "mag",
  [SoundKind.switch]: "mag",
  // Weapons v2: a grenade blast reads as a bang; the pin / a bounce off a wall as a metal click.
  [SoundKind.explosion]: "burst",
  [SoundKind.grenade]: "mag",
};

export function ringRadius(w: number, h: number): number {
  return Math.min(RING.RADIUS_MAX, Math.max(RING.RADIUS_MIN, RING.RADIUS_FRAC * Math.min(w, h)));
}

/** One marker to add (output of placeSounds). */
export interface RingInput {
  kind: SoundKind;
  /** Screen/world angle (y down, same convention as atan2(dy, dx) in world space). */
  angle: number;
  band: Band;
  occluded: boolean;
  /** Merge bucket: `${icon}:s${sector}` for hidden, `${icon}:${sessionId}` for visible sources. */
  key: string;
  /** Visible source's sessionId (its direction is re-aimed every frame); null for hidden. */
  id: string | null;
}

export interface SoundIndicator extends RingInput {
  /** Last (re)trigger time, ms (performance.now clock). */
  born: number;
  lifeMs: number;
  color: number;
  icon: RingIcon;
}

export interface PlacementEnv {
  /** Local sessionId: own sounds are never shown. */
  selfId: string;
  selfX: number;
  selfY: number;
  aim: number;
  /** World position of a visible player (state.players), null if not (or no longer) synced. */
  playerPos(id: string): { x: number; y: number } | null;
  /** Whether a world point is inside the screen. */
  onScreen(x: number, y: number): boolean;
}

/** Band of a visible source from its real distance (same thresholds as quantizeSound). */
export function bandOfDistance(d: number, radius: number): Band {
  const q = radius > 0 ? d / radius : 1;
  return q < SOUND.BANDS[0] ? 0 : q < SOUND.BANDS[1] ? 1 : 2;
}

/**
 * Decoded sounds → ring markers.
 * - Hidden: the centre of the server's sector, with its band and occlusion.
 * - Visible: the exact direction to the entity we render; skipped when it is our own sound, when
 *   the entity is unknown, or when it is on screen inside the vision cone (you can see it).
 */
export function placeSounds(sounds: readonly DecodedSound[], env: PlacementEnv): RingInput[] {
  const out: RingInput[] = [];
  for (const s of sounds) {
    const icon = ICON_OF[s.kind];
    if (!icon) continue;
    if (s.hidden) {
      out.push({ kind: s.kind, angle: sectorAngle(s.a), band: s.b, occluded: s.occluded, key: `${icon}:s${s.a}`, id: null });
      continue;
    }
    if (s.id === env.selfId) continue;
    const p = env.playerPos(s.id);
    if (!p) continue;
    const dx = p.x - env.selfX;
    const dy = p.y - env.selfY;
    const d = Math.hypot(dx, dy);
    // On top of us: no meaningful direction (and certainly visible).
    if (d < 1) continue;
    const angle = Math.atan2(dy, dx);
    if (env.onScreen(p.x, p.y) && !isBehind(angle, env.aim, RING.SEEN_HALF_FOV)) continue;
    const band = bandOfDistance(d, baseSoundRadius(s.kind, s.variant));
    out.push({ kind: s.kind, angle, band, occluded: false, key: `${icon}:${s.id}`, id: s.id });
  }
  return out;
}

/** Visual state of one marker at `now`; null once it has faded out. */
export interface IndicatorStyle {
  /** Arc alpha: band × occlusion × fade. */
  alpha: number;
  /** Badge / icon / chevron alpha: slower fade, floored so far sounds stay legible. */
  iconAlpha: number;
  width: number;
  scale: number;
  behind: boolean;
}

export function indicatorStyle(ind: SoundIndicator, now: number, aim: number): IndicatorStyle | null {
  const age = now - ind.born;
  if (age >= ind.lifeMs) return null;
  const t = Math.max(0, age) / ind.lifeMs;
  let strength = SOUND_BAND_ALPHA[ind.band];
  if (ind.occluded) strength *= RING.OCCLUDED_ALPHA;
  const alpha = strength * Math.pow(1 - t, RING.FADE_POW);
  const iconFade = t <= RING.ICON_HOLD ? 1 : (1 - t) / (1 - RING.ICON_HOLD);
  const iconAlpha = Math.max(RING.ICON_MIN_ALPHA, strength) * iconFade;
  const behind = isBehind(ind.angle, aim, RING.BEHIND_HALF_FOV);
  const width = RING.BAND_WIDTH[ind.band] * (behind ? RING.BEHIND_WIDTH_MULT : 1);
  const pop = Math.min(1, Math.max(0, age) / RING.POP_MS);
  const scale = RING.POP_SCALE + (1 - RING.POP_SCALE) * pop;
  return { alpha, iconAlpha, width, scale, behind };
}

/** Pulsing chevron alpha multiplier (0.55..1). */
export function chevronPulse(now: number): number {
  return 0.775 + 0.225 * Math.sin((now / RING.CHEVRON_PERIOD_MS) * Math.PI * 2);
}

/**
 * Chevron alpha multiplier for a marker of age `ageMs`: starts at 1, dips to 0.55 and back for
 * CHEVRON_PULSE_MS after a (re)trigger, then stays at 1 (a footstep run re-pulses with each step).
 */
export function chevronAlpha(ageMs: number): number {
  if (!(ageMs >= 0) || ageMs >= RING.CHEVRON_PULSE_MS) return 1;
  return 0.775 + 0.225 * Math.cos((ageMs / RING.CHEVRON_PERIOD_MS) * Math.PI * 2);
}

/**
 * Live markers: push (with merge), prune, re-aim, cap. Arrays are reused; `list` is read by the
 * drawer every frame.
 */
export class SoundIndicators {
  readonly list: SoundIndicator[] = [];

  constructor(private readonly max: number = RING.MAX_MARKERS) {}

  /**
   * Add a marker or refresh the one in the same bucket. A refresh restarts the timer (and the
   * pop, so repeated footsteps pulse instead of stacking), keeps the stronger band and the
   * clearer (non-occluded) reading, and takes the newest kind/direction.
   */
  push(input: RingInput, now: number): SoundIndicator {
    const viz = SOUND_VIZ[input.kind];
    const icon = ICON_OF[input.kind];
    const existing = this.list.find((m) => m.key === input.key);
    if (existing) {
      const alive = now - existing.born < existing.lifeMs;
      existing.band = alive ? (Math.min(existing.band, input.band) as Band) : input.band;
      existing.occluded = alive ? existing.occluded && input.occluded : input.occluded;
      existing.kind = input.kind;
      existing.angle = input.angle;
      existing.color = viz.color;
      existing.icon = icon;
      existing.lifeMs = viz.lifeMs;
      existing.born = now;
      return existing;
    }
    const m: SoundIndicator = { ...input, born: now, lifeMs: viz.lifeMs, color: viz.color, icon };
    this.list.push(m);
    if (this.list.length > this.max) this.evict(now);
    return m;
  }

  /** Drop expired markers; returns how many remain. */
  prune(now: number): number {
    let w = 0;
    for (const m of this.list) if (now - m.born < m.lifeMs) this.list[w++] = m;
    this.list.length = w;
    return w;
  }

  clear(): void {
    this.list.length = 0;
  }

  /**
   * Over the cap: drop the least important marker — lowest SOUND_PRIORITY, then the one closest
   * to fading out. The new marker competes too: a fresh footstep must not push out a gunshot, and
   * on equal priority it has the most life left so an older marker goes first.
   */
  private evict(now: number): void {
    let victim = -1;
    let vp = Infinity;
    let vLeft = Infinity;
    for (let i = 0; i < this.list.length; i++) {
      const m = this.list[i]!;
      const p = SOUND_PRIORITY[m.kind];
      const left = m.lifeMs - (now - m.born);
      if (p < vp || (p === vp && left < vLeft)) {
        victim = i;
        vp = p;
        vLeft = left;
      }
    }
    if (victim >= 0) this.list.splice(victim, 1);
  }
}
