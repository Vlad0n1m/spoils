/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/session-secret.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { productionEnvProblems } from "./env";
import { SESSION_SECRET_MIN, sessionPassword } from "./session-secret";

describe("session secret (security audit: forgeable sessions)", () => {
  it("production refuses a missing or short SESSION_SECRET instead of the public fallback / padding", () => {
    assert.throws(() => sessionPassword({ NODE_ENV: "production" }), /SESSION_SECRET/);
    assert.throws(() => sessionPassword({ NODE_ENV: "production", SESSION_SECRET: "short-secret" }), /SESSION_SECRET/);
    const good = "s".repeat(SESSION_SECRET_MIN);
    assert.equal(sessionPassword({ NODE_ENV: "production", SESSION_SECRET: ` ${good} ` }), good);
    assert.match(productionEnvProblems({ NODE_ENV: "production", CRON_SECRET: "c".repeat(32), SESSION_SECRET: "short" }).join(), /SESSION_SECRET/);
    assert.deepEqual(productionEnvProblems({ NODE_ENV: "production", CRON_SECRET: "c".repeat(32), SESSION_SECRET: good }), []);
  });

  it("dev and next build keep working without one", () => {
    assert.ok(sessionPassword({ NODE_ENV: "development" }).length >= SESSION_SECRET_MIN);
    assert.equal(sessionPassword({ NODE_ENV: "development", SESSION_SECRET: "abc" }).length, SESSION_SECRET_MIN);
    assert.ok(sessionPassword({ NODE_ENV: "production", NEXT_PHASE: "phase-production-build" }).length >= SESSION_SECRET_MIN);
  });
});
