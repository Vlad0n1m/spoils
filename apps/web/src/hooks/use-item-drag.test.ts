/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/hooks/use-item-drag.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DRAG_THRESHOLD_PX, parseDropTarget, passedThreshold } from "./use-item-drag";

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
});
