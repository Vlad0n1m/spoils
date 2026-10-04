/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/touch-controls.test.ts
 * Pure parts only: stick maths and the button layout around the HUD.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AIM_FROM,
  FIRE_AT,
  STICK_RADIUS,
  TOUCH_BUTTONS,
  TOUCH_MIN_SIZE,
  aimFromStick,
  hudReservedRects,
  layoutTouchButtons,
  rectsOverlap,
  stickVector,
} from "./touch-controls";

/** Landscape phones / tablets in CSS px (the Seeker is ~915 × 412). */
const SCREENS: Array<[number, number]> = [
  [915, 412],
  [872, 392],
  [851, 393],
  [800, 360],
  [780, 360],
  [740, 360],
  [1024, 600],
  [1280, 800],
];

describe("touch sticks", () => {
  it("aims from AIM_FROM and fires from FIRE_AT", () => {
    assert.deepEqual(aimFromStick(0, 0), { angle: null, fire: false });
    assert.deepEqual(aimFromStick(AIM_FROM * 0.9, 0), { angle: null, fire: false });
    const a = aimFromStick(0, AIM_FROM + 0.01);
    assert.ok(a.angle !== null && Math.abs(a.angle - Math.PI / 2) < 1e-9);
    assert.equal(a.fire, false);
    assert.equal(aimFromStick(-(FIRE_AT + 0.01), 0).fire, true);
    assert.deepEqual(aimFromStick(NaN, 0), { angle: null, fire: false });
  });

  it("clamps the finger offset to the stick radius", () => {
    assert.deepEqual(stickVector(0, 0), { x: 0, y: 0 });
    assert.deepEqual(stickVector(STICK_RADIUS / 2, 0), { x: 0.5, y: 0 });
    const v = stickVector(STICK_RADIUS * 3, STICK_RADIUS * 4);
    assert.ok(Math.abs(v.x - 0.6) < 1e-9 && Math.abs(v.y - 0.8) < 1e-9);
  });
});

describe("touch button layout", () => {
  for (const [w, h] of SCREENS) {
    it(`${w}×${h}: every button placed, on its side, clear of the HUD and of each other`, () => {
      const rects = layoutTouchButtons(w, h);
      const hud = hudReservedRects(w, h);
      assert.equal(rects.size, TOUCH_BUTTONS.length, `placed: ${[...rects.keys()].join(",")}`);
      const placed = [...rects.entries()];
      for (const [id, r] of placed) {
        const spec = TOUCH_BUTTONS.find((b) => b.id === id)!;
        assert.ok(r.w >= TOUCH_MIN_SIZE && r.w === r.h, `${id} size ${r.w}`);
        assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= w && r.y + r.h <= h, `${id} on screen`);
        if (spec.side === "right") assert.ok(r.x >= w / 2, `${id} right half`);
        else assert.ok(r.x + r.w <= w / 2, `${id} left half`);
        for (const a of hud) {
          if (a.soft) continue;
          assert.ok(!rectsOverlap(r, a), `${id} covers HUD ${a.id}`);
        }
      }
      for (let i = 0; i < placed.length; i++) {
        for (let j = i + 1; j < placed.length; j++) {
          assert.ok(!rectsOverlap(placed[i]![1], placed[j]![1]), `${placed[i]![0]} overlaps ${placed[j]![0]}`);
        }
      }
    });
  }

  it("Seeker-class screens: full size, and the kill feed, hint and extract ring stay clear too", () => {
    for (const [w, h] of [[915, 412], [872, 392], [851, 393], [1024, 600]] as const) {
      const rects = layoutTouchButtons(w, h);
      const hud = hudReservedRects(w, h);
      for (const spec of TOUCH_BUTTONS) {
        const r = rects.get(spec.id)!;
        if (w === 915) assert.equal(r.w, spec.size, `${spec.id} at its preferred size`);
        for (const a of hud) assert.ok(!rectsOverlap(r, a), `${w}×${h}: ${spec.id} covers ${a.id}`);
      }
    }
  });

  it("the wipe / boss stack at the top centre is never covered", () => {
    for (const [w, h] of SCREENS) {
      const top = hudReservedRects(w, h).find((a) => a.id === "top")!;
      assert.ok(top.w >= Math.min(w - 24, 400) && top.h >= 200, "reserves the timer, wipe banner and boss toast");
      for (const r of layoutTouchButtons(w, h).values()) assert.ok(!rectsOverlap(r, top));
    }
  });

  it("an empty or zero-size mount places nothing", () => {
    assert.equal(layoutTouchButtons(0, 400).size, 0);
    assert.equal(layoutTouchButtons(900, NaN).size, 0);
  });
});
