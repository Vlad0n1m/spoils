/**
 * Raid environment (immersion contract): weather, time of day, lightning. Fully determined by
 * BattleState.envSeed / todStartMin / durationMs / weatherOverride and the map size, so the
 * client computes the same sampleEnv from synced state and nothing per-tick goes over the wire.
 * The server samples it for vision (env.vis) and hearing (env.hear).
 */

import {
  WEATHER_KINDS,
  envConfigOf,
  rollRaidTime,
  sampleEnv,
  type EnvConfig,
  type EnvSample,
  type WeatherKind,
} from "@extract/shared";
import type { Match } from "./match.js";

export interface EnvRuntime {
  cfg: EnvConfig;
  /** One sample per clock value: several systems ask within one tick. */
  at: number;
  sample: EnvSample;
}

/**
 * At match creation: pick the raid time from the env seed and write the env fields into state.
 * `override` forces one weather kind for the whole raid (dev / events); invalid values are ignored.
 */
export function initEnvironment(m: Match, envSeed: number, override: string = ""): EnvRuntime {
  const { todStartMin } = rollRaidTime(envSeed);
  m.state.envSeed = envSeed >>> 0;
  m.state.todStartMin = todStartMin;
  m.state.weatherOverride = (WEATHER_KINDS as readonly string[]).includes(override) ? (override as WeatherKind) : "";
  const cfg = envConfigOf(m.state, m.map);
  return { cfg, at: -1, sample: sampleEnv(cfg, 0) };
}

/** Environment at the current match clock (cached per clock value). */
export function envNow(m: Match): EnvSample {
  const env = m.env;
  if (env.at !== m.clock) {
    env.sample = sampleEnv(env.cfg, m.clock);
    env.at = m.clock;
  }
  return env.sample;
}
