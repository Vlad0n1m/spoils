/**
 * In-process throttle for POST /api/auth/login: every bcrypt compare costs ≈250 ms of CPU, so
 * unthrottled guessing both brute-forces accounts and stalls the event loop for every route.
 *  - per client IP: token bucket over all attempts (taken before the compare, so a parallel burst
 *    is cut off too);
 *  - per email: after `emailMaxFailures` wrong passwords within `emailWindowMs` the account
 *    refuses further attempts until the window ends; a successful sign-in clears it.
 * State is per process (several web instances each keep their own) and bounded by `maxKeys`.
 */

export interface LoginLimitOptions {
  ipBurst: number;
  ipRefillMs: number;
  emailMaxFailures: number;
  emailWindowMs: number;
  maxKeys: number;
}

export const LOGIN_LIMITS: LoginLimitOptions = {
  ipBurst: 20,
  ipRefillMs: 3_000,
  emailMaxFailures: 10,
  emailWindowMs: 15 * 60_000,
  maxKeys: 10_000,
};

export type LimitDecision = { ok: true } | { ok: false; retryAfterSec: number };

export class LoginLimiter {
  private readonly ips = new Map<string, { tokens: number; at: number }>();
  private readonly emails = new Map<string, { failures: number; resetAt: number }>();

  constructor(private readonly o: LoginLimitOptions = LOGIN_LIMITS) {}

  /** Call before verifying the password; consumes one IP token when allowed. */
  begin(ip: string, email: string, now = Date.now()): LimitDecision {
    const e = this.emails.get(email);
    if (e && now < e.resetAt && e.failures >= this.o.emailMaxFailures) {
      return { ok: false, retryAfterSec: Math.ceil((e.resetAt - now) / 1000) };
    }
    const b = this.ips.get(ip) ?? { tokens: this.o.ipBurst, at: now };
    b.tokens = Math.min(this.o.ipBurst, b.tokens + (now - b.at) / this.o.ipRefillMs);
    b.at = now;
    if (b.tokens < 1) {
      this.ips.set(ip, b);
      return { ok: false, retryAfterSec: Math.ceil(((1 - b.tokens) * this.o.ipRefillMs) / 1000) };
    }
    b.tokens -= 1;
    this.ips.delete(ip); // re-insert: Map order = least recently used first
    this.ips.set(ip, b);
    this.prune(now);
    return { ok: true };
  }

  fail(email: string, now = Date.now()): void {
    const e = this.emails.get(email);
    const live = e && now < e.resetAt ? e : { failures: 0, resetAt: now + this.o.emailWindowMs };
    live.failures += 1;
    this.emails.set(email, live);
    this.prune(now);
  }

  succeed(email: string): void {
    this.emails.delete(email);
  }

  private prune(now: number): void {
    if (this.emails.size > this.o.maxKeys) {
      for (const [k, v] of this.emails) if (now >= v.resetAt) this.emails.delete(k);
      for (const k of this.emails.keys()) {
        if (this.emails.size <= this.o.maxKeys) break;
        this.emails.delete(k);
      }
    }
    for (const k of this.ips.keys()) {
      if (this.ips.size <= this.o.maxKeys) break;
      this.ips.delete(k);
    }
  }
}

/** Best-effort client address (the proxy's X-Real-IP / first X-Forwarded-For hop). */
export function clientIp(req: Request): string {
  const real = req.headers.get("x-real-ip")?.trim();
  if (real) return real;
  const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || "unknown";
}

/** Process-wide limiter used by the login route. */
export const loginLimiter = new LoginLimiter();
