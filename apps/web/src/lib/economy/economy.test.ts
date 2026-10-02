/** Pure tests (no DB): tsx --test apps/web/src/lib/economy/economy.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ARMOR, GIVEAWAY_KIT, POOL, mulberry32 } from "@extract/shared";
import { planAllocation, type AllocContainer } from "./pool";
import { fromRaidDur, itemRefValueCr, toRaidDur } from "./value";
import { checkGameServerSignature, signGameServerBody } from "../game-server-hmac";
import { rollStarterKit } from "../inventory/starter";

const CONTAINERS: AllocContainer[] = [
  { idx: 0, kind: "fridge", tier: 4 },
  { idx: 1, kind: "crate", tier: 0 },
  { idx: 2, kind: "weapon_box", tier: 3 },
  { idx: 3, kind: "safe", tier: 4 },
  { idx: 4, kind: "stash", tier: 1 },
];

test("planAllocation: boss gets the best, one item per container, deterministic, no fridges", () => {
  const picks = [10, 50, 30, 20, 40, 5].map((v, i) => ({ id: `i${i}`, value: v }));
  const a = planAllocation(picks, CONTAINERS, 1, 42);
  assert.deepEqual(a.get("boss"), ["i1", "i4"]);
  assert.equal(POOL.BOSS_SHARE, 2);
  const placed = [...a.entries()].filter(([k]) => k !== "boss");
  assert.equal(placed.flatMap(([, v]) => v).length, 4);
  assert.ok(placed.every(([, v]) => v.length === 1), "4 eligible containers, 4 items");
  assert.ok(!a.has("0"), "fridge is never chosen while other kinds exist");
  assert.deepEqual(planAllocation(picks, CONTAINERS, 1, 42), a);
});

test("planAllocation: reuses containers when items outnumber them; empty map keeps items in the pool", () => {
  const picks = Array.from({ length: 9 }, (_, i) => ({ id: `i${i}`, value: i }));
  const a = planAllocation(picks, CONTAINERS, 0, 1);
  assert.equal([...a.values()].flat().length, 9);
  assert.equal(planAllocation(picks, [], 0, 1).size, 0);
  assert.deepEqual([...planAllocation(picks, [], 1, 1).keys()], ["boss"]);
});

test("planAllocation favours high tiers", () => {
  let high = 0;
  for (let s = 0; s < 400; s++) {
    const a = planAllocation([{ id: "x", value: 1 }], CONTAINERS, 0, s);
    const key = [...a.keys()][0]!;
    if (key === "2" || key === "3") high++;
  }
  // weights: crate 1, stash 4, weapon_box 16, safe 25 → 41/46 ≈ 0.89
  assert.ok(high > 320, `high-tier share ${high}/400`);
});

test("planAllocation: floor items only land in T3/T4 containers (or the boss), never elsewhere", () => {
  const picks = Array.from({ length: 8 }, (_, i) => ({ id: `f${i}`, value: i }));
  const floor = new Set(picks.map((p) => p.id));
  for (let seed = 0; seed < 50; seed++) {
    const a = planAllocation(picks, CONTAINERS, 0, seed, floor);
    const keys = [...a.keys()];
    assert.ok(keys.every((k) => k === "2" || k === "3"), `seed ${seed}: ${keys.join(",")}`);
    assert.equal([...a.values()].flat().length, 8, "dangerous containers reused when outnumbered");
  }
  const low: AllocContainer[] = [{ idx: 1, kind: "crate", tier: 0 }, { idx: 4, kind: "stash", tier: 2 }];
  assert.equal(planAllocation(picks, low, 0, 1, floor).size, 0, "no T3/T4 container: floor items stay in the pool");
  assert.deepEqual([...planAllocation(picks, low, 1, 1, floor).keys()], ["boss"], "boss stash takes its share");
  // Mixed: risk items may go anywhere eligible, floor items only high.
  const mixed = planAllocation(
    [{ id: "r0", value: 1 }, { id: "f0", value: 2 }, { id: "f1", value: 3 }],
    [...low, { idx: 9, kind: "safe", tier: 4 }],
    0,
    3,
    new Set(["f0", "f1"]),
  );
  assert.deepEqual(mixed.get("9")?.sort(), ["f0", "f1"]);
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
