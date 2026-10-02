/**
 * Short-lived cosmetic effects: tracers, muzzle flashes, impact particles, chest bursts,
 * floating damage numbers, screen shake and the red "you were hit" vignette.
 * Everything vector is drawn into one Graphics that is rebuilt every frame (cheap at these
 * counts and avoids creating/destroying display objects per bullet).
 */

import { Container, Graphics, ImageSource, Sprite, Text, Texture } from "pixi.js";
import { WEAPONS, type CollisionIndex, type WeaponId } from "@extract/shared";
import { COLORS } from "./assets";
import { tracerLengths } from "./shots";

interface Tracer {
  shooter: string;
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

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  born: number;
  life: number;
  color: number;
  size: number;
}

interface Flash {
  x: number;
  y: number;
  a: number;
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

export class Effects {
  /** World-space vector effects (below canopies). */
  readonly layer = new Graphics();
  /** World-space floating numbers (above everything in the world). */
  readonly floatLayer = new Container();
  /** Screen-space red vignette; the renderer adds it to the stage and sizes it. */
  readonly vignette: Sprite;
  private vignetteTex: Texture;

  private tracers: Tracer[] = [];
  private particles: Particle[] = [];
  private flashes: Flash[] = [];
  private rings: Ring[] = [];
  private numbers: FloatNumber[] = [];
  private textPool: Text[] = [];
  private shakeAmp = 0;
  private hurt = 0;

  constructor() {
    this.vignetteTex = makeVignetteTexture();
    this.vignette = new Sprite(this.vignetteTex);
    this.vignette.alpha = 0;
    this.vignette.eventMode = "none";
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
      this.tracers.push({
        shooter, sx: x, sy: y, dx: Math.cos(a), dy: Math.sin(a), len, speed: def.bulletSpeed, born: now,
        width: weapon === "sniper" ? 4 : weapon === "shotgun" ? 2.5 : 3,
      });
    });
    if (this.tracers.length > MAX_TRACERS) this.tracers.splice(0, this.tracers.length - MAX_TRACERS);
    const avg = angles.length ? sumA / angles.length : 0;
    this.flashes.push({ x, y, a: avg, born: now, size: weapon === "shotgun" || weapon === "sniper" ? 1.4 : 1 });
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
      this.particles.push({
        x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, born: now,
        life: 250 + Math.random() * 200, color, size: 2.5 + Math.random() * 3,
      });
    }
    if (this.particles.length > MAX_PARTICLES) this.particles.splice(0, this.particles.length - MAX_PARTICLES);
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
    const g = this.layer;
    g.clear();

    // Tracers: a short streak whose head flies at bulletSpeed and whose tail catches up at the end.
    let w = 0;
    for (const t of this.tracers) {
      const age = (now - t.born) / 1000;
      const head = Math.min(t.len, age * t.speed);
      const tail = Math.max(0, age * t.speed - TRACER_LEN);
      if (tail >= t.len) continue;
      this.tracers[w++] = t;
      if (head <= tail) continue;
      const x0 = t.sx + t.dx * tail;
      const y0 = t.sy + t.dy * tail;
      const x1 = t.sx + t.dx * head;
      const y1 = t.sy + t.dy * head;
      g.moveTo(x0, y0).lineTo(x1, y1).stroke({ width: t.width + 2, color: COLORS.tracer, alpha: 0.45, cap: "round" });
      g.moveTo(x0, y0).lineTo(x1, y1).stroke({ width: t.width * 0.5, color: COLORS.tracerCore, alpha: 0.95, cap: "round" });
    }
    this.tracers.length = w;

    w = 0;
    for (const f of this.flashes) {
      const k = (now - f.born) / FLASH_MS;
      if (k >= 1) continue;
      this.flashes[w++] = f;
      const s = f.size * (1 - k * 0.5);
      const cos = Math.cos(f.a);
      const sin = Math.sin(f.a);
      const pts = [
        [22 * s, 0], [6 * s, 7 * s], [0, 12 * s * 0.6], [-3 * s, 0], [0, -12 * s * 0.6], [6 * s, -7 * s],
      ].flatMap(([px, py]) => [f.x + px! * cos - py! * sin, f.y + px! * sin + py! * cos]);
      g.poly(pts).fill({ color: 0xffd34d, alpha: 0.9 * (1 - k) });
      g.circle(f.x + cos * 4 * s, f.y + sin * 4 * s, 5 * s).fill({ color: 0xffffff, alpha: 0.9 * (1 - k) });
    }
    this.flashes.length = w;

    const dt = dtMs / 1000;
    w = 0;
    for (const p of this.particles) {
      const k = (now - p.born) / p.life;
      if (k >= 1) continue;
      this.particles[w++] = p;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.9;
      p.vy *= 0.9;
      g.circle(p.x, p.y, p.size * (1 - k * 0.6)).fill({ color: p.color, alpha: 1 - k });
    }
    this.particles.length = w;

    w = 0;
    for (const r of this.rings) {
      const k = (now - r.born) / r.life;
      if (k >= 1) continue;
      this.rings[w++] = r;
      g.circle(r.x, r.y, r.maxR * (0.3 + 0.7 * k)).stroke({ width: 5 * (1 - k) + 1, color: r.color, alpha: 1 - k });
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
    this.layer.destroy();
    this.floatLayer.destroy({ children: true });
    this.vignette.destroy();
    this.vignetteTex.destroy(true);
  }
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
