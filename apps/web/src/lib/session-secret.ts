import { isProductionRuntime } from "./env";

/** Session lifetime: the cookie's maxAge and the seal's own expiry (iron-session `ttl`). */
export const SESSION_TTL_SEC = 60 * 60 * 24 * 7;

/** The minimum iron-session accepts, and what production requires of SESSION_SECRET. */
export const SESSION_SECRET_MIN = 32;

const DEV_FALLBACK = "dev-only-fake-32byte-secret-pad-pad-pad-pad";

/**
 * The iron-session password. Production (the runtime, not `next build`) refuses a missing or short
 * SESSION_SECRET instead of falling back to the public dev constant or padding it (security audit:
 * anyone could otherwise forge a session for any user, admins included). Dev keeps the fallback.
 */
export function sessionPassword(env: Record<string, string | undefined> = process.env): string {
  const raw = env.SESSION_SECRET?.trim() ?? "";
  if (isProductionRuntime(env)) {
    if (raw.length < SESSION_SECRET_MIN) {
      throw new Error(`SESSION_SECRET (${SESSION_SECRET_MIN}+ characters) is required in production`);
    }
    return raw;
  }
  const v = raw || DEV_FALLBACK;
  return v.length >= SESSION_SECRET_MIN ? v : v.padEnd(SESSION_SECRET_MIN, "x");
}
