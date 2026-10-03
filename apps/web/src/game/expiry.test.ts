/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/expiry.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WORLD } from "@extract/shared";
import { BLINK_FAST_PERIOD_MS, BLINK_MIN, BLINK_PERIOD_MS, expiryBlink, expiryFading } from "./expiry";

describe("expiry blink (A6)", () => {
  const exp = 20 * 60_000;
  it("does nothing for items that never expire or are far from it", () => {
    assert.equal(expiryBlink(0, exp), 1);
    assert.equal(expiryBlink(undefined, exp), 1);
    assert.equal(expiryBlink(exp, exp - WORLD.EXPIRE_WARN_MS - 1), 1);
  });
  it("blinks between BLINK_MIN and 1 in the last minute, faster at the end", () => {
    const at = (t: number) => expiryBlink(exp, t);
    let lo = 1;
    let hi = 0;
    for (let t = exp - WORLD.EXPIRE_WARN_MS; t < exp; t += 50) {
      const a = at(t);
      assert.ok(a >= BLINK_MIN - 1e-9 && a <= 1 + 1e-9);
      lo = Math.min(lo, a);
      hi = Math.max(hi, a);
    }
    assert.ok(lo < 0.4 && hi > 0.95);
    // Phase follows the match clock: one full period apart → same alpha.
    const slow = exp - 40_000;
    assert.ok(Math.abs(at(slow + 123) - at(slow + 123 + BLINK_PERIOD_MS)) < 1e-9);
    const fast = exp - 10_000;
    assert.ok(Math.abs(at(fast + 77) - at(fast + 77 + BLINK_FAST_PERIOD_MS)) < 1e-9);
    assert.ok(Math.abs(at(fast) - at(fast + BLINK_FAST_PERIOD_MS / 2)) > 0.5);
  });
  it("tells an expiry removal from a pick-up", () => {
    assert.equal(expiryFading(exp, exp - 30_000), false);
    assert.equal(expiryFading(exp, exp - 500), true);
    assert.equal(expiryFading(exp, exp + 2_000), true);
    assert.equal(expiryFading(0, exp), false);
  });
});
