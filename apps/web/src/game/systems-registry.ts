/**
 * The plug-in systems the renderer creates for every battle (systems.ts contract). Order matters
 * only for drawing into the same layer (earlier = below): weather sits under the screen-space
 * indicators, the full map draws on top of everything in the screen layer.
 */

import { createGameAudioSystem } from "./audio/game-audio";
import { createWeatherSystem } from "./env/weather-fx";
import { DamageArcSystem } from "./entities";
import { createMapOverlaySystem } from "./fullmap";
import { SoundVizSystem } from "./sound-viz";
import type { SystemFactory } from "./systems";

export const SYSTEM_FACTORIES: readonly SystemFactory[] = [
  // Rain / splashes / fog banks / dusk grade (ground + worldTop) and the lightning flash (screen).
  () => createWeatherSystem(),
  // Red arc toward whoever hit the local player (HitMsg.fa), screen layer.
  () => new DamageArcSystem(),
  // Sound ring around the local player (ev.snd), screen layer, above the damage arcs.
  () => new SoundVizSystem(),
  // Full map (M) and the zone toast; drawn last so the opened map covers the indicators.
  () => createMapOverlaySystem(),
  // Positional audio, ambience, own-action cues. Draws nothing.
  () => createGameAudioSystem(),
];
