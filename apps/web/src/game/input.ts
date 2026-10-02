/**
 * Keyboard / mouse state for the game canvas. Movement and trigger are sampled by the
 * fixed-rate input loop; discrete intents (reload, interact, …) fire immediately as callbacks.
 */

import type { HealKind } from "@extract/shared";

export interface InputActions {
  interact(): void;
  reload(): void;
  selectSlot(slot: 0 | 1): void;
  toggleSlot(): void;
  heal(kind: HealKind): void;
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

/** Wheel events come in bursts (trackpads especially); one toggle per burst. */
const WHEEL_COOLDOWN_MS = 180;

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;
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
  private lastWheelAt = 0;
  private attached = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly actions: InputActions,
  ) {}

  attach() {
    if (this.attached) return;
    this.attached = true;
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    window.addEventListener("pointermove", this.onPointerMove, { passive: true });
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("pointercancel", this.onPointerUp);
    document.addEventListener("visibilitychange", this.onBlur);
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.canvas.addEventListener("contextmenu", this.onContextMenu);
  }

  detach() {
    if (!this.attached) return;
    this.attached = false;
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerUp);
    document.removeEventListener("visibilitychange", this.onBlur);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.canvas.removeEventListener("contextmenu", this.onContextMenu);
    this.keys.clear();
    this.fireHeld = false;
    this.fireLatched = false;
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
    const fire = this.fireHeld || this.fireLatched;
    this.fireLatched = false;
    return fire;
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (isTypingTarget(e.target)) return;
    // Leave browser shortcuts (Cmd+R, Ctrl+F, …) alone.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (MOVE_KEYS[e.code]) {
      this.keys.add(e.code);
      if (e.code.startsWith("Arrow")) e.preventDefault();
      return;
    }
    if (e.repeat) return;
    switch (e.code) {
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
    this.keys.clear();
    this.fireHeld = false;
  };

  private onPointerMove = (e: PointerEvent) => {
    const rect = this.canvas.getBoundingClientRect();
    this.mouseX = e.clientX - rect.left;
    this.mouseY = e.clientY - rect.top;
    this.hasMouse = true;
  };

  private onPointerDown = (e: PointerEvent) => {
    this.onPointerMove(e);
    if (e.button !== 0) return;
    this.fireHeld = true;
    this.fireLatched = true;
    // Clicking the canvas should take focus away from any HUD input so keys reach the game.
    if (document.activeElement instanceof HTMLElement && isTypingTarget(document.activeElement)) {
      document.activeElement.blur();
    }
  };

  private onPointerUp = (e: PointerEvent) => {
    if (e.button !== 0 && e.type !== "pointercancel") return;
    this.fireHeld = false;
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const now = performance.now();
    if (Math.abs(e.deltaY) < 1 || now - this.lastWheelAt < WHEEL_COOLDOWN_MS) return;
    this.lastWheelAt = now;
    this.actions.toggleSlot();
  };

  private onContextMenu = (e: Event) => {
    e.preventDefault();
  };
}
