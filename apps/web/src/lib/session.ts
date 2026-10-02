import { getIronSession, type SessionOptions } from "iron-session";
import { cookies, headers } from "next/headers";

export interface AppSession {
  userId?: string;
  nickname?: string;
  /** No DB row; join match without debiting balance. */
  guest?: boolean;
}

/** iron-session requires password length >= 32 (chars). */
function sessionPassword(): string {
  const raw =
    process.env.SESSION_SECRET?.trim() ||
    "dev-only-fake-32byte-secret-pad-pad-pad-pad";
  if (raw.length >= 32) return raw;
  return raw.padEnd(32, "x");
}

/**
 * Whether the session cookie should use the Secure attribute.
 * Behind Nginx/Traefik, set: proxy_set_header X-Forwarded-Proto $scheme;
 * Without that, NODE_ENV=production defaults to secure=true (correct for HTTPS sites).
 */
async function resolveCookieSecure(): Promise<boolean> {
  const explicit = process.env.SESSION_COOKIE_SECURE?.trim().toLowerCase();
  if (explicit === "false" || explicit === "0") return false;
  if (explicit === "true" || explicit === "1") return true;

  const h = await headers();
  const forwarded = h.get("x-forwarded-proto")?.split(",")[0]?.trim();
  if (forwarded === "https") return true;
  if (forwarded === "http") return false;

  return process.env.NODE_ENV === "production";
}

async function getSessionOptions(): Promise<SessionOptions> {
  const password = sessionPassword();
  return {
    password,
    cookieName: "extract_session",
    cookieOptions: {
      httpOnly: true,
      sameSite: "lax",
      secure: await resolveCookieSecure(),
      maxAge: 60 * 60 * 24 * 7,
      path: "/",
    },
  };
}

export async function getSession() {
  const c = await cookies();
  return getIronSession<AppSession>(c, await getSessionOptions());
}
