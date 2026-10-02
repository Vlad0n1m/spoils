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
import { WEAPONS, type CollisionIndex, type WeaponId } from "@extract/shared";
import { COLORS } from "./assets";
import { tracerLengths } from "./shots";

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
