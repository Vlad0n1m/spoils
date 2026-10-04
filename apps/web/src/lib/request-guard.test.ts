/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/request-guard.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkApiMutation, checkSameOriginRequest, isServerToServerApi } from "./request-guard";

const req = (headers: Record<string, string>) =>
  new Request("https://game.example/api/auth/login", { method: "POST", headers: { host: "game.example", ...headers } });

describe("checkSameOriginRequest", () => {
  it("allows the app's own fetch (same-origin, application/json)", () => {
    assert.equal(
      checkSameOriginRequest(
        req({ origin: "https://game.example", "sec-fetch-site": "same-origin", "content-type": "application/json" }),
        { json: true },
      ),
      null,
    );
    assert.equal(checkSameOriginRequest(req({ "content-type": "application/json; charset=utf-8" }), { json: true }), null, "no browser headers (server-side caller)");
    assert.equal(checkSameOriginRequest(req({ origin: "https://game.example", "sec-fetch-site": "same-origin" }), { json: false }), null, "logout without a body");
  });

  it("blocks a cross-site text/plain form post that parses as JSON (login CSRF)", () => {
    const attack = req({ origin: "https://evil.example", "sec-fetch-site": "cross-site", "content-type": "text/plain" });
    assert.deepEqual(checkSameOriginRequest(attack, { json: true }), { status: 403, error: "cross_site" });
    assert.deepEqual(checkSameOriginRequest(attack, { json: false }), { status: 403, error: "cross_site" }, "forced logout");
  });

  it("blocks a foreign Origin even without fetch metadata, and same-site subdomains", () => {
    assert.equal(checkSameOriginRequest(req({ origin: "https://evil.example", "content-type": "application/json" }), { json: true })?.error, "cross_site");
    assert.equal(checkSameOriginRequest(req({ origin: "null", "content-type": "application/json" }), { json: true })?.error, "cross_site");
    assert.equal(checkSameOriginRequest(req({ "sec-fetch-site": "same-site", "content-type": "application/json" }), { json: true })?.error, "cross_site");
  });

  it("requires application/json for body routes (a form cannot send it cross-origin)", () => {
    for (const ct of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", ""]) {
      const r = req(ct ? { "content-type": ct } : {});
      assert.deepEqual(checkSameOriginRequest(r, { json: true }), { status: 415, error: "unsupported_media_type" }, ct);
    }
  });

  it("accepts the proxy's X-Forwarded-Host as the app host", () => {
    const r = new Request("http://internal:3000/api/auth/login", {
      method: "POST",
      headers: { host: "internal:3000", "x-forwarded-host": "game.example", origin: "https://game.example", "content-type": "application/json" },
    });
    assert.equal(checkSameOriginRequest(r, { json: true }), null);
  });
});

describe("checkApiMutation (middleware.ts, every /api route)", () => {
  const api = (path: string, method: string, headers: Record<string, string>) =>
    new Request(`https://idos.example${path}`, { method, headers: { host: "idos.example", ...headers } });
  const listingBody = JSON.stringify({ listingId: "00000000-0000-4000-8000-000000000001" });

  it("blocks a cross-site text/plain form post to market/buy (SameSite=None cookie of the iDos edition)", () => {
    const attack = new Request("https://idos.example/api/market/buy", {
      method: "POST",
      headers: { host: "idos.example", origin: "https://evil.example", "sec-fetch-site": "cross-site", "content-type": "text/plain" },
      body: listingBody,
    });
    assert.deepEqual(checkApiMutation(attack), { status: 403, error: "cross_site" });
    // without fetch metadata or Origin (old browser), the form body type alone is refused
    const bare = new Request("https://idos.example/api/market/buy", { method: "POST", headers: { host: "idos.example", "content-type": "text/plain" }, body: listingBody });
    assert.deepEqual(checkApiMutation(bare), { status: 415, error: "unsupported_media_type" });
  });

  it("covers every state-changing method and the money routes", () => {
    for (const [path, method] of [
      ["/api/market/buy", "POST"],
      ["/api/market/list", "POST"],
      ["/api/market/cancel", "POST"],
      ["/api/trader/buy", "POST"],
      ["/api/stash/starter", "POST"],
      ["/api/loadout/draft", "PUT"],
      ["/api/loadout/unlock", "POST"],
      ["/api/world/join", "POST"],
      ["/api/withdraw", "POST"],
      ["/api/wallet/link", "DELETE"],
    ]) {
      const r = api(path!, method!, { "sec-fetch-site": "cross-site", "content-type": "application/json" });
      assert.deepEqual(checkApiMutation(r), { status: 403, error: "cross_site" }, `${method} ${path}`);
    }
    for (const ct of ["application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
      assert.equal(checkApiMutation(api("/api/trader/buy", "POST", { "sec-fetch-site": "same-origin", "content-type": ct }))?.status, 415, ct);
    }
  });

  it("lets the app's own calls through, including the page inside the iDos iframe", () => {
    const own = { origin: "https://idos.example", "sec-fetch-site": "same-origin" };
    assert.equal(checkApiMutation(api("/api/market/buy", "POST", { ...own, "content-type": "application/json" })), null);
    assert.equal(checkApiMutation(api("/api/loadout/unlock", "POST", own)), null, "bodiless POST");
    assert.equal(checkApiMutation(api("/api/market/buy", "GET", { "sec-fetch-site": "cross-site" })), null, "reads are not guarded");
    assert.equal(checkApiMutation(api("/api/market/buy", "POST", { "x-forwarded-host": "idos.example", origin: "https://idos.example", "content-type": "application/json" })), null);
  });

  it("leaves the game server (HMAC) and cron (Bearer) routes to their own checks", () => {
    for (const path of ["/api/raids/end", "/api/raids/exit", "/api/world/event", "/api/cron/chain-events"]) {
      assert.equal(checkApiMutation(api(path, "POST", { origin: "null", "content-type": "application/json" })), null, path);
      assert.equal(isServerToServerApi(path), true, path);
    }
    for (const path of ["/api/world/events", "/api/world/join", "/api/raidsx", "/api/market/buy"]) assert.equal(isServerToServerApi(path), false, path);
  });

  it("the middleware answers 403 with the guard's error and passes the app's own calls", async () => {
    const { middleware, config } = await import("../middleware");
    const { NextRequest } = await import("next/server");
    assert.deepEqual(config.matcher, ["/api/:path*"]);
    const attack = new NextRequest("https://idos.example/api/market/buy", {
      method: "POST",
      headers: { host: "idos.example", origin: "https://evil.example", "sec-fetch-site": "cross-site", "content-type": "text/plain" },
      body: listingBody,
    });
    const res = middleware(attack);
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: "cross_site" });
    const ok = middleware(
      new NextRequest("https://idos.example/api/market/buy", {
        method: "POST",
        headers: { host: "idos.example", "sec-fetch-site": "same-origin", "content-type": "application/json" },
        body: listingBody,
      }),
    );
    assert.equal(ok.headers.get("x-middleware-next"), "1");
  });
});
