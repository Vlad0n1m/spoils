/**
 * SPOILS shop pricing (lib/idos/shop-rules.ts) and the pure quote of lib/idos/shop.ts: scarcity,
 * demand, the [1, 100]¢ clamp, cents → SPOILS rounding, the payment decomposition, availability.
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/idos/shop-rules.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { COSMETICS, POOL, STARTER_KIT } from "@extract/shared";
import {
  IDOS_PRODUCTS,
  IDOS_SHOP,
  SPOILS_MAX_PAYABLE,
  clampCents,
  crateCents,
  crateDemand,
  crateScarcity,
  decomposeSpoils,
  formatUsdCents,
  shopProduct,
  spoilsForCents,
  spoilsPerCent,
} from "./shop-rules";
import { crateAvailable, parseIdosAccountKey, quoteProducts, type ShopState } from "./shop";

/** The live price on 05.10: 1¢ ≈ 2 750 SPOILS. */
const PRICE = 0.0000036;

const STATE: ShopState = {
  poolSize: 400,
  poolByRarity: [40, 40, 40],
  minReserve: POOL.MIN_RESERVE,
  sold24h: {},
  kitsToday: 0,
  kitDailyMax: STARTER_KIT.DAILY_MAX,
  kitPaused: false,
  crPacksToday: 0,
};

describe("products", () => {
  it("are the agreed ones, with fixed prices inside [1, 100]¢", () => {
    assert.deepEqual(
      IDOS_PRODUCTS.map((p) => [p.id, p.kind, p.usdCents]),
      [
        ["crate_common", "crate", 5],
        ["crate_rare", "crate", 15],
        ["crate_epic", "crate", 40],
        ["starter_kit", "kit", 10],
        ["cr_pack", "credits", 5],
        ["supporter", "donation", 25],
        ["patron", "donation", 100],
      ],
    );
    for (const p of IDOS_PRODUCTS) assert.ok(p.usdCents >= IDOS_SHOP.MIN_CENTS && p.usdCents <= IDOS_SHOP.MAX_CENTS, p.id);
    assert.deepEqual(IDOS_PRODUCTS.filter((p) => p.kind === "crate").map((p) => p.rarity), [0, 1, 2], "legendary is never sold");
    assert.equal(shopProduct("crate_legendary"), null);
    assert.equal(shopProduct(42), null);
  });

  it("donation titles exist as granted title cosmetics", () => {
    for (const id of ["supporter", "patron"]) {
      assert.equal(shopProduct(id)?.cosmetic, id);
      assert.equal(COSMETICS[id]?.kind, "title");
      assert.equal(COSMETICS[id]?.grant, "donation");
    }
  });
});

describe("crate dynamics", () => {
  it("scarcity = clamp(sqrt(40 / stock), 0.8, 1.5)", () => {
    assert.equal(crateScarcity(40), 1);
    assert.equal(crateScarcity(10), 1.5, "sqrt(4) = 2, clamped at 1.5");
    assert.ok(Math.abs(crateScarcity(20) - Math.SQRT2) < 1e-12);
    assert.equal(crateScarcity(1000), 0.8, "clamped at 0.8");
    assert.equal(crateScarcity(0), 1.5, "an empty pool is the most scarce");
  });

  it("demand = min(1.5, 1 + 0.02 × sold in 24 h)", () => {
    assert.equal(crateDemand(0), 1);
    assert.equal(crateDemand(10), 1.2);
    assert.equal(crateDemand(25), 1.5);
    assert.equal(crateDemand(500), 1.5);
    assert.equal(crateDemand(-3), 1);
  });

  it("price = base × scarcity × demand, whole cents, clamped to [1, 100]", () => {
    assert.equal(crateCents(5, 40, 0), 5);
    assert.equal(crateCents(15, 20, 10), Math.round(15 * Math.SQRT2 * 1.2)); // 25.45… → 25
    assert.equal(crateCents(40, 5, 100), 90); // 40 × 1.5 × 1.5
    assert.equal(crateCents(40, 1000, 0), 32); // 40 × 0.8
    assert.equal(crateCents(100, 0, 100), 100, "never above $1");
    assert.equal(crateCents(1, 1000, 0), 1, "never below 1¢");
    assert.equal(clampCents(0.2), 1);
    assert.equal(clampCents(Number.NaN), 100);
  });
});

describe("cents → SPOILS", () => {
  it("rounds UP to a multiple of 1 000 at the live price", () => {
    // 5¢ at $0.0000036 = 13 888.9 SPOILS → 14 000.
    assert.equal(spoilsForCents(5, PRICE), 14_000);
    assert.equal(spoilsForCents(1, PRICE), 3_000); // 2 777.8 → 3 000
    assert.equal(spoilsForCents(100, PRICE), 278_000); // 277 777.8 → 278 000
    assert.equal(spoilsForCents(1, 0.00001), 1_000, "an exact multiple is not bumped a step");
    assert.equal(spoilsForCents(1, 1), 1_000, "never below one step");
  });

  it("refuses no price, a bad price and amounts the two offers cannot pay", () => {
    assert.equal(spoilsForCents(5, 0), null);
    assert.equal(spoilsForCents(5, -1), null);
    assert.equal(spoilsForCents(5, Number.NaN), null);
    assert.equal(spoilsForCents(100, 1e-12), null, "above 100 × 100k + 99 × 1k");
    assert.equal(SPOILS_MAX_PAYABLE, 10_099_000);
  });

  it("SPOILS per cent for display", () => {
    assert.ok(Math.abs(spoilsPerCent(PRICE) - 2777.777) < 0.01);
    assert.equal(spoilsPerCent(0), 0);
  });
});

describe("payment decomposition", () => {
  it("a × pay_100k + b × pay_1k, biggest first, empty legs left out", () => {
    assert.deepEqual(decomposeSpoils(14_000), [{ offerId: "pay_1k", count: 14, spoils: 14_000, key: "1k" }]);
    assert.deepEqual(decomposeSpoils(278_000), [
      { offerId: "pay_100k", count: 2, spoils: 200_000, key: "100k" },
      { offerId: "pay_1k", count: 78, spoils: 78_000, key: "1k" },
    ]);
    assert.deepEqual(decomposeSpoils(300_000), [{ offerId: "pay_100k", count: 3, spoils: 300_000, key: "100k" }]);
    assert.deepEqual(decomposeSpoils(SPOILS_MAX_PAYABLE)?.map((l) => l.count), [100, 99]);
  });

  it("refuses non-multiples, zero, negatives and more than 100 of an offer", () => {
    for (const bad of [0, -1_000, 1_500, 999, 10_100_000, 1.5e3 + 0.5]) assert.equal(decomposeSpoils(bad), null, String(bad));
  });

  it("every product at the live price can be paid", () => {
    for (const p of IDOS_PRODUCTS) {
      for (const cents of [p.usdCents, IDOS_SHOP.MAX_CENTS, IDOS_SHOP.MIN_CENTS]) {
        const amount = spoilsForCents(cents, PRICE)!;
        const legs = decomposeSpoils(amount)!;
        assert.equal(legs.reduce((s, l) => s + l.spoils, 0), amount, `${p.id} ${cents}`);
      }
    }
  });

  it("formats dollars", () => {
    assert.equal(formatUsdCents(5), "$0.05");
    assert.equal(formatUsdCents(100), "$1.00");
  });
});

describe("quotes", () => {
  it("prices every product, crates with dynamics and the rest fixed", () => {
    const q = quoteProducts({ ...STATE, poolByRarity: [10, 40, 1000], sold24h: { crate_common: 10 } }, PRICE);
    const by = Object.fromEntries(q.map((x) => [x.id, x]));
    assert.equal(by.crate_common!.usdCents, 9); // 5 × 1.5 × 1.2
    assert.equal(by.crate_rare!.usdCents, 15);
    assert.equal(by.crate_epic!.usdCents, 32);
    assert.equal(by.starter_kit!.usdCents, 10);
    assert.equal(by.cr_pack!.usdCents, 5);
    assert.equal(by.patron!.usdCents, 100);
    assert.equal(by.crate_common!.spoils, spoilsForCents(9, PRICE));
    assert.equal(by.crate_rare!.stock, 40);
    assert.ok(q.every((x) => x.available));
  });

  it("no token price: nothing is available", () => {
    const q = quoteProducts(STATE, null);
    assert.ok(q.every((x) => !x.available && x.reason === "no_price" && x.spoils === null));
  });

  it("a crate never takes the pool below its floor or below 5 of its rarity", () => {
    const at = (s: Partial<ShopState>, r: number) => crateAvailable({ ...STATE, ...s }, r);
    assert.equal(at({ poolByRarity: [6, 0, 0] }, 0), true);
    assert.equal(at({ poolByRarity: [5, 0, 0] }, 0), false, "would leave 4 commons");
    assert.equal(at({ poolSize: POOL.MIN_RESERVE + 1 }, 1), true);
    assert.equal(at({ poolSize: POOL.MIN_RESERVE }, 1), false, "would leave the pool under its floor");
    const q = quoteProducts({ ...STATE, poolByRarity: [40, 5, 40] }, PRICE);
    assert.equal(q.find((x) => x.id === "crate_rare")!.reason, "sold_out");
  });

  it("daily caps and the kit stop-crane", () => {
    const q = quoteProducts({ ...STATE, kitsToday: STARTER_KIT.DAILY_MAX, crPacksToday: IDOS_SHOP.CR_PACK_DAILY_MAX }, PRICE);
    assert.equal(q.find((x) => x.id === "starter_kit")!.reason, "daily_limit");
    assert.equal(q.find((x) => x.id === "cr_pack")!.reason, "daily_limit");
    assert.deepEqual(q.find((x) => x.id === "cr_pack")!.limit, { used: 5, max: 5 });
    assert.equal(quoteProducts({ ...STATE, kitPaused: true }, PRICE).find((x) => x.id === "starter_kit")!.reason, "paused");
    assert.ok(quoteProducts(STATE, PRICE).filter((x) => x.kind === "donation").every((x) => x.available), "donations are never capped");
  });

  it("parses the iDos account key", () => {
    assert.deepEqual(parseIdosAccountKey("8YECHSD4/abc_DEF-1"), { titleId: "8YECHSD4", userId: "abc_DEF-1" });
    assert.deepEqual(parseIdosAccountKey("8YECHSD4-DEV/u1"), { titleId: "8YECHSD4-DEV", userId: "u1" });
    for (const bad of [null, undefined, "", "noslash", "/u", "T/"]) assert.equal(parseIdosAccountKey(bad), null, String(bad));
  });
});
