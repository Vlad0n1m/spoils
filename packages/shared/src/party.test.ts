/**
 * Party contract: ticket payload compatibility, the drop window, the no-friendly-fire rule, S2C.PARTY.
 * Run: apps/game-server/node_modules/.bin/tsx --test packages/shared/src/party.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { FRIENDS, PARTY, partyDropLive, partyMates } from "./party.js";
import { S2C } from "./protocol.js";
import { joinTicketPayload } from "./types.js";

const base = { userId: "u", nickname: "n", issuedAt: 5, loadoutId: "L", matchId: "m", entryId: "e" };

test("a ticket without party fields signs exactly the pre-party payload (old tickets stay valid)", () => {
  assert.equal(joinTicketPayload(base), "u.n.5.L.m.e");
  assert.equal(joinTicketPayload({ userId: "u", nickname: "n", issuedAt: 5, loadoutId: "L" }), "u.n.5.L..");
  assert.equal(joinTicketPayload({ ...base, dropId: "", partyId: "" }), "u.n.5.L.m.e");
});

test("dropId and partyId are appended after the existing fields and both are covered", () => {
  const t = { ...base, dropId: "d", partyId: "p" };
  assert.equal(joinTicketPayload(t), "u.n.5.L.m.e.d.p");
  assert.equal(joinTicketPayload({ ...base, partyId: "p" }), "u.n.5.L.m.e..p");
  const p = joinTicketPayload(t);
  assert.notEqual(joinTicketPayload({ ...t, dropId: "d2" }), p);
  assert.notEqual(joinTicketPayload({ ...t, partyId: "p2" }), p);
  assert.notEqual(joinTicketPayload({ ...t, dropId: undefined }), p);
  assert.notEqual(joinTicketPayload({ ...t, partyId: undefined }), p);
});

test("a party drop is live for PARTY.DROP_TTL_MS", () => {
  const d = { createdAt: 1_000_000, expiresAt: 1_000_000 + PARTY.DROP_TTL_MS };
  assert.equal(partyDropLive(d, 1_000_000), true);
  assert.equal(partyDropLive(d, 1_000_000 + PARTY.DROP_TTL_MS - 1), true);
  assert.equal(partyDropLive(d, 1_000_000 + PARTY.DROP_TTL_MS), false);
  assert.equal(partyDropLive(d, 1_000_000 - 60_000), false, "a drop from the future is not live");
});

test("party mates never damage each other; anyone without a party can be damaged", () => {
  assert.equal(PARTY.FRIENDLY_FIRE, false);
  assert.equal(partyMates("p1", "p1"), true);
  assert.equal(partyMates("p1", "p2"), false);
  assert.equal(partyMates("", ""), false);
  assert.equal(partyMates(undefined, undefined), false);
  assert.equal(partyMates(null, "p1"), false);
});

test("limits and the S2C.PARTY message name", () => {
  assert.equal(PARTY.MIN_SIZE, 2);
  assert.equal(PARTY.MAX_SIZE, 4);
  assert.equal(PARTY.INVITE_TTL_MS, 10 * 60_000);
  assert.equal(PARTY.DROP_TTL_MS, 60_000);
  assert.equal(PARTY.POLL_MS, 5_000);
  assert.equal(FRIENDS.MAX_FRIENDS, 100);
  assert.equal(FRIENDS.MAX_PENDING, 20);
  assert.equal(FRIENDS.ONLINE_WINDOW_MS, 2 * 60_000);
  assert.equal(S2C.PARTY, "party");
  assert.equal(new Set(Object.values(S2C)).size, Object.values(S2C).length);
});
