import { z } from "zod";
import { db } from "@/db/client";
import { buyListing } from "@/lib/market/market";
import { marketFeeBps } from "@/lib/market/server-config";
import { apiError, caller, json, readJson, registeredOnly } from "@/lib/lobby/route-helpers";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ listingId: z.string().uuid() });

const MESSAGES: Record<string, string> = {
  not_found: "That lot does not exist.",
  gone: "Someone else bought it first (or the seller withdrew it).",
  not_visible: "That lot is not on sale yet.",
  expired: "That lot has expired.",
  own_listing: "That's your own lot.",
  rate_limited: "Buying too fast — wait a bit and try again.",
  insufficient_funds: "Not enough balance. Top up your wallet first.",
  no_user: "Sign in again.",
};

/** Buys one lot. Concurrency-safe: the listing row lock lets exactly one buyer win. */
export async function POST(req: Request) {
  const c = await caller();
  const deny = registeredOnly(c);
  if (deny || c.kind !== "user") return deny!;
  const parsed = bodySchema.safeParse(await readJson(req));
  if (!parsed.success) return apiError(400, "bad_body", "Pick a lot.");
  const r = await buyListing(db, c.userId, parsed.data.listingId, { feeBps: marketFeeBps() });
  if (!r.ok) {
    const status = r.code === "not_found" ? 404 : r.code === "rate_limited" ? 429 : r.code === "no_user" ? 401 : 409;
    return apiError(status, r.code, MESSAGES[r.code]);
  }
  return json(r);
}
