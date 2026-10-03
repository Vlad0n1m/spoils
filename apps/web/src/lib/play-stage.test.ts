/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/play-stage.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JoinTicket } from "@extract/shared";
import { stageForUser, type PlayStage } from "./play-stage";

const ticketA: JoinTicket = { userId: "user-a", nickname: "Alice", issuedAt: 1, loadoutId: "", matchId: "m1", entryId: "e1", sig: "sig" };
const battle: PlayStage = { kind: "battle", ticket: ticketA, roomId: "r1", cycle: 100 };

describe("stageForUser", () => {
  it("keeps the menu for anyone", () => {
    const menu: PlayStage = { kind: "menu" };
    assert.equal(stageForUser(menu, null), menu);
    assert.equal(stageForUser(menu, "user-b"), menu);
  });

  it("keeps a battle for the account whose ticket it holds", () => {
    assert.equal(stageForUser(battle, "user-a"), battle);
  });

  it("drops a battle to the menu after sign-out", () => {
    assert.deepEqual(stageForUser(battle, null), { kind: "menu" });
    assert.deepEqual(stageForUser(battle, undefined), { kind: "menu" });
  });

  it("never resumes another account's ticket after a guest signs in on the same page", () => {
    assert.deepEqual(stageForUser(battle, "guest-b"), { kind: "menu" });
  });
});
