/**
 * Keyboard / mouse state for the game canvas. Movement, trigger, roll and walk are sampled by the
 * fixed-rate input loop; discrete intents (reload, interact, inventory, …) fire immediately as
 * callbacks.
 *
 * Bindings: WASD/arrows move, Shift walk (quiet), Space roll, LMB fire, wheel / 1 / 2 weapon,
 * 3 / 4 heal, R reload, F interact/search, Tab inventory, T take all, M full map, Esc close.
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
  /** Tab. */
  toggleInventory?(): void;
  /** T: take everything from the open container. */
  takeAll?(): void;
  /** Esc: close the topmost panel (inventory, search, full map). */
  closePanel?(): void;
  /** M: full-screen map. */
  toggleMap?(): void;
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
    const fire = !this.fireBlocked && (this.fireHeld || this.fireLatched);
    this.fireLatched = false;
    return fire;
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

  /** Quiet walk (Shift) held. */
  walkHeld(): boolean {
    for (const k of WALK_KEYS) if (this.keys.has(k)) return true;
    return false;
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
    this.fireHeld = false;
    this.fireLatched = false;
    this.rollSamplesLeft = 0;
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

  private onPointerMove = (e: PointerEvent) => {
    const rect = this.canvas.getBoundingClientRect();
    this.mouseX = e.clientX - rect.left;
    this.mouseY = e.clientY - rect.top;
    this.hasMouse = true;
  };

  private onPointerDown = (e: PointerEvent) => {
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
