/**
 * Deterministic raid environment (immersion memo §2, verbatim contract). No per-tick weather sync:
 * BattleState carries envSeed, todStartMin and weatherOverride; server, bots and clients all call
 * sampleEnv(envConfigOf(state, map), clockMs). Lightning strikes are known in advance, so every
 * side agrees on the flash. Vision uses visionRangeMult(sample.vis); sound radii × sample.hear.
 */
import { mulberry32, pickWeighted, randInt, randRange } from "./rng.js";

export type WeatherKind = "clear" | "cloudy" | "rain" | "fog" | "storm";
export const WEATHER_KINDS: readonly WeatherKind[] = ["clear", "cloudy", "rain", "fog", "storm"];
export type RaidTime = "day" | "dusk" | "night" | "dawn";

export const ENV = {
  /** In-game minutes per real minute: a 30-min raid spans 2 in-game hours. */
  TOD_RATE: 4,
  SEGMENT_MIN_MS: 4 * 60_000,
  SEGMENT_MAX_MS: 8 * 60_000,
  /** Cross-fade between two weather kinds. */
  BLEND_MS: 45_000,
  /** Ground wetness lags the rain. */
  WET_BLEND_MS: 120_000,
  LIGHTNING_MEAN_GAP_MS: 12_000,
  LIGHTNING_MIN_GAP_MS: 2_000,
  LIGHTNING_FLASH_MS: 250,
  /** Stylised speed of sound, used only to delay thunder (px/s). */
  THUNDER_SPEED: 3000,
  NEAR_THUNDER_PX: 2500,
  NIGHT_LIGHT: 0.12,
} as const;

export const RAID_TIMES: ReadonlyArray<{ id: RaidTime; weight: number; startMin: readonly [number, number] }> = [
  { id: "day", weight: 45, startMin: [600, 900] },
  { id: "dusk", weight: 25, startMin: [1110, 1140] },
  { id: "night", weight: 15, startMin: [1350, 1410] },
  { id: "dawn", weight: 15, startMin: [240, 270] },
];

export interface WeatherParams {
  rain: number; fog: number; wind: number; cloud: number;
  /** Vision range multiplier from weather alone. */ vis: number;
  /** Hearing range multiplier. */ hear: number;
  /** Multiplies sun light. */ light: number;
}
export const WEATHER_PARAMS: Record<WeatherKind, WeatherParams> = {
  clear:  { rain: 0,   fog: 0,   wind: 0.2, cloud: 0.1, vis: 1.0,  hear: 1.0,  light: 1.0 },
  cloudy: { rain: 0,   fog: 0.1, wind: 0.4, cloud: 0.6, vis: 1.0,  hear: 1.0,  light: 0.9 },
  rain:   { rain: 0.6, fog: 0.2, wind: 0.5, cloud: 0.9, vis: 0.85, hear: 0.8,  light: 0.8 },
  fog:    { rain: 0,   fog: 1.0, wind: 0.1, cloud: 0.5, vis: 0.55, hear: 1.05, light: 0.85 },
  storm:  { rain: 1.0, fog: 0.3, wind: 1.0, cloud: 1.0, vis: 0.75, hear: 0.65, light: 0.65 },
};

type W = ReadonlyArray<{ k: WeatherKind; weight: number }>;
const NEXT: Record<WeatherKind, W> = {
  clear:  [{ k: "clear", weight: 40 }, { k: "cloudy", weight: 45 }, { k: "fog", weight: 15 }],
  cloudy: [{ k: "clear", weight: 30 }, { k: "cloudy", weight: 20 }, { k: "rain", weight: 35 }, { k: "fog", weight: 15 }],
  rain:   [{ k: "cloudy", weight: 40 }, { k: "rain", weight: 25 }, { k: "storm", weight: 35 }],
  storm:  [{ k: "rain", weight: 60 }, { k: "cloudy", weight: 40 }],
  fog:    [{ k: "clear", weight: 35 }, { k: "cloudy", weight: 45 }, { k: "fog", weight: 20 }],
};
const INITIAL: Record<RaidTime, W> = {
  day:   [{ k: "clear", weight: 50 }, { k: "cloudy", weight: 35 }, { k: "rain", weight: 15 }],
  dusk:  [{ k: "clear", weight: 40 }, { k: "cloudy", weight: 35 }, { k: "rain", weight: 20 }, { k: "storm", weight: 5 }],
  night: [{ k: "clear", weight: 40 }, { k: "cloudy", weight: 30 }, { k: "rain", weight: 20 }, { k: "fog", weight: 10 }],
  dawn:  [{ k: "fog", weight: 50 }, { k: "clear", weight: 30 }, { k: "cloudy", weight: 20 }],
};

export interface EnvConfig {
  seed: number;
  todStartMin: number;
  durationMs: number;
  mapW: number;
  mapH: number;
  /** "" = scheduled weather; otherwise force one kind for the whole raid (dev / events). */
  override?: WeatherKind | "";
}

/** Server, at match creation: pick raid time + start minute. Put seed/todStartMin in BattleState. */
export function rollRaidTime(seed: number): { raidTime: RaidTime; todStartMin: number } {
  const rng = mulberry32((seed ^ 0x7a11c0de) >>> 0);
  const rt = pickWeighted(rng, RAID_TIMES);
  return { raidTime: rt.id, todStartMin: randInt(rng, rt.startMin[0], rt.startMin[1]) };
}

export function raidTimeOf(todStartMin: number): RaidTime {
  const m = ((todStartMin % 1440) + 1440) % 1440;
  if (m >= 240 && m < 390) return "dawn";
  if (m >= 390 && m < 1080) return "day";
  if (m >= 1080 && m < 1290) return "dusk";
  return "night";
}

export interface WeatherSegment { kind: WeatherKind; startMs: number; endMs: number }
export interface Strike { t: number; x: number; y: number }
export interface EnvSchedule { segments: WeatherSegment[]; strikes: Strike[] }

const scheduleCache = new Map<string, EnvSchedule>();

/** Deterministic weather segments + lightning strikes for the whole raid (memoized). */
export function envSchedule(cfg: EnvConfig): EnvSchedule {
  const key = `${cfg.seed}|${cfg.todStartMin}|${cfg.durationMs}|${cfg.mapW}|${cfg.mapH}|${cfg.override ?? ""}`;
  const hit = scheduleCache.get(key);
  if (hit) return hit;
  const rng = mulberry32((cfg.seed ^ 0x5eed1234) >>> 0);
  const segments: WeatherSegment[] = [];
  if (cfg.override) {
    segments.push({ kind: cfg.override, startMs: 0, endMs: cfg.durationMs });
  } else {
    let kind = pickWeighted(rng, INITIAL[raidTimeOf(cfg.todStartMin)]).k;
    let t = 0;
    while (t < cfg.durationMs) {
      const len = randInt(rng, ENV.SEGMENT_MIN_MS, ENV.SEGMENT_MAX_MS);
      segments.push({ kind, startMs: t, endMs: Math.min(cfg.durationMs, t + len) });
      t += len;
      kind = pickWeighted(rng, NEXT[kind]).k;
    }
  }
  const strikes: Strike[] = [];
  for (const s of segments) {
    if (s.kind !== "storm") continue;
    let t = s.startMs + ENV.BLEND_MS / 2;
    for (;;) {
      t += -Math.log(1 - rng()) * ENV.LIGHTNING_MEAN_GAP_MS + ENV.LIGHTNING_MIN_GAP_MS;
      if (t >= s.endMs) break;
      strikes.push({ t: Math.round(t), x: randRange(rng, 0, cfg.mapW), y: randRange(rng, 0, cfg.mapH) });
    }
  }
  if (scheduleCache.size > 32) scheduleCache.clear();
  const out = { segments, strikes };
  scheduleCache.set(key, out);
  return out;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (t: number) => t * t * (3 - 2 * t);

/** Sun light 0.12..1 for a time of day in minutes. */
export function sunLight(todMin: number): number {
  const m = ((todMin % 1440) + 1440) % 1440;
  const N = ENV.NIGHT_LIGHT;
  if (m < 270 || m >= 1290) return N;                       // before 04:30 / after 21:30
  if (m < 390) return N + (1 - N) * smooth((m - 270) / 120); // 04:30–06:30
  if (m < 1110) return 1;                                    // until 18:30
  return 1 - (1 - N) * smooth((m - 1110) / 180);             // 18:30–21:30
}

export interface EnvSample {
  kind: WeatherKind;
  prev: WeatherKind;
  /** 0..1 progress of the cross-fade prev → kind. */
  blend: number;
  rain: number; fog: number; wind: number; cloud: number;
  /** 0 dry .. 1 soaked (lags rain by WET_BLEND_MS). */
  wetness: number;
  /** In-game minutes since midnight. */
  todMin: number;
  /** Final ambient light 0.12..1 (includes lightning flash). */
  light: number;
  /** Lightning flash brightness 0..1 right now. */
  flash: number;
  /** Vision range multiplier (weather × darkness). Flashlight is handled separately. */
  vis: number;
  /** Hearing range multiplier for noise events / gunshots. */
  hear: number;
}

export function sampleEnv(cfg: EnvConfig, clockMs: number): EnvSample {
  const { segments, strikes } = envSchedule(cfg);
  const t = Math.max(0, clockMs);
  let i = segments.length - 1;
  for (let k = 0; k < segments.length; k++) if (t < segments[k]!.endMs) { i = k; break; }
  const seg = segments[i]!;
  const prev = i > 0 ? segments[i - 1]!.kind : seg.kind;
  const into = t - seg.startMs;
  const blend = smooth(clamp01(into / ENV.BLEND_MS));
  const a = WEATHER_PARAMS[prev];
  const b = WEATHER_PARAMS[seg.kind];
  const mix = (key: keyof WeatherParams) => lerp(a[key], b[key], blend);
  const wetness = lerp(a.rain > 0 ? 1 : 0, b.rain > 0 ? 1 : 0, clamp01(into / ENV.WET_BLEND_MS));
  const todMin = (cfg.todStartMin + (t / 60_000) * ENV.TOD_RATE) % 1440;
  let flash = 0;
  for (const s of strikes) {
    if (s.t > t) break; // strikes are sorted ascending
    const age = t - s.t;
    if (age < ENV.LIGHTNING_FLASH_MS) flash = Math.max(flash, 1 - age / ENV.LIGHTNING_FLASH_MS);
  }
  const ambient = sunLight(todMin) * mix("light");
  const light = Math.max(ambient, flash);
  // Night hearing bonus (memo: ×1.1 below light 0.3). Ramped over 0.25..0.35 instead of a step so
  // sound radii never jump mid-raid (the memo's own continuity test), and keyed on the pre-flash
  // light so a lightning strike does not make everyone briefly hard of hearing.
  const nightHear = 1 + 0.1 * smooth(clamp01((0.35 - ambient) / 0.1));
  return {
    kind: seg.kind, prev, blend,
    rain: mix("rain"), fog: mix("fog"), wind: mix("wind"), cloud: mix("cloud"),
    wetness, todMin, light, flash,
    // Includes the flash on purpose (memo): lightning briefly reveals the map.
    vis: mix("vis") * (0.45 + 0.55 * light),
    hear: Math.min(1.15, mix("hear") * nightHear),
  };
}

/** Strikes with t in [t0, t1) — clients schedule flash + thunder from this. */
export function strikesBetween(cfg: EnvConfig, t0: number, t1: number): Strike[] {
  return envSchedule(cfg).strikes.filter((s) => s.t >= t0 && s.t < t1);
}

/** Helper both sides use. */
export function envConfigOf(
  state: { envSeed: number; todStartMin: number; durationMs: number; weatherOverride: string },
  map: { width: number; height: number },
): EnvConfig {
  return {
    seed: state.envSeed, todStartMin: state.todStartMin, durationMs: state.durationMs,
    mapW: map.width, mapH: map.height,
    override: (WEATHER_KINDS as readonly string[]).includes(state.weatherOverride) ? (state.weatherOverride as WeatherKind) : "",
  };
}
