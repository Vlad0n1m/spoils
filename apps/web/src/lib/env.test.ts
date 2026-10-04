/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/env.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isCronAuthorized, parseCoreEnv, productionEnvProblems } from "./env";

const base = {
  DATABASE_URL: "postgres://u:p@localhost:5432/extract_test",
  SESSION_SECRET: "x".repeat(40),
  GAME_SERVER_HMAC_SECRET: "y".repeat(32),
};
const secret = "c".repeat(32);

describe("web env", () => {
  it("dev works without CRON_SECRET and treats empty values as unset", () => {
    const env = parseCoreEnv({ ...base, NODE_ENV: "development", CRON_SECRET: "", SOLANA_RPC_URL: "" });
    assert.equal(env.CRON_SECRET, undefined);
    assert.equal(env.SOLANA_RPC_URL, "https://api.devnet.solana.com");
    assert.equal(env.SOLANA_CLUSTER, "devnet");
  });

  it("production refuses to run without a CRON_SECRET of 16+ characters", () => {
    assert.match(productionEnvProblems({ ...base, NODE_ENV: "production" }).join(), /CRON_SECRET/);
    assert.match(productionEnvProblems({ ...base, NODE_ENV: "production", CRON_SECRET: "short-secret" }).join(), /16/);
    assert.throws(() => parseCoreEnv({ ...base, NODE_ENV: "production" }), /Invalid server env/);
    assert.equal(parseCoreEnv({ ...base, NODE_ENV: "production", CRON_SECRET: secret }).CRON_SECRET, secret);
  });

  it("next build is not the production runtime", () => {
    const env = { ...base, NODE_ENV: "production", NEXT_PHASE: "phase-production-build" };
    assert.deepEqual(productionEnvProblems(env), []);
  });

  it("cron auth wants the exact Bearer header; open only outside production without a secret", () => {
    assert.equal(isCronAuthorized(`Bearer ${secret}`, secret, { NODE_ENV: "production" }), true);
    assert.equal(isCronAuthorized(`Bearer ${secret}x`, secret, { NODE_ENV: "production" }), false);
    assert.equal(isCronAuthorized(secret, secret, { NODE_ENV: "production" }), false);
    assert.equal(isCronAuthorized(null, secret, { NODE_ENV: "development" }), false);
    assert.equal(isCronAuthorized(null, undefined, { NODE_ENV: "development" }), true);
    assert.equal(isCronAuthorized(null, undefined, { NODE_ENV: "production" }), false);
  });
});
