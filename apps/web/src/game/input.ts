/**
 * Keyboard / mouse state for the game canvas. Movement, trigger, roll and walk are sampled by the
 * fixed-rate input loop; discrete intents (reload, interact, inventory, …) fire immediately as
 * callbacks.
 *
 * Bindings: WASD/arrows move, Shift walk (quiet), Space roll, LMB fire, wheel / 1 / 2 weapon,
 * 3 / 4 heal, G / 5 throw a grenade (Weapons v2), R reload, F interact/search, Tab inventory,
 * T take all, M full map, Esc close.
 *
 * Phones (touch-controls.ts): an analog move stick (part deflection = quiet walk), an aim stick
 * that only aims, and buttons that go through press(). Firing is automatic (auto-fire.ts): while
 * the aim stick is held and the renderer's setTouchAutoFire check says the aim line is on an enemy,
 * the touch trigger is pulled. While those sticks are
 * mounted (setTouchSticks), finger pointer events on the canvas never aim or fire; without them (a
 * touch laptop whose primary pointer is a mouse or trackpad) a finger aims and fires like the mouse.
 *
 * DOM access goes through InputEnv so the controller runs under node:test with fakes.
 */

import { ROLL, type HealKind } from "@extract/shared";

export interface InputActions {
  /** F: pick up / open the container or corpse in front of the player. */
  interact(): void;
  reload(): void;
  selectSlot(slot: 0 | 1): void;
  toggleSlot(): void;
  heal(kind: HealKind): void;
  /**
   * Weapons v2, G / 5 and the touch grenade button: throw a hand grenade. Without `aim` the
   * renderer throws toward the cursor (distance = cursor distance) or, on a phone, ahead along the
   * facing at GRENADE_TAP_FRAC; the touch button's drag passes its own direction and range.
   */
  throwGrenade?(aim?: GrenadeAim): void;
  /** Tab. */
  toggleInventory?(): void;
  /** T: take everything from the open container. */
  takeAll?(): void;
  /** Esc: close the topmost panel (inventory, search, full map). */
  closePanel?(): void;
  /** M: full-screen map. */
  toggleMap?(): void;
  /**
   * Touch MAP button when no panel handles M: the full map system listens to the M key itself, so
   * the keyboard path never calls this.
   */
  toggleFullMap?(): void;
}

/** Touch buttons (touch-controls.ts), dispatched by InputController.press(). */
export type TouchAction = "roll" | "interact" | "reload" | "swap" | "bandage" | "medkit" | "grenade" | "inventory" | "map";

/** A grenade throw: direction (radians) and 0..1 of the throw range (shared grenadeThrowPx). */
export interface GrenadeAim {
  angle: number;
  frac: number;
}

/** Move stick pushed less than this far (0..1) = quiet walk. */
export const TOUCH_WALK_BELOW = 0.55;
/** Move stick deflection under which it does not steer the facing (aim follows movement). */
const TOUCH_FACE_FROM = 0.2;

/**
 * Aim an input sample carries. A held touch stick (the aim stick, else the move stick past its dead
 * zone) wins as of now: the renderer copies the stick into its own aim only after the input loop,
 * so a flick that sets the angle and the trigger in one pointermove would otherwise send its first
 * shot (the whole shot of a semi-auto, which fires on the press edge) along the previous facing.
 * While a panel blocks input the aim stays frozen.
 */
export function sampleAim(aim: number, touchFacing: number | null, blocked: boolean): number {
  return !blocked && touchFacing !== null ? touchFacing : aim;
}

/** The DOM surface the controller needs (window, document, clock). */
export interface InputEnv {
  win: Pick<Window, "addEventListener" | "removeEventListener">;
  doc: Pick<Document, "addEventListener" | "removeEventListener" | "activeElement" | "body" | "documentElement">;
  now(): number;
}

const MOVE_KEYS: Record<string, [number, number]> = {
  KeyW: [0, -1],
  ArrowUp: [0, -1],
  KeyS: [0, 1],
  ArrowDown: [0, 1],
  KeyA: [-1, 0],
  ArrowLeft: [-1, 0],
  KeyD: [1, 0],
  ArrowRight: [1, 0],
};

const WALK_KEYS = new Set(["ShiftLeft", "ShiftRight"]);

/** Wheel events come in bursts (trackpads especially); one toggle per burst. */
const WHEEL_COOLDOWN_MS = 180;

type Focusable = { tagName?: unknown; isContentEditable?: unknown; blur?: () => void };

/** Text fields keep every key (chat, nickname, market search): the game ignores them. */
export function isTypingTarget(t: EventTarget | null | undefined): boolean {
  const el = t as Focusable | null | undefined;
  if (!el || typeof el.tagName !== "string") return false;
  const tag = el.tagName.toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true;
}

export class InputController {
  /** Pointer position in canvas CSS pixels. */
  mouseX = 0;
  mouseY = 0;
  private hasMouse = false;
  private keys = new Set<string>();
  private fireHeld = false;
  /** Set on press so a click shorter than one input tick still reaches the server. */
  private fireLatched = false;
  /** Samples that still carry roll:true after a Space press (ROLL.BUFFER_SAMPLES per press). */
  private rollSamplesLeft = 0;
  /** An open panel (inventory, search, map) owns the mouse: no fire from canvas clicks. */
  private fireBlocked = false;
  private lastWheelAt = -Infinity;
  /** Touch twin-stick (touch-controls.ts): analog move vector, aim direction, trigger. */
  private touchMove: { x: number; y: number } | null = null;
  private touchAim: number | null = null;
  /** Phones: whether the aim line along an angle is on an enemy right now (auto-fire.ts), null = never fire. */
  private autoFire: ((angle: number) => boolean) | null = null;
  /**
   * Semi-auto weapons fire on a press, so a held fire stick re-presses every this many ms
   * (the weapon's fire interval; 0 = automatic weapon, the trigger is simply held).
   */
  private touchRepeatMs = 0;
  /** Clock of the last touch press edge sent; null = the touch trigger is not pressed. */
  private touchPressAt: number | null = null;
  /** The last sample carried the touch press. */
  private touchHigh = false;
  /** The touch sticks are mounted: fingers belong to them, finger events on the canvas are ignored. */
  private touchSticks = false;
  /** Weapons v2: the touch grenade button is being dragged (aim preview), null otherwise. */
  private grenadeDrag: GrenadeAim | null = null;
  private attached = false;
  private readonly env: InputEnv;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly actions: InputActions,
    env?: InputEnv,
  ) {
    this.env = env ?? { win: window, doc: document, now: () => performance.now() };
  }

  attach() {
    if (this.attached) return;
    this.attached = true;
    // Programmatically focusable (not in the tab order): a canvas click moves focus here, so Space
    // stops re-activating the last clicked HUD button and keys are known to belong to the game.
    if (!this.canvas.hasAttribute("tabindex")) this.canvas.tabIndex = -1;
    const { win, doc } = this.env;
    win.addEventListener("keydown", this.onKeyDown);
    win.addEventListener("keyup", this.onKeyUp);
    win.addEventListener("blur", this.onBlur);
    win.addEventListener("pointermove", this.onPointerMove, { passive: true });
    win.addEventListener("pointerup", this.onPointerUp);
    win.addEventListener("pointercancel", this.onPointerUp);
    doc.addEventListener("visibilitychange", this.onBlur);
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.canvas.addEventListener("contextmenu", this.onContextMenu);
  }

  detach() {
    if (!this.attached) return;
    this.attached = false;
    const { win, doc } = this.env;
    win.removeEventListener("keydown", this.onKeyDown);
    win.removeEventListener("keyup", this.onKeyUp);
    win.removeEventListener("blur", this.onBlur);
    win.removeEventListener("pointermove", this.onPointerMove);
    win.removeEventListener("pointerup", this.onPointerUp);
    win.removeEventListener("pointercancel", this.onPointerUp);
    doc.removeEventListener("visibilitychange", this.onBlur);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.canvas.removeEventListener("contextmenu", this.onContextMenu);
    this.releaseAll();
  }

  /** Whether the pointer has been over the page at least once (aim is meaningless before). */
  get hasPointer(): boolean {
    return this.hasMouse;
  }

  movement(): { mx: number; my: number } {
    if (this.touchMove) {
      const { x, y } = this.touchMove;
      const len = Math.hypot(x, y);
      return len > 1 ? { mx: x / len, my: y / len } : { mx: x, my: y };
    }
    let mx = 0;
    let my = 0;
    for (const code of this.keys) {
      const d = MOVE_KEYS[code];
      if (!d) continue;
      mx += d[0];
      my += d[1];
    }
    return { mx: Math.max(-1, Math.min(1, mx)), my: Math.max(-1, Math.min(1, my)) };
  }

  /** Trigger state for one input sample. */
  sampleFire(): boolean {
    const fire = !this.fireBlocked && (this.fireHeld || this.fireLatched || this.sampleTouchFire());
    this.fireLatched = false;
    return fire;
  }

  /**
   * The touch trigger for one sample: pulled while the aim stick is held and the auto-fire check
   * says the aim line is on an enemy. Automatic weapons: held. Semi-auto: a press on the first
   * sample, then one released sample, then a new press every touchRepeatMs while the aim stays on
   * target, so it keeps firing at the weapon's rate.
   */
  private sampleTouchFire(): boolean {
    const aim = this.touchAim;
    const on = aim !== null && !this.fireBlocked && !!this.autoFire && this.autoFire(aim);
    if (!on) {
      this.touchPressAt = null;
      this.touchHigh = false;
      return false;
    }
    if (this.touchRepeatMs <= 0) return true;
    const now = this.env.now();
    // A new press needs a released sample before it (the server fires semi-autos on the edge).
    if (this.touchPressAt === null || (!this.touchHigh && now - this.touchPressAt >= this.touchRepeatMs)) {
      this.touchPressAt = now;
      this.touchHigh = true;
      return true;
    }
    this.touchHigh = false;
    return false;
  }

  /**
   * Roll flag for one input sample. A press is repeated on ROLL.BUFFER_SAMPLES consecutive samples,
   * so a press up to 200 ms before the cooldown ends still rolls and one dropped input does not
   * lose the roll. Repeats while already rolling are ignored by stepMovement on both sides.
   */
  sampleRoll(): boolean {
    if (this.rollSamplesLeft <= 0) return false;
    this.rollSamplesLeft -= 1;
    return true;
  }

  /** Quiet walk (Shift) held, or the move stick pushed only part way. */
  walkHeld(): boolean {
    for (const k of WALK_KEYS) if (this.keys.has(k)) return true;
    if (this.touchMove) {
      const len = Math.hypot(this.touchMove.x, this.touchMove.y);
      return len > 0 && len < TOUCH_WALK_BELOW;
    }
    return false;
  }

  /** Move stick: x, y in -1..1 (screen axes = world axes), null when released. */
  setTouchMove(v: { x: number; y: number } | null): void {
    this.touchMove = v && Number.isFinite(v.x) && Number.isFinite(v.y) ? { x: v.x, y: v.y } : null;
  }

  /** Aim stick: direction in radians (screen axes = world axes); null = released. It never fires by itself. */
  setTouchAim(angle: number | null): void {
    this.touchAim = angle !== null && Number.isFinite(angle) ? angle : null;
  }

  /**
   * Phones: auto-fire check, called once per input sample with the aim stick's angle (the renderer
   * passes autoFireTarget over the client's visible entities). null = the touch trigger never pulls.
   */
  setTouchAutoFire(check: ((angle: number) => boolean) | null): void {
    this.autoFire = check;
  }

  /** Re-press interval of a held fire stick: the semi-auto weapon's fire interval, 0 = automatic. */
  setTouchRepeatMs(ms: number): void {
    this.touchRepeatMs = Number.isFinite(ms) && ms > 0 ? ms : 0;
  }

  /** Aim set by the touch aim stick (overrides the mouse while held), null when released. */
  get touchAimAngle(): number | null {
    return this.touchAim;
  }

  /** Direction of the move stick when pushed past the facing dead zone, else null. */
  get touchMoveAngle(): number | null {
    const m = this.touchMove;
    if (!m || Math.hypot(m.x, m.y) < TOUCH_FACE_FROM) return null;
    return Math.atan2(m.y, m.x);
  }

  /** Facing from the touch sticks right now: the aim stick, else the move stick; null when neither steers. */
  get touchFacing(): number | null {
    return this.touchAim ?? this.touchMoveAngle;
  }

  /**
   * The touch sticks are mounted (TouchControls): finger pointer events on the canvas then neither
   * aim nor fire. Without them a finger on the canvas acts like the mouse.
   */
  setTouchSticks(on: boolean): void {
    this.touchSticks = on;
  }

  /** Touch button press: the same paths as the keys (roll buffer, heal prediction, panels). */
  press(action: TouchAction): void {
    const a = this.actions;
    switch (action) {
      case "roll":
        this.rollSamplesLeft = ROLL.BUFFER_SAMPLES;
        return;
      case "interact":
        a.interact();
        return;
      case "reload":
        a.reload();
        return;
      case "swap":
        a.toggleSlot();
        return;
      case "bandage":
      case "medkit":
        a.heal(action);
        return;
      case "grenade":
        a.throwGrenade?.();
        return;
      case "inventory":
        a.toggleInventory?.();
        return;
      case "map":
        if (a.toggleMap) a.toggleMap();
        else a.toggleFullMap?.();
        return;
    }
  }

  /** Touch grenade button dragged: the aim preview the renderer draws (null = released / cancelled). */
  setGrenadeAim(v: GrenadeAim | null): void {
    this.grenadeDrag = v && Number.isFinite(v.angle) && Number.isFinite(v.frac) ? { angle: v.angle, frac: clamp01(v.frac) } : null;
  }

  /** The touch grenade drag in progress, null when none. */
  get grenadeAim(): GrenadeAim | null {
    return this.grenadeDrag;
  }

  /** Touch grenade button released after a drag: throw along that direction and range. */
  throwGrenadeAt(angle: number, frac: number): void {
    this.grenadeDrag = null;
    if (!Number.isFinite(angle) || !Number.isFinite(frac)) return;
    this.actions.throwGrenade?.({ angle, frac: clamp01(frac) });
  }

  /**
   * Drop buffered one-shot input (click latch, roll buffer) while the player is not controllable,
   * so it does not fire or roll on the first input once control returns.
   */
  dropBuffered(): void {
    this.fireLatched = false;
    this.rollSamplesLeft = 0;
  }

  /** An open panel takes the mouse: aim/fire are blocked on the client, movement continues. */
  setFireBlocked(blocked: boolean): void {
    this.fireBlocked = blocked;
    if (blocked) {
      this.fireHeld = false;
      this.fireLatched = false;
    }
  }

  /** A click not yet carried by an input sample (the renderer sends it at once instead of waiting). */
  get hasFreshPress(): boolean {
    return this.fireLatched && !this.fireBlocked;
  }

  get isFireBlocked(): boolean {
    return this.fireBlocked;
  }

  /** Nothing but the game holds keyboard focus (the canvas, or nothing at all). */
  private gameHasFocus(): boolean {
    const a = this.env.doc.activeElement;
    return !a || a === this.canvas || a === this.env.doc.body || a === this.env.doc.documentElement;
  }

  private releaseAll() {
    this.keys.clear();
    this.touchMove = null;
    this.touchAim = null;
    this.touchPressAt = null;
    this.touchHigh = false;
    this.fireHeld = false;
    this.fireLatched = false;
    this.rollSamplesLeft = 0;
    this.grenadeDrag = null;
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (isTypingTarget(e.target)) {
      // Esc leaves a text field so the next keys reach the game again.
      if (e.code === "Escape") (e.target as Focusable).blur?.();
      return;
    }
    // Leave browser shortcuts (Cmd+R, Ctrl+F, …) alone.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (MOVE_KEYS[e.code]) {
      this.keys.add(e.code);
      if (e.code.startsWith("Arrow")) e.preventDefault();
      return;
    }
    if (WALK_KEYS.has(e.code)) {
      this.keys.add(e.code);
      return;
    }
    if (e.repeat) {
      // Held Space / Tab must not scroll the page or walk the focus either.
      if ((e.code === "Space" && this.gameHasFocus()) || e.code === "Tab") e.preventDefault();
      return;
    }
    switch (e.code) {
      case "Space":
        this.rollSamplesLeft = ROLL.BUFFER_SAMPLES;
        // Only while the game has focus: elsewhere (a focused HUD button) Space keeps its meaning.
        if (this.gameHasFocus()) e.preventDefault();
        return;
      case "Tab":
        // Focus traversal is meaningless in a raid; Tab must also close the panel when focus sits
        // inside it, so it is always taken.
        this.actions.toggleInventory?.();
        break;
      case "KeyT":
        if (!this.actions.takeAll) return;
        this.actions.takeAll();
        break;
      case "KeyM":
        if (!this.actions.toggleMap) return;
        this.actions.toggleMap();
        break;
      case "Escape":
        this.actions.closePanel?.();
        return;
      case "KeyR":
        this.actions.reload();
        break;
      case "KeyF":
        this.actions.interact();
        break;
      case "Digit1":
        this.actions.selectSlot(0);
        break;
      case "Digit2":
        this.actions.selectSlot(1);
        break;
      case "Digit3":
        this.actions.heal("bandage");
        break;
      case "Digit4":
        this.actions.heal("medkit");
        break;
      case "KeyG":
      case "Digit5":
        // Not while a panel owns the mouse: G there drops the focused inventory item instead.
        if (!this.actions.throwGrenade || this.fireBlocked || e.defaultPrevented) return;
        this.actions.throwGrenade();
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };

  private onBlur = () => {
    // Key-ups are lost while the window is unfocused: release everything, incl. walk and roll.
    this.releaseAll();
  };

  /** A finger while the touch sticks own the fingers (only a mouse or a pen aims by position then). */
  private isStickFinger(e: PointerEvent): boolean {
    return this.touchSticks && e.pointerType === "touch";
  }

  private onPointerMove = (e: PointerEvent) => {
    if (this.isStickFinger(e)) return;
    const rect = this.canvas.getBoundingClientRect();
    this.mouseX = e.clientX - rect.left;
    this.mouseY = e.clientY - rect.top;
    this.hasMouse = true;
  };

  private onPointerDown = (e: PointerEvent) => {
    // With the sticks mounted, a tap on the open canvas (outside the sticks and buttons) neither
    // aims nor fires.
    if (this.isStickFinger(e)) return;
    this.onPointerMove(e);
    // Clicking the canvas takes focus away from any HUD input / button so keys reach the game.
    const active = this.env.doc.activeElement as (Element & Focusable) | null;
    if (active !== this.canvas) {
      this.canvas.focus({ preventScroll: true });
      if (this.env.doc.activeElement === active && active && isTypingTarget(active)) active.blur?.();
    }
    // Shift+click starts a text/link selection in some browsers; walking while shooting is normal.
    if (e.shiftKey) e.preventDefault();
    if (e.button !== 0 || this.fireBlocked) return;
    this.fireHeld = true;
    this.fireLatched = true;
  };

  private onPointerUp = (e: PointerEvent) => {
    if (this.isStickFinger(e)) return;
    if (e.button !== 0 && e.type !== "pointercancel") return;
    this.fireHeld = false;
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const now = this.env.now();
    if (Math.abs(e.deltaY) < 1 || now - this.lastWheelAt < WHEEL_COOLDOWN_MS) return;
    this.lastWheelAt = now;
    this.actions.toggleSlot();
  };

  private onContextMenu = (e: Event) => {
    e.preventDefault();
  };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
