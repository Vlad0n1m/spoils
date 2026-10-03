/**
 * Loot-yield harness smoke (NPC MODEL v5): the in-process pool release mirrors the web rule (risk
 * count, boss slots first by tier score, containers only T3/T4, v5 marauder carriers one item each),
 * one short raid of the scripted rat runs on the real Steppe sim (humans + NPCs, no player-bots), a
 * two-human lobby gives one record per human, and the NPC threat micro-bench runs a trial.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  POOL,
  bossGroupNpcCount,
  containerGuarded,
  generateMap,
  itemDef,
  mulberry32,
  npcPostsOf,
  parseNpcCarrierKey,
  poolReleasePlanV4,
  raidBossSlots,
  raidNpcCarriers,
  rollBossSpawns,
  rollNpcSpawns,
  uniqueTierScore,
} from "@extract/shared";
import { STRATEGIES } from "./human.js";
import { lobbyHumans, parseMix, runLobbyRaid, runYieldRaid, summarize, summaryMarkdown, lobbyMarkdown } from "./loot-yield.bench.js";
import { runThreatTrial } from "./npc-threat.bench.js";
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

test("pool mirror (v5 carriers): R = 0 → 0; R = 3 → bosses only; R = 24 → some carriers, one item each, T3/T4 only", () => {
  const map = generateMap("steppe");
  const posts = npcPostsOf(map);
  const byId = new Map(posts.map((p) => [p.id, p]));
  const conts = map.containers.map((c, idx) => ({ idx, kind: c.kind, tier: c.tier, guarded: containerGuarded(c, map.bosses) }));
  let carried = 0;
  let nonBoss = 0;
  for (let s = 1; s <= 60; s++) {
    const spawned = rollBossSpawns(s, map.bosses);
    const carriers = raidNpcCarriers(rollNpcSpawns(s, posts, bossGroupNpcCount(spawned)), posts);
    const bosses = raidBossSlots(spawned);
    const nSlots = bosses.reduce((n, b) => n + b.slots.length, 0);
    const req = { matchSeed: s, containers: conts, bosses, carriers };
    const none = mirrorAllocatePool(seedPool(700, mulberry32(s)), { ...req, riskUnits: 0 }, mulberry32(s + 1));
    assert.equal(none.released, 0);
    const small = mirrorAllocatePool(seedPool(700, mulberry32(s)), { ...req, riskUnits: 3 }, mulberry32(s + 1));
    if (nSlots >= small.released) assert.equal(small.carrier, 0, `seed ${s}: R = 3 with ${nSlots} boss slots`);
    const big = mirrorAllocatePool(seedPool(700, mulberry32(s)), { ...req, riskUnits: 24 }, mulberry32(s + 1));
    assert.equal(big.carriersOffered, carriers.length);
    for (const [key, items] of Object.entries(big.containerLoot)) {
      const c = parseNpcCarrierKey(key);
      if (!c) continue;
      assert.equal(items.length, 1, `${key} holds ${items.length}`);
      assert.ok((byId.get(c.postId)?.tier ?? 0) >= 3, `${key} below T3`);
      assert.ok(carriers.some((x) => x.key === key), `${key} was not offered`);
    }
    carried += big.carrier;
    nonBoss += big.carrier + big.container;
  }
  assert.ok(carried > 0 && carried < nonBoss, `carriers ${carried} of ${nonBoss} non-boss items`);
});

test("loot-yield: one rat raid on the live Steppe sim (no player-bots) gives a well-formed record", () => {
  const r = runYieldRaid({ strategy: "rat", seed: 3 });
  assert.ok(["extract", "dead", "timeout"].includes(r.exit));
  assert.equal(r.survived, r.exit === "extract");
  assert.ok(r.minutes > 0 && r.minutes <= 30);
  assert.equal(r.riskUnits, 3);
  assert.deepEqual(r.lobby, { humans: 1, idx: 0, members: ["rat:starter"] });
  assert.equal(r.pvp.kills, 0);
  assert.ok(["", "boss", "guard", "marauder", "env"].includes(r.killedBy));
  assert.ok(r.npcs > 0 && r.npc.spawned.marauder > 0, "the match spawns its own NPCs");
  const map = generateMap("steppe");
  const nSlots = raidBossSlots(rollBossSpawns(r.matchSeed, map.bosses)).reduce((n, b) => n + b.slots.length, 0);
  assert.equal(r.pool.released, poolReleasePlanV4(700, 3, nSlots).total);
  // R = 3: boss slots first, only the rest (no boss spawned / fewer slots than 3) goes to containers / carriers.
  assert.equal(r.pool.container + r.pool.carrier, Math.max(0, r.pool.released - nSlots));
  // A rat never opens a POI container.
  assert.deepEqual(Object.keys(r.containers.byZone).filter((z) => z !== "wild"), []);
  for (const u of r.gained) assert.ok(["pool", "boss", "carrier"].includes(u.origin), u.origin);
  assert.ok(r.haul.junkCr >= 0 && Number.isFinite(r.crTotal));
  const s = summarize([r]);
  assert.equal(s.raids, 1);
  assert.equal(s.metrics["junk CR extracted"]!.mean, r.haul.junkCr);
  assert.match(summaryMarkdown(s, [r]), /\| junk CR extracted \|/);
});

test("loot-yield lobby: two scripted humans share one raid, one record each, own uids kept apart", () => {
  const { records, lobby } = runLobbyRaid({
    seed: 5,
    humans: [{ strategy: "rat", kit: "starter" }, { strategy: "rat", kit: "free" }],
  });
  assert.equal(records.length, 2);
  assert.equal(lobby.humans, 2);
  assert.deepEqual(lobby.members, ["rat:starter", "rat:free"]);
  assert.equal(lobby.lobbyR, 3);
  assert.deepEqual(records.map((r) => r.lobby.idx), [0, 1]);
  assert.equal(records[1]!.riskUnits, 0);
  assert.equal(records[0]!.matchSeed, records[1]!.matchSeed);
  assert.equal(lobby.extracted, records.filter((r) => r.survived).length);
  // Two humans never spawn on the same spot (humans-only spawn rule).
  assert.notDeepEqual(records[0]!.spawn, records[1]!.spawn);
  assert.match(lobbyMarkdown([lobby]), /Lobby raids \(1 raids, 2 scripted humans\)/);
  // The lobby draw is deterministic in the seed.
  const mix = parseMix("rat:2,poi:3,boss:1", STRATEGIES, "mix");
  const kits = parseMix("starter:3,free:1,hunter:1", ["starter", "free", "hunter"] as const, "kit-mix");
  assert.deepEqual(lobbyHumans(9, 6, mix, kits, 0.5), lobbyHumans(9, 6, mix, kits, 0.5));
  assert.equal(lobbyHumans(9, 6, mix, kits, 0.5).length, 6);
});

test("npc threat micro-bench: a marauder sees the human and never fires at an unseen target", () => {
  const t = runThreatTrial({ cls: "mid", seed: 1, windowMs: 8000 });
  assert.ok(t.placed);
  assert.ok(t.seenAfterMs >= 0, "the NPC saw the human");
  assert.equal(t.shotsUnseen, 0);
  assert.ok(t.shotHits <= t.shots && t.hits >= t.shotHits);
});
