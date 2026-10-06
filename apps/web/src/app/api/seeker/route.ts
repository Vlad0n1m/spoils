import { db } from "@/db/client";
import { apiError, caller, json, registeredOnly } from "@/lib/lobby/route-helpers";
import { checkSameOriginRequest } from "@/lib/request-guard";
import { claimSeekerFrame, getSeekerStatus } from "@/lib/seeker/seeker";

export const dynamic = "force-dynamic";

/**
 * Seeker perk (lib/seeker, GAME_DESIGN §18g): does the caller's linked wallet hold a Seeker Genesis
 * Token on mainnet? Read-only chain check, cached per wallet for hours.
 *   GET  [?refresh=1] → SeekerDto (refresh re-checks the chain when the last check is over a minute old)
 *   POST             → claims the one-time Seeker Genesis frame → { status: SeekerDto }
 * Registered users only; guests get 403.
 */
export async function GET(req: Request) {
  const c = await caller();
  const deny = registeredOnly(c);
  if (deny || c.kind !== "user") return deny!;
  const refresh = new URL(req.url).searchParams.get("refresh") === "1";
  try {
    return json(await getSeekerStatus(db, c.userId, { refresh }));
  } catch (e) {
    console.error("[seeker] status failed", e);
    return apiError(500, "internal");
  }
}

const CLAIM_ERRORS = {
  no_wallet: [409, "Link the wallet that holds your Seeker Genesis Token first."],
  not_verified: [409, "No Seeker Genesis Token in the linked wallet."],
  already_claimed: [409, "You already have the Seeker frame."],
  mint_used: [409, "This Seeker Genesis Token already claimed the frame on another account."],
  unavailable: [503, "Couldn't reach Solana. Try again in a minute."],
} as const;

export async function POST(req: Request) {
  const blocked = checkSameOriginRequest(req, { json: false });
  if (blocked) return apiError(blocked.status, blocked.error);
  const c = await caller();
  const deny = registeredOnly(c);
  if (deny || c.kind !== "user") return deny!;
  try {
    const r = await claimSeekerFrame(db, c.userId);
    if (!r.ok) {
      const [status, message] = CLAIM_ERRORS[r.error];
      return apiError(status, r.error, message);
    }
    return json({ status: r.status });
  } catch (e) {
    console.error("[seeker] claim failed", e);
    return apiError(500, "internal");
  }
}
