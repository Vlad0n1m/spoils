/**
 * Weather visuals (WP-A1): rain streaks + splashes, fog banks, cloud shadows, lightning flash,
 * wet-ground and dusk grading. One GameSystem, `createWeatherSystem`, drawing only into the layers
 * the renderer hands out (systems.ts GameLayers):
 *
 *   ground   : wet tint (multiply sprite over the terrain, under every entity)
 *   worldTop : splashes, cloud shadows, rain streaks, two fog banks, dusk grade (multiply)
 *   screen   : lightning flash (above the darkness pass, so a strike lights the night)
 *
 * Budget (critique / immersion perf): ≤ 1 ms CPU per frame at heavy rain on a mid laptop. Hence:
 *  - no Graphics anywhere and no per-frame rebuilds — ParticleContainers with fixed pools; only
 *    positions (streaks) or position+scale+alpha (64 splashes) are dynamic;
 *  - counts scale with intensity, and every element is `visible = false` (zero cost) at 0;
 *  - the environment is sampled at 10 Hz (it blends over 45 s); only the flash is per frame, from
 *    a binary search into the deterministic strike list.
 * Night darkness is NOT here: fog.ts owns the one darkness RT (critique "Client fog rendering").
 *
 * The particle simulation (`RainField`, `SplashField`) and the grading maths are pure and are
 * tested in weather-fx.test.ts with plain objects.
 */
import { Particle, ParticleContainer, Sprite, Texture, TilingSprite } from "pixi.js";
import { envConfigOf, envSchedule, isIndoor, sampleEnv, type EnvConfig, type EnvSample, type MapData, type Strike } from "@extract/shared";
import type { GameContext, GameSystem } from "../systems";
import { emptyEnvSource, firstStrikeAtOrAfter, rememberEnvSource, sameEnvSource } from "../audio/ambience";
import { getSettings, subscribeSettings } from "../audio/settings";
import { acquireWeatherTextures, releaseWeatherTextures, type WeatherTextures } from "./textures";

// ---------------------------------------------------------------- tuning

export const RAIN = {
  MAX_STREAKS: 450,
  MAX_SPLASHES: 64,
  /** World px/s. */
  SPEED_MIN: 1100,
  SPEED_MAX: 1500,
  SPLASH_LIFE_MS: 400,
  SPLASH_SCALE_FROM: 0.15,
  SPLASH_SCALE_TO: 0.85,
  SPLASH_ALPHA: 0.55,
  STREAK_ALPHA: 0.35,
  STREAK_TINT: 0xc8d6e8,
  /** Streak length multiplier (texture is 32 px tall). */
  STREAK_SCALE_Y: 0.9,
} as const;

export const FOG = {
  /** Two banks at different scales and drift so they never line up into an obvious tile. */
  ALPHA: [0.4, 0.25] as const,
  SCALE: [6, 10] as const,
  PARALLAX: [0.9, 0.8] as const,
  /** Drift px/s per unit of wind. */
  DRIFT: [24, 40] as const,
  TINT: 0xdfe6ee,
} as const;

export const CLOUD = { ALPHA: 0.12, SCALE: 8, DRIFT: 30, TINT: 0x10161f, MIN_LIGHT: 0.5 } as const;

export const GRADE = {
  WET_COLOR: 0xa9b6c4,
  WET_MAX: 0.85,
  DUSK_COLOR: 0xffd8b0,
  DUSK_MAX: 0.9,
} as const;

export const ENV_SAMPLE_MS = 100;
/** Photosensitivity: the flash never exceeds these alphas (immersion memo §3 + risks). */
export const FLASH_MAX = 0.45;
export const FLASH_REDUCED_MAX = 0.15;

// ---------------------------------------------------------------- pure helpers

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Positive modulo (JS % keeps the sign of the dividend). */
export function wrap(v: number, size: number): number {
  const r = v % size;
  // `+ 0` turns -0 into 0 so callers can compare positions exactly.
  return r < 0 ? r + size : r + 0;
}

/** Linear blend of two 0xRRGGBB colors. */
export function lerpColor(a: number, b: number, t: number): number {
  const k = clamp01(t);
  const ch = (s: number) => {
    const x = (a >> s) & 0xff;
    const y = (b >> s) & 0xff;
    return Math.round(x + (y - x) * k) << s;
  };
  return ch(16) | ch(8) | ch(0);
}

/** Horizontal drift per vertical px: rain leans with the wind. */
export function rainSlant(wind: number): number {
  return 0.1 + 0.35 * clamp01(wind);
}

/** Triangle-ish smooth bump: 0 at lo and hi, 1 at peak. */
function bump(m: number, lo: number, peak: number, hi: number): number {
  if (m <= lo || m >= hi) return 0;
  const t = m < peak ? (m - lo) / (peak - lo) : (hi - m) / (hi - peak);
  return t * t * (3 - 2 * t);
}

/** Golden-hour warmth 0..1 from the in-game time: evening 17:30→19:30→21:30, dawn 05:00→06:30→08:00. */
export function duskAmount(todMin: number, cloud: number): number {
  const m = wrap(todMin, 1440);
  const warm = Math.max(bump(m, 1050, 1170, 1290), bump(m, 300, 390, 480));
  // Overcast skies kill the warm light.
  return warm * (1 - 0.6 * clamp01(cloud));
}

export interface Grade {
  /** Multiply tint for the ground (0xffffff = off). */
  wet: number;
  /** Multiply tint over the world (0xffffff = off). */
  dusk: number;
}

export function gradeFor(env: Pick<EnvSample, "wetness" | "todMin" | "cloud">): Grade {
  return {
    wet: lerpColor(0xffffff, GRADE.WET_COLOR, clamp01(env.wetness) * GRADE.WET_MAX),
    dusk: lerpColor(0xffffff, GRADE.DUSK_COLOR, duskAmount(env.todMin, env.cloud) * GRADE.DUSK_MAX),
  };
}

/**
 * Double-flicker lightning: 0.45 → 0 over 60 ms, dark 40 ms, then 0.3 → 0 over 300 ms.
 * Scaled to `max` (FLASH_MAX, or FLASH_REDUCED_MAX with "reduce flashes").
 */
export function lightningAlpha(ageMs: number, max = FLASH_MAX): number {
  const k = max / FLASH_MAX;
  if (!(ageMs >= 0)) return 0;
  if (ageMs < 60) return 0.45 * (1 - ageMs / 60) * k;
  if (ageMs < 100) return 0;
  if (ageMs < 400) return 0.3 * (1 - (ageMs - 100) / 300) * k;
  return 0;
}

/** Age of the most recent strike at `clockMs`, or Infinity. O(log n), allocation-free. */
export function lastStrikeAge(strikes: readonly Strike[], clockMs: number): number {
  const i = firstStrikeAtOrAfter(strikes, clockMs + 1e-6) - 1;
  return i >= 0 ? clockMs - strikes[i]!.t : Number.POSITIVE_INFINITY;
}

export interface ViewRect {
  left: number;
  top: number;
  w: number;
  h: number;
}

/** What the pure fields need from a particle (Pixi's Particle satisfies it; tests use objects). */
export interface ParticleLike {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  alpha: number;
}

/** Inactive drops sit below this x (far outside any map). */
const PARKED = -1e5;

/**
 * Rain streaks, world-locked: each drop moves in world space and is wrapped into the view rect,
 * so walking does not drag the rain along and density stays uniform. Inactive drops are parked
 * far off-view (position is the only dynamic attribute, so this costs nothing to upload).
 */
export class RainField<P extends ParticleLike> {
  readonly speed: Float32Array;
  active = 0;
  private slant = Number.NaN;

  constructor(
    readonly drops: P[],
    private readonly rnd: () => number = Math.random,
  ) {
    this.speed = new Float32Array(drops.length);
    for (let i = 0; i < drops.length; i++) {
      this.speed[i] = RAIN.SPEED_MIN + rnd() * (RAIN.SPEED_MAX - RAIN.SPEED_MIN);
      // Spread over a unit square; the first step maps them into the view.
      drops[i]!.x = rnd() * 4096;
      drops[i]!.y = rnd() * 4096;
    }
  }

  /** Returns true when static attributes (rotation) changed and the container needs update(). */
  step(dtMs: number, view: ViewRect, intensity: number, slant: number): boolean {
    const n = Math.round(this.drops.length * clamp01(intensity));
    this.active = n;
    const dt = Math.min(dtMs, 100) / 1000;
    let dirty = false;
    if (Math.abs(slant - this.slant) > 0.01 || !Number.isFinite(this.slant)) {
      this.slant = slant;
      const rot = -Math.atan(slant);
      for (const d of this.drops) d.rotation = rot;
      dirty = true;
    }
    const { left, top, w, h } = view;
    for (let i = 0; i < n; i++) {
      const d = this.drops[i]!;
      if (d.x < PARKED) {
        // Re-activated as the rain picks up: scatter it, or every revived drop lands on one spot.
        d.x = left + this.rnd() * w;
        d.y = top + this.rnd() * h;
      }
      const vy = this.speed[i]! * dt;
      d.x = left + wrap(d.x + vy * slant - left, w);
      d.y = top + wrap(d.y + vy - top, h);
    }
    for (let i = n; i < this.drops.length; i++) {
      const d = this.drops[i]!;
      if (d.x >= PARKED) {
        d.x = PARKED * 10;
        d.y = PARKED * 10;
      }
    }
    return dirty;
  }
}

/**
 * Splash rings on the ground inside the view: each lives SPLASH_LIFE_MS, grows and fades, then
 * respawns at a random spot. Spots under a roof (`covered`) stay invisible for that life, so
 * splashes never appear on building floors.
 */
export class SplashField<P extends ParticleLike> {
  readonly age: Float32Array;
  readonly shown: Uint8Array;

  constructor(
    readonly rings: P[],
    private readonly rnd: () => number = Math.random,
  ) {
    this.age = new Float32Array(rings.length);
    this.shown = new Uint8Array(rings.length);
    // Stagger ages so the first second does not pulse in sync.
    for (let i = 0; i < rings.length; i++) {
      this.age[i] = rnd() * RAIN.SPLASH_LIFE_MS;
      rings[i]!.alpha = 0;
    }
  }

  step(dtMs: number, view: ViewRect, intensity: number, covered: (x: number, y: number) => boolean): void {
    const n = Math.round(this.rings.length * clamp01(intensity));
    const life = RAIN.SPLASH_LIFE_MS;
    for (let i = 0; i < this.rings.length; i++) {
      const r = this.rings[i]!;
      let a = this.age[i]! + dtMs;
      if (a >= life) {
        a %= life;
        if (i < n) {
          r.x = view.left + this.rnd() * view.w;
          r.y = view.top + this.rnd() * view.h;
          this.shown[i] = covered(r.x, r.y) ? 0 : 1;
        } else this.shown[i] = 0;
      }
      this.age[i] = a;
      if (!this.shown[i]) {
        r.alpha = 0;
        continue;
      }
      const t = a / life;
      const s = RAIN.SPLASH_SCALE_FROM + (RAIN.SPLASH_SCALE_TO - RAIN.SPLASH_SCALE_FROM) * t;
      r.scaleX = s;
      r.scaleY = s * 0.6; // seen at a slight angle, like the art's ground shadows
      r.alpha = RAIN.SPLASH_ALPHA * (1 - t);
    }
  }
}

/** View rect in world units from the camera, without assuming whether camera x/y is centre or corner. */
export function viewRectOf(ctx: Pick<GameContext, "camera" | "toScreen">, margin: number, out: ViewRect): ViewRect {
  const cam = ctx.camera();
  const z = cam.zoom > 0 ? cam.zoom : 1;
  const o = ctx.toScreen(0, 0);
  out.left = -o.x / z - margin;
  out.top = -o.y / z - margin;
  out.w = cam.width / z + margin * 2;
  out.h = cam.height / z + margin * 2;
  return out;
}

// ---------------------------------------------------------------- the system

class WeatherSystem implements GameSystem {
  readonly id = "weather";
  private tex: WeatherTextures | null = null;
  private disposed = false;

  private streakPc: ParticleContainer | null = null;
  private splashPc: ParticleContainer | null = null;
  private rain: RainField<Particle> | null = null;
  private splashes: SplashField<Particle> | null = null;
  private fog: TilingSprite[] = [];
  private cloud: TilingSprite | null = null;
  private wet: Sprite | null = null;
  private dusk: Sprite | null = null;
  private flash: Sprite | null = null;

  private map: MapData | null = null;
  private cfg: EnvConfig | null = null;
  private readonly envSrc = emptyEnvSource();
  private strikes: readonly Strike[] = [];
  private env: EnvSample | null = null;
  private nextSampleAt = 0;
  private flashMax = FLASH_MAX;
  private unsubSettings: (() => void) | null = null;
  private readonly view: ViewRect = { left: 0, top: 0, w: 1, h: 1 };
  private t = 0;
  private readonly covered = (x: number, y: number) => (this.map ? isIndoor(this.map, x, y) : false);

  init(ctx: GameContext): void {
    const tex = acquireWeatherTextures();
    this.tex = tex;
    const { ground, worldTop, screen } = ctx.layers;

    this.wet = fullSprite("blend-wet");
    this.wet.blendMode = "multiply";
    ground.addChild(this.wet);

    this.splashPc = new ParticleContainer({
      texture: tex.ring,
      dynamicProperties: { position: true, vertex: true, color: true, rotation: false, uvs: false },
    });
    const rings: Particle[] = [];
    for (let i = 0; i < RAIN.MAX_SPLASHES; i++) {
      rings.push(new Particle({ texture: tex.ring, anchorX: 0.5, anchorY: 0.5, tint: RAIN.STREAK_TINT, alpha: 0 }));
    }
    this.splashPc.addParticle(...rings);
    this.splashes = new SplashField(rings);
    worldTop.addChild(this.splashPc);

    this.cloud = new TilingSprite({ texture: tex.cloud, width: 1, height: 1 });
    this.cloud.tint = CLOUD.TINT;
    this.cloud.tileScale.set(CLOUD.SCALE);
    worldTop.addChild(this.cloud);

    this.streakPc = new ParticleContainer({
      texture: tex.streak,
      dynamicProperties: { position: true, rotation: false, vertex: false, color: false, uvs: false },
    });
    const drops: Particle[] = [];
    for (let i = 0; i < RAIN.MAX_STREAKS; i++) {
      drops.push(
        new Particle({
          texture: tex.streak,
          anchorX: 0.5,
          anchorY: 1,
          scaleY: RAIN.STREAK_SCALE_Y * (0.8 + Math.random() * 0.4),
          tint: RAIN.STREAK_TINT,
          alpha: RAIN.STREAK_ALPHA * (0.6 + Math.random() * 0.4),
        }),
      );
    }
    this.streakPc.addParticle(...drops);
    this.rain = new RainField(drops);
    worldTop.addChild(this.streakPc);

    for (let i = 0; i < 2; i++) {
      const f = new TilingSprite({ texture: tex.fog, width: 1, height: 1 });
      f.tint = FOG.TINT;
      f.tileScale.set(FOG.SCALE[i]!);
      this.fog.push(f);
      worldTop.addChild(f);
    }

    this.dusk = fullSprite("blend-dusk");
    this.dusk.blendMode = "multiply";
    worldTop.addChild(this.dusk);

    this.flash = fullSprite("flash");
    screen.addChild(this.flash);

    // ParticleContainers have no bounds by design; never let the culler drop them.
    this.splashPc.cullable = false;
    this.streakPc.cullable = false;

    const applySettings = () => {
      this.flashMax = getSettings().reduceFlashes ? FLASH_REDUCED_MAX : FLASH_MAX;
    };
    applySettings();
    this.unsubSettings = subscribeSettings(applySettings);
    this.hideAll();
  }

  frame(dtMs: number, ctx: GameContext): void {
    if (this.disposed || !this.tex) return;
    const state = ctx.state();
    const map = ctx.map();
    if (!state || !map) return;
    this.map = map;
    const clock = ctx.clockMs();
    const now = performance.now();
    this.t += dtMs / 1000;

    if (!this.cfg || !sameEnvSource(this.envSrc, state, map)) {
      rememberEnvSource(this.envSrc, state, map);
      this.cfg = envConfigOf(state, map);
      this.strikes = envSchedule(this.cfg).strikes;
      this.nextSampleAt = 0;
    }
    if (now >= this.nextSampleAt && this.cfg) {
      this.nextSampleAt = now + ENV_SAMPLE_MS;
      this.env = sampleEnv(this.cfg, clock);
    }
    const env = this.env;
    if (!env) return;

    const view = viewRectOf(ctx, 64, this.view);
    this.rainTick(dtMs, env, view);
    this.fogTick(env, view);
    this.gradeTick(env, view);
    this.flashTick(clock, ctx);
  }

  private rainTick(dtMs: number, env: EnvSample, view: ViewRect): void {
    const rain = env.rain;
    const on = rain > 0.02;
    this.streakPc!.visible = on;
    this.splashPc!.visible = on;
    if (!on) return;
    if (this.rain!.step(dtMs, view, rain, rainSlant(env.wind))) this.streakPc!.update();
    this.splashes!.step(dtMs, view, rain, this.covered);
  }

  private fogTick(env: EnvSample, view: ViewRect): void {
    for (let i = 0; i < this.fog.length; i++) {
      const f = this.fog[i]!;
      const a = env.fog * FOG.ALPHA[i]!;
      f.visible = a > 0.01;
      if (!f.visible) continue;
      f.alpha = a;
      placeTiling(f, view, FOG.PARALLAX[i]!, this.t * FOG.DRIFT[i]! * (0.3 + env.wind));
    }
    const c = this.cloud!;
    // Shadows need sun: they vanish at night and under full overcast stays a uniform grey anyway.
    const a = CLOUD.ALPHA * env.cloud * clamp01((env.light - CLOUD.MIN_LIGHT) / (1 - CLOUD.MIN_LIGHT)) * (1 - 0.5 * env.rain);
    c.visible = a > 0.01;
    if (c.visible) {
      c.alpha = a;
      placeTiling(c, view, 1, this.t * CLOUD.DRIFT * (0.3 + env.wind));
    }
  }

  private gradeTick(env: EnvSample, view: ViewRect): void {
    const g = gradeFor(env);
    setMultiply(this.wet!, g.wet, view);
    setMultiply(this.dusk!, g.dusk, view);
  }

  private flashTick(clock: number, ctx: GameContext): void {
    const a = lightningAlpha(lastStrikeAge(this.strikes, clock), this.flashMax);
    const f = this.flash!;
    f.visible = a > 0.005;
    if (!f.visible) return;
    const cam = ctx.camera();
    f.alpha = a;
    f.width = cam.width;
    f.height = cam.height;
  }

  private hideAll(): void {
    for (const d of [this.streakPc, this.splashPc, this.cloud, this.wet, this.dusk, this.flash, ...this.fog]) if (d) d.visible = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubSettings?.();
    this.unsubSettings = null;
    for (const d of [this.streakPc, this.splashPc, this.cloud, this.wet, this.dusk, this.flash, ...this.fog]) {
      if (!d) continue;
      d.removeFromParent();
      // Shared textures are released below, never destroyed with the display object.
      d.destroy({ children: true, texture: false, textureSource: false });
    }
    this.fog = [];
    this.streakPc = this.splashPc = null;
    this.cloud = this.wet = this.dusk = this.flash = null;
    this.rain = null;
    this.splashes = null;
    if (this.tex) {
      this.tex = null;
      releaseWeatherTextures();
    }
  }
}

function fullSprite(label: string): Sprite {
  const s = new Sprite(Texture.WHITE);
  s.label = label;
  s.visible = false;
  return s;
}

/** Cover the view with a world-space TilingSprite whose pattern is world-locked (× parallax). */
function placeTiling(s: TilingSprite, v: ViewRect, parallax: number, drift: number): void {
  s.position.set(v.left, v.top);
  s.width = v.w;
  s.height = v.h;
  s.tilePosition.set(-v.left * parallax + drift, -v.top * parallax + drift * 0.35);
}

/** A multiply sprite tinted white is a no-op: hide it instead of paying the fill. */
function setMultiply(s: Sprite, tint: number, v: ViewRect): void {
  s.visible = tint !== 0xffffff;
  if (!s.visible) return;
  s.tint = tint;
  s.position.set(v.left, v.top);
  s.width = v.w;
  s.height = v.h;
}

/** GameSystem factory for the renderer registry (systems.ts SYSTEM_FACTORIES). */
export function createWeatherSystem(): GameSystem {
  return new WeatherSystem();
}
