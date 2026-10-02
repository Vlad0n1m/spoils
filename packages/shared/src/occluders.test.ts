import assert from "node:assert/strict";
import { test } from "node:test";
import { SOLID, buildCollisionIndex, circleIsFree, raycastSolidsDDA, type SolidMask } from "./geometry.js";
import { buildOccluderGrid, pointShadowed, shadowQuads } from "./occluders.js";
import { mulberry32 } from "./rng.js";
import { fixtureMap, type FixtureCircle, type FixtureRect } from "./testing/fixtures.js";

const R = 1000;
const OCT_R = 1 / Math.cos(Math.PI / 8);
const out = new Float32Array(8 * 8192);

/** P inside any of the first n quads (convex, either winding). */
function inQuads(n: number, px: number, py: number): boolean {
  for (let q = 0; q < n; q++) {
    const o = q * 8;
    let pos = 0, neg = 0;
    for (let k = 0; k < 4; k++) {
      const ax = out[o + k * 2]!, ay = out[o + k * 2 + 1]!;
      const bx = out[o + ((k + 1) % 4) * 2]!, by = out[o + ((k + 1) % 4) * 2 + 1]!;
      const c = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
      if (c > 0) pos++;
      else if (c < 0) neg++;
    }
    if (pos === 0 || neg === 0) return true;
  }
  return false;
}

function randomMap(seed: number, withCircles: boolean) {
  const rng = mulberry32(seed);
  const W = 6000;
  const flags: SolidMask[] = [SOLID.ALL, SOLID.MOVE, SOLID.MOVE | SOLID.SIGHT, SOLID.MOVE | SOLID.SHOT];
  const rects: FixtureRect[] = [];
  for (let i = 0; i < 260; i++) {
    const long = rng() < 0.5;
    const a = long ? 100 + Math.floor(rng() * 700) : 24 + Math.floor(rng() * 80);
    const b = long ? 24 : 24 + Math.floor(rng() * 80);
    const v = rng() < 0.5;
    rects.push({ x: 200 + Math.floor(rng() * 5000), y: 200 + Math.floor(rng() * 5000), w: v ? b : a, h: v ? a : b, f: flags[i % flags.length]! });
  }
  const circles: FixtureCircle[] = [];
  if (withCircles) {
    for (let i = 0; i < 200; i++) circles.push({ x: 200 + rng() * 5600, y: 200 + rng() * 5600, r: 10 + rng() * 50, f: flags[i % flags.length]! });
  }
  return fixtureMap(W, W, rects, circles);
}

/**
 * Compares the per-frame shadow quads (what the client darkens) and the pointShadowed oracle with
 * the server's SIGHT raycast, for random eyes and points within R.
 */
function compare(seed: number, withCircles: boolean) {
  const map = randomMap(seed, withCircles);
  const idx = buildCollisionIndex(map, map.width, map.height);
  const grid = buildOccluderGrid(map);
  const sightCircles = map.circles.filter((c) => c.f & SOLID.SIGHT);
  const rng = mulberry32(seed + 1);
  const hiddenBy = (ex: number, ey: number, px: number, py: number) => raycastSolidsDDA(idx, ex, ey, px, py, SOLID.SIGHT) !== Infinity;
  let checked = 0, unexplained = 0, hidden = 0;
  for (let i = 0; i < 6000; i++) {
    const ex = 300 + rng() * 5400, ey = 300 + rng() * 5400;
    if (!circleIsFree(idx, ex, ey, 2, SOLID.SIGHT)) continue;
    const a = rng() * Math.PI * 2, d = 30 + rng() * (R - 40);
    const px = ex + Math.cos(a) * d, py = ey + Math.sin(a) * d;
    // Points inside (or touching) a solid are drawn by the wall sprite, not the fog.
    if (!circleIsFree(idx, px, py, 1.5, SOLID.SIGHT)) continue;
    const truth = hiddenBy(ex, ey, px, py);
    const n = shadowQuads(grid, ex, ey, R, out, 8192);
    const shaded = inQuads(n, px, py);
    const oracle = pointShadowed(grid, ex, ey, px, py, R);
    checked++;
    if (truth) hidden++;
    if (truth === shaded && truth === oracle) continue;
    // Grazing a corner: a sub-pixel perturbation flips the server answer — float32 noise, not a leak.
    const nx = (-Math.sin(a)) * 0.75, ny = Math.cos(a) * 0.75;
    if (hiddenBy(ex, ey, px + nx, py + ny) !== truth || hiddenBy(ex, ey, px - nx, py - ny) !== truth) continue;
    // Octagons circumscribe circles: the client may darken a sliver more (incl. points inside the
    // octagon but outside the circle), never less.
    if (withCircles && !truth) {
      const dx = px - ex, dy = py - ey, L2 = dx * dx + dy * dy;
      const nearOct = sightCircles.some((c) => {
        const t = Math.max(0, Math.min(1, ((c.x - ex) * dx + (c.y - ey) * dy) / L2));
        const dist = Math.hypot(ex + dx * t - c.x, ey + dy * t - c.y);
        return dist <= c.r * OCT_R + 0.5;
      });
      if (nearOct) continue;
    }
    unexplained++;
  }
  return { checked, hidden, unexplained };
}

test("shadow quads and pointShadowed equal the server SIGHT raycast (rect-only map)", () => {
  const r = compare(31, false);
  assert.ok(r.checked > 3000 && r.hidden > 300, JSON.stringify(r));
  assert.equal(r.unexplained, 0, JSON.stringify(r));
});

test("with circles the client hides a superset of what the server hides (octagon slack only)", () => {
  const r = compare(77, true);
  assert.ok(r.checked > 3000 && r.hidden > 300, JSON.stringify(r));
  assert.equal(r.unexplained, 0, JSON.stringify(r));
});

test("back faces only: the wall face you look at is lit, behind it is dark", () => {
  const map = fixtureMap(2000, 2000, [{ x: 900, y: 500, w: 200, h: 24, f: SOLID.ALL }]);
  const grid = buildOccluderGrid(map);
  const n = shadowQuads(grid, 1000, 300, R, out, 64);
  assert.ok(!inQuads(n, 1000, 495), "in front of the face");
  assert.ok(inQuads(n, 1000, 530), "just behind");
  assert.ok(inQuads(n, 1000, 1200), "far behind");
  assert.ok(!inQuads(n, 1600, 1200), "outside the shadow wedge");
});

test("hugging a long wall still darkens everything behind it (wide back edges are split)", () => {
  const map = fixtureMap(4000, 4000, [{ x: 1000, y: 2000, w: 2000, h: 24, f: SOLID.ALL }]);
  const grid = buildOccluderGrid(map);
  const ey = 2000 - 25; // player radius 24 + 1 px from the face
  const n = shadowQuads(grid, 2000, ey, R, out, 64);
  for (const [px, py] of [[2000, 2600], [2000, 2970], [1500, 2800], [2600, 2700]] as const) {
    assert.ok(inQuads(n, px, py), `(${px},${py}) behind the wall must be dark`);
  }
  assert.ok(!inQuads(n, 2000, 1500), "the open side stays lit");
});

test("non-SIGHT solids cast no shadow; maxQuads bounds the output", () => {
  const map = fixtureMap(2000, 2000, [
    { x: 900, y: 500, w: 200, h: 24, f: SOLID.MOVE }, // window
    { x: 900, y: 700, w: 200, h: 24, f: SOLID.MOVE | SOLID.SHOT }, // sandbags
  ], [{ x: 500, y: 500, r: 30, f: SOLID.MOVE | SOLID.SHOT }]);
  const grid = buildOccluderGrid(map);
  assert.equal(grid.count, 0);
  assert.equal(shadowQuads(grid, 1000, 300, R, out, 64), 0);
  const dense = buildOccluderGrid(randomMap(5, true));
  const all = shadowQuads(dense, 3000, 3000, R, out, 8192);
  assert.ok(all > 3);
  assert.equal(shadowQuads(dense, 3000, 3000, R, out, 3), 3);
  // A too-small output buffer caps the count too (never writes out of bounds).
  assert.equal(shadowQuads(dense, 3000, 3000, R, new Float32Array(8 * 2), 100), 2);
});
