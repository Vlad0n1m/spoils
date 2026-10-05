/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/spectate-ui.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nextMateKey, spectateEndedLine } from "./spectate-ui";

describe("spectate UI helpers", () => {
  it("cycles the mates in order and wraps", () => {
    const mates = [{ key: "p1" }, { key: "p4" }, { key: "p7" }];
    assert.equal(nextMateKey(mates, null), "p1");
    assert.equal(nextMateKey(mates, "p1"), "p4");
    assert.equal(nextMateKey(mates, "p7"), "p1");
    assert.equal(nextMateKey(mates, "gone"), "p1", "a mate who left: start over");
    assert.equal(nextMateKey([], "p1"), null);
  });
  it("explains why watching ended, not a manual stop", () => {
    assert.equal(spectateEndedLine({ reason: "mate_down", name: "Ana" }), "Ana is down.");
    assert.equal(spectateEndedLine({ reason: "mate_out", name: "Ana" }), "Ana got out.");
    assert.equal(spectateEndedLine({ reason: "wipe", name: "Ana" }), "The map wiped.");
    assert.equal(spectateEndedLine({ reason: "refused", name: "" }), "Can't watch that mate right now.");
    assert.equal(spectateEndedLine({ reason: "stopped", name: "Ana" }), null);
    assert.equal(spectateEndedLine(null), null);
  });
});
