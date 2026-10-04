/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/security-headers.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { securityHeaders } from "./security-headers.mjs";

const byKey = (env: Record<string, string | undefined>) =>
  Object.fromEntries(securityHeaders(env).flatMap((r) => r.headers.map((h) => [h.key, h.value])));

describe("securityHeaders (security audit: the main build sent no security headers)", () => {
  it("main build: nosniff, referrer policy, own-origin framing only; HSTS in production builds", () => {
    const dev = byKey({ NODE_ENV: "development" });
    assert.equal(dev["X-Content-Type-Options"], "nosniff");
    assert.equal(dev["Referrer-Policy"], "strict-origin-when-cross-origin");
    assert.equal(dev["Content-Security-Policy"], "frame-ancestors 'self'");
    assert.equal(dev["Strict-Transport-Security"], undefined, "never pins localhost to https");
    assert.equal(byKey({ NODE_ENV: "production" })["Strict-Transport-Security"], "max-age=31536000");
    assert.equal(dev["X-Frame-Options"], undefined);
  });

  it("the iDos edition keeps its frame-ancestors list and gets the common headers", () => {
    const h = byKey({ NODE_ENV: "production", IDOS_BUILD: "1" });
    assert.match(h["Content-Security-Policy"]!, /^frame-ancestors 'self' https:\/\/idosgames\.com/);
    assert.equal(h["X-Content-Type-Options"], "nosniff");
    assert.equal(securityHeaders({ IDOS_BUILD: "1" }).length, 1, "one rule, not two CSPs");
  });
});
