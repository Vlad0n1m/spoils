/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/crosshair.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CROSSHAIR_CURSOR_CLASS, TOUCH_CROSSHAIR, crosshairAlpha, rayToScreenEdge, setCanvasCrosshair, touchCrosshairDistance } from "./crosshair";

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

describe("crosshair", () => {
  it("rayToScreenEdge measures to the inset screen rect", () => {
    assert.ok(near(rayToScreenEdge(500, 300, 0, 1000, 600, 0), 500));
    assert.ok(near(rayToScreenEdge(500, 300, Math.PI, 1000, 600, 0), 500));
    assert.ok(near(rayToScreenEdge(500, 300, Math.PI / 2, 1000, 600, 20), 280));
    assert.ok(near(rayToScreenEdge(500, 300, -Math.PI / 2, 1000, 600, 20), 280));
    // Diagonal: the nearer edge wins (bottom at 300 px down → 300·√2 along the ray).
    assert.ok(near(rayToScreenEdge(500, 300, Math.PI / 4, 1000, 600, 0), 300 * Math.SQRT2));
    assert.equal(rayToScreenEdge(-5, 300, 0, 1000, 600, 0), 0, "outside the rect");
  });

  it("the touch crosshair sits at the weapon range, kept on screen", () => {
    // Range 420 world px at zoom 0.5 = 210 px, the screen allows 500 → 210.
    assert.ok(near(touchCrosshairDistance(420, 0.5, 500, 300, 0, 1000, 600), 210));
    // Sniper range far past the edge → the edge minus the inset.
    assert.ok(near(touchCrosshairDistance(1700, 1, 500, 300, 0, 1000, 600), 500 - TOUCH_CROSSHAIR.EDGE_INSET));
    // No weapon → as far as the screen allows; never closer than MIN_PX.
    assert.ok(near(touchCrosshairDistance(0, 1, 500, 300, Math.PI / 2, 1000, 600), 300 - TOUCH_CROSSHAIR.EDGE_INSET));
    assert.equal(touchCrosshairDistance(10, 1, 500, 300, 0, 1000, 600), TOUCH_CROSSHAIR.MIN_PX);
  });

  it("fades in fast and out slower", () => {
    const up = crosshairAlpha(0, true, 16);
    const down = crosshairAlpha(1, false, 16);
    assert.ok(up > 0 && up < 1);
    assert.ok(1 - down < up, "fading out is slower than fading in");
    let a = 1;
    for (let i = 0; i < 120; i++) a = crosshairAlpha(a, false, 16);
    assert.equal(a, 0, "snaps to 0");
    assert.equal(crosshairAlpha(0.999, true, 16), 1);
  });

  it("toggles the desktop cursor class on the canvas", () => {
    const seen: Array<[string, boolean]> = [];
    const canvas = {
      classList: {
        toggle: (c: string, on?: boolean) => {
          seen.push([c, !!on]);
          return !!on;
        },
      },
    };
    assert.equal(setCanvasCrosshair(canvas, true), true);
    assert.equal(setCanvasCrosshair(canvas, false), false);
    assert.deepEqual(seen, [
      [CROSSHAIR_CURSOR_CLASS, true],
      [CROSSHAIR_CURSOR_CLASS, false],
    ]);
  });
});
