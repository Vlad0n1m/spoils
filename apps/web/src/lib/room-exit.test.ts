/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/room-exit.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CLOSE_CODES } from "@extract/shared";
import { describeRoomExit } from "./room-exit";

describe("describeRoomExit", () => {
  it("LOADOUT_REJECTED (4104) explains the released loadout instead of blaming the network", () => {
    for (const exit of [describeRoomExit(CLOSE_CODES.LOADOUT_REJECTED, "loadout_rejected"), describeRoomExit(4104), describeRoomExit(undefined, "loadout_rejected")]) {
      assert.ok(exit);
      assert.equal(exit.action, "retry");
      assert.equal(exit.title, "Loadout not locked");
      assert.doesNotMatch(exit.message, /network/i);
    }
  });

  it("normal closes need no message; unknown codes still read as a lost connection", () => {
    assert.equal(describeRoomExit(undefined), null);
    assert.equal(describeRoomExit(1000), null);
    assert.equal(describeRoomExit(1006)?.title, "Connection lost");
  });
});
