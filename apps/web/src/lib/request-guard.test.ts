/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/request-guard.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkSameOriginRequest } from "./request-guard";

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
