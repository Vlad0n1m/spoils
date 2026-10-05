/**
 * Level rewards for the menu (RETENTION.md §3): the rewards table, the LEVEL N lines, next reward.
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/lobby/levels.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { COSMETICS, LEVEL_REWARDS, MARKET } from "@extract/shared";
import {
  REWARD_TABLE_TOP,
  cosmeticLabel,
  defaultSellUnlockLevel,
  levelRewards,
  levelUnlocks,
  featureKindOf,
  markRewardTable,
  rewardsBetween,
  nameColorHex,
  nextReward,
  rewardTable,
  titleName,
  unlocksBetween,
} from "./levels";

describe("level rewards", () => {
  it("level 5: market, traders 2, lime badge, then the title and name colour", () => {
    const r = levelRewards(5, 5);
    assert.deepEqual(r.map((x) => x.kind), ["feature", "feature", "feature", "title", "color"]);
    assert.deepEqual(r.slice(3).map((x) => x.label), ["Title: Raider", "Name colour: Lime"]);
    assert.equal(r[2]!.label, "Level badge turns lime");
    assert.equal(r[4]!.hex, "#ccff00");
    assert.ok(levelUnlocks(5, 5).includes("Market selling unlocked"));
    // Demo rules (selling from level 1): no market line at 5.
    assert.ok(!levelUnlocks(5, 1).includes("Market selling unlocked"));
  });

  it("the LEVEL N lines include the cosmetics of every level crossed", () => {
    const lines = unlocksBetween(1, 4, MARKET.SELL_UNLOCK_LEVEL);
    assert.deepEqual(lines, ["Title: Scavenger", "Badge frame: Rope", "Name colour: Sand"]);
    assert.deepEqual(unlocksBetween(10, 11), []);
  });

  it("the table lists every cosmetic level reward once, up to level 30", () => {
    assert.equal(REWARD_TABLE_TOP, 30);
    const table = rewardTable();
    const ids = table.flatMap((r) => r.items.filter((i) => i.id).map((i) => i.id));
    assert.deepEqual(ids, LEVEL_REWARDS.flatMap((r) => r.ids));
    assert.deepEqual(table.map((r) => r.level), [...new Set(table.map((r) => r.level))].sort((a, b) => a - b));
    // Traders tier 4 (level 15) sells the rare crossbow and LMG since Weapons v2, so it is promised.
    assert.ok(levelRewards(15).some((i) => i.label.startsWith("Traders tier 4")));
    assert.deepEqual(markRewardTable().map((r) => [r.marks, r.items.map((i) => i.label)]), [
      [10, ["Name colour: Contract Blue"]],
      [25, ["Badge frame: Contract"]],
      [50, ["Title: Fixer"]],
      [100, ["Badge frame: Fixer"]],
    ]);
  });

  it("reward cards: feature kinds, and every item of the levels crossed", () => {
    assert.deepEqual(levelRewards(5, 5).slice(0, 3).map((x) => x.feature), ["market", "trader", "band"]);
    assert.equal(featureKindOf("Level badge turns gold"), "band");
    assert.deepEqual(rewardsBetween(1, 4).map((x) => x.label), unlocksBetween(1, 4));
    assert.deepEqual(rewardsBetween(10, 11), []);
  });

  it("iDos edition (no market): no level promises market selling; the rest of the table is unchanged", () => {
    assert.equal(defaultSellUnlockLevel(true), MARKET.SELL_UNLOCK_LEVEL);
    assert.equal(defaultSellUnlockLevel(false), null);
    assert.equal(defaultSellUnlockLevel(), MARKET.SELL_UNLOCK_LEVEL, "tests run as the main build");
    const all = rewardTable(null).flatMap((r) => r.items);
    assert.ok(all.every((i) => i.feature !== "market" && !/market|sell|SOL/i.test(i.label)), "no market line anywhere");
    assert.deepEqual(levelRewards(5, null).map((x) => x.feature ?? x.kind), ["trader", "band", "title", "color"]);
    assert.ok(!unlocksBetween(1, 30, null).includes("Market selling unlocked"));
    assert.ok(rewardsBetween(1, 30, null).every((x) => x.feature !== "market"));
    // Only the market line differs from the main table.
    const main = rewardTable(MARKET.SELL_UNLOCK_LEVEL).flatMap((r) => r.items).filter((i) => i.feature !== "market");
    assert.deepEqual(all, main);
    assert.equal(nextReward(1, null)!.level, nextReward(1)!.level);
  });

  it("next reward after a level", () => {
    assert.equal(nextReward(1)!.level, 2);
    assert.equal(nextReward(10)!.level, 12);
    assert.equal(nextReward(25)!.level, 30);
    assert.equal(nextReward(30), null);
  });

  it("labels and lookups", () => {
    assert.equal(cosmeticLabel("f-gilded"), "Badge frame: Gilded");
    assert.equal(cosmeticLabel("nope"), "");
    assert.equal(nameColorHex("c-gold"), COSMETICS["c-gold"]!.hex);
    assert.equal(nameColorHex("t-raider"), undefined);
    assert.equal(nameColorHex(null), undefined);
    assert.equal(titleName("t-legend"), "Legend of the Outskirts");
    assert.equal(titleName("c-gold"), null);
  });
});
