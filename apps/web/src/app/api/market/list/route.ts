import { z } from "zod";
import { db } from "@/db/client";
import { createListing } from "@/lib/market/market";
import { marketRules, visibleDelayMs } from "@/lib/market/server-config";
import { formatPrice } from "@/lib/market/config";
import { apiError, caller, json, readJson, registeredOnly } from "@/lib/lobby/route-helpers";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  itemId: z.string().uuid(),
  /** Whole CR as a decimal string (bigint over JSON). */
  price: z.string().regex(/^\d{1,8}$/),
});

const MESSAGES: Record<string, string> = {
  no_user: "Sign in again.",
  too_many_listings: "You have too many active lots. Cancel one first.",
  not_found: "That item is not in your stash.",
  not_in_stash: "That item is not in your stash (equipped, listed or in a raid).",
  bound: "Trader-bound items can't be sold.",
  trade_locked: "Starter-kit items unlock for trading after you extract with them.",
  broken: "Worn-out items can't be sold.",
  not_tradable: "That item can't be traded.",
  bad_price: "Enter a price above zero.",
  insufficient_credits: "Not enough CR for the listing fee.",
  market_paused: "The market is paused for a moment. Your item stays in your stash; try again later.",
};

/** Puts a stash unique on the market at a fixed CR price; charges the CR listing fee. */
export async function POST(req: Request) {
  const c = await caller();
  const deny = registeredOnly(c);
  if (deny || c.kind !== "user") return deny!;
  const parsed = bodySchema.safeParse(await readJson(req));
  if (!parsed.success) return apiError(400, "bad_body", "Pick an item and a price.");
  const rules = marketRules();
  const r = await createListing(db, c.userId, parsed.data.itemId, BigInt(parsed.data.price), {
    feeBps: rules.feeBps,
    sellUnlockLevel: rules.sellUnlockLevel,
    visibleDelayMs: visibleDelayMs(),
  });
  if (!r.ok) {
    const message =
      r.code === "level_locked"
        ? `Selling unlocks at level ${rules.sellUnlockLevel}.`
        : r.code === "price_out_of_band" && r.band
          ? `Price must be between ${formatPrice(r.band.min)} and ${r.band.max ? formatPrice(r.band.max) : "∞"} right now.`
          : (MESSAGES[r.code] ?? r.code);
    const status = r.code === "no_user" ? 401 : r.code === "market_paused" ? 503 : r.code === "price_out_of_band" || r.code === "bad_price" ? 400 : 409;
    return apiError(status, r.code, message);
  }
  return json(r);
}
