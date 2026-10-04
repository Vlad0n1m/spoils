import { getIronSession, type SessionOptions } from "iron-session";
import { cookies, headers } from "next/headers";
import { editionSessionCookie } from "./edition";
import { SESSION_TTL_SEC, sessionPassword } from "./session-secret";

export interface AppSession {
  userId?: string;
  nickname?: string;
  /** No DB row; join match without debiting balance. */
  guest?: boolean;
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
    // The seal expires with the cookie (iron-session's default seal TTL is 14 days: a copied cookie
    // stayed valid a week past its maxAge, security audit).
    ttl: SESSION_TTL_SEC,
    cookieOptions: {
      httpOnly: true,
      sameSite: "lax",
      secure: await resolveCookieSecure(),
      maxAge: SESSION_TTL_SEC,
      path: "/",
      // iDos Games edition only (inside the idosgames.com iframe): SameSite=None; Secure; Partitioned.
      ...editionSessionCookie(),
    },
  };
}

export async function getSession() {
  const c = await cookies();
  return getIronSession<AppSession>(c, await getSessionOptions());
}
