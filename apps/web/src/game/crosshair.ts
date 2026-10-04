/**
 * Crosshair.
 *
 * - Desktop: the system cursor over the game canvas is replaced by a crosshair through CSS
 *   (`.game-crosshair` in app/globals.css: a small inline SVG cursor). A hardware cursor has no
 *   input lag at all, unlike a sprite redrawn on the next frame; HUD panels, the inventory and the
 *   other DOM overlays keep the normal cursor, and the renderer drops the class while an overlay
 *   drawn on the canvas itself (the full map) owns the mouse.
 * - Phone: a reticle on the aim line of the right stick at the effective aim distance (the active
 *   weapon's range, kept on screen), with a faint line from the player. It lives in the screen
 *   layer above the fog (UI, always visible) and fades out when the stick is released. It turns red
 *   while the aim line is on an enemy, i.e. while auto-fire shoots (auto-fire.ts).
 */

import { Container, Graphics } from "pixi.js";

/** The CSS class (app/globals.css) that swaps the canvas cursor for the crosshair. */
export const CROSSHAIR_CURSOR_CLASS = "game-crosshair";

/** Toggle the desktop crosshair cursor on the canvas; returns `on` so callers can cache it. */
export function setCanvasCrosshair(canvas: { classList: Pick<DOMTokenList, "toggle"> }, on: boolean): boolean {
  canvas.classList.toggle(CROSSHAIR_CURSOR_CLASS, on);
  return on;
}

/**
 * Keep Pixi's event system from owning the canvas cursor: it sets canvas.style.cursor to
 * cursorStyles.default ("inherit") on pointer moves, and that inline style beats the
 * .game-crosshair class. With "" (default and hover) the inline style stays empty.
 */
export function releaseCanvasCursor(app: { renderer?: { events?: { cursorStyles?: Record<string, unknown> } }; canvas?: { style: { cursor: string } } }): void {
  const styles = app.renderer?.events?.cursorStyles;
  if (styles) {
    styles.default = "";
    styles.pointer = "";
  }
  if (app.canvas) app.canvas.style.cursor = "";
}

export const TOUCH_CROSSHAIR = {
  /** Kept this far (px) inside the screen edges. */
  EDGE_INSET: 36,
  /** Never closer than this (px) to the player, so it never sits on the own sprite. */
  MIN_PX: 48,
  /** Fade time constants (ms). */
  FADE_IN_MS: 50,
  FADE_OUT_MS: 220,
  /** The aim line starts this far (px) from the player and stops this far before the reticle. */
  LINE_FROM_PX: 26,
  LINE_GAP_PX: 18,
  LINE_ALPHA: 0.35,
  /** Reticle + line tint while auto-fire is locked on an enemy (auto-fire.ts). */
  LOCK_TINT: 0xff3b3b,
} as const;

/**
 * Screen distance (px) from (sx, sy) along `angle` to the screen rect shrunk by `inset`, or 0 when
 * the point is outside that rect.
 */
export function rayToScreenEdge(sx: number, sy: number, angle: number, w: number, h: number, inset: number): number {
  const x0 = inset, y0 = inset, x1 = w - inset, y1 = h - inset;
  if (!(x1 > x0) || !(y1 > y0) || sx < x0 || sx > x1 || sy < y0 || sy > y1) return 0;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  let t = Infinity;
  if (c > 1e-9) t = Math.min(t, (x1 - sx) / c);
  else if (c < -1e-9) t = Math.min(t, (x0 - sx) / c);
  if (s > 1e-9) t = Math.min(t, (y1 - sy) / s);
  else if (s < -1e-9) t = Math.min(t, (y0 - sy) / s);
  return Number.isFinite(t) ? Math.max(0, t) : 0;
}

/**
 * Effective aim distance in SCREEN px for the touch crosshair: the weapon range (world px × zoom),
 * cut where the aim line would leave the screen (minus TOUCH_CROSSHAIR.EDGE_INSET), never below
 * MIN_PX. `rangeWorld` 0 / unknown → as far as the screen allows.
 */
export function touchCrosshairDistance(
  rangeWorld: number,
  zoom: number,
  sx: number,
  sy: number,
  angle: number,
  w: number,
  h: number,
): number {
  const edge = rayToScreenEdge(sx, sy, angle, w, h, TOUCH_CROSSHAIR.EDGE_INSET);
  const range = rangeWorld > 0 && zoom > 0 ? rangeWorld * zoom : Infinity;
  return Math.max(TOUCH_CROSSHAIR.MIN_PX, Math.min(range, edge));
}

/** Alpha one frame later: up fast while the stick aims, down slower once released. */
export function crosshairAlpha(prev: number, show: boolean, dtMs: number): number {
  const tau = show ? TOUCH_CROSSHAIR.FADE_IN_MS : TOUCH_CROSSHAIR.FADE_OUT_MS;
  const target = show ? 1 : 0;
  const k = 1 - Math.exp(-Math.max(0, dtMs) / tau);
  const a = prev + (target - prev) * k;
  return Math.abs(a - target) < 0.01 ? target : a;
}

/** The phone reticle + aim line (screen layer). */
export class TouchCrosshair {
  readonly root = new Container();
  private readonly line = new Graphics();
  private readonly reticle = new Graphics();
  private alpha = 0;
  private angle = 0;
  private dist: number = TOUCH_CROSSHAIR.MIN_PX;

  constructor() {
    this.line.rect(0, -1, 1, 2).fill(0xffffff);
    this.line.alpha = TOUCH_CROSSHAIR.LINE_ALPHA;
    const r = this.reticle;
    // Black outline under white strokes: readable on snow, sand and at night alike.
    r.circle(0, 0, 13).stroke({ width: 5, color: 0x000000, alpha: 0.65 });
    r.circle(0, 0, 13).stroke({ width: 2, color: 0xffffff });
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      r.moveTo(dx * 8, dy * 8).lineTo(dx * 19, dy * 19).stroke({ width: 5, color: 0x000000, alpha: 0.65 });
      r.moveTo(dx * 8, dy * 8).lineTo(dx * 19, dy * 19).stroke({ width: 2, color: 0xffffff });
    }
    r.circle(0, 0, 2).fill(0xffffff);
    this.root.addChild(this.line, this.reticle);
    this.root.eventMode = "none";
    this.root.interactiveChildren = false;
    this.root.visible = false;
  }

  /**
   * Per frame. `show` while the aim stick aims, `locked` while auto-fire is on a target (red); the last angle / distance are kept while it fades
   * out (following the player). Returns the reticle's screen position, or null when hidden.
   */
  update(dtMs: number, show: boolean, sx: number, sy: number, angle: number, distPx: number, locked = false): { x: number; y: number } | null {
    const tint = locked ? TOUCH_CROSSHAIR.LOCK_TINT : 0xffffff;
    if (this.reticle.tint !== tint) {
      this.reticle.tint = tint;
      this.line.tint = tint;
    }
    if (show) {
      this.angle = angle;
      this.dist = distPx;
    }
    this.alpha = crosshairAlpha(this.alpha, show, dtMs);
    this.root.visible = this.alpha > 0;
    if (!this.root.visible) return null;
    this.root.alpha = this.alpha;
    const c = Math.cos(this.angle);
    const s = Math.sin(this.angle);
    const x = sx + c * this.dist;
    const y = sy + s * this.dist;
    this.reticle.position.set(x, y);
    const len = Math.max(0, this.dist - TOUCH_CROSSHAIR.LINE_FROM_PX - TOUCH_CROSSHAIR.LINE_GAP_PX);
    this.line.visible = len > 4;
    this.line.position.set(sx + c * TOUCH_CROSSHAIR.LINE_FROM_PX, sy + s * TOUCH_CROSSHAIR.LINE_FROM_PX);
    this.line.rotation = this.angle;
    this.line.scale.set(len, 1);
    return { x, y };
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }
}
