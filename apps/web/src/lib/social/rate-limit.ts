/**
 * Throttle for the social POST routes (friend requests, invites, party actions), shaped like the
 * login limiter (lib/auth-rate-limit.ts): a token bucket per user with the same burst and refill as
 * the login route's per-IP bucket, so a script cannot spam requests or invites. State is per
 * process and bounded by `maxKeys`.
 */
import { LOGIN_LIMITS, type LimitDecision } from "../auth-rate-limit";

export interface SocialLimitOptions {
  burst: number;
  refillMs: number;
  maxKeys: number;
}

export const SOCIAL_LIMITS: SocialLimitOptions = {
  burst: LOGIN_LIMITS.ipBurst,
  refillMs: LOGIN_LIMITS.ipRefillMs,
  maxKeys: LOGIN_LIMITS.maxKeys,
};

export class SocialLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(private readonly o: SocialLimitOptions = SOCIAL_LIMITS) {}

  /** Takes one token for `key` (the user id) when allowed. */
  take(key: string, now = Date.now()): LimitDecision {
    const b = this.buckets.get(key) ?? { tokens: this.o.burst, at: now };
    b.tokens = Math.min(this.o.burst, b.tokens + Math.max(0, now - b.at) / this.o.refillMs);
    b.at = now;
    this.buckets.delete(key); // re-insert: Map order = least recently used first
    this.buckets.set(key, b);
    if (b.tokens < 1) return { ok: false, retryAfterSec: Math.max(1, Math.ceil(((1 - b.tokens) * this.o.refillMs) / 1000)) };
    b.tokens -= 1;
    for (const k of this.buckets.keys()) {
      if (this.buckets.size <= this.o.maxKeys) break;
      this.buckets.delete(k);
    }
    return { ok: true };
  }
}

/** Process-wide limiter of the social routes. */
export const socialLimiter = new SocialLimiter();
