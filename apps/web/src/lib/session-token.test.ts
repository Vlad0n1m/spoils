/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/session-token.test.ts
 * Header-carried session (iDos edition): the bearer parser and the one-value cookie store that
 * iron-session reads and writes.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getIronSession, sealData } from "iron-session";
import { TokenCookieStore, bearerToken } from "./session-token";

const password = "x".repeat(40);

describe("bearerToken", () => {
  it("takes an iron seal from a Bearer header and nothing else", () => {
    assert.equal(bearerToken("Bearer Fe26.2*abc"), "Fe26.2*abc");
    assert.equal(bearerToken("Bearer none"), "", "first sign-in: an empty token session");
    assert.equal(bearerToken("bearer  Fe26.2*abc "), "Fe26.2*abc");
    assert.equal(bearerToken(null), null);
    assert.equal(bearerToken("Basic Fe26.2*abc"), null);
    assert.equal(bearerToken("Bearer something-else"), null);
    assert.equal(bearerToken(`Bearer Fe26.2${"a".repeat(5000)}`), null);
  });
});

describe("TokenCookieStore with iron-session", () => {
  it("reads a sealed session and writes the new seal on save / clears it on destroy", async () => {
    const seal = await sealData({ userId: "u1", nickname: "Rook" }, { password, ttl: 3600 });
    const store = new TokenCookieStore("extract_session", seal);
    const s = await getIronSession<{ userId?: string; nickname?: string }>(store, { password, cookieName: "extract_session", ttl: 3600 });
    assert.equal(s.userId, "u1");
    s.nickname = "Bishop";
    await s.save();
    assert.notEqual(store.value, seal);
    const again = await getIronSession<{ nickname?: string }>(new TokenCookieStore("extract_session", store.value), { password, cookieName: "extract_session", ttl: 3600 });
    assert.equal(again.nickname, "Bishop");
    s.destroy();
    assert.equal(store.value, "");
  });

  it("an empty token starts an empty session whose save() yields the first seal", async () => {
    const store = new TokenCookieStore("extract_session", "");
    const s = await getIronSession<{ userId?: string }>(store, { password, cookieName: "extract_session", ttl: 3600 });
    assert.equal(s.userId, undefined);
    s.userId = "u2";
    await s.save();
    assert.ok(store.value.startsWith("Fe26.2"));
  });

  it("a forged or foreign token gives an empty session", async () => {
    const foreign = await sealData({ userId: "u1" }, { password: "y".repeat(40), ttl: 3600 });
    const s = await getIronSession<{ userId?: string }>(new TokenCookieStore("extract_session", foreign), { password, cookieName: "extract_session", ttl: 3600 });
    assert.equal(s.userId, undefined);
  });
});
