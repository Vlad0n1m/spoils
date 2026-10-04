/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/room-exit.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CLOSE_CODES, WORLD_JOIN_ERR } from "@extract/shared";
import { describeRoomExit, errorCodeAndReason, splitJoinError } from "./room-exit";

describe("describeRoomExit", () => {
  it("loadout_rejected (with or without the EntryRejectReason detail) explains the released loadout", () => {
    for (const exit of [
      describeRoomExit(409, "loadout_rejected:expired"),
      describeRoomExit(409, "loadout_rejected"),
      describeRoomExit(CLOSE_CODES.LOADOUT_REJECTED),
      describeRoomExit(undefined, "loadout_rejected:weird_reason"),
    ]) {
      assert.ok(exit);
      assert.equal(exit.action, "retry");
      assert.equal(exit.code, "loadout_rejected");
      assert.equal(exit.title, "Loadout not locked");
      assert.doesNotMatch(exit.message, /network/i);
    }
    assert.match(describeRoomExit(409, "loadout_rejected:expired")!.message, /expired/);
  });

  it("maps every world join refusal to its text and action", () => {
    const cases: Array<[number, string, RegExp, "retry" | "back"]> = [
      [409, WORLD_JOIN_ERR.ENTRY_CLOSED, /Entry is closed — the next map opens soon/, "back"],
      [503, WORLD_JOIN_ERR.WORLD_FULL, /The map is full/, "retry"],
      [503, `${WORLD_JOIN_ERR.WORLD_FULL}:party`, /can't fit your whole party/, "retry"],
      [410, WORLD_JOIN_ERR.MAP_GONE, /This map just wiped/, "back"],
      [409, WORLD_JOIN_ERR.EXIT_SETTLING, /Settling your last raid…/, "retry"],
      [409, WORLD_JOIN_ERR.IN_RAID, /still on another map/, "back"],
      [409, WORLD_JOIN_ERR.ENTRY_LIMIT, /You've dropped into this map 4 times/, "back"],
      [503, WORLD_JOIN_ERR.WEB_UNAVAILABLE, /account service/, "retry"],
      [401, WORLD_JOIN_ERR.INVALID_TICKET, /no longer valid/, "retry"],
      [409, `${WORLD_JOIN_ERR.MAP_MISMATCH}:abc123`, /Reload the page/, "back"],
    ];
    for (const [status, reason, text, action] of cases) {
      const exit = describeRoomExit(status, reason);
      assert.ok(exit, reason);
      assert.equal(exit.code, splitJoinError(reason).code, reason);
      assert.match(`${exit.title} ${exit.message}`, text, reason);
      assert.equal(exit.action, action, reason);
    }
  });

  it("the wipe close is benign after an outcome, and explained without one", () => {
    assert.equal(describeRoomExit(CLOSE_CODES.WIPED, "", { hadOutcome: true }), null);
    const exit = describeRoomExit(CLOSE_CODES.WIPED);
    assert.ok(exit);
    assert.equal(exit.title, "The map wiped");
    assert.equal(exit.action, "back");
  });

  it("NOT_IN_WORLD replaces the old roster kick; JOINED_ELSEWHERE still explains the other tab", () => {
    assert.equal(describeRoomExit(CLOSE_CODES.NOT_IN_WORLD)?.code, "not_in_world");
    assert.equal(describeRoomExit(CLOSE_CODES.NOT_IN_WORLD)?.action, "back");
    assert.equal(describeRoomExit(CLOSE_CODES.JOINED_ELSEWHERE)?.title, "You joined from another tab");
  });

  it("normal closes need no message; unknown codes still read as a lost connection", () => {
    assert.equal(describeRoomExit(undefined), null);
    assert.equal(describeRoomExit(1000), null);
    assert.equal(describeRoomExit(4000), null);
    assert.equal(describeRoomExit(1006)?.title, "Connection lost");
    assert.equal(describeRoomExit(409, "something_new")?.title, "Connection lost");
  });
});

describe("splitJoinError / errorCodeAndReason", () => {
  it("splits code and detail", () => {
    assert.deepEqual(splitJoinError("map_mismatch:ABC:def"), { code: "map_mismatch", detail: "ABC:def" });
    assert.deepEqual(splitJoinError("World_Full"), { code: "world_full", detail: "" });
    assert.deepEqual(splitJoinError(undefined), { code: "", detail: "" });
  });
  it("reads colyseus.js errors", () => {
    assert.deepEqual(errorCodeAndReason({ code: 409, message: "entry_closed" }), { code: 409, reason: "entry_closed" });
    assert.deepEqual(errorCodeAndReason("boom"), { code: undefined, reason: "boom" });
    assert.deepEqual(errorCodeAndReason(null), { code: undefined, reason: "" });
  });
});
