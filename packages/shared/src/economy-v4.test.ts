/**
 * LOOT ECONOMY v4 ("risk drives reward"): container / floor zoning by tier, the risk-tied pool
 * release with the boss top-up, boss definitions and their pure rolls. Expected numbers come from
 * the static model (scratchpad econ4/v4model.mts) run on the real Steppe map.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BOSSES,
  BOSS_AI,
  BOT_FREE_AMMO_LIGHT,
  CONSUMABLES_CR,
  CONTAINER,
  CONTAINER_LOOT,
  FLOOR_LOOT,
  POOL,
  POOL_CONTAINER_KINDS,
  bossSlotCount,
  containerGuarded,
  containerLootFor,
  effectiveHp,
  floorLootTable,
  poolContainerEligible,
  poolContainerWeight,
  poolReleasePlanV4,
  raidBossSlots,
  rollBossJunk,
  rollBossSpawns,
  rollContainerFungibles,
  rollFloorLoot,
  rollGuardLoot,
  uniqueTierScore,
} from "./economy.js";
import { itemDef } from "./item-defs.js";
import { generateMap } from "./map/generate.js";
import { zoneAt } from "./map/query.js";
import { BOSS_CHANCE, BOSS_GUARD_COUNT } from "./map/steppe.js";
import { BOSS_KINDS, CONTAINER_KINDS, type LootTier } from "./map/types.js";
import { mulberry32 } from "./rng.js";
import { bossKindOfLootKey, bossLootKey } from "./types.js";

const m = generateMap("steppe");
const junkCr = (def: string) => {
  const d = itemDef(def);
  return d?.cat === "junk" ? (d.value ?? 0) : 0;
};
const consCr = (def: string) => {
  const c = (CONSUMABLES_CR as Record<string, { qty: number; cr: number }>)[def];
  return c ? c.cr / c.qty : 0;
};
const near = (v: number, want: number, tol: number) => Math.abs(v - want) <= want * tol;

// ───────────────────────── containers

test("containerLootFor: junk capped by tier, medkits only T3+, ammo scaled, memoized", () => {
  for (const kind of CONTAINER_KINDS) {
    for (let tier = 0; tier <= 4; tier++) {
      const t = containerLootFor({ kind, tier });
      assert.equal(containerLootFor({ kind, tier }), t, "memoized");
      for (const e of t) {
        const d = itemDef(e.def)!;
        if (d.cat === "junk") assert.ok((d.value ?? 0) <= CONTAINER.JUNK_VALUE_CAP[tier]!, `${kind} T${tier} ${e.def}`);
        if (e.def === "medkit") assert.ok(tier >= CONTAINER.MEDKIT_MIN_TIER, `${kind} T${tier} medkit`);
        assert.ok(e.qty >= 1 && e.qty <= d.stack);
        assert.ok(CONTAINER_LOOT[kind].some((x) => x.def === e.def));
      }
    }
  }
  const ammo = (kind: "stash" | "weapon_box", tier: number, def: string) => containerLootFor({ kind, tier }).find((e) => e.def === def)!.qty;
  assert.equal(ammo("stash", 0, "ammo_light"), 10, "30 rounds → 10 in the wilds");
  assert.equal(ammo("weapon_box", 2, "ammo_light"), 15);
  assert.equal(ammo("weapon_box", 3, "ammo_light"), 20);
  assert.equal(ammo("weapon_box", 4, "ammo_light"), 15);
  assert.equal(ammo("weapon_box", 0, "ammo_shell"), 3);
  assert.deepEqual(containerLootFor({ kind: "safe", tier: 2 }), [], "a safe below T3 has nothing under the cap");
  assert.ok(containerLootFor({ kind: "med_case", tier: 3 }).some((e) => e.def === "medkit"));
  assert.ok(!containerLootFor({ kind: "med_case", tier: 2 }).some((e) => e.def === "medkit"));
});

test("high-value junk left ordinary containers: GPU only in safes, cold wallet nowhere", () => {
  for (const kind of CONTAINER_KINDS) {
    const defs = CONTAINER_LOOT[kind].map((e) => e.def);
    assert.ok(!defs.includes("junk_coldwallet"), `${kind} cold wallet`);
    if (kind !== "safe") {
      assert.ok(!defs.includes("junk_gpu"), `${kind} gpu`);
      assert.ok(!defs.includes("junk_goldchain"), `${kind} gold chain`);
    }
  }
  assert.ok(CONTAINER_LOOT.safe.some((e) => e.def === "junk_gpu"));
});

test("10k random rolls never break the tier cap or put a medkit below T3", () => {
  const rng = mulberry32(77);
  for (let i = 0; i < 10_000; i++) {
    const kind = CONTAINER_KINDS[Math.floor(rng() * CONTAINER_KINDS.length)]!;
    const tier = Math.floor(rng() * 5) as LootTier;
    const out = rollContainerFungibles(Math.floor(rng() * 2 ** 31), i, { kind, tier });
    assert.ok(out.length <= CONTAINER.ROLLS[tier]!);
    for (const f of out) {
      const d = itemDef(f.def)!;
      if (d.cat === "junk") assert.ok((d.value ?? 0) <= CONTAINER.JUNK_VALUE_CAP[tier]!);
      if (f.def === "medkit") assert.ok(tier >= 3);
      assert.ok(f.qty >= 1 && f.qty <= d.stack);
    }
  }
});

test("Steppe container EV per zone class matches the v4 model (±10 %), value concentrates in T3/T4", () => {
  const SEEDS = 400;
  const tierOf = new Map(m.zones.map((z) => [z.id, z.tier]));
  const acc: Record<string, { n: number; junk: number; cons: number; empty: number }> = {};
  let junk = 0, cons = 0, junkHot = 0, hv = 0, hvWild = 0;
  for (let s = 0; s < SEEDS; s++) {
    const seed = Math.imul(s + 1, 0x9e3779b1) >>> 0;
    m.containers.forEach((c, i) => {
      const cls = c.zone ? `T${tierOf.get(c.zone)}` : "wild";
      const a = (acc[cls] ??= { n: 0, junk: 0, cons: 0, empty: 0 });
      const r = rollContainerFungibles(seed, i, c);
      a.n++;
      if (r.length === 0) a.empty++;
      for (const f of r) {
        const j = junkCr(f.def) * f.qty;
        a.junk += j;
        a.cons += consCr(f.def) * f.qty;
        junk += j;
        cons += consCr(f.def) * f.qty;
        if (c.zone === "elevator" || c.zone === "radar") junkHot += j;
        if (junkCr(f.def) >= 650) {
          hv += f.qty;
          if (!c.zone) hvWild += f.qty;
        }
      }
    });
  }
  const want: Record<string, number> = { wild: 6.7, T1: 12.8, T2: 19.2, T3: 169, T4: 173 };
  for (const [cls, w] of Object.entries(want)) {
    const a = acc[cls]!;
    assert.ok(near(a.junk / a.n, w, 0.1), `${cls} junk/container ${(a.junk / a.n).toFixed(1)} vs ${w}`);
  }
  assert.ok(Math.abs(acc.wild!.empty / acc.wild!.n - 0.79) < 0.03, `wild empty ${(acc.wild!.empty / acc.wild!.n).toFixed(3)}`);
  assert.ok(near(junk / SEEDS, 20_200, 0.1), `junk per match ${(junk / SEEDS).toFixed(0)}`);
  assert.ok(junkHot / junk >= 0.75, `elevator + radar share ${(junkHot / junk).toFixed(2)}`);
  assert.ok(near(cons / SEEDS, 2_400, 0.15), `container consumables per match ${(cons / SEEDS).toFixed(0)}`);
  assert.equal(hvWild, 0, "no 650+ CR junk in the wilds");
  assert.ok(near(hv / SEEDS, 7.1, 0.2), `high-value junk per match ${(hv / SEEDS).toFixed(1)}`);
});

// ───────────────────────── floor loot

test("floor loot: tiered spawn chance and tables; LOW has no medkit or heavy ammo", () => {
  assert.equal(FLOOR_LOOT.SPAWN_CHANCE.length, 5);
  for (const t of [FLOOR_LOOT.LOW, FLOOR_LOOT.MID]) assert.ok(!t.some((e) => e.def === "medkit"));
  assert.ok(!FLOOR_LOOT.LOW.some((e) => e.def === "ammo_heavy"));
  assert.ok(FLOOR_LOOT.HIGH.some((e) => e.def === "medkit"));
  assert.equal(floorLootTable(0), FLOOR_LOOT.LOW);
  assert.equal(floorLootTable(1), FLOOR_LOOT.LOW);
  assert.equal(floorLootTable(2), FLOOR_LOOT.MID);
  assert.equal(floorLootTable(4), FLOOR_LOOT.HIGH);
  for (const t of [FLOOR_LOOT.LOW, FLOOR_LOOT.MID, FLOOR_LOOT.HIGH]) {
    for (const e of t) {
      const d = itemDef(e.def)!;
      assert.ok(d && !d.unique && e.qty >= 1 && e.qty <= d.stack, e.def);
    }
  }
  const rng = mulberry32(5);
  const N = 20_000;
  for (let tier = 0; tier <= 4; tier++) {
    let spawned = 0;
    for (let i = 0; i < N; i++) {
      const r = rollFloorLoot(rng, tier);
      if (!r) continue;
      spawned++;
      assert.ok(floorLootTable(tier).some((e) => e.def === r.def && e.qty === r.qty));
    }
    const p = FLOOR_LOOT.SPAWN_CHANCE[tier]!;
    assert.ok(Math.abs(spawned / N - p) < 0.015, `tier ${tier} spawn ${(spawned / N).toFixed(3)} vs ${p}`);
  }
});

test("Steppe floor loot per match: ≈ 3.5k CR-eq total, wilds ≈ 9 items, medkits only on T3/T4 spots", () => {
  const SEEDS = 300;
  const rng = mulberry32(99);
  let cons = 0, wildItems = 0, wildValue = 0, medkits = 0;
  for (let s = 0; s < SEEDS; s++) {
    for (const sp of m.lootSpots) {
      const r = rollFloorLoot(rng, sp.tier);
      if (!r) continue;
      const v = consCr(r.def) * r.qty;
      cons += v;
      if (r.def === "medkit") {
        medkits++;
        assert.ok(sp.tier >= 3);
      }
      if (!zoneAt(m, sp.x, sp.y)) {
        wildItems++;
        wildValue += v + junkCr(r.def) * r.qty;
      }
    }
  }
  assert.ok(near(cons / SEEDS, 3_500, 0.15), `floor consumables per match ${(cons / SEEDS).toFixed(0)}`);
  assert.ok(wildItems / SEEDS < 14, `wild floor items per match ${(wildItems / SEEDS).toFixed(1)}`);
  assert.ok(wildValue / SEEDS < 350, `wild floor value per match ${(wildValue / SEEDS).toFixed(0)}`);
  assert.ok(near(medkits / SEEDS, 2.6, 0.3), `medkits per match ${(medkits / SEEDS).toFixed(2)}`);
});

// ───────────────────────── pool release

test("poolReleasePlanV4: risk-tied release, boss top-up gated by risk and pool size", () => {
  assert.deepEqual(poolReleasePlanV4(700, 0, 5), { total: 0, risk: 0, boss: 0 }, "free-kit lobby: nothing, not even on bosses");
  assert.deepEqual(poolReleasePlanV4(700, 3, 5), { total: 5, risk: 3, boss: 2 });
  assert.deepEqual(poolReleasePlanV4(700, 24, 5), { total: 8, risk: 8, boss: 0 });
  assert.deepEqual(poolReleasePlanV4(120, 3, 5), { total: 3, risk: 3, boss: 0 }, "pool at the reserve: no top-up");
  assert.deepEqual(poolReleasePlanV4(5, 24, 5), { total: 5, risk: 5, boss: 0 });
  assert.deepEqual(poolReleasePlanV4(700, 3, 0), { total: 3, risk: 3, boss: 0 }, "no boss spawned");
  assert.deepEqual(poolReleasePlanV4(700, 1, 99), { total: POOL.MAX_PER_MATCH, risk: 1, boss: POOL.MAX_PER_MATCH - 1 });
  assert.deepEqual(poolReleasePlanV4(POOL.BOSS_MIN_POOL + 3, 3, 6), { total: 3, risk: 3, boss: 0 }, "P − risk must exceed BOSS_MIN_POOL");
  assert.deepEqual(poolReleasePlanV4(POOL.BOSS_MIN_POOL + 3, 2, 6), { total: 6, risk: 2, boss: 4 });
  assert.deepEqual(poolReleasePlanV4(0, 3, 5), { total: 0, risk: 0, boss: 0 });
  for (let P = 0; P < 400; P += 37) {
    for (let R = 0; R < 30; R += 3) {
      for (let B = 0; B <= 6; B++) {
        const p = poolReleasePlanV4(P, R, B);
        assert.ok(p.total <= Math.min(P, POOL.MAX_PER_MATCH) && p.total === p.risk + p.boss && p.boss >= 0);
        assert.ok(p.risk <= R, "container supply never exceeds the risk");
      }
    }
  }
});

test("uniqueTierScore: top / rare / rest", () => {
  assert.equal(uniqueTierScore("rifle", 3), 2);
  assert.equal(uniqueTierScore("sniper", 2), 2);
  assert.equal(uniqueTierScore("shotgun", 1), 1);
  assert.equal(uniqueTierScore("pistol", 0), 0);
  assert.equal(uniqueTierScore("armor_3", 0), 2);
  assert.equal(uniqueTierScore("armor_2", 1), 1);
  assert.equal(uniqueTierScore("armor_1", 3), 0, "armor scores by level, not rarity");
  assert.equal(uniqueTierScore("backpack_3", 2), 2);
  assert.equal(uniqueTierScore("backpack_2", 1), 1);
  assert.equal(uniqueTierScore("backpack_1", 0), 0);
  assert.equal(uniqueTierScore("junk_gpu", 3), 0);
  assert.equal(uniqueTierScore("nope", 3), 0);
});

test("pool containers: T3/T4 crate/toolbox/weapon_box/safe only; guarded ≈ 68 % of placements on the Steppe", () => {
  assert.ok(!POOL_CONTAINER_KINDS.includes("stash") && !POOL_CONTAINER_KINDS.includes("fridge"));
  assert.equal(poolContainerEligible({ kind: "safe", tier: 2 }), false);
  assert.equal(poolContainerEligible({ kind: "stash", tier: 4 }), false);
  assert.equal(poolContainerEligible({ kind: "weapon_box", tier: 3 }), true);
  assert.equal(poolContainerWeight({ tier: 3 }), 16);
  assert.equal(poolContainerWeight({ tier: 4, guarded: true }), 100);
  const elig = m.containers.filter(poolContainerEligible);
  assert.equal(elig.length, 70);
  const guarded = elig.filter((c) => containerGuarded(c, m.bosses));
  assert.equal(guarded.length, 24);
  assert.equal(guarded.filter((c) => c.zone === "elevator").length, 7);
  assert.equal(guarded.filter((c) => c.zone === "radar").length, 17);
  const w = (c: (typeof elig)[number]) => poolContainerWeight({ tier: c.tier, guarded: containerGuarded(c, m.bosses) });
  const share = guarded.reduce((a, c) => a + w(c), 0) / elig.reduce((a, c) => a + w(c), 0);
  assert.ok(share > 0.6 && share < 0.78, `guarded weight share ${share.toFixed(3)}`);
  assert.equal(containerGuarded({ x: 0, y: 0 }, []), false);
  assert.equal(containerGuarded({ x: 0, y: POOL.GUARDED_RADIUS_PX }, [{ x: 0, y: 0 }]), true);
  assert.equal(containerGuarded({ x: 0, y: POOL.GUARDED_RADIUS_PX + 1 }, [{ x: 0, y: 0 }]), false);
});

// ───────────────────────── bosses

test("BOSSES agree with the map (chance, guard posts) and reference real defs", () => {
  assert.deepEqual([...BOSS_KINDS].sort(), Object.keys(BOSSES).sort());
  for (const k of BOSS_KINDS) {
    const b = BOSSES[k];
    assert.equal(b.kind, k);
    assert.equal(b.spawnChance, BOSS_CHANCE[k]);
    assert.equal(b.guards.length, BOSS_GUARD_COUNT[k]);
    assert.ok(b.poolSlots.length >= 1);
    for (const j of b.junk) assert.equal(itemDef(j.def)?.cat, "junk", j.def);
    assert.ok(b.hp > 100 && b.ammo > 0);
  }
  assert.deepEqual(BOSSES.commander.poolSlots, [2, 1, 1]);
  assert.deepEqual(BOSSES.foreman.poolSlots, [2, 1]);
  assert.deepEqual(BOSSES.warden.poolSlots, [1]);
  assert.ok(BOSS_AI.NO_BREAK);
  assert.equal(BOT_FREE_AMMO_LIGHT, 90);
});

test("effective HP and boss junk EV match the design", () => {
  assert.equal(effectiveHp(BOSSES.commander.hp, BOSSES.commander.armor), 580);
  assert.equal(effectiveHp(BOSSES.foreman.hp, BOSSES.foreman.armor), 430);
  assert.equal(Math.round(effectiveHp(BOSSES.warden.hp, BOSSES.warden.armor)), 313);
  assert.equal(effectiveHp(100, 0), 100);
  const ev = (k: keyof typeof BOSSES) => BOSSES[k].junk.reduce((a, j) => a + j.chance * j.qty * junkCr(j.def), 0);
  assert.equal(Math.round(ev("commander")), 2980);
  assert.equal(Math.round(ev("foreman")), 2150);
  assert.equal(Math.round(ev("warden")), 925);
  // Rolled EV converges to the table EV.
  let sum = 0;
  const N = 4000;
  for (let s = 0; s < N; s++) for (const f of rollBossJunk(s * 2654435761, "commander")) sum += junkCr(f.def) * f.qty;
  assert.ok(near(sum / N, 2980, 0.06), `commander junk ${(sum / N).toFixed(0)}`);
});

test("rollBossSpawns: deterministic per seed, frequency ≈ chance, expected slots ≈ 4.3", () => {
  assert.deepEqual(rollBossSpawns(1234, m.bosses), rollBossSpawns(1234, m.bosses));
  const N = 20_000;
  const count: Record<string, number> = {};
  let slots = 0;
  for (let s = 0; s < N; s++) {
    const sp = rollBossSpawns(s * 7919, m.bosses);
    for (const b of sp) count[b.kind] = (count[b.kind] ?? 0) + 1;
    slots += bossSlotCount(raidBossSlots(sp));
  }
  for (const k of BOSS_KINDS) assert.ok(Math.abs(count[k]! / N - BOSS_CHANCE[k]) < 0.015, `${k} ${(count[k]! / N).toFixed(3)}`);
  assert.ok(Math.abs(slots / N - 4.3) < 0.08, `slots ${(slots / N).toFixed(2)}`);
  assert.deepEqual(rollBossSpawns(1, []), []);
  assert.deepEqual(raidBossSlots([{ kind: "foreman" }]), [{ kind: "foreman", slots: [2, 1] }]);
});

test("boss and guard drops are deterministic and non-empty where promised", () => {
  for (const k of BOSS_KINDS) assert.deepEqual(rollBossJunk(42, k), rollBossJunk(42, k));
  for (let s = 0; s < 200; s++) {
    assert.ok(rollBossJunk(s, "commander").some((f) => f.def === "junk_keycard"), "keycard 100 %");
    assert.ok(rollBossJunk(s, "foreman").some((f) => f.def === "junk_hdd" && f.qty === 2));
    assert.ok(rollBossJunk(s, "warden").some((f) => f.def === "junk_battery" && f.qty === 3));
  }
  const g = rollGuardLoot(42, "commander", 2, 4);
  assert.deepEqual(rollGuardLoot(42, "commander", 2, 4), g);
  assert.ok(g.some((f) => f.def === "ammo_heavy" && f.qty === 10), "sniper guard: heavy ammo");
  assert.ok(g.some((f) => f.def === "bandage"));
  const w = rollGuardLoot(7, "warden", 0, 2);
  assert.ok(w.some((f) => f.def === "ammo_light" && f.qty >= 30));
  for (const f of w) if (itemDef(f.def)!.cat === "junk") assert.ok(junkCr(f.def) <= CONTAINER.JUNK_VALUE_CAP[2]!);
});

test("boss loot keys", () => {
  assert.equal(bossLootKey("commander"), "boss:commander");
  assert.equal(bossKindOfLootKey("boss:warden"), "warden");
  assert.equal(bossKindOfLootKey("boss"), null);
  assert.equal(bossKindOfLootKey("boss:nobody"), null);
  assert.equal(bossKindOfLootKey("12"), null);
});
