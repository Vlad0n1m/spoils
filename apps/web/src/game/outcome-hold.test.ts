/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/outcome-hold.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CINE } from "./cinematics";
import { OUTCOME_HOLD_MS, cineExitOf, outcomeHoldMs } from "./outcome-hold";

describe("outcome overlay hold", () => {
  it("lets the canvas beats land before the overlay dims and covers them", () => {
    // Extraction: the stamp slams and the auto-sell line fades in (250 ms) before the hold ends.
    assert.ok(OUTCOME_HOLD_MS.extract >= CINE.STAMP_AT_MS + CINE.STAMP_MS + 250);
    // Death: the KILLED BY card, the desaturation, the pan and the fade all complete first.
    assert.ok(OUTCOME_HOLD_MS.death >= CINE.DEATH_CARD_AT_MS + CINE.DEATH_CARD_MS);
    assert.ok(OUTCOME_HOLD_MS.death >= CINE.DEATH_DESAT_MS);
    assert.ok(OUTCOME_HOLD_MS.death >= CINE.PAN_AT_MS + CINE.PAN_TAU_MS);
    assert.ok(OUTCOME_HOLD_MS.death >= CINE.DEATH_FADE_MS);
  });

  it("picks the beat from the HUD first, then from the outcome message", () => {
    assert.equal(cineExitOf({ alive: true, extractedAt: 0 }, null), null);
    assert.equal(cineExitOf({ alive: false, extractedAt: 61_000 }, null), "extract");
    assert.equal(cineExitOf({ alive: false, extractedAt: 0 }, null), "death");
    assert.equal(cineExitOf({ alive: true, extractedAt: 0 }, "dead"), "death", "OUTCOME before the HUD patch");
    assert.equal(cineExitOf(null, "extract"), "extract");
    assert.equal(cineExitOf(null, "timeout"), null);
  });

  it("does not hold once the raid ended or the room is gone", () => {
    assert.equal(outcomeHoldMs("death", "open", false), OUTCOME_HOLD_MS.death);
    assert.equal(outcomeHoldMs("extract", "open", false), OUTCOME_HOLD_MS.extract);
    assert.equal(outcomeHoldMs("death", "ended", false), 0, "timeout: 'Time's up' right away");
    assert.equal(outcomeHoldMs("death", "open", true), 0);
    assert.equal(outcomeHoldMs(null, "open", false), 0);
  });
});
