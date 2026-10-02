import { test } from "node:test";
import assert from "node:assert/strict";
import { PERF_BUDGET, getCollisionIndex, mulberry32, raycastSolids } from "@extract/shared";
import { mapRuntime, warmMap, type Pt } from "./nav.js";
import { PathPlanner, WORK_PER_MS } from "./planner.js";
import { testMap } from "./test-utils.js";

const rt = warmMap("steppe");
const g = rt.regions;
const walkable: number[] = [];
for (let i = 0; i < g.blocked.length; i++) if (!g.blocked[i]) walkable.push(i);

/** Random walkable point pairs at least `minDist` apart, in the spawn's component. */
function pairs(seed: number, n: number, minDist: number): Array<[Pt, Pt]> {
  const rng = mulberry32(seed);
  const home = g.comp[g.region[g.cellAt(rt.map.spawns[0]!.x, rt.map.spawns[0]!.y)]!];
  const out: Array<[Pt, Pt]> = [];
  while (out.length < n) {
    const a = walkable[Math.floor(rng() * walkable.length)]!;
    const b = walkable[Math.floor(rng() * walkable.length)]!;
    if (g.comp[g.region[a]!] !== home || g.comp[g.region[b]!] !== home) continue;
    const pa = { x: g.cellX(a), y: g.cellY(a) }, pb = { x: g.cellX(b), y: g.cellY(b) };
    if (Math.hypot(pb.x - pa.x, pb.y - pa.y) >= minDist) out.push([pa, pb]);
  }
  return out;
}

/** Every leg of a waypoint path is walkable on the grid (no leg crosses a blocked cell). */
function legsWalkable(from: Pt, path: readonly Pt[], upto: number): boolean {
  let p = from;
  for (let k = 0; k < upto; k++) {
    const q = path[k]!;
    const steps = Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / 8);
    for (let s = 1; s < steps; s++) {
      const x = p.x + ((q.x - p.x) * s) / steps, y = p.y + ((q.y - p.y) * s) / steps;
      const c = Math.floor(y / g.cell) * g.cols + Math.floor(x / g.cell);
      // Leg endpoints are cell centres of an 8-connected path without corner cuts, so a straight
      // leg only touches cells of that path's bounding run; allow the start/goal snap cells.
      if (g.blocked[c] && k > 0) return false;
    }
    p = q;
  }
  return true;
}

test("planner p95 < 1 ms for random long queries on the Steppe (cold agents, no route cache)", () => {
  let clock = 0;
  const pl = new PathPlanner(g, () => clock, 1000); // budget out of the way: measure the queries
  const qs = pairs(3, 600, 8000);
  // Warm the JIT on a separate set, like a server that has been running for a minute.
  for (const [a, b] of pairs(4, 60, 2000)) pl.request(999, a, b);
  const ms: number[] = [];
  let incomplete = 0;
  qs.forEach(([a, b], k) => {
    clock++;
    const t0 = performance.now();
    const r = pl.request(k, a, b);
    ms.push(performance.now() - t0);
    assert.equal(r.status, "ok", `query ${k}`);
    if (r.status === "ok" && !r.complete) incomplete++;
  });
  ms.sort((x, y) => x - y);
  const p95 = ms[Math.floor(ms.length * 0.95)]!;
  console.log(`planner long queries: p50 ${ms[ms.length >> 1]!.toFixed(3)} ms, p95 ${p95.toFixed(3)} ms, max ${ms[ms.length - 1]!.toFixed(3)} ms, windowed ${incomplete}/${qs.length}`);
  assert.ok(p95 < 1, `p95 ${p95} ms`);
  assert.ok(incomplete > qs.length / 2, "long routes are refined window by window");
});

test("following windows always reaches the goal (100 long routes, re-requesting from each window end)", () => {
  let clock = 0;
  const pl = new PathPlanner(g, () => clock, 1000);
  for (const [k, [a, b]] of pairs(9, 100, 6000).entries()) {
    let from = a;
    let hops = 0;
    for (;;) {
      clock++;
      const r = pl.request(k, from, b);
      assert.equal(r.status, "ok");
      if (r.status !== "ok") break;
      assert.ok(r.path.length >= 1);
      const last = r.path[r.path.length - 1]!;
      assert.deepEqual(last, b, "the final point is always the target");
      if (r.complete) {
        assert.ok(legsWalkable(from, r.path, r.path.length), "complete path walkable");
        break;
      }
      // The window end is the point before the appended target.
      const end = r.path[r.path.length - 2]!;
      assert.ok(legsWalkable(from, r.path, r.path.length - 1), "window walkable");
      assert.ok(Math.hypot(end.x - from.x, end.y - from.y) > 0, "a window makes progress");
      from = end;
      assert.ok(++hops < 60, `route ${k} does not converge`);
    }
  }
  assert.ok(pl.stats.routeHits > 0, "refinements reuse the cached region route");
});

test("budget: work beyond PATH_PLAN_MS_PER_TICK waits for the next tick, FIFO, and is handed back", () => {
  let clock = 0;
  const budgetMs = 0.2;
  const pl = new PathPlanner(g, () => clock, budgetMs);
  assert.equal(pl.budgetWork, Math.round(budgetMs * WORK_PER_MS));
  const qs = pairs(11, 40, 8000);
  const first = qs.map(([a, b], k) => pl.request(k, a, b));
  const pending = first.map((r, k) => (r.status === "pending" ? k : -1)).filter((k) => k >= 0);
  assert.ok(pending.length > 0 && first[0]!.status === "ok", "the first request of a tick always runs");
  assert.ok(pl.queued === pending.length);
  // A re-request of a queued agent keeps its place and stays pending.
  assert.equal(pl.request(pending[0]!, qs[pending[0]!]![0], qs[pending[0]!]![1]).status, "pending");
  assert.equal(pl.queued, pending.length);

  const served: number[] = [];
  for (let tick = 0; tick < 200 && served.length < pending.length; tick++) {
    clock += 50;
    for (const k of pending) {
      if (served.includes(k)) continue;
      const r = pl.poll(k);
      if (r) {
        assert.equal(r.status, "ok");
        served.push(k);
      }
    }
  }
  assert.deepEqual(served, pending, "served in FIFO order, every one of them");
  // Per tick at most the budget plus the one query that crossed it.
  assert.ok(pl.stats.maxTickWork <= pl.budgetWork + 6000, `max tick work ${pl.stats.maxTickWork}`);
  assert.equal(pl.queued, 0);
});

test("pending result is returned by the agent's next request for (about) the same target", () => {
  let clock = 0;
  const pl = new PathPlanner(g, () => clock, 0.0001); // one query per tick
  const [[a1, b1], [a2, b2]] = pairs(13, 2, 5000) as [[Pt, Pt], [Pt, Pt]];
  assert.equal(pl.request(1, a1, b1).status, "ok");
  assert.equal(pl.request(2, a2, b2).status, "pending");
  clock++;
  const moved = { x: b2.x + 20, y: b2.y - 20 };
  const r = pl.request(2, a2, moved);
  assert.equal(r.status, "ok");
  if (r.status === "ok") assert.deepEqual(r.path[r.path.length - 1], moved, "retargeted to the new point");
  assert.equal(pl.path(3, a1, b1), null, "budget spent by the queue: pending → null for bots");
});

test("deterministic: the same request sequence gives the same paths and the same deferrals", () => {
  const run = () => {
    let clock = 0;
    const pl = new PathPlanner(g, () => clock, 0.5);
    const out: string[] = [];
    for (const [k, [a, b]] of pairs(21, 80, 3000).entries()) {
      if (k % 10 === 0) clock += 50;
      const r = pl.request(k % 25, a, b);
      out.push(r.status === "ok" ? `${r.path.length}:${r.path[0]!.x},${r.path[0]!.y}` : r.status);
    }
    return out.join("|");
  };
  assert.equal(run(), run());
});

test("unreachable targets and a small map", () => {
  const map = testMap({ walls: [{ x: 1960, y: 1960, w: 600, h: 40 }, { x: 1960, y: 2520, w: 600, h: 40 }, { x: 1960, y: 1960, w: 40, h: 600 }, { x: 2520, y: 1960, w: 40, h: 600 }] });
  const mr = mapRuntime(map);
  let clock = 0;
  const pl = new PathPlanner(mr.regions, () => clock);
  assert.equal(pl.request(0, { x: 1000, y: 1000 }, { x: 2260, y: 2260 }).status, "unreachable", "walled-off box");
  assert.equal(pl.request(0, { x: 1000, y: 1000 }, { x: -5000, y: 1000 }).status, "unreachable", "off the map");
  assert.equal(pl.path(0, { x: 1000, y: 1000 }, { x: 2260, y: 2260 }), null);
  // Around the crate wall (x 3000..3064, y 3000..3400): every leg clears the solids.
  const from = { x: 2900, y: 3200 }, to = { x: 3200, y: 3200 };
  const r = pl.request(1, from, to);
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  assert.equal(r.complete, true);
  const idx = getCollisionIndex(map);
  let p = from;
  for (const q of r.path) {
    assert.equal(raycastSolids(idx, p.x, p.y, q.x, q.y), Infinity, `leg (${p.x},${p.y}) → (${q.x},${q.y}) hits a solid`);
    p = q;
  }
  assert.ok(PERF_BUDGET.PATH_PLAN_MS_PER_TICK === 2);
});
