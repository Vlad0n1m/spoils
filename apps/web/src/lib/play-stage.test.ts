/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/play-stage.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JoinTicket } from "@extract/shared";
import { stageForUser, type PlayStage } from "./play-stage";

const ticketA: JoinTicket = { userId: "user-a", nickname: "Alice", issuedAt: 1, sig: "sig" };

describe("stageForUser", () => {
  it("keeps the lobby for anyone", () => {
    const lobby: PlayStage = { kind: "lobby" };
    assert.equal(stageForUser(lobby, null), lobby);
    assert.equal(stageForUser(lobby, "user-b"), lobby);
  });

  it("keeps a search or raid for the account whose ticket it holds", () => {
    const mm: PlayStage = { kind: "matchmaking", ticket: ticketA, roomName: "mm", searchId: 1 };
    const battle: PlayStage = { kind: "battle", ticket: ticketA, battleRoomId: "r1" };
    assert.equal(stageForUser(mm, "user-a"), mm);
    assert.equal(stageForUser(battle, "user-a"), battle);
  });

  it("drops a search to the lobby after sign-out", () => {
    const mm: PlayStage = { kind: "matchmaking", ticket: ticketA, roomName: "mm", searchId: 1 };
    assert.deepEqual(stageForUser(mm, null), { kind: "lobby" });
    assert.deepEqual(stageForUser(mm, undefined), { kind: "lobby" });
  });

  it("never resumes another account's ticket after a guest signs in on the same page", () => {
    const mm: PlayStage = { kind: "matchmaking", ticket: ticketA, roomName: "mm", searchId: 1 };
    const battle: PlayStage = { kind: "battle", ticket: ticketA, battleRoomId: "r1" };
    assert.deepEqual(stageForUser(mm, "guest-b"), { kind: "lobby" });
    assert.deepEqual(stageForUser(battle, "guest-b"), { kind: "lobby" });
  });
});
