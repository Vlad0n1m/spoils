import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWalkGrid, getCollisionIndex, mulberry32 } from "@extract/shared";
import { navGridFor, warmMap } from "./nav.js";
import { REGION_BLOCK, RegionGraph } from "./regions.js";
import { testMap } from "./test-utils.js";

const rt = warmMap("steppe");
const g = rt.regions;

/** Connected components of walkable cells (4-neighbourhood) by plain BFS: the oracle. */
function cellComponents(): Int32Array {
  const { cols, rows, blocked } = g;
  const comp = new Int32Array(cols * rows).fill(-1);
  const q = new Int32Array(cols * rows);
  let c = 0;
  for (let s = 0; s < comp.length; s++) {
    if (blocked[s] || comp[s] !== -1) continue;
    let head = 0, tail = 0;
    q[tail++] = s;
    comp[s] = c;
    while (head < tail) {
      const i = q[head++]!;
      const x = i % cols;
      const nb = [x > 0 ? i - 1 : -1, x < cols - 1 ? i + 1 : -1, i >= cols ? i - cols : -1, i < (rows - 1) * cols ? i + cols : -1];
      for (const j of nb) if (j >= 0 && !blocked[j] && comp[j] === -1) { comp[j] = c; q[tail++] = j; }
    }
    c++;
  }
  return comp;
}

const walkable: number[] = [];
for (let i = 0; i < g.blocked.length; i++) if (!g.blocked[i]) walkable.push(i);

test("steppe region graph: size and build cost in the map memo's range", () => {
  assert.equal(g.cols, Math.ceil(rt.map.width / 32));
  assert.ok(g.count > 1500 && g.count < 6000, `${g.count} regions`);
  assert.ok(g.edgeCount > g.count, `${g.edgeCount} edges`);
  // Built once at boot; a second call returns the very same object.
  assert.equal(warmMap("steppe"), rt);
  const t0 = performance.now();
  const again = new RegionGraph(rt.walk);
  const ms = performance.now() - t0;
  assert.equal(again.count, g.count, "deterministic build");
  assert.ok(ms < 300, `region build ${ms.toFixed(0)} ms`);
});

test("region completeness: every walkable cell is in exactly one region of its own block, blocked cells in none", () => {
  const { cols, region, blocked } = g;
  const cells = new Int32Array(g.count);
  const blockOf = new Int32Array(g.count).fill(-1);
  for (let i = 0; i < region.length; i++) {
    const r = region[i]!;
    if (blocked[i]) {
      assert.equal(r, -1, `blocked cell ${i} has region ${r}`);
      continue;
    }
    assert.ok(r >= 0 && r < g.count, `walkable cell ${i} has no region`);
    cells[r]!++;
    const x = i % cols, y = (i - x) / cols;
    const b = Math.floor(y / REGION_BLOCK) * 10_000 + Math.floor(x / REGION_BLOCK);
    if (blockOf[r] === -1) blockOf[r] = b;
    else assert.equal(blockOf[r], b, `region ${r} spans two blocks`);
  }
  for (let r = 0; r < g.count; r++) {
    assert.ok(cells[r]! > 0, `empty region ${r}`);
    assert.equal(region[g.repCell[r]!], r, `rep cell of region ${r} lies inside it`);
  }
});

test("region graph connectivity equals the flat walk-grid connectivity (every pair, via a component bijection)", () => {
  const comp = cellComponents();
  const cellToRegionComp = new Map<number, number>();
  const regionCompToCell = new Map<number, number>();
  for (const i of walkable) {
    const rc = g.comp[g.region[i]!]!;
    const cc = comp[i]!;
    const a = cellToRegionComp.get(cc);
    if (a === undefined) cellToRegionComp.set(cc, rc);
    else assert.equal(a, rc, `cell component ${cc} split over region components`);
    const b = regionCompToCell.get(rc);
    if (b === undefined) regionCompToCell.set(rc, cc);
    else assert.equal(b, cc, `region component ${rc} merges cell components`);
  }
  // Every spawn, extract and container of the map is reachable from every spawn (one component).
  const spawnComp = g.comp[g.region[g.cellAt(rt.map.spawns[0]!.x, rt.map.spawns[0]!.y)]!]!;
  for (const p of [...rt.map.spawns, ...rt.map.extracts]) {
    const c = g.cellAt(p.x, p.y);
    assert.ok(c >= 0 && g.comp[g.region[c]!] === spawnComp, `(${p.x}, ${p.y}) not reachable from spawn 0`);
  }
});

test("coarse + corridor refinement: 1000 random pairs find a path exactly when the cells are connected", () => {
  const comp = cellComponents();
  const rng = mulberry32(17);
  let paths = 0;
  for (let k = 0; k < 1000; k++) {
    const a = walkable[Math.floor(rng() * walkable.length)]!;
    const b = walkable[Math.floor(rng() * walkable.length)]!;
    const rp = g.coarse(g.region[a]!, g.region[b]!);
    assert.equal(rp !== null, comp[a] === comp[b], `pair ${a} → ${b}`);
    if (!rp) continue;
    // Consecutive path regions are neighbours.
    for (let i = 1; i < rp.length; i++) {
      let adjacent = false;
      for (let e = g.adjStart[rp[i - 1]!]!; e < g.adjStart[rp[i - 1]! + 1]!; e++) if (g.adj[e] === rp[i]) adjacent = true;
      assert.ok(adjacent, `regions ${rp[i - 1]} and ${rp[i]} are not adjacent`);
    }
    // Full-corridor refinement without the ring must still succeed (completeness argument).
    const cells = g.fine(a, b, rp, false);
    assert.ok(cells, `no fine path inside the corridor ${a} → ${b}`);
    const allowed = new Set(rp);
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i]!;
      assert.ok(!g.blocked[c] && allowed.has(g.region[c]!), "path leaves the corridor");
      if (i === 0) continue;
      const p = cells[i - 1]!;
      const dx = (c % g.cols) - (p % g.cols), dy = Math.floor(c / g.cols) - Math.floor(p / g.cols);
      assert.ok(Math.abs(dx) <= 1 && Math.abs(dy) <= 1 && (dx || dy), "non-adjacent step");
      if (dx && dy) assert.ok(!g.blocked[p + dx] && !g.blocked[p + dy * g.cols], "corner cut");
    }
    assert.equal(cells[0], a);
    assert.equal(cells[cells.length - 1], b);
    paths++;
  }
  assert.ok(paths > 900, `${paths} connected pairs`);
});

test("corridor paths stay close to the flat optimum (ring of 1 region)", () => {
  const flat = navGridFor(rt.map);
  const rng = mulberry32(5);
  const len = (cells: readonly number[]) => {
    let d = 0;
    for (let i = 1; i < cells.length; i++) {
      d += Math.hypot(g.cellX(cells[i]!) - g.cellX(cells[i - 1]!), g.cellY(cells[i]!) - g.cellY(cells[i - 1]!));
    }
    return d;
  };
  const ratios: number[] = [];
  while (ratios.length < 40) {
    const a = walkable[Math.floor(rng() * walkable.length)]!;
    const b = walkable[Math.floor(rng() * walkable.length)]!;
    const ax = g.cellX(a), ay = g.cellY(a), bx = g.cellX(b), by = g.cellY(b);
    if (Math.hypot(bx - ax, by - ay) > 3000) continue; // keep the flat oracle under its expansion cap
    const opt = flat.findPath({ x: ax, y: ay }, { x: bx, y: by });
    const rp = g.coarse(g.region[a]!, g.region[b]!);
    if (!opt || !rp) continue;
    const optLen = len([a, ...opt.map((p) => Math.floor(p.y / 32) * g.cols + Math.floor(p.x / 32))]);
    const cells = g.fine(a, b, rp, true)!;
    if (optLen < 64) continue;
    ratios.push(len(cells) / optLen);
  }
  ratios.sort((x, y) => x - y);
  const median = ratios[ratios.length >> 1]!;
  console.log(`corridor/optimal length: median ${median.toFixed(3)}, max ${ratios[ratios.length - 1]!.toFixed(3)}`);
  assert.ok(median < 1.1, `median ${median}`);
  assert.ok(ratios[ratios.length - 1]! < 1.6, `max ${ratios[ratios.length - 1]}`);
});

test("small maps: the walled-off box is its own component and the crate wall is routed around", () => {
  const map = testMap({ walls: [{ x: 1960, y: 1960, w: 600, h: 40 }, { x: 1960, y: 2520, w: 600, h: 40 }, { x: 1960, y: 1960, w: 40, h: 600 }, { x: 2520, y: 1960, w: 40, h: 600 }] });
  const rg = new RegionGraph(buildWalkGrid(map, getCollisionIndex(map)));
  const inside = rg.cellAt(2260, 2260);
  const outside = rg.cellAt(1000, 1000);
  assert.ok(inside >= 0 && outside >= 0);
  assert.equal(rg.connected(rg.region[inside]!, rg.region[outside]!), false);
  const w0 = rg.work;
  assert.equal(rg.coarse(rg.region[inside]!, rg.region[outside]!), null);
  assert.equal(rg.work, w0, "different components are refused without any search");
  // Around the 64×400 crate wall at x 3000..3064, y 3000..3400.
  const a = rg.cellAt(2900, 3200), b = rg.cellAt(3200, 3200);
  const cells = rg.fine(a, b, rg.coarse(rg.region[a]!, rg.region[b]!)!)!;
  assert.ok(cells.some((c) => rg.cellY(c) < 3000 - 24 || rg.cellY(c) > 3400 + 24), "goes around the wall");
});
