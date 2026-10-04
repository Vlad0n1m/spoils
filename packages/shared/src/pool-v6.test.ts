/**
 * WORLD v6 lost-pool release per entry and the boss bag gate (spec §9 T4, D17 / D19).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { WORLD } from "./constants.js";
import { POOL, bossFillPlan, poolReleaseForEntry, type EntryReleaseInput } from "./economy.js";

const MIN = 60_000;
const CLOSE = WORLD.CYCLE_MS - WORLD.ENTRY_CLOSE_MS;
const base: EntryReleaseInput = {
  poolSize: 500, entryRisk: 3, userCycleMaxRisk: 0, userCycleReleased: 0, userDayReleased: 0,
  shardReleased: 0, riskUsers: 1, atMs: 5 * MIN, entryCloseMs: CLOSE, targets: 30,
};
const rel = (o: Partial<EntryReleaseInput>) => poolReleaseForEntry({ ...base, ...o });

test("T4 config", () => {
  assert.equal(CLOSE, 35 * MIN);
  assert.equal(POOL.CYCLE_BASE, 4);
  assert.equal(POOL.CYCLE_PER_RISK_USER, 0.5);
  assert.equal(POOL.CYCLE_MAX, 24);
  assert.equal(POOL.USER_DAILY_MAX, 8);
  assert.equal(POOL.LATE_TAPER_MS, 15 * MIN);
  assert.equal(POOL.APPLY_AFTER_MS, 8 * MIN);
  assert.equal(POOL.PLACE_MIN_HUMAN_PX, 1500);
  assert.equal(POOL.PLACE_RETRY_MS, 10_000);
  assert.equal(POOL.TOP_RESERVE, 20);
  assert.equal(POOL.BOSS_ENGAGED_MS, 60_000);
  assert.equal(POOL.RISK_K, 1.0, "unchanged");
});

test("T4 first entry releases round(K × risk); re-entry with the same gear releases 0", () => {
  assert.deepEqual(rel({}), { n: 3, budget: 3, cap: 5, taper: 1 });
  // Extracted, re-entered with the same 3 risked items.
  const again = rel({ userCycleMaxRisk: 3, userCycleReleased: 3 });
  assert.equal(again.n, 0);
  assert.equal(again.budget, 0);
  // Re-entry with more gear: only the delta.
  assert.equal(rel({ entryRisk: 5, userCycleMaxRisk: 3, userCycleReleased: 3 }).n, 2);
  // Re-entry with less gear: the cycle max still counts, nothing new.
  assert.equal(rel({ entryRisk: 1, userCycleMaxRisk: 3, userCycleReleased: 3 }).n, 0);
  // Free kit, no earlier risk.
  assert.equal(rel({ entryRisk: 0 }).n, 0);
  // K from economy_params.
  assert.equal(rel({ entryRisk: 2, k: 1.5 }).budget, 3);
});

test("T4 late taper at 20 / 27.5 / 34 min", () => {
  const at = (m: number) => rel({ entryRisk: 4, riskUsers: 2, atMs: m * MIN });
  assert.equal(at(20).taper, 1);
  assert.equal(at(20).n, 4);
  assert.equal(at(27.5).taper, 0.5);
  assert.equal(at(27.5).n, 2);
  assert.ok(Math.abs(at(34).taper - 1 / 15) < 1e-12);
  assert.equal(at(34).n, 0);
  assert.equal(at(36).taper, 0, "after entry close");
  assert.equal(at(0).taper, 1);
});

test("T4 fewer than 8 targets → 0; else ≤ floor(targets / 3)", () => {
  assert.equal(rel({ targets: 7 }).n, 0);
  assert.equal(rel({ targets: 0 }).n, 0);
  assert.equal(rel({ targets: 8 }).n, 2);
  assert.equal(rel({ targets: 9 }).n, 3);
  assert.equal(rel({ entryRisk: 8, riskUsers: 20, targets: 14 }).n, 4);
});

test("T4 daily cap of 8 per user", () => {
  assert.equal(rel({ userDayReleased: 7 }).n, 1);
  assert.equal(rel({ userDayReleased: 8 }).n, 0);
  assert.equal(rel({ userDayReleased: 12 }).n, 0);
  assert.equal(rel({ entryRisk: 12, riskUsers: 30, targets: 60 }).n, POOL.USER_DAILY_MAX);
});

test("T4 shard cap = min(24, 4 + ceil(0.5 × riskUsers)) − shardReleased", () => {
  for (const u of [0, 1, 2, 3, 10, 39, 40, 41, 100]) {
    const want = Math.min(24, 4 + Math.ceil(0.5 * u));
    assert.equal(rel({ riskUsers: u }).cap, want, `riskUsers ${u}`);
  }
  assert.equal(rel({ riskUsers: 3, shardReleased: 5 }).cap, 1);
  assert.equal(rel({ riskUsers: 3, shardReleased: 5 }).n, 1);
  assert.equal(rel({ riskUsers: 3, shardReleased: 9 }).cap, 0);
  assert.equal(rel({ riskUsers: 3, shardReleased: 9 }).n, 0);
  // Pool size bounds too: never below POOL.MIN_RESERVE (04.10).
  assert.equal(POOL.MIN_RESERVE, 150);
  assert.equal(rel({ poolSize: POOL.MIN_RESERVE + 2 }).n, 2);
  assert.equal(rel({ poolSize: POOL.MIN_RESERVE }).n, 0);
  assert.equal(rel({ poolSize: 2 }).n, 0);
  assert.equal(rel({ poolSize: 0 }).n, 0);
});

test("T4 bossFillPlan gates: shard risk below slots, pool ≤ 150 after the fill, top reserve, once", () => {
  const slots = [2, 1, 1];
  const ok = { slots, shardRiskSum: 3, anyTopRisk: true, poolSize: 400, topInPool: 40, filled: false };
  assert.deepEqual(bossFillPlan(ok), { n: 3, maxTier: 2, maxTop: 3 });
  assert.deepEqual(bossFillPlan({ ...ok, shardRiskSum: 2 }), { n: 0, maxTier: 0, maxTop: 0 }, "shard risk below the slot count");
  assert.deepEqual(bossFillPlan({ ...ok, poolSize: 153 }), { n: 0, maxTier: 0, maxTop: 0 }, "pool − n = 150 is not > 150");
  assert.equal(bossFillPlan({ ...ok, poolSize: 154 }).n, 3);
  assert.deepEqual(bossFillPlan({ ...ok, topInPool: 20 }), { n: 3, maxTier: 1, maxTop: 0 }, "top reserve: > 20 top items needed");
  // Review fix: the fill never takes the top tier below the reserve (21 top → at most 1 top item).
  assert.deepEqual(bossFillPlan({ ...ok, topInPool: 21 }), { n: 3, maxTier: 2, maxTop: 1 });
  assert.deepEqual(bossFillPlan({ ...ok, topInPool: 22 }), { n: 3, maxTier: 2, maxTop: 2 });
  assert.deepEqual(bossFillPlan({ ...ok, anyTopRisk: false }), { n: 3, maxTier: 1, maxTop: 0 }, "nobody risked a top item");
  assert.deepEqual(bossFillPlan({ ...ok, filled: true }), { n: 0, maxTier: 0, maxTop: 0 }, "once per shard-cycle");
  assert.deepEqual(bossFillPlan({ ...ok, slots: [] }), { n: 0, maxTier: 0, maxTop: 0 });
});
