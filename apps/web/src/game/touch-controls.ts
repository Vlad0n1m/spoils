/**
 * Phone touch controls (TWA build): a floating move stick on the left half (part deflection =
 * quiet walk), a floating aim stick on the right half that fires past FIRE_AT, and round buttons
 * for roll, use (search / pick up), reload, weapon swap, bandage, medkit, inventory and full map.
 *
 * Plain DOM inside the game mount, right above the canvas and BELOW the React HUD in paint order
 * (no z-index), so the HUD's own buttons (controls / leave raid, audio) stay tappable and the
 * inventory overlay covers everything. The buttons are placed by layoutTouchButtons() around the
 * HUD's areas (hudReservedRects), so they never cover the wipe countdown, warnings, boss toasts,
 * kill feed, minimap or the bottom bar. Pointer capture + touch-action: none: the browser never
 * scrolls, zooms or delays a tap. Input goes into InputController, which the fixed-rate input loop
 * samples as usual.
 */

import type { InputController, TouchAction } from "./input";
import { MINIMAP_MARGIN, minimapSize } from "./minimap";

/** Stick travel in CSS px for full deflection. */
export const STICK_RADIUS = 56;
/** Aim stick: aims from this deflection, fires from FIRE_AT. */
export const AIM_FROM = 0.2;
export const FIRE_AT = 0.55;

/** Phones and tablets (coarse primary pointer); ?touch=1 forces it on a desktop, ?touch=0 off. */
export function shouldUseTouch(): boolean {
  if (typeof window === "undefined") return false;
  const q = new URLSearchParams(window.location.search).get("touch");
  if (q === "1") return true;
  if (q === "0") return false;
  return window.matchMedia?.("(pointer: coarse)").matches ?? false;
}

/** Aim stick deflection (stick units, 0..1 past the centre) → aim angle and trigger. */
export function aimFromStick(x: number, y: number): { angle: number | null; fire: boolean } {
  const len = Math.hypot(x, y);
  if (!(len >= AIM_FROM)) return { angle: null, fire: false };
  return { angle: Math.atan2(y, x), fire: len >= FIRE_AT };
}

/** Finger offset from the stick origin (px) → stick vector clamped to the unit circle. */
export function stickVector(dx: number, dy: number, radius = STICK_RADIUS): { x: number; y: number } {
  const len = Math.hypot(dx, dy);
  if (!(len > 0) || !(radius > 0)) return { x: 0, y: 0 };
  const k = len > radius ? 1 / len : 1 / radius;
  return { x: dx * k, y: dy * k };
}

// ---------------------------------------------------------------------------------------------
// Layout (pure)
// ---------------------------------------------------------------------------------------------

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A HUD area; `soft` ones are transient or rare (kill feed, extract ring, hint) — see layout. */
export interface HudArea extends Rect {
  id: string;
  soft?: boolean;
}

export type TouchButtonId = TouchAction;

export interface TouchButtonSpec {
  id: TouchButtonId;
  side: "left" | "right";
  /** Preferred diameter (px); shrinks down to TOUCH_MIN_SIZE when the screen is tight. */
  size: number;
  label: string;
  /** Icon instead of the label (public/ path). */
  icon?: string;
  aria: string;
}

/**
 * Every battle action that is not a stick (move / aim / fire / quiet walk are). Placement priority
 * per side is this order: the first ones get the spots nearest the thumb. Take all and close are
 * buttons of the search / inventory panels themselves; extraction is standing in the circle.
 */
export const TOUCH_BUTTONS: readonly TouchButtonSpec[] = [
  { id: "roll", side: "right", size: 64, label: "ROLL", aria: "Dodge roll" },
  { id: "interact", side: "right", size: 56, label: "USE", aria: "Search / pick up" },
  { id: "reload", side: "right", size: 50, label: "RELOAD", aria: "Reload" },
  { id: "swap", side: "right", size: 50, label: "SWAP", aria: "Switch weapon" },
  { id: "bandage", side: "left", size: 52, label: "+", icon: "/sprites/bandage.png", aria: "Bandage" },
  { id: "medkit", side: "left", size: 52, label: "+", icon: "/sprites/medkit.png", aria: "Medkit" },
  { id: "inventory", side: "left", size: 48, label: "BAG", icon: "/sprites/backpack.png", aria: "Inventory" },
  { id: "map", side: "left", size: 48, label: "MAP", aria: "Full map" },
];

export const TOUCH_MIN_SIZE = 38;
/** Distance kept from the screen edges, from each other and from HUD areas (px). */
const EDGE = 6;
const GAP = 8;
/** Candidate grid step (px). */
const STEP = 4;

/**
 * Screen areas the React HUD (components/hud.tsx) and the canvas HUD (minimap.ts, boss-hud.ts,
 * the zone toast of fullmap.ts) draw into, in CSS px of the game mount. Sizes mirror the HUD's
 * Tailwind classes at their largest content; keep them in sync when the HUD layout changes.
 */
export function hudReservedRects(w: number, h: number): HudArea[] {
  const md = w >= 768;
  const r: HudArea[] = [];
  // Top centre: phase timer / wipe countdown, extract compass, wipe warning, boss toast (the
  // top-3 stack), the boss bar (bossBarY ≤ 118) and the zone toast (h × 0.16).
  const topW = Math.min(w - 24, 420);
  r.push({ id: "top", x: (w - topW) / 2, y: 0, w: topW, h: 222 });
  // Top right: minimap.
  const mm = minimapSize(w, h);
  r.push({ id: "minimap", x: w - mm - MINIMAP_MARGIN - 6, y: 0, w: mm + MINIMAP_MARGIN + 6, h: MINIMAP_MARGIN + mm + 6 });
  // Bottom centre: the move / vitals / weapons / meds bar (~44.5 rem wide at md+, ~40 rem below,
  // 6.5 rem cards).
  const barW = Math.min(w - 24, md ? 712 : 640) + 12;
  const barH = 12 + 112 + 6;
  r.push({ id: "bar", x: (w - barW) / 2, y: h - barH, w: barW, h: barH });
  // Bottom left: ping badge.
  r.push({ id: "ping", x: 0, y: h - 44, w: 100, h: 44 });
  // Bottom right (md+ only): the controls / leave-raid chip and the audio button above it.
  if (md) r.push({ id: "chips", x: w - 64, y: h - 108, w: 64, h: 108 });
  // Soft: shown now and then. Top left: kill feed, up to 5 rows, max-w min(22rem, 40vw).
  r.push({ id: "killfeed", soft: true, x: 0, y: 0, w: 12 + Math.min(352, 0.4 * w) + 6, h: 12 + 5 * 34 + 6 });
  // Interact hint + heal / reload progress stacked above the bar.
  r.push({ id: "hint", soft: true, x: w / 2 - 210, y: h - barH - 96, w: 420, h: 96 });
  // Extract ring + caption, bottom: clamp(13rem, 30vh, 17rem).
  const ringBottom = Math.max(208, Math.min(272, 0.3 * h));
  r.push({ id: "ring", soft: true, x: w / 2 - 200, y: h - ringBottom - 176, w: 400, h: 176 });
  return r;
}

export function rectsOverlap(a: Rect, b: Rect, gap = 0): boolean {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}

/** Where each side's buttons gather: the thumb's resting area above the bottom HUD. */
function anchorOf(side: "left" | "right", w: number, h: number): { x: number; y: number } {
  return { x: side === "right" ? w - 48 : 48, y: h - 150 };
}

/**
 * Button rects for a w × h game mount. Each button, in TOUCH_BUTTONS order, takes the free spot
 * (inside its half of the screen, clear of the HUD areas and the buttons already placed) nearest
 * its side's thumb anchor, at its preferred size or smaller down to TOUCH_MIN_SIZE. Buttons that
 * fit nowhere get a second pass that may cover the soft areas (kill feed, interact hint, extract
 * ring: short-lived); the hard ones (timer / wipe / boss stack, minimap, bottom bar, ping, corner
 * chips) are never covered. A button that still fits nowhere is left out (absent from the map).
 */
export function layoutTouchButtons(
  w: number,
  h: number,
  reserved: readonly HudArea[] = hudReservedRects(w, h),
  specs: readonly TouchButtonSpec[] = TOUCH_BUTTONS,
): Map<TouchButtonId, Rect> {
  let best = new Map<TouchButtonId, Rect>();
  if (!(w > 0) || !(h > 0)) return best;
  // Cramped screens: shrink every button together rather than drop one.
  for (const scale of LAYOUT_SCALES) {
    const sized = specs.map((s) => ({ ...s, size: Math.max(TOUCH_MIN_SIZE, Math.round((s.size * scale) / 2) * 2) }));
    const got = layoutPass(w, h, reserved, sized);
    if (got.size > best.size) best = got;
    if (got.size === specs.length) break;
  }
  return best;
}

const LAYOUT_SCALES = [1, 0.85, 0.72, 0.6] as const;

function layoutPass(w: number, h: number, reserved: readonly HudArea[], specs: readonly TouchButtonSpec[]): Map<TouchButtonId, Rect> {
  const out = new Map<TouchButtonId, Rect>();
  const placed: Rect[] = [];
  const hard = reserved.filter((r) => !r.soft);
  for (const areas of [reserved, hard]) {
    for (const spec of specs) {
      if (out.has(spec.id)) continue;
      const rc = placeOne(spec, w, h, areas, placed);
      if (!rc) continue;
      placed.push(rc);
      out.set(spec.id, rc);
    }
  }
  return out;
}

function placeOne(spec: TouchButtonSpec, w: number, h: number, areas: readonly Rect[], placed: readonly Rect[]): Rect | null {
  const a = anchorOf(spec.side, w, h);
  for (let size = spec.size; size >= TOUCH_MIN_SIZE; size -= 4) {
    const x0 = spec.side === "right" ? Math.ceil(w / 2) : EDGE;
    const x1 = spec.side === "right" ? w - EDGE - size : Math.floor(w / 2) - size;
    let best: Rect | null = null;
    let bestD = Infinity;
    for (let y = EDGE; y <= h - EDGE - size; y += STEP) {
      for (let x = x0; x <= x1; x += STEP) {
        const d = (x + size / 2 - a.x) ** 2 + (y + size / 2 - a.y) ** 2;
        if (d >= bestD) continue;
        const c = { x, y, w: size, h: size };
        if (areas.some((r) => rectsOverlap(c, r))) continue;
        if (placed.some((r) => rectsOverlap(c, r, GAP))) continue;
        best = c;
        bestD = d;
      }
    }
    if (best) return best;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------------------------

/** What the buttons reflect from the HUD snapshot (TouchControls.sync). */
export interface TouchHudState {
  /** The player can act (alive, on the map, raid running): otherwise the controls hide. */
  active: boolean;
  /** Something to search / pick up in reach (USE lights up). */
  canUse: boolean;
  bandages: number;
  medkits: number;
}

interface Stick {
  zone: HTMLDivElement;
  base: HTMLDivElement;
  knob: HTMLDivElement;
  pointerId: number | null;
  ox: number;
  oy: number;
}

const BTN_BG = "rgba(22,27,40,0.78)";
const BTN_BG_LIT = "rgba(204,255,0,0.92)";

export class TouchControls {
  private root: HTMLDivElement | null = null;
  private move: Stick | null = null;
  private aim: Stick | null = null;
  private readonly buttons = new Map<TouchButtonId, { el: HTMLDivElement; badge: HTMLSpanElement | null }>();
  private resizeObs: ResizeObserver | null = null;
  private laidOut = "";
  private shown: TouchHudState = { active: true, canUse: false, bandages: -1, medkits: -1 };
  /** Called with the event timestamp of every stick or button press (perf overlay). */
  onPress: ((t: number) => void) | null = null;

  constructor(
    private readonly mount: HTMLElement,
    private readonly input: InputController,
  ) {}

  attach(): void {
    if (this.root) return;
    if (getComputedStyle(this.mount).position === "static") this.mount.style.position = "relative";
    // No z-index: painted right above the canvas, under the HUD and the panels.
    const root = el("div", {
      position: "absolute",
      inset: "0",
      pointerEvents: "none",
      userSelect: "none",
      webkitUserSelect: "none",
    });
    root.setAttribute("data-touch-controls", "");
    this.move = this.makeStick(root, { left: "0", top: "20%", bottom: "0", width: "50%" }, "rgba(255,255,255,0.16)", false);
    this.aim = this.makeStick(root, { right: "0", top: "20%", bottom: "0", width: "50%" }, "rgba(255,90,90,0.2)", true);
    this.bindStick(
      this.move,
      (x, y) => this.input.setTouchMove({ x, y }),
      () => this.input.setTouchMove(null),
    );
    this.bindStick(
      this.aim,
      (x, y) => {
        const a = aimFromStick(x, y);
        this.input.setTouchAim(a.angle, a.fire);
        if (this.aim) this.aim.knob.style.background = a.fire ? "rgba(255,80,80,0.95)" : "rgba(255,255,255,0.85)";
      },
      () => this.input.setTouchAim(null, false),
    );
    for (const spec of TOUCH_BUTTONS) {
      const b = this.makeButton(spec);
      root.appendChild(b.el);
      this.buttons.set(spec.id, b);
    }
    this.mount.appendChild(root);
    this.root = root;
    this.layout();
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObs = new ResizeObserver(() => this.layout());
      this.resizeObs.observe(this.mount);
    } else {
      window.addEventListener("resize", this.layout);
    }
  }

  detach(): void {
    this.resizeObs?.disconnect();
    this.resizeObs = null;
    window.removeEventListener("resize", this.layout);
    this.root?.remove();
    this.root = null;
    this.move = null;
    this.aim = null;
    this.buttons.clear();
    this.laidOut = "";
    this.input.setTouchMove(null);
    this.input.setTouchAim(null, false);
  }

  /** Mirror the HUD: hide while out of play, light USE, dim meds the player has none of. */
  sync(s: TouchHudState): void {
    const root = this.root;
    if (!root) return;
    const prev = this.shown;
    if (s.active !== prev.active) {
      root.style.display = s.active ? "" : "none";
      if (!s.active) {
        // Fingers lifted while hidden never send pointerup to a display:none zone.
        this.releaseStick(this.move, () => this.input.setTouchMove(null));
        this.releaseStick(this.aim, () => this.input.setTouchAim(null, false));
      }
    }
    if (s.canUse !== prev.canUse) {
      const use = this.buttons.get("interact")?.el;
      if (use) use.style.boxShadow = s.canUse ? "0 3px 0 #000, 0 0 0 3px rgba(204,255,0,0.9)" : "0 3px 0 #000";
    }
    if (s.bandages !== prev.bandages) this.setCount("bandage", s.bandages);
    if (s.medkits !== prev.medkits) this.setCount("medkit", s.medkits);
    this.shown = { ...s };
  }

  private setCount(id: TouchButtonId, n: number) {
    const b = this.buttons.get(id);
    if (!b) return;
    b.el.style.opacity = n > 0 ? "1" : "0.45";
    if (b.badge) b.badge.textContent = String(Math.max(0, n));
  }

  private layout = () => {
    if (!this.root) return;
    const r = this.mount.getBoundingClientRect();
    const w = Math.round(r.width);
    const h = Math.round(r.height);
    const key = `${w}x${h}`;
    if (key === this.laidOut || w <= 0 || h <= 0) return;
    this.laidOut = key;
    const rects = layoutTouchButtons(w, h);
    for (const [id, b] of this.buttons) {
      const rc = rects.get(id);
      if (!rc) {
        b.el.style.display = "none";
        continue;
      }
      Object.assign(b.el.style, {
        display: "grid",
        left: `${rc.x}px`,
        top: `${rc.y}px`,
        width: `${rc.w}px`,
        height: `${rc.h}px`,
        fontSize: `${rc.w >= 60 ? 15 : rc.w >= 48 ? 12 : 10}px`,
      });
    }
  };

  private makeStick(root: HTMLDivElement, pos: Partial<CSSStyleDeclaration>, tint: string, fireRing: boolean): Stick {
    const zone = el("div", { position: "absolute", pointerEvents: "auto", touchAction: "none", ...pos });
    const base = el("div", {
      position: "absolute",
      width: `${STICK_RADIUS * 2}px`,
      height: `${STICK_RADIUS * 2}px`,
      marginLeft: `${-STICK_RADIUS}px`,
      marginTop: `${-STICK_RADIUS}px`,
      borderRadius: "50%",
      border: "3px solid rgba(0,0,0,0.6)",
      background: tint,
      display: "none",
      boxSizing: "border-box",
    });
    if (fireRing) {
      // Past this ring the aim stick fires.
      const d = Math.round(STICK_RADIUS * 2 * FIRE_AT);
      base.appendChild(
        el("div", {
          position: "absolute",
          left: "50%",
          top: "50%",
          width: `${d}px`,
          height: `${d}px`,
          marginLeft: `${-d / 2}px`,
          marginTop: `${-d / 2}px`,
          borderRadius: "50%",
          border: "2px dashed rgba(255,255,255,0.45)",
          boxSizing: "border-box",
        }),
      );
    }
    const knob = el("div", {
      position: "absolute",
      width: "52px",
      height: "52px",
      marginLeft: "-26px",
      marginTop: "-26px",
      borderRadius: "50%",
      border: "3px solid #000",
      background: "rgba(255,255,255,0.85)",
      display: "none",
      boxSizing: "border-box",
    });
    zone.append(base, knob);
    root.appendChild(zone);
    return { zone, base, knob, pointerId: null, ox: 0, oy: 0 };
  }

  private releaseStick(s: Stick | null, onEnd: () => void) {
    if (!s || s.pointerId === null) return;
    s.pointerId = null;
    s.base.style.display = "none";
    s.knob.style.display = "none";
    onEnd();
  }

  private bindStick(s: Stick, onMove: (x: number, y: number) => void, onEnd: () => void): void {
    const place = (node: HTMLDivElement, x: number, y: number) => {
      node.style.left = `${x}px`;
      node.style.top = `${y}px`;
      node.style.display = "block";
    };
    s.zone.addEventListener("pointerdown", (e) => {
      if (s.pointerId !== null) return;
      e.preventDefault();
      try {
        s.zone.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic or already-released pointer: moves still arrive while the finger stays in the zone */
      }
      s.pointerId = e.pointerId;
      const r = s.zone.getBoundingClientRect();
      s.ox = e.clientX - r.left;
      s.oy = e.clientY - r.top;
      place(s.base, s.ox, s.oy);
      place(s.knob, s.ox, s.oy);
      this.onPress?.(e.timeStamp);
      onMove(0, 0);
    });
    s.zone.addEventListener("pointermove", (e) => {
      if (e.pointerId !== s.pointerId) return;
      const r = s.zone.getBoundingClientRect();
      const v = stickVector(e.clientX - r.left - s.ox, e.clientY - r.top - s.oy);
      place(s.knob, s.ox + v.x * STICK_RADIUS, s.oy + v.y * STICK_RADIUS);
      onMove(v.x, v.y);
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== s.pointerId) return;
      this.releaseStick(s, onEnd);
    };
    s.zone.addEventListener("pointerup", end);
    s.zone.addEventListener("pointercancel", end);
    s.zone.addEventListener("lostpointercapture", end);
  }

  private makeButton(spec: TouchButtonSpec): { el: HTMLDivElement; badge: HTMLSpanElement | null } {
    const b = el("div", {
      position: "absolute",
      display: "none",
      placeItems: "center",
      borderRadius: "50%",
      border: "3px solid #000",
      boxSizing: "border-box",
      background: BTN_BG,
      color: "#fff",
      fontFamily: "var(--font-luckiest-guy), sans-serif",
      letterSpacing: "0.04em",
      lineHeight: "1",
      pointerEvents: "auto",
      touchAction: "none",
      boxShadow: "0 3px 0 #000",
    });
    b.setAttribute("role", "button");
    b.setAttribute("aria-label", spec.aria);
    let badge: HTMLSpanElement | null = null;
    if (spec.icon) {
      const img = document.createElement("img");
      img.src = spec.icon;
      img.alt = "";
      img.draggable = false;
      Object.assign(img.style, { width: "62%", height: "62%", objectFit: "contain", pointerEvents: "none" });
      b.appendChild(img);
      if (spec.id === "bandage" || spec.id === "medkit") {
        badge = document.createElement("span");
        Object.assign(badge.style, {
          position: "absolute",
          right: "-4px",
          bottom: "-4px",
          minWidth: "18px",
          height: "18px",
          padding: "0 3px",
          borderRadius: "9px",
          border: "2px solid #000",
          background: "#fff",
          color: "#000",
          fontSize: "11px",
          lineHeight: "14px",
          textAlign: "center",
          boxSizing: "border-box",
          pointerEvents: "none",
        });
        b.appendChild(badge);
      }
    } else {
      b.textContent = spec.label;
    }
    b.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      b.style.background = BTN_BG_LIT;
      b.style.color = "#000";
      this.onPress?.(e.timeStamp);
      this.input.press(spec.id);
    });
    const up = () => {
      b.style.background = BTN_BG;
      b.style.color = "#fff";
    };
    b.addEventListener("pointerup", up);
    b.addEventListener("pointercancel", up);
    b.addEventListener("pointerleave", up);
    return { el: b, badge };
  }
}

/**
 * FPS, p95 frame time and touch→next-frame delay (?perf=1). The delay is from the input event to
 * the start of the next animation frame, i.e. the part of the latency the browser adds before the
 * game can react (display scan-out not included).
 */
export class PerfOverlay {
  private el: HTMLDivElement | null = null;
  private raf = 0;
  private last = 0;
  private frames: number[] = [];
  private lat: number[] = [];
  private pending: number | null = null;
  private shownAt = 0;

  constructor(private readonly mount: HTMLElement) {}

  attach(): void {
    if (this.el) return;
    this.el = el("div", {
      position: "absolute",
      left: "8px",
      bottom: "52px",
      zIndex: "40",
      padding: "4px 8px",
      borderRadius: "8px",
      background: "rgba(0,0,0,0.6)",
      color: "#bdfc4f",
      font: "11px ui-monospace, monospace",
      pointerEvents: "none",
      whiteSpace: "pre",
    });
    this.mount.appendChild(this.el);
    const loop = (t: number) => {
      if (this.last) this.frames.push(t - this.last);
      if (this.frames.length > 120) this.frames.shift();
      this.last = t;
      if (this.pending !== null) {
        this.lat.push(Math.max(0, t - this.pending));
        if (this.lat.length > 40) this.lat.shift();
        this.pending = null;
      }
      if (t - this.shownAt > 500) {
        this.shownAt = t;
        this.render();
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** Event timestamp of a touch (same clock as requestAnimationFrame). */
  markInput(t: number): void {
    this.pending = t;
  }

  detach(): void {
    cancelAnimationFrame(this.raf);
    this.el?.remove();
    this.el = null;
  }

  private render(): void {
    if (!this.el || this.frames.length < 2) return;
    const avg = this.frames.reduce((a, b) => a + b, 0) / this.frames.length;
    const p95 = pct(this.frames, 0.95);
    const lat = this.lat.length
      ? `${Math.round(this.lat.reduce((a, b) => a + b, 0) / this.lat.length)} / ${Math.round(pct(this.lat, 0.95))} ms`
      : "—";
    this.el.textContent = `FPS ${Math.round(1000 / avg)}  frame p95 ${p95.toFixed(1)} ms\ntouch→frame avg/p95 ${lat}`;
  }
}

function pct(a: number[], q: number): number {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))] ?? 0;
}

function el(tag: "div", style: Partial<CSSStyleDeclaration>): HTMLDivElement {
  const node = document.createElement(tag);
  Object.assign(node.style, style);
  return node;
}
