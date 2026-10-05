/**
 * Alpha rules copy: the iDos edition never mentions a balance, the market, a wallet or the Economy page.
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/content/alpha.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ALPHA_SHORT, alphaBadge, alphaOneLine, alphaRulesCopy, alphaShort } from "./alpha";

const MONEY_WORDS = /\b(balance|market|wallet|SOL|deposit|withdraw|economy|starter kit|listings?)\b/i;

function allText(sol: boolean): string[] {
  const c = alphaRulesCopy(sol);
  return [c.description, c.shortFirst, c.money.nav, c.money.title, ...c.money.items, ...c.earn, c.wipeRemoves, c.dataAccount, ...alphaShort(sol), alphaOneLine(sol), alphaBadge(sol)];
}

describe("alpha copy", () => {
  it("main build keeps the test-balance copy unchanged", () => {
    const c = alphaRulesCopy(true);
    assert.equal(c.money.id, "balance");
    assert.equal(c.money.title, "A test balance, not real money");
    assert.ok(c.money.items[0]!.startsWith("Your market balance in the alpha is test money."));
    assert.equal(c.economyLink, true);
    assert.deepEqual(ALPHA_SHORT, alphaShort(true), "tests run as the main build");
    assert.equal(alphaShort(true)[0], "This is an alpha on a test balance. No real money goes in or out.");
    assert.equal(alphaBadge(true), "ALPHA TEST · free · test balance →");
    assert.match(alphaOneLine(true), /^Alpha test: a test balance,/);
  });

  it("iDos edition: no balance, market, wallet, SOL or Economy page anywhere", () => {
    const c = alphaRulesCopy(false);
    assert.equal(c.economyLink, false);
    assert.notEqual(c.money.id, "balance");
    for (const line of allText(false)) assert.doesNotMatch(line, MONEY_WORDS, line);
    // Still says what matters: no real money, no cash-out, one wipe.
    assert.match(alphaShort(false).join(" "), /No real money/);
    assert.match(alphaShort(false).join(" "), /cashed out/);
    assert.match(c.wipeRemoves, /items/);
  });
});
