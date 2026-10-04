/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/hooks/use-item-drag.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DRAG_THRESHOLD_PX,
  canStartDrag,
  isTouchContextMenu,
  parseDropTarget,
  passedThreshold,
  trackPointerDrag,
  type DragEventTarget,
} from "./use-item-drag";

describe("use-item-drag helpers", () => {
  it("parses data-drop values", () => {
    assert.deepEqual(parseDropTarget("self:w1"), { kind: "self", key: "w1" });
    assert.deepEqual(parseDropTarget("ground"), { kind: "ground" });
    assert.deepEqual(parseDropTarget("loot"), { kind: "loot" });
    assert.equal(parseDropTarget("self:"), null);
    assert.equal(parseDropTarget(undefined), null);
    assert.equal(parseDropTarget("bogus"), null);
  });
  it("a small wobble is a click, not a drag", () => {
    assert.equal(passedThreshold(3, 3), false);
    assert.equal(passedThreshold(DRAG_THRESHOLD_PX, 0), true);
  });
  it("a touch long press is not a right-click (it must not drop the item)", () => {
    assert.equal(isTouchContextMenu({ pointerType: "touch" }, null), true, "Chrome: contextmenu is a PointerEvent");
    assert.equal(isTouchContextMenu({}, "touch"), true, "other browsers: the press before it was a finger");
    assert.equal(isTouchContextMenu({ pointerType: "mouse" }, "mouse"), false);
    assert.equal(isTouchContextMenu({}, "pen"), false, "a pen's barrel button still right-clicks");
    assert.equal(isTouchContextMenu({}, null), false, "keyboard context menu key");
  });
});

type Fn = (e: object) => void;
class FakeWindow implements DragEventTarget {
  listeners = new Map<string, Set<Fn>>();
  addEventListener(type: string, fn: Fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: Fn) {
    this.listeners.get(type)?.delete(fn);
  }
  fire(type: string, e: object) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(e);
  }
  get count() {
    let n = 0;
    for (const s of this.listeners.values()) n += s.size;
    return n;
  }
}

const ptr = (pointerId: number, clientX: number, clientY: number) => ({ pointerId, clientX, clientY, preventDefault() {} });

function track(originId = 2) {
  const win = new FakeWindow();
  const log: string[] = [];
  const abort = trackPointerDrag(win, ptr(originId, 100, 100), {
    move: (x, y) => log.push(`move ${x},${y}`),
    drop: (x, y) => log.push(`drop ${x},${y}`),
    cancel: () => log.push("cancel"),
    end: () => log.push("end"),
  });
  return { win, log, abort };
}

describe("trackPointerDrag (touch: a thumb held on a stick)", () => {
  it("any finger may start a drag, primary or not; only the left mouse button", () => {
    assert.equal(canStartDrag({ button: 0 }), true, "a second finger (isPrimary false) still drags");
    assert.equal(canStartDrag({ button: 2 }), false);
  });

  it("follows only the pointer that pressed the tile", () => {
    const { win, log } = track(2);
    // Pointer 1 is the thumb on the move stick: it moves a lot and even lifts.
    win.fire("pointermove", ptr(1, 400, 400));
    win.fire("pointerup", ptr(1, 400, 400));
    win.fire("pointercancel", ptr(1, 400, 400));
    assert.deepEqual(log, [], "the stick finger neither moves, drops nor cancels the drag");
    win.fire("pointermove", ptr(2, 100 + DRAG_THRESHOLD_PX, 100));
    win.fire("pointermove", ptr(2, 150, 120));
    win.fire("pointerup", ptr(2, 160, 130));
    assert.deepEqual(log, [`move ${100 + DRAG_THRESHOLD_PX},100`, "move 150,120", "end", "drop 160,130"]);
    assert.equal(win.count, 0, "listeners removed");
  });

  it("a press without movement is a click: nothing but end", () => {
    const { win, log } = track();
    win.fire("pointermove", ptr(2, 102, 101));
    win.fire("pointerup", ptr(2, 102, 101));
    assert.deepEqual(log, ["end"]);
    assert.equal(win.count, 0);
  });

  it("its own pointercancel, Escape and abort() cancel a started drag once", () => {
    const a = track();
    a.win.fire("pointermove", ptr(2, 140, 100));
    a.win.fire("pointercancel", ptr(2, 140, 100));
    a.abort();
    assert.deepEqual(a.log, ["move 140,100", "end", "cancel"]);

    const b = track();
    b.win.fire("pointermove", ptr(2, 140, 100));
    let stopped = false;
    b.win.fire("keydown", { code: "Escape", stopPropagation: () => (stopped = true) });
    assert.deepEqual(b.log, ["move 140,100", "end", "cancel"]);
    assert.equal(stopped, true);

    const c = track();
    c.abort();
    assert.deepEqual(c.log, ["end"], "abort before the threshold: no cancel");
    assert.equal(c.win.count, 0);
  });
});
