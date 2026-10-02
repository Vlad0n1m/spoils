/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/input.test.ts
 * DOM-free: the controller takes an InputEnv, events are plain objects passed to its handlers.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ROLL } from "@extract/shared";
import { InputController, isTypingTarget, type InputActions, type InputEnv } from "./input";

type Listener = (e: unknown) => void;
class FakeTarget {
  listeners = new Map<string, Listener>();
  addEventListener(type: string, fn: Listener) {
    this.listeners.set(type, fn);
  }
  removeEventListener(type: string) {
    this.listeners.delete(type);
  }
  fire(type: string, e: unknown) {
    this.listeners.get(type)?.(e);
  }
}

class FakeCanvas extends FakeTarget {
  tagName = "CANVAS";
  tabIndex = 0;
  attrs = new Set<string>();
  focused = 0;
  doc: { activeElement: unknown } | null = null;
  hasAttribute(n: string) {
    return this.attrs.has(n);
  }
  getBoundingClientRect() {
    return { left: 10, top: 20 };
  }
  focus() {
    this.focused++;
    if (this.doc) this.doc.activeElement = this;
  }
}

function key(code: string, extra: Record<string, unknown> = {}) {
  return {
    code,
    repeat: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    target: null as unknown,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    ...extra,
  };
}

function pointer(extra: Record<string, unknown> = {}) {
  return { clientX: 110, clientY: 220, button: 0, shiftKey: false, type: "pointerdown", defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
}

function setup() {
  const calls: string[] = [];
  const actions: Required<InputActions> = {
    interact: () => calls.push("interact"),
    reload: () => calls.push("reload"),
    selectSlot: (s) => calls.push(`slot${s}`),
    toggleSlot: () => calls.push("toggleSlot"),
    heal: (k) => calls.push(`heal:${k}`),
    toggleInventory: () => calls.push("inventory"),
    takeAll: () => calls.push("takeAll"),
    closePanel: () => calls.push("close"),
    toggleMap: () => calls.push("map"),
  };
  const win = new FakeTarget();
  const body = { tagName: "BODY" };
  const doc = Object.assign(new FakeTarget(), { activeElement: body as unknown, body, documentElement: { tagName: "HTML" } });
  const canvas = new FakeCanvas();
  canvas.doc = doc;
  let now = 1000;
  const env = { win, doc, now: () => now } as unknown as InputEnv;
  const ctl = new InputController(canvas as unknown as HTMLCanvasElement, actions, env);
  ctl.attach();
  const down = (code: string, extra?: Record<string, unknown>) => {
    const e = key(code, extra);
    win.fire("keydown", e);
    return e;
  };
  const up = (code: string) => win.fire("keyup", key(code));
  return { ctl, calls, win, doc, canvas, down, up, setNow: (t: number) => (now = t) };
}

describe("InputController", () => {
  it("Space buffers roll:true for ROLL.BUFFER_SAMPLES samples, once per press", () => {
    const { ctl, down } = setup();
    assert.equal(ctl.sampleRoll(), false);
    const e = down("Space");
    assert.equal(e.defaultPrevented, true, "game has focus: no page scroll");
    const got = Array.from({ length: ROLL.BUFFER_SAMPLES + 3 }, () => ctl.sampleRoll());
    assert.deepEqual(got, [...Array(ROLL.BUFFER_SAMPLES).fill(true), false, false, false]);
    down("Space", { repeat: true });
    assert.equal(ctl.sampleRoll(), false, "auto-repeat does not roll again");
  });

  it("Space keeps its default when another element (a HUD button) has focus", () => {
    const { ctl, doc, down } = setup();
    doc.activeElement = { tagName: "BUTTON" };
    const e = down("Space");
    assert.equal(e.defaultPrevented, false);
    assert.equal(ctl.sampleRoll(), true);
  });

  it("Shift is quiet walk, released on keyup and blur", () => {
    const { ctl, win, down, up } = setup();
    assert.equal(ctl.walkHeld(), false);
    down("ShiftLeft", { shiftKey: true });
    down("KeyW", { shiftKey: true });
    assert.equal(ctl.walkHeld(), true);
    assert.deepEqual(ctl.movement(), { mx: 0, my: -1 }, "Shift does not change movement keys");
    up("ShiftLeft");
    assert.equal(ctl.walkHeld(), false);
    down("ShiftRight");
    down("Space");
    win.fire("blur", {});
    assert.equal(ctl.walkHeld(), false);
    assert.equal(ctl.sampleRoll(), false, "blur clears the roll buffer");
    assert.deepEqual(ctl.movement(), { mx: 0, my: 0 });
  });

  it("text fields keep every key", () => {
    const { ctl, calls, down } = setup();
    const input = { tagName: "INPUT", blurred: 0, blur() { this.blurred++; } };
    for (const code of ["Space", "ShiftLeft", "Tab", "KeyT", "KeyM", "KeyF", "KeyR", "KeyW"]) {
      const e = down(code, { target: input });
      assert.equal(e.defaultPrevented, false, code);
    }
    assert.equal(ctl.sampleRoll(), false);
    assert.equal(ctl.walkHeld(), false);
    assert.deepEqual(ctl.movement(), { mx: 0, my: 0 });
    assert.deepEqual(calls, []);
    down("Escape", { target: input });
    assert.equal(input.blurred, 1, "Esc leaves the text field");
    assert.deepEqual(calls, []);
  });

  it("isTypingTarget is DOM-free", () => {
    assert.equal(isTypingTarget(null), false);
    assert.equal(isTypingTarget({ tagName: "textarea" } as unknown as EventTarget), true);
    assert.equal(isTypingTarget({ tagName: "DIV", isContentEditable: true } as unknown as EventTarget), true);
    assert.equal(isTypingTarget({ tagName: "BUTTON" } as unknown as EventTarget), false);
  });

  it("maps the intent keys and takes Tab", () => {
    const { calls, down } = setup();
    const tab = down("Tab");
    assert.equal(tab.defaultPrevented, true, "no focus traversal");
    for (const code of ["KeyT", "KeyM", "Escape", "KeyF", "KeyR", "Digit1", "Digit2", "Digit3", "Digit4"]) down(code);
    assert.deepEqual(calls, ["inventory", "takeAll", "map", "close", "interact", "reload", "slot0", "slot1", "heal:bandage", "heal:medkit"]);
    down("KeyT", { repeat: true });
    down("KeyR", { ctrlKey: true });
    assert.equal(calls.length, 10, "repeats and browser shortcuts are ignored");
  });

  it("fire latches short clicks, is blocked while a panel is open, and dropBuffered clears latches", () => {
    const { ctl, canvas, win } = setup();
    canvas.fire("pointerdown", pointer());
    win.fire("pointerup", pointer({ type: "pointerup" }));
    assert.equal(ctl.sampleFire(), true, "click shorter than one input still fires");
    assert.equal(ctl.sampleFire(), false);
    assert.deepEqual([ctl.mouseX, ctl.mouseY], [100, 200]);

    canvas.fire("pointerdown", pointer());
    ctl.setFireBlocked(true);
    assert.equal(ctl.sampleFire(), false, "opening a panel releases the trigger");
    canvas.fire("pointerdown", pointer());
    assert.equal(ctl.sampleFire(), false);
    ctl.setFireBlocked(false);

    canvas.fire("pointerdown", pointer());
    win.fire("pointerup", pointer({ type: "pointerup" }));
    win.fire("keydown", key("Space"));
    ctl.dropBuffered();
    assert.equal(ctl.sampleFire(), false);
    assert.equal(ctl.sampleRoll(), false);
  });

  it("a canvas click takes focus from HUD elements; Shift+click does not start a selection", () => {
    const { canvas, doc } = setup();
    doc.activeElement = { tagName: "BUTTON" };
    const e = pointer({ shiftKey: true });
    canvas.fire("pointerdown", e);
    assert.equal(doc.activeElement, canvas);
    assert.equal(e.defaultPrevented, true);
    const plain = pointer();
    canvas.fire("pointerdown", plain);
    assert.equal(plain.defaultPrevented, false);
  });

  it("makes the canvas focusable without putting it in the tab order", () => {
    const { canvas } = setup();
    assert.equal(canvas.tabIndex, -1);
  });

  it("wheel toggles the weapon once per burst", () => {
    const { calls, canvas, setNow } = setup();
    const wheel = (dy: number) => canvas.fire("wheel", { deltaY: dy, preventDefault() {} });
    wheel(10);
    wheel(10);
    setNow(1100);
    wheel(10);
    setNow(1300);
    wheel(0.5);
    wheel(10);
    assert.deepEqual(calls, ["toggleSlot", "toggleSlot"]);
  });

  it("detach removes listeners and releases everything", () => {
    const { ctl, win, canvas, down } = setup();
    down("KeyW");
    down("ShiftLeft");
    down("Space");
    ctl.detach();
    assert.equal(win.listeners.size, 0);
    assert.equal(canvas.listeners.size, 0);
    assert.deepEqual(ctl.movement(), { mx: 0, my: 0 });
    assert.equal(ctl.walkHeld(), false);
    assert.equal(ctl.sampleRoll(), false);
  });
});
