/** Pure tests (no DB): tsx --test apps/web/src/lib/economy/economy.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ARMOR,
  GIVEAWAY_KIT,
  POOL,
  bossGroupNpcCount,
  bossLootKey,
  bossSlotCount,
  containerGuarded,
  generateMap,
  mulberry32,
  npcCarrierWeight,
  poolContainerEligible,
  poolContainerWeight,
  poolReleasePlanV4,
  raidBossSlots,
  raidNpcCarriers,
  rollBossSpawns,
  rollNpcSpawns,
} from "@extract/shared";
import {
  DEFAULT_RELEASE,
  normCarriers,
  planAllocation,
  rankBossSlots,
  releasePlan,
  type AllocCarrier,
  type AllocContainer,
  type AllocPick,
} from "./pool";
import { fromRaidDur, itemRefValueCr, toRaidDur } from "./value";
import { npcPriceMinor } from "./seed";
import { matchEndReportSchema, playerExitReportSchema } from "../inventory/report-schemas";
import { checkGameServerSignature, signGameServerBody } from "../game-server-hmac";
import { rollStarterKit } from "../inventory/starter";

const CONTAINERS: AllocContainer[] = [
  { idx: 0, kind: "fridge", tier: 4 },
  { idx: 1, kind: "crate", tier: 0 },
  { idx: 2, kind: "weapon_box", tier: 3 },
  { idx: 3, kind: "safe", tier: 4 },
  { idx: 4, kind: "stash", tier: 1 },
  { idx: 5, kind: "crate", tier: 2 },
  { idx: 6, kind: "stash", tier: 4 },
];
const P = (id: string, value: number, score = 0): AllocPick => ({ id, value, score });

test("releasePlan = shared poolReleasePlanV4 at the default knobs; the design's cases hold", () => {
  for (const P of [0, 5, 120, 151, 155, 160, 700])
    for (const R of [0, 1, 2, 3, 5, 8, 24])
      for (const B of [0, 1, 4, 5, 6]) assert.deepEqual(releasePlan(P, R, B), poolReleasePlanV4(P, R, B), `P${P} R${R} B${B}`);
  assert.deepEqual(DEFAULT_RELEASE, { k: 1, max: 8 });
  assert.equal(releasePlan(700, 0, 5).total, 0, "free-kit lobby: nothing, not even for bosses");
  assert.deepEqual(releasePlan(700, 3, 5), { total: 5, risk: 3, boss: 2 });
  assert.equal(releasePlan(700, 24, 5).total, 8);
  assert.deepEqual(releasePlan(120, 3, 5), { total: 3, risk: 3, boss: 0 }, "small pool: no boss top-up");
  assert.equal(releasePlan(5, 24, 5).total, 5);
  // The lever (economy memo §13): k 1.25 / max 10.
  assert.deepEqual(releasePlan(700, 4, 0, { k: 1.25, max: 10 }), { total: 5, risk: 5, boss: 0 });
  assert.equal(releasePlan(700, 24, 0, { k: 1.25, max: 10 }).total, 10);
});

test("rankBossSlots: top slots first, the tougher boss first among equals", () => {
  const r = rankBossSlots([
    { kind: "warden", slots: [1] },
    { kind: "foreman", slots: [2, 1] },
    { kind: "commander", slots: [2, 1, 1] },
  ]);
  assert.deepEqual(
    r.map((s) => `${s.kind}:${s.min}`),
    // Equal slots rank by BOSSES[kind].hp: Commander 250 > Foreman 240 on the top slots; on the rare
    // slots the Warden (300 HP) now comes first, then the Commander (250, v5 iteration 2), then the Foreman.
    ["commander:2", "foreman:2", "warden:1", "commander:1", "commander:1", "foreman:1"],
  );
});

test("planAllocation: bosses get the best by tier score, the rest only T3/T4 pool kinds, deterministic", () => {
  const picks = [P("c0", 300), P("top1", 1600, 2), P("r1", 700, 1), P("c1", 900), P("top2", 1200, 2), P("r2", 500, 1)];
  const bosses = [
    { kind: "foreman" as const, slots: [2, 1] },
    { kind: "commander" as const, slots: [2, 1, 1] },
  ];
  const a = planAllocation(picks, CONTAINERS, bosses, 42);
  assert.deepEqual(a.get(bossLootKey("commander")), ["top1", "r1", "r2"]);
  assert.deepEqual(a.get(bossLootKey("foreman")), ["top2", "c1"], "fallback: best available for the rare slot");
  assert.deepEqual([...a.keys()].filter((k) => !k.startsWith("boss:")).length, 1);
  const placed = [...a.entries()].filter(([k]) => !k.startsWith("boss:"));
  assert.ok(placed.every(([k]) => k === "2" || k === "3"), `container keys ${placed.map(([k]) => k)}`);
  assert.deepEqual(planAllocation(picks, CONTAINERS, bosses, 42), a);
});

test("planAllocation: never below tier 3, never fridge / stash; reuses containers; no eligible → nothing placed", () => {
  const picks = Array.from({ length: 9 }, (_, i) => P(`i${i}`, i));
  for (let seed = 0; seed < 200; seed++) {
    const a = planAllocation(picks, CONTAINERS, [], seed);
    assert.ok([...a.keys()].every((k) => k === "2" || k === "3"), `seed ${seed}: ${[...a.keys()]}`);
    assert.equal([...a.values()].flat().length, 9, "two eligible containers, reused");
  }
  const low: AllocContainer[] = [{ idx: 1, kind: "crate", tier: 2 }, { idx: 6, kind: "stash", tier: 4 }, { idx: 0, kind: "fridge", tier: 4 }];
  assert.equal(planAllocation(picks, low, [], 1).size, 0);
  assert.equal(planAllocation(picks, [], [], 1).size, 0);
  assert.deepEqual([...planAllocation(picks, [], [{ kind: "warden", slots: [1] }], 1).keys()], ["boss:warden"]);
});

test("planAllocation on the Steppe: ≈68 % of container uniques in guarded (boss) containers", () => {
  const map = generateMap("steppe");
  const containers: AllocContainer[] = map.containers.map((c, idx) => ({
    idx,
    kind: c.kind,
    tier: c.tier,
    guarded: containerGuarded(c, map.bosses),
  }));
  const eligible = containers.filter((c) => c.tier >= POOL.CONTAINER_MIN_TIER && c.kind !== "stash" && c.kind !== "fridge" && c.kind !== "pc" && c.kind !== "med_case");
  assert.ok(eligible.length >= 60, `eligible ${eligible.length}`);
  const byIdx = new Map(containers.map((c) => [String(c.idx), c]));
  let guarded = 0;
  let total = 0;
  for (let seed = 0; seed < 10_000; seed++) {
    const a = planAllocation([P("x", 1), P("y", 2), P("z", 3)], containers, [], seed);
    for (const [k, ids] of a) {
      const c = byIdx.get(k)!;
      assert.ok(c.tier >= 3, `tier ${c.tier}`);
      total += ids.length;
      if (c.guarded) guarded += ids.length;
    }
  }
  assert.equal(total, 30_000);
  const share = guarded / total;
  assert.ok(share > 0.6 && share < 0.76, `guarded share ${share.toFixed(3)}`);
});

// ---------------------------------------------------------------- NPC MODEL v5: carriers

const CARRIERS: AllocCarrier[] = [
  { key: "npc:7.0", tier: 3 },
  { key: "npc:7.1", tier: 3 },
  { key: "npc:12.0", tier: 4 },
];

test("planAllocation v5: no carriers → exactly the v4 placement (same draws)", () => {
  const picks = Array.from({ length: 9 }, (_, i) => P(`i${i}`, i * 10, i % 3 === 0 ? 2 : 0));
  const bosses = [{ kind: "foreman" as const, slots: [2, 1] }];
  for (let seed = 0; seed < 100; seed++) {
    assert.deepEqual(planAllocation(picks, CONTAINERS, bosses, seed, []), planAllocation(picks, CONTAINERS, bosses, seed));
    assert.deepEqual(planAllocation(picks, CONTAINERS, bosses, seed, undefined), planAllocation(picks, CONTAINERS, bosses, seed));
  }
});

test("planAllocation v5: bosses first, then containers + carriers; a carrier never holds two; deterministic", () => {
  const picks = Array.from({ length: 12 }, (_, i) => P(`i${i}`, 100 + i, i < 2 ? 2 : 0));
  const bosses = [{ kind: "warden" as const, slots: [1] }];
  let onCarriers = 0;
  for (let seed = 0; seed < 500; seed++) {
    const a = planAllocation(picks, CONTAINERS, bosses, seed, CARRIERS);
    assert.deepEqual(a.get(bossLootKey("warden")), ["i1"], "best item to the boss slot");
    assert.equal([...a.values()].flat().length, 12, "containers take the overflow in rounds");
    for (const [k, ids] of a) {
      if (k.startsWith("npc:")) {
        assert.equal(ids.length, 1, `seed ${seed}: ${k} holds ${ids.length}`);
        onCarriers++;
      } else if (!k.startsWith("boss:")) assert.ok(k === "2" || k === "3", `seed ${seed}: container ${k}`);
    }
    assert.deepEqual(planAllocation(picks, CONTAINERS, bosses, seed, CARRIERS), a);
  }
  assert.ok(onCarriers > 0, "carriers do get items");
});

test("planAllocation v5: carriers only (no T3/T4 container) take one each; the rest stays out", () => {
  const picks = Array.from({ length: 6 }, (_, i) => P(`i${i}`, i));
  const low: AllocContainer[] = [{ idx: 1, kind: "crate", tier: 2 }];
  for (let seed = 0; seed < 50; seed++) {
    const a = planAllocation(picks, low, [], seed, CARRIERS);
    assert.deepEqual([...a.keys()].sort(), ["npc:12.0", "npc:7.0", "npc:7.1"]);
    assert.deepEqual([...a.values()].map((v) => v.length), [1, 1, 1]);
  }
  // The most valuable picks go first.
  const a = planAllocation(picks, low, [], 3, CARRIERS);
  assert.deepEqual([...a.values()].flat().sort(), ["i3", "i4", "i5"]);
});

test("normCarriers: never below T3, well-formed keys once each, sorted", () => {
  const n = normCarriers([
    { key: "npc:9.1", tier: 4 },
    { key: "npc:9.1", tier: 4 },
    { key: "npc:2.0", tier: 3 },
    { key: "npc:3.0", tier: 2 },
    { key: "npc:4.0", tier: 5 },
    { key: "boss:commander", tier: 4 },
    { key: "17", tier: 4 },
    { key: "npc:x.0", tier: 3 },
  ]);
  assert.deepEqual(n, [{ key: "npc:2.0", tier: 3 }, { key: "npc:9.1", tier: 4 }]);
  assert.deepEqual(normCarriers(undefined), []);
  // A T2 "carrier" is ignored by planAllocation as well.
  const a = planAllocation([P("x", 1)], [], [], 1, [{ key: "npc:3.0", tier: 2 }]);
  assert.equal(a.size, 0);
});

test("planAllocation on the Steppe with rolled carriers: share of the non-boss release follows the weights", () => {
  const map = generateMap("steppe");
  const posts = map.npcPosts ?? [];
  assert.ok(posts.length > 0, "the generator places NPC posts");
  const containers: AllocContainer[] = map.containers.map((c, idx) => ({ idx, kind: c.kind, tier: c.tier, guarded: containerGuarded(c, map.bosses) }));
  const wC = containers.filter(poolContainerEligible).reduce((s, c) => s + poolContainerWeight(c), 0);
  const N = 2000;
  let nonBoss = 0;
  let carried = 0;
  let wK = 0;
  for (let seed = 0; seed < N; seed++) {
    const spawned = rollBossSpawns(seed, map.bosses);
    const bosses = raidBossSlots(spawned);
    const carriers = raidNpcCarriers(rollNpcSpawns(seed, posts, bossGroupNpcCount(spawned)), posts);
    assert.ok(carriers.every((c) => c.tier >= 3));
    wK += carriers.reduce((s, c) => s + npcCarrierWeight(c.tier), 0);
    const rel = releasePlan(700, 24, bossSlotCount(bosses));
    assert.equal(rel.total, 8, "R = 24: the cap");
    const picks = Array.from({ length: rel.total }, (_, i) => P(`p${i}`, 100 + i, i % 3 ? 1 : 2));
    const a = planAllocation(picks, containers, bosses, seed, carriers);
    for (const [k, ids] of a) {
      if (k.startsWith("boss:")) continue;
      nonBoss += ids.length;
      if (k.startsWith("npc:")) {
        assert.equal(ids.length, 1);
        carried += ids.length;
      }
    }
  }
  const share = carried / nonBoss;
  const expected = wK / N / (wC + wK / N);
  // NPC_CARRIER.WEIGHT_MULT 5 (v5 review; was 3, design 2): the loot-yield harness measures 0.61 of the
  // ≈ 3.6 non-boss items per raid on carriers at R 24 (≈ 17 %, design 15–20 %). Pinned to the configured weights.
  assert.ok(Math.abs(share - expected) < 0.25 * expected, `carrier share ${share.toFixed(3)} vs weights ${expected.toFixed(3)}`);
  assert.ok(share > 0.05 && share < 0.4, `carrier share ${share.toFixed(3)}`);
});

test("v5 report schemas: npcKills and npcSummary survive parsing", () => {
  const start = { matchId: "6f1c2b9e-8a1d-4b7a-9c3e-2f5d6a7b8c9d" };

  const exit = playerExitReportSchema.safeParse({
    matchId: start.matchId,
    userId: "8f1c2b9e-8a1d-4b7a-9c3e-2f5d6a7b8c9d",
    exit: "extract",
    atMs: 1,
    kills: 0,
    level: 1,
    extracted: [],
    lost: [],
    destroyed: [],
    stats: { shotsFired: 1, dmgDealt: 1, containersSearched: 0, corpsesSearched: 0, bossKills: 0, npcKills: 4 },
  });
  assert.ok(exit.success);
  assert.equal(exit.data.stats.npcKills, 4, "npcKills is not stripped");

  const npcSummary = { spawned: { boss: 2, guard: 5, marauder: 31 }, killedByHumans: { boss: 1, guard: 2, marauder: 9 } };
  const end = matchEndReportSchema.safeParse({
    matchId: start.matchId,
    mapId: "steppe",
    matchSeed: 7,
    startedAt: 0,
    endedAt: 1,
    participants: [{ userId: "8f1c2b9e-8a1d-4b7a-9c3e-2f5d6a7b8c9d", nickname: "a", isBot: false, exitType: "extract", kills: 0 }],
    leftOnMap: [],
    npcSummary,
  });
  assert.ok(end.success);
  assert.deepEqual(end.data.npcSummary, npcSummary);
  assert.equal(end.data.botLost, undefined, "v5 reports carry no bot fields");
});

test("durability conversion: armor % ↔ points, weapons stay %", () => {
  assert.equal(toRaidDur("armor_3", 50), ARMOR[3].durability / 2);
  assert.equal(fromRaidDur("armor_3", ARMOR[3].durability / 2), 50);
  assert.equal(toRaidDur("rifle", 73), 73);
  assert.equal(fromRaidDur("rifle", 140), 100);
  assert.equal(fromRaidDur("rifle", Number.NaN), 0);
  assert.equal(itemRefValueCr({ def: "rifle", rarity: 3, dur: 50 }), 1750);
  assert.equal(itemRefValueCr({ def: "junk_gpu", rarity: 3, dur: 100 }), 0);
});

test("HMAC: accepts the game server's signature, rejects tampering and stale timestamps", () => {
  const secret = "s".repeat(32);
  const now = 1_700_000_000_000;
  const ts = String(now);
  const body = '{"a":1}';
  const sig = signGameServerBody(secret, ts, body);
  assert.equal(checkGameServerSignature(secret, ts, sig, body, now), "ok");
  assert.equal(checkGameServerSignature(secret, ts, sig, '{"a":2}', now), "bad_signature");
  assert.equal(checkGameServerSignature(secret, ts, sig.slice(2), body, now), "bad_signature");
  assert.equal(checkGameServerSignature(secret, ts, sig, body, now + 61_000), "stale_timestamp");
  assert.equal(checkGameServerSignature(secret, null, sig, body, now), "missing_signature");
});

test("starter kit roll follows GIVEAWAY_KIT and brings matching ammo", () => {
  const rng = mulberry32(3);
  for (let i = 0; i < 50; i++) {
    const k = rollStarterKit(rng);
    assert.ok(GIVEAWAY_KIT.weapon.some((w) => w.def === k.weapon.def && w.rarity === k.weapon.rarity));
    assert.ok(GIVEAWAY_KIT.armor.some((a) => a.def === k.armor.def));
    const ammo = k.weapon.def === "rifle" ? "ammo_light" : "ammo_shell";
    assert.ok(k.stacks.some((s) => s.def === ammo && s.qty > 0));
  }
});

test("Weapons v2: the new guns have no NPC reference price (Vlad sets it); the old ones keep theirs", () => {
  const rng = mulberry32(7);
  for (const w of ["smg", "lmg", "revolver", "crossbow"]) {
    for (const r of [0, 1, 2, 3]) assert.equal(npcPriceMinor(w, r, 100, rng), null, `${w} r${r}`);
  }
  const rifle = npcPriceMinor("rifle", 2, 100, rng);
  assert.ok(rifle !== null && rifle > 0n);
  assert.ok((npcPriceMinor("armor_2", 1, 100, rng) ?? 0n) > 0n);
});
