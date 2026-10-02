import { test } from "node:test";
import assert from "node:assert/strict";
import { INTENT_BURST, INTENTS_PER_SEC, IntentLimiter } from "./intent-limit.js";

test("intent limiter: a burst passes, a flood is dropped, tokens refill per client", () => {
  let now = 0;
  const lim = new IntentLimiter(INTENTS_PER_SEC, INTENT_BURST, () => now);
  const a = {}, b = {};
  let ok = 0;
  for (let k = 0; k < 5000; k++) if (lim.take(a)) ok++;
  assert.equal(ok, INTENT_BURST, "5000 SWITCH messages in one instant: only the burst gets through");
  assert.ok(lim.take(b), "another client has its own bucket");
  now += 1000;
  ok = 0;
  for (let k = 0; k < 5000; k++) if (lim.take(a)) ok++;
  assert.equal(ok, INTENTS_PER_SEC, "one second later: the refill only");
  // An honest client (a few intents per second) never hits the limit.
  const c = {};
  for (let t = 0; t < 60_000; t += 200) {
    now = 10_000 + t;
    assert.ok(lim.take(c));
  }
});
