/**
 * When the outcome overlay (match-outcome-overlay.tsx) may cover the canvas after the local player
 * leaves the map. The CinematicSystem (cinematics.ts) plays its beat on the same state edge that
 * makes the screen show the overlay: the EXTRACTED stamp + auto-sell line, or the death fade, the
 * KILLED BY card and the death-cam pan. The overlay's dim and centred card would hide most of it,
 * so it waits until the beat has landed. Pure (no Pixi): battle-screen imports it.
 */

import type { ExitType } from "@extract/shared";

export type CineExit = "extract" | "death";

/** Hold per beat (ms): stamp + credits are in by ~650 ms; the death fade completes at 2.5 s. */
export const OUTCOME_HOLD_MS: Readonly<Record<CineExit, number>> = { extract: 1200, death: 2500 };

/**
 * Which raid-ending beat is playing. The HUD's own state first (it is what starts the cinematic),
 * else the S2C.OUTCOME exit, which may land before the throttled HUD shows the change. A timeout
 * (legacy) or a "mia" (caught in the wipe, WORLD v6) plays no beat: the wipe ends the map for everyone.
 */
export function cineExitOf(self: { alive: boolean; extractedAt: number } | null, outcomeExit: ExitType | null | undefined): CineExit | null {
  if (self && self.extractedAt > 0) return "extract";
  if (self && !self.alive) return "death";
  if (outcomeExit === "extract") return "extract";
  if (outcomeExit === "dead") return "death";
  return null;
}

/** How long the overlay waits; 0 once the raid is over for everyone or the room is gone. */
export function outcomeHoldMs(exit: CineExit | null, phase: string, disconnected: boolean): number {
  if (!exit || phase === "ended" || disconnected) return 0;
  return OUTCOME_HOLD_MS[exit];
}
