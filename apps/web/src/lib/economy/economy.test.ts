/** Pure tests (no DB): tsx --test apps/web/src/lib/economy/economy.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ARMOR,
  GIVEAWAY_KIT,
  POOL,
  bossLootKey,
  containerGuarded,
  generateMap,
  mulberry32,
  poolReleasePlanV4,
} from "@extract/shared";
import { DEFAULT_RELEASE, planAllocation, rankBossSlots, releasePlan, type AllocContainer, type AllocPick } from "./pool";
import { fromRaidDur, itemRefValueCr, toRaidDur } from "./value";
import { raidStartRequestSchema } from "../inventory/report-schemas";
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
    ["commander:2", "foreman:2", "commander:1", "commander:1", "foreman:1", "warden:1"],
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

test("raids/start schema keeps v4 bosses[] and containers[].guarded; rejects an unknown boss kind", () => {
  const body = {
    matchId: "6f1c2b9e-8a1d-4b7a-9c3e-2f5d6a7b8c9d",
    mode: "live",
    mapId: "steppe",
    matchSeed: 7,
    players: [],
    containers: [{ idx: 3, kind: "safe", tier: 4, guarded: true }],
    bossSlots: 6,
    bosses: [{ kind: "commander", slots: [2, 1, 1] }, { kind: "warden", slots: [1] }],
  };
  const r = raidStartRequestSchema.safeParse(body);
  assert.ok(r.success);
  assert.deepEqual(r.data.bosses, body.bosses);
  assert.equal(r.data.containers[0]!.guarded, true);
  assert.equal(raidStartRequestSchema.safeParse({ ...body, bosses: [{ kind: "dragon", slots: [2] }] }).success, false);
  const legacy = raidStartRequestSchema.safeParse({ ...body, bosses: undefined, containers: [{ idx: 3, kind: "safe", tier: 4 }] });
  assert.ok(legacy.success, "an older game server still validates");
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
