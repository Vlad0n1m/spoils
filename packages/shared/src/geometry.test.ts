import assert from "node:assert/strict";
import { test } from "node:test";
import { PLAYER } from "./constants.js";
import {
  SOLID,
  buildCollisionIndex,
  circleIsFree,
  countOccluders,
  forEachSolidNear,
  hasLineOfSight,
  leaveVault,
  moveCircle,
  raycastSolids,
  resolveCircle,
  raycastSolidsDDA,
  segmentCircleT,
  segmentRectT,
  type Circle,
  type Rect,
  type SolidMask,
} from "./geometry.js";
import { mulberry32 } from "./rng.js";

/**
 * Hand-built dense map with every flag combination the generator uses (walls ALL, windows MOVE|VAULT,
 * sandbags MOVE|SHOT, fences MOVE|SIGHT, water MOVE), so mask handling is exercised without
 * depending on the map generator.
 */
const W = 8192;
const FLAGS: SolidMask[] = [SOLID.ALL, SOLID.MOVE, SOLID.WINDOW, SOLID.MOVE | SOLID.SHOT, SOLID.MOVE | SOLID.SIGHT, SOLID.SIGHT];
function syntheticMap(seed: number) {
  const rng = mulberry32(seed);
  const rects: Array<Rect & { f: SolidMask }> = [];
  const circles: Array<Circle & { f: SolidMask }> = [];
  for (let i = 0; i < 900; i++) {
    const long = rng() < 0.4;
    const w = long ? 24 + Math.floor(rng() * 600) : 20 + Math.floor(rng() * 90);
    const h = long ? 24 : 20 + Math.floor(rng() * 90);
    const vertical = rng() < 0.5;
    rects.push({
      x: Math.floor(rng() * (W - 700)), y: Math.floor(rng() * (W - 700)),
      w: vertical ? h : w, h: vertical ? w : h, f: FLAGS[Math.floor(rng() * FLAGS.length)]!,
    });
  }
  // Cell-aligned rects: edges exactly on 256 px borders are the classic DDA failure.
  for (let i = 0; i < 60; i++) {
    rects.push({ x: 256 * (1 + Math.floor(rng() * 28)), y: 256 * (1 + Math.floor(rng() * 28)), w: 256, h: 24, f: SOLID.ALL });
  }
  for (let i = 0; i < 700; i++) {
    circles.push({ x: rng() * W, y: rng() * W, r: 8 + rng() * 60, f: FLAGS[Math.floor(rng() * FLAGS.length)]! });
  }
  return { rects, circles };
}

const solids = syntheticMap(2026);
const idx = buildCollisionIndex(solids, W, W);

/** Brute force over every solid: the reference both raycasts must reproduce. */
function bruteRay(x0: number, y0: number, x1: number, y1: number, mask: SolidMask): number {
  let best = Infinity;
  for (const r of solids.rects) if (r.f & mask) best = Math.min(best, segmentRectT(x0, y0, x1 - x0, y1 - y0, r));
  for (const c of solids.circles) if (c.f & mask) best = Math.min(best, segmentCircleT(x0, y0, x1 - x0, y1 - y0, c.x, c.y, c.r));
  return best;
}

const same = (a: number, b: number) => a === b || Math.abs(a - b) < 1e-9;

test("raycastSolidsDDA agrees with raycastSolids and brute force over 20k random rays, every mask", () => {
  const rng = mulberry32(7);
  const masks = [SOLID.SIGHT, SOLID.SHOT, SOLID.MOVE, SOLID.ALL];
  let mismatches = 0, hits = 0;
  for (let i = 0; i < 20_000; i++) {
    const x0 = rng() * W, y0 = rng() * W;
    const a = rng() * Math.PI * 2, len = rng() * 1500;
    const x1 = Math.min(W - 1e-6, Math.max(0, x0 + Math.cos(a) * len));
    const y1 = Math.min(W - 1e-6, Math.max(0, y0 + Math.sin(a) * len));
    const mask = masks[i % masks.length]!;
    const tb = raycastSolids(idx, x0, y0, x1, y1, mask);
    const td = raycastSolidsDDA(idx, x0, y0, x1, y1, mask);
    const tr = bruteRay(x0, y0, x1, y1, mask);
    if (!same(tb, td) || !same(td, tr)) mismatches++;
    if (td !== Infinity) hits++;
  }
  assert.equal(mismatches, 0);
  assert.ok(hits > 3000 && hits < 18_000, `the map is neither empty nor solid (${hits} hits)`);
});

test("DDA: axis-aligned rays, rays on cell borders, zero-length and reversed rays", () => {
  const rng = mulberry32(11);
  let mismatches = 0;
  for (let i = 0; i < 4000; i++) {
    const mask = [SOLID.SIGHT, SOLID.SHOT, SOLID.ALL][i % 3]!;
    // Start exactly on a cell border (x, y or both) half the time.
    const onX = i % 2 === 0, onY = i % 4 < 2;
    const x0 = onX ? 256 * Math.floor(1 + rng() * 30) : rng() * W;
    const y0 = onY ? 256 * Math.floor(1 + rng() * 30) : rng() * W;
    const len = rng() * 1200;
    const dir = i % 5; // 0 +x, 1 -x, 2 +y, 3 -y, 4 exact diagonal through corners
    const x1 = Math.max(0, Math.min(W - 1, dir === 0 ? x0 + len : dir === 1 ? x0 - len : dir === 4 ? x0 + len : x0));
    const y1 = Math.max(0, Math.min(W - 1, dir === 2 ? y0 + len : dir === 3 ? y0 - len : dir === 4 ? y0 + (x1 - x0) : y0));
    for (const [a0, b0, a1, b1] of [[x0, y0, x1, y1], [x1, y1, x0, y0], [x0, y0, x0, y0]] as const) {
      const td = raycastSolidsDDA(idx, a0, b0, a1, b1, mask);
      if (!same(td, bruteRay(a0, b0, a1, b1, mask)) || !same(td, raycastSolids(idx, a0, b0, a1, b1, mask))) mismatches++;
    }
  }
  assert.equal(mismatches, 0);
});

test("masks: windows block movement only, sandbags block bullets, fences block sight", () => {
  assert.equal(SOLID.WINDOW, SOLID.MOVE | SOLID.VAULT);
  assert.equal(SOLID.ALL & SOLID.VAULT, 0, "VAULT is an exemption, not part of ALL");
  const m = buildCollisionIndex(
    {
      rects: [
        { x: 100, y: 0, w: 10, h: 200, f: SOLID.WINDOW }, // window
        { x: 300, y: 0, w: 10, h: 200, f: SOLID.MOVE | SOLID.SIGHT }, // wooden fence
        { x: 500, y: 0, w: 10, h: 200, f: SOLID.MOVE | SOLID.SHOT }, // sandbags
      ],
      circles: [],
    },
    1000, 1000,
  );
  assert.equal(raycastSolids(m, 0, 100, 200, 100), Infinity, "bullets pass the window");
  assert.ok(hasLineOfSight(m, 0, 100, 200, 100), "and you see through it");
  assert.equal(circleIsFree(m, 105, 100, 10), false, "but cannot walk into it");
  assert.equal(raycastSolids(m, 200, 100, 400, 100), Infinity, "wallbang through the fence");
  assert.equal(hasLineOfSight(m, 200, 100, 400, 100), false);
  assert.ok(raycastSolids(m, 400, 100, 600, 100) < 1, "sandbags stop bullets");
  assert.ok(hasLineOfSight(m, 400, 100, 600, 100), "but not sight");
  assert.ok(raycastSolidsDDA(m, 400, 100, 600, 100, SOLID.SHOT) < 1);
  // Legacy solids without `f` block everything.
  const legacy = buildCollisionIndex({ rects: [{ x: 100, y: 0, w: 10, h: 200 }], circles: [{ x: 300, y: 100, r: 20 }] }, 1000, 1000);
  assert.ok(raycastSolids(legacy, 0, 100, 200, 100, SOLID.SIGHT) < 1);
  assert.ok(raycastSolidsDDA(legacy, 200, 100, 400, 100, SOLID.MOVE) < 1);
});

test("forEachSolidNear visits each matching solid once and honours early stop", () => {
  const m = buildCollisionIndex(
    {
      rects: [{ x: 0, y: 0, w: 900, h: 20, f: SOLID.ALL }, { x: 50, y: 50, w: 10, h: 10, f: SOLID.MOVE }],
      circles: [{ x: 100, y: 100, r: 300, f: SOLID.SIGHT }],
    },
    1024, 1024, 128,
  );
  const seen: string[] = [];
  forEachSolidNear(m, 0, 0, 1000, 1000, SOLID.SIGHT, (r) => void seen.push(`r${r.x}`), (c) => void seen.push(`c${c.r}`));
  assert.deepEqual(seen.sort(), ["c300", "r0"], "spanning solids visited once, MOVE-only skipped");
  let n = 0;
  forEachSolidNear(m, 0, 0, 1000, 1000, SOLID.ALL, () => ++n > 0, () => ++n > 0);
  assert.equal(n, 1);
});

test("moveCircle slides along MOVE solids and never tunnels through thin walls", () => {
  const m = buildCollisionIndex(
    { rects: [{ x: 500, y: 0, w: 8, h: 1000, f: SOLID.MOVE }, { x: 700, y: 0, w: 8, h: 1000, f: SOLID.SIGHT }], circles: [] },
    1000, 1000,
  );
  // A 400 px jump into an 8 px wall stops at its face.
  const p = moveCircle(m, 400, 300, PLAYER.RADIUS, 400, 0);
  assert.ok(Math.abs(p.x - (500 - PLAYER.RADIUS)) < 1e-6, String(p.x));
  // Sliding: diagonal movement against the wall keeps the tangential component.
  const s = moveCircle(m, 500 - PLAYER.RADIUS, 300, PLAYER.RADIUS, 10, 10);
  assert.ok(Math.abs(s.y - 310) < 1e-6 && s.x <= 500 - PLAYER.RADIUS + 1e-6);
  // SIGHT-only solids do not block movement.
  const q = moveCircle(m, 650, 300, PLAYER.RADIUS, 100, 0);
  assert.ok(Math.abs(q.x - 750) < 1e-9);
});

test("countOccluders counts rect walls crossed, capped at max", () => {
  const walls = buildCollisionIndex(
    { rects: [100, 300, 500, 700].map((x) => ({ x, y: 0, w: 20, h: 400, f: SOLID.ALL })), circles: [{ x: 50, y: 200, r: 30, f: SOLID.ALL }] },
    1000, 1000,
  );
  assert.equal(countOccluders(walls, 0, 200, 90, 200), 0, "circles never count (walls-only rule)");
  assert.equal(countOccluders(walls, 0, 200, 200, 200), 1);
  assert.equal(countOccluders(walls, 0, 200, 400, 200), 2);
  assert.equal(countOccluders(walls, 0, 200, 900, 200), 3, "capped at the default max 3");
  assert.equal(countOccluders(walls, 0, 200, 900, 200, 10), 4);
  assert.equal(countOccluders(walls, 0, 500, 900, 500), 0, "passing below the walls");
});

test("ignore mask: VAULT solids are skipped only when asked (the roll), every MOVE query still sees them", () => {
  const m = buildCollisionIndex(
    {
      rects: [
        { x: 500, y: 0, w: 24, h: 1000, f: SOLID.WINDOW },
        { x: 800, y: 0, w: 24, h: 1000, f: SOLID.MOVE }, // water: MOVE without VAULT
      ],
      circles: [{ x: 300, y: 500, r: 20, f: SOLID.MOVE | SOLID.VAULT }],
    },
    1000, 1000,
  );
  const seen = (ignore: number) => {
    let n = 0;
    forEachSolidNear(m, 0, 0, 999, 999, SOLID.MOVE, () => { n++; }, () => { n++; }, ignore);
    return n;
  };
  assert.equal(seen(0), 3);
  assert.equal(seen(SOLID.VAULT), 1, "only the water is left");
  assert.ok(Math.abs(moveCircle(m, 400, 300, PLAYER.RADIUS, 300, 0).x - (500 - PLAYER.RADIUS)) < 1e-6, "walking stops");
  const vaulted = moveCircle(m, 400, 300, PLAYER.RADIUS, 300, 0, SOLID.VAULT);
  assert.ok(Math.abs(vaulted.x - 700) < 1e-9, "the roll passes the window");
  assert.ok(Math.abs(moveCircle(m, 700, 300, PLAYER.RADIUS, 200, 0, SOLID.VAULT).x - (800 - PLAYER.RADIUS)) < 1e-6, "but not water");
  assert.deepEqual(resolveCircle(m, 505, 300, PLAYER.RADIUS, SOLID.VAULT), { x: 505, y: 300 });
  assert.equal(circleIsFree(m, 512, 300, PLAYER.RADIUS), false, "MOVE queries still see the window");
  assert.equal(hasLineOfSight(m, 400, 300, 700, 300, SOLID.MOVE), false, "and interaction line of sight stops at it");
});

test("leaveVault: unchanged outside; inside it exits along the axis on the nearer side, forward on a tie", () => {
  const W = { x: 500, y: 400, w: 24, h: 200 };
  const r = PLAYER.RADIUS;
  const m = buildCollisionIndex(
    {
      rects: [{ x: 500, y: 0, w: 24, h: 400, f: SOLID.ALL }, { ...W, f: SOLID.WINDOW }, { x: 500, y: 600, w: 24, h: 400, f: SOLID.ALL }],
      circles: [],
    },
    1000, 1000,
  );
  const lo = W.x - r, hi = W.x + W.w + r; // 476 .. 548, middle 512
  assert.deepEqual(leaveVault(m, 300, 500, r, 1, 0), { x: 300, y: 500 });
  assert.deepEqual(leaveVault(m, lo, 500, r, 1, 0), { x: lo, y: 500 }, "flush against the face is not inside");
  assert.deepEqual(leaveVault(m, 512, 500, r, 1, 0), { x: hi, y: 500 }, "tie → forward");
  assert.deepEqual(leaveVault(m, 512, 500, r, -1, 0), { x: lo, y: 500 }, "tie → forward (−x)");
  assert.deepEqual(leaveVault(m, 490, 500, r, 1, 0), { x: lo, y: 500 }, "nearer side is back");
  assert.deepEqual(leaveVault(m, 540, 500, r, 1, 0), { x: hi, y: 500 }, "nearer side is ahead");
  // Odd offsets land within one VAULT_EXIT_STEP past the face.
  const odd = leaveVault(m, 541, 500, r, 1, 0);
  assert.ok(odd.x >= hi && odd.x < hi + 2 && odd.y === 500, JSON.stringify(odd));
  // Forward blocked by a crate right behind the window: it backs out instead.
  const crate = buildCollisionIndex(
    {
      rects: [
        { x: 500, y: 0, w: 24, h: 400, f: SOLID.ALL }, { ...W, f: SOLID.WINDOW }, { x: 500, y: 600, w: 24, h: 400, f: SOLID.ALL },
        { x: 560, y: 300, w: 60, h: 400, f: SOLID.ALL },
      ],
      circles: [],
    },
    1000, 1000,
  );
  const back = leaveVault(crate, 520, 500, r, 1, 0);
  assert.ok(back.x <= lo && back.x > lo - 2 && back.y === 500, JSON.stringify(back));
  // No axis (a drop or a body that was not rolling): the plain push-out.
  assert.deepEqual(leaveVault(m, 505, 500, r, 0, 0), resolveCircle(m, 505, 500, r));
});
