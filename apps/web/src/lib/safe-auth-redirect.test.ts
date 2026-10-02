/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/safe-auth-redirect.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_AUTH_REDIRECT, safeAuthRedirect } from "./safe-auth-redirect";

/** Where the app router would actually navigate (new URL(href, location.href)). */
const resolve = (href: string) => new URL(href, "https://game.example/auth/login");

describe("safeAuthRedirect", () => {
  it("keeps same-origin paths, query and hash", () => {
    assert.equal(safeAuthRedirect("/play"), "/play");
    assert.equal(safeAuthRedirect("/lobby?tab=stash#x"), "/lobby?tab=stash#x");
    assert.equal(safeAuthRedirect("  /play  "), "/play");
  });

  it("falls back for empty / absolute / protocol-relative / backslash values", () => {
    for (const raw of [null, undefined, "", "play", "https://evil.com", "//evil.com", "/\\evil.com", "\\\\evil.com", "javascript:alert(1)"]) {
      assert.equal(safeAuthRedirect(raw), DEFAULT_AUTH_REDIRECT, String(raw));
    }
  });

  it("rejects tab / newline / CR smuggling that the URL parser strips into //host (open redirect)", () => {
    for (const next of ["/%09/evil.com", "/%0a/evil.com", "/%0d/evil.com", "/%0d%0a/evil.com", "/%20/evil.com"]) {
      const raw = new URLSearchParams(`next=${next}`).get("next");
      const out = safeAuthRedirect(raw);
      assert.equal(out, DEFAULT_AUTH_REDIRECT, next);
      assert.equal(resolve(out).origin, "https://game.example", next);
    }
  });

  it("every accepted value resolves on the app's own origin", () => {
    for (const raw of ["/a/../b", "/%2F%2Fevil.com", "/.//evil.com", "/play?next=//evil.com"]) {
      const out = safeAuthRedirect(raw);
      assert.equal(resolve(out).origin, "https://game.example", raw);
      assert.ok(!out.startsWith("//"), raw);
    }
  });
});
