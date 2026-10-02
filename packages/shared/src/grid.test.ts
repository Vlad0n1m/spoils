import assert from "node:assert/strict";
import { test } from "node:test";
import { UniformGrid } from "./grid.js";
import { mulberry32 } from "./rng.js";

test("UniformGrid: set / move / delete / clear keep cells consistent", () => {
  const g = new UniformGrid(1000, 1000, 100);
  g.set(1, 50, 50);
  g.set(2, 150, 50);
  g.set(3, 950, 950);
  assert.equal(g.size, 3);
  assert.deepEqual([...g.cellIds(0, 0)], [1]);
  g.set(1, 60, 60); // same cell: no-op
  assert.deepEqual([...g.cellIds(0, 0)], [1]);
  g.set(1, 160, 60); // moves to cell (1,0)
  assert.deepEqual([...g.cellIds(0, 0)], []);
  assert.deepEqual([...g.cellIds(1, 0)].sort(), [1, 2]);
  g.delete(2);
  g.delete(42); // unknown id is ignored
  assert.deepEqual([...g.cellIds(1, 0)], [1]);
  assert.ok(g.has(3) && !g.has(2));
  // Out-of-bounds points clamp into edge cells instead of throwing.
  g.set(4, -500, 5000);
  assert.deepEqual([...g.cellIds(0, 9)], [4]);
  assert.deepEqual([...g.cellIds(-1, 0)], []);
  g.clear();
  assert.equal(g.size, 0);
  assert.deepEqual(g.queryCircle(500, 500, 2000), []);
});

test("UniformGrid.queryCircle returns a superset of the exact circle query (fuzz)", () => {
  const rng = mulberry32(5);
  const g = new UniformGrid(24_576, 24_576, 256);
  const pts = new Map<number, [number, number]>();
  for (let i = 0; i < 3000; i++) {
    const p: [number, number] = [rng() * 24_576, rng() * 24_576];
    pts.set(i, p);
    g.set(i, p[0], p[1]);
  }
  const out: number[] = [];
  for (let q = 0; q < 500; q++) {
    // Move some points between queries (the per-tick server pattern).
    for (let k = 0; k < 50; k++) {
      const id = Math.floor(rng() * 3000);
      const p: [number, number] = [rng() * 24_576, rng() * 24_576];
      pts.set(id, p);
      g.set(id, p[0], p[1]);
    }
    const x = rng() * 24_576, y = rng() * 24_576, r = rng() * 1500;
    const got = new Set(g.queryCircle(x, y, r, out));
    assert.equal(got.size, out.length, "no duplicates");
    for (const [id, [px, py]] of pts) {
      if ((px - x) ** 2 + (py - y) ** 2 <= r * r) assert.ok(got.has(id), `missing ${id}`);
    }
  }
});

test("UniformGrid.queryCircle reuses the output buffer", () => {
  const g = new UniformGrid(512, 512, 256);
  g.set(7, 10, 10);
  const buf = [99, 98, 97];
  const res = g.queryCircle(10, 10, 5, buf);
  assert.equal(res, buf);
  assert.deepEqual(res, [7]);
});
