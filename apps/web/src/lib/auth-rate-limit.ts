/**
 * In-process throttles of the auth routes. Every bcrypt compare / hash costs ≈250 ms of CPU, so
 * unthrottled guessing or sign-ups both attack accounts and stall the event loop for every route.
 * Login (LoginLimiter):
 *  - per client IP: token bucket over all attempts (taken before the compare, so a parallel burst
 *    is cut off too);
 *  - per (email, client IP): after `emailMaxFailures` wrong passwords within `emailWindowMs` that
 *    pair is refused until the window ends, so one attacker IP cannot lock the owner out from their
 *    own IP (security audit); a successful sign-in clears it;
 *  - per email from all IPs together: `emailGlobalMaxFailures` (far higher) still stops guessing
 *    spread over many IPs.
 * Register and guest sessions (KeyedBucket): a slow per-IP bucket taken before any DB work or hash.
 * State is per process (several web instances each keep their own) and bounded by `maxKeys`.
 */

export interface LoginLimitOptions {
  ipBurst: number;
  ipRefillMs: number;
  /** Wrong passwords per (email, IP) within emailWindowMs before that pair is refused. */
  emailMaxFailures: number;
  emailWindowMs: number;
  /** Wrong passwords per email from all IPs within emailWindowMs before it is refused everywhere. */
  emailGlobalMaxFailures: number;
  maxKeys: number;
}

export const LOGIN_LIMITS: LoginLimitOptions = {
  ipBurst: 20,
  ipRefillMs: 3_000,
  emailMaxFailures: 10,
  emailWindowMs: 15 * 60_000,
  emailGlobalMaxFailures: 100,
  maxKeys: 10_000,
};

export type LimitDecision = { ok: true } | { ok: false; retryAfterSec: number };

type Failures = { failures: number; resetAt: number };

const pairKey = (email: string, ip: string) => `${email}\n${ip}`;

export class LoginLimiter {
  private readonly ips = new Map<string, { tokens: number; at: number }>();
  /** Failures per (email, IP). */
  private readonly pairs = new Map<string, Failures>();
  /** Failures per email from every IP. */
  private readonly emails = new Map<string, Failures>();

  constructor(private readonly o: LoginLimitOptions = LOGIN_LIMITS) {}

  /** Call before verifying the password; consumes one IP token when allowed. */
  begin(ip: string, email: string, now = Date.now()): LimitDecision {
    const locked = lockedFor(this.pairs.get(pairKey(email, ip)), this.o.emailMaxFailures, now) ??
      lockedFor(this.emails.get(email), this.o.emailGlobalMaxFailures, now);
    if (locked !== null) return { ok: false, retryAfterSec: locked };
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

  fail(email: string, ip: string, now = Date.now()): void {
    bump(this.pairs, pairKey(email, ip), this.o.emailWindowMs, now);
    bump(this.emails, email, this.o.emailWindowMs, now);
    this.prune(now);
  }

  succeed(email: string, ip: string): void {
    this.pairs.delete(pairKey(email, ip));
    this.emails.delete(email);
  }

  private prune(now: number): void {
    for (const m of [this.pairs, this.emails]) {
      if (m.size <= this.o.maxKeys) continue;
      for (const [k, v] of m) if (now >= v.resetAt) m.delete(k);
      for (const k of m.keys()) {
        if (m.size <= this.o.maxKeys) break;
        m.delete(k);
      }
    }
    for (const k of this.ips.keys()) {
      if (this.ips.size <= this.o.maxKeys) break;
      this.ips.delete(k);
    }
  }
}

/** Seconds until `f` unlocks when it has reached `max` failures inside its window, else null. */
function lockedFor(f: Failures | undefined, max: number, now: number): number | null {
  if (!f || now >= f.resetAt || f.failures < max) return null;
  return Math.ceil((f.resetAt - now) / 1000);
}

function bump(m: Map<string, Failures>, key: string, windowMs: number, now: number): void {
  const e = m.get(key);
  const live = e && now < e.resetAt ? e : { failures: 0, resetAt: now + windowMs };
  live.failures += 1;
  m.set(key, live);
}

export interface BucketOptions {
  burst: number;
  refillMs: number;
  maxKeys: number;
}

/** A token bucket per key (client IP): `burst` at once, then one token every `refillMs`. */
export class KeyedBucket {
  private readonly keys = new Map<string, { tokens: number; at: number }>();

  constructor(private readonly o: BucketOptions) {}

  take(key: string, now = Date.now()): LimitDecision {
    const b = this.keys.get(key) ?? { tokens: this.o.burst, at: now };
    b.tokens = Math.min(this.o.burst, b.tokens + (now - b.at) / this.o.refillMs);
    b.at = now;
    this.keys.delete(key);
    this.keys.set(key, b);
    for (const k of this.keys.keys()) {
      if (this.keys.size <= this.o.maxKeys) break;
      this.keys.delete(k);
    }
    if (b.tokens < 1) return { ok: false, retryAfterSec: Math.ceil(((1 - b.tokens) * this.o.refillMs) / 1000) };
    b.tokens -= 1;
    return { ok: true };
  }
}

/**
 * POST /api/auth/register per client IP (security audit): 5 at once, then one every 10 minutes.
 * Taken before the duplicate checks and the bcrypt hash, so neither account farming (seats of the
 * world shard) nor hash floods (CPU) nor email probing scale from one address.
 */
export const REGISTER_LIMITS: BucketOptions = { burst: 5, refillMs: 10 * 60_000, maxKeys: 10_000 };
/** POST /api/auth/guest per client IP (guest play on): 10 at once, then one a minute. */
export const GUEST_LIMITS: BucketOptions = { burst: 10, refillMs: 60_000, maxKeys: 10_000 };

/**
 * Client address for the throttles: X-Real-IP (deploy/nginx sets it to $remote_addr, which a CDN
 * in front must turn into the visitor's address with set_real_ip_from / real_ip_header), else the
 * LAST X-Forwarded-For hop — the one our own proxy appended. The first hop is whatever the client
 * sent, so trusting it would let anyone pick a fresh bucket per request (security audit).
 */
export function clientIp(req: Request): string {
  const real = req.headers.get("x-real-ip")?.trim();
  if (real) return real;
  const hops = req.headers.get("x-forwarded-for")?.split(",").map((h) => h.trim()).filter(Boolean) ?? [];
  return hops[hops.length - 1] || "unknown";
}

/** Process-wide limiters of the auth routes. */
export const loginLimiter = new LoginLimiter();
export const registerLimiter = new KeyedBucket(REGISTER_LIMITS);
export const guestLimiter = new KeyedBucket(GUEST_LIMITS);
