/** Pure tests: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/market/config.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MARKET } from "@extract/shared";
import { MAX_PRICE_MINOR, formatMinor, listingFeeCr, minorToText, parsePriceToMinor, saleBreakdown } from "./config";
import { defOfTemplate, templateCat, templateLabel } from "./templates";

test("parsePriceToMinor accepts what sellers type and refuses silent rounding", () => {
  assert.equal(parsePriceToMinor("12"), 1200n);
  assert.equal(parsePriceToMinor(" 12.5 "), 1250n);
  assert.equal(parsePriceToMinor("12,05"), 1205n);
  assert.equal(parsePriceToMinor("0.01"), 1n);
  assert.equal(parsePriceToMinor("12."), 1200n);
  for (const bad of ["", "0", "0.00", "-1", "1.234", "abc", "1e3", "12.5.1"]) {
    assert.equal(parsePriceToMinor(bad), null, bad);
  }
  assert.equal(parsePriceToMinor("1000000"), MAX_PRICE_MINOR);
  assert.equal(parsePriceToMinor("1000000.01"), null);
});

test("minor units format with thousands separators and a currency label", () => {
  assert.equal(minorToText(0n), "0.00");
  assert.equal(minorToText("5"), "0.05");
  assert.equal(minorToText(123456789n), "1 234 567.89");
  assert.equal(minorToText(-250n), "−2.50");
  assert.match(formatMinor(1250n), /^12\.50 \S+$/);
  assert.equal(minorToText("not a number"), "0.00");
});

test("sale breakdown: 5% fee rounded up for the house, seller gets the rest", () => {
  assert.deepEqual(saleBreakdown(1000n, MARKET.FEE_BPS), { fee: 50n, net: 950n });
  assert.deepEqual(saleBreakdown(1n, MARKET.FEE_BPS), { fee: 1n, net: 0n });
  assert.deepEqual(saleBreakdown(1999n, 0), { fee: 0n, net: 1999n });
  for (const p of [7n, 99n, 12345n]) {
    const b = saleBreakdown(p, 500);
    assert.equal(b.fee + b.net, p);
  }
});

test("listing fee by rarity with clamping", () => {
  assert.equal(listingFeeCr(0), MARKET.LISTING_FEE_CR[0]);
  assert.equal(listingFeeCr(3), MARKET.LISTING_FEE_CR[3]);
  assert.equal(listingFeeCr(9), MARKET.LISTING_FEE_CR[3]);
  assert.equal(listingFeeCr(-1), MARKET.LISTING_FEE_CR[0]);
});

test("template helpers", () => {
  assert.equal(defOfTemplate("weapon:rifle:2"), "rifle");
  assert.equal(defOfTemplate("armor:3"), "armor_3");
  assert.equal(defOfTemplate("backpack:1"), "backpack_1");
  assert.equal(templateLabel("weapon:sniper:3"), "Sniper rifle · Legendary");
  assert.equal(templateLabel("backpack:3"), "Raid pack");
  assert.equal(templateCat("armor:2"), "armor");
  assert.equal(templateCat("junk_gpu"), null);
});
