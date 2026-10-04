/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/auth-rate-limit.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { KeyedBucket, LoginLimiter, REGISTER_LIMITS, clientIp, type LoginLimitOptions } from "./auth-rate-limit";

const OPTS: LoginLimitOptions = { ipBurst: 5, ipRefillMs: 1_000, emailMaxFailures: 3, emailWindowMs: 60_000, emailGlobalMaxFailures: 6, maxKeys: 100 };

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

  it("locks an (email, IP) pair after N failures; the owner's own IP still signs in (security audit)", () => {
    const l = new LoginLimiter(OPTS);
    const t = 2_000_000;
    for (let i = 0; i < 3; i++) {
      assert.equal(l.begin("6.6.6.6", "victim@x.io", t + i).ok, true);
      l.fail("victim@x.io", "6.6.6.6", t + i);
    }
    const locked = l.begin("6.6.6.6", "victim@x.io", t + 10);
    assert.equal(locked.ok, false, "the guessing IP is refused for that account");
    assert.ok(!locked.ok && locked.retryAfterSec > 0 && locked.retryAfterSec <= 60);
    assert.equal(l.begin("10.0.0.7", "victim@x.io", t + 10).ok, true, "the owner from their own IP is not locked out");
    assert.equal(l.begin("6.6.6.6", "other@x.io", t + 10).ok, true, "other accounts are unaffected");
    assert.equal(l.begin("6.6.6.6", "victim@x.io", t + 60_001).ok, true, "window over");

    l.fail("friend@x.io", "10.0.1.1", t);
    l.fail("friend@x.io", "10.0.1.1", t);
    l.succeed("friend@x.io", "10.0.1.1");
    l.fail("friend@x.io", "10.0.1.1", t);
    assert.equal(l.begin("10.0.1.1", "friend@x.io", t).ok, true, "a successful sign-in resets the count");
  });

  it("guessing spread over many IPs still locks the account past emailGlobalMaxFailures", () => {
    const l = new LoginLimiter(OPTS);
    const t = 3_000_000;
    for (let i = 0; i < 6; i++) {
      assert.equal(l.begin(`10.1.0.${i}`, "victim@x.io", t).ok, true);
      l.fail("victim@x.io", `10.1.0.${i}`, t);
    }
    assert.equal(l.begin("10.1.9.9", "victim@x.io", t + 1).ok, false, "global lock");
    assert.equal(l.begin("10.1.9.9", "victim@x.io", t + 60_001).ok, true);
  });

  it("stays bounded in memory", () => {
    const l = new LoginLimiter({ ...OPTS, maxKeys: 10 });
    for (let i = 0; i < 100; i++) {
      l.begin(`ip-${i}`, `e${i}@x.io`, 0);
      l.fail(`e${i}@x.io`, `ip-${i}`, 0);
    }
    const inner = l as unknown as { ips: Map<string, unknown>; emails: Map<string, unknown>; pairs: Map<string, unknown> };
    assert.ok(inner.ips.size <= 10 && inner.emails.size <= 10 && inner.pairs.size <= 10);
  });
});

describe("KeyedBucket (register / guest)", () => {
  it("lets a burst through per IP, then one per refill; other IPs are separate (security audit)", () => {
    const b = new KeyedBucket(REGISTER_LIMITS);
    const t = 5_000_000;
    const res = Array.from({ length: 50 }, () => b.take("6.6.6.6", t));
    assert.equal(res.filter((r) => r.ok).length, REGISTER_LIMITS.burst, "50 sign-ups from one IP: only the burst");
    const no = res.at(-1)!;
    assert.ok(!no.ok && no.retryAfterSec > 0);
    assert.equal(b.take("7.7.7.7", t).ok, true);
    assert.equal(b.take("6.6.6.6", t + REGISTER_LIMITS.refillMs).ok, true, "one more after refillMs");
    assert.equal(b.take("6.6.6.6", t + REGISTER_LIMITS.refillMs).ok, false);
  });

  it("stays bounded in memory", () => {
    const b = new KeyedBucket({ burst: 1, refillMs: 1_000, maxKeys: 10 });
    for (let i = 0; i < 100; i++) b.take(`ip-${i}`, 0);
    assert.ok((b as unknown as { keys: Map<string, unknown> }).keys.size <= 10);
  });
});

describe("clientIp", () => {
  it("prefers X-Real-IP, then the LAST X-Forwarded-For hop (the client controls the first)", () => {
    const r = (h: Record<string, string>) => new Request("http://x/", { headers: h });
    assert.equal(clientIp(r({ "x-real-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9" })), "1.2.3.4");
    assert.equal(clientIp(r({ "x-forwarded-for": "9.9.9.9, 6.6.6.6" })), "6.6.6.6", "a spoofed first hop is ignored");
    assert.equal(clientIp(r({ "x-forwarded-for": "6.6.6.6" })), "6.6.6.6");
    assert.equal(clientIp(r({})), "unknown");
  });
});
