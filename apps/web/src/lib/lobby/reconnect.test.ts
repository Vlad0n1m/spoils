/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/lobby/reconnect.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CLOSE_CODES } from "@extract/shared";
import { describeRoomExit } from "../room-exit";
import { RECONNECT, autoRejoinStep, reconnectDelayMs, rejoinFailureIsFinal, shouldAutoReconnect } from "./reconnect";

describe("mid-raid socket drop", () => {
  it("reconnects by itself only after an abnormal close with no outcome yet", () => {
    const lost = describeRoomExit(1006);
    assert.equal(lost?.code, "connection_lost");
    assert.equal(shouldAutoReconnect(lost, false), true);
    assert.equal(shouldAutoReconnect(lost, true), false, "dead or extracted: the result screen, no reconnect");
    assert.equal(shouldAutoReconnect(null, false), false, "a plain close");
    assert.equal(shouldAutoReconnect(describeRoomExit(CLOSE_CODES.WIPED), false), false);
    assert.equal(shouldAutoReconnect(describeRoomExit(CLOSE_CODES.JOINED_ELSEWHERE), false), false);
    assert.equal(shouldAutoReconnect(describeRoomExit(CLOSE_CODES.NOT_IN_WORLD), false), false);
    assert.equal(shouldAutoReconnect(describeRoomExit(4002), false), false, "the room itself closed");
  });

  it("backs off 1 s, 2 s, 4 s over MAX_TRIES tries, well inside the server's shelter window", () => {
    assert.equal(RECONNECT.MAX_TRIES, 3);
    assert.deepEqual([1, 2, 3].map(reconnectDelayMs), [1_000, 2_000, 4_000]);
  });

  it("stops when the raider is gone or the session is, tries again on network and server hiccups", () => {
    for (const [status, error] of [[409, "not_on_map"], [409, "in_raid"], [401, "unauthenticated"], [403, ""]] as const) {
      assert.equal(rejoinFailureIsFinal(status, error), true, `${status} ${error}`);
    }
    for (const [status, error] of [[0, ""], [500, ""], [503, "world_starting"], [502, ""]] as const) {
      assert.equal(rejoinFailureIsFinal(status, error), false, `${status} ${error}`);
    }
  });
});

describe("page-load auto-rejoin", () => {
  it("joins once on REJOIN in a visible tab, waits while loading or hidden, skips anything else", () => {
    assert.equal(autoRejoinStep("rejoin", true), "join");
    assert.equal(autoRejoinStep("rejoin", false), "wait");
    assert.equal(autoRejoinStep("loading", true), "wait");
    assert.equal(autoRejoinStep("joining", true), "wait");
    for (const k of ["ready", "closed", "armed", "gear_in_raid", "offline", "signed_out"]) assert.equal(autoRejoinStep(k, true), "skip", k);
  });
});
