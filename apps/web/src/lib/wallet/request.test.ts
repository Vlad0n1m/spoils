/**
 * SIWS domain of the nonce route: only our own hosts may appear in the message a wallet signs.
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/wallet/request.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSiwsAllowedHosts, siwsContextFromRequest, siwsHostAllowed } from "./request";

const req = (host: string, headers: Record<string, string> = {}, url = "http://internal:3000/api/wallet/link/nonce") =>
  new Request(url, { method: "POST", headers: { host, ...headers } });

describe("SIWS host pinning", () => {
  it("parses SIWS_ALLOWED_HOSTS: hosts or origins, spaces or commas, invalid tokens dropped", () => {
    assert.deepEqual(parseSiwsAllowedHosts(undefined), []);
    assert.deepEqual(parseSiwsAllowedHosts("  "), []);
    assert.deepEqual(
      parseSiwsAllowedHosts("https://Spoils.example/, idos.spoils.example  localhost:3001 spoils.example bad/path *.x.com"),
      ["spoils.example", "idos.spoils.example", "localhost:3001"],
    );
  });

  it("a forged Host never becomes the signed domain once the hosts are configured", () => {
    const allowed = ["spoils.example"];
    assert.equal(siwsContextFromRequest(req("evil.example", { "x-forwarded-proto": "https" }), allowed), null);
    assert.equal(siwsContextFromRequest(req("spoils.example.evil.example"), allowed), null);
    assert.equal(siwsContextFromRequest(req("localhost:3001"), allowed), null, "configured: localhost is not implied");
    assert.deepEqual(siwsContextFromRequest(req("Spoils.Example", { "x-forwarded-proto": "https" }), allowed), {
      domain: "spoils.example",
      uri: "https://spoils.example",
    });
  });

  it("unset: only local development hosts", () => {
    assert.equal(siwsHostAllowed("localhost:3001", []), true);
    assert.equal(siwsHostAllowed("127.0.0.1:3001", []), true);
    assert.equal(siwsHostAllowed("[::1]:3001", []), true);
    assert.equal(siwsHostAllowed("evil.example", []), false);
    assert.equal(siwsHostAllowed("localhost.evil.example", []), false);
    assert.deepEqual(siwsContextFromRequest(req("localhost:3001"), []), { domain: "localhost:3001", uri: "http://localhost:3001" });
    assert.equal(siwsContextFromRequest(req("evil.example"), []), null);
  });

  it("X-Forwarded-Host is never trusted", () => {
    assert.equal(siwsContextFromRequest(req("internal:3000", { "x-forwarded-host": "spoils.example" }), ["spoils.example"]), null);
  });
});
