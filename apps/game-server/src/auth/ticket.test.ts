import { test } from "node:test";
import assert from "node:assert/strict";
import { JOIN_TICKET_TTL_MS } from "@extract/shared";
import { signJoinTicket, verifyJoinTicket } from "./ticket.js";

const SECRET = "test-secret-0123456789abcdef";
const NOW = 1_700_000_000_000;

function withSecret<T>(secret: string | undefined, fn: () => T): T {
  const prev = process.env.GAME_SERVER_HMAC_SECRET;
  if (secret === undefined) delete process.env.GAME_SERVER_HMAC_SECRET;
  else process.env.GAME_SERVER_HMAC_SECRET = secret;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.GAME_SERVER_HMAC_SECRET;
    else process.env.GAME_SERVER_HMAC_SECRET = prev;
  }
}

const ticket = (over: Partial<{ userId: string; nickname: string; issuedAt: number; loadoutId: string }> = {}) =>
  signJoinTicket({ userId: "user-1", nickname: "Neo", issuedAt: NOW, ...over }, SECRET);

test("a valid ticket verifies (object or JSON string)", () => {
  withSecret(SECRET, () => {
    const t = ticket();
    assert.deepEqual(verifyJoinTicket(t, NOW + 1000), t);
    assert.deepEqual(verifyJoinTicket(JSON.stringify(t), NOW), t);
  });
});

test("the loadoutId is covered by the signature; \"\" = free kit; malformed ids are rejected", () => {
  withSecret(SECRET, () => {
    const free = ticket();
    assert.equal(free.loadoutId, "");
    assert.equal(verifyJoinTicket(free, NOW)?.loadoutId, "");
    const locked = ticket({ loadoutId: "0b9d2c1e-7f43-4a51-9c3e-2f1d8a6b5c40" });
    assert.equal(verifyJoinTicket(locked, NOW)?.loadoutId, locked.loadoutId);
    // Swapping in another loadout (or dropping it) breaks the signature.
    assert.equal(verifyJoinTicket({ ...locked, loadoutId: "other" }, NOW), null);
    assert.equal(verifyJoinTicket({ ...locked, loadoutId: "" }, NOW), null);
    const { loadoutId: _drop, ...noField } = locked;
    assert.equal(verifyJoinTicket(noField, NOW), null);
    // A ticket signed without the field verifies as the free kit (payload has an empty loadoutId).
    const { loadoutId: _d2, ...freeNoField } = free;
    assert.equal(verifyJoinTicket(freeNoField, NOW)?.loadoutId, "");
    // A "." would make the signed payload ambiguous; non-strings are malformed.
    assert.equal(verifyJoinTicket(ticket({ loadoutId: "a.b" }), NOW), null);
    assert.equal(verifyJoinTicket({ ...free, loadoutId: 7 }, NOW), null);
    assert.equal(verifyJoinTicket(ticket({ loadoutId: "x".repeat(65) }), NOW), null);
  });
});

test("a bad signature or tampered field is rejected", () => {
  withSecret(SECRET, () => {
    const t = ticket();
    assert.equal(verifyJoinTicket({ ...t, nickname: "Trinity" }, NOW), null);
    assert.equal(verifyJoinTicket({ ...t, sig: t.sig.replace(/^./, t.sig[0] === "a" ? "b" : "a") }, NOW), null);
    assert.equal(verifyJoinTicket({ ...t, sig: "abc" }, NOW), null);
    assert.equal(verifyJoinTicket(signJoinTicket({ userId: "user-1", nickname: "Neo", issuedAt: NOW }, "other-secret"), NOW), null);
  });
});

test("expired and future tickets are rejected", () => {
  withSecret(SECRET, () => {
    const t = ticket();
    assert.ok(verifyJoinTicket(t, NOW + JOIN_TICKET_TTL_MS - 1));
    assert.equal(verifyJoinTicket(t, NOW + JOIN_TICKET_TTL_MS + 1), null);
    assert.ok(verifyJoinTicket(t, NOW - 20_000), "small clock skew is fine");
    assert.equal(verifyJoinTicket(t, NOW - 31_000), null);
  });
});

test("malformed tickets are rejected", () => {
  withSecret(SECRET, () => {
    for (const bad of [null, undefined, 42, "not json", {}, [], { userId: "u" }]) {
      assert.equal(verifyJoinTicket(bad, NOW), null);
    }
    assert.equal(verifyJoinTicket(ticket({ nickname: "" }), NOW), null);
    assert.equal(verifyJoinTicket(ticket({ nickname: "x".repeat(25) }), NOW), null);
    assert.ok(verifyJoinTicket(ticket({ nickname: "x".repeat(24) }), NOW));
    assert.equal(verifyJoinTicket(ticket({ userId: "" }), NOW), null);
    assert.equal(verifyJoinTicket({ ...ticket(), issuedAt: String(NOW) }, NOW), null);
  });
});

test("without a secret every ticket is rejected", () => {
  const t = ticket();
  withSecret(undefined, () => {
    assert.equal(verifyJoinTicket(t, NOW), null);
  });
  withSecret("", () => {
    assert.equal(verifyJoinTicket(t, NOW), null);
  });
});

test("WORLD v6: matchId / entryId are covered by the signature; legacy tickets still verify", () => {
  withSecret(SECRET, () => {
    const matchId = "0b9d2c1e-7f43-4a51-9c3e-2f1d8a6b5c40";
    const entryId = "6f1c7e2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
    const t = signJoinTicket({ userId: "user-1", nickname: "Neo", issuedAt: NOW, matchId, entryId }, SECRET);
    assert.deepEqual(verifyJoinTicket(t, NOW), t);
    assert.equal(verifyJoinTicket(JSON.stringify(t), NOW)?.entryId, entryId);
    // Swapping the map or the entry breaks the signature; so does dropping either.
    assert.equal(verifyJoinTicket({ ...t, matchId: "1b9d2c1e-7f43-4a51-9c3e-2f1d8a6b5c40" }, NOW), null);
    assert.equal(verifyJoinTicket({ ...t, entryId: "7f1c7e2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b" }, NOW), null);
    const { entryId: _e, ...noEntry } = t;
    assert.equal(verifyJoinTicket(noEntry, NOW), null);
    // Malformed ids are refused before the signature check.
    assert.equal(verifyJoinTicket({ ...t, matchId: "not-a-uuid" }, NOW), null);
    assert.equal(verifyJoinTicket({ ...t, entryId: 7 }, NOW), null);
    // A legacy ticket (no world fields) verifies and carries none.
    const legacy = ticket();
    const v = verifyJoinTicket(legacy, NOW)!;
    assert.equal(v.matchId, undefined);
    assert.equal(v.entryId, undefined);
    // Upper-case ids verify (the web's casing is signed) and come out lower-case (shard lookup).
    const up = signJoinTicket({ userId: "user-1", nickname: "Neo", issuedAt: NOW, matchId: matchId.toUpperCase(), entryId }, SECRET);
    assert.equal(verifyJoinTicket(up, NOW)?.matchId, matchId);
  });
});

test("party: dropId / partyId are signed after the world fields; solo tickets sign the old payload", () => {
  withSecret(SECRET, () => {
    const matchId = "0b9d2c1e-7f43-4a51-9c3e-2f1d8a6b5c40";
    const entryId = "6f1c7e2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
    const dropId = "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d";
    const partyId = "9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a";
    const t = signJoinTicket({ userId: "user-1", nickname: "Neo", issuedAt: NOW, matchId, entryId, dropId, partyId }, SECRET);
    assert.deepEqual(verifyJoinTicket(t, NOW), t);
    // Moving the ticket to another drop / party, or dropping a field, breaks the signature.
    assert.equal(verifyJoinTicket({ ...t, dropId: "3a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d" }, NOW), null);
    assert.equal(verifyJoinTicket({ ...t, partyId: "8f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a" }, NOW), null);
    const { dropId: _d, ...noDrop } = t;
    assert.equal(verifyJoinTicket(noDrop, NOW), null);
    const { partyId: _p, ...noParty } = t;
    assert.equal(verifyJoinTicket(noParty, NOW), null);
    // Malformed ids are refused before the signature check.
    assert.equal(verifyJoinTicket({ ...t, dropId: "nope" }, NOW), null);
    assert.equal(verifyJoinTicket({ ...t, partyId: 5 }, NOW), null);
    // A member following on their own (partyId only) verifies without a dropId.
    const member = signJoinTicket({ userId: "user-2", nickname: "Ann", issuedAt: NOW, matchId, entryId, partyId }, SECRET);
    const v = verifyJoinTicket(member, NOW)!;
    assert.equal(v.partyId, partyId);
    assert.equal(v.dropId, undefined);
    // Upper-case ids verify and come out lower-case.
    const up = signJoinTicket({ userId: "user-1", nickname: "Neo", issuedAt: NOW, matchId, entryId, dropId: dropId.toUpperCase(), partyId: partyId.toUpperCase() }, SECRET);
    const u = verifyJoinTicket(up, NOW)!;
    assert.equal(u.dropId, dropId);
    assert.equal(u.partyId, partyId);
    // A dropId without its partyId still verifies (it is signed) but drops solo: no party fields.
    const lone = signJoinTicket({ userId: "user-3", nickname: "Lone", issuedAt: NOW, matchId, entryId, dropId }, SECRET);
    const l = verifyJoinTicket(lone, NOW)!;
    assert.equal(l.dropId, undefined);
    assert.equal(l.partyId, undefined);
    // Solo tickets are unchanged: no party fields, the pre-party payload.
    const solo = signJoinTicket({ userId: "user-1", nickname: "Neo", issuedAt: NOW, matchId, entryId }, SECRET);
    assert.deepEqual(verifyJoinTicket(solo, NOW), solo);
    // dropSize (seats the shard holds for the drop) is signed after the party fields.
    const sized = signJoinTicket({ userId: "user-4", nickname: "Pair", issuedAt: NOW, matchId, entryId, dropId, partyId, dropSize: 2 }, SECRET);
    assert.equal(verifyJoinTicket(sized, NOW)?.dropSize, 2);
    assert.equal(verifyJoinTicket({ ...sized, dropSize: 4 }, NOW), null, "a re-sized drop fails the signature");
    const { dropSize: _s, ...unsized } = sized;
    assert.equal(verifyJoinTicket(unsized, NOW), null);
    assert.equal(verifyJoinTicket({ ...sized, dropSize: 9 }, NOW), null, "out of range");
    assert.equal(verifyJoinTicket({ ...sized, dropSize: "2" }, NOW), null);
    // A party ticket from before dropSize still verifies (and the shard holds a full party for it).
    assert.equal(verifyJoinTicket(t, NOW)?.dropSize, undefined);
  });
});
