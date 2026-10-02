/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/auth-rate-limit.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LoginLimiter, clientIp, type LoginLimitOptions } from "./auth-rate-limit";

const OPTS: LoginLimitOptions = { ipBurst: 5, ipRefillMs: 1_000, emailMaxFailures: 3, emailWindowMs: 60_000, maxKeys: 100 };

describe("LoginLimiter", () => {
  it("caps attempts per IP before the password is checked, refilling over time (parallel bursts too)", () => {
    const l = new LoginLimiter(OPTS);
    const t = 1_000_000;
    // 30 parallel guesses against different emails: only the burst gets through.
    const res = Array.from({ length: 30 }, (_, i) => l.begin("6.6.6.6", `u${i}@x.io`, t));
    assert.equal(res.filter((r) => r.ok).length, 5);
    const denied = res.find((r) => !r.ok);
    assert.ok(denied && !denied.ok && denied.retryAfterSec >= 1);
    assert.equal(l.begin("7.7.7.7", "u0@x.io", t).ok, true, "other IPs are unaffected");
    assert.equal(l.begin("6.6.6.6", "a@x.io", t + 1_000).ok, true, "one token back after ipRefillMs");
    assert.equal(l.begin("6.6.6.6", "a@x.io", t + 1_000).ok, false);
  });

  it("locks an email after N failures across IPs until the window ends; success clears it", () => {
    const l = new LoginLimiter(OPTS);
    const t = 2_000_000;
    for (let i = 0; i < 3; i++) {
      assert.equal(l.begin(`10.0.0.${i}`, "victim@x.io", t + i).ok, true);
      l.fail("victim@x.io", t + i);
    }
    const locked = l.begin("10.0.0.99", "victim@x.io", t + 10);
    assert.equal(locked.ok, false, "4th guess from a fresh IP is refused");
    assert.ok(!locked.ok && locked.retryAfterSec > 0 && locked.retryAfterSec <= 60);
    assert.equal(l.begin("10.0.0.99", "other@x.io", t + 10).ok, true, "other accounts are unaffected");
    assert.equal(l.begin("10.0.0.99", "victim@x.io", t + 60_001).ok, true, "window over");

    l.fail("friend@x.io", t);
    l.fail("friend@x.io", t);
    l.succeed("friend@x.io");
    l.fail("friend@x.io", t);
    assert.equal(l.begin("10.0.1.1", "friend@x.io", t).ok, true, "a successful sign-in resets the count");
  });

  it("stays bounded in memory", () => {
    const l = new LoginLimiter({ ...OPTS, maxKeys: 10 });
    for (let i = 0; i < 100; i++) {
      l.begin(`ip-${i}`, `e${i}@x.io`, 0);
      l.fail(`e${i}@x.io`, 0);
    }
    const inner = l as unknown as { ips: Map<string, unknown>; emails: Map<string, unknown> };
    assert.ok(inner.ips.size <= 10 && inner.emails.size <= 10);
  });
});

describe("clientIp", () => {
  it("prefers X-Real-IP, then the first X-Forwarded-For hop", () => {
    const r = (h: Record<string, string>) => new Request("http://x/", { headers: h });
    assert.equal(clientIp(r({ "x-real-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9" })), "1.2.3.4");
    assert.equal(clientIp(r({ "x-forwarded-for": "6.6.6.6, 10.0.0.1" })), "6.6.6.6");
    assert.equal(clientIp(r({})), "unknown");
  });
});
