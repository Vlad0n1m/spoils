/**
 * Phone touch controls (TWA build): a floating move stick on the left half (part deflection =
 * quiet walk), a floating aim stick on the right half that only aims (firing is automatic while
 * the aim is on an enemy: auto-fire.ts), and round icon buttons in two groups: the combat cluster
 * around the aim stick (roll, use = search / pick up, reload, grenade — Weapons v2: tap throws
 * ahead, a drag off the button aims the throw and sets its range — and weapon swap) and the
 * utility row under the minimap (bandage, medkit, inventory, full map). Tapping the minimap also
 * opens the full map; while it is open the sticks and the cluster are gone and a tap anywhere (or
 * the × button) closes it, so no finger moves or aims through the map.
 *
 * Both sticks are always marked: at rest a faint ring + knob labelled MOVE / AIM sits in each
 * thumb corner (stickRest); a finger anywhere in the stick's half moves the stick there, and on
 * release it returns to its rest mark. Buttons have a ≥ 44 px hit area with a smaller,
 * half-transparent disc drawn inside it (BUTTON_DISC), so they hide less of the map.
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
import { zoneToastY } from "./fullmap";
import { bossBarY } from "./boss-hud";
import { touchIconSvg } from "./touch-icons";

/** Stick travel in CSS px for full deflection. */
export const STICK_RADIUS = 48;
/** Stick knob diameter (CSS px). */
export const STICK_KNOB = 40;
/** Aim stick: aims from this deflection (it never fires by itself: auto-fire.ts). */
export const AIM_FROM = 0.2;
/** Visible disc of a button, as a fraction of its hit area. */
export const BUTTON_DISC = 0.8;
/** The stick zones start this far down the mount (the top strip belongs to the HUD and the minimap). */
const STICK_ZONE_TOP = 0.2;

/** Phones and tablets (coarse primary pointer); ?touch=1 forces it on a desktop, ?touch=0 off. */
export { shouldUseTouch } from "./touch-mode";

/**
 * Weapons v2, grenade button: a finger dragged at least GRENADE_DRAG_FROM px off the button aims
 * the throw; the range grows over the next GRENADE_DRAG_SPAN px (0 = GRENADE.MIN_PX, 1 = MAX_PX).
 * A shorter drag is a tap: the renderer throws ahead along the facing (GRENADE_TAP_FRAC).
 * Toward a near screen edge (the button sits ~45 px from the left edge on a small landscape phone)
 * the span shrinks to the room the finger has, down to GRENADE_DRAG_MIN_SPAN, so the full range is
 * reachable in every direction.
 */
export const GRENADE_DRAG_FROM = 16;
export const GRENADE_DRAG_SPAN = 110;
export const GRENADE_DRAG_MIN_SPAN = 20;
/** The finger stops this short of the screen edge (bezel, rounded corners). */
export const GRENADE_DRAG_EDGE_PX = 6;

/**
 * Finger offset from where the grenade button was pressed → throw aim, null while still a tap.
 * `room` = px from the press point to the screen edge along the drag (dragRoom); omitted = no limit.
 */
export function grenadeDragAim(dx: number, dy: number, room = Infinity): { angle: number; frac: number } | null {
  const len = Math.hypot(dx, dy);
  if (!(len >= GRENADE_DRAG_FROM)) return null;
  const span = Math.max(GRENADE_DRAG_MIN_SPAN, Math.min(GRENADE_DRAG_SPAN, room - GRENADE_DRAG_EDGE_PX - GRENADE_DRAG_FROM));
  return { angle: Math.atan2(dy, dx), frac: Math.max(0, Math.min(1, (len - GRENADE_DRAG_FROM) / span)) };
}

/** Distance from (x, y) to the edge of a w × h screen along `angle` (0 outside the screen). */
export function dragRoom(x: number, y: number, angle: number, w: number, h: number): number {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  let t = Infinity;
  if (c > 1e-9) t = Math.min(t, (w - x) / c);
  else if (c < -1e-9) t = Math.min(t, -x / c);
  if (s > 1e-9) t = Math.min(t, (h - y) / s);
  else if (s < -1e-9) t = Math.min(t, -y / s);
  return Number.isFinite(t) ? Math.max(0, t) : 0;
}

/** Aim stick deflection (stick units, 0..1 past the centre) → aim angle, null inside the dead zone. */
export function aimFromStick(x: number, y: number): number | null {
  const len = Math.hypot(x, y);
  if (!(len >= AIM_FROM)) return null;
  return Math.atan2(y, x);
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

/** Inline SVG glyph of a button (touch-icons.ts). */
export type TouchIconId = "roll" | "use" | "reload" | "swap" | "grenade" | "bandage" | "medkit" | "bag" | "map";

export interface TouchButtonSpec {
  id: TouchButtonId;
  /**
   * "cluster": combat actions packed around the aim stick's rest mark (right thumb); "top": the
   * utility row right under the minimap (heals, inventory, full map).
   */
  group: "cluster" | "top";
  /**
   * Cluster: preferred direction from the aim stick, degrees on screen (180 = left, 270 = up), so the
   * cluster keeps the same arc on every screen.
   */
  angle?: number;
  /** Preferred diameter (px); shrinks down to TOUCH_MIN_SIZE when the screen is tight. */
  size: number;
  icon: TouchIconId;
  aria: string;
}

/**
 * Every battle action that is not a stick (move / aim / fire / quiet walk are). Cluster buttons are
 * placed in this order, each on the free spot nearest the aim stick, so the first ones sit closest
 * to the thumb; the top row runs left → right in this order and ends under the minimap's right
 * edge. Take all and close are buttons of the search / inventory panels themselves; extraction is
 * standing in the circle.
 */
export const TOUCH_BUTTONS: readonly TouchButtonSpec[] = [
  { id: "roll", group: "cluster", angle: 225, size: 56, icon: "roll", aria: "Dodge roll" },
  { id: "interact", group: "cluster", angle: 180, size: 52, icon: "use", aria: "Search / pick up" },
  { id: "reload", group: "cluster", angle: 270, size: 48, icon: "reload", aria: "Reload" },
  { id: "grenade", group: "cluster", angle: 200, size: 48, icon: "grenade", aria: "Throw grenade (drag to aim)" },
  { id: "swap", group: "cluster", angle: 250, size: 48, icon: "swap", aria: "Switch weapon" },
  { id: "bandage", group: "top", size: 44, icon: "bandage", aria: "Bandage" },
  { id: "medkit", group: "top", size: 44, icon: "medkit", aria: "Medkit" },
  { id: "inventory", group: "top", size: 44, icon: "bag", aria: "Inventory" },
  { id: "map", group: "top", size: 44, icon: "map", aria: "Full map" },
];

/** Smallest hit area (px) a button shrinks to on a tight screen (the Apple / Material minimum). */
export const TOUCH_MIN_SIZE = 44;
/** Distance kept from the screen edges and between buttons (px; the discs add their own margin). */
const EDGE = 4;
const GAP = 6;
/** Candidate grid step (px). */
const STEP = 2;
/** Room kept around the resting aim stick's centre: a thumb going down to aim never lands on a button. */
export const STICK_KEEP = STICK_RADIUS + 10;
/** Cluster buttons stay within this distance of the aim stick's centre (px, to the button centre). */
export const CLUSTER_REACH = STICK_KEEP + 118;
/** The top row sits this far under the minimap. */
const TOP_ROW_GAP = 8;

/**
 * Where the left thumb lands to start the floating move stick: the bottom-left corner. No button
 * may sit there, or a thumb that goes down to move taps a medkit instead.
 */
export function thumbZone(w: number, h: number): { w: number; h: number } {
  return { w: Math.round(Math.max(136, Math.min(200, 0.19 * w))), h: Math.round(Math.max(140, Math.min(210, 0.4 * h))) };
}

/** The touch HUD's top stack (timer, compass, wipe banner, boss toast) is drawn at this scale (hud.tsx). */
export const TOUCH_TOP_SCALE = 0.8;
/** The touch HUD's bottom bar (vitals, weapon cards, carry) is drawn at this scale (hud.tsx). */
export const TOUCH_BAR_SCALE = 0.78;

/**
 * Rest mark of each stick (mount px): the middle of its thumb corner, at least one stick radius plus
 * a margin from the screen edges. A stick sits here, faint and labelled, while no finger holds it.
 */
export function stickRest(side: "left" | "right", w: number, h: number): { x: number; y: number } {
  const tz = thumbZone(w, h);
  const m = STICK_RADIUS + 14;
  const x = Math.max(m, (side === "left" ? tz.w : AIM_CORNER * tz.w) / 2);
  const y = Math.min(h - m, h - (side === "left" ? tz.h : AIM_CORNER * tz.h) / 2);
  return { x: side === "left" ? x : w - x, y };
}

/** The aim stick rests deeper in its corner than the move stick, so the action cluster fits around it. */
const AIM_CORNER = 0.8;

/** The minimap's screen rect (minimap.ts: MINIMAP_MARGIN from the top-right corner). */
export function minimapRect(w: number, h: number): Rect {
  const mm = minimapSize(w, h);
  return { x: Math.round(w - MINIMAP_MARGIN - mm), y: MINIMAP_MARGIN, w: Math.round(mm), h: Math.round(mm) };
}

/**
 * Screen areas the touch HUD (components/hud.tsx with `touch`) and the canvas HUD (minimap.ts,
 * boss-hud.ts, the zone toast of fullmap.ts) draw into, plus the move thumb's corner, in CSS px of the game mount. Sizes mirror the HUD's Tailwind classes at their
 * largest content, times the touch scales above; keep them in sync when the touch HUD layout changes.
 */
export function hudReservedRects(w: number, h: number): HudArea[] {
  const r: HudArea[] = [];
  // Top centre: phase timer / wipe countdown, extract compass, wipe warning, boss toast (the
  // top-1.5 stack, ≤ 21.5 rem wide and ~190 px tall unscaled, drawn at 80 %) and the boss bar
  // (bossBarY + 12 px bar, ≤ 340 px; 260 px on short screens).
  const topW = Math.round(Math.max(Math.min(w - 24, 352) * TOUCH_TOP_SCALE, Math.min(w - 24, h < 480 ? 268 : 348)));
  const topH = Math.round(Math.max(6 + 190 * TOUCH_TOP_SCALE, bossBarY(h) + 20));
  r.push({ id: "top", x: (w - topW) / 2, y: 0, w: topW, h: topH });
  // Top right: minimap.
  const mm = minimapSize(w, h);
  r.push({ id: "minimap", x: w - mm - MINIMAP_MARGIN - 6, y: 0, w: mm + MINIMAP_MARGIN + 6, h: MINIMAP_MARGIN + mm + 6 });
  // Top left: the menu and audio chips (2 × 40 px from left-2 / top-2) and the ping badge.
  r.push({ id: "chips", x: 0, y: 0, w: 164, h: 54 });
  // Bottom centre: the touch bar (12.5 rem vitals, two 5.5 rem weapon cards, the carry panel up to
  // 5 rem, gap-2; 5.25 rem cards, the active one lifted 6 px) at bottom-1, drawn at 78 %.
  const barW = Math.round((Math.min(w - 24, 480) + 12) * TOUCH_BAR_SCALE);
  const barH = Math.round(4 + (84 + 6 + 4) * TOUCH_BAR_SCALE);
  r.push({ id: "bar", x: (w - barW) / 2, y: h - barH, w: barW, h: barH });
  // The left thumb's corner (move stick). The resting aim stick is kept clear by the layout itself
  // (a STICK_KEEP circle, so buttons may tuck in around it).
  const tz = thumbZone(w, h);
  r.push({ id: "thumb-left", x: 0, y: h - tz.h, w: tz.w, h: tz.h });
  // Soft: shown now and then. Top left, under the chips: kill feed, up to 5 rows, max-w min(22rem, 40vw)
  // at 85 %. Only the first rows are kept clear: the feed is short-lived and paints over the buttons anyway.
  r.push({ id: "killfeed", soft: true, x: 0, y: 52, w: 8 + 0.85 * Math.min(352, 0.4 * w) + 6, h: 2 * 29 + 6 });
  // The zone toast (fullmap.ts ZoneToast, a few seconds when entering a zone; 80 % on short screens) under the boss bar.
  r.push({ id: "zone", soft: true, x: (w - topW) / 2, y: zoneToastY(h) - 8, w: topW, h: h < 480 ? 92 : 112 });
  // Interact hint + heal / reload progress (w-64 at 78 %) stacked above the bar.
  r.push({ id: "hint", soft: true, x: w / 2 - 120, y: h - barH - 76, w: 240, h: 76 });
  // Extract ring + caption: bottom clamp(13rem, 30vh, 17rem); a 6 rem ring from top-[6.75rem] when
  // ≤ 500 px tall.
  if (h <= 500) {
    r.push({ id: "ring", soft: true, x: w / 2 - 170, y: 104, w: 340, h: 140 });
  } else {
    const ringBottom = Math.max(208, Math.min(272, 0.3 * h));
    r.push({ id: "ring", soft: true, x: w / 2 - 200, y: h - ringBottom - 176, w: 400, h: 176 });
  }
  return r;
}

export function rectsOverlap(a: Rect, b: Rect, gap = 0): boolean {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}

/** Distance from a point to the nearest point of a rect (0 inside). */
export function distToRect(px: number, py: number, r: Rect): number {
  const dx = Math.max(r.x - px, 0, px - (r.x + r.w));
  const dy = Math.max(r.y - py, 0, py - (r.y + r.h));
  return Math.hypot(dx, dy);
}

/**
 * Button rects for a w × h game mount.
 *  - Top row: the "top" buttons side by side right under the minimap, right-aligned with it.
 *  - Cluster: each "cluster" button, in TOUCH_BUTTONS order, takes the free spot nearest the aim
 *    stick's rest mark — in the right half, outside the stick's keep-out circle (STICK_KEEP), clear
 *    of the HUD areas and of the buttons already placed — so they pack into an arc around the
 *    right thumb, never farther than CLUSTER_REACH from it.
 * Cramped screens shrink every button together (never below TOUCH_MIN_SIZE); only when that is not
 * enough may cluster buttons cover the soft areas (kill feed, interact hint, extract ring:
 * short-lived) — the hard ones are never covered. A button that still fits nowhere is left out
 * (absent from the map).
 */
export function layoutTouchButtons(
  w: number,
  h: number,
  reserved: readonly HudArea[] = hudReservedRects(w, h),
  specs: readonly TouchButtonSpec[] = TOUCH_BUTTONS,
): Map<TouchButtonId, Rect> {
  let best = new Map<TouchButtonId, Rect>();
  if (!(w > 0) || !(h > 0)) return best;
  // Shrinking the buttons beats covering a soft area; covering one beats dropping a button.
  for (const coverSoft of [false, true]) {
    for (const scale of LAYOUT_SCALES) {
      const sized = specs.map((s) => ({ ...s, size: Math.max(TOUCH_MIN_SIZE, Math.round((s.size * scale) / 2) * 2) }));
      const got = layoutPass(w, h, reserved, sized, coverSoft);
      if (got.size > best.size) best = got;
      if (got.size === specs.length) return got;
    }
  }
  return best;
}

const LAYOUT_SCALES = [1, 0.92, 0.85] as const;

function layoutPass(
  w: number,
  h: number,
  reserved: readonly HudArea[],
  specs: readonly TouchButtonSpec[],
  coverSoft: boolean,
): Map<TouchButtonId, Rect> {
  const out = new Map<TouchButtonId, Rect>();
  const placed: Rect[] = [];
  const hard = reserved.filter((r) => !r.soft);
  // Top row, right → left from the minimap's right edge.
  const mm = minimapRect(w, h);
  let x = mm.x + mm.w;
  const y = mm.y + mm.h + TOP_ROW_GAP;
  const top = specs.filter((s) => s.group === "top");
  for (let i = top.length - 1; i >= 0; i--) {
    const s = top[i]!;
    x -= s.size;
    const rc = { x, y, w: s.size, h: s.size };
    x -= GAP;
    if (rc.x < EDGE || rc.y + rc.h > h - EDGE) continue;
    if (hard.some((a) => rectsOverlap(rc, a))) continue;
    out.set(s.id, rc);
    placed.push(rc);
  }
  // Cluster around the aim stick.
  const c = stickRest("right", w, h);
  const cluster = specs.filter((s) => s.group === "cluster");
  for (const areas of coverSoft ? [reserved, hard] : [reserved]) {
    for (const spec of cluster) {
      if (out.has(spec.id)) continue;
      const rc = placeNearStick(spec.size, spec.angle ?? 225, w, h, c, areas, placed);
      if (!rc) continue;
      placed.push(rc);
      out.set(spec.id, rc);
    }
  }
  return out;
}

/** Cluster placement: px of extra distance one degree off a button's preferred direction costs. */
const ANGLE_COST = 0.8;

function placeNearStick(
  size: number,
  angle: number,
  w: number,
  h: number,
  c: { x: number; y: number },
  areas: readonly Rect[],
  placed: readonly Rect[],
): Rect | null {
  let best: Rect | null = null;
  let bestD = Infinity;
  for (let y = EDGE; y <= h - EDGE - size; y += STEP) {
    for (let x = Math.ceil(w / 2); x <= w - EDGE - size; x += STEP) {
      const dx = x + size / 2 - c.x;
      const dy = y + size / 2 - c.y;
      const dist = Math.hypot(dx, dy);
      if (dist > CLUSTER_REACH) continue;
      const off = Math.abs(((((Math.atan2(dy, dx) * 180) / Math.PI - angle) % 360) + 540) % 360 - 180);
      const d = dist + ANGLE_COST * off;
      if (d >= bestD) continue;
      const rc = { x, y, w: size, h: size };
      if (distToRect(c.x, c.y, rc) < STICK_KEEP) continue;
      if (areas.some((r) => rectsOverlap(rc, r))) continue;
      if (placed.some((r) => rectsOverlap(rc, r, GAP))) continue;
      best = rc;
      bestD = d;
    }
  }
  return best;
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
  /** Weapons v2: hand grenades carried (the grenade button's badge; dimmed at 0). */
  grenades: number;
  /** The full map is open: the controls step aside for it (tap anywhere closes it). */
  mapOpen?: boolean;
}

interface Stick {
  side: "left" | "right";
  zone: HTMLDivElement;
  base: HTMLDivElement;
  knob: HTMLDivElement;
  pointerId: number | null;
  ox: number;
  oy: number;
  /** Rest mark in zone px (stickRest). */
  rx: number;
  ry: number;
}

const BTN_BG = "rgba(22,27,40,0.55)";
const BTN_BG_LIT = "rgba(204,255,0,0.92)";
const BTN_BORDER = "2px solid rgba(0,0,0,0.6)";
/** Stick look at rest (faint mark) and while held. */
const STICK_REST = { base: "0.5", knob: "rgba(255,255,255,0.32)", text: "rgba(0,0,0,0.75)" };
const STICK_HELD = { base: "1", knob: "rgba(255,255,255,0.85)", text: "rgba(0,0,0,0.85)" };


export class TouchControls {
  private root: HTMLDivElement | null = null;
  private move: Stick | null = null;
  private aim: Stick | null = null;
  private readonly buttons = new Map<TouchButtonId, { el: HTMLDivElement; disc: HTMLDivElement; badge: HTMLSpanElement | null }>();
  private resizeObs: ResizeObserver | null = null;
  private laidOut = "";
  private shown: TouchHudState = { active: true, canUse: false, bandages: -1, medkits: -1, grenades: -1, mapOpen: false };
  /** Tap target over the canvas minimap: opens the full map. */
  private minimapHit: HTMLDivElement | null = null;
  /** While the full map is open: catches every finger (a tap closes the map), plus a visible ×. */
  private mapShield: HTMLDivElement | null = null;
  private mapClose: HTMLDivElement | null = null;
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
    this.move = this.makeStick(root, "left", { left: "0", top: `${STICK_ZONE_TOP * 100}%`, bottom: "0", width: "50%" }, "rgba(255,255,255,0.10)", "MOVE");
    this.aim = this.makeStick(root, "right", { right: "0", top: `${STICK_ZONE_TOP * 100}%`, bottom: "0", width: "50%" }, "rgba(255,90,90,0.12)", "AIM");
    this.bindStick(
      this.move,
      (x, y) => this.input.setTouchMove({ x, y }),
      () => this.input.setTouchMove(null),
    );
    this.bindStick(
      this.aim,
      (x, y) => this.input.setTouchAim(aimFromStick(x, y)),
      () => this.input.setTouchAim(null),
    );
    for (const spec of TOUCH_BUTTONS) {
      const b = this.makeButton(spec);
      root.appendChild(b.el);
      this.buttons.set(spec.id, b);
    }
    // The minimap is drawn on the canvas: a transparent tap target over it opens the full map.
    const hit = el("div", { position: "absolute", pointerEvents: "auto", touchAction: "none", borderRadius: "10px" });
    hit.setAttribute("role", "button");
    hit.setAttribute("aria-label", "Open full map");
    hit.setAttribute("data-minimap-hit", "");
    hit.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onPress?.(e.timeStamp);
      this.input.press("map");
    });
    root.appendChild(hit);
    this.minimapHit = hit;
    // Open full map: a shield over the whole mount (above the sticks) closes it on any tap, so no
    // finger moves, aims or presses a button through the map; the × marks how to leave.
    const shield = el("div", { position: "absolute", inset: "0", display: "none", pointerEvents: "auto", touchAction: "none" });
    shield.setAttribute("data-map-shield", "");
    const closeMap = (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!this.shown.mapOpen) return;
      this.onPress?.(e.timeStamp);
      this.input.press("map");
    };
    shield.addEventListener("pointerdown", closeMap);
    const close = el("div", {
      position: "absolute",
      display: "none",
      placeItems: "center",
      width: "48px",
      height: "48px",
      borderRadius: "50%",
      border: BTN_BORDER,
      boxSizing: "border-box",
      background: "rgba(22,27,40,0.85)",
      color: "#fff",
      pointerEvents: "auto",
      touchAction: "none",
    });
    close.innerHTML = touchIconSvg("close", 50);
    close.setAttribute("role", "button");
    close.setAttribute("aria-label", "Close map");
    close.setAttribute("data-map-close", "");
    close.addEventListener("pointerdown", closeMap);
    root.append(shield, close);
    this.mapShield = shield;
    this.mapClose = close;
    this.mount.appendChild(root);
    this.root = root;
    this.layout();
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObs = new ResizeObserver(() => this.layout());
      this.resizeObs.observe(this.mount);
    } else {
      window.addEventListener("resize", this.layout);
    }
    window.addEventListener("blur", this.releaseSticks);
    document.addEventListener("visibilitychange", this.releaseSticks);
  }

  detach(): void {
    this.resizeObs?.disconnect();
    this.resizeObs = null;
    window.removeEventListener("resize", this.layout);
    window.removeEventListener("blur", this.releaseSticks);
    document.removeEventListener("visibilitychange", this.releaseSticks);
    this.root?.remove();
    this.root = null;
    this.move = null;
    this.aim = null;
    this.buttons.clear();
    this.minimapHit = null;
    this.mapShield = null;
    this.mapClose = null;
    this.laidOut = "";
    this.input.setTouchMove(null);
    this.input.setTouchAim(null);
  }

  /** Mirror the HUD: hide while out of play, light USE, dim meds the player has none of. */
  sync(s: TouchHudState): void {
    const root = this.root;
    if (!root) return;
    const prev = this.shown;
    if (s.active !== prev.active) {
      root.style.display = s.active ? "" : "none";
      // Fingers lifted while hidden never send pointerup to a display:none zone.
      if (!s.active) this.releaseSticks();
    }
    if (s.canUse !== prev.canUse) {
      const use = this.buttons.get("interact")?.disc;
      if (use) {
        use.style.boxShadow = s.canUse ? "0 0 0 3px rgba(204,255,0,0.9)" : "none";
        use.style.background = s.canUse ? "rgba(22,27,40,0.8)" : BTN_BG;
      }
    }
    if (!!s.mapOpen !== !!prev.mapOpen) this.setMapMode(!!s.mapOpen);
    if (s.bandages !== prev.bandages) this.setCount("bandage", s.bandages);
    if (s.medkits !== prev.medkits) this.setCount("medkit", s.medkits);
    if (s.grenades !== prev.grenades) this.setCount("grenade", s.grenades);
    this.shown = { ...s };
  }

  /**
   * The app lost focus (notification shade, a system dialog, the tab hidden): a finger on a stick may
   * never get its pointerup, which would leave the stick claimed and dead to every later touch. Free
   * both, like InputController does with its own touch state on blur.
   */
  private releaseSticks = () => {
    this.releaseStick(this.move, () => this.input.setTouchMove(null));
    this.releaseStick(this.aim, () => this.input.setTouchAim(null));
    this.input.setGrenadeAim(null);
  };

  /**
   * The screen turned (portrait ↔ landscape) or the mount changed size under a held finger: free
   * both sticks and the grenade drag, then lay the buttons and rest marks out again for the new size.
   */
  reset(): void {
    this.releaseSticks();
    this.laidOut = "";
    this.layout();
  }

  /** Full map open: sticks, cluster and the minimap target step aside; the shield and × close it. */
  private setMapMode(open: boolean) {
    if (open) this.releaseSticks();
    for (const s of [this.move, this.aim]) if (s) s.zone.style.display = open ? "none" : "";
    if (this.minimapHit) this.minimapHit.style.visibility = open ? "hidden" : "";
    if (this.mapShield) this.mapShield.style.display = open ? "block" : "none";
    if (this.mapClose) this.mapClose.style.display = open ? "grid" : "none";
    for (const [id, b] of this.buttons) {
      // Hidden buttons keep their laid-out display; visibility only.
      b.el.style.visibility = open ? "hidden" : "";
      if (id === "map") b.disc.style.background = BTN_BG;
    }
  }

  private setCount(id: TouchButtonId, n: number) {
    const b = this.buttons.get(id);
    if (!b) return;
    b.el.style.opacity = n > 0 ? "1" : "0.5";
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
      const d = Math.round(rc.w * BUTTON_DISC);
      Object.assign(b.el.style, {
        display: "grid",
        left: `${rc.x}px`,
        top: `${rc.y}px`,
        width: `${rc.w}px`,
        height: `${rc.h}px`,
      });
      Object.assign(b.disc.style, { width: `${d}px`, height: `${d}px` });
    }
    const mm = minimapRect(w, h);
    if (this.minimapHit) {
      // A little larger than the minimap: easier to hit, still clear of the row under it.
      Object.assign(this.minimapHit.style, { left: `${mm.x - 4}px`, top: `${mm.y - 4}px`, width: `${mm.w + 8}px`, height: `${mm.h + 4 + 2}px` });
    }
    if (this.mapClose) Object.assign(this.mapClose.style, { left: `${mm.x + mm.w - 48}px`, top: `${mm.y}px` });
    // Sticks back to (or onto) their rest marks for this size.
    for (const s of [this.move, this.aim]) {
      if (!s) continue;
      const rest = stickRest(s.side, w, h);
      // From the zone's CSS box (STICK_ZONE_TOP, half width), not its measured rect: the zone is
      // display:none while the controls hide (portrait, full map) and would measure 0 × 0.
      s.rx = rest.x - (s.side === "right" ? w - w / 2 : 0);
      s.ry = rest.y - STICK_ZONE_TOP * h;
      if (s.pointerId === null) this.showRest(s);
    }
  };

  /** A stick at its rest mark: faint ring + knob with its label. */
  private showRest(s: Stick) {
    for (const n of [s.base, s.knob]) {
      n.style.left = `${s.rx}px`;
      n.style.top = `${s.ry}px`;
      n.style.display = "grid";
    }
    s.base.style.opacity = STICK_REST.base;
    s.knob.style.background = STICK_REST.knob;
    s.knob.style.color = STICK_REST.text;
  }

  private makeStick(root: HTMLDivElement, side: "left" | "right", pos: Partial<CSSStyleDeclaration>, tint: string, label: string): Stick {
    const zone = el("div", { position: "absolute", pointerEvents: "auto", touchAction: "none", ...pos });
    zone.setAttribute("data-stick", label.toLowerCase());
    const base = el("div", {
      position: "absolute",
      width: `${STICK_RADIUS * 2}px`,
      height: `${STICK_RADIUS * 2}px`,
      marginLeft: `${-STICK_RADIUS}px`,
      marginTop: `${-STICK_RADIUS}px`,
      borderRadius: "50%",
      border: "2px solid rgba(255,255,255,0.35)",
      boxShadow: "0 0 0 1px rgba(0,0,0,0.45)",
      background: tint,
      display: "none",
      boxSizing: "border-box",
      pointerEvents: "none",
    });
    const knob = el("div", {
      position: "absolute",
      display: "none",
      width: `${STICK_KNOB}px`,
      height: `${STICK_KNOB}px`,
      marginLeft: `${-STICK_KNOB / 2}px`,
      marginTop: `${-STICK_KNOB / 2}px`,
      borderRadius: "50%",
      border: "2px solid rgba(0,0,0,0.7)",
      background: STICK_REST.knob,
      boxSizing: "border-box",
      pointerEvents: "none",
      // The MOVE / AIM mark, centred in the knob (grid: the global text-box-trim would lift a line box).
      placeItems: "center",
      lineHeight: "1",
      fontFamily: "var(--font-luckiest-guy), sans-serif",
      fontSize: "10px",
      letterSpacing: "0.04em",
      color: STICK_REST.text,
    });
    knob.textContent = label;
    zone.append(base, knob);
    root.appendChild(zone);
    return { side, zone, base, knob, pointerId: null, ox: 0, oy: 0, rx: 0, ry: 0 };
  }

  private releaseStick(s: Stick | null, onEnd: () => void) {
    if (!s || s.pointerId === null) return;
    s.pointerId = null;
    this.showRest(s);
    onEnd();
  }

  private bindStick(s: Stick, onMove: (x: number, y: number) => void, onEnd: () => void): void {
    const place = (node: HTMLDivElement, x: number, y: number) => {
      node.style.left = `${x}px`;
      node.style.top = `${y}px`;
      node.style.display = "grid";
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
      s.base.style.opacity = STICK_HELD.base;
      s.knob.style.background = STICK_HELD.knob;
      s.knob.style.color = STICK_HELD.text;
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

  /**
   * A button: a transparent hit area (laid out by layoutTouchButtons) with a smaller round disc
   * (BUTTON_DISC of it) that carries the look, so the button hides less of the map than it catches.
   */
  private makeButton(spec: TouchButtonSpec): { el: HTMLDivElement; disc: HTMLDivElement; badge: HTMLSpanElement | null } {
    const b = el("div", {
      position: "absolute",
      display: "none",
      placeItems: "center",
      boxSizing: "border-box",
      pointerEvents: "auto",
      touchAction: "none",
    });
    b.setAttribute("role", "button");
    b.setAttribute("aria-label", spec.aria);
    b.setAttribute("data-touch-button", spec.id);
    const disc = el("div", {
      position: "relative",
      display: "grid",
      placeItems: "center",
      borderRadius: "50%",
      border: BTN_BORDER,
      boxSizing: "border-box",
      background: BTN_BG,
      color: "#fff",
      fontFamily: "var(--font-luckiest-guy), sans-serif",
      letterSpacing: "0.04em",
      lineHeight: "1",
      textShadow: "0 1px 0 #000",
      pointerEvents: "none",
    });
    b.appendChild(disc);
    let badge: HTMLSpanElement | null = null;
    disc.innerHTML = touchIconSvg(spec.icon, 68);
    if (spec.id === "bandage" || spec.id === "medkit" || spec.id === "grenade") {
      badge = document.createElement("span");
      Object.assign(badge.style, {
        position: "absolute",
        right: "-5px",
        bottom: "-5px",
        minWidth: "15px",
        height: "15px",
        padding: "0 2px",
        borderRadius: "8px",
        border: "1.5px solid #000",
        background: "rgba(255,255,255,0.92)",
        color: "#000",
        fontSize: "9px",
        lineHeight: "12px",
        textAlign: "center",
        textShadow: "none",
        boxSizing: "border-box",
        pointerEvents: "none",
      });
      disc.appendChild(badge);
    }
    if (spec.id === "grenade") {
      this.bindGrenadeButton(b, disc);
      return { el: b, disc, badge };
    }
    b.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      disc.style.background = BTN_BG_LIT;
      disc.style.color = "#000";
      this.onPress?.(e.timeStamp);
      this.input.press(spec.id);
    });
    const up = () => {
      disc.style.background = BTN_BG;
      disc.style.color = "#fff";
    };
    b.addEventListener("pointerup", up);
    b.addEventListener("pointercancel", up);
    b.addEventListener("pointerleave", up);
    return { el: b, disc, badge };
  }

  /**
   * Weapons v2 grenade button: press, then either lift (a tap: throw ahead) or drag off the button
   * to aim (the renderer draws the throw line) and lift to throw there. A cancelled pointer (the
   * app lost focus) throws nothing.
   */
  private bindGrenadeButton(b: HTMLDivElement, disc: HTMLDivElement): void {
    let pid: number | null = null;
    let ox = 0;
    let oy = 0;
    let aim: { angle: number; frac: number } | null = null;
    const lit = (on: boolean) => {
      disc.style.background = on ? BTN_BG_LIT : BTN_BG;
      disc.style.color = on ? "#000" : "#fff";
    };
    b.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (pid !== null) return;
      pid = e.pointerId;
      try {
        b.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic pointer: moves still arrive while the finger stays on the button */
      }
      ox = e.clientX;
      oy = e.clientY;
      aim = null;
      lit(true);
      this.onPress?.(e.timeStamp);
    });
    b.addEventListener("pointermove", (e) => {
      if (e.pointerId !== pid) return;
      const dx = e.clientX - ox;
      const dy = e.clientY - oy;
      const room = dragRoom(ox, oy, Math.atan2(dy, dx), window.innerWidth, window.innerHeight);
      aim = grenadeDragAim(dx, dy, room);
      this.input.setGrenadeAim(aim);
    });
    const finish = (e: PointerEvent, cancel: boolean) => {
      if (e.pointerId !== pid) return;
      pid = null;
      lit(false);
      const a = aim;
      aim = null;
      this.input.setGrenadeAim(null);
      if (cancel) return;
      if (a) this.input.throwGrenadeAt(a.angle, a.frac);
      else this.input.press("grenade");
    };
    b.addEventListener("pointerup", (e) => finish(e, false));
    b.addEventListener("pointercancel", (e) => finish(e, true));
    b.addEventListener("lostpointercapture", (e) => finish(e, true));
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
