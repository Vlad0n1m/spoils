import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AUTOSELL,
  BOUND_OFFERS,
  CONSUMABLES_CR,
  CONTAINER,
  CR,
  SEED_KIT,
  STARTER_KIT,
  MARKET,
  POOL,
  armorPct,
  boundTraderLevel,
  capBandAtTrader,
  traderPriceCap,
  armorPoints,
  dogTagPairMult,
  junkSellCr,
  levelForXp,
  marketFeeMinor,
  nextAutosellMult,
  poolEntry,
  poolReleaseCount,
  rollContainerFungibles,
  priceBand,
  takeTreasuryTax,
  templateKey,
  trimmedMedian,
  xpForExit,
  xpToNext,
} from "./economy.js";
import { LOOT_TRIM } from "./alpha-loot.js";
import { DOG_TAG, JUNK_IDS, dogTagCr, itemDef, junkCredits } from "./item-defs.js";
import { ARMOR } from "./items.js";

test("starting balance is 1000 CR", () => {
  assert.equal(CR.START_BALANCE, 1000);
});

test("nextAutosellMult: ±5%/day inside [0.4, 1.0] on the 400–900 CR band, needs a sample of 50", () => {
  assert.equal(nextAutosellMult(1, 50_000, AUTOSELL.MIN_SAMPLE - 1), 1, "small sample: unchanged");
  assert.ok(Math.abs(nextAutosellMult(1, 1000, 100) - 0.95) < 1e-12);
  assert.ok(Math.abs(nextAutosellMult(0.5, 300, 100) - 0.525) < 1e-12);
  assert.equal(nextAutosellMult(1, 300, 100), AUTOSELL.MAX, "never above ×1");
  assert.equal(nextAutosellMult(0.8, 600, 100), 0.8, "inside the band");
  assert.equal(nextAutosellMult(0.41, 9000, 100), AUTOSELL.MIN);
  assert.equal(nextAutosellMult(1.3, 600, 100), AUTOSELL.MAX, "an old stored 1.3 is clamped");
  assert.equal(nextAutosellMult(1.3, 600, 1), AUTOSELL.MAX, "clamped even on a small sample");
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

test("trader price cap: the bound traders' CR price per def caps the listing band", () => {
  assert.equal(traderPriceCap("shotgun"), 1500n);
  assert.equal(traderPriceCap("armor_2"), 2600n);
  assert.equal(traderPriceCap("pistol"), null, "not sold by a trader");
  assert.equal(traderPriceCap("rifle", 0), 1800n, "the trader's own rarity");
  assert.equal(traderPriceCap("rifle", 2), null, "an epic rifle is not the trader's common one: no cap");
  assert.equal(traderPriceCap("armor_2", 1), 2600n);
  assert.equal(traderPriceCap("lmg", 1), 4500n);
  assert.equal(traderPriceCap("lmg", 3), null);
  for (const o of BOUND_OFFERS) assert.equal(traderPriceCap(o.def, o.rarity), BigInt(o.cr), o.def);

  assert.deepEqual(capBandAtTrader({ min: 1n, max: null }, 1500n), { min: 1n, max: 1500n });
  assert.deepEqual(capBandAtTrader({ min: 500n, max: 4000n }, 1500n), { min: 500n, max: 1500n });
  assert.deepEqual(capBandAtTrader({ min: 500n, max: 1000n }, 1500n), { min: 500n, max: 1000n }, "a lower band max stays");
  assert.deepEqual(capBandAtTrader({ min: 2000n, max: 8000n }, 1500n), { min: 1500n, max: 1500n }, "the trader price stays allowed");
  assert.deepEqual(capBandAtTrader({ min: 500n, max: 4000n }, null), { min: 500n, max: 4000n });
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
  // WORLD v6 calibration (xpForExit): 40 % extracts after 15 min (400 CR haul, 8 containers, 1 marauder),
  // 60 % deaths (5 containers, 1 marauder) → ~150 XP per entry → level 5 after roughly 17 entries.
  const base = { onMapMs: 15 * 60_000, guards: 0, bosses: 0, rankedPvp: 0, grindToday: 0, firstExtractToday: false };
  const ext = xpForExit({ ...base, exit: "extract", haulCr: 400, containers: 8, marauders: 1 }).total;
  const dead = xpForExit({ ...base, exit: "dead", haulCr: 0, containers: 5, marauders: 1 }).total;
  const perEntry = 0.4 * ext + 0.6 * dead;
  const entriesToL5 = Math.ceil([1, 2, 3, 4].reduce((a, l) => a + xpToNext(l), 0) / perEntry);
  assert.ok(entriesToL5 >= 10 && entriesToL5 <= 20, String(entriesToL5));
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
    assert.ok(d && (d.cat === "ammo" || d.cat === "med" || d.cat === "throwable"), id);
    assert.ok(o.qty >= 1 && o.cr > 0);
  }
  for (const group of [SEED_KIT.weapon, SEED_KIT.armor, SEED_KIT.backpack, STARTER_KIT.weapons, STARTER_KIT.armor]) {
    for (const e of group) assert.ok(itemDef(e.def)?.unique, e.def);
  }
  for (const s of STARTER_KIT.stacks) {
    const d = itemDef(s.def);
    assert.ok(d && !d.unique && (d.cat === "ammo" || d.cat === "med") && s.qty >= 1, s.def);
  }
  for (const o of BOUND_OFFERS) assert.ok(itemDef(o.def)?.unique, o.def);
  // One entry per LootTier 0..4.
  assert.equal(CONTAINER.ROLLS.length, 5);
  assert.equal(CONTAINER.FILL_CHANCE.length, 5);
  for (const p of CONTAINER.FILL_CHANCE) assert.ok(p > 0 && p <= 1);
});

test("boundTraderLevel: 1–4 → 1, 5–9 → 2, 10–14 → 3, 15+ → 4 (badge bands; rifle at level 5)", () => {
  const want = (l: number) => (l < 5 ? 1 : l < 10 ? 2 : l < 15 ? 3 : 4);
  for (let l = 0; l <= 40; l++) assert.equal(boundTraderLevel(l), want(Math.max(1, l)), `level ${l}`);
  assert.equal(BOUND_OFFERS.find((o) => o.def === "rifle")?.traderLevel, boundTraderLevel(5));
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
  // Empty ≈ 1 − FILL × (1 − EMPTY^ROLLS): T0 85 % (v5 tuning: FILL 0.25 → 0.18), T1 62 %, T2 58 %, T3 17 %, T4 12 %.
  // LOOT_TRIM (2026-10): fill × 0.9, so empty = 1 − 0.9 × (1 − pre-cut empty).
  const want = [0.85, 0.62, 0.58, 0.17, 0.12].map((e) => 1 - LOOT_TRIM.DROP_MULT * (1 - e));
  want.forEach((w, t) => assert.ok(Math.abs(empty[t]! / n - w) < 0.03, `T${t} empty ${(empty[t]! / n).toFixed(3)} vs ${w}`));
  assert.ok(lines[3]! / n > lines[0]! / n + 0.8, "T3 has clearly more lines than T0");
});
