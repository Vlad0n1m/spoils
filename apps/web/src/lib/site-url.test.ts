/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/site-url.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSiteUrl } from "./site-url";

describe("parseSiteUrl", () => {
  it("keeps only the origin of an https URL", () => {
    assert.equal(parseSiteUrl("https://spoils.example")?.href, "https://spoils.example/");
    assert.equal(parseSiteUrl(" https://spoils.example/play?x=1 ")?.href, "https://spoils.example/");
    assert.equal(parseSiteUrl("https://spoils.example:8443/")?.href, "https://spoils.example:8443/");
  });

  it("allows plain http only for a local build", () => {
    assert.equal(parseSiteUrl("http://localhost:3001")?.href, "http://localhost:3001/");
    assert.equal(parseSiteUrl("http://spoils.example"), null);
  });

  it("is null when unset or not a URL", () => {
    for (const v of [undefined, null, "", "  ", "spoils.example", "ftp://spoils.example", "javascript:alert(1)"]) assert.equal(parseSiteUrl(v), null, String(v));
  });
});
