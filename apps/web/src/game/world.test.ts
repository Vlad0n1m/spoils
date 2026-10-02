/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/world.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateMap } from "@extract/shared";
import { dirtBakeRes, dirtLobes, lobesBounds } from "./world";

describe("dirt patches", () => {
  it("are deterministic and stay within the old mask's reach", () => {
    const d = { x: 1234, y: 2345, r: 160 };
    assert.deepEqual(dirtLobes(d), dirtLobes({ ...d }));
    const lobes = dirtLobes(d);
    assert.equal(lobes.length, 6);
    for (const l of lobes) assert.ok(Math.hypot(l.x - d.x, l.y - d.y) + l.r <= d.r * 1.24);
  });

  it("bounds cover every lobe", () => {
    const lobes = dirtLobes({ x: 500.5, y: 700.2, r: 90 });
    const b = lobesBounds(lobes);
    for (const l of lobes) {
      assert.ok(l.x - l.r >= b.x && l.x + l.r <= b.x + b.w);
      assert.ok(l.y - l.r >= b.y && l.y + l.r <= b.y + b.h);
    }
  });

  it("bakes today's map at full resolution and caps a much larger map", () => {
    const map = generateMap(4242);
    const bounds = map.dirt.map((d) => lobesBounds(dirtLobes(d)));
    assert.equal(dirtBakeRes(bounds), 1);
    const px = bounds.reduce((s, b) => s + b.w * b.h, 0);
    assert.ok(px < 8_000_000, `today's dirt bakes ${px} px`);
    // 25× the patches (a Tarkov-size map before chunked baking lands).
    const big = Array.from({ length: 25 }, () => bounds).flat();
    const res = dirtBakeRes(big);
    assert.ok(res < 1 && res >= 0.25);
    const bigPx = big.reduce((s, b) => s + b.w * res * b.h * res, 0);
    assert.ok(bigPx <= 16_000_001);
  });
});
