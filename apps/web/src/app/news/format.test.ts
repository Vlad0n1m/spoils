/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/app/news/format.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LATEST_POST_ID, NEWS_POSTS, newsPosts } from "../../content/news";
import { fmtPostDate, parseInline, plainInline, postAnchor, postTags, sortNewestFirst } from "./format";

describe("sortNewestFirst", () => {
  it("orders by date descending and keeps file order within a day", () => {
    const posts = [
      { id: "a", date: "2026-10-01" },
      { id: "b", date: "2026-10-06" },
      { id: "c", date: "2026-10-01" },
      { id: "d", date: "2026-10-06" },
    ];
    assert.deepEqual(
      sortNewestFirst(posts).map((p) => p.id),
      ["b", "d", "a", "c"],
    );
    assert.equal(posts[0].id, "a", "does not mutate the input");
  });
});

describe("postAnchor", () => {
  it("keeps ids that are already safe", () => {
    assert.equal(postAnchor("2026-10-06-alpha"), "2026-10-06-alpha");
  });
  it("slugs anything else", () => {
    assert.equal(postAnchor("  Hot Fix #2! "), "hot-fix-2");
    assert.equal(postAnchor("!!!"), "post");
  });
});

describe("postTags", () => {
  it("puts the main tag first and drops repeats and blanks", () => {
    assert.deepEqual(postTags({ tag: "update", tags: ["Alpha", "update", " ", "world"] }), ["update", "alpha", "world"]);
    assert.deepEqual(postTags({ tag: "fix" }), ["fix"]);
  });
});

describe("fmtPostDate", () => {
  it("formats a UTC day without shifting it", () => {
    assert.equal(fmtPostDate("2026-10-06"), "Oct 6, 2026");
    assert.equal(fmtPostDate("2027-01-31"), "Jan 31, 2027");
  });
  it("returns anything else unchanged", () => {
    assert.equal(fmtPostDate("soon"), "soon");
    assert.equal(fmtPostDate("2026-13-01"), "2026-13-01");
  });
});

describe("parseInline", () => {
  it("splits bold and links", () => {
    assert.deepEqual(parseInline("**Always live.** See [the economy](/economy) now."), [
      { kind: "strong", text: "Always live." },
      { kind: "text", text: " See " },
      { kind: "link", text: "the economy", href: "/economy" },
      { kind: "text", text: " now." },
    ]);
  });
  it("leaves plain text and unmatched markers alone", () => {
    assert.deepEqual(parseInline("plain"), [{ kind: "text", text: "plain" }]);
    assert.deepEqual(parseInline("a ** b"), [{ kind: "text", text: "a ** b" }]);
    assert.deepEqual(parseInline(""), []);
  });
  it("turns unsafe links into text", () => {
    assert.deepEqual(parseInline("[x](javascript:void) [y](//evil.example) [z](http://a.b)"), [{ kind: "text", text: "x y z" }]);
    assert.deepEqual(parseInline("[ok](https://solana.com)"), [{ kind: "link", text: "ok", href: "https://solana.com" }]);
    assert.deepEqual(parseInline("[top](#2026-10-06-alpha)"), [{ kind: "link", text: "top", href: "#2026-10-06-alpha" }]);
  });
  it("plainInline drops the markers", () => {
    assert.equal(plainInline("**Bold** and [link](/news)."), "Bold and link.");
  });
});

describe("content/news.ts", () => {
  it("has unique, anchor-safe ids and valid dates, newest first", () => {
    const ids = NEWS_POSTS.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const p of NEWS_POSTS) {
      assert.equal(postAnchor(p.id), p.id, `${p.id} should already be a safe anchor`);
      assert.notEqual(fmtPostDate(p.date), p.date, `${p.id} has a bad date`);
      assert.ok(p.body.length > 0);
      for (const b of p.body) assert.equal(plainInline(b), b, "body is shown raw in the menu panel: keep it plain");
    }
    assert.deepEqual(sortNewestFirst(NEWS_POSTS).map((p) => p.id), ids);
    assert.equal(LATEST_POST_ID, ids[0]);
  });
  it("has no earnings promises", () => {
    const all = JSON.stringify(NEWS_POSTS).toLowerCase();
    for (const w of ["play-to-earn", "play to earn", "p2e", "profit", "earn money", "earn sol"]) assert.ok(!all.includes(w), w);
  });
  it("main build keeps the wallet and treasury lines", () => {
    assert.deepEqual(NEWS_POSTS, newsPosts(true), "tests run as the main build");
    const all = JSON.stringify(newsPosts(true));
    assert.match(all, /Sign-In with Solana/);
    assert.match(all, /Valuables go to the treasury/);
  });
  it("iDos edition: same posts without wallet, Solana or treasury lines", () => {
    const main = newsPosts(true);
    const ed = newsPosts(false);
    assert.deepEqual(ed.map((p) => p.id), main.map((p) => p.id));
    assert.doesNotMatch(JSON.stringify(ed), /wallet|solana|phantom|treasury|market|\bSOL\b/i);
    assert.match(JSON.stringify(ed), /Valuables go back into the loot pool/);
    for (const p of ed) for (const b of p.body) assert.equal(plainInline(b), b);
  });
});
