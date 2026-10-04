/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/wallet-dev-topup-server.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { devTopupAllowedOnServer } from "./wallet-dev-topup-server";

describe("dev top-up server gate (security audit: minted balance in production)", () => {
  it("dev: on by default, off with 0|false", () => {
    assert.equal(devTopupAllowedOnServer({ NODE_ENV: "development" }), true);
    assert.equal(devTopupAllowedOnServer({ NODE_ENV: "development", NEXT_PUBLIC_WALLET_DEV_TOPUP: "0" }), false);
    assert.equal(devTopupAllowedOnServer({ NODE_ENV: "test" }), false);
    assert.equal(devTopupAllowedOnServer({ NODE_ENV: "test", NEXT_PUBLIC_WALLET_DEV_TOPUP: "1" }), true);
  });

  it("production: the public flag alone is refused", () => {
    assert.equal(devTopupAllowedOnServer({ NODE_ENV: "production", NEXT_PUBLIC_WALLET_DEV_TOPUP: "1" }), false);
    assert.equal(devTopupAllowedOnServer({ NODE_ENV: "production", NEXT_PUBLIC_WALLET_DEV_TOPUP: "true" }), false);
  });

  it("production: only an explicit demo switch off mainnet", () => {
    const demo = { NODE_ENV: "production", NEXT_PUBLIC_WALLET_DEV_TOPUP: "1", WALLET_DEV_TOPUP_PRODUCTION: "1" };
    assert.equal(devTopupAllowedOnServer(demo), true);
    assert.equal(devTopupAllowedOnServer({ ...demo, SOLANA_CLUSTER: "mainnet-beta" }), false);
    assert.equal(devTopupAllowedOnServer({ ...demo, NEXT_PUBLIC_SOLANA_CLUSTER: "mainnet-beta" }), false);
    assert.equal(devTopupAllowedOnServer({ ...demo, NEXT_PUBLIC_WALLET_DEV_TOPUP: "0" }), false);
  });
});
