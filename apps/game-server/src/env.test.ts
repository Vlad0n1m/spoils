/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/game-server/src/env.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertProductionEnv, productionEnvProblems } from "./env.js";

const prod = {
  NODE_ENV: "production",
  GAME_SERVER_ID: "world-1",
  WEB_API_BASE_URL: "http://web:3000",
  GAME_SERVER_HMAC_SECRET: "0123456789abcdef0123456789abcdef",
};

describe("game-server production env", () => {
  it("passes a complete production env and ignores dev", () => {
    assert.deepEqual(productionEnvProblems(prod), []);
    assert.deepEqual(productionEnvProblems({ NODE_ENV: "development" }), []);
    assert.deepEqual(productionEnvProblems({}), []);
  });

  it("lists every missing production variable", () => {
    const problems = productionEnvProblems({ NODE_ENV: "production", GAME_SERVER_HMAC_SECRET: "short" });
    assert.equal(problems.length, 3);
    assert.match(problems.join(" "), /GAME_SERVER_ID/);
    assert.match(problems.join(" "), /WEB_API_BASE_URL/);
    assert.match(problems.join(" "), /GAME_SERVER_HMAC_SECRET/);
  });

  it("throws without GAME_SERVER_ID and never echoes values", () => {
    const env = { ...prod, GAME_SERVER_ID: " " };
    assert.throws(() => assertProductionEnv(env), (e: Error) => {
      assert.match(e.message, /GAME_SERVER_ID/);
      assert.doesNotMatch(e.message, /0123456789abcdef/);
      return true;
    });
  });
});
