import { db } from "@/db/client";
import { clientIp } from "@/lib/auth-rate-limit";
import { apiError, caller, json, registeredOnly } from "@/lib/lobby/route-helpers";
import { checkSameOriginRequest } from "@/lib/request-guard";
import { siwsChainId } from "@/lib/wallet/cluster";
import { issueLinkChallenge } from "@/lib/wallet/link";
import { siwsContextFromRequest, walletLinkLimiter } from "@/lib/wallet/request";

export const dynamic = "force-dynamic";

/**
 * Sign-In with Solana challenge for linking a wallet: a single-use nonce bound to the signed-in
 * account, valid 10 minutes, plus the exact fields the wallet must sign. Registered users only.
 */
export async function POST(req: Request) {
  const blocked = checkSameOriginRequest(req, { json: true });
  if (blocked) return apiError(blocked.status, blocked.error);
  const c = await caller();
  const deny = registeredOnly(c);
  if (deny || c.kind !== "user") return deny!;

  const gate = walletLinkLimiter.begin(clientIp(req), c.userId);
  if (!gate.ok) {
    const res = apiError(429, "rate_limited", "Too many attempts. Wait a minute and try again.");
    res.headers.set("Retry-After", String(gate.retryAfterSec));
    return res;
  }

  // Only our own hosts (SIWS_ALLOWED_HOSTS; localhost while unset): a forged Host must never put
  // another domain into the message a wallet signs.
  const ctx = siwsContextFromRequest(req);
  if (!ctx) return apiError(400, "bad_host", "Open the game from its own address and try again.");
  const r = await issueLinkChallenge(db, c.userId, { ...ctx, chainId: siwsChainId() });
  if (!r.ok) return apiError(401, r.error, "Sign in again.");
  return json({ challenge: r.challenge });
}
