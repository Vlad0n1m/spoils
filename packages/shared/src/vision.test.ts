import assert from "node:assert/strict";
import { test } from "node:test";
import { PLAYER } from "./constants.js";
import { SOLID, buildCollisionIndex } from "./geometry.js";
import { mulberry32 } from "./rng.js";
import { fixtureMap, type FixtureRect } from "./testing/fixtures.js";
import {
  VISION,
  aoiCell,
  buildBushIndex,
  bushIndexAt,
  canSee,
  coneAlpha,
  visionRangeMult,
  type VisionEnv,
  type VisionTarget,
  type VisionViewer,
} from "./vision.js";

// Fog memo §5 test plan, on hand-built maps (no generator dependency).
const envOf = (rects: FixtureRect[], rangeMult = 1, rangeCap?: number): VisionEnv => {
  const m = fixtureMap(4000, 4000, rects);
  return { idx: buildCollisionIndex(m, m.width, m.height), rangeMult, rangeCap };
};
const open = envOf([]);
const V = (x: number, y: number, aim = 0, vx = 0, vy = 0): VisionViewer => ({ x, y, aim, vx, vy });
const T = (x: number, y: number, o: Partial<VisionTarget> = {}): VisionTarget => ({
  x, y, inBush: false, stillMs: 0, sinceShotMs: Infinity, ...o,
});

test("a wall between viewer and target blocks; a door gap lets the target be seen", () => {
  const wall = envOf([{ x: 1500, y: 1000, w: 24, h: 2000, f: SOLID.ALL }]);
  assert.equal(canSee(wall, V(1200, 2000), T(1800, 2000)), false);
  // Same wall with a 96 px door gap centred on the line of sight.
  const door = envOf([
    { x: 1500, y: 1000, w: 24, h: 952, f: SOLID.ALL },
    { x: 1500, y: 2048, w: 24, h: 952, f: SOLID.ALL },
  ]);
  assert.equal(canSee(door, V(1200, 2000), T(1800, 2000)), true);
  assert.equal(canSee(open, V(1200, 2000), T(1800, 2000)), true);
});

test("SIGHT mask: windows and sandbags are see-through, fences block", () => {
  const mk = (f: number) => envOf([{ x: 1500, y: 1000, w: 24, h: 2000, f }]);
  assert.equal(canSee(mk(SOLID.WINDOW), V(1200, 2000), T(1800, 2000)), true, "window");
  assert.equal(canSee(mk(SOLID.MOVE | SOLID.SHOT), V(1200, 2000), T(1800, 2000)), true, "sandbags");
  assert.equal(canSee(mk(SOLID.MOVE | SOLID.SIGHT), V(1200, 2000), T(1800, 2000)), false, "fence");
});

test("cone and awareness: a target at 170° is seen only inside SERVER_AWARE_R and not through walls", () => {
  const a = (170 * Math.PI) / 180;
  const at = (d: number) => T(2000 + Math.cos(a) * d, 2000 + Math.sin(a) * d);
  assert.equal(canSee(open, V(2000, 2000, 0), at(300)), false);
  assert.equal(canSee(open, V(2000, 2000, 0), at(100)), true);
  const wall = envOf([{ x: 1940, y: 1900, w: 10, h: 200, f: SOLID.ALL }]);
  assert.equal(canSee(wall, V(2000, 2000, 0), at(100)), false);
  // The server cone is 105° per side: 100° is in, 110° is out.
  const side = (deg: number) => T(2000 + Math.cos((deg * Math.PI) / 180) * 600, 2000 + Math.sin((deg * Math.PI) / 180) * 600);
  assert.equal(canSee(open, V(2000, 2000, 0), side(100)), true);
  assert.equal(canSee(open, V(2000, 2000, 0), side(-100)), true);
  assert.equal(canSee(open, V(2000, 2000, 0), side(110)), false);
});

test("range: 1000 (+ target radius) is seen, 1030 is not; env multiplier and muzzle flash", () => {
  assert.equal(canSee(open, V(1000, 2000), T(2000, 2000)), true);
  assert.equal(canSee(open, V(1000, 2000), T(2030, 2000)), false);
  const fog = { ...open, rangeMult: 0.55 };
  assert.equal(canSee(fog, V(1000, 2000), T(1600, 2000)), false);
  assert.equal(canSee(fog, V(1000, 2000), T(1600, 2000, { sinceShotMs: 200 })), true, "flash ignores weather");
  assert.equal(canSee(fog, V(1000, 2000), T(1600, 2000, { sinceShotMs: 300 })), false, "flash is over");
  // NPCs: the calm sight cap hides a quiet target beyond it, but a muzzle flash is seen to the full
  // VISION.RANGE (v5 review fix: no shooting NPCs from beyond their cap without being seen back).
  const npc = { ...open, rangeCap: 800 };
  assert.equal(canSee(npc, V(1000, 2000), T(1900, 2000)), false);
  assert.equal(canSee(npc, V(1000, 2000), T(1800, 2000)), true);
  assert.equal(canSee(npc, V(1000, 2000), T(1900, 2000, { sinceShotMs: 0 })), true, "flash beats the NPC cap");
  assert.equal(canSee(npc, V(1000, 2000), T(2030, 2000, { sinceShotMs: 0 })), false, "never beyond VISION.RANGE");
  assert.equal(canSee({ ...npc, rangeMult: 0.55 }, V(1000, 2000), T(1900, 2000, { sinceShotMs: 100 })), true);
});

test("visionRangeMult clamps env.vis to [MIN_RANGE_MULT, 1]", () => {
  assert.equal(visionRangeMult(0.1), VISION.MIN_RANGE_MULT);
  assert.equal(visionRangeMult(1.4), 1);
  assert.equal(visionRangeMult(0.7), 0.7);
});

test("bushes: still → hidden beyond 160, moving → half range, a recent shot reveals", () => {
  const still = (d: number) => T(1000 + d, 2000, { inBush: true, stillMs: 500 });
  assert.equal(canSee(open, V(1000, 2000), still(200)), false);
  assert.equal(canSee(open, V(1000, 2000), still(150)), true);
  const moving = (d: number) => T(1000 + d, 2000, { inBush: true, stillMs: 100 });
  assert.equal(canSee(open, V(1000, 2000), moving(450)), true);
  assert.equal(canSee(open, V(1000, 2000), moving(550)), false);
  assert.equal(canSee(open, V(1000, 2000), T(1900, 2000, { inBush: true, stillMs: 5000, sinceShotMs: 1000 })), true);
  assert.equal(canSee(open, V(1000, 2000), T(1900, 2000, { inBush: true, stillMs: 5000, sinceShotMs: 2000 })), false);
});

test("peek: the lead eye along the viewer's velocity sees around a corner first", () => {
  // Wall below-left of the viewer; the target hides behind its right end from the centre eye.
  const env = envOf([{ x: 1500, y: 2100, w: 550, h: 20, f: SOLID.ALL }]);
  const tgt = T(2090, 2400);
  assert.equal(canSee(env, V(2000, 2000, Math.PI / 2), tgt), false, "standing still: hidden");
  assert.equal(canSee(env, V(2000, 2000, Math.PI / 2, 300, 0), tgt), true, "moving right: the lead eye peeks");
  assert.equal(canSee(env, V(2000, 2000, Math.PI / 2, -300, 0), tgt), false, "moving away: still hidden");
});

test("side rays: a target half behind a crate edge is still seen", () => {
  const crate = envOf([{ x: 1250, y: 1990, w: 20, h: 50, f: SOLID.ALL }]);
  assert.equal(canSee(crate, V(1000, 2000), T(1500, 2000)), true);
  const full = envOf([{ x: 1250, y: 1900, w: 20, h: 200, f: SOLID.ALL }]);
  assert.equal(canSee(full, V(1000, 2000), T(1500, 2000)), false);
});

test("canSee is symmetric in the open within the cone and never sees beyond range (fuzz)", () => {
  const rng = mulberry32(3);
  for (let i = 0; i < 2000; i++) {
    const vx = 500 + rng() * 3000, vy = 500 + rng() * 3000;
    const tx = 500 + rng() * 3000, ty = 500 + rng() * 3000;
    const d = Math.hypot(tx - vx, ty - vy);
    const seen = canSee(open, V(vx, vy, Math.atan2(ty - vy, tx - vx)), T(tx, ty));
    assert.equal(seen, d <= VISION.RANGE + PLAYER.RADIUS);
  }
});

test("bushIndexAt: 0.9 r rule, lowest index on overlap, grid-cell borders", () => {
  const bushes = [
    { x: 510, y: 510, r: 100 }, // straddles the 512 px cell border
    { x: 560, y: 510, r: 100 },
    { x: 3000, y: 3000, r: 40 },
  ];
  const bi = buildBushIndex(fixtureMap(4000, 4000, [], [], bushes).bushes, 4000, 4000);
  assert.equal(bushIndexAt(bi, 520, 515), 0, "inside both: lowest index wins");
  assert.equal(bushIndexAt(bi, 640, 510), 1, "only inside the second (crosses into the next cell)");
  assert.equal(bushIndexAt(bi, 510, 510 - 95), -1, "inside r but outside 0.9 r of both");
  assert.equal(bushIndexAt(bi, 3000, 3035), 2, "small bush far from the others");
  assert.equal(bushIndexAt(bi, 3000, 3037), -1);
  assert.equal(bushIndexAt(bi, 100, 100), -1);
  // Matches a linear scan everywhere.
  const rng = mulberry32(9);
  for (let i = 0; i < 2000; i++) {
    const x = rng() * 4000, y = rng() * 4000;
    const lin = bushes.findIndex((b) => (x - b.x) ** 2 + (y - b.y) ** 2 < (b.r * VISION.BUSH_INSIDE_FRAC) ** 2);
    assert.equal(bushIndexAt(bi, x, y), lin);
  }
});

test("coneAlpha: full in the cone, fades at the cone edge and range, awareness behind", () => {
  const R = VISION.RANGE;
  assert.equal(coneAlpha(0, 500, 0, R), 1);
  assert.equal(coneAlpha(0, -500, 0, R), 0, "behind, beyond awareness");
  assert.equal(coneAlpha(0, -50, 0, R), 1, "behind, inside awareness");
  const fadeMid = coneAlpha(0, -(VISION.AWARE_R + VISION.AWARE_FADE / 2), 0, R);
  assert.ok(Math.abs(fadeMid - 0.5) < 1e-9);
  const at = (deg: number) => coneAlpha(0, Math.cos((deg * Math.PI) / 180) * 400, Math.sin((deg * Math.PI) / 180) * 400, R);
  assert.equal(at(VISION.CONE_HALF_DEG - VISION.CONE_FADE_DEG - 1), 1);
  assert.ok(Math.abs(at(VISION.CONE_HALF_DEG - VISION.CONE_FADE_DEG / 2) - 0.5) < 1e-9);
  assert.equal(at(VISION.CONE_HALF_DEG + 1), 0);
  assert.ok(Math.abs(at(-(VISION.CONE_HALF_DEG - VISION.CONE_FADE_DEG / 2)) - 0.5) < 1e-9, "symmetric");
  assert.ok(Math.abs(coneAlpha(0, 0.9 * R, 0, R) - 0.5) < 1e-9, "radial fade from 0.8 R");
  assert.equal(coneAlpha(0, R + 1, 0, R), 0);
  // Aim wrap-around: aim ≈ π, target at angle ≈ -π is straight ahead.
  assert.equal(coneAlpha(Math.PI - 0.01, -500, -1, R), 1);
  // The client never draws what the server cone (105°) cuts: client cone ⊂ server cone.
  assert.ok(VISION.CONE_HALF_DEG < VISION.SERVER_CONE_HALF_DEG && VISION.AWARE_R + VISION.AWARE_FADE < VISION.SERVER_AWARE_R);
});

test("aoiCell buckets by AOI_CELL", () => {
  assert.deepEqual(aoiCell(0, 0), { cx: 0, cy: 0 });
  assert.deepEqual(aoiCell(VISION.AOI_CELL, 2 * VISION.AOI_CELL - 1), { cx: 1, cy: 1 });
});
