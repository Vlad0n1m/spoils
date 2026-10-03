import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LEGACY_WORLD,
  MATCH,
  NPC,
  SPAWN_RULES,
  WORLD,
  allowedExtracts,
  extractMask,
  humanSideCap,
  npcPostsOf,
  generateMap,
  legacyMapData,
  mapHash,
  mulberry32,
  type MapData,
  type MapSide,
} from "@extract/shared";
import { Match, assignSpawns, defaultMapChoice, expectedMapHash, matchMap, warmMatchMap } from "./match.js";
import { mapRuntime } from "./nav.js";
import { counterUid, testMap } from "./test-utils.js";
import type { RosterEntry } from "./types.js";

const STEPPE_HASH = "d066dcca";

function roster(humans: number): RosterEntry[] {
  return Array.from({ length: humans }, (_, i) => ({ userId: `u${i}`, nickname: `H${i}` }));
}

test("map boot: the Steppe is the default, built once per process, and its hash is the golden one", () => {
  assert.equal(defaultMapChoice(), "steppe");
  const boot = warmMatchMap()!;
  assert.equal(boot.map, generateMap("steppe"));
  assert.equal(boot.hash, STEPPE_HASH);
  assert.equal(expectedMapHash(), mapHash(generateMap("steppe")));
  assert.equal(expectedMapHash("legacy"), null, "seed-dependent legacy map: no single hash");
  assert.equal(MATCH.MAX_HUMANS, 24);

  const a = new Match({ roster: roster(1), rng: mulberry32(1), newUid: counterUid, npcBrains: false });
  const b = new Match({ roster: roster(1), rng: mulberry32(2), newUid: counterUid, npcBrains: false });
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
  const full = new Match({ roster: roster(MATCH.MAX_HUMANS), rng: mulberry32(3), newUid: counterUid });
  assert.ok(performance.now() - t0 < 100, "room creation on a warm map is cheap (24 humans + every NPC)");
  assert.ok(full.npcs.runtimes().length > 0 && full.npcs.runtimes().length <= NPC.MAX_PER_RAID);
});

test("legacy map stays available behind MatchOptions.mapId for small-map tests", () => {
  const m = new Match({ mapId: "legacy", mapSeed: 7, roster: roster(1), rng: mulberry32(7), newUid: counterUid, npcBrains: false });
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
  const m = new Match({ roster: roster(4), rng: mulberry32(5), newUid: counterUid, npcBrains: false });
  // Humans only: NPCs (Player.role != 0) stand at their posts and never extract (mask 0).
  for (const rt of m.allRuntimes().filter((r) => r.pub.role !== 0)) assert.equal(rt.self.extractMask, 0);
  for (const rt of m.allRuntimes().filter((r) => r.pub.role === 0)) {
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
  const tm = new Match({ map: t, roster: roster(1), rng: mulberry32(1), newUid: counterUid, npcBrains: false });
  assert.equal(tm.allRuntimes()[0]!.self.extractMask, 1);
});

/** Nearest-other-player distance per roster index. */
function nearest(ps: ReadonlyArray<{ x: number; y: number }>): number[] {
  return ps.map((p, i) => Math.min(...ps.filter((_, j) => j !== i).map((o) => Math.hypot(o.x - p.x, o.y - p.y))));
}

function checkSpawns(map: MapData, label: string, maxHumans: number) {
  const sides = new Set(map.spawns.map((s) => s.side)).size;
  for (const humansN of [1, 2, 3, 4, 6, 8, 12, 16, 24].filter((n) => n <= maxHumans)) {
    for (let seed = 1; seed <= 8; seed++) {
      const sp = assignSpawns(mulberry32(seed), map.spawns, humansN);
      assert.equal(sp.length, humansN);
      const at = `${label}: ${humansN} humans, seed ${seed}`;
      if (humansN <= map.spawns.length) assert.equal(new Set(sp).size, humansN, `${at}: distinct spots`);
      // Spread over the sides: at most humanSideCap(n) = ceil(n/4) + 1 per side.
      const perSide = [0, 0, 0, 0];
      for (const s of sp) perSide[s.side]!++;
      if (sides > 1) assert.ok(Math.max(...perSide) <= humanSideCap(humansN), `${at}: per side ${perSide}`);
      // Farthest-point sampling: SPAWN_RULES.HUMAN_MIN_SEP_PX always holds for n ≤ 16 on the Steppe.
      if (label === "steppe" && humansN <= 16 && humansN > 1) {
        const worst = Math.min(...nearest(sp));
        assert.ok(worst >= SPAWN_RULES.HUMAN_MIN_SEP_PX, `${at}: nearest pair ${worst.toFixed(0)} px`);
      }
    }
  }
}

test("humans-only spawns on the Steppe: farthest-point sampling, spread over sides, ≥ HUMAN_MIN_SEP_PX for n ≤ 16", () => {
  const map = generateMap("steppe");
  assert.ok(map.spawns.length >= MATCH.MAX_HUMANS);
  checkSpawns(map, "steppe", MATCH.MAX_HUMANS);
  // Four humans spread over the sides (cap 2 per side), each with that side's mask.
  const m = new Match({ roster: roster(4), rng: mulberry32(9), newUid: counterUid, npcBrains: false });
  const humanSides = m.allRuntimes().filter((r) => !r.isNpc).map((r) => r.self.side);
  assert.ok(new Set(humanSides).size >= 3, `sides ${humanSides}`);
  for (const rt of m.allRuntimes().filter((r) => r.pub.role === 0)) {
    const s = map.spawns.find((p) => p.x === rt.pub.x && p.y === rt.pub.y);
    assert.ok(s, `${rt.nickname} stands on a spawn spot`);
    assert.equal(rt.self.side, s.side);
  }
  // Nobody spawns into a camp: every NPC post is ≥ NPC.SPAWN_CLEAR_PX from every spawn spot.
  for (const p of npcPostsOf(map)) {
    for (const s of map.spawns) assert.ok(Math.hypot(p.x - s.x, p.y - s.y) >= NPC.SPAWN_CLEAR_PX - 1, `post ${p.id} vs spawn`);
  }
});

test("humans-only spawns on the legacy map (sides from the nearest edge) and with more humans than spots", () => {
  checkSpawns(legacyMapData(3), "legacy", 16);
  const spots = legacyMapData(3).spawns;
  const sp = assignSpawns(mulberry32(1), spots, spots.length + 5);
  assert.equal(sp.length, spots.length + 5, "extra humans reuse spots");
  assert.equal(new Set(sp.slice(0, spots.length)).size, spots.length);
  assert.equal(assignSpawns(mulberry32(1), [], 1).length, 0);
  assert.equal(assignSpawns(mulberry32(1), spots, 0).length, 0);
});
