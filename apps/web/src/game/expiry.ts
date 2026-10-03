/**
 * WORLD v6 (addendum A6): loose ground items vanish WORLD.GROUND_EXPIRE_MS after they hit the
 * ground, corpses WORLD.CORPSE_EXPIRE_MS after death (GroundItem.expiresAt / Corpse.expiresAt, match
 * clock, 0 = never). The client blinks them in their last WORLD.EXPIRE_WARN_MS and lets an expired
 * one fade out a little slower than a normal removal. Pure: the renderer multiplies the alpha.
 */

import { WORLD } from "@extract/shared";

/** Blink period (ms of match clock) in the last minute, and in the last BLINK_FAST_LAST_MS. */
export const BLINK_PERIOD_MS = 1_000;
export const BLINK_FAST_PERIOD_MS = 500;
export const BLINK_FAST_LAST_MS = 15_000;
/** Lowest alpha factor of a blink (never fully invisible: it is still there and lootable). */
export const BLINK_MIN = 0.3;
/** Fade time constant of an expired item / corpse (normal removals use FOG.FADE_MS = 150). */
export const EXPIRE_FADE_TAU_MS = 260;
/** A removal this close to (or after) expiresAt counts as an expiry (server tick + clock drift). */
const EXPIRE_SLACK_MS = 1_500;

/**
 * Alpha factor 0..1 for an entity with `expiresAt` at match clock `clockMs`: 1 outside the warning
 * window (or when it never expires), a cosine blink between BLINK_MIN and 1 inside it, faster in the
 * last BLINK_FAST_LAST_MS. The phase follows the match clock, so every client blinks alike.
 */
export function expiryBlink(expiresAt: number | undefined, clockMs: number): number {
  if (!expiresAt || !(expiresAt > 0)) return 1;
  const left = expiresAt - clockMs;
  if (left > WORLD.EXPIRE_WARN_MS) return 1;
  if (left <= 0) return BLINK_MIN;
  const period = left <= BLINK_FAST_LAST_MS ? BLINK_FAST_PERIOD_MS : BLINK_PERIOD_MS;
  const wave = 0.5 + 0.5 * Math.cos((2 * Math.PI * (((clockMs % period) + period) % period)) / period);
  return BLINK_MIN + (1 - BLINK_MIN) * wave;
}

/** Was a removal at `clockMs` the expiry (slow fade) rather than a pick-up / AOI exit? */
export function expiryFading(expiresAt: number | undefined, clockMs: number): boolean {
  return !!expiresAt && expiresAt > 0 && clockMs >= expiresAt - EXPIRE_SLACK_MS;
}
