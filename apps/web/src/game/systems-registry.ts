/**
 * The plug-in systems the renderer creates for every battle (systems.ts contract). Order matters
 * only for drawing into the same layer (earlier = below): weather sits under the screen-space
 * indicators, the full map draws on top of everything in the screen layer.
 */

import { createGameAudioSystem } from "./audio/game-audio";
import { createCameraSystem } from "./camera";
import { createCinematicSystem, createHitmarkerSystem, createLowHpSystem } from "./cinematics";
import { createAmbientSystem, createWorldFxSystem } from "./effects";
import { createWeatherSystem } from "./env/weather-fx";
import { DamageArcSystem } from "./entities";
import { createMapOverlaySystem } from "./fullmap";
import { createIntroSystem } from "./intro";
import { SoundVizSystem } from "./sound-viz";
import type { SystemFactory } from "./systems";

export const SYSTEM_FACTORIES: readonly SystemFactory[] = [
  // Rain / splashes / fog banks / dusk grade (ground + worldTop) and the lightning flash (screen).
  () => createWeatherSystem(),
  // Blood decals (ground), shell casings + footstep / roll / body-fall dust (worldFx).
  () => createWorldFxSystem(),
  // Pollen / motes by day, fireflies at night, leaves near forest (worldTop).
  () => createAmbientSystem(),
  // Look-ahead, recoil kick, close-shot shake; the renderer reads its CameraRig. Draws nothing.
  () => createCameraSystem(),
  // Low-HP heartbeat vignette, screen layer, under every indicator.
  () => createLowHpSystem(),
  // Red arc toward whoever hit the local player (HitMsg.fa), screen layer.
  () => new DamageArcSystem(),
  // Sound ring around the local player (ev.snd), screen layer, above the damage arcs.
  () => new SoundVizSystem(),
  // Crosshair hitmarker on dealt hits / kills, screen layer.
  () => createHitmarkerSystem(),
  // Drop-in title card (zone, time, weather, extract countdown) + intro zoom, screen layer.
  () => createIntroSystem(),
  // Extraction letterbox / stamp / auto-sell total and the death cam, screen layer.
  () => createCinematicSystem(),
  // Full map (M) and the zone toast; drawn last so the opened map covers the indicators.
  () => createMapOverlaySystem(),
  // Positional audio, ambience, own-action cues. Draws nothing.
  () => createGameAudioSystem(),
];
