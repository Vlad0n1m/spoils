/**
 * Short-lived cosmetic effects: tracers, muzzle flashes, impact particles, chest bursts,
 * floating damage numbers, screen shake and the red "you were hit" vignette.
 *
 * Nothing is re-tessellated per frame: tracers and flashes are pooled Sprites (a stretched
 * white texture and a pre-rendered flash), particles live in one ParticleContainer, and only
 * the rare chest rings use a Graphics, redrawn just while a ring is alive. Rebuilding one big
 * Graphics every frame cost 0.56–1.7 ms at 60–150 shots/s (perf memo).
 */

import { Container, Graphics, ImageSource, Particle, ParticleContainer, Sprite, Text, Texture } from "pixi.js";
import {
  ACT,
  MATCH,
  SOUND,
  STEP_MATERIALS,
  SoundKind,
  TERRAIN,
  TERRAIN_KIND_MASK,
  WEAPONS,
  envConfigOf,
  isIndoor,
  sampleEnv,
  surfaceAt,
  terrainByteAt,
  type CollisionIndex,
  type EnvConfig,
  type EventsMsg,
  type MapData,
  type StepMaterial,
  type WeaponId,
} from "@extract/shared";
import { COLORS } from "./assets";
import { emptyEnvSource, rememberEnvSource, sameEnvSource } from "./audio/ambience";
import { tracerLengths } from "./shots";
import type { GameContext, GameSystem } from "./systems";

interface Tracer {
  shooter: string;
  /** Wide translucent streak and the thin bright core drawn over it. */
  glow: Sprite;
  core: Sprite;
  sx: number;
  sy: number;
  dx: number;
  dy: number;
  /** Distance to where the bullet stops (wall / range / hit player). */
  len: number;
  speed: number;
  born: number;
  width: number;
}

interface Spark {
  sprite: Particle;
  x: number;
  y: number;
  vx: number;
  vy: number;
  born: number;
  life: number;
  size: number;
}

interface Flash {
  sprite: Sprite;
  born: number;
  size: number;
}

interface Ring {
  x: number;
  y: number;
  born: number;
  life: number;
  color: number;
  maxR: number;
}

interface FloatNumber {
  text: Text;
  x: number;
  y: number;
  born: number;
}

const TRACER_LEN = 70;
const FLASH_MS = 70;
const NUMBER_MS = 850;
const MAX_TRACERS = 300;
const MAX_PARTICLES = 600;

/** Screen shake strength per weapon for the local player's shots. */
const SHAKE: Record<WeaponId, number> = { pistol: 2.5, rifle: 2, shotgun: 7, sniper: 9 };

/** Muzzle-flash texture pixels per world unit (flashes scale up to 1.4× on a 1.5× screen). */
const FLASH_TEX_RES = 2;
/** Flash shape bounds in world units at size 1 (the star spans x -3..22, y ±7.2), plus AA padding. */
const FLASH_X0 = -5;
const FLASH_X1 = 24;
const FLASH_HALF_H = 9;
/** Radius of the particle disc texture in pixels; particles are scaled from it. */
const DOT_TEX_R = 16;

/** Textures the effects draw with. Injectable so tests run without a DOM canvas. */
export interface FxTextures {
  /** Stretched for tracers; Texture.WHITE works. */
  line: Texture;
  /** Muzzle flash, FLASH_TEX_RES px per world unit, origin at (−FLASH_X0, FLASH_HALF_H) px. */
  flash: Texture;
  /** White disc of radius DOT_TEX_R px. */
  dot: Texture;
  vignette: Texture;
}

/** Where a tracer streak is this frame, along its path from the muzzle; null once it is gone. */
export function tracerSpan(age: number, len: number, speed: number): { tail: number; head: number } | null {
  const head = Math.min(len, age * speed);
  const tail = Math.max(0, age * speed - TRACER_LEN);
  if (tail >= len) return null;
  return { tail, head };
}

export class Effects {
  /** World-space effects (below canopies): tracers, flashes, particles, rings — in that order. */
  readonly layer = new Container();
  /** World-space floating numbers (above everything in the world). */
  readonly floatLayer = new Container();
  /** Screen-space red vignette; the renderer adds it to the stage and sizes it. */
  readonly vignette: Sprite;

  private readonly tex: FxTextures;
  /** Textures this instance created (and must destroy); injected ones belong to the caller. */
  private readonly ownsTextures: boolean;
  private readonly tracerLayer = new Container();
  private readonly flashLayer = new Container();
  private readonly particleLayer: ParticleContainer;
  private readonly ringLayer = new Graphics();
  /** Whether ringLayer holds geometry from the last frame (so it is cleared once, not every frame). */
  private ringsDrawn = false;

  private tracers: Tracer[] = [];
  private particles: Spark[] = [];
  private flashes: Flash[] = [];
  private rings: Ring[] = [];
  private numbers: FloatNumber[] = [];
  private textPool: Text[] = [];
  /** Hidden display objects waiting for reuse (they stay parented, only `visible` flips). */
  private spritePool: Sprite[] = [];
  private flashPool: Sprite[] = [];
  private particlePool: Particle[] = [];
  /** Particles were born since the last update (the live set changed even if its size did not). */
  private particlesDirty = false;
  private shakeAmp = 0;
  private hurt = 0;

  constructor(opts: { textures?: FxTextures } = {}) {
    this.ownsTextures = !opts.textures;
    this.tex = opts.textures ?? makeFxTextures();
    this.particleLayer = new ParticleContainer({
      texture: this.tex.dot,
      // Particles move, fade/tint and shrink every frame; rotation and uvs never change.
      dynamicProperties: { position: true, color: true, vertex: true, rotation: false, uvs: false },
    });
    this.layer.addChild(this.tracerLayer, this.flashLayer, this.particleLayer, this.ringLayer);
    this.vignette = new Sprite(this.tex.vignette);
    this.vignette.alpha = 0;
    this.vignette.eventMode = "none";
  }

  /** Display-object counts, for tests and the perf overlay. */
  stats(): { tracers: number; particles: number; flashes: number; rings: number; pooledSprites: number } {
    return {
      tracers: this.tracers.length,
      particles: this.particles.length,
      flashes: this.flashes.length,
      rings: this.rings.length,
      pooledSprites: this.tracerLayer.children.length,
    };
  }

  private takeLineSprite(tint: number, alpha: number): Sprite {
    let s = this.spritePool.pop();
    if (!s) {
      s = new Sprite(this.tex.line);
      // Anchored at the tail end, vertically centred: scale.x is the length, scale.y the width.
      s.anchor.set(0, 0.5);
      this.tracerLayer.addChild(s);
    }
    s.tint = tint;
    s.alpha = alpha;
    s.visible = false;
    return s;
  }

  private releaseTracer(t: Tracer) {
    t.glow.visible = false;
    t.core.visible = false;
    this.spritePool.push(t.glow, t.core);
  }

  /**
   * Somebody fired. (cx, cy) is the shooter's centre, where the server spawns the pellets and
   * raycasts walls from; (x, y) is the muzzle, where tracers and the flash are drawn from.
   */
  shot(
    idx: CollisionIndex | null,
    shooter: string,
    weapon: WeaponId,
    cx: number,
    cy: number,
    x: number,
    y: number,
    angles: number[],
    isSelf: boolean,
    now: number,
  ) {
    const def = WEAPONS[weapon] ?? WEAPONS.pistol;
    if (isSelf) this.shakeAmp = Math.max(this.shakeAmp, SHAKE[weapon] ?? 2);
    // The muzzle pokes through a wall: the server's bullets stop inside it, draw nothing.
    const lens = tracerLengths(idx, cx, cy, x, y, angles, def.range);
    if (!lens) return;
    let sumA = 0;
    angles.forEach((a, i) => {
      sumA += a;
      const len = lens[i]!;
      if (len <= 0) return;
      const glow = this.takeLineSprite(COLORS.tracer, 0.45);
      const core = this.takeLineSprite(COLORS.tracerCore, 0.95);
      glow.rotation = a;
      core.rotation = a;
      this.tracers.push({
        shooter, glow, core, sx: x, sy: y, dx: Math.cos(a), dy: Math.sin(a), len, speed: def.bulletSpeed, born: now,
        width: weapon === "sniper" ? 4 : weapon === "shotgun" ? 2.5 : 3,
      });
    });
    if (this.tracers.length > MAX_TRACERS) {
      for (const t of this.tracers.splice(0, this.tracers.length - MAX_TRACERS)) this.releaseTracer(t);
    }
    const avg = angles.length ? sumA / angles.length : 0;
    let flash = this.flashPool.pop();
    if (!flash) {
      flash = new Sprite(this.tex.flash);
      flash.anchor.set(-FLASH_X0 / (FLASH_X1 - FLASH_X0), 0.5);
      this.flashLayer.addChild(flash);
    }
    flash.position.set(x, y);
    flash.rotation = avg;
    flash.visible = false;
    this.flashes.push({ sprite: flash, born: now, size: weapon === "shotgun" || weapon === "sniper" ? 1.4 : 1 });
  }

  /** A bullet from `shooter` hit someone at (x, y): stop the matching tracer there and burst. */
  hit(shooter: string, x: number, y: number, armor: boolean, now: number) {
    this.stopTracer(shooter, x, y);
    this.hitBurst(x, y, armor, now);
  }

  /** Stop the tracer from `shooter` that passes closest to (x, y) at that point. */
  stopTracer(shooter: string, x: number, y: number) {
    let best: Tracer | null = null;
    let bestErr = 40;
    for (const t of this.tracers) {
      if (t.shooter !== shooter) continue;
      const px = x - t.sx;
      const py = y - t.sy;
      const along = px * t.dx + py * t.dy;
      if (along < 0 || along > t.len + 40) continue;
      const err = Math.abs(px * t.dy - py * t.dx);
      if (err < bestErr) {
        bestErr = err;
        best = t;
      }
    }
    if (best) best.len = Math.max(0, (x - best.sx) * best.dx + (y - best.sy) * best.dy);
  }

  /** Impact particles where a bullet hit a player. */
  hitBurst(x: number, y: number, armor: boolean, now: number) {
    this.burst(x, y, armor ? COLORS.hitArmor : COLORS.hitFlesh, 9, 260, now);
  }

  burst(x: number, y: number, color: number, count: number, speed: number, now: number) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.4 + Math.random() * 0.6);
      const sprite = this.particlePool.pop() ?? new Particle({ texture: this.tex.dot, anchorX: 0.5, anchorY: 0.5 });
      sprite.tint = color;
      this.particles.push({
        sprite, x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, born: now,
        life: 250 + Math.random() * 200, size: 2.5 + Math.random() * 3,
      });
    }
    this.particlesDirty = true;
    if (this.particles.length > MAX_PARTICLES) {
      for (const p of this.particles.splice(0, this.particles.length - MAX_PARTICLES)) this.particlePool.push(p.sprite);
    }
  }

  ring(x: number, y: number, color: number, maxR: number, life: number, now: number) {
    this.rings.push({ x, y, born: now, life, color, maxR });
  }

  damageNumber(x: number, y: number, amount: number, color: number, now: number) {
    const text =
      this.textPool.pop() ??
      new Text({
        text: "",
        style: {
          fontFamily: "ui-rounded, 'Trebuchet MS', system-ui, sans-serif",
          fontSize: 20,
          fontWeight: "900",
          fill: 0xffffff,
          stroke: { color: 0x1a1a1a, width: 4 },
        },
        resolution: 2,
      });
    text.text = String(Math.max(1, Math.round(amount)));
    text.style.fill = color;
    text.anchor.set(0.5);
    text.alpha = 1;
    text.visible = true;
    this.floatLayer.addChild(text);
    this.numbers.push({ text, x: x + (Math.random() - 0.5) * 16, y: y - 20, born: now });
  }

  hurtFlash(amount: number) {
    this.hurt = Math.min(1, Math.max(this.hurt, 0.35 + amount / 60));
  }

  /** Advance and redraw. Returns the camera shake offset for this frame. */
  update(now: number, dtMs: number, screenW: number, screenH: number): { x: number; y: number } {
    // Tracers: a short streak whose head flies at bulletSpeed and whose tail catches up at the end.
    let w = 0;
    for (const t of this.tracers) {
      const span = tracerSpan((now - t.born) / 1000, t.len, t.speed);
      if (!span) {
        this.releaseTracer(t);
        continue;
      }
      this.tracers[w++] = t;
      const visible = span.head > span.tail;
      t.glow.visible = visible;
      t.core.visible = visible;
      if (!visible) continue;
      placeStreak(t.glow, t, span, t.width + 2);
      placeStreak(t.core, t, span, t.width * 0.5);
    }
    this.tracers.length = w;

    w = 0;
    for (const f of this.flashes) {
      const k = (now - f.born) / FLASH_MS;
      if (k >= 1) {
        f.sprite.visible = false;
        this.flashPool.push(f.sprite);
        continue;
      }
      this.flashes[w++] = f;
      f.sprite.visible = true;
      f.sprite.scale.set((f.size * (1 - k * 0.5)) / FLASH_TEX_RES);
      f.sprite.alpha = 0.9 * (1 - k);
    }
    this.flashes.length = w;

    const dt = dtMs / 1000;
    const before = this.particles.length;
    w = 0;
    const live = this.particleLayer.particleChildren;
    live.length = 0;
    for (const p of this.particles) {
      const k = (now - p.born) / p.life;
      if (k >= 1) {
        this.particlePool.push(p.sprite);
        continue;
      }
      this.particles[w++] = p;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.9;
      p.vy *= 0.9;
      const sp = p.sprite;
      sp.x = p.x;
      sp.y = p.y;
      const sc = (p.size * (1 - k * 0.6)) / DOT_TEX_R;
      sp.scaleX = sc;
      sp.scaleY = sc;
      sp.alpha = 1 - k;
      live.push(sp);
    }
    this.particles.length = w;
    // The list was rebuilt in place: let the container re-upload its static data (cheap; only
    // when the set changed, which is when particles were born or died).
    if (w !== before || this.particlesDirty) this.particleLayer.update();
    this.particlesDirty = false;

    // Rings are rare (chest opens): redraw only while one is alive, and clear once after.
    const g = this.ringLayer;
    if (this.rings.length || this.ringsDrawn) g.clear();
    this.ringsDrawn = false;
    w = 0;
    for (const r of this.rings) {
      const k = (now - r.born) / r.life;
      if (k >= 1) continue;
      this.rings[w++] = r;
      g.circle(r.x, r.y, r.maxR * (0.3 + 0.7 * k)).stroke({ width: 5 * (1 - k) + 1, color: r.color, alpha: 1 - k });
      this.ringsDrawn = true;
    }
    this.rings.length = w;

    w = 0;
    for (const n of this.numbers) {
      const k = (now - n.born) / NUMBER_MS;
      if (k >= 1) {
        n.text.visible = false;
        this.floatLayer.removeChild(n.text);
        this.textPool.push(n.text);
        continue;
      }
      this.numbers[w++] = n;
      n.text.position.set(n.x, n.y - 34 * k);
      n.text.alpha = k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4;
      n.text.scale.set(k < 0.12 ? 0.7 + (k / 0.12) * 0.5 : 1.2 - Math.min(0.2, k * 0.4));
    }
    this.numbers.length = w;

    // Vignette fades over ~0.4 s.
    this.hurt *= Math.exp(-dtMs / 160);
    if (this.hurt < 0.01) this.hurt = 0;
    this.vignette.alpha = this.hurt;
    this.vignette.visible = this.hurt > 0;
    this.vignette.width = screenW;
    this.vignette.height = screenH;

    this.shakeAmp *= Math.exp(-dtMs / 60);
    if (this.shakeAmp < 0.1) return { x: 0, y: 0 };
    return {
      x: (Math.random() * 2 - 1) * this.shakeAmp,
      y: (Math.random() * 2 - 1) * this.shakeAmp,
    };
  }

  destroy() {
    for (const n of this.numbers) n.text.destroy();
    for (const t of this.textPool) t.destroy();
    this.numbers = [];
    this.textPool = [];
    this.tracers = [];
    this.flashes = [];
    this.particles = [];
    this.rings = [];
    this.spritePool = [];
    this.flashPool = [];
    this.particlePool = [];
    // Children (pooled sprites, the particle container, the ring Graphics) go with the layer;
    // textures are shared between them and released once below.
    this.layer.destroy({ children: true });
    this.floatLayer.destroy({ children: true });
    this.vignette.destroy();
    if (this.ownsTextures) {
      for (const t of [this.tex.flash, this.tex.dot, this.tex.vignette]) t.destroy(true);
    }
  }
}

/**
 * Positions a stretched line sprite over the visible part of a tracer. The old stroke had round
 * caps (half a width past each end), so the sprite is extended by that much on both sides.
 */
function placeStreak(s: Sprite, t: Tracer, span: { tail: number; head: number }, width: number) {
  const cap = width / 2;
  s.position.set(t.sx + t.dx * (span.tail - cap), t.sy + t.dy * (span.tail - cap));
  // Texture.WHITE is 1×1, so scale is the size in world units; divide anyway for any line texture.
  s.scale.set((span.head - span.tail + 2 * cap) / s.texture.width, width / s.texture.height);
}

function makeFxTextures(): FxTextures {
  return { line: Texture.WHITE, flash: makeFlashTexture(), dot: makeDotTexture(), vignette: makeVignetteTexture() };
}

/** The old per-frame muzzle-flash shape (yellow star + white core) at size 1, pre-rendered. */
function makeFlashTexture(): Texture {
  const c = document.createElement("canvas");
  c.width = Math.ceil((FLASH_X1 - FLASH_X0) * FLASH_TEX_RES);
  c.height = Math.ceil(2 * FLASH_HALF_H * FLASH_TEX_RES);
  const ctx = c.getContext("2d")!;
  ctx.setTransform(FLASH_TEX_RES, 0, 0, FLASH_TEX_RES, -FLASH_X0 * FLASH_TEX_RES, FLASH_HALF_H * FLASH_TEX_RES);
  const pts: Array<[number, number]> = [[22, 0], [6, 7], [0, 7.2], [-3, 0], [0, -7.2], [6, -7]];
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.fillStyle = "#ffd34d";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(4, 0, 5, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  return new Texture({ source: new ImageSource({ resource: c, scaleMode: "linear" }) });
}

/** White anti-aliased disc for particles (tinted per burst). */
function makeDotTexture(): Texture {
  const size = DOT_TEX_R * 2 + 2;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d")!;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, DOT_TEX_R, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  return new Texture({ source: new ImageSource({ resource: c, scaleMode: "linear" }) });
}

/** Radial transparent → red gradient, stretched over the screen. */
function makeVignetteTexture(): Texture {
  const size = 256;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d")!;
  const grad = ctx.createRadialGradient(size / 2, size / 2, size * 0.25, size / 2, size / 2, size * 0.72);
  grad.addColorStop(0, "rgba(255,0,0,0)");
  grad.addColorStop(0.6, "rgba(200,0,0,0.35)");
  grad.addColorStop(1, "rgba(150,0,0,0.85)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return new Texture({ source: new ImageSource({ resource: c }) });
}

// =================================================================================================
// WP-I immersion: world FX pools (blood decals, shell casings, dust puffs, ambient particles).
//
// Same rules as the Effects class above: fixed pools of Particles in one ParticleContainer each
// (one draw call per pool), nothing created or tessellated per frame, ring-buffer reuse when a pool
// is full. The simulations are written against `FxParticle` so tests drive them with plain
// objects. Two GameSystems use them (registered in systems-registry.ts):
//   world-fx : blood splats + corpse pools (layers.ground), casings + dust (layers.worldFx);
//   ambient  : pollen / dust motes by day, fireflies at night (additive; bottom of layers.screen
//              with the world transform, so they glow above the night darkness), drifting
//              leaves near forest (layers.worldTop) — counts follow the deterministic environment.
// Remote events are shown on the same 100 ms-in-the-past timeline as the renderer's own effects
// (INTERP_DELAY_MS) through a small typed-array delay queue — no closures per event.
// =================================================================================================

/** What the pooled simulations write: a Pixi Particle, or a plain object in tests. */
export interface FxParticle {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  alpha: number;
  tint: number;
}

/** Remote players are drawn this far in the past (renderer INTERP_DELAY_MS). */
export const FX_REMOTE_DELAY_MS = 100;
/** Parked (free) particles sit far outside any map, fully transparent. */
const PARK = -1e6;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOut = (k: number) => 1 - (1 - clamp01(k)) * (1 - clamp01(k));

function park(p: FxParticle): void {
  p.x = PARK;
  p.y = PARK;
  p.alpha = 0;
}

/** Positive modulo. */
export function wrapIn(v: number, size: number): number {
  const r = v % size;
  return r < 0 ? r + size : r;
}

// ------------------------------------------------------------------------------- blood decals

export const BLOOD = {
  MAX: 200,
  LIFE_MS: 60_000,
  FADE_MS: 8_000,
  /** Splat scale range (texture is SPLAT_TEX px wide → 20–40 world px). */
  SIZE_MIN: 0.32,
  SIZE_MAX: 0.62,
  ALPHA: 0.85,
  /** How far along the bullet the splats land. */
  SPRAY_PX: 26,
  POOL_SIZE: 1.5,
  POOL_GROW_MS: 2000,
  POOL_ALPHA: 0.78,
  POOL_TINT: 0x5c070b,
  TINTS: [0x7d0a10, 0x8f1016, 0x6a080d] as const,
} as const;

const SPLAT_TEX = 64;

/** Splats for a hit that took `dmg` HP (0 when armor ate everything). */
export function bloodSplats(dmg: number): number {
  if (!(dmg > 0)) return 0;
  return dmg < 15 ? 1 : dmg < 40 ? 2 : 3;
}

/**
 * Ground decals with a lifetime: they fade over the last FADE_MS and can grow in (pools). When the
 * pool is full the oldest decal is reused. `spawn` changes static attributes (position, rotation):
 * the caller must `update()` its ParticleContainer once after spawning.
 */
export class DecalField<P extends FxParticle> {
  readonly born: Float64Array;
  private readonly grow: Float32Array;
  private readonly sx: Float32Array;
  private readonly sy: Float32Array;
  private readonly a0: Float32Array;
  private next = 0;
  live = 0;

  constructor(
    readonly items: P[],
    readonly lifeMs: number = BLOOD.LIFE_MS,
    readonly fadeMs: number = BLOOD.FADE_MS,
  ) {
    const n = items.length;
    this.born = new Float64Array(n).fill(-1);
    this.grow = new Float32Array(n);
    this.sx = new Float32Array(n);
    this.sy = new Float32Array(n);
    this.a0 = new Float32Array(n);
    for (const p of items) park(p);
  }

  spawn(x: number, y: number, scaleX: number, scaleY: number, rotation: number, tint: number, alpha: number, now: number, growMs = 0): void {
    const n = this.items.length;
    if (!n) return;
    const i = this.next;
    this.next = (i + 1) % n;
    if (this.born[i]! < 0) this.live++;
    const p = this.items[i]!;
    p.x = x;
    p.y = y;
    p.rotation = rotation;
    p.tint = tint;
    p.alpha = alpha;
    this.born[i] = now;
    this.grow[i] = growMs;
    this.sx[i] = scaleX;
    this.sy[i] = scaleY;
    this.a0[i] = alpha;
    const k = growMs > 0 ? 0.05 : 1;
    p.scaleX = scaleX * k;
    p.scaleY = scaleY * k;
  }

  step(now: number): void {
    if (this.live === 0) return;
    const fadeFrom = this.lifeMs - this.fadeMs;
    for (let i = 0; i < this.items.length; i++) {
      const b = this.born[i]!;
      if (b < 0) continue;
      const p = this.items[i]!;
      const age = now - b;
      if (age >= this.lifeMs) {
        this.born[i] = -1;
        this.live--;
        park(p);
        continue;
      }
      if (age > fadeFrom) p.alpha = this.a0[i]! * (1 - (age - fadeFrom) / this.fadeMs);
      const g = this.grow[i]!;
      if (g > 0) {
        const k = age >= g ? 1 : 0.05 + 0.95 * easeOut(age / g);
        p.scaleX = this.sx[i]! * k;
        p.scaleY = this.sy[i]! * k;
        if (age >= g) this.grow[i] = 0;
      }
    }
  }
}

// ------------------------------------------------------------------------------- shell casings

export const CASING = {
  MAX: 120,
  LIFE_MS: 20_000,
  FADE_MS: 3_000,
  /** Flight + bounces; afterwards the casing lies still. */
  FLY_MS: 360,
  SPEED_MIN: 200,
  SPEED_MAX: 320,
  DRAG_TAU_MS: 110,
  SPIN_MIN: 12,
  SPIN_MAX: 26,
  /** Scale bump of the bounces (it hops toward the camera). */
  HOP: 0.5,
  /** Ejection port: this far forward of the body centre and to the right of the aim. */
  FORWARD_PX: 14,
  RIGHT_PX: 7,
  BRASS: 0xd9a441,
  SHELL: 0xc23b2b,
  /** Scale of the CASING_TEX_W × CASING_TEX_H texture per weapon. */
  SIZE: { pistol: 0.6, rifle: 0.68, shotgun: 0.85, sniper: 0.85 } as Record<WeaponId, number>,
  /** Pump / bolt: the shell comes out with the rack (matches game-audio RACK_AFTER_SHOT_S). */
  DELAY_MS: { pistol: 0, rifle: 0, shotgun: 350, sniper: 500 } as Record<WeaponId, number>,
} as const;

const CASING_TEX_W = 10;
const CASING_TEX_H = 20;

/** Flying, spinning, bouncing casings that settle and fade. Every attribute is dynamic. */
export class CasingField<P extends FxParticle> {
  private readonly born: Float64Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly spin: Float32Array;
  private readonly size: Float32Array;
  private next = 0;
  live = 0;

  constructor(readonly items: P[]) {
    const n = items.length;
    this.born = new Float64Array(n).fill(-1);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.spin = new Float32Array(n);
    this.size = new Float32Array(n);
    for (const p of items) park(p);
  }

  spawn(x: number, y: number, dir: number, speed: number, spin: number, size: number, tint: number, now: number): void {
    const n = this.items.length;
    if (!n) return;
    const i = this.next;
    this.next = (i + 1) % n;
    if (this.born[i]! < 0) this.live++;
    const p = this.items[i]!;
    p.x = x;
    p.y = y;
    p.rotation = dir;
    p.tint = tint;
    p.alpha = 1;
    p.scaleX = size;
    p.scaleY = size;
    this.born[i] = now;
    this.vx[i] = Math.cos(dir) * speed;
    this.vy[i] = Math.sin(dir) * speed;
    this.spin[i] = spin;
    this.size[i] = size;
  }

  step(dtMs: number, now: number): void {
    if (this.live === 0) return;
    const dt = Math.min(100, dtMs) / 1000;
    const drag = Math.exp(-Math.min(100, dtMs) / CASING.DRAG_TAU_MS);
    const fadeFrom = CASING.LIFE_MS - CASING.FADE_MS;
    for (let i = 0; i < this.items.length; i++) {
      const b = this.born[i]!;
      if (b < 0) continue;
      const p = this.items[i]!;
      const age = now - b;
      if (age >= CASING.LIFE_MS) {
        this.born[i] = -1;
        this.live--;
        park(p);
        continue;
      }
      if (age < CASING.FLY_MS) {
        p.x += this.vx[i]! * dt;
        p.y += this.vy[i]! * dt;
        p.rotation += this.spin[i]! * dt;
        this.vx[i]! *= drag;
        this.vy[i]! *= drag;
        this.spin[i]! *= drag;
        // Two bounces of decreasing height.
        const k = age / CASING.FLY_MS;
        const hop = CASING.HOP * Math.abs(Math.sin(2 * Math.PI * k)) * (1 - k);
        p.scaleX = p.scaleY = this.size[i]! * (1 + hop);
      } else if (p.scaleX !== this.size[i]) {
        p.scaleX = p.scaleY = this.size[i]!;
      }
      if (age > fadeFrom) p.alpha = 1 - (age - fadeFrom) / CASING.FADE_MS;
    }
  }
}

// ------------------------------------------------------------------------------- dust puffs

export const PUFF = {
  MAX: 128,
  DRAG_TAU_MS: 160,
  /** Footstep dust: particles per step and their size (world px) / life. */
  STEP_N: 3,
  STEP_SIZE: [5, 15] as const,
  STEP_LIFE_MS: 520,
  STEP_ALPHA: 0.45,
  ROLL_N: 7,
  ROLL_SIZE: [8, 26] as const,
  ROLL_LIFE_MS: 700,
  BODY_N: 12,
  BODY_SIZE: [10, 34] as const,
  BODY_LIFE_MS: 900,
  BODY_ALPHA: 0.55,
  BODY_TINT: 0xb8ab94,
} as const;

/** Texture radius (px) of the soft disc used for puffs and glows. */
const SOFT_TEX_R = 16;

/** Dust colour of a step material, or -1 when it does not raise dust (grass, wood, water, mud). */
export function dustTint(material: StepMaterial | string, wetness = 0): number {
  if (wetness > 0.5) return -1;
  switch (material) {
    case "dirt":
      return 0xc2a378;
    case "asphalt":
      return 0xb9b9b4;
    case "gravel":
      return 0xbdb3a3;
    case "concrete":
      return 0xc9c6bf;
    default:
      return -1;
  }
}

/**
 * Material variant (STEP_MATERIALS index) for the dust of a remote player's step / roll, or -1 for
 * none. Rolls are emitted without a material (variant 0 = grass), so their ground is sampled here
 * the way ownSteps samples ours; a quiet walk (ACT.WALK) raises no dust, like our own sneaking.
 */
export function remoteDustVariant(kind: number, wireVariant: unknown, act: number, map: MapData | null, x: number, y: number): number {
  if (kind === SoundKind.step && (act & ACT.WALK) !== 0) return -1;
  if (kind === SoundKind.roll) {
    if (!map) return -1;
    try {
      return surfaceAt(map, x, y).variant;
    } catch {
      return -1;
    }
  }
  return typeof wireVariant === "number" ? wireVariant : 0;
}

/** Expanding, slowing, fading soft discs. Every attribute is dynamic. */
export class PuffField<P extends FxParticle> {
  private readonly born: Float64Array;
  private readonly life: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly s0: Float32Array;
  private readonly s1: Float32Array;
  private readonly a0: Float32Array;
  private next = 0;
  live = 0;

  constructor(readonly items: P[]) {
    const n = items.length;
    this.born = new Float64Array(n).fill(-1);
    this.life = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.s0 = new Float32Array(n);
    this.s1 = new Float32Array(n);
    this.a0 = new Float32Array(n);
    for (const p of items) park(p);
  }

  /** Sizes are diameters in world px. */
  spawn(x: number, y: number, vx: number, vy: number, size0: number, size1: number, lifeMs: number, tint: number, alpha: number, now: number): void {
    const n = this.items.length;
    if (!n) return;
    const i = this.next;
    this.next = (i + 1) % n;
    if (this.born[i]! < 0) this.live++;
    const p = this.items[i]!;
    p.x = x;
    p.y = y;
    p.tint = tint;
    p.alpha = alpha;
    p.scaleX = p.scaleY = size0 / (2 * SOFT_TEX_R);
    this.born[i] = now;
    this.life[i] = lifeMs;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.s0[i] = size0;
    this.s1[i] = size1;
    this.a0[i] = alpha;
  }

  /** A ring of `n` puffs pushed outward from (x, y), biased toward `dir` by `bias` (0..1). */
  burst(
    x: number,
    y: number,
    n: number,
    dir: number,
    bias: number,
    speed: number,
    size: readonly [number, number],
    lifeMs: number,
    tint: number,
    alpha: number,
    now: number,
    rnd: () => number = Math.random,
  ): void {
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + rnd() * 0.8;
      const v = speed * (0.5 + rnd() * 0.5);
      const bx = Math.cos(dir) * bias * speed;
      const by = Math.sin(dir) * bias * speed;
      const s = size[0] * (0.7 + rnd() * 0.6);
      this.spawn(x + Math.cos(a) * 3, y + Math.sin(a) * 3, Math.cos(a) * v + bx, Math.sin(a) * v + by, s, size[1] * (0.8 + rnd() * 0.4), lifeMs * (0.8 + rnd() * 0.4), tint, alpha, now);
    }
  }

  step(dtMs: number, now: number): void {
    if (this.live === 0) return;
    const dt = Math.min(100, dtMs) / 1000;
    const drag = Math.exp(-Math.min(100, dtMs) / PUFF.DRAG_TAU_MS);
    for (let i = 0; i < this.items.length; i++) {
      const b = this.born[i]!;
      if (b < 0) continue;
      const p = this.items[i]!;
      const k = (now - b) / this.life[i]!;
      if (k >= 1) {
        this.born[i] = -1;
        this.live--;
        park(p);
        continue;
      }
      p.x += this.vx[i]! * dt;
      p.y += this.vy[i]! * dt;
      this.vx[i]! *= drag;
      this.vy[i]! *= drag;
      p.scaleX = p.scaleY = (this.s0[i]! + (this.s1[i]! - this.s0[i]!) * easeOut(k)) / (2 * SOFT_TEX_R);
      const f = 1 - k;
      p.alpha = this.a0[i]! * f * Math.sqrt(f);
    }
  }
}

// ------------------------------------------------------------------------------- delay queue

/** Deferred world FX (remote events on the past timeline, pump / bolt casings). */
export const FX_EV = { CASING: 1, BLOOD: 2, POOL: 3, BODY: 4, STEP: 5, ROLL: 6 } as const;

/** Fixed-capacity unsorted queue in typed arrays; `drain` calls `fire` for each due entry. */
export class FxQueue {
  readonly at: Float64Array;
  readonly kind: Uint8Array;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly a: Float64Array;
  readonly b: Float64Array;
  n = 0;

  constructor(readonly cap = 256) {
    this.at = new Float64Array(cap);
    this.kind = new Uint8Array(cap);
    this.x = new Float64Array(cap);
    this.y = new Float64Array(cap);
    this.a = new Float64Array(cap);
    this.b = new Float64Array(cap);
  }

  /** Returns false (and drops it) when the queue is full: cosmetic, never worth growing. */
  push(at: number, kind: number, x: number, y: number, a = 0, b = 0): boolean {
    const i = this.n;
    if (i >= this.cap) return false;
    this.at[i] = at;
    this.kind[i] = kind;
    this.x[i] = x;
    this.y[i] = y;
    this.a[i] = a;
    this.b[i] = b;
    this.n = i + 1;
    return true;
  }

  drain(now: number, fire: (kind: number, x: number, y: number, a: number, b: number) => void): void {
    let i = 0;
    while (i < this.n) {
      if (this.at[i]! > now) {
        i++;
        continue;
      }
      fire(this.kind[i]!, this.x[i]!, this.y[i]!, this.a[i]!, this.b[i]!);
      // Swap-remove (fire may push: n is re-read every iteration).
      const last = --this.n;
      if (i !== last) {
        this.at[i] = this.at[last]!;
        this.kind[i] = this.kind[last]!;
        this.x[i] = this.x[last]!;
        this.y[i] = this.y[last]!;
        this.a[i] = this.a[last]!;
        this.b[i] = this.b[last]!;
      }
    }
  }

  clear(): void {
    this.n = 0;
  }
}

// ------------------------------------------------------------------------------- ambient

export const AMBIENT = {
  MOTES: 40,
  FIREFLIES: 26,
  LEAVES: 16,
  ENV_MS: 250,
  FADE_TAU_MS: 700,
  /** Margin (world px) around the view the particles wrap within. */
  MARGIN: 80,
  /** How fast the forest factor follows the terrain under the camera. */
  FOREST_TAU_MS: 2500,
  MOTE_TINT: 0xfff3c4,
  FIREFLY_TINT: 0xd8ff6a,
  LEAF_TINTS: [0x6b8f2a, 0x8aa83a, 0xc79a2b, 0xa8642a] as const,
} as const;

export type AmbientMode = "mote" | "firefly" | "leaf";

const smoothstep = (a: number, b: number, v: number) => {
  const k = clamp01((v - a) / (b - a));
  return k * k * (3 - 2 * k);
};

/**
 * Target particle counts for an environment sample: motes need daylight and dry air, fireflies
 * need night and no rain, leaves follow the forest under the camera and the wind. Indoors: none.
 */
export function ambientTargets(
  env: { light: number; rain: number; fog: number; wind: number },
  indoor: boolean,
  forest: number,
  out: { motes: number; fireflies: number; leaves: number },
): { motes: number; fireflies: number; leaves: number } {
  if (indoor) {
    out.motes = out.fireflies = out.leaves = 0;
    return out;
  }
  const day = smoothstep(0.35, 0.8, env.light);
  const night = 1 - smoothstep(0.15, 0.4, env.light);
  const dry = 1 - clamp01(env.rain * 1.5);
  out.motes = AMBIENT.MOTES * day * dry * (1 - 0.6 * clamp01(env.fog));
  out.fireflies = AMBIENT.FIREFLIES * night * dry * (1 - 0.5 * clamp01(env.fog));
  out.leaves = AMBIENT.LEAVES * (0.2 + 0.8 * clamp01(forest)) * (0.6 + 0.4 * clamp01(env.wind)) * (1 - 0.5 * clamp01(env.rain));
  return out;
}

export interface FxView {
  left: number;
  top: number;
  w: number;
  h: number;
}

/**
 * World-locked ambient particles wrapped into the view (like weather-fx's RainField), each with a
 * fade envelope so count changes never pop. `count` may be fractional; particles [0, count) are on.
 */
export class AmbientField<P extends FxParticle> {
  private readonly phase: Float32Array;
  private readonly speed: Float32Array;
  private readonly fade: Float32Array;
  private readonly base: Float32Array;
  private readonly parked: Uint8Array;

  constructor(
    readonly items: P[],
    readonly mode: AmbientMode,
    private readonly rnd: () => number = Math.random,
  ) {
    const n = items.length;
    this.phase = new Float32Array(n);
    this.speed = new Float32Array(n);
    this.fade = new Float32Array(n);
    this.base = new Float32Array(n);
    this.parked = new Uint8Array(n).fill(1);
    for (let i = 0; i < n; i++) {
      this.phase[i] = rnd() * Math.PI * 2;
      this.speed[i] = 0.6 + rnd() * 0.8;
      this.base[i] = items[i]!.scaleX;
      park(items[i]!);
    }
  }

  /** Particles currently drawn (fade > 0). */
  get shown(): number {
    let n = 0;
    for (let i = 0; i < this.fade.length; i++) if (this.fade[i]! > 0) n++;
    return n;
  }

  step(dtMs: number, tSec: number, view: FxView, count: number, wind: number): void {
    const dt = Math.min(100, Math.max(0, dtMs)) / 1000;
    const fk = 1 - Math.exp(-Math.min(100, dtMs) / AMBIENT.FADE_TAU_MS);
    const { left, top, w, h } = view;
    for (let i = 0; i < this.items.length; i++) {
      const on = i < count;
      let f = this.fade[i]!;
      if (!on && f === 0) continue;
      const p = this.items[i]!;
      f += ((on ? 1 : 0) - f) * fk;
      if (!on && f < 0.01) {
        this.fade[i] = 0;
        this.parked[i] = 1;
        park(p);
        continue;
      }
      this.fade[i] = f;
      if (this.parked[i]) {
        this.parked[i] = 0;
        p.x = left + this.rnd() * w;
        p.y = top + this.rnd() * h;
      }
      const ph = this.phase[i]!;
      const sp = this.speed[i]!;
      if (this.mode === "mote") {
        p.x += (6 + wind * 30 + Math.sin(tSec * 0.6 * sp + ph) * 8) * dt;
        p.y += (2 + Math.cos(tSec * 0.5 * sp + ph * 1.3) * 6) * dt;
        p.alpha = f * (0.28 + 0.18 * Math.sin(tSec * 1.1 * sp + ph));
      } else if (this.mode === "firefly") {
        p.x += Math.cos(tSec * 0.45 * sp + ph) * 24 * dt;
        p.y += Math.sin(tSec * 0.33 * sp + ph * 1.7) * 24 * dt;
        const s = Math.sin(tSec * 1.3 * sp + ph);
        p.alpha = s > 0 ? f * s * s * s * 0.95 : 0;
      } else {
        p.x += (14 + wind * 55 + Math.sin(tSec * 0.7 + ph) * 10) * dt;
        p.y += (10 + Math.sin(tSec * 0.9 * sp + ph) * 14) * dt;
        p.rotation += (ph > Math.PI ? 1 : -1) * (0.8 + sp) * dt;
        // Flutter: the leaf turns over, so it looks thinner, then wider.
        p.scaleX = this.base[i]! * (0.5 + 0.5 * Math.abs(Math.cos(tSec * 2.6 * sp + ph)));
        p.alpha = f * 0.9;
      }
      p.x = left + wrapIn(p.x - left, w);
      p.y = top + wrapIn(p.y - top, h);
    }
  }
}

// ------------------------------------------------------------------------------- textures

export interface WorldFxTextures {
  splat: Texture;
  casing: Texture;
  soft: Texture;
  leaf: Texture;
}

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): Texture {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d")!);
  return new Texture({ source: new ImageSource({ resource: c, scaleMode: "linear" }) });
}

function makeWorldFxTextures(): WorldFxTextures {
  // Deterministic little LCG so the splat looks the same every session.
  let seed = 1337;
  const r = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const splat = canvasTexture(SPLAT_TEX, SPLAT_TEX, (g) => {
    const c = SPLAT_TEX / 2;
    g.fillStyle = "#ffffff";
    g.beginPath();
    const n = 14;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const rad = SPLAT_TEX * (0.2 + r() * 0.09);
      const x = c + Math.cos(a) * rad;
      const y = c + Math.sin(a) * rad;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.closePath();
    g.fill();
    for (let i = 0; i < 9; i++) {
      const a = r() * Math.PI * 2;
      const d = SPLAT_TEX * (0.26 + r() * 0.2);
      g.beginPath();
      g.arc(c + Math.cos(a) * d, c + Math.sin(a) * d, 1.5 + r() * 3.5, 0, Math.PI * 2);
      g.fill();
    }
  });
  const casing = canvasTexture(CASING_TEX_W, CASING_TEX_H, (g) => {
    // Cartoon casing: dark outline (stays dark under the tint), white body, rim and highlight.
    g.fillStyle = "#1a1a1a";
    g.beginPath();
    g.roundRect(0.5, 0.5, CASING_TEX_W - 1, CASING_TEX_H - 1, 3);
    g.fill();
    g.fillStyle = "#ffffff";
    g.beginPath();
    g.roundRect(2, 2, CASING_TEX_W - 4, CASING_TEX_H - 4, 2);
    g.fill();
    g.fillStyle = "rgba(0,0,0,0.3)";
    g.fillRect(2, CASING_TEX_H - 6, CASING_TEX_W - 4, 2);
    g.fillStyle = "rgba(255,255,255,0.95)";
    g.fillRect(3, 3, 2, CASING_TEX_H - 10);
  });
  const soft = canvasTexture(SOFT_TEX_R * 2, SOFT_TEX_R * 2, (g) => {
    const grad = g.createRadialGradient(SOFT_TEX_R, SOFT_TEX_R, 0, SOFT_TEX_R, SOFT_TEX_R, SOFT_TEX_R);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.45, "rgba(255,255,255,0.6)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, SOFT_TEX_R * 2, SOFT_TEX_R * 2);
  });
  const leaf = canvasTexture(24, 14, (g) => {
    g.fillStyle = "#ffffff";
    g.beginPath();
    g.moveTo(1, 7);
    g.quadraticCurveTo(12, -3, 23, 7);
    g.quadraticCurveTo(12, 17, 1, 7);
    g.fill();
    g.strokeStyle = "rgba(0,0,0,0.3)";
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(2, 7);
    g.lineTo(22, 7);
    g.stroke();
  });
  return { splat, casing, soft, leaf };
}

function particlePool(n: number, texture: Texture, init?: (p: Particle, i: number) => void): Particle[] {
  const out: Particle[] = [];
  for (let i = 0; i < n; i++) {
    const p = new Particle({ texture, anchorX: 0.5, anchorY: 0.5 });
    init?.(p, i);
    out.push(p);
  }
  return out;
}

function makePc(texture: Texture, dynamic: { position: boolean; vertex: boolean; rotation: boolean; color: boolean }, items: Particle[]): ParticleContainer {
  const pc = new ParticleContainer({ texture, dynamicProperties: { ...dynamic, uvs: false } });
  pc.addParticle(...items);
  // ParticleContainers have no bounds: never let a culler drop them.
  pc.cullable = false;
  pc.eventMode = "none";
  return pc;
}

// ------------------------------------------------------------------------------- world-fx system

class WorldFxSystem implements GameSystem {
  readonly id = "world-fx";
  private tex: WorldFxTextures | null = null;
  private decalPc: ParticleContainer | null = null;
  private casingPc: ParticleContainer | null = null;
  private puffPc: ParticleContainer | null = null;
  private decals: DecalField<Particle> | null = null;
  private casings: CasingField<Particle> | null = null;
  private puffs: PuffField<Particle> | null = null;
  private decalsDirty = false;
  private readonly queue = new FxQueue(256);
  private map: MapData | null = null;
  private sid = "";

  // Own footsteps (same stride as the server's footstep emitter).
  private lastX = Number.NaN;
  private lastY = Number.NaN;
  private stride = 0;
  private foot = 1;
  private prevRoll = 0;

  // Environment (wet ground: no dust).
  private cfg: EnvConfig | null = null;
  private readonly envSrc = emptyEnvSource();
  private wetness = 0;
  private nextEnvAt = 0;

  // Per-batch scratch: blood is summed per target so 7 shotgun pellets make one spray.
  private readonly hitT: string[] = [];
  private readonly hitD: number[] = [];
  private readonly hitX: number[] = [];
  private readonly hitY: number[] = [];
  private readonly hitA: number[] = [];

  private readonly fire = (kind: number, x: number, y: number, a: number, b: number) => this.fireNow(kind, x, y, a, b, performance.now());

  init(ctx: GameContext): void {
    const tex = makeWorldFxTextures();
    this.tex = tex;
    const decals = particlePool(BLOOD.MAX, tex.splat);
    this.decalPc = makePc(tex.splat, { position: false, rotation: false, vertex: true, color: true }, decals);
    this.decals = new DecalField(decals);
    const casings = particlePool(CASING.MAX, tex.casing);
    this.casingPc = makePc(tex.casing, { position: true, rotation: true, vertex: true, color: true }, casings);
    this.casings = new CasingField(casings);
    const puffs = particlePool(PUFF.MAX, tex.soft);
    this.puffPc = makePc(tex.soft, { position: true, rotation: false, vertex: true, color: true }, puffs);
    this.puffs = new PuffField(puffs);
    this.decalPc.label = "fx-blood";
    this.casingPc.label = "fx-casings";
    this.puffPc.label = "fx-dust";
    ctx.layers.ground.addChild(this.decalPc);
    ctx.layers.worldFx.addChild(this.casingPc, this.puffPc);
    this.decalPc.update();
  }

  onEvents(ev: EventsMsg, ctx: GameContext): void {
    if (!this.tex) return;
    const sid = (this.sid = ctx.room.sessionId);
    const now = performance.now();
    const state = ctx.state();

    if (ev.shots) {
      for (const s of ev.shots) {
        if (!s || !s.s || !Array.isArray(s.a) || !s.a.length || !(s.w in WEAPONS)) continue;
        let sum = 0;
        for (const v of s.a) sum += v;
        const aim = sum / s.a.length;
        const self = s.s === sid;
        const c = self ? ctx.selfPos() : null;
        const cx = c ? c.x : s.cx;
        const cy = c ? c.y : s.cy;
        // Ejection port: forward of the body, on the right of the aim (y-down: right = aim + 90°).
        const x = cx + Math.cos(aim) * CASING.FORWARD_PX - Math.sin(aim) * CASING.RIGHT_PX;
        const y = cy + Math.sin(aim) * CASING.FORWARD_PX + Math.cos(aim) * CASING.RIGHT_PX;
        const at = now + (self ? 0 : FX_REMOTE_DELAY_MS) + (CASING.DELAY_MS[s.w] ?? 0);
        this.queue.push(at, FX_EV.CASING, x, y, aim, WEAPON_INDEX[s.w] ?? 0);
      }
    }

    if (ev.hits) {
      const T = this.hitT;
      T.length = this.hitD.length = this.hitX.length = this.hitY.length = this.hitA.length = 0;
      for (const h of ev.hits) {
        if (!h || !(h.d > 0)) continue;
        let k = T.indexOf(h.t);
        if (k < 0) {
          k = T.length;
          T.push(h.t);
          this.hitD.push(0);
          this.hitX.push(h.x);
          this.hitY.push(h.y);
          this.hitA.push(this.sprayAngle(h.s, h.t, h.x, h.y, h.fa, ctx));
        }
        this.hitD[k]! += h.d;
      }
      for (let k = 0; k < T.length; k++) {
        const at = T[k] === sid ? now : now + FX_REMOTE_DELAY_MS;
        this.queue.push(at, FX_EV.BLOOD, this.hitX[k]!, this.hitY[k]!, this.hitA[k]!, this.hitD[k]!);
      }
    }

    if (ev.kills) {
      for (const m of ev.kills) {
        if (!m) continue;
        if (m.victimId === sid) {
          const p = ctx.selfPos();
          this.queue.push(now, FX_EV.POOL, p.x, p.y);
          this.queue.push(now + 60, FX_EV.BODY, p.x, p.y);
          continue;
        }
        // Only bodies this client can see (KILL is broadcast with names only).
        const v = state?.players.get(m.victimId);
        if (!v) continue;
        this.queue.push(now + FX_REMOTE_DELAY_MS, FX_EV.POOL, v.x, v.y);
        this.queue.push(now + FX_REMOTE_DELAY_MS + 60, FX_EV.BODY, v.x, v.y);
      }
    }

    // Visible remote footsteps / rolls (ev.snd.v: [kind, sessionId, variant] — variant = material).
    const v = ev.snd?.v;
    if (Array.isArray(v) && state) {
      for (let i = 0; i + 2 < v.length; i += 3) {
        const kind = v[i];
        if (kind !== SoundKind.step && kind !== SoundKind.roll) continue;
        const id = v[i + 1];
        if (typeof id !== "string" || id === sid) continue;
        const p = state.players.get(id);
        if (!p) continue;
        const variant = remoteDustVariant(kind, v[i + 2], p.act, ctx.map(), p.x, p.y);
        if (variant < 0) continue;
        this.queue.push(now + FX_REMOTE_DELAY_MS, kind === SoundKind.roll ? FX_EV.ROLL : FX_EV.STEP, p.x, p.y, p.aim, variant);
      }
    }
  }

  /** Direction the blood sprays: away from the shooter when we know where they are. */
  private sprayAngle(shooter: string, target: string, x: number, y: number, fa: number | undefined, ctx: GameContext): number {
    if (target === this.sid && typeof fa === "number") return fa + Math.PI;
    let sx = Number.NaN;
    let sy = Number.NaN;
    if (shooter && shooter === this.sid) {
      const p = ctx.selfPos();
      sx = p.x;
      sy = p.y;
    } else if (shooter) {
      const p = ctx.state()?.players.get(shooter);
      if (p) {
        sx = p.x;
        sy = p.y;
      }
    }
    if (Number.isFinite(sx) && (x !== sx || y !== sy)) return Math.atan2(y - sy, x - sx);
    return Math.random() * Math.PI * 2;
  }

  /** Material index (STEP_MATERIALS) → dust tint, honouring wet ground. */
  private dustOf(variant: number): number {
    return dustTint(STEP_MATERIALS[variant] ?? "grass", this.wetness);
  }

  private fireNow(kind: number, x: number, y: number, a: number, b: number, now: number): void {
    const puffs = this.puffs;
    if (!puffs || !this.decals || !this.casings) return;
    switch (kind) {
      case FX_EV.CASING: {
        const w = WEAPON_IDS_BY_INDEX[b] ?? "pistol";
        const dir = a + Math.PI / 2 + (Math.random() - 0.5) * 0.7;
        const speed = CASING.SPEED_MIN + Math.random() * (CASING.SPEED_MAX - CASING.SPEED_MIN);
        const spin = (CASING.SPIN_MIN + Math.random() * (CASING.SPIN_MAX - CASING.SPIN_MIN)) * (Math.random() < 0.5 ? -1 : 1);
        this.casings.spawn(x, y, dir, speed, spin, CASING.SIZE[w], w === "shotgun" ? CASING.SHELL : CASING.BRASS, now);
        break;
      }
      case FX_EV.BLOOD: {
        const n = bloodSplats(b);
        for (let k = 0; k < n; k++) {
          const d = BLOOD.SPRAY_PX * (0.3 + Math.random() * 0.9) * (k + 1) * 0.7;
          const ang = a + (Math.random() - 0.5) * 0.6;
          const s = BLOOD.SIZE_MIN + Math.random() * (BLOOD.SIZE_MAX - BLOOD.SIZE_MIN) * (k === 0 ? 1 : 0.7);
          // Stretched along the spray, like a real splatter.
          this.decals.spawn(
            x + Math.cos(ang) * d,
            y + Math.sin(ang) * d,
            s * 1.35,
            s * 0.8,
            ang,
            BLOOD.TINTS[(Math.random() * BLOOD.TINTS.length) | 0]!,
            BLOOD.ALPHA,
            now,
          );
        }
        if (n) this.decalsDirty = true;
        break;
      }
      case FX_EV.POOL:
        this.decals.spawn(x, y + 4, BLOOD.POOL_SIZE, BLOOD.POOL_SIZE * 0.8, Math.random() * Math.PI, BLOOD.POOL_TINT, BLOOD.POOL_ALPHA, now, BLOOD.POOL_GROW_MS);
        this.decalsDirty = true;
        break;
      case FX_EV.BODY:
        puffs.burst(x, y + 6, PUFF.BODY_N, 0, 0, 70, PUFF.BODY_SIZE, PUFF.BODY_LIFE_MS, PUFF.BODY_TINT, PUFF.BODY_ALPHA, now);
        break;
      case FX_EV.STEP: {
        const tint = this.dustOf(b);
        if (tint >= 0) this.stepDust(x, y, a, tint, now);
        break;
      }
      case FX_EV.ROLL: {
        const tint = this.dustOf(b);
        if (tint >= 0) puffs.burst(x, y + 8, PUFF.ROLL_N, a + Math.PI, 0.3, 55, PUFF.ROLL_SIZE, PUFF.ROLL_LIFE_MS, tint, PUFF.STEP_ALPHA, now);
        break;
      }
    }
  }

  /** A few small dust puffs at the feet, kicked backward from the movement direction. */
  private stepDust(x: number, y: number, dir: number, tint: number, now: number): void {
    const puffs = this.puffs!;
    this.foot = -this.foot;
    const fx = x - Math.sin(dir) * 6 * this.foot;
    const fy = y + 10 + Math.cos(dir) * 6 * this.foot;
    for (let k = 0; k < PUFF.STEP_N; k++) {
      const a = dir + Math.PI + (Math.random() - 0.5) * 1.6;
      const v = 18 + Math.random() * 22;
      puffs.spawn(fx, fy, Math.cos(a) * v, Math.sin(a) * v, PUFF.STEP_SIZE[0], PUFF.STEP_SIZE[1] * (0.7 + Math.random() * 0.5), PUFF.STEP_LIFE_MS, tint, PUFF.STEP_ALPHA, now);
    }
  }

  frame(dtMs: number, ctx: GameContext): void {
    if (!this.tex) return;
    const now = performance.now();
    const map = ctx.map();
    const state = ctx.state();
    if (map !== this.map) {
      this.map = map;
      this.lastX = Number.NaN;
    }
    if (map && state && now >= this.nextEnvAt) {
      this.nextEnvAt = now + AMBIENT.ENV_MS;
      try {
        if (!this.cfg || !sameEnvSource(this.envSrc, state, map)) {
          rememberEnvSource(this.envSrc, state, map);
          this.cfg = envConfigOf({ envSeed: state.envSeed, todStartMin: state.todStartMin, durationMs: state.durationMs || MATCH.DURATION_MS, weatherOverride: state.weatherOverride }, map);
        }
        this.wetness = sampleEnv(this.cfg, ctx.clockMs()).wetness;
      } catch {
        this.wetness = 0;
      }
    }
    this.ownSteps(ctx, map, now);
    this.queue.drain(now, this.fire);
    this.decals!.step(now);
    if (this.decalsDirty) {
      this.decalsDirty = false;
      this.decalPc!.update();
    }
    this.casings!.step(dtMs, now);
    this.puffs!.step(dtMs, now);
  }

  /** Our own footsteps never come back from the server: derive them from predicted travel. */
  private ownSteps(ctx: GameContext, map: MapData | null, now: number): void {
    const me = ctx.me();
    const self = ctx.self();
    if (!map || !me || !me.alive || !self || self.extractedAt > 0) {
      this.lastX = Number.NaN;
      return;
    }
    const p = ctx.selfPos();
    if (!Number.isFinite(this.lastX)) {
      this.lastX = p.x;
      this.lastY = p.y;
      this.prevRoll = self.rollLeft;
      return;
    }
    const dx = p.x - this.lastX;
    const dy = p.y - this.lastY;
    this.lastX = p.x;
    this.lastY = p.y;
    const d = Math.hypot(dx, dy);
    const rolling = self.rollLeft > 0;
    if (rolling && this.prevRoll === 0) {
      const tint = this.dustAt(map, p.x, p.y);
      if (tint >= 0) this.puffs!.burst(p.x, p.y + 8, PUFF.ROLL_N, Math.atan2(-self.rollDy, -self.rollDx), 0.3, 55, PUFF.ROLL_SIZE, PUFF.ROLL_LIFE_MS, tint, PUFF.STEP_ALPHA, now);
    }
    this.prevRoll = self.rollLeft;
    if (d > 200 || rolling) return; // teleport / respawn, or a roll (no steps, like the server)
    this.stride += d;
    if (this.stride < SOUND.STEP_EVERY_PX) return;
    this.stride -= SOUND.STEP_EVERY_PX;
    if (this.stride > SOUND.STEP_EVERY_PX) this.stride = 0;
    if (self.walking) return; // sneaking raises no dust
    const tint = this.dustAt(map, p.x, p.y);
    if (tint >= 0) this.stepDust(p.x, p.y, Math.atan2(dy, dx), tint, now);
  }

  private dustAt(map: MapData, x: number, y: number): number {
    try {
      return dustTint(surfaceAt(map, x, y).material, this.wetness);
    } catch {
      return -1;
    }
  }

  dispose(): void {
    for (const pc of [this.decalPc, this.casingPc, this.puffPc]) {
      if (!pc) continue;
      pc.removeFromParent();
      pc.destroy({ children: true, texture: false, textureSource: false });
    }
    this.decalPc = this.casingPc = this.puffPc = null;
    this.decals = null;
    this.casings = null;
    this.puffs = null;
    this.queue.clear();
    if (this.tex) {
      for (const t of Object.values(this.tex)) t.destroy(true);
      this.tex = null;
    }
  }
}

const WEAPON_IDS_BY_INDEX: readonly WeaponId[] = ["pistol", "rifle", "shotgun", "sniper"];
const WEAPON_INDEX: Record<string, number> = { pistol: 0, rifle: 1, shotgun: 2, sniper: 3 };

/** GameSystem factory for the renderer registry (systems-registry.ts). */
export function createWorldFxSystem(): GameSystem {
  return new WorldFxSystem();
}

// ------------------------------------------------------------------------------- ambient system

class AmbientSystem implements GameSystem {
  readonly id = "ambient";
  private tex: WorldFxTextures | null = null;
  private glowPc: ParticleContainer | null = null;
  private leafPc: ParticleContainer | null = null;
  private motes: AmbientField<Particle> | null = null;
  private fireflies: AmbientField<Particle> | null = null;
  private leaves: AmbientField<Particle> | null = null;
  private cfg: EnvConfig | null = null;
  private readonly envSrc = emptyEnvSource();
  private nextEnvAt = 0;
  private indoor = false;
  private forest = 0;
  private forestTarget = 0;
  private wind = 0;
  private t = 0;
  private readonly env = { light: 1, rain: 0, fog: 0, wind: 0 };
  private readonly targets = { motes: 0, fireflies: 0, leaves: 0 };
  private readonly view: FxView = { left: 0, top: 0, w: 1, h: 1 };

  init(ctx: GameContext): void {
    // Only the soft disc and the leaf are drawn here; the other two textures are tiny (64 px).
    const tex = makeWorldFxTextures();
    this.tex = tex;
    const glow = particlePool(AMBIENT.MOTES + AMBIENT.FIREFLIES, tex.soft, (p, i) => {
      const mote = i < AMBIENT.MOTES;
      p.tint = mote ? AMBIENT.MOTE_TINT : AMBIENT.FIREFLY_TINT;
      p.scaleX = p.scaleY = (mote ? 2.4 + Math.random() * 2.6 : 11 + Math.random() * 6) / (2 * SOFT_TEX_R);
    });
    const leaves = particlePool(AMBIENT.LEAVES, tex.leaf, (p, i) => {
      p.tint = AMBIENT.LEAF_TINTS[i % AMBIENT.LEAF_TINTS.length]!;
      p.scaleX = p.scaleY = 0.45 + Math.random() * 0.3;
      p.rotation = Math.random() * Math.PI * 2;
    });
    this.motes = new AmbientField(glow.slice(0, AMBIENT.MOTES), "mote");
    this.fireflies = new AmbientField(glow.slice(AMBIENT.MOTES), "firefly");
    this.leaves = new AmbientField(leaves, "leaf");
    this.glowPc = makePc(tex.soft, { position: true, rotation: false, vertex: false, color: true }, glow);
    this.glowPc.blendMode = "add";
    this.glowPc.label = "fx-ambient-glow";
    this.leafPc = makePc(tex.leaf, { position: true, rotation: true, vertex: true, color: true }, leaves);
    this.leafPc.label = "fx-ambient-leaves";
    ctx.layers.worldTop.addChild(this.leafPc);
    // Glows live in world coordinates but are drawn ABOVE the fog / night darkness (screen layer,
    // bottom-most), with the world transform copied each frame: fireflies glowing in the dark
    // outside the vision cone are pure decoration (random positions, no information).
    ctx.layers.screen.addChildAt(this.glowPc, 0);
  }

  frame(dtMs: number, ctx: GameContext): void {
    const glow = this.glowPc;
    const leafPc = this.leafPc;
    if (!glow || !leafPc || !this.tex) return;
    const map = ctx.map();
    const state = ctx.state();
    if (!map || !state) return;
    const now = performance.now();
    this.t += Math.min(100, dtMs) / 1000;
    const cam = ctx.camera();
    if (now >= this.nextEnvAt) {
      this.nextEnvAt = now + AMBIENT.ENV_MS;
      this.sampleEnv(ctx, map, cam.x, cam.y);
    }
    this.forest += (this.forestTarget - this.forest) * (1 - Math.exp(-Math.min(100, dtMs) / AMBIENT.FOREST_TAU_MS));
    const tg = ambientTargets(this.env, this.indoor, this.forest, this.targets);

    const z = cam.zoom > 0 ? cam.zoom : 1;
    const v = this.view;
    v.w = cam.width / z + AMBIENT.MARGIN * 2;
    v.h = cam.height / z + AMBIENT.MARGIN * 2;
    v.left = cam.x - v.w / 2;
    v.top = cam.y - v.h / 2;

    glow.scale.set(z);
    glow.position.set(cam.width / 2 - cam.x * z, cam.height / 2 - cam.y * z);
    this.motes!.step(dtMs, this.t, v, tg.motes, this.wind);
    this.fireflies!.step(dtMs, this.t, v, tg.fireflies, this.wind);
    this.leaves!.step(dtMs, this.t, v, tg.leaves, this.wind);
    glow.visible = tg.motes > 0 || tg.fireflies > 0 || this.motes!.shown + this.fireflies!.shown > 0;
    leafPc.visible = tg.leaves > 0 || this.leaves!.shown > 0;
  }

  private sampleEnv(ctx: GameContext, map: MapData, x: number, y: number): void {
    const state = ctx.state()!;
    try {
      if (!this.cfg || !sameEnvSource(this.envSrc, state, map)) {
        rememberEnvSource(this.envSrc, state, map);
        this.cfg = envConfigOf({ envSeed: state.envSeed, todStartMin: state.todStartMin, durationMs: state.durationMs || MATCH.DURATION_MS, weatherOverride: state.weatherOverride }, map);
      }
      const e = sampleEnv(this.cfg, ctx.clockMs());
      // A lightning flash is not daylight: keep the last light level through it.
      if (!(e.flash > 0)) this.env.light = e.light;
      this.env.rain = e.rain;
      this.env.fog = e.fog;
      this.env.wind = e.wind;
      this.wind = e.wind;
    } catch {
      /* keep the last sample */
    }
    try {
      const p = ctx.selfPos();
      this.indoor = isIndoor(map, p.x, p.y);
      this.forestTarget = (terrainByteAt(map, x, y) & TERRAIN_KIND_MASK) === TERRAIN.FOREST ? 1 : 0;
    } catch {
      this.indoor = false;
      this.forestTarget = 0;
    }
  }

  dispose(): void {
    for (const pc of [this.glowPc, this.leafPc]) {
      if (!pc) continue;
      pc.removeFromParent();
      pc.destroy({ children: true, texture: false, textureSource: false });
    }
    this.glowPc = this.leafPc = null;
    this.motes = this.fireflies = this.leaves = null;
    if (this.tex) {
      for (const t of Object.values(this.tex)) t.destroy(true);
      this.tex = null;
    }
  }
}

/** GameSystem factory for the renderer registry (systems-registry.ts). */
export function createAmbientSystem(): GameSystem {
  return new AmbientSystem();
}
