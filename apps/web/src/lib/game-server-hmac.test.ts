/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/game-server-hmac.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SIGNED_BODY_MAX_BYTES, readCappedText, readSignedJson } from "./game-server-hmac";

const post = (body: string, headers: Record<string, string> = {}) => new Request("http://web/api/raids/exit", { method: "POST", body, headers });

describe("signed game-server bodies are capped before the signature check (security audit)", () => {
  it("readSignedJson answers 413 for a body past SIGNED_BODY_MAX_BYTES, declared or streamed", async () => {
    const big = "x".repeat(SIGNED_BODY_MAX_BYTES + 1);
    const streamed = await readSignedJson(post(big));
    assert.equal(streamed.ok, false);
    if (!streamed.ok) assert.equal(streamed.res.status, 413);
    const declared = await readSignedJson(post("{}", { "content-length": String(SIGNED_BODY_MAX_BYTES + 1) }));
    assert.equal(declared.ok, false);
    if (!declared.ok) assert.equal(declared.res.status, 413);
  });

  it("readCappedText returns the text up to the cap", async () => {
    assert.equal(await readCappedText(post("hello"), 5), "hello");
    assert.equal(await readCappedText(post("hello!"), 5), null);
  });
});
