/**
 * Camera feel (WP-I, immersion memo §4 P0.3): look-ahead toward the aim, a directional recoil kick
 * per weapon, a short screen shake on close shots / incoming hits / explosions, and the zoom and
 * focus moves the drop-in intro (intro.ts) and the cinematics (cinematics.ts) ask for.
 *
 * The renderer owns the camera and GameContext only exposes it read-only, so the CameraRig is a
 * small output record the renderer reads once per frame (the only renderer.ts hook of this lane):
 *   zoomMul    multiplies the base zoom (intro push-in, extraction zoom);
 *   offX/offY  world offset added to the camera centre (look-ahead + focus pans). It is part of
 *              camX/camY, so aim, culling, fog and toScreen all stay consistent;
 *   shakeX/Y   screen px added to the world position only (kick + shake) — aim never sees it;
 *   shakeScale multiplies the legacy Effects shake (0 under reduced motion).
 * The camera system updates the rig in frame(); the renderer applies it on the next frame (one
 * frame of latency, invisible under the 120 ms smoothing). Nothing here allocates per frame.
 *
 * Reduced motion (`prefers-reduced-motion`, or the `extract.motion.v1` key = "reduce" / "full"):
 * no kick, no shake (also the legacy one), no zoom moves or pans; look-ahead is halved.
 */

import { WEAPONS, type EventsMsg, type WeaponId } from "@extract/shared";
import type { GameContext, GameSystem } from "./systems";

// ---------------------------------------------------------------- tuning

export const LOOK = {
  /** Offset = aim direction × min(cursor distance × FRACTION, MAX_PX) (memo). */
  FRACTION: 0.25,
  MAX_PX: 220,
  TAU_MS: 120,
  /** Look-ahead multiplier under reduced motion. */
  REDUCED: 0.5,
} as const;

/** Recoil kick in screen px, opposite the aim, per own shot (memo: 4–10 px, back in ~120 ms). */
export const RECOIL_PX: Record<WeaponId, number> = { pistol: 4, rifle: 3, shotgun: 9, sniper: 10 };
export const KICK = { TAU_MS: 40, MAX_PX: 14 } as const;

export const SHAKE = {
  TAU_MS: 70,
  MAX: 10,
  /** Someone else fired within this radius of us. */
  CLOSE_SHOT_PX: 450,
  CLOSE_SHOT_AMP: { pistol: 1.6, rifle: 1.6, shotgun: 3.5, sniper: 4.5 } as Record<WeaponId, number>,
  /** Taking damage: amp = dmg × PER_DMG, clamped. */
  HIT_PER_DMG: 0.12,
  HIT_MIN: 1.5,
  HIT_MAX: 6,
  /** explosionShake(): amp = power at the centre, zero at power × RADIUS_PER_POWER px. */
  RADIUS_PER_POWER: 120,
} as const;

export const MOTION_KEY = "extract.motion.v1";

// ---------------------------------------------------------------- pure helpers

/** Exponential approach of `cur` toward `target` over dtMs with time constant tauMs. */
export function approach(cur: number, target: number, dtMs: number, tauMs: number): number {
  if (!(tauMs > 0)) return target;
  const k = 1 - Math.exp(-Math.max(0, dtMs) / tauMs);
  const v = cur + (target - cur) * k;
  return Math.abs(v - target) < 1e-4 ? target : v;
}

/**
 * Look-ahead offset (world units) for a cursor at (mx, my) screen px. Measured from the screen
 * centre, not from the player, so the camera moving does not feed back into its own target.
 */
export function lookAheadTarget(
  mx: number,
  my: number,
  screenW: number,
  screenH: number,
  zoom: number,
  out: { x: number; y: number },
  fraction: number = LOOK.FRACTION,
  maxPx: number = LOOK.MAX_PX,
): { x: number; y: number } {
  const z = zoom > 0 ? zoom : 1;
  const dx = (mx - screenW / 2) / z;
  const dy = (my - screenH / 2) / z;
  const d = Math.hypot(dx, dy);
  if (!(d > 1e-3)) {
    out.x = 0;
    out.y = 0;
    return out;
  }
  const m = Math.min(d * fraction, maxPx);
  out.x = (dx / d) * m;
  out.y = (dy / d) * m;
  return out;
}

/** Shake amplitude for someone else's shot `dist` px away (0 beyond CLOSE_SHOT_PX). */
export function closeShotShake(weapon: string, dist: number): number {
  const base = SHAKE.CLOSE_SHOT_AMP[weapon as WeaponId] ?? SHAKE.CLOSE_SHOT_AMP.pistol;
  if (!(dist < SHAKE.CLOSE_SHOT_PX)) return 0;
  const k = 1 - Math.max(0, dist) / SHAKE.CLOSE_SHOT_PX;
  return base * k * k;
}

/** Shake amplitude for damage taken. */
export function hitShake(dmg: number): number {
  if (!(dmg > 0)) return 0;
  return Math.min(SHAKE.HIT_MAX, Math.max(SHAKE.HIT_MIN, dmg * SHAKE.HIT_PER_DMG));
}

/** Shake for an explosion of `power` (≈ amp at the centre) `dist` px away. No explosives exist yet. */
export function explosionShake(power: number, dist: number): number {
  const r = power * SHAKE.RADIUS_PER_POWER;
  if (!(power > 0) || !(dist < r)) return 0;
  const k = 1 - Math.max(0, dist) / r;
  return Math.min(SHAKE.MAX, power * k * k);
}

/** "reduce" / "full" stored override, else the OS preference. Never throws. */
export function readReducedMotion(
  storage: { getItem(k: string): string | null } | null,
  media: { matches: boolean } | null,
): boolean {
  try {
    const v = storage?.getItem(MOTION_KEY);
    if (v === "reduce") return true;
    if (v === "full") return false;
  } catch {
    /* blocked storage */
  }
  return !!media?.matches;
}

let reduced: boolean | null = null;
const motionListeners = new Set<(v: boolean) => void>();

function browserStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function motionQuery(): MediaQueryList | null {
  try {
    return typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  } catch {
    return null;
  }
}

/** Current reduced-motion preference (cached; refreshed by setReducedMotion / the OS query). */
export function reducedMotion(): boolean {
  if (reduced === null) reduced = readReducedMotion(browserStorage(), motionQuery());
  return reduced;
}

/** Settings hook for a future toggle: true / false stores an override, null follows the OS. */
export function setReducedMotion(v: boolean | null): void {
  try {
    const s = browserStorage();
    if (v === null) s?.removeItem(MOTION_KEY);
    else s?.setItem(MOTION_KEY, v ? "reduce" : "full");
  } catch {
    /* the choice still applies for this session */
  }
  reduced = v ?? readReducedMotion(null, motionQuery());
  for (const l of motionListeners) l(reduced);
}

export function subscribeReducedMotion(l: (v: boolean) => void): () => void {
  motionListeners.add(l);
  return () => motionListeners.delete(l);
}

// ---------------------------------------------------------------- the rig

export class CameraRig {
  // Outputs (read by the renderer).
  zoomMul = 1;
  offX = 0;
  offY = 0;
  shakeX = 0;
  shakeY = 0;
  shakeScale = 1;

  reduced = false;

  private lookX = 0;
  private lookY = 0;
  private lookTX = 0;
  private lookTY = 0;
  private focusX = 0;
  private focusY = 0;
  private focusTX = 0;
  private focusTY = 0;
  private focusTau = 600;
  private zoomTarget = 1;
  private zoomTau = 400;
  private kickX = 0;
  private kickY = 0;
  private amp = 0;
  private t = 0;

  /** Look-ahead target, world units. */
  setLook(x: number, y: number): void {
    this.lookTX = x;
    this.lookTY = y;
  }

  /** Recoil: the view jumps `px` screen px against `angle` and springs back. */
  kick(angle: number, px: number): void {
    if (!(px > 0)) return;
    let x = this.kickX - Math.cos(angle) * px;
    let y = this.kickY - Math.sin(angle) * px;
    const m = Math.hypot(x, y);
    if (m > KICK.MAX_PX) {
      x *= KICK.MAX_PX / m;
      y *= KICK.MAX_PX / m;
    }
    this.kickX = x;
    this.kickY = y;
  }

  /** Short random shake; the strongest request wins. */
  shake(amp: number): void {
    if (amp > this.amp) this.amp = Math.min(SHAKE.MAX, amp);
  }

  /** Jump the zoom multiplier (e.g. the intro starts wide), then use zoomTo to ease back. */
  snapZoom(mul: number): void {
    this.zoomMul = mul;
    this.zoomTarget = mul;
  }

  zoomTo(mul: number, tauMs: number): void {
    this.zoomTarget = mul;
    this.zoomTau = tauMs;
  }

  /** Pan the camera by (dx, dy) world units from the player (death cam → killer). */
  focusTo(dx: number, dy: number, tauMs: number): void {
    this.focusTX = dx;
    this.focusTY = dy;
    this.focusTau = tauMs;
  }

  clearFocus(tauMs = 500): void {
    this.focusTo(0, 0, tauMs);
  }

  update(dtMs: number): void {
    const dt = Math.min(100, Math.max(0, dtMs));
    const red = this.reduced;
    this.t += dt;
    const look = red ? LOOK.REDUCED : 1;
    this.lookX = approach(this.lookX, this.lookTX * look, dt, LOOK.TAU_MS);
    this.lookY = approach(this.lookY, this.lookTY * look, dt, LOOK.TAU_MS);
    this.focusX = approach(this.focusX, red ? 0 : this.focusTX, dt, this.focusTau);
    this.focusY = approach(this.focusY, red ? 0 : this.focusTY, dt, this.focusTau);
    this.zoomMul = red ? 1 : approach(this.zoomMul, this.zoomTarget, dt, this.zoomTau);
    const kd = Math.exp(-dt / KICK.TAU_MS);
    this.kickX *= kd;
    this.kickY *= kd;
    if (Math.abs(this.kickX) < 0.05) this.kickX = 0;
    if (Math.abs(this.kickY) < 0.05) this.kickY = 0;
    this.amp *= Math.exp(-dt / SHAKE.TAU_MS);
    if (this.amp < 0.1) this.amp = 0;

    this.offX = this.lookX + this.focusX;
    this.offY = this.lookY + this.focusY;
    if (red) {
      this.shakeX = 0;
      this.shakeY = 0;
      this.shakeScale = 0;
      return;
    }
    // Smooth pseudo-noise (two incommensurate sines per axis): no Math.random flicker.
    const t = this.t;
    const a = this.amp;
    this.shakeX = this.kickX + a * Math.sin(t * 0.093) * Math.cos(t * 0.057);
    this.shakeY = this.kickY + a * Math.sin(t * 0.081 + 1.3) * Math.cos(t * 0.049 + 0.4);
    this.shakeScale = 1;
  }

  /** Back to neutral (new raid). */
  reset(): void {
    this.lookX = this.lookY = this.lookTX = this.lookTY = 0;
    this.focusX = this.focusY = this.focusTX = this.focusTY = 0;
    this.kickX = this.kickY = this.amp = 0;
    this.zoomMul = this.zoomTarget = 1;
    this.offX = this.offY = this.shakeX = this.shakeY = 0;
  }
}

let activeRig: CameraRig | null = null;

/** The running camera system's rig (the renderer hook and other systems read it), or null. */
export function getCameraRig(): CameraRig | null {
  return activeRig;
}

// ---------------------------------------------------------------- pointer

/** Cursor position in canvas px, from window pointer events (the renderer's input does the same). */
export class PointerTracker {
  x = 0;
  y = 0;
  has = false;
  /** The last move happened over the game canvas (not over an inventory / map overlay). */
  overCanvas = false;
  private canvas: HTMLCanvasElement | null = null;

  attach(canvas: HTMLCanvasElement): void {
    if (this.canvas || typeof window === "undefined") return;
    this.canvas = canvas;
    window.addEventListener("pointermove", this.onMove, { passive: true });
    window.addEventListener("pointerdown", this.onMove, { passive: true });
  }

  detach(): void {
    if (!this.canvas) return;
    window.removeEventListener("pointermove", this.onMove);
    window.removeEventListener("pointerdown", this.onMove);
    this.canvas = null;
  }

  private onMove = (e: PointerEvent) => {
    const c = this.canvas;
    if (!c) return;
    const r = c.getBoundingClientRect();
    this.x = e.clientX - r.left;
    this.y = e.clientY - r.top;
    this.has = true;
    this.overCanvas = e.target === c;
  };
}

// ---------------------------------------------------------------- the system

class CameraSystem implements GameSystem {
  readonly id = "camera";
  private rig: CameraRig | null = null;
  private readonly pointer = new PointerTracker();
  private readonly look = { x: 0, y: 0 };
  private unsub: (() => void) | null = null;
  private mql: MediaQueryList | null = null;
  private readonly onMql = () => {
    // The OS preference flipped: re-read (a stored override still wins) and tell every listener.
    reduced = readReducedMotion(browserStorage(), this.mql);
    for (const l of motionListeners) l(reduced);
  };

  init(ctx: GameContext): void {
    const rig = new CameraRig();
    rig.reduced = reducedMotion();
    this.rig = rig;
    activeRig = rig;
    this.pointer.attach(ctx.app.canvas as HTMLCanvasElement);
    this.unsub = subscribeReducedMotion((v) => {
      if (this.rig) this.rig.reduced = v;
    });
    this.mql = motionQuery();
    this.mql?.addEventListener?.("change", this.onMql);
  }

  frame(dtMs: number, ctx: GameContext): void {
    const rig = this.rig;
    if (!rig) return;
    const state = ctx.state();
    const me = ctx.me();
    const self = ctx.self();
    const controllable = !!state && state.phase !== "ended" && !!me && me.alive && !!self && self.extractedAt === 0;
    if (!controllable) rig.setLook(0, 0);
    else if (this.pointer.has && this.pointer.overCanvas && !ctx.inputBlocked()) {
      const cam = ctx.camera();
      // Base zoom: the target must not shrink while the intro / extraction zoom runs.
      lookAheadTarget(this.pointer.x, this.pointer.y, cam.width, cam.height, cam.zoom / (rig.zoomMul || 1), this.look);
      rig.setLook(this.look.x, this.look.y);
    }
    // Over an overlay (inventory, full map — the map is drawn on the canvas itself, hence
    // inputBlocked) the cursor is not aiming: keep the last target.
    rig.update(dtMs);
  }

  onEvents(ev: EventsMsg, ctx: GameContext): void {
    const rig = this.rig;
    if (!rig) return;
    const sid = ctx.room.sessionId;
    if (ev.shots) {
      let p: { x: number; y: number } | null = null;
      for (const s of ev.shots) {
        if (!s || !Array.isArray(s.a) || !(s.w in WEAPONS)) continue;
        if (s.s === sid) {
          let a = 0;
          for (const v of s.a) a += v;
          rig.kick(s.a.length ? a / s.a.length : ctx.aim(), RECOIL_PX[s.w] ?? 3);
          continue;
        }
        p ??= ctx.selfPos();
        rig.shake(closeShotShake(s.w, Math.hypot(s.x - p.x, s.y - p.y)));
      }
    }
    if (ev.hits) {
      for (const h of ev.hits) if (h && h.t === sid) rig.shake(hitShake(h.d));
    }
  }

  dispose(): void {
    this.pointer.detach();
    this.unsub?.();
    this.unsub = null;
    this.mql?.removeEventListener?.("change", this.onMql);
    this.mql = null;
    if (activeRig === this.rig) activeRig = null;
    this.rig = null;
  }
}

/** GameSystem factory for the renderer registry (systems-registry.ts). */
export function createCameraSystem(): GameSystem {
  return new CameraSystem();
}
