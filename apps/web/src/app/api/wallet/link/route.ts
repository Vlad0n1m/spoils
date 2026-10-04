import { db } from "@/db/client";
import { clientIp } from "@/lib/auth-rate-limit";
import { apiError, caller, json, readJson, registeredOnly } from "@/lib/lobby/route-helpers";
import { checkSameOriginRequest } from "@/lib/request-guard";
import { SOLANA_CLUSTER } from "@/lib/wallet/cluster";
import { LINK_ERRORS } from "@/lib/wallet/errors";
import { getLinkedWallet, linkWallet, unlinkWallet } from "@/lib/wallet/link";
import { linkBodySchema, proofFromBody, walletLinkLimiter } from "@/lib/wallet/request";

export const dynamic = "force-dynamic";

/**
 * The account's self-custody Solana wallet (identity only: no transfers, no transaction signing).
 *   GET    → { wallet: { address, linkedAt } | null, cluster }
 *   POST   { address, message, signature } (base64) → verifies the Sign-In with Solana proof against
 *          the nonce from POST /api/wallet/link/nonce and links the address
 *   DELETE → unlinks
 * Registered users only; guests get 403.
 */
export async function GET() {
  const c = await caller();
  const deny = registeredOnly(c);
  if (deny || c.kind !== "user") return deny!;
  return json({ wallet: await getLinkedWallet(db, c.userId), cluster: SOLANA_CLUSTER });
}

/** Failures that say nothing about a guessing attempt (the proof itself was fine). */
const NOT_COUNTED = new Set(["address_taken", "already_linked"]);

export async function POST(req: Request) {
  const blocked = checkSameOriginRequest(req, { json: true });
  if (blocked) return apiError(blocked.status, blocked.error);
  const c = await caller();
  const deny = registeredOnly(c);
  if (deny || c.kind !== "user") return deny!;

  const ip = clientIp(req);
  const gate = walletLinkLimiter.begin(ip, c.userId);
  if (!gate.ok) {
    const res = apiError(429, "rate_limited", "Too many attempts. Wait a minute and try again.");
    res.headers.set("Retry-After", String(gate.retryAfterSec));
    return res;
  }

  const parsed = linkBodySchema.safeParse(await readJson(req));
  if (!parsed.success) {
    walletLinkLimiter.fail(c.userId, ip);
    return apiError(400, "bad_body", "The wallet answer was incomplete. Try again.");
  }
  const r = await linkWallet(db, c.userId, proofFromBody(parsed.data));
  if (!r.ok) {
    if (!NOT_COUNTED.has(r.error)) walletLinkLimiter.fail(c.userId, ip);
    const e = LINK_ERRORS[r.error];
    return apiError(e.status, r.error, e.message);
  }
  walletLinkLimiter.succeed(c.userId, ip);
  return json({ wallet: r.wallet });
}

export async function DELETE(req: Request) {
  const blocked = checkSameOriginRequest(req, { json: false });
  if (blocked) return apiError(blocked.status, blocked.error);
  const c = await caller();
  const deny = registeredOnly(c);
  if (deny || c.kind !== "user") return deny!;
  const r = await unlinkWallet(db, c.userId);
  return json({ wallet: null, unlinked: r.unlinked });
}
