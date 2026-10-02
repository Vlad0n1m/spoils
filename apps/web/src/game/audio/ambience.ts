/**
 * Ambient beds and thunder, driven by the deterministic raid environment (shared environment.ts).
 *
 * Two layers:
 *  - pure functions (`ambienceTargets`, `StrikeScheduler`, `thunderFor`, `nextBirdDelayMs`), tested in
 *    ambience.test.ts without Web Audio;
 *  - `AmbientDirector`, the thin engine adapter GameAudio calls at 4 Hz.
 *
 * Why 4 Hz and τ = 1.5 s: weather blends over 45 s, so per-frame updates would only cost main
 * thread; the long time constant hides the step between updates and indoor/outdoor flips.
 *
 * Thunder never needs the network: every client computes the same strike list from envSeed, so a
 * strike is scheduled up to LOOKAHEAD_MS before it happens and the rumble is delayed by distance.
 */
import { ENV, type EnvSample, type Strike } from "@extract/shared";
import { AudioEngine, type LoopHandle } from "./engine";
import { clamp, thunderDelayMs } from "./spatial";

export const AMBIENCE = {
  /** Director update period (ms). */
  UPDATE_MS: 250,
  /** Bed gain smoothing time constant (s). */
  TAU_S: 1.5,
  /** Indoors the ambience bus reads as "rain on the roof": a 900 Hz lowpass at ×0.7. */
  INDOOR_CUTOFF: 900,
  INDOOR_GAIN: 0.7,
  OUTDOOR_CUTOFF: 20000,
  /** Birds sing on bright, dry stretches, one trill every 3–9 s. */
  BIRD_LIGHT_MIN: 0.6,
  BIRD_RAIN_MAX: 0.2,
  BIRD_MIN_MS: 3000,
  BIRD_MAX_MS: 9000,
  /** Crickets: dark and mostly dry. Soft ramps instead of a hard switch so dusk fades them in. */
  CRICKET_LIGHT_ON: 0.35,
  CRICKET_LIGHT_OFF: 0.45,
  CRICKET_RAIN_ON: 0.25,
  CRICKET_RAIN_OFF: 0.35,
  /** Strikes are scheduled this far before their flash. */
  LOOKAHEAD_MS: 2000,
  /** A strike whose flash is older than this is skipped (tab was hidden / clock jumped). */
  MAX_LATE_MS: 300,
} as const;

export interface AmbienceTargets {
  /** Loop gains 0..1 relative to each loop's mix level. */
  wind: number;
  rain: number;
  crickets: number;
  birds: boolean;
  /** Ambience bus lowpass / gain (indoor muffle). */
  busCutoff: number;
  busGain: number;
}

/** Linear 0..1 ramp that is 1 at `on` and 0 at `off` (works for either direction). */
function ramp(v: number, on: number, off: number): number {
  return clamp((v - off) / (on - off), 0, 1);
}

/** Bed levels for an environment sample (immersion memo §1 "Ambient director"). */
export function ambienceTargets(env: EnvSample, indoor: boolean): AmbienceTargets {
  const A = AMBIENCE;
  // Crickets ride on the 1.5 s gain smoothing, so a 250 ms lightning flash cannot switch them off;
  // birds would only arm their timer, and storms have rain > BIRD_RAIN_MAX anyway.
  const light = env.light;
  return {
    wind: clamp(0.15 + 0.5 * env.wind, 0, 1),
    rain: clamp(env.rain, 0, 1),
    crickets: ramp(light, A.CRICKET_LIGHT_ON, A.CRICKET_LIGHT_OFF) * ramp(env.rain, A.CRICKET_RAIN_ON, A.CRICKET_RAIN_OFF),
    birds: light > A.BIRD_LIGHT_MIN && env.rain < A.BIRD_RAIN_MAX && env.flash === 0,
    busCutoff: indoor ? A.INDOOR_CUTOFF : A.OUTDOOR_CUTOFF,
    busGain: indoor ? A.INDOOR_GAIN : 1,
  };
}

/** Delay before the next bird trill, from one uniform random number. */
export function nextBirdDelayMs(rnd: number): number {
  return AMBIENCE.BIRD_MIN_MS + clamp(rnd, 0, 1) * (AMBIENCE.BIRD_MAX_MS - AMBIENCE.BIRD_MIN_MS);
}

/** Lower bound index of the first strike with t ≥ tMs (strikes are sorted ascending by t). */
export function firstStrikeAtOrAfter(strikes: readonly Strike[], tMs: number): number {
  let lo = 0;
  let hi = strikes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (strikes[mid]!.t < tMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Hands out each strike exactly once, a little before it happens. Keyed off the match clock, not
 * wall time, so a reconnect or a hidden tab never replays a burst of old thunder: any jump larger
 * than JUMP_MS re-seeks the cursor and drops strikes that are already MAX_LATE_MS old.
 */
export class StrikeScheduler {
  static readonly JUMP_MS = 1500;
  private cursor = -1;
  private lastClock = Number.NEGATIVE_INFINITY;

  constructor(
    readonly lookaheadMs: number = AMBIENCE.LOOKAHEAD_MS,
    readonly maxLateMs: number = AMBIENCE.MAX_LATE_MS,
  ) {}

  /** Strikes due in [clock - maxLate, clock + lookahead) not handed out before. Appends into `out`. */
  poll(strikes: readonly Strike[], clockMs: number, out: Strike[] = []): Strike[] {
    if (!Number.isFinite(clockMs)) return out;
    const jumped = this.cursor < 0 || clockMs < this.lastClock - StrikeScheduler.JUMP_MS || clockMs > this.lastClock + StrikeScheduler.JUMP_MS;
    if (jumped) this.cursor = firstStrikeAtOrAfter(strikes, clockMs - this.maxLateMs);
    this.lastClock = clockMs;
    const horizon = clockMs + this.lookaheadMs;
    while (this.cursor < strikes.length && strikes[this.cursor]!.t < horizon) {
      const s = strikes[this.cursor++]!;
      if (s.t >= clockMs - this.maxLateMs) out.push(s);
    }
    return out;
  }

  reset(): void {
    this.cursor = -1;
    this.lastClock = Number.NEGATIVE_INFINITY;
  }
}

export interface ThunderPlan {
  id: "thunder_near" | "thunder_far";
  /** Seconds from now (flash time + travel time). */
  delayS: number;
  gain: number;
  pan: number;
  cutoff: number;
}

/** Past this distance thunder is at its quietest and darkest. */
export const THUNDER_FAR_PX = 18000;

/** How a strike sounds from the listener: near crack within NEAR_THUNDER_PX, else a distant roll. */
export function thunderFor(strike: Strike, listenerX: number, listenerY: number, clockMs: number): ThunderPlan {
  const dx = strike.x - listenerX;
  const dy = strike.y - listenerY;
  const d = Math.hypot(dx, dy);
  const near = d < ENV.NEAR_THUNDER_PX;
  const u = clamp((d - ENV.NEAR_THUNDER_PX) / (THUNDER_FAR_PX - ENV.NEAR_THUNDER_PX), 0, 1);
  return {
    id: near ? "thunder_near" : "thunder_far",
    delayS: Math.max(0, (strike.t - clockMs) / 1000) + thunderDelayMs(d) / 1000,
    gain: near ? 1 : 1 - 0.6 * u,
    // Wide but never hard-panned: thunder fills the sky.
    pan: clamp(dx / 8000, -1, 1) * 0.6,
    cutoff: near ? 20000 : 6000 * Math.pow(0.2, u),
  };
}

/**
 * The raw BattleState fields an EnvConfig is built from. They are immutable per match, so systems
 * compare them in place every frame instead of building a string key (frames stay allocation-free)
 * and rebuild the config only on a new match.
 */
export interface EnvSource {
  seed: number;
  tod: number;
  dur: number;
  override: string;
  map: object | null;
}

type EnvState = { envSeed: number; todStartMin: number; durationMs: number; weatherOverride: string };

export function emptyEnvSource(): EnvSource {
  return { seed: Number.NaN, tod: Number.NaN, dur: Number.NaN, override: "", map: null };
}

export function sameEnvSource(src: EnvSource, s: EnvState, map: object): boolean {
  return src.map === map && src.seed === s.envSeed && src.tod === s.todStartMin && src.dur === s.durationMs && src.override === s.weatherOverride;
}

export function rememberEnvSource(src: EnvSource, s: EnvState, map: object): void {
  src.seed = s.envSeed;
  src.tod = s.todStartMin;
  src.dur = s.durationMs;
  src.override = s.weatherOverride;
  src.map = map;
}

// ---------------------------------------------------------------- engine adapter

/**
 * Owns the three beds, the bird scheduler and thunder. `update` is cheap (a few AudioParam
 * setTargetAtTime calls) and is meant to run at AMBIENCE.UPDATE_MS.
 */
export class AmbientDirector {
  private readonly wind: LoopHandle;
  private readonly rain: LoopHandle;
  private readonly crickets: LoopHandle;
  private readonly strikes = new StrikeScheduler();
  private readonly due: Strike[] = [];
  private nextBirdAt = 0;
  private lastIndoor: boolean | null = null;
  private disposed = false;

  constructor(private readonly eng: AudioEngine = AudioEngine.get()) {
    this.wind = eng.loop("loop_wind");
    this.rain = eng.loop("loop_rain");
    this.crickets = eng.loop("loop_crickets");
  }

  /**
   * @param nowMs  wall clock (performance.now) for the cosmetic bird timer
   * @param clockMs match clock for the deterministic strike list
   */
  update(env: EnvSample, indoor: boolean, listenerX: number, listenerY: number, strikes: readonly Strike[], nowMs: number, clockMs: number): void {
    if (this.disposed) return;
    const t = ambienceTargets(env, indoor);
    this.wind.setGain(t.wind, AMBIENCE.TAU_S);
    this.rain.setGain(t.rain, AMBIENCE.TAU_S);
    this.crickets.setGain(t.crickets, AMBIENCE.TAU_S);
    if (this.lastIndoor !== indoor) {
      this.lastIndoor = indoor;
      this.eng.setAmbienceMuffle(t.busCutoff, t.busGain, 0.6);
    }

    if (t.birds) {
      if (nowMs >= this.nextBirdAt) {
        if (this.nextBirdAt > 0) this.eng.play("bird", { pan: (Math.random() * 2 - 1) * 0.7, db: -Math.random() * 6 });
        this.nextBirdAt = nowMs + nextBirdDelayMs(Math.random());
      }
    } else {
      // Re-arm so birds do not chirp the instant the rain stops.
      this.nextBirdAt = 0;
    }

    this.due.length = 0;
    this.strikes.poll(strikes, clockMs, this.due);
    for (const s of this.due) {
      const p = thunderFor(s, listenerX, listenerY, clockMs);
      this.eng.play(p.id, { delay: p.delayS, gain: p.gain, pan: p.pan, cutoff: p.cutoff });
    }
  }

  /** Clock jump (reconnect): drop pending strike bookkeeping; beds re-sync on the next update. */
  resync(): void {
    this.strikes.reset();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.wind.stop(0.8);
    this.rain.stop(0.8);
    this.crickets.stop(0.8);
    this.eng.setAmbienceMuffle(AMBIENCE.OUTDOOR_CUTOFF, 1, 0.1);
  }
}
