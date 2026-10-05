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
  EDITION_UI,
  editionBlock,
  editionUi,
  flagOn,
  IDOS_DISABLED_API,
  IDOS_SHELL_ORIGINS,
  idosShellOrigins,
  isIdosAccountEmail,
  parseIdosTitleIds,
  SOL_ECONOMY,
  shellOriginsFromEnv,
  solEconomyEnabled,
  titleShellOrigin,
  frameAncestorsDirective,
  isFramed,
  isIdosBuildEnv,
  isIdosFramed,
  parseFrameAncestors,
  wildcardSources,
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
    assert.deepEqual(DEFAULT_IDOS_FRAME_ANCESTORS, ["https://idosgames.com", "https://www.idosgames.com"]);
  });

  it("never trusts every iDos-hosted title by default; a wildcard is an explicit opt-in", () => {
    // Other publishers' titles live at {titleid}.idos.games too: a wildcard default would let any of
    // them frame the signed-in edition.
    assert.deepEqual(wildcardSources(DEFAULT_IDOS_FRAME_ANCESTORS), []);
    assert.ok(!DEFAULT_IDOS_FRAME_ANCESTORS.some((s) => s.includes("idos.games")));
    const exact = parseFrameAncestors("https://idosgames.com https://www.idosgames.com https://spoils.idos.games");
    assert.deepEqual(wildcardSources(exact.sources), []);
    assert.deepEqual(wildcardSources(parseFrameAncestors("https://idosgames.com https://*.idos.games").sources), ["https://*.idos.games"]);
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
      { key: "Content-Security-Policy", value: "frame-ancestors 'self' https://idosgames.com https://www.idosgames.com" },
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

describe("SOL economy gate (iDos edition)", () => {
  it("is on in the main build and off in the edition", () => {
    assert.equal(solEconomyEnabled(false), true);
    assert.equal(solEconomyEnabled(true), false);
    // This test bundle is the main build.
    assert.equal(IDOS_BUILD, false);
    assert.equal(SOL_ECONOMY, true);
  });

  it("hides every SOL piece of the UI in the edition and none in the main build", () => {
    for (const v of Object.values(editionUi(false))) assert.equal(v, true);
    for (const v of Object.values(editionUi(true))) assert.equal(v, false);
    assert.deepEqual(EDITION_UI, editionUi(false));
  });

  it("the edition answers 404 on the SOL economy API", () => {
    for (const p of [
      "/api/market/buy",
      "/api/market/list",
      "/api/market/cancel",
      "/api/market/listings",
      "/api/market/history",
      "/api/market",
      "/api/wallet/dev-topup",
      "/api/wallet/link",
      "/api/wallet/link/nonce",
      "/api/withdraw",
      "/api/withdraw/",
      "/api/stash/starter",
      "/API/Market/Buy",
      "/api/economy/stats",
    ]) {
      assert.equal(editionBlock(p, true), "api", p);
      assert.equal(editionBlock(p, false), null, `main build serves ${p}`);
    }
  });

  it("the edition keeps the game loop", () => {
    for (const p of [
      "/api/stash",
      "/api/trader/buy",
      "/api/trader/bound",
      "/api/raids/enter",
      "/api/raids/exit",
      "/api/loadout/draft",
      "/api/pass",
      "/api/quests",
      "/api/friends",
      "/api/leaderboards",
      "/api/me",
      "/api/auth/login",
      "/api/world/join",
      "/api/marketing",
      "/api/idos/session",
      "/play",
      "/",
    ]) assert.equal(editionBlock(p, true), null, p);
  });

  it("the edition sends its SOL pages to /play", () => {
    for (const p of ["/wallet", "/wallet/", "/economy", "/economy/x"]) assert.equal(editionBlock(p, true), "page", p);
    for (const p of ["/wallet", "/economy"]) assert.equal(editionBlock(p, false), null, p);
  });

  it("the main build answers 404 on the edition-only bridge", () => {
    assert.equal(editionBlock("/api/idos/session", false), "api");
    assert.equal(editionBlock("/api/idos", false), "api");
    assert.equal(editionBlock("/api/idosx", false), null);
  });

  it("lists only real route prefixes", () => {
    for (const p of IDOS_DISABLED_API) assert.match(p, /^\/api\/[a-z/-]+$/);
  });
});

describe("iDos Titles and shells", () => {
  it("parses IDOS_TITLE_IDS", () => {
    assert.deepEqual(parseIdosTitleIds("abcd1234, ABCD1234-dev  junk *.idos.games ABCD1234"), ["ABCD1234", "ABCD1234-DEV"]);
    assert.deepEqual(parseIdosTitleIds(undefined), []);
    assert.deepEqual(parseIdosTitleIds("ABC"), []);
  });

  it("maps a Title to its shell origin", () => {
    assert.equal(titleShellOrigin("ABCD1234"), "https://abcd1234.idos.games");
    assert.equal(titleShellOrigin("ABCD1234-DEV"), "https://abcd1234-dev.idos.games");
    assert.deepEqual(idosShellOrigins({ IDOS_TITLE_IDS: "ABCD1234 ABCD1234-DEV" }), [
      "https://abcd1234.idos.games",
      "https://abcd1234-dev.idos.games",
    ]);
  });

  it("frames: defaults plus our shells when IDOS_FRAME_ANCESTORS is unset; an explicit list wins", () => {
    const h = editionHeaders({ IDOS_BUILD: "1", IDOS_TITLE_IDS: "ABCD1234-DEV" });
    assert.equal(
      h[0]!.headers[0]!.value,
      "frame-ancestors 'self' https://idosgames.com https://www.idosgames.com https://abcd1234-dev.idos.games",
    );
    const explicit = editionHeaders({ IDOS_BUILD: "1", IDOS_TITLE_IDS: "ABCD1234", IDOS_FRAME_ANCESTORS: "https://idosgames.com" });
    assert.equal(explicit[0]!.headers[0]!.value, "frame-ancestors 'self' https://idosgames.com");
    assert.deepEqual(editionHeaders({ IDOS_TITLE_IDS: "ABCD1234" }), []);
  });

  it("inlines the shell origins only into the edition", () => {
    assert.deepEqual(editionPublicEnv({ IDOS_BUILD: "1", IDOS_TITLE_IDS: "ABCD1234" }), {
      NEXT_PUBLIC_IDOS_BUILD: "1",
      NEXT_PUBLIC_IDOS_SHELL_ORIGINS: "https://abcd1234.idos.games",
    });
    assert.deepEqual(editionPublicEnv({ IDOS_TITLE_IDS: "ABCD1234" }), {});
  });

  it("the page accepts only exact iDos shell origins, and none in the main build", () => {
    const raw = "https://abcd1234.idos.games https://evil.example https://*.idos.games https://abcd1234-dev.idos.games";
    assert.deepEqual(shellOriginsFromEnv(raw, true), ["https://abcd1234.idos.games", "https://abcd1234-dev.idos.games"]);
    assert.deepEqual(shellOriginsFromEnv(raw, false), []);
    assert.deepEqual(IDOS_SHELL_ORIGINS, []);
  });

  it("recognises bridge accounts by their placeholder email", () => {
    assert.equal(isIdosAccountEmail("0123abcd@idos.invalid"), true);
    assert.equal(isIdosAccountEmail("player@example.com"), false);
    assert.equal(isIdosAccountEmail(undefined), false);
  });
});
