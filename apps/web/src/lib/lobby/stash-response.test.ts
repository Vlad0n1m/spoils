/**
 * GET /api/stash body: the SOL-economy fields are main-build only (docs/IDOS_EDITION.md §3.5).
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/lobby/stash-response.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { MarketConfigDto, StashDto, StashMoneyDto } from "./api-types";
import { hasStashMarket, hasStashMoney, stashResponse } from "./stash-response";
import { defaultSellUnlockLevel, rewardTable } from "./levels";

const STASH: StashDto = {
  credits: 1200,
  xp: 40,
  level: 3,
  matchesPlayed: 2,
  starterClaimed: false,
  uniques: [],
  stacks: { ammo_light: 30 },
  active: null,
  draft: null,
};

const MONEY: StashMoneyDto = {
  balance: "5000",
  market: { currency: "SOL", decimals: 9, feeBps: 500, sellUnlockLevel: 5, maxActiveListings: 10, listingFeeCr: [0, 1, 2, 3] },
  kit: { priceMinor: "50000000", dailyMax: 3, boughtToday: 0, paused: false },
};

const CR_MARKET: MarketConfigDto = { currency: "CR", decimals: 0, feeBps: 500, sellUnlockLevel: 5, maxActiveListings: 10, listingFeeCr: [0, 1, 2, 3] };

describe("/api/stash body", () => {
  it("main build: stash + wallet, market rules, kit offer and the junker multiplier", () => {
    const r = stashResponse(STASH, 1.1, MONEY);
    assert.deepEqual(r, { ...STASH, ...MONEY, autosellMult: 1.1 });
    assert.ok(hasStashMoney(r));
  });

  it("iDos edition: balance and kit are left out (not zeros), the CR market's rules stay", () => {
    const r = stashResponse(STASH, 1.1, null, CR_MARKET);
    for (const k of ["balance", "kit"]) assert.equal(k in r, false, k);
    assert.deepEqual(r, { ...STASH, market: CR_MARKET, autosellMult: 1.1 });
    assert.equal(hasStashMoney(r), false);
    assert.ok(hasStashMarket(r));
    // Survives JSON as the client sees it.
    const wire = JSON.parse(JSON.stringify(r)) as typeof r;
    assert.equal(hasStashMoney(wire), false);
    assert.equal(wire.market?.currency, "CR");
    // The edition has the CR market, so its reward lines promise market selling like the main build.
    assert.ok(rewardTable(wire.market?.sellUnlockLevel).some((x) => x.items.some((i) => i.feature === "market")));
  });

  it("without money and market rules the body is the stash alone (no market line)", () => {
    const r = stashResponse(STASH, 1.1, null);
    for (const k of ["balance", "market", "kit"]) assert.equal(k in r, false, k);
    assert.equal(hasStashMarket(r), false);
    assert.ok(rewardTable(defaultSellUnlockLevel(false)).every((x) => x.items.every((i) => i.feature !== "market")));
  });

  it("a partial body (no kit) is not treated as money data", () => {
    const { kit: _kit, ...rest } = MONEY;
    assert.equal(hasStashMoney({ ...STASH, ...rest }), false);
  });
});
