/**
 * Hand grenades on the client (Weapons v2, docs/WEAPONS_V2.md §4; numbers in shared GRENADE).
 *
 * The server computes a grenade's whole flight when it is thrown (shared grenadePath) and sends it
 * once per recipient in `ev.nades` (GrenadeMsg: a polyline [x, y, t…] with t = ms after the throw,
 * or just the resting point for someone who sees only where it landed). This system:
 * - moves the grenade along that polyline with the same constant deceleration the server used
 *   (exact: the deceleration is recovered from the first segment), a small hop over the first
 *   segment and a shadow, spinning while it moves;
 * - draws the warning ring (radius GRENADE.EDGE_PX) over the last GRENADE.WARN_MS of the fuse;
 * - plays the explosion (`ev.booms`, authoritative) from explosion_sheet.png (8 × 128 px frames,
 *   EXPLOSION_FRAME_MS each) with a quick shock ring; a grenade whose BoomMsg never comes (out of
 *   view) is dropped LINGER_MS after its fuse;
 * - draws the aim preview of the touch grenade button (GameContext.grenadeAim): the real bounce
 *   path from shared grenadePath and the blast radius where it would rest.
 * Audio (explosion, pin, bounce) is game-audio.ts, the blast shake camera.ts. Nothing here is
 * authoritative: damage, kills and the blast position all come from the server.
 */

import { Container, Graphics, GraphicsContext, Rectangle, Sprite, Texture } from "pixi.js";
import {
  GRENADE,
  getCollisionIndex,
  grenadePath,
  grenadeThrowPx,
  type BoomMsg,
  type EventsMsg,
  type GrenadeMsg,
} from "@extract/shared";
import { EXPLOSION_DRAW_PX, EXPLOSION_FRAMES, EXPLOSION_FRAME_MS, GRENADE_DRAW_PX } from "./assets";
import { IconCache } from "./entities";
import type { GameContext, GameSystem } from "./systems";

/** A tap on the grenade button (no drag) throws ahead at this share of the range (≈ 340 px). */
export const GRENADE_TAP_FRAC = 0.5;
/** A grenade without its BoomMsg (thrown out of view) is dropped this long after its fuse. */
export const LINGER_MS = 700;
/** Peak height of the hop over the first flight segment, as a share of that segment (capped). */
const HOP_K = 0.12;
const HOP_MAX_PX = 30;
/** Spin while moving (radians per px travelled). */
const SPIN_PER_PX = 0.06;
/** Shock ring: grows to GRENADE.EDGE_PX over this long. */
const SHOCK_MS = 260;
/** Hard caps (a flood of malformed messages must not grow the scene). */
const MAX_LIVE = 32;
const MAX_BOOMS = 16;
/** Polyline points accepted per grenade (start + MAX_BOUNCES bounces + rest + slack). */
const MAX_POINTS = GRENADE.MAX_BOUNCES + 4;

// ---------------------------------------------------------------- pure helpers (tested)

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A GrenadeMsg from the wire, or null when malformed (wrong types, bad polyline, silly times). */
export function parseGrenadeMsg(raw: unknown): GrenadeMsg | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Partial<Record<keyof GrenadeMsg, unknown>>;
  if (!isNum(m.id) || !isNum(m.fuse) || !isNum(m.at) || typeof m.s !== "string" || !Array.isArray(m.p)) return null;
  const p = m.p as unknown[];
  if (p.length < 3 || p.length % 3 !== 0 || p.length > MAX_POINTS * 3 || !p.every(isNum)) return null;
  if (!(m.fuse > 0 && m.fuse <= 10_000) || !(m.at >= 0 && m.at <= m.fuse + 1000)) return null;
  // Times must not run backwards along the polyline.
  for (let i = 5; i < p.length; i += 3) if ((p[i] as number) < (p[i - 3] as number)) return null;
  return { id: m.id, s: m.s, p: p as number[], fuse: m.fuse, at: m.at };
}

/** A BoomMsg from the wire, or null. */
export function parseBoomMsg(raw: unknown): BoomMsg | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Partial<Record<keyof BoomMsg, unknown>>;
  return isNum(m.id) && isNum(m.x) && isNum(m.y) ? { id: m.id, x: m.x, y: m.y } : null;
}

/**
 * Deceleration (px/ms²) of a flight, recovered from its first segment: the server throws at
 * v0 = a × FLIGHT_MS and slows at a constant `a`, so L1 = a·T1·(FLIGHT_MS − T1/2). 0 for a
 * resting-only polyline.
 */
export function grenadeDecel(p: readonly number[]): number {
  if (p.length < 6) return 0;
  const L = Math.hypot(p[3]! - p[0]!, p[4]! - p[1]!);
  const T = p[5]! - p[2]!;
  const F = GRENADE.FLIGHT_MS;
  if (!(L > 0) || !(T > 0) || !(T < 2 * F)) return 0;
  return L / (T * (F - T / 2));
}

export interface GrenadePose {
  x: number;
  y: number;
  /** Distance travelled so far along the polyline (spin). */
  dist: number;
  /** 0..1 of the hop height (a parabola in time over the first segment only), 0 on the ground. */
  hop: number;
  /** Length of the first segment (scales the hop). */
  firstLen: number;
  moving: boolean;
}

/**
 * Where the grenade is `t` ms after the throw: along polyline `p` (stride 3: x, y, t) under the
 * constant deceleration `a` (grenadeDecel). Inside a segment of length L and duration T it starts
 * at v = L/T + a·T/2 and covers v·τ − a·τ²/2 (clamped so it never runs backwards); with a = 0 it
 * moves linearly. Before the first point it is at the start, after the last it rests there.
 */
export function grenadePoseAt(p: readonly number[], a: number, t: number, out?: GrenadePose): GrenadePose {
  const o: GrenadePose = out ?? { x: 0, y: 0, dist: 0, hop: 0, firstLen: 0, moving: false };
  const n = Math.floor(p.length / 3);
  o.firstLen = n >= 2 ? Math.hypot(p[3]! - p[0]!, p[4]! - p[1]!) : 0;
  o.hop = 0;
  o.moving = false;
  o.dist = 0;
  if (n === 0) {
    o.x = 0;
    o.y = 0;
    return o;
  }
  if (n === 1 || !(t > p[2]!)) {
    o.x = p[0]!;
    o.y = p[1]!;
    return o;
  }
  let dist = 0;
  for (let i = 0; i < n - 1; i++) {
    const x0 = p[i * 3]!;
    const y0 = p[i * 3 + 1]!;
    const t0 = p[i * 3 + 2]!;
    const x1 = p[i * 3 + 3]!;
    const y1 = p[i * 3 + 4]!;
    const t1 = p[i * 3 + 5]!;
    const L = Math.hypot(x1 - x0, y1 - y0);
    if (t >= t1) {
      dist += L;
      continue;
    }
    const T = t1 - t0;
    const tau = Math.max(0, t - t0);
    let f = T > 0 ? tau / T : 1;
    if (T > 0 && L > 0 && a > 0) {
      // Constant deceleration; never decelerate past rest inside the segment (wire rounding).
      const aa = Math.min(a, (2 * L) / (T * T));
      const v = L / T + (aa * T) / 2;
      f = (v * tau - (aa * tau * tau) / 2) / L;
    }
    f = Math.max(0, Math.min(1, f));
    o.x = x0 + (x1 - x0) * f;
    o.y = y0 + (y1 - y0) * f;
    o.dist = dist + L * f;
    o.moving = L > 0;
    if (i === 0 && L > 0) {
      // Height is a parabola in time (gravity), not in distance.
      const u = T > 0 ? Math.min(1, tau / T) : 1;
      o.hop = 4 * u * (1 - u);
    }
    return o;
  }
  o.x = p[(n - 1) * 3]!;
  o.y = p[(n - 1) * 3 + 1]!;
  o.dist = dist;
  return o;
}

/** Throw fraction (0..1) that lands a grenade `dist` px away (inverse of grenadeThrowPx, clamped). */
export function grenadeFracFor(dist: number): number {
  if (!Number.isFinite(dist)) return 1;
  return Math.max(0, Math.min(1, (dist - GRENADE.MIN_PX) / (GRENADE.MAX_PX - GRENADE.MIN_PX)));
}

/** Explosion frame at `age` ms (0..EXPLOSION_FRAMES−1), −1 once the animation is over. */
export function explosionFrame(age: number): number {
  if (!(age >= 0)) return 0;
  const f = Math.floor(age / EXPLOSION_FRAME_MS);
  return f < EXPLOSION_FRAMES ? f : -1;
}

/**
 * Warning ring strength 0..1 with `left` ms to the blast: 0 before the last GRENADE.WARN_MS, then
 * pulsing faster as it nears (never 0 in the last 250 ms).
 */
export function warnStrength(left: number): number {
  if (!(left <= GRENADE.WARN_MS) || left < 0) return 0;
  const k = 1 - left / GRENADE.WARN_MS;
  const pulse = 0.5 + 0.5 * Math.cos(k * k * Math.PI * 10);
  return Math.max(left < 250 ? 0.6 : 0.15, pulse) * (0.45 + 0.55 * k);
}

// ---------------------------------------------------------------- the system

interface LiveNade {
  id: number;
  /** performance.now() of the throw (receive time − msg.at). */
  t0: number;
  p: number[];
  a: number;
  fuse: number;
  /** Only the resting point is known (a landing copy). */
  restOnly: boolean;
  body: Sprite;
  shadow: Graphics;
}

interface Boom {
  x: number;
  y: number;
  born: number;
  sprite: Sprite | null;
}

let shadowCtx: GraphicsContext | null = null;
function shadowContext(): GraphicsContext {
  shadowCtx ??= new GraphicsContext().ellipse(0, 0, 8, 4.5).fill({ color: 0x000000, alpha: 0.35 });
  return shadowCtx;
}

class GrenadeSystem implements GameSystem {
  readonly id = "grenades";
  private readonly icons = new IconCache();
  /** Grenades, rings and the preview (worldFx: under canopies, over entities). */
  private readonly root = new Container();
  private readonly rings = new Graphics();
  private readonly preview = new Graphics();
  private readonly nadeLayer = new Container();
  /** Explosions (worldTop: the fireball rises over trees and roofs). */
  private readonly boomLayer = new Container();
  private readonly live = new Map<number, LiveNade>();
  private booms: Boom[] = [];
  private frames: Texture[] | null = null;
  private ringsDrawn = false;
  private previewDrawn = false;
  private readonly pose: GrenadePose = { x: 0, y: 0, dist: 0, hop: 0, firstLen: 0, moving: false };
  private disposed = false;

  init(ctx: GameContext): void {
    this.root.addChild(this.preview, this.rings, this.nadeLayer);
    ctx.layers.worldFx.addChild(this.root);
    ctx.layers.worldTop.addChild(this.boomLayer);
    // Start decoding now so the first throw and the first blast have their art.
    this.icons.get("grenade");
    this.icons.get("explosion_sheet");
  }

  onEvents(ev: EventsMsg): void {
    if (this.disposed) return;
    const now = performance.now();
    if (Array.isArray(ev.nades)) for (const raw of ev.nades) this.addNade(parseGrenadeMsg(raw), now);
    if (Array.isArray(ev.booms)) {
      for (const raw of ev.booms) {
        const b = parseBoomMsg(raw);
        if (!b) continue;
        this.removeNade(b.id);
        this.addBoom(b.x, b.y, now);
      }
    }
  }

  frame(_dtMs: number, ctx: GameContext): void {
    if (this.disposed) return;
    const now = performance.now();
    this.stepNades(now);
    this.stepBooms(now);
    this.drawPreview(ctx);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.live.clear();
    this.booms = [];
    this.root.destroy({ children: true });
    this.boomLayer.destroy({ children: true });
    if (this.frames) for (const f of this.frames) f.destroy(false);
    this.frames = null;
    this.icons.destroy();
  }

  // ------------------------------------------------------------ grenades

  private addNade(m: GrenadeMsg | null, now: number): void {
    if (!m) return;
    const restOnly = m.p.length === 3;
    const had = this.live.get(m.id);
    // A full flight replaces a landing copy; anything else about a known grenade is a duplicate.
    if (had && (restOnly || !had.restOnly)) return;
    if (had) this.removeNade(m.id);
    if (this.live.size >= MAX_LIVE) return;
    const body = new Sprite(Texture.EMPTY);
    body.anchor.set(0.5);
    const shadow = new Graphics(shadowContext());
    this.nadeLayer.addChild(shadow, body);
    this.live.set(m.id, {
      id: m.id,
      t0: now - m.at,
      p: m.p,
      a: grenadeDecel(m.p),
      fuse: m.fuse,
      restOnly,
      body,
      shadow,
    });
  }

  private removeNade(id: number): void {
    const g = this.live.get(id);
    if (!g) return;
    this.live.delete(id);
    g.body.destroy();
    g.shadow.destroy();
  }

  private stepNades(now: number): void {
    const g = this.rings;
    if (this.live.size || this.ringsDrawn) g.clear();
    this.ringsDrawn = false;
    if (this.live.size === 0) return;
    const tex = this.icons.get("grenade");
    // Deleting the current entry while iterating a Map is safe.
    for (const n of this.live.values()) {
      const t = now - n.t0;
      if (t > n.fuse + LINGER_MS) {
        this.removeNade(n.id);
        continue;
      }
      const pose = grenadePoseAt(n.p, n.a, t, this.pose);
      const lift = pose.hop * Math.min(HOP_MAX_PX, pose.firstLen * HOP_K);
      n.shadow.position.set(pose.x, pose.y + 3);
      n.shadow.scale.set(1 - pose.hop * 0.35);
      if (tex && n.body.texture !== tex) {
        n.body.texture = tex;
        n.body.scale.set(GRENADE_DRAW_PX / Math.max(1, tex.width));
      }
      n.body.position.set(pose.x, pose.y - lift);
      n.body.rotation = pose.dist * SPIN_PER_PX;
      // Warning: the blast radius and a blinking core over the last second of the fuse.
      const w = warnStrength(n.fuse - t);
      if (w > 0) {
        g.circle(pose.x, pose.y, GRENADE.EDGE_PX).fill({ color: 0xff3b30, alpha: 0.06 * w });
        g.circle(pose.x, pose.y, GRENADE.EDGE_PX).stroke({ width: 3, color: 0xff3b30, alpha: 0.75 * w });
        g.circle(pose.x, pose.y, GRENADE.FULL_PX).stroke({ width: 2, color: 0xffd54a, alpha: 0.5 * w });
        g.circle(pose.x, pose.y - lift, 4).fill({ color: 0xff3b30, alpha: Math.min(1, w + 0.2) });
        this.ringsDrawn = true;
      }
    }
  }

  // ------------------------------------------------------------ explosions

  private explosionFrames(): Texture[] | null {
    if (this.frames) return this.frames;
    const sheet = this.icons.get("explosion_sheet");
    if (!sheet || sheet === Texture.EMPTY) return null;
    const fw = sheet.width / EXPLOSION_FRAMES;
    const out: Texture[] = [];
    for (let i = 0; i < EXPLOSION_FRAMES; i++) {
      out.push(new Texture({ source: sheet.source, frame: new Rectangle(i * fw, 0, fw, sheet.height) }));
    }
    this.frames = out;
    return out;
  }

  private addBoom(x: number, y: number, now: number): void {
    if (this.booms.length >= MAX_BOOMS) {
      const old = this.booms.shift();
      old?.sprite?.destroy();
    }
    const frames = this.explosionFrames();
    let sprite: Sprite | null = null;
    if (frames) {
      sprite = new Sprite(frames[0]!);
      sprite.anchor.set(0.5);
      sprite.position.set(x, y);
      sprite.scale.set(EXPLOSION_DRAW_PX / Math.max(1, frames[0]!.width));
      sprite.rotation = Math.random() * Math.PI * 2;
      this.boomLayer.addChild(sprite);
    }
    this.booms.push({ x, y, born: now, sprite });
  }

  private stepBooms(now: number): void {
    if (!this.booms.length) return;
    // stepNades cleared the shared Graphics already (it ran first this frame).
    const g = this.rings;
    const frames = this.frames;
    const keep: Boom[] = [];
    for (const b of this.booms) {
      const age = now - b.born;
      const f = explosionFrame(age);
      // Shock ring out to the blast radius, and a flat flash when the sheet is not loaded yet.
      if (age < SHOCK_MS) {
        const k = age / SHOCK_MS;
        g.circle(b.x, b.y, GRENADE.EDGE_PX * (0.25 + 0.75 * k)).stroke({ width: 6 * (1 - k) + 1, color: 0xfff1c1, alpha: 0.8 * (1 - k) });
        if (!b.sprite) g.circle(b.x, b.y, GRENADE.FULL_PX * (1 + k)).fill({ color: 0xff8a1f, alpha: 0.7 * (1 - k) });
        this.ringsDrawn = true;
      }
      if (f < 0 && age >= SHOCK_MS) {
        b.sprite?.destroy();
        continue;
      }
      if (b.sprite && frames && f >= 0) {
        b.sprite.texture = frames[f]!;
        b.sprite.visible = true;
      } else if (b.sprite) {
        b.sprite.visible = false;
      }
      keep.push(b);
    }
    this.booms = keep;
  }

  // ------------------------------------------------------------ aim preview (touch drag)

  private drawPreview(ctx: GameContext): void {
    const aim = ctx.grenadeAim?.() ?? null;
    const g = this.preview;
    if (!aim) {
      if (this.previewDrawn) g.clear();
      this.previewDrawn = false;
      return;
    }
    const map = ctx.map();
    if (!map) return;
    const from = ctx.selfPos();
    const path = grenadePath(getCollisionIndex(map), from.x, from.y, aim.angle, grenadeThrowPx(aim.frac), map);
    g.clear();
    this.previewDrawn = true;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]!;
      const b = path[i]!;
      dashed(g, a.x, a.y, b.x, b.y, 12, 8);
    }
    g.stroke({ width: 3, color: 0xffffff, alpha: 0.8 });
    const rest = path[path.length - 1]!;
    g.circle(rest.x, rest.y, GRENADE.EDGE_PX).fill({ color: 0xff3b30, alpha: 0.08 });
    g.circle(rest.x, rest.y, GRENADE.EDGE_PX).stroke({ width: 2, color: 0xff3b30, alpha: 0.6 });
    g.circle(rest.x, rest.y, 7).fill({ color: 0xffffff, alpha: 0.9 });
  }
}

/** Dashed segment as subpaths (stroked once by the caller). */
function dashed(g: Graphics, x0: number, y0: number, x1: number, y1: number, on: number, off: number): void {
  const L = Math.hypot(x1 - x0, y1 - y0);
  if (!(L > 0)) return;
  const dx = (x1 - x0) / L;
  const dy = (y1 - y0) / L;
  for (let s = 0; s < L; s += on + off) {
    const e = Math.min(L, s + on);
    g.moveTo(x0 + dx * s, y0 + dy * s).lineTo(x0 + dx * e, y0 + dy * e);
  }
}

/** GameSystem factory for the renderer registry (systems-registry.ts). */
export function createGrenadeSystem(): GameSystem {
  return new GrenadeSystem();
}
