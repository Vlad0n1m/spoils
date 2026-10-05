/**
 * iDos sign-in bridge: the server-side session check and the postMessage protocol.
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/idos/verify.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { idosAccountKey, verifyIdosSession, verifyRequest, type IdosSessionClaim } from "./verify";
import { BRIDGE_VERSION, MSG_SESSION, nicknameBase, parseShellMessage } from "./bridge-protocol";

const claim: IdosSessionClaim = {
  titleId: "ABCD1234-DEV",
  userId: "9f86d081884c7d659a2feaa0c55ad015",
  ticket: "tkt.0123456789abcdef.signature",
};

function fakeFetch(status: number, body: unknown, seen: { url?: string; init?: RequestInit }[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

describe("verifyIdosSession", () => {
  it("calls the iDos Client API the way the SDK does", async () => {
    const seen: { url?: string; init?: RequestInit }[] = [];
    const r = await verifyIdosSession(claim, { fetchImpl: fakeFetch(200, { Success: true, Data: { Total: 1 } }, seen) });
    assert.deepEqual(r, { ok: true });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.url, "https://api.idosgames.com/api/v2/ABCD1234-DEV/Client/User/GetUsageTime/9f86d081884c7d659a2feaa0c55ad015");
    const h = seen[0]!.init!.headers as Record<string, string>;
    assert.equal(seen[0]!.init!.method, "POST");
    assert.equal(h.Authorization, `Bearer ${claim.ticket}`);
    assert.deepEqual(JSON.parse(String(seen[0]!.init!.body)), { UserID: claim.userId, ClientSessionTicket: claim.ticket });
  });

  it("honours a custom base URL without a double slash", () => {
    assert.equal(verifyRequest(claim, "https://api.example.test/").url.startsWith("https://api.example.test/api/v2/"), true);
  });

  it("refuses on 401/403 and on Success=false", async () => {
    assert.deepEqual(await verifyIdosSession(claim, { fetchImpl: fakeFetch(401, "") }), { ok: false, reason: "invalid" });
    assert.deepEqual(await verifyIdosSession(claim, { fetchImpl: fakeFetch(403, "") }), { ok: false, reason: "invalid" });
    assert.deepEqual(
      await verifyIdosSession(claim, { fetchImpl: fakeFetch(200, { Success: false, Error: "User data not found" }) }),
      { ok: false, reason: "invalid" },
    );
  });

  it("never signs in when iDos is down or answers garbage", async () => {
    assert.deepEqual(await verifyIdosSession(claim, { fetchImpl: fakeFetch(500, {}) }), { ok: false, reason: "unavailable" });
    assert.deepEqual(await verifyIdosSession(claim, { fetchImpl: fakeFetch(200, "<html>") }), { ok: false, reason: "unavailable" });
    const throwing = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    assert.deepEqual(await verifyIdosSession(claim, { fetchImpl: throwing }), { ok: false, reason: "unavailable" });
  });

  it("times out instead of hanging", async () => {
    const hanging = ((_u: unknown, init?: RequestInit) =>
      new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof fetch;
    assert.deepEqual(await verifyIdosSession(claim, { fetchImpl: hanging, timeoutMs: 20 }), { ok: false, reason: "unavailable" });
  });

  it("rejects malformed claims without calling iDos", async () => {
    const seen: { url?: string }[] = [];
    const f = fakeFetch(200, { Success: true }, seen);
    for (const bad of [
      { ...claim, titleId: "abcd1234" },
      { ...claim, titleId: "ABCD1234-PROD" },
      { ...claim, userId: "../../Admin" },
      { ...claim, userId: "a b" },
      { ...claim, ticket: "short" },
      { ...claim, ticket: "has space in it 0123456789" },
    ]) assert.deepEqual(await verifyIdosSession(bad, { fetchImpl: f }), { ok: false, reason: "invalid" }, JSON.stringify(bad));
    assert.equal(seen.length, 0);
  });

  it("keys accounts by Title and player", () => {
    assert.equal(idosAccountKey("ABCD1234", "u1"), "ABCD1234/u1");
    assert.notEqual(idosAccountKey("ABCD1234", "u1"), idosAccountKey("ABCD1234-DEV", "u1"));
  });
});

describe("bridge protocol", () => {
  const msg = { type: MSG_SESSION, v: BRIDGE_VERSION, titleId: "ABCD1234", userId: "u123456", ticket: "t".repeat(20), nickname: "Raider One" };
  it("accepts the shell's session message", () => {
    assert.deepEqual(parseShellMessage(msg), { titleId: "ABCD1234", userId: "u123456", ticket: "t".repeat(20), nickname: "Raider One" });
  });

  it("ignores everything else", () => {
    for (const bad of [null, "x", 1, {}, { ...msg, type: "other" }, { ...msg, v: 2 }, { ...msg, ticket: 5 }, { ...msg, userId: "" }])
      assert.equal(parseShellMessage(bad), null, JSON.stringify(bad));
  });

  it("fits iDos usernames to our nickname rules", () => {
    assert.equal(nicknameBase("Raider One!"), "RaiderOne");
    assert.equal(nicknameBase("ВасяПупкин"), "raider");
    assert.equal(nicknameBase(undefined), "raider");
    assert.equal(nicknameBase("a_very_long_username_here"), "a_very_long_");
  });
});
