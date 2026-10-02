import assert from "node:assert/strict";
import { test } from "node:test";
import type { Rect } from "../geometry.js";
import { mulberry32 } from "../rng.js";
import { Placement } from "./placement.js";

test("Placement.free matches a brute-force scan (margins, bucket edges, map edges)", () => {
  const size = 8192;
  const p = new Placement(size);
  const all: Rect[] = [];
  const rng = mulberry32(99);
  for (let i = 0; i < 400; i++) {
    const r = { x: Math.floor(rng() * size) - 200, y: Math.floor(rng() * size) - 200, w: 8 + Math.floor(rng() * 900), h: 8 + Math.floor(rng() * 900) };
    if (i % 2 === 0) {
      p.add(r);
      all.push(r);
    }
  }
  for (let i = 0; i < 5000; i++) {
    const r = { x: Math.floor(rng() * size), y: Math.floor(rng() * size), w: 1 + Math.floor(rng() * 300), h: 1 + Math.floor(rng() * 300) };
    const m = Math.floor(rng() * 120);
    const brute = !all.some((t) => r.x - m < t.x + t.w && r.x + r.w + m > t.x && r.y - m < t.y + t.h && r.y + r.h + m > t.y);
    assert.equal(p.free(r, m), brute);
  }
});

test("Placement: touching rects are free with margin 0, blocked with margin 1", () => {
  const p = new Placement(2048);
  p.add({ x: 500, y: 500, w: 100, h: 100 });
  assert.ok(p.free({ x: 600, y: 500, w: 50, h: 50 }, 0));
  assert.ok(!p.free({ x: 600, y: 500, w: 50, h: 50 }, 1));
  assert.ok(!p.free({ x: 510, y: 510, w: 10, h: 10 }, 0));
  // A rect spanning a bucket boundary (512) is found from either side.
  p.add({ x: 1000, y: 1000, w: 40, h: 40 });
  assert.ok(!p.free({ x: 1030, y: 1030, w: 4, h: 4 }, 0));
});
