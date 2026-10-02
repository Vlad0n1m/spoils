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

const ticket = (over: Partial<{ userId: string; nickname: string; issuedAt: number }> = {}) =>
  signJoinTicket({ userId: "user-1", nickname: "Neo", issuedAt: NOW, ...over }, SECRET);

test("a valid ticket verifies (object or JSON string)", () => {
  withSecret(SECRET, () => {
    const t = ticket();
    assert.deepEqual(verifyJoinTicket(t, NOW + 1000), t);
    assert.deepEqual(verifyJoinTicket(JSON.stringify(t), NOW), t);
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
