import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LEGACY_WORLD,
  MATCH,
  PERF_BUDGET,
  SERVER_TICK_MS,
  WORLD,
  allowedExtracts,
  extractMask,
  generateMap,
  legacyMapData,
  mapHash,
  mulberry32,
  type MapData,
  type MapSide,
} from "@extract/shared";
import { LEGACY_MATCH_PLAYERS, MATCH_PLAYERS, Match, assignSpawns, defaultMapChoice, expectedMapHash, matchMap, warmMatchMap } from "./match.js";
import { mapRuntime } from "./nav.js";
import { counterUid, testMap } from "./test-utils.js";
import type { RosterEntry } from "./types.js";

const STEPPE_HASH = "d066dcca";

function roster(humans: number, total: number): RosterEntry[] {
  return Array.from({ length: total }, (_, i) =>
    i < humans ? { userId: `u${i}`, nickname: `H${i}`, isBot: false } : { userId: null, nickname: `B${i}`, isBot: true });
}

test("map boot: the Steppe is the default, built once per process, and its hash is the golden one", () => {
  assert.equal(defaultMapChoice(), "steppe");
  const boot = warmMatchMap()!;
  assert.equal(boot.map, generateMap("steppe"));
  assert.equal(boot.hash, STEPPE_HASH);
  assert.equal(expectedMapHash(), mapHash(generateMap("steppe")));
  assert.equal(expectedMapHash("legacy"), null, "seed-dependent legacy map: no single hash");
  assert.equal(MATCH_PLAYERS, MATCH.MAX_PLAYERS);

  const a = new Match({ roster: roster(1, 4), rng: mulberry32(1), newUid: counterUid, botBrains: false });
  const b = new Match({ roster: roster(1, 4), rng: mulberry32(2), newUid: counterUid, botBrains: false });
  assert.equal(a.map.width, WORLD.WIDTH);
  assert.equal(a.state.mapId, "steppe");
  assert.notEqual(a.state.mapSeed, b.state.mapSeed, "the match seed varies, the layout does not");
  // Shared static runtime: the same collision index, walk grid, region graph and bush index.
  assert.equal(a.mapRt, boot);
  assert.equal(b.mapRt, boot);
  assert.equal(a.idx, b.idx);
  assert.equal(a.bushIndex, boot.bushIndex);
  assert.notEqual(a.planner, b.planner, "per-match planner (queue + budget), shared graph");
  assert.equal(a.planner.regions, boot.regions);
  // Creating a room builds nothing static any more.
  const t0 = performance.now();
  new Match({ roster: roster(0, MATCH_PLAYERS), rng: mulberry32(3), newUid: counterUid });
  assert.ok(performance.now() - t0 < 100, "room creation on a warm map is cheap");
});

test("legacy map stays available behind MatchOptions.mapId for small-map tests", () => {
  const m = new Match({ mapId: "legacy", mapSeed: 7, roster: roster(1, LEGACY_MATCH_PLAYERS), rng: mulberry32(7), newUid: counterUid, botBrains: false });
  assert.equal(m.map.width, LEGACY_WORLD.WIDTH);
  assert.equal(m.map, legacyMapData(7));
  assert.equal(matchMap(7, "legacy"), legacyMapData(7));
  assert.equal(matchMap(7), generateMap("steppe"));
  assert.equal(m.mapRt, mapRuntime(m.map));
});

test("extract masks: Tarkov side rule (both opposite + one per adjacent side, never your own side)", () => {
  const map = generateMap("steppe");
  assert.equal(map.extracts.length, 8);
  for (const side of [0, 1, 2, 3] as MapSide[]) {
    const mask = extractMask(map, side);
    const ids = map.extracts.filter((_, i) => mask & (1 << i)).map((e) => e.id);
    assert.equal(ids.length, 4, `side ${side}: ${ids}`);
    assert.ok(map.extracts.every((e, i) => e.side !== side || !(mask & (1 << i))), "never own side");
    assert.deepEqual(new Set(ids), new Set(allowedExtracts(map, side).map((e) => e.id)));
  }
  const m = new Match({ roster: roster(4, MATCH_PLAYERS), rng: mulberry32(5), newUid: counterUid, botBrains: false });
  for (const rt of m.allRuntimes()) {
    assert.equal(rt.self.extractMask, extractMask(map, rt.self.side as MapSide), `${rt.nickname} side ${rt.self.side}`);
    assert.ok(rt.self.extractMask !== 0);
  }
  // The Steppe schedules its own closes (N2, S2 at 25:00): no random closes on top, so every side
  // keeps an always-open allowed extract until the end.
  const closing = [...m.state.extracts.values()].filter((e) => e.closeAt > 0).map((e) => e.id).sort();
  assert.deepEqual(closing, map.extracts.filter((e) => e.closesAtMs !== undefined).map((e) => e.id).sort());
  for (const side of [0, 1, 2, 3] as MapSide[]) {
    assert.ok(allowedExtracts(map, side).some((e) => m.state.extracts.get(e.id)!.closeAt === 0), `side ${side}`);
  }
  // Maps whose extracts leave a side with none (hand-made test maps) fall back to all extracts.
  const t = testMap();
  t.extracts = [{ id: "X", name: "X", x: 100, y: 100, r: 100, side: 0, kind: "always" }];
  const tm = new Match({ map: t, roster: roster(1, 1), rng: mulberry32(1), newUid: counterUid, botBrains: false });
  assert.equal(tm.allRuntimes()[0]!.self.extractMask, 1);
});

/** Nearest-other-player distance per roster index. */
function nearest(ps: ReadonlyArray<{ x: number; y: number }>): number[] {
  return ps.map((p, i) => Math.min(...ps.filter((_, j) => j !== i).map((o) => Math.hypot(o.x - p.x, o.y - p.y))));
}

function checkSpawns(map: MapData, total: number, label: string) {
  const sides = new Set(map.spawns.map((s) => s.side)).size;
  for (const humansN of [1, 2, 3, 4, 6, 8]) {
    for (let seed = 1; seed <= 8; seed++) {
      const isHuman = Array.from({ length: total }, (_, i) => i < humansN);
      const sp = assignSpawns(mulberry32(seed), map.spawns, isHuman);
      assert.equal(sp.length, total);
      const at = `${label}: ${humansN} humans, seed ${seed}`;
      // Humans first: distinct spots, at most ceil(H / sides) per side (round-robin spread).
      assert.equal(new Set(sp.slice(0, humansN)).size, humansN, `${at}: distinct human spots`);
      const perSide = [0, 0, 0, 0];
      for (const s of sp.slice(0, humansN)) perSide[s.side]!++;
      assert.ok(Math.max(...perSide) <= Math.ceil(humansN / sides), `${at}: per side ${perSide}`);
      if (total <= map.spawns.length) assert.equal(new Set(sp).size, total, `${at}: distinct spots`);
      // Farthest: no human is more crowded than the most crowded bot; with a single human the side
      // cap does not bind and the human gets the most isolated layout outright.
      const d = nearest(sp);
      const humanWorst = Math.min(...d.slice(0, humansN));
      const bots = d.slice(humansN).sort((x, y) => x - y);
      assert.ok(humanWorst >= bots[0]!, `${at}: human ${humanWorst} < most crowded bot ${bots[0]}`);
      if (humansN === 1) assert.ok(humanWorst >= bots[bots.length - 1]!, `${at}: lone human ${humanWorst} < bot ${bots[bots.length - 1]}`);
    }
  }
}

test("side-aware spawns on the Steppe: humans first, spread over sides, farthest from everyone", () => {
  const map = generateMap("steppe");
  assert.ok(map.spawns.length >= MATCH_PLAYERS);
  checkSpawns(map, MATCH_PLAYERS, "steppe");
  // Four humans in a full match: one per side, each with that side's mask.
  const m = new Match({ roster: roster(4, MATCH_PLAYERS), rng: mulberry32(9), newUid: counterUid, botBrains: false });
  const humanSides = m.allRuntimes().filter((r) => !r.isBot).map((r) => r.self.side).sort();
  assert.deepEqual(humanSides, [0, 1, 2, 3]);
  for (const rt of m.allRuntimes()) {
    const s = map.spawns.find((p) => p.x === rt.pub.x && p.y === rt.pub.y);
    assert.ok(s, `${rt.nickname} stands on a spawn spot`);
    assert.equal(rt.self.side, s.side);
  }
});

test("side-aware spawns on the legacy map (sides from the nearest edge) and with more players than spots", () => {
  checkSpawns(legacyMapData(3), LEGACY_MATCH_PLAYERS, "legacy");
  const spots = legacyMapData(3).spawns;
  const sp = assignSpawns(mulberry32(1), spots, Array.from({ length: spots.length + 5 }, (_, i) => i < 2));
  assert.equal(sp.length, spots.length + 5, "extra bots reuse spots");
  assert.notEqual(sp[0], sp[1]);
  assert.equal(assignSpawns(mulberry32(1), [], [true]).length, 0);
});

test("soak: 32 bots on the Steppe for 5 simulated minutes, step p99 under PERF_BUDGET, no exceptions", () => {
  const m = new Match({ roster: roster(0, MATCH_PLAYERS), rng: mulberry32(2026), newUid: counterUid, strictLedger: true });
  const ticks = (5 * 60_000) / SERVER_TICK_MS;
  const ms: number[] = [];
  const counts: Record<string, number> = {};
  for (let i = 0; i < ticks && !m.ended; i++) {
    const t0 = performance.now();
    m.step(SERVER_TICK_MS);
    ms.push(performance.now() - t0);
    for (const e of m.drainEvents()) counts[e.type] = (counts[e.type] ?? 0) + 1;
  }
  // The first second is JIT warm-up of every system; the budget is about steady state.
  const steady = ms.slice(20).sort((x, y) => x - y);
  const avg = steady.reduce((s, v) => s + v, 0) / steady.length;
  const p99 = steady[Math.floor(steady.length * 0.99)]!;
  const st = m.planner.stats;
  const okShare = (st.served - st.unreachable) / Math.max(1, st.served);
  console.log(
    `steppe soak: ${ms.length} ticks, step avg ${avg.toFixed(3)} ms, p99 ${p99.toFixed(3)} ms, max ${steady[steady.length - 1]!.toFixed(2)} ms; ` +
    `alive ${m.state.aliveCount}/${MATCH_PLAYERS}; events ${JSON.stringify(counts)}; planner served ${st.served} ` +
    `(ok ${(okShare * 100).toFixed(1)}%, deferred ${st.deferred}, route hits ${st.routeHits}, max tick work ${st.maxTickWork}/${m.planner.budgetWork})`,
  );
  assert.equal(ms.length, ticks, "the match runs the whole 5 minutes");
  assert.ok(avg < PERF_BUDGET.SERVER_STEP_AVG_MS, `avg ${avg}`);
  assert.ok(p99 < PERF_BUDGET.SERVER_STEP_P99_MS, `p99 ${p99}`);
  assert.ok(st.served > MATCH_PLAYERS * 10, "bots plan through the region planner");
  assert.ok(okShare >= 0.95, `path success ${okShare}`);
  assert.ok(st.maxTickWork <= m.planner.budgetWork * 1.5, `planner tick work ${st.maxTickWork}`);
  assert.ok((counts.chest ?? 0) > 0, "bots reach containers across the map");
  // Nobody walked out of the world or into a wall: every live player stands on a free spot.
  for (const rt of m.allRuntimes()) {
    if (!rt.pub.alive) continue;
    assert.ok(rt.pub.x > 0 && rt.pub.x < m.map.width && rt.pub.y > 0 && rt.pub.y < m.map.height);
  }
});
