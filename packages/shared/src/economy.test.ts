import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AUTOSELL,
  BOUND_OFFERS,
  CONSUMABLES_CR,
  CONTAINER,
  CR,
  GIVEAWAY_KIT,
  MARKET,
  POOL,
  PROGRESSION,
  armorPct,
  armorPoints,
  dogTagPairMult,
  junkSellCr,
  levelForXp,
  marketFeeMinor,
  nextAutosellMult,
  poolEntry,
  poolReleaseCount,
  poolReleasePlan,
  rollContainerFungibles,
  priceBand,
  takeTreasuryTax,
  templateKey,
  trimmedMedian,
  xpToNext,
} from "./economy.js";
import { DOG_TAG, JUNK_IDS, dogTagCr, itemDef, junkCredits } from "./item-defs.js";
import { ARMOR } from "./items.js";

test("starting balance is 1000 CR", () => {
  assert.equal(CR.START_BALANCE, 1000);
});

test("nextAutosellMult: ±3%/day inside [0.6, 1.3], needs a sample of 50", () => {
  assert.equal(nextAutosellMult(1, 50_000, AUTOSELL.MIN_SAMPLE - 1), 1, "small sample: unchanged");
  assert.ok(Math.abs(nextAutosellMult(1, 9000, 100) - 0.97) < 1e-12);
  assert.ok(Math.abs(nextAutosellMult(1, 1000, 100) - 1.03) < 1e-12);
  assert.equal(nextAutosellMult(1, 5000, 100), 1, "inside the band");
  assert.equal(nextAutosellMult(0.61, 9000, 100), AUTOSELL.MIN);
  assert.equal(nextAutosellMult(1.29, 10, 100), AUTOSELL.MAX);
  // A long inflationary streak converges to the floor and stays there.
  let m = 1;
  for (let d = 0; d < 100; d++) m = nextAutosellMult(m, 20_000, 500);
  assert.equal(m, AUTOSELL.MIN);
});

test("junkSellCr: per-line floor, ignores non-junk, dog tags by level, pair rule, trader bonus", () => {
  const items = [
    { def: "junk_apple", qty: 3 },
    { def: "rifle", qty: 1 },
    { def: "junk_dogtag", qty: 1, lvl: 4, label: "bob" },
    { def: "junk_gpu", qty: 1 },
    { def: "nope", qty: 9 },
  ];
  const r = junkSellCr(items, 1);
  assert.deepEqual(r.lines, [
    { def: "junk_apple", qty: 3, cr: 60 },
    { def: "junk_dogtag", qty: 1, cr: dogTagCr(4), label: "bob" },
    { def: "junk_gpu", qty: 1, cr: 1500 },
  ]);
  assert.equal(r.total, 60 + dogTagCr(4) + 1500);
  assert.equal(r.total, junkCredits(items), "mult 1 equals the shared junkCredits");
  const low = junkSellCr([{ def: "junk_bolts", qty: 3 }], 0.97);
  assert.equal(low.total, Math.floor(30 * 3 * 0.97));
  assert.equal(junkSellCr([{ def: "junk_gpu", qty: 1 }], 1, 0.1).total, 1650);
  // The pair-repeat rule zeroes the third tag of the same victim inside the window.
  const tags = [0, 1, 2].map(() => ({ def: "junk_dogtag", qty: 1, lvl: 2, label: "alt" }));
  const paid = junkSellCr(tags, 1, 0, (i) => dogTagPairMult(i));
  assert.deepEqual(paid.lines.map((l) => l.cr), [dogTagCr(2), dogTagCr(2), 0]);
  assert.equal(dogTagPairMult(DOG_TAG.REPEAT_FREE - 1), 1);
  assert.equal(dogTagPairMult(DOG_TAG.REPEAT_FREE), 0);
  assert.deepEqual(junkSellCr([], 1), { total: 0, lines: [] });
});

test("junk table: 16 ids, economy CR prices, all real defs", () => {
  assert.equal(JUNK_IDS.length, 16);
  const prices = JUNK_IDS.filter((id) => id !== "junk_dogtag").map((id) => itemDef(id)!.value!);
  assert.ok(Math.min(...prices) === 20 && Math.max(...prices) === 2800, "economy memo range 20–2800 CR");
  assert.equal(dogTagCr(0), DOG_TAG.BASE_CR);
  assert.equal(dogTagCr(3.9), DOG_TAG.BASE_CR + 3 * DOG_TAG.PER_LEVEL_CR);
  assert.equal(dogTagCr(-5), DOG_TAG.BASE_CR);
});

test("poolEntry: bound never enters; a break costs 8 dur; worn out items are destroyed", () => {
  assert.equal(poolEntry({ dur: 80, bound: true }, true), null);
  assert.equal(poolEntry({ dur: 80, bound: false }, true), 80 - POOL.BREAK_DUR_LOSS);
  assert.equal(poolEntry({ dur: 80, bound: false }, false), 80, "left on the map: no wear");
  assert.equal(poolEntry({ dur: POOL.BREAK_DUR_LOSS, bound: false }, true), null);
  assert.equal(poolEntry({ dur: 0, bound: false }, false), null);
});

test("poolReleaseCount = round(1.0 × riskUnits), capped by MAX_PER_MATCH and the pool", () => {
  assert.equal(POOL.RISK_K, 1);
  assert.equal(POOL.MAX_PER_MATCH, 8);
  assert.equal(poolReleaseCount(100, 0), 0, "free-kit lobby: no pool loot");
  assert.equal(poolReleaseCount(100, 1), 1);
  assert.equal(poolReleaseCount(100, 3), 3);
  assert.equal(poolReleaseCount(100, 50), POOL.MAX_PER_MATCH);
  assert.equal(poolReleaseCount(3, 50), 3);
  assert.equal(poolReleaseCount(0, 5), 0);
  assert.equal(poolReleaseCount(10, -4), 0);
});

test("takeTreasuryTax: 1% accrues, whole items taken most valuable first, deterministic", () => {
  const a = takeTreasuryTax(0, [{ uid: "a", value: 500 }, { uid: "b", value: 300 }]);
  assert.deepEqual(a, { taken: [], acc: 8 });
  // The accumulator carries over and eventually pays for an item.
  let acc = 0;
  const taken: string[] = [];
  for (let i = 0; i < 120; i++) {
    const r = takeTreasuryTax(acc, [{ uid: `x${i}`, value: 100 }, { uid: `y${i}`, value: 40 }]);
    acc = r.acc;
    taken.push(...r.taken);
  }
  // 120 × 140 × 1% = 168 value accrued → items worth ≤ 168 taken in total, acc ≥ 0.
  assert.ok(taken.length >= 1 && acc >= 0 && acc < 100 + 40);
  const r1 = takeTreasuryTax(250, [{ uid: "s", value: 40 }, { uid: "g", value: 200 }, { uid: "z", value: 0 }]);
  assert.deepEqual(r1.taken, ["g", "s"], "most valuable first; zero-value never taken");
  assert.ok(Math.abs(r1.acc - (250 + 2.4 - 240)) < 1e-9);
  assert.deepEqual(takeTreasuryTax(250, [{ uid: "s", value: 40 }, { uid: "g", value: 200 }, { uid: "z", value: 0 }]), r1);
});

test("market: fee rounds up, trimmed median, price band", () => {
  assert.equal(MARKET.FEE_BPS, 500);
  assert.equal(marketFeeMinor(100n), 5n);
  assert.equal(marketFeeMinor(101n), 6n, "5.05 rounds up: the house never loses a unit");
  assert.equal(marketFeeMinor(0n), 0n);
  assert.equal(marketFeeMinor(1n), 1n);
  assert.equal(marketFeeMinor(10_000n, 250), 250n);

  assert.equal(trimmedMedian([]), null);
  assert.equal(trimmedMedian([7n]), 7n);
  const prices = [1000n, 1n, 5n, 3n, 2n, 4n, 9n, 6n, 8n, 7n];
  const copy = [...prices];
  assert.equal(trimmedMedian(prices), 6n, "drops 1 and 1000, median of 2..9 (upper middle)");
  assert.deepEqual(prices, copy, "input not mutated");

  assert.deepEqual(priceBand(null, null), { min: 1n, max: null });
  assert.deepEqual(priceBand(null, 50n), { min: 50n, max: null });
  assert.deepEqual(priceBand(1000n, null), { min: 500n, max: 4000n });
  assert.deepEqual(priceBand(1000n, 700n), { min: 700n, max: 4000n });
  assert.equal(MARKET.LISTING_FEE_CR.length, 4);
});

test("progression: xpToNext grows, levelForXp inverts it", () => {
  assert.equal(levelForXp(0), 1);
  assert.equal(levelForXp(xpToNext(1) - 1), 1);
  assert.equal(levelForXp(xpToNext(1)), 2);
  let xp = 0;
  for (let l = 1; l < 30; l++) {
    assert.equal(levelForXp(xp), l);
    assert.ok(xpToNext(l + 1) > xpToNext(l));
    xp += xpToNext(l);
  }
  // Memo calibration: ~180 XP per raid → level 5 after roughly 14 raids.
  const perRaid = PROGRESSION.XP_RAID + 0.3 * PROGRESSION.XP_EXTRACT + 0.1 * PROGRESSION.XP_KILL;
  const raidsToL5 = Math.ceil([1, 2, 3, 4].reduce((a, l) => a + xpToNext(l), 0) / perRaid);
  assert.ok(raidsToL5 >= 10 && raidsToL5 <= 18, String(raidsToL5));
});

test("armorPoints / armorPct convert at the API boundary and clamp", () => {
  const max = ARMOR[2].durability;
  assert.equal(armorPoints(max, 50), max / 2);
  assert.equal(armorPct(max, max / 2), 50);
  assert.equal(armorPoints(max, 150), max);
  assert.equal(armorPoints(max, -3), 0);
  assert.equal(armorPct(max, max * 2), 100);
  assert.equal(armorPct(0, 10), 0);
  for (let p = 0; p <= 100; p += 7) assert.ok(Math.abs(armorPct(max, armorPoints(max, p)) - p) < 1e-9);
});

test("templateKey: weapons by type and rarity, armor/backpacks by level, others none", () => {
  assert.equal(templateKey({ def: "rifle", rarity: 2 }), "weapon:rifle:2");
  assert.equal(templateKey({ def: "sniper", rarity: 9 }), "weapon:sniper:3", "rarity clamped");
  assert.equal(templateKey({ def: "armor_3", rarity: 0 }), "armor:3");
  assert.equal(templateKey({ def: "backpack_1", rarity: 0 }), "backpack:1");
  assert.equal(templateKey({ def: "junk_gpu", rarity: 3 }), null);
  assert.equal(templateKey({ def: "bandage", rarity: 0 }), null);
  assert.equal(templateKey({ def: "missing", rarity: 0 }), null);
});

test("tables reference real item defs with valid quantities", () => {
  for (const [id, o] of Object.entries(CONSUMABLES_CR)) {
    const d = itemDef(id);
    assert.ok(d && (d.cat === "ammo" || d.cat === "med"), id);
    assert.ok(o.qty >= 1 && o.cr > 0);
  }
  for (const group of [GIVEAWAY_KIT.weapon, GIVEAWAY_KIT.armor, GIVEAWAY_KIT.backpack]) {
    for (const e of group) assert.ok(itemDef(e.def)?.unique, e.def);
  }
  for (const o of BOUND_OFFERS) assert.ok(itemDef(o.def)?.unique, o.def);
  // One entry per LootTier 0..4.
  assert.equal(CONTAINER.ROLLS.length, 5);
  assert.equal(CONTAINER.FILL_CHANCE.length, 5);
  for (const p of CONTAINER.FILL_CHANCE) assert.ok(p > 0 && p <= 1);
});

test("legacy poolReleasePlan: v4 has no free floor (risk-only by default)", () => {
  assert.equal(POOL.MIN_RELEASE_PER_MATCH, 0);
  assert.deepEqual(poolReleasePlan(700, 0), { total: 0, risk: 0, floor: 0 }, "free-kit lobby gets nothing");
  assert.deepEqual(poolReleasePlan(700, 3), { total: 3, risk: 3, floor: 0 });
  assert.deepEqual(poolReleasePlan(700, 50), { total: POOL.MAX_PER_MATCH, risk: POOL.MAX_PER_MATCH, floor: 0 });
  // An explicit floor still works for old callers, never below FLOOR_MIN_POOL.
  assert.deepEqual(poolReleasePlan(POOL.FLOOR_MIN_POOL + 2, 0, 6), { total: 2, risk: 0, floor: 2 });
});

test("container fungibles: wilds mostly empty, T3/T4 mostly full and hold more lines", () => {
  // No safe: below T3 its whole table is above the junk cap, so a T0–T2 safe is always empty
  // (the Steppe has none there).
  const kinds = ["crate", "toolbox", "fridge", "pc", "med_case", "weapon_box", "stash"] as const;
  const empty = [0, 0, 0, 0, 0];
  const lines = [0, 0, 0, 0, 0];
  const n = 4000;
  for (let tier = 0; tier <= 4; tier++) {
    for (let i = 0; i < n; i++) {
      const f = rollContainerFungibles(7919 + i * 31, tier * 100_000 + i, { kind: kinds[i % kinds.length]!, tier: tier as 0 });
      if (f.length === 0) empty[tier]!++;
      lines[tier]! += f.length;
    }
  }
  // Empty ≈ 1 − FILL × (1 − EMPTY^ROLLS): T0 79 %, T1 62 %, T2 58 %, T3 17 %, T4 12 %.
  const want = [0.79, 0.62, 0.58, 0.17, 0.12];
  want.forEach((w, t) => assert.ok(Math.abs(empty[t]! / n - w) < 0.03, `T${t} empty ${(empty[t]! / n).toFixed(3)} vs ${w}`));
  assert.ok(lines[3]! / n > lines[0]! / n + 0.8, "T3 has clearly more lines than T0");
});
