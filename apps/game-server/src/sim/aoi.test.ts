import { test } from "node:test";
import assert from "node:assert/strict";
import { SERVER_TICK_MS, VISION, generateMap, mulberry32, type GroundItem } from "@extract/shared";
import { AoiSystem, type AoiEntity } from "./aoi.js";
import { spawnGroundItem } from "./inventory.js";
import { makeItem } from "./items.js";
import { Match } from "./match.js";
import { counterUid, humans, ids, npcOpts, npcsOf, place, rtOf, testMatch, testPost } from "./test-utils.js";

const item = (m: Match, x: number, y: number): GroundItem => spawnGroundItem(m, makeItem("bandage", { qty: 1 }), x, y);
const keys = (es: readonly AoiEntity[]) => es.map((e) => e.id).sort();

test("aoi: the ring is ±AOI_RING cells of 512 px around the viewer", () => {
  assert.equal(VISION.AOI_CELL, 512);
  assert.equal(VISION.AOI_RING, 3);
  assert.equal(AoiSystem.ringContains(1000, 1000, 2559, 1000), true, "cell 4 from cell 1");
  assert.equal(AoiSystem.ringContains(1000, 1000, 2560, 1000), false, "cell 5 from cell 1");
  assert.equal(AoiSystem.ringContains(3000, 3000, 1536, 1536), true, "cells 5 → 3: two away");
  assert.equal(AoiSystem.ringContains(3000, 3000, 1023, 3000), false, "cell 1 is four away");
});

test("aoi: a (re)connecting view gets its ring; spawns reach only the viewers whose ring holds them", () => {
  const m = testMatch(2);
  const [a, b] = ids(m);
  place(m, a!, 1000, 1000);
  place(m, b!, 4000, 4000);
  const near = item(m, 2500, 1000);
  const far = item(m, 2600, 1000);
  m.step(SERVER_TICK_MS);
  m.aoi.drainDiffs();
  const ra = rtOf(m, a!).rosterIndex, rb = rtOf(m, b!).rosterIndex;
  assert.deepEqual(keys(m.aoi.ring(m, ra, 1000, 1000)), [near.id]);
  assert.deepEqual(keys(m.aoi.ring(m, rb, 4000, 4000)), []);

  const fresh = item(m, 900, 1200);
  const forB = item(m, 4100, 3900);
  m.step(SERVER_TICK_MS);
  const d = new Map(m.aoi.drainDiffs().map((x) => [x.viewer, x]));
  assert.deepEqual(keys(d.get(ra)!.add), [fresh.id]);
  assert.deepEqual(keys(d.get(rb)!.add), [forB.id]);
  void far;

  // Nothing changes → no diffs at all.
  m.step(SERVER_TICK_MS);
  assert.deepEqual(m.aoi.drainDiffs(), []);
});

test("aoi: crossing a cell adds the entering cells and removes the leaving ones; despawns need no diff", () => {
  const m = testMatch(1);
  const [a] = ids(m);
  place(m, a!, 1000, 1000);
  const west = item(m, 300, 1000);
  const east = item(m, 2600, 1000);
  const far = item(m, 4500, 1000);
  m.step(SERVER_TICK_MS);
  m.aoi.drainDiffs();
  const ra = rtOf(m, a!).rosterIndex;
  assert.deepEqual(keys(m.aoi.ring(m, ra, 1000, 1000)), [west.id]);

  place(m, a!, 1100, 1000); // cell 1 → 2: the ring now reaches x < 3072
  m.step(SERVER_TICK_MS);
  let d = m.aoi.drainDiffs();
  assert.deepEqual(keys(d[0]!.add), [east.id]);
  assert.deepEqual(d[0]!.remove, []);

  place(m, a!, 3000, 1000); // cell 2 → 5: x in [1024, 4608)
  m.step(SERVER_TICK_MS);
  d = m.aoi.drainDiffs();
  assert.deepEqual(keys(d[0]!.add), [far.id]);
  assert.deepEqual(keys(d[0]!.remove), [west.id]);

  assert.equal(m.aoi.isLive(m, east), true);
  m.ground.remove(m, east.id);
  m.step(SERVER_TICK_MS);
  assert.deepEqual(m.aoi.drainDiffs(), [], "a despawn is a state DELETE, not a view diff");
  assert.equal(m.aoi.isLive(m, east), false);
  assert.deepEqual(keys(m.aoi.ring(m, ra, 3000, 1000)), [far.id]);
});

test("aoi: NPCs are never viewers", () => {
  const m = testMatch(1, { ...npcOpts([testPost(0, 1000, 1100)]), npcBrains: false });
  const npc = npcsOf(m)[0]!;
  item(m, 1000, 1000);
  m.step(SERVER_TICK_MS);
  item(m, 1001, 1000);
  m.step(SERVER_TICK_MS);
  const viewers = m.aoi.drainDiffs().map((d) => d.viewer);
  assert.ok(!viewers.includes(npc.rosterIndex), "the NPC gets no diffs");
});

test("aoi: 3000 items × 32 viewers per tick is far below the budget", () => {
  const map = generateMap("steppe");
  const m = new Match({
    roster: humans(32), rng: mulberry32(5), map, newUid: counterUid, now: () => 0,
    emptyWorld: true, npcBrains: false, envSeed: 2, weatherOverride: "clear",
  });
  const rng = mulberry32(1);
  for (let k = 0; k < 3000; k++) item(m, 200 + rng() * (map.width - 400), 200 + rng() * (map.height - 400));
  m.step(SERVER_TICK_MS);
  const N = 100;
  const t0 = performance.now();
  for (let k = 0; k < N; k++) {
    for (const rt of m.allRuntimes()) rt.pub.x = Math.min(map.width - 100, rt.pub.x + 13);
    m.aoi.update(m);
    m.aoi.drainDiffs();
  }
  const per = (performance.now() - t0) / N;
  console.log(`aoi.update, 3000 items × 32 moving viewers: ${per.toFixed(3)} ms`);
  assert.ok(per < 2, `aoi pass ${per.toFixed(3)} ms`);
});
