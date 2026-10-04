/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/edition.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_IDOS_FRAME_ANCESTORS,
  IDOS_BUILD,
  brandFullName,
  editionHeaders,
  editionLabel,
  editionPublicEnv,
  editionSessionCookie,
  flagOn,
  frameAncestorsDirective,
  isFramed,
  isIdosBuildEnv,
  isIdosFramed,
  parseFrameAncestors,
} from "./edition";
import { BRAND } from "./brand";

describe("flag", () => {
  it("reads 1 / true as on and everything else as off", () => {
    for (const v of ["1", "true", " TRUE ", "True"]) assert.equal(flagOn(v), true, v);
    for (const v of [undefined, null, "", " ", "0", "false", "yes", "2"]) assert.equal(flagOn(v), false, String(v));
  });

  it("is on with IDOS_BUILD or NEXT_PUBLIC_IDOS_BUILD", () => {
    assert.equal(isIdosBuildEnv({}), false);
    assert.equal(isIdosBuildEnv({ IDOS_BUILD: "" }), false);
    assert.equal(isIdosBuildEnv({ IDOS_BUILD: "0", NEXT_PUBLIC_IDOS_BUILD: "0" }), false);
    assert.equal(isIdosBuildEnv({ IDOS_BUILD: "1" }), true);
    assert.equal(isIdosBuildEnv({ NEXT_PUBLIC_IDOS_BUILD: "1" }), true);
  });

  it("is off in this process (tests run without the edition env)", () => {
    assert.equal(IDOS_BUILD, false);
  });
});

describe("brand", () => {
  it("main build keeps the plain name", () => {
    assert.equal(editionLabel(false), null);
    assert.equal(brandFullName("SPOILS", false), "SPOILS");
    assert.equal(BRAND.name, "SPOILS");
    assert.equal(BRAND.edition, null);
    assert.equal(BRAND.fullName, "SPOILS");
  });

  it("edition adds the label after the name", () => {
    assert.equal(editionLabel(true), "iDos Games edition");
    assert.equal(brandFullName("SPOILS", true), "SPOILS — iDos Games edition");
  });
});

describe("parseFrameAncestors", () => {
  it("falls back to the iDos defaults when unset or empty", () => {
    for (const raw of [undefined, null, "", "  ", " , "]) {
      const r = parseFrameAncestors(raw);
      assert.deepEqual(r.sources, [...DEFAULT_IDOS_FRAME_ANCESTORS]);
      assert.equal(r.usedDefault, true);
      assert.deepEqual(r.rejected, []);
    }
    assert.deepEqual(DEFAULT_IDOS_FRAME_ANCESTORS, ["https://idosgames.com", "https://www.idosgames.com", "https://*.idos.games"]);
  });

  it("accepts https origins and wildcard subdomains, split by spaces or commas", () => {
    const r = parseFrameAncestors("https://idosgames.com, https://*.idos.games  https://dev.example.org:8443/");
    assert.deepEqual(r.sources, ["https://idosgames.com", "https://*.idos.games", "https://dev.example.org:8443"]);
    assert.equal(r.usedDefault, false);
    assert.deepEqual(r.rejected, []);
  });

  it("lowercases and removes duplicates", () => {
    assert.deepEqual(parseFrameAncestors("https://IDOSGAMES.com https://idosgames.com/").sources, ["https://idosgames.com"]);
  });

  it("allows plain http only for localhost test pages", () => {
    assert.deepEqual(parseFrameAncestors("http://localhost:5173 http://127.0.0.1").sources, ["http://localhost:5173", "http://127.0.0.1"]);
    const r = parseFrameAncestors("http://idosgames.com");
    assert.deepEqual(r.rejected, ["http://idosgames.com"]);
    assert.equal(r.usedDefault, true);
  });

  it("drops anything that would open the site to every framer or inject a directive", () => {
    const bad = ["*", "https:", "https://*", "'none'", "'self'", "data:", "https://idosgames.com/play", "https://idosgames.com;", "https://*.*.idos.games", "idosgames.com", "https://a.com;script-src"];
    const r = parseFrameAncestors([...bad, "https://ok.example.com"].join(" "));
    assert.deepEqual(r.sources, ["https://ok.example.com"]);
    assert.deepEqual(r.rejected, bad);
  });

  it("uses the defaults when every token is invalid", () => {
    const r = parseFrameAncestors("* https:");
    assert.deepEqual(r.sources, [...DEFAULT_IDOS_FRAME_ANCESTORS]);
    assert.equal(r.usedDefault, true);
    assert.deepEqual(r.rejected, ["*", "https:"]);
  });
});

describe("editionHeaders", () => {
  it("adds nothing to the main build", () => {
    assert.deepEqual(editionHeaders({}), []);
    assert.deepEqual(editionHeaders({ IDOS_FRAME_ANCESTORS: "https://idosgames.com" }), []);
    assert.deepEqual(editionPublicEnv({}), {});
    assert.deepEqual(editionPublicEnv({ IDOS_BUILD: "0" }), {});
  });

  it("sends only CSP frame-ancestors (no X-Frame-Options) on every path in the edition", () => {
    const h = editionHeaders({ IDOS_BUILD: "1" });
    assert.equal(h.length, 1);
    assert.equal(h[0]!.source, "/:path*");
    assert.deepEqual(h[0]!.headers, [
      { key: "Content-Security-Policy", value: "frame-ancestors 'self' https://idosgames.com https://www.idosgames.com https://*.idos.games" },
    ]);
    assert.ok(!h[0]!.headers.some((x) => x.key.toLowerCase() === "x-frame-options"));
    assert.deepEqual(editionPublicEnv({ IDOS_BUILD: "1" }), { NEXT_PUBLIC_IDOS_BUILD: "1" });
  });

  it("uses IDOS_FRAME_ANCESTORS when set", () => {
    const h = editionHeaders({ IDOS_BUILD: "true", IDOS_FRAME_ANCESTORS: "https://abc123.idos.games" });
    assert.equal(h[0]!.headers[0]!.value, "frame-ancestors 'self' https://abc123.idos.games");
    assert.equal(frameAncestorsDirective([]), "frame-ancestors 'self'");
  });
});

describe("editionSessionCookie", () => {
  it("leaves the main cookie alone", () => {
    assert.deepEqual(editionSessionCookie(false), {});
    assert.deepEqual(editionSessionCookie(), {});
  });

  it("makes the edition cookie cross-site: SameSite=None; Secure; Partitioned", () => {
    const base = { httpOnly: true, sameSite: "lax", secure: false, path: "/" };
    assert.deepEqual({ ...base, ...editionSessionCookie(true) }, { httpOnly: true, sameSite: "none", secure: true, partitioned: true, path: "/" });
  });
});

describe("isFramed", () => {
  const top = {};
  it("compares window.top with window.self", () => {
    assert.equal(isFramed({ self: top, top }), false);
    assert.equal(isFramed({ self: {}, top }), true);
  });

  it("counts a throwing window.top as framed", () => {
    const win = {
      self: {},
      get top(): unknown {
        throw new Error("SecurityError");
      },
    };
    assert.equal(isFramed(win), true);
  });

  it("is false without a window (server render)", () => {
    assert.equal(isFramed(), false);
  });

  it("only the edition reports the iDos frame", () => {
    const framed = { self: {}, top };
    assert.equal(isIdosFramed(false, framed), false);
    assert.equal(isIdosFramed(true, framed), true);
    assert.equal(isIdosFramed(true, { self: top, top }), false);
  });
});
