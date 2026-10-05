/**
 * Character animation (presentation only): procedural layers on top of the static top-down
 * character sprites (player.png / boss.png + the held weapon). Humans, marauders, guards and bosses
 * share it; PlayerView (entities.ts) owns one CharAnimator and applies its pose every frame.
 *
 * Layers (each one a weight that eases in and out, so nothing pops):
 *  - gait:   distance-driven step phase (no foot sliding) → body bob with a slight squash/stretch,
 *            a side-to-side weight shift, two boots that step under the body, backpack sway and a
 *            weapon bob; quiet walk (ACT.WALK) takes shorter, lower steps; idle breathes;
 *  - aim:    the gun trails fast aim turns a little (clamped) and settles; recoil stays in
 *            combat-fx (recoilOffset) and is added on top by PlayerView;
 *  - roll:   one eased spin over ROLL.TICKS inputs with a tuck squash (dust: world-fx);
 *  - reload: the gun dips and tilts toward the body, the mag drops out and a new one slams in,
 *            timed to WeaponDef.reloadMs from the moment ACT.RELOAD appears;
 *  - heal:   the gun lowers to the side, the body pulses (green sparkles: PlayerView);
 *  - swap:   the new gun is drawn from the hip with a small overshoot;
 *  - hit:    a flinch away from the bullet with a small twist (the white flash stays combat-fx);
 *  - death:  the body pitches forward face down like the corpse lies (stretch + narrow + darken),
 *            a shoulder first on the side the bullet pushes, the gun skids and spins away, then the corpse sprite takes over (the renderer holds its fade-in).
 *
 * Reduced motion (camera.reducedMotion): no roll spin, a third of the bob, no sway, half the flinch.
 * Everything here is allocation-free per frame: the animator writes into its own `pose`.
 */

import { INPUT_DT_MS, PLAYER, ROLL } from "@extract/shared";

export const ANIM = {
  /** Distance of one full gait cycle (two steps), px: running / quiet walk. */
  STRIDE_PX: 74,
  WALK_STRIDE_PX: 54,
  /** Body scale pulse per step (fraction) at full run / quiet walk. */
  BOB: 0.045,
  WALK_BOB: 0.018,
  /** Side-to-side weight shift, px at full run. */
  SWAY_PX: 1.8,
  /** Boots: fore/aft travel (px, at full run), lateral spread from the centre line, size. */
  FOOT_STRIDE: 17,
  WALK_FOOT_STRIDE: 12,
  FOOT_SPREAD: 14,
  /** Feet sit a little behind the centre, so the trailing boot kicks out past the shoulders. */
  FOOT_BACK: 7,
  /** Shoulder twist per step (rad) at full run: the classic top-down walk cue. */
  TWIST: 0.075,
  /** Backpack swing (rad) at full run. */
  PACK_SWAY: 0.1,
  /** Idle breathing: scale amplitude and period. */
  BREATH: 0.014,
  BREATH_MS: 2600,
  /** Speed / heading / layer smoothing. */
  SPEED_TAU_MS: 70,
  HEADING_TAU_MS: 70,
  LAYER_TAU_MS: 55,
  /** Gun lag behind a fast aim turn: smoothing and clamp (rad). */
  AIM_LAG_TAU_MS: 40,
  AIM_LAG_MAX: 0.2,
  /** Roll: smallest tuck scale (mid roll) and the travel stretch at its start. */
  ROLL_TUCK: 0.76,
  ROLL_STRETCH: 0.1,
  /** Reload: dip angle (rad, toward the body), pull-back (px), mag drop (px). */
  RELOAD_TILT: -0.36,
  RELOAD_PULL_PX: 4,
  MAG_DROP_PX: 16,
  /** Heal: gun lowered to the side (rad / px), pulse period / amplitude. */
  HEAL_TILT: 0.95,
  HEAL_PULL_PX: 9,
  HEAL_PULSE_MS: 620,
  HEAL_PULSE: 0.035,
  /** Weapon swap (draw) length and the holster pose it starts from. */
  SWAP_MS: 260,
  SWAP_TILT: 1.15,
  SWAP_PULL_PX: 15,
  /** Hit flinch. */
  HIT_MS: 220,
  HIT_PX: 5,
  HIT_TWIST: 0.14,
  /** Death: fall time, turn (rad), flatten (perpendicular scale), lengthen, gun skid. */
  DEATH_MS: 560,
  DEATH_TURN: 0.38,
  DEATH_FLAT: 0.82,
  DEATH_LONG: 1.16,
  DEATH_SLIDE_PX: 11,
  DEATH_SKID_PX: 24,
  DEATH_SKID_SPIN: 2.2,
  /** After the fall the body crossfades into the corpse over this long. */
  DEATH_FADE_MS: 260,
} as const;

/** Roll length: ROLL.TICKS applied inputs (matches the server's roll timing). */
export const ROLL_MS = ROLL.TICKS * INPUT_DT_MS;

const TAU = Math.PI * 2;

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const smooth01 = (t: number) => {
  const k = clamp01(t);
  return k * k * (3 - 2 * k);
};
export const easeOutCubic = (t: number) => {
  const k = 1 - clamp01(t);
  return 1 - k * k * k;
};
/** Overshoots ~10 % and settles at 1. */
export const easeOutBack = (t: number) => {
  const k = clamp01(t) - 1;
  const c = 1.70158;
  return 1 + (c + 1) * k * k * k + c * k * k;
};

/** Signed shortest angle from `a` to `b` (−π..π]. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  else if (d <= -Math.PI) d += TAU;
  return d;
}

/** Frame-rate independent ease factor toward a target over `dtMs` with time constant `tauMs`. */
export function follow(dtMs: number, tauMs: number): number {
  if (!(dtMs > 0)) return 0;
  return 1 - Math.exp(-dtMs / tauMs);
}

/** Gait phase (rad, wrapped to 0..2π) after travelling `distPx`; quiet walk takes shorter strides. */
export function gaitAdvance(phase: number, distPx: number, walking: boolean): number {
  const p = phase + (TAU * Math.max(0, distPx)) / (walking ? ANIM.WALK_STRIDE_PX : ANIM.STRIDE_PX);
  return p % TAU;
}

/** Movement intensity 0..1 from speed (px/s): 1 = full run. */
export function moveIntensity(speed: number): number {
  return clamp01(speed / PLAYER.SPEED);
}

/** Body spin while rolling: one turn over the roll, eased so it starts and ends gently. */
export function rollSpin(sinceMs: number): number {
  return TAU * smooth01(sinceMs / ROLL_MS);
}

/** Uniform tuck scale during a roll: 1 → ROLL_TUCK at mid roll → 1. */
export function rollTuck(sinceMs: number): number {
  const t = clamp01(sinceMs / ROLL_MS);
  return 1 - (1 - ANIM.ROLL_TUCK) * Math.sin(Math.PI * t);
}

/** Stretch along the travel at the dive in and on landing (0 mid roll). */
export function rollStretch(sinceMs: number): number {
  const t = clamp01(sinceMs / ROLL_MS);
  if (t <= 0 || t >= 1) return 0;
  return ANIM.ROLL_STRETCH * (t < 0.2 ? Math.sin((Math.PI * t) / 0.2) : t > 0.82 ? Math.sin((Math.PI * (t - 0.82)) / 0.18) * 0.6 : 0);
}

/**
 * Reload curve at progress p (0..1 of WeaponDef.reloadMs) → [tilt rad, pull px, mag]: mag is
 * −1..0 while the old mag drops out (−1 = gone), 0 hidden, 0..1 while the new one slides in and
 * seats (1 = seated, then hidden again). The gun dips in 15 %, flicks up when the mag seats, and
 * comes back over the last 15 %.
 */
export function reloadCurve(p: number, out: { tilt: number; pull: number; mag: number }): void {
  const t = clamp01(p);
  let w: number;
  if (t < 0.15) w = smooth01(t / 0.15);
  else if (t > 0.85) w = 1 - smooth01((t - 0.85) / 0.15);
  else w = 1;
  // The slam: a short upward flick when the new mag seats (62–72 %).
  const slam = t > 0.62 && t < 0.74 ? Math.sin((Math.PI * (t - 0.62)) / 0.12) : 0;
  out.tilt = ANIM.RELOAD_TILT * w + 0.22 * slam;
  out.pull = ANIM.RELOAD_PULL_PX * w - 2 * slam;
  if (t >= 0.18 && t < 0.38) out.mag = -smooth01((t - 0.18) / 0.2);
  else if (t >= 0.45 && t < 0.66) out.mag = smooth01((t - 0.45) / 0.18) || 1e-3;
  else out.mag = 0;
}

/** Weapon draw after a swap, `sinceMs` after it: 1 = holstered, 0 = aiming (with an overshoot). */
export function swapHolster(sinceMs: number): number {
  if (!(sinceMs >= 0) || sinceMs >= ANIM.SWAP_MS) return 0;
  return 1 - easeOutBack(sinceMs / ANIM.SWAP_MS);
}

/** Flinch envelope `sinceMs` after a hit: a 30 ms snap out, a damped return; 0 when over. */
export function hitEnvelope(sinceMs: number): number {
  if (!(sinceMs >= 0) || sinceMs >= ANIM.HIT_MS) return 0;
  if (sinceMs < 30) return sinceMs / 30;
  const k = (sinceMs - 30) / (ANIM.HIT_MS - 30);
  return (1 - k) * (1 - k) * Math.cos(k * Math.PI * 1.5);
}

/** Fall progress `sinceMs` after death: 0 → 1.06 (impact) → settles at 1. */
export function deathFall(sinceMs: number): number {
  if (!(sinceMs > 0)) return 0;
  const t = clamp01(sinceMs / ANIM.DEATH_MS);
  // Tipping over accelerates (gravity), overshoots a little on impact and settles.
  if (t < 0.6) {
    const k = t / 0.6;
    return 1.06 * k * k;
  }
  const k = (t - 0.6) / 0.4;
  return 1 + 0.06 * (1 - k) * Math.cos(k * Math.PI * 2);
}

/** Alpha of the falling body: 1 through the fall, then the crossfade into the corpse. */
export function deathAlpha(sinceMs: number): number {
  if (!(sinceMs > ANIM.DEATH_MS)) return 1;
  return clamp01(1 - (sinceMs - ANIM.DEATH_MS) / ANIM.DEATH_FADE_MS);
}

/** Gun skid distance (px) `sinceMs` after death: thrown, decelerating, stops at the end of the fall. */
export function deathSkid(sinceMs: number): number {
  if (!(sinceMs > 0)) return 0;
  return ANIM.DEATH_SKID_PX * easeOutCubic(sinceMs / (ANIM.DEATH_MS * 0.9));
}

/** The pose the animator writes every frame (offsets in world px, rotations in rad). */
export interface CharPose {
  /** Body container: extra rotation on top of the aim, offset, scale along / across the aim. */
  rot: number;
  dx: number;
  dy: number;
  sx: number;
  sy: number;
  /** Body alpha and darkening (0 = none, 1 = black) for the death fall. */
  alpha: number;
  dark: number;
  /** Weapon (body-local): rotation, x pull-back, y offset, alpha. */
  wRot: number;
  wPull: number;
  wY: number;
  wAlpha: number;
  /** Death: the gun leaves the hands and skids in world space (from the body centre); its rotation is on top of the aim. */
  wDropped: boolean;
  wDropX: number;
  wDropY: number;
  wDropRot: number;
  /** Magazine (see reloadCurve); 0 = hidden. */
  mag: number;
  /** Legs: heading (world rad), boot offsets fore/aft (px) and alpha. */
  legRot: number;
  footL: number;
  footR: number;
  feetAlpha: number;
  /** Backpack swing (rad) and lateral shift (px). */
  packRot: number;
  /** Heal sparkle intensity 0..1 (0 = none). */
  heal: number;
}

export function newPose(): CharPose {
  return {
    rot: 0, dx: 0, dy: 0, sx: 1, sy: 1, alpha: 1, dark: 0,
    wRot: 0, wPull: 0, wY: 0, wAlpha: 1, wDropped: false, wDropX: 0, wDropY: 0, wDropRot: 0,
    mag: 0, legRot: 0, footL: 0, footR: 0, feetAlpha: 1, packRot: 0, heal: 0,
  };
}

/** Per-frame inputs (flags as booleans so the animator stays independent of ACT bit values). */
export interface CharInput {
  x: number;
  y: number;
  aim: number;
  nowMs: number;
  rolling: boolean;
  reloading: boolean;
  healing: boolean;
  walking: boolean;
  reduced: boolean;
}

/**
 * One character's animation state. `update` once per frame after the position is known; the
 * event methods (hit / swap / die) may be called any time. No allocation after construction.
 */
export class CharAnimator {
  readonly pose: CharPose = newPose();
  private lastX = Number.NaN;
  private lastY = Number.NaN;
  private lastAt = 0;
  private speed = 0;
  private phase = 0;
  private heading = 0;
  private headingSet = false;
  private backward = false;
  private lagAim = Number.NaN;
  private rollAt = Number.NEGATIVE_INFINITY;
  private wasRolling = false;
  private reloadAt = Number.NEGATIVE_INFINITY;
  private wasReloading = false;
  /** Reload length for the held weapon (WeaponDef.reloadMs). */
  reloadMs = 1500;
  private reloadW = 0;
  private healW = 0;
  private healAt = 0;
  private swapAt = Number.NEGATIVE_INFINITY;
  private hitAt = Number.NEGATIVE_INFINITY;
  private hitDx = 0;
  private hitDy = 0;
  /** Death: when the fall started (−∞ = alive) and its direction / the gun's throw. */
  deathAt = Number.NEGATIVE_INFINITY;
  private deathAim = 0;
  private fallTwist = 1;
  private dropDir = 0;
  private dropSpin = 1;
  private readonly rl = { tilt: 0, pull: 0, mag: 0 };

  reset(): void {
    this.lastX = this.lastY = this.lagAim = Number.NaN;
    this.speed = this.phase = this.reloadW = this.healW = 0;
    this.headingSet = this.backward = this.wasRolling = this.wasReloading = false;
    this.rollAt = this.reloadAt = this.swapAt = this.hitAt = this.deathAt = Number.NEGATIVE_INFINITY;
    this.hitDx = this.hitDy = 0;
  }

  /** A bullet hit this character, travelling along (dx, dy) (unit or zero). */
  hit(nowMs: number, dx: number, dy: number): void {
    this.hitAt = nowMs;
    this.hitDx = dx;
    this.hitDy = dy;
  }

  /** The held weapon changed to another real weapon: play the draw. */
  swap(nowMs: number): void {
    this.swapAt = nowMs;
  }

  /** Alive → dead: start the fall (away from a recent hit, else backward from the aim). */
  die(nowMs: number, aim: number): void {
    if (this.deathAt > Number.NEGATIVE_INFINITY) return;
    this.deathAt = nowMs;
    this.deathAim = aim;
    // The body falls forward, face down, like the corpse sprite lies (head along the death aim); a
    // recent hit decides which shoulder goes first (it twists with the bullet).
    const recent = nowMs - this.hitAt < 600 && (this.hitDx !== 0 || this.hitDy !== 0);
    const cross = recent ? Math.cos(aim) * this.hitDy - Math.sin(aim) * this.hitDx : 1;
    this.fallTwist = cross >= 0 ? 1 : -1;
    // The gun flies out forward and to the side the body twists away from, spinning.
    this.dropSpin = -this.fallTwist;
    this.dropDir = aim - 0.55 * this.fallTwist;
  }

  revive(): void {
    this.deathAt = Number.NEGATIVE_INFINITY;
  }

  get dying(): boolean {
    return this.deathAt > Number.NEGATIVE_INFINITY;
  }

  /** The fall and the crossfade are over (the corpse sprite has taken over). */
  deathDone(nowMs: number): boolean {
    return this.dying && nowMs - this.deathAt >= ANIM.DEATH_MS + ANIM.DEATH_FADE_MS;
  }

  update(i: CharInput): CharPose {
    const o = this.pose;
    const now = i.nowMs;
    const dt = Number.isFinite(this.lastX) ? Math.min(100, Math.max(0, now - this.lastAt)) : 0;
    let dist = 0;
    let mvx = 0;
    let mvy = 0;
    if (Number.isFinite(this.lastX)) {
      mvx = i.x - this.lastX;
      mvy = i.y - this.lastY;
      dist = Math.hypot(mvx, mvy);
      // Teleports (respawn, pooled view reuse, snapshot jumps) are not steps.
      if (dist > 120) dist = mvx = mvy = 0;
    }
    this.lastX = i.x;
    this.lastY = i.y;
    this.lastAt = now;
    if (dt > 0) this.speed += ((dist * 1000) / dt - this.speed) * follow(dt, ANIM.SPEED_TAU_MS);
    const move = i.rolling ? 0 : moveIntensity(this.speed);

    // ---- event edges
    if (i.rolling && !this.wasRolling) this.rollAt = now;
    this.wasRolling = i.rolling;
    if (i.reloading && !this.wasReloading) this.reloadAt = now;
    this.wasReloading = i.reloading;

    // ---- gait
    if (!i.rolling && dist > 0) this.phase = gaitAdvance(this.phase, dist, i.walking);
    if (dist > 0.3 && !i.rolling) {
      const mv = Math.atan2(mvy, mvx);
      // Backpedalling / strafing far from the aim: the legs face the aim side and step backward.
      const back = Math.abs(angleDelta(i.aim, mv)) > 1.95;
      const target = back ? mv + Math.PI : mv;
      if (!this.headingSet) {
        this.heading = target;
        this.headingSet = true;
      } else this.heading += angleDelta(this.heading, target) * follow(dt, ANIM.HEADING_TAU_MS);
      this.backward = back;
    } else if (move < 0.08) {
      if (!this.headingSet) {
        this.heading = i.aim;
        this.headingSet = true;
      } else this.heading += angleDelta(this.heading, i.aim) * follow(dt, ANIM.HEADING_TAU_MS * 3);
    }
    const walkK = i.walking ? 1 : 0;
    const bobAmp = (i.walking ? ANIM.WALK_BOB : ANIM.BOB) * move * (i.reduced ? 0.33 : 1);
    const stepWave = Math.sin(this.phase);
    // Two bumps per cycle (one per step), sharp at push-off.
    const bump = Math.abs(stepWave);
    const breath = (1 - move) * ANIM.BREATH * (0.5 + 0.5 * Math.sin((TAU * now) / ANIM.BREATH_MS)) * (i.reduced ? 0.5 : 1);
    let sx = 1 + bobAmp * bump + breath;
    let sy = 1 + bobAmp * 0.55 * (1 - bump) + breath * 0.6;
    const sway = i.reduced ? 0 : ANIM.SWAY_PX * move * (1 - 0.6 * walkK) * Math.cos(this.phase);
    let dx = -Math.sin(this.heading) * sway;
    let dy = Math.cos(this.heading) * sway;
    const stride = (i.walking ? ANIM.WALK_FOOT_STRIDE : ANIM.FOOT_STRIDE) * Math.min(1, move * 1.4) * (this.backward ? -1 : 1);
    o.footL = stride * stepWave;
    o.footR = -stride * stepWave;
    o.legRot = this.heading;
    o.packRot = (i.reduced ? 0.4 : 1) * ANIM.PACK_SWAY * move * Math.sin(this.phase + 0.6);
    let feetAlpha = 1;

    // ---- aim lag (the gun trails fast turns)
    if (!Number.isFinite(this.lagAim)) this.lagAim = i.aim;
    this.lagAim += angleDelta(this.lagAim, i.aim) * follow(dt, ANIM.AIM_LAG_TAU_MS);
    let lag = angleDelta(i.aim, this.lagAim);
    if (lag > ANIM.AIM_LAG_MAX) lag = ANIM.AIM_LAG_MAX;
    else if (lag < -ANIM.AIM_LAG_MAX) lag = -ANIM.AIM_LAG_MAX;
    if (i.reduced) lag *= 0.5;
    let wRot = lag;
    let wPull = 0;
    let wY = 0.9 * move * Math.cos(this.phase * 2) * (i.reduced ? 0.3 : 1);
    // Shoulders twist with each step; the gun is held steadier than the body.
    let rot = (i.reduced ? 0.3 : 1) * ANIM.TWIST * move * (1 - 0.5 * walkK) * Math.sin(this.phase);
    wRot -= rot * 0.6;

    // ---- roll
    const sinceRoll = now - this.rollAt;
    if (i.rolling || sinceRoll < ROLL_MS) {
      if (!i.reduced) rot += rollSpin(sinceRoll);
      const tuck = rollTuck(sinceRoll);
      const st = rollStretch(sinceRoll);
      sx = tuck * (1 + st);
      sy = tuck * (1 - st * 0.5);
      feetAlpha = 1 - Math.sin(Math.PI * clamp01(sinceRoll / ROLL_MS)) * 1.6;
      if (feetAlpha < 0) feetAlpha = 0;
    }

    // ---- reload
    this.reloadW += ((i.reloading ? 1 : 0) - this.reloadW) * follow(dt, ANIM.LAYER_TAU_MS);
    if (this.reloadW < 1e-3 && !i.reloading) this.reloadW = 0;
    o.mag = 0;
    if (this.reloadW > 0) {
      // Remote flags may outlast our estimate: hold the dipped middle instead of finishing early.
      let p = (now - this.reloadAt) / Math.max(200, this.reloadMs);
      if (i.reloading && p > 0.84) p = 0.84;
      if (!i.reloading && p < 0.85) p = 0.5;
      reloadCurve(p, this.rl);
      // Hands working the gun while the dip holds: a small fast wobble.
      const work = this.rl.mag !== 0 ? 0.06 * Math.sin(now / 55) : 0;
      wRot += (this.rl.tilt + work) * this.reloadW;
      wPull += this.rl.pull * this.reloadW;
      if (i.reloading) o.mag = this.rl.mag;
    }

    // ---- heal
    if (i.healing && this.healW === 0) this.healAt = now;
    this.healW += ((i.healing ? 1 : 0) - this.healW) * follow(dt, ANIM.LAYER_TAU_MS * 1.6);
    if (this.healW < 1e-3 && !i.healing) this.healW = 0;
    if (this.healW > 0) {
      wRot += ANIM.HEAL_TILT * this.healW;
      wPull += ANIM.HEAL_PULL_PX * this.healW;
      const pulse = 0.5 + 0.5 * Math.sin((TAU * (now - this.healAt)) / ANIM.HEAL_PULSE_MS);
      const k = ANIM.HEAL_PULSE * this.healW * pulse * (i.reduced ? 0.5 : 1);
      sx += k;
      sy += k;
    }
    o.heal = this.healW;

    // ---- swap (draw)
    const hol = swapHolster(now - this.swapAt);
    if (hol !== 0) {
      wRot += ANIM.SWAP_TILT * hol;
      wPull += ANIM.SWAP_PULL_PX * hol;
    }

    // ---- hit flinch (away from the shooter along the bullet)
    const he = hitEnvelope(now - this.hitAt) * (i.reduced ? 0.5 : 1);
    if (he !== 0) {
      dx += this.hitDx * ANIM.HIT_PX * he;
      dy += this.hitDy * ANIM.HIT_PX * he;
      // Twist toward the side the bullet pushes: sign of cross(aim, bullet).
      const cross = Math.cos(i.aim) * this.hitDy - Math.sin(i.aim) * this.hitDx;
      rot += (cross >= 0 ? 1 : -1) * ANIM.HIT_TWIST * he;
      sx -= 0.04 * Math.abs(he);
    }

    // ---- death
    o.wDropped = false;
    o.alpha = 1;
    o.dark = 0;
    if (this.dying) {
      const since = now - this.deathAt;
      const f = deathFall(since);
      // Pitch forward: the body stretches along the aim, narrows and shrinks a little (further
      // from the camera), twists a shoulder down and slides toward where the corpse's head lies.
      rot = angleDelta(i.aim, this.deathAim) + this.fallTwist * ANIM.DEATH_TURN * f * (i.reduced ? 0.6 : 1);
      sx = (1 + (ANIM.DEATH_LONG - 1) * f) * (1 - 0.08 * f);
      sy = (1 - (1 - ANIM.DEATH_FLAT) * f) * (1 - 0.08 * f);
      const slide = ANIM.DEATH_SLIDE_PX * Math.min(1, f);
      dx = Math.cos(this.deathAim) * slide;
      dy = Math.sin(this.deathAim) * slide;
      o.alpha = deathAlpha(since);
      o.dark = 0.35 * clamp01(since / ANIM.DEATH_MS);
      feetAlpha = 1 - clamp01(since / (ANIM.DEATH_MS * 0.5));
      o.wDropped = true;
      const skid = deathSkid(since);
      o.wDropX = Math.cos(this.dropDir) * (14 + skid);
      o.wDropY = Math.sin(this.dropDir) * (14 + skid);
      o.wDropRot = angleDelta(i.aim, this.deathAim) + this.dropSpin * ANIM.DEATH_SKID_SPIN * easeOutCubic(since / ANIM.DEATH_MS);
      o.mag = 0;
      o.heal = 0;
      wRot = wPull = wY = 0;
    }

    o.rot = rot;
    o.dx = dx;
    o.dy = dy;
    o.sx = sx;
    o.sy = sy;
    o.wRot = wRot;
    o.wPull = wPull;
    o.wY = wY;
    o.wAlpha = 1;
    o.feetAlpha = feetAlpha;
    return o;
  }
}
