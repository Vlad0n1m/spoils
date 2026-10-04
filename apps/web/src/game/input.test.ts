/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/input.test.ts
 * DOM-free: the controller takes an InputEnv, events are plain objects passed to its handlers.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ROLL } from "@extract/shared";
import { InputController, TOUCH_WALK_BELOW, isTypingTarget, sampleAim, type InputActions, type InputEnv, type TouchAction } from "./input";

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
  return { clientX: 110, clientY: 220, button: 0, shiftKey: false, type: "pointerdown", pointerType: "mouse", defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
}

function setup(opts: { noToggleMap?: boolean } = {}) {
  const calls: string[] = [];
  const actions: InputActions = {
    interact: () => calls.push("interact"),
    reload: () => calls.push("reload"),
    selectSlot: (s) => calls.push(`slot${s}`),
    toggleSlot: () => calls.push("toggleSlot"),
    heal: (k) => calls.push(`heal:${k}`),
    toggleInventory: () => calls.push("inventory"),
    takeAll: () => calls.push("takeAll"),
    closePanel: () => calls.push("close"),
    toggleMap: opts.noToggleMap ? undefined : () => calls.push("map"),
    toggleFullMap: () => calls.push("fullMap"),
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

  describe("touch", () => {
    it("the move stick is analog, clamped to the unit circle, and part deflection is quiet walk", () => {
      const { ctl, down } = setup();
      ctl.setTouchMove({ x: 0.3, y: -0.2 });
      assert.deepEqual(ctl.movement(), { mx: 0.3, my: -0.2 });
      assert.equal(ctl.walkHeld(), true, "below TOUCH_WALK_BELOW = quiet walk");
      ctl.setTouchMove({ x: 0, y: TOUCH_WALK_BELOW + 0.05 });
      assert.equal(ctl.walkHeld(), false);
      ctl.setTouchMove({ x: 3, y: 4 });
      const m = ctl.movement();
      assert.ok(Math.abs(m.mx - 0.6) < 1e-9 && Math.abs(m.my - 0.8) < 1e-9, "longer than 1 is normalized");
      ctl.setTouchMove({ x: 0, y: 0 });
      assert.equal(ctl.walkHeld(), false, "a centred stick is not walking");
      assert.equal(ctl.touchMoveAngle, null, "inside the facing dead zone");
      ctl.setTouchMove({ x: NaN, y: 1 });
      assert.deepEqual(ctl.movement(), { mx: 0, my: 0 }, "garbage = released");
      // Released: the keys move again; Shift still walks.
      ctl.setTouchMove(null);
      down("KeyD");
      down("ShiftLeft");
      assert.deepEqual(ctl.movement(), { mx: 1, my: 0 });
      assert.equal(ctl.walkHeld(), true);
    });

    it("touchMoveAngle is the move direction past the dead zone", () => {
      const { ctl } = setup();
      assert.equal(ctl.touchMoveAngle, null);
      ctl.setTouchMove({ x: 0, y: 0.5 });
      assert.ok(Math.abs((ctl.touchMoveAngle ?? 0) - Math.PI / 2) < 1e-9);
    });

    it("the aim stick aims, fires only while aiming, and is blocked by an open panel", () => {
      const { ctl } = setup();
      assert.equal(ctl.touchAimAngle, null);
      ctl.setTouchAim(1.25, false);
      assert.equal(ctl.touchAimAngle, 1.25);
      assert.equal(ctl.sampleFire(), false, "aiming without the trigger");
      ctl.setTouchAim(1.25, true);
      assert.equal(ctl.sampleFire(), true);
      assert.equal(ctl.sampleFire(), true, "automatic weapon: the trigger stays held");
      ctl.setTouchAim(null, true);
      assert.equal(ctl.touchAimAngle, null);
      assert.equal(ctl.sampleFire(), false, "no fire without an aim");
      ctl.setTouchAim(0, true);
      ctl.setFireBlocked(true);
      assert.equal(ctl.sampleFire(), false, "panel open: no fire");
      ctl.setFireBlocked(false);
      assert.equal(ctl.sampleFire(), true);
    });

    it("a held fire stick re-presses a semi-auto weapon at its fire interval, with a release in between", () => {
      const { ctl, setNow } = setup();
      ctl.setTouchRepeatMs(280);
      ctl.setTouchAim(0, true);
      const got: boolean[] = [];
      for (let t = 1000; t <= 1600; t += 33) {
        setNow(t);
        got.push(ctl.sampleFire());
      }
      // Presses at 1000, then the first sample ≥ 1280 (1297), then ≥ 1577 (1594).
      const pressedAt = got.flatMap((v, i) => (v ? [1000 + i * 33] : []));
      assert.deepEqual(pressedAt, [1000, 1297, 1594]);
      // Releasing and pressing again fires at once.
      ctl.setTouchAim(0, false);
      setNow(1610);
      assert.equal(ctl.sampleFire(), false);
      ctl.setTouchAim(0, true);
      setNow(1643);
      assert.equal(ctl.sampleFire(), true);
      // Never two pressed samples in a row, even with an interval shorter than a sample.
      ctl.setTouchRepeatMs(1);
      setNow(1676);
      assert.equal(ctl.sampleFire(), false);
      setNow(1709);
      assert.equal(ctl.sampleFire(), true);
    });

    it("buttons take the same paths as the keys", () => {
      const { ctl, calls } = setup();
      const all: TouchAction[] = ["interact", "reload", "swap", "bandage", "medkit", "inventory", "map"];
      for (const a of all) ctl.press(a);
      assert.deepEqual(calls, ["interact", "reload", "toggleSlot", "heal:bandage", "heal:medkit", "inventory", "map"]);
      ctl.press("roll");
      const got = Array.from({ length: ROLL.BUFFER_SAMPLES + 1 }, () => ctl.sampleRoll());
      assert.deepEqual(got, [...Array(ROLL.BUFFER_SAMPLES).fill(true), false], "roll is buffered like Space");
    });

    it("MAP falls back to the full map system when no panel handles M", () => {
      const { ctl, calls } = setup({ noToggleMap: true });
      ctl.press("map");
      assert.deepEqual(calls, ["fullMap"]);
    });

    it("a flick's first shot carries the stick direction, not the previous facing", () => {
      const { ctl } = setup();
      ctl.setTouchRepeatMs(250); // semi-auto: this one press is the whole shot
      // Facing right from the move stick, then one pointermove flicks the aim stick left past FIRE_AT.
      ctl.setTouchMove({ x: 1, y: 0 });
      let aim = sampleAim(0.4, ctl.touchFacing, false);
      assert.equal(aim, 0, "the move stick steers the facing");
      ctl.setTouchAim(Math.PI, true);
      // The renderer's input loop runs before its per-frame aim update: the sample must take the stick now.
      const fire = ctl.sampleFire();
      aim = sampleAim(aim, ctl.touchFacing, false);
      assert.equal(fire, true);
      assert.equal(aim, Math.PI);
      // A panel open: the aim stays frozen; no stick held: the last aim (mouse) stays.
      assert.equal(sampleAim(0.3, ctl.touchFacing, true), 0.3);
      ctl.setTouchAim(null, false);
      ctl.setTouchMove(null);
      assert.equal(ctl.touchFacing, null);
      assert.equal(sampleAim(0.3, ctl.touchFacing, false), 0.3);
    });

    it("finger pointer events on the canvas neither aim nor fire while the sticks are mounted", () => {
      const { ctl, canvas, win } = setup();
      ctl.setTouchSticks(true);
      canvas.fire("pointerdown", pointer({ pointerType: "touch" }));
      win.fire("pointermove", pointer({ pointerType: "touch", type: "pointermove", clientX: 500 }));
      assert.equal(ctl.sampleFire(), false);
      assert.equal(ctl.hasPointer, false);
      assert.equal(canvas.focused, 0);
      // A mouse still works, and a finger lifting does not release the mouse trigger.
      canvas.fire("pointerdown", pointer());
      win.fire("pointerup", pointer({ pointerType: "touch", type: "pointerup" }));
      assert.equal(ctl.sampleFire(), true);
      assert.equal(ctl.sampleFire(), true, "still held");
    });

    it("without the sticks (a touch laptop with a mouse) a finger aims and fires like the mouse", () => {
      const { ctl, canvas, win } = setup();
      canvas.fire("pointerdown", pointer({ pointerType: "touch", clientX: 60, clientY: 70 }));
      assert.equal(ctl.hasPointer, true);
      assert.deepEqual([ctl.mouseX, ctl.mouseY], [50, 50]);
      assert.equal(ctl.sampleFire(), true);
      win.fire("pointerup", pointer({ pointerType: "touch", type: "pointerup" }));
      assert.equal(ctl.sampleFire(), false, "the finger lifted");
    });

    it("blur and detach release the sticks", () => {
      const { ctl, win } = setup();
      ctl.setTouchMove({ x: 1, y: 0 });
      ctl.setTouchAim(0, true);
      win.fire("blur", {});
      assert.deepEqual(ctl.movement(), { mx: 0, my: 0 });
      assert.equal(ctl.touchAimAngle, null);
      assert.equal(ctl.sampleFire(), false);
      ctl.setTouchMove({ x: 1, y: 0 });
      ctl.detach();
      assert.deepEqual(ctl.movement(), { mx: 0, my: 0 });
    });
  });
});
