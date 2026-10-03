/**
 * Loot-yield harness smoke: the in-process pool release mirrors the web v4 rule (risk count, boss
 * slots first by tier score, containers only T3/T4), and one short raid of the scripted rat runs on
 * the real Steppe sim and produces a well-formed record and summary.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { POOL, containerGuarded, generateMap, itemDef, mulberry32, poolReleasePlanV4, raidBossSlots, rollBossSpawns, uniqueTierScore } from "@extract/shared";
import { runYieldRaid, summarize, summaryMarkdown } from "./loot-yield.bench.js";
import { mirrorAllocatePool, seedPool, topTierCount } from "./pool-mirror.js";

test("pool mirror: seeded pool looks like the DB seed (weapon / armor / backpack in turn)", () => {
  const pool = seedPool(700, mulberry32(7));
  assert.equal(pool.length, 700);
  const cats = new Map<string, number>();
  for (const p of pool) {
    const cat = itemDef(p.def)!.cat;
    cats.set(cat, (cats.get(cat) ?? 0) + 1);
    assert.ok(p.dur >= 55 && p.dur <= 100, `dur ${p.dur}`);
  }
  assert.deepEqual([...cats.entries()].sort(), [["armor", 233], ["backpack", 233], ["weapon", 234]]);
});

test("pool mirror (v4): free kits get nothing; R = 3 fills boss slots only; R = 24 → 8 with containers in T3/T4", () => {
  const map = generateMap("steppe");
  const conts = map.containers.map((c, idx) => ({ idx, kind: c.kind, tier: c.tier, guarded: containerGuarded(c, map.bosses) }));
  const bosses = raidBossSlots(map.bosses);
  const nSlots = bosses.reduce((n, b) => n + b.slots.length, 0);
  const pool = seedPool(700, mulberry32(1));
  const free = mirrorAllocatePool(pool, { matchSeed: 42, containers: conts, bosses, riskUnits: 0 }, mulberry32(2));
  assert.equal(free.released, 0);
  assert.equal(pool.length, 700);
  const kit = mirrorAllocatePool(pool, { matchSeed: 43, containers: conts, bosses, riskUnits: 3 }, mulberry32(3));
  assert.equal(kit.released, poolReleasePlanV4(700, 3, nSlots).total);
  assert.equal(kit.boss, Math.min(nSlots, kit.released));
  assert.equal(kit.container, kit.released - kit.boss);
  assert.equal(pool.length, 700 - kit.released);
  // Boss slots take the top tier first.
  const top = (kit.containerLoot["boss:commander"] ?? []).map((i) => uniqueTierScore(i.def, i.rarity));
  assert.equal(top[0], 2);
  const big = mirrorAllocatePool(pool, { matchSeed: 44, containers: conts, bosses, riskUnits: 24 }, mulberry32(4));
  assert.equal(big.released, POOL.MAX_PER_MATCH);
  for (const key of Object.keys(big.containerLoot)) {
    if (key.startsWith("boss:")) continue;
    assert.ok(conts[Number(key)]!.tier >= POOL.CONTAINER_MIN_TIER, `pool item in T${conts[Number(key)]!.tier}`);
  }
  assert.ok(topTierCount(pool) > 0);
});

test("loot-yield: one rat raid on the live Steppe sim gives a well-formed record", () => {
  const r = runYieldRaid({ strategy: "rat", seed: 3, humanOnly: true });
  assert.ok(["extract", "dead", "timeout"].includes(r.exit));
  assert.equal(r.survived, r.exit === "extract");
  assert.ok(r.minutes > 0 && r.minutes <= 30);
  assert.equal(r.riskUnits, 3);
  const map = generateMap("steppe");
  const nSlots = raidBossSlots(rollBossSpawns(r.matchSeed, map.bosses)).reduce((n, b) => n + b.slots.length, 0);
  assert.equal(r.pool.released, poolReleasePlanV4(700, 3, nSlots).total);
  // R = 3: boss slots first, only the rest (no boss spawned / fewer slots than 3) goes to containers.
  assert.equal(r.pool.container, Math.max(0, r.pool.released - nSlots));
  // A rat never opens a POI container.
  assert.deepEqual(Object.keys(r.containers.byZone).filter((z) => z !== "wild"), []);
  for (const u of r.gained) assert.ok(["pool", "floor", "boss", "other"].includes(u.origin));
  assert.ok(r.haul.junkCr >= 0 && Number.isFinite(r.crTotal));
  const s = summarize([r]);
  assert.equal(s.raids, 1);
  assert.equal(s.metrics["junk CR extracted"]!.mean, r.haul.junkCr);
  assert.match(summaryMarkdown(s, [r]), /\| junk CR extracted \|/);
});
