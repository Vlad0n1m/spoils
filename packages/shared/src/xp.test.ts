/**
 * WORLD v6 XP (spec §9 T3): xpForExit table cases and levelProgress.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { XP, XP_LINE_LABEL, levelForXp, levelProgress, xpForExit, xpToNext, type XpInput, type XpKey } from "./economy.js";

const MIN = 60_000;
const base: XpInput = {
  exit: "extract", onMapMs: 0, haulCr: 0, containers: 0, marauders: 0, guards: 0, bosses: 0,
  rankedPvp: 0, grindToday: 0, firstExtractToday: false,
};
const x = (o: Partial<XpInput>) => xpForExit({ ...base, ...o });
const lineMap = (r: ReturnType<typeof xpForExit>) => Object.fromEntries(r.lines.map((l) => [l.key, l.xp]));

test("T3 a 7-min extract gives no extract / haul XP (containers still count)", () => {
  const r = x({ onMapMs: 7 * MIN + 59_999, haulCr: 1000, containers: 3, firstExtractToday: true });
  assert.deepEqual(lineMap(r), { containers: 6 });
  assert.equal(r.total, 6, "no first-extract bonus without a qualifying extract");
  assert.equal(r.grind, 6);
});

test("T3 a 15-min extract with a 1 000 CR haul", () => {
  const r = x({ onMapMs: 15 * MIN + 30_000, haulCr: 1000, containers: 5 });
  assert.deepEqual(lineMap(r), { extract: 250, haul: 100, containers: 10 });
  assert.equal(r.total, 360);
  assert.equal(r.grind, 360);
  assert.deepEqual(r.lines[0], { key: "extract", qty: 15, xp: 250 });
  // Caps: minutes at 25, haul at 150, containers at 30.
  const big = x({ onMapMs: 40 * MIN, haulCr: 99_999, containers: 99 });
  assert.deepEqual(lineMap(big), { extract: 350, haul: 150, containers: 60 });
  // Exactly MIN_ONMAP_MS qualifies.
  assert.equal(x({ onMapMs: XP.MIN_ONMAP_MS }).total, 180);
});

test("T3 death with kills: kill lines and containers, no extract / haul / first bonus", () => {
  const r = x({ exit: "dead", onMapMs: 30 * MIN, haulCr: 500, containers: 2, marauders: 3, guards: 1, bosses: 1, rankedPvp: 2, firstExtractToday: true });
  assert.deepEqual(lineMap(r), { containers: 4, npc: 60, guard: 40, boss: 400, pvp: 160 });
  assert.equal(r.total, 664);
  assert.equal(r.grind, 104, "boss and PvP are not grind");
});

test("T3 MIA = kill lines only", () => {
  const r = x({ exit: "mia", onMapMs: 44 * MIN, haulCr: 800, containers: 9, marauders: 2, guards: 1, bosses: 1, rankedPvp: 1, firstExtractToday: true });
  assert.deepEqual(lineMap(r), { npc: 40, guard: 40, boss: 400, pvp: 80 });
  assert.equal(r.total, 560);
  assert.equal(x({ exit: "mia", onMapMs: 44 * MIN, containers: 9 }).total, 0);
  assert.equal(x({ exit: "timeout", onMapMs: 29 * MIN }).total, 0, "legacy timeout: no extract XP");
});

test("T3 daily soft cap at 2 400 + 300 (× 0.25 above 2 500)", () => {
  const r = x({ exit: "dead", marauders: 15, grindToday: 2400 });
  // raw 300, room 100 → 100 + floor(200 × 0.25) = 150.
  assert.equal(r.grind, 150);
  assert.equal(r.total, 150);
  assert.deepEqual(lineMap(r), { npc: 300, daily_cap: -150 });
  // Fully above the cap; boss / PvP untouched.
  const over = x({ exit: "dead", marauders: 10, bosses: 1, rankedPvp: 1, grindToday: 9000 });
  assert.equal(over.grind, 50);
  assert.equal(over.total, 50 + 400 + 80);
  // Under the cap: no daily_cap line.
  assert.ok(!x({ exit: "dead", marauders: 5, grindToday: 100 }).lines.some((l) => l.key === "daily_cap"));
});

test("T3 above the daily cap time lines (extract, haul) pay nothing; activity keeps × 0.25 (review fix)", () => {
  // Fully above the cap: a 25-min extract with a full haul and 10 containers → only the containers' quarter.
  const over = x({ onMapMs: 25 * MIN, haulCr: 1500, containers: 10, grindToday: 2500 });
  assert.equal(over.grind, 5);
  assert.deepEqual(lineMap(over), { extract: 350, haul: 150, containers: 20, daily_cap: -515 });
  // Straddling: the time lines fill the room first (pays the player most), the activity rest × 0.25.
  const mid = x({ onMapMs: 10 * MIN, marauders: 2, grindToday: 2400 });
  // time 200, act 40, room 100 → timeIn 100, actIn 0 → 100 + 0 + floor(40 × 0.25) = 110.
  assert.equal(mid.grind, 110);
  // An idle hide-and-extract bot (4 × 8-min extracts every cycle, 32 cycles) is held at the cap
  // plus the first-extract bonus instead of ≈ 7 800 XP a day.
  let grind = 0, total = 0;
  for (let k = 0; k < 128; k++) {
    const r = x({ onMapMs: 8 * MIN + 5_000, grindToday: grind, firstExtractToday: k === 0 });
    grind += r.grind;
    total += r.total;
  }
  assert.equal(grind, XP.DAILY_SOFT_CAP);
  assert.equal(total, XP.DAILY_SOFT_CAP + 180);
  assert.equal(XP.DAILY_TIME_OVER_MULT, 0);
});

test("T3 first-extract bonus doubles the entry up to 300", () => {
  const small = x({ onMapMs: 10 * MIN, firstExtractToday: true });
  assert.equal(small.total, 400, "200 + 200");
  assert.deepEqual(small.lines.at(-1), { key: "first_extract", qty: 1, xp: 200 });
  const big = x({ onMapMs: 25 * MIN, haulCr: 1500, bosses: 1, firstExtractToday: true });
  // 350 + 150 + 400 = 900; bonus capped at 300.
  assert.equal(big.total, 1200);
  assert.equal(lineMap(big).first_extract, 300);
  assert.equal(big.grind, 500, "the bonus is not grind");
});

test("T3 lines sum to the total, no zero lines, every key labelled", () => {
  const cases: Partial<XpInput>[] = [
    {}, { onMapMs: 12 * MIN, haulCr: 333, containers: 4, marauders: 1, firstExtractToday: true, grindToday: 2490 },
    { exit: "dead", rankedPvp: 1 }, { exit: "mia", marauders: 30, grindToday: 2000 },
  ];
  for (const c of cases) {
    const r = x(c);
    assert.equal(r.lines.reduce((s, l) => s + l.xp, 0), r.total, JSON.stringify(c));
    assert.ok(r.lines.every((l) => l.xp !== 0));
  }
  assert.equal(x({}).lines.length, 0);
  const keys: XpKey[] = ["extract", "haul", "containers", "npc", "guard", "boss", "pvp", "first_extract", "daily_cap"];
  for (const k of keys) assert.ok(XP_LINE_LABEL[k].length > 0, k);
  // Garbage input never yields negative or NaN XP.
  const g = x({ onMapMs: Number.NaN, haulCr: -50, containers: -1, marauders: Number.NaN, grindToday: -100 });
  assert.equal(g.total, 0);
});

test("T3 levelProgress agrees with levelForXp; xpToNext unchanged", () => {
  assert.equal(xpToNext(1), 400);
  assert.equal(xpToNext(10), 1750);
  assert.deepEqual(levelProgress(0), { level: 1, into: 0, need: 400, total: 0 });
  assert.deepEqual(levelProgress(399), { level: 1, into: 399, need: 400, total: 399 });
  assert.deepEqual(levelProgress(400), { level: 2, into: 0, need: 550, total: 400 });
  for (let xp = 0; xp < 60_000; xp += 37) {
    const p = levelProgress(xp);
    assert.equal(p.level, levelForXp(xp), `xp ${xp}`);
    assert.equal(p.need, xpToNext(p.level));
    assert.ok(p.into >= 0 && p.into < p.need);
    let floor = 0;
    for (let l = 1; l < p.level; l++) floor += xpToNext(l);
    assert.equal(floor + p.into, xp);
  }
});
