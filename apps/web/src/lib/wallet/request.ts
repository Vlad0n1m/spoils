/**
 * Request helpers of the /api/wallet/link routes (server only).
 */
import { z } from "zod";
import { LOGIN_LIMITS, LoginLimiter } from "../auth-rate-limit";
import type { LinkProof } from "./verify";

/**
 * Same throttle as POST /api/auth/login, keyed by user id instead of email: a token bucket per client
 * IP over nonce + verify calls, and after 10 failed verifies in 15 minutes the account waits out the
 * window. Its own instance, so wallet attempts and sign-ins do not share buckets.
 */
export const walletLinkLimiter = new LoginLimiter(LOGIN_LIMITS);

const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/;
/** Local development hosts: allowed while SIWS_ALLOWED_HOSTS is unset. */
const LOOPBACK_RE = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/;

/**
 * SIWS_ALLOWED_HOSTS: the hosts (host[:port], as the browser's address bar shows them) the wallet
 * may be asked to sign in to, separated by spaces or commas; `https://` and a trailing slash are
 * ignored, e.g. "spoils.example" or "https://idos.spoils.example". Each deployment lists its own
 * public host (the main site and the iDos edition have separate env files). Invalid tokens are
 * dropped.
 */
export function parseSiwsAllowedHosts(raw: string | undefined | null): string[] {
  const out: string[] = [];
  for (const token of (raw ?? "").split(/[\s,]+/)) {
    const host = token
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/$/, "");
    if (host && host.length <= 255 && HOST_RE.test(host) && !out.includes(host)) out.push(host);
  }
  return out;
}

/**
 * Whether a SIWS message may name `host`. The Host header is chosen by the client (a request sent
 * straight to the server, or through a proxy without a catch-all server, can carry any name), so it
 * is only trusted when it is one of our own hosts: otherwise a player could fetch a challenge for
 * their account that names a phishing domain, where a victim's wallet would see the domain match
 * the page and sign without a warning. Unset list: only localhost (development); a deployment that
 * links wallets must set SIWS_ALLOWED_HOSTS.
 */
export function siwsHostAllowed(host: string, allowed: readonly string[]): boolean {
  return allowed.length > 0 ? allowed.includes(host) : LOOPBACK_RE.test(host);
}

/**
 * SIWS domain and URI of the page that asked: the Host header (what the browser shows the wallet as
 * the origin; nginx and Vercel pass it through) and the scheme from X-Forwarded-Proto, or null when
 * the host is not one of ours (siwsHostAllowed). X-Forwarded-Host is ignored on purpose: a client
 * can send it through a proxy that does not overwrite it.
 */
export function siwsContextFromRequest(
  req: Request,
  allowed: readonly string[] = parseSiwsAllowedHosts(process.env.SIWS_ALLOWED_HOSTS),
): { domain: string; uri: string } | null {
  const host = req.headers.get("host")?.trim().toLowerCase() ?? "";
  if (!host || host.length > 255 || !HOST_RE.test(host)) return null;
  if (!siwsHostAllowed(host, allowed)) return null;
  const fwd = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  let proto = fwd === "https" || fwd === "http" ? fwd : "";
  if (!proto) {
    try {
      proto = new URL(req.url).protocol === "https:" ? "https" : "http";
    } catch {
      proto = "https";
    }
  }
  return { domain: host, uri: `${proto}://${host}` };
}

const base64 = (max: number) => z.string().min(1).max(max).regex(/^[A-Za-z0-9+/]+={0,2}$/);

export const linkBodySchema = z.object({
  address: z.string().min(32).max(44),
  /** base64 of the exact bytes the wallet signed */
  message: base64(6000),
  /** base64 of the 64-byte ed25519 signature */
  signature: base64(100),
});

export function proofFromBody(body: z.infer<typeof linkBodySchema>): LinkProof {
  return {
    address: body.address,
    message: new Uint8Array(Buffer.from(body.message, "base64")),
    signature: new Uint8Array(Buffer.from(body.signature, "base64")),
  };
}
