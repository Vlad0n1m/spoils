/**
 * The SPOILS token price source (lib/idos/token-price.ts): Jupiter body parsing, the 60 s cache, the
 * last good price kept for at most 10 minutes, and the mint from the env.
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/idos/token-price.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SPOILS_MINT, JUPITER_PRICE_URL, createTokenPriceSource, parseJupiterPrice, spoilsMint } from "./token-price";

const MINT = DEFAULT_SPOILS_MINT;

function fakeJupiter(answers: Array<number | "fail">) {
  const urls: string[] = [];
  const impl = (async (url: string | URL | Request) => {
    urls.push(String(url));
    const a = answers.shift();
    if (a === undefined || a === "fail") return new Response("{}", { status: 500 });
    return new Response(JSON.stringify({ [MINT]: { usdPrice: a, decimals: 6 } }), { status: 200 });
  }) as typeof fetch;
  return { impl, urls };
}

describe("token price", () => {
  it("parses usdPrice of the mint", () => {
    assert.equal(parseJupiterPrice({ [MINT]: { usdPrice: 0.0000036 } }, MINT), 0.0000036);
    assert.equal(parseJupiterPrice({ [MINT]: { usdPrice: "0.0000036" } }, MINT), 0.0000036);
    assert.equal(parseJupiterPrice({}, MINT), null);
    assert.equal(parseJupiterPrice({ [MINT]: { usdPrice: 0 } }, MINT), null);
    assert.equal(parseJupiterPrice({ [MINT]: { usdPrice: -1 } }, MINT), null);
    assert.equal(parseJupiterPrice(null, MINT), null);
  });

  it("uses IDOS_TOKEN_MINT when it is a mint, else the SPOILS mint", () => {
    assert.equal(spoilsMint(undefined), MINT);
    assert.equal(spoilsMint("  "), MINT);
    assert.equal(spoilsMint("not a mint!"), MINT);
    assert.equal(spoilsMint("So11111111111111111111111111111111111111112"), "So11111111111111111111111111111111111111112");
  });

  it("caches 60 s, keeps the last good price up to 10 min on failures, then has none", async () => {
    let t = 1_000_000;
    const j = fakeJupiter([0.0000036, "fail", "fail", 0.000004]);
    const src = createTokenPriceSource({ fetchImpl: j.impl, now: () => t });
    assert.deepEqual(await src.get(), { usd: 0.0000036, at: 1_000_000 });
    assert.equal(j.urls[0], `${JUPITER_PRICE_URL}?ids=${MINT}`);
    t += 59_000;
    await src.get();
    assert.equal(j.urls.length, 1, "cached for 60 s");
    t += 2_000;
    assert.equal((await src.get())?.usd, 0.0000036, "a failed refresh keeps the last good price");
    assert.equal(j.urls.length, 2);
    t = 1_000_000 + 10 * 60_000 + 1;
    assert.equal(await src.get(), null, "older than 10 min: no price, no sales");
    assert.equal(src.peek(), null);
    assert.equal((await src.get())?.usd, 0.000004, "a later success brings it back");
  });

  it("shares one request between concurrent callers", async () => {
    const j = fakeJupiter([0.0000036]);
    const src = createTokenPriceSource({ fetchImpl: j.impl, now: () => 5 });
    const [a, b] = await Promise.all([src.get(), src.get()]);
    assert.equal(a?.usd, 0.0000036);
    assert.equal(b?.usd, 0.0000036);
    assert.equal(j.urls.length, 1);
  });
});
