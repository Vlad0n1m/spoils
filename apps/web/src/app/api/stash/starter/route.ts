import { db } from "@/db/client";
import { buyStarterKit } from "@/lib/inventory/starter";
import { formatMinor } from "@/lib/market/config";
import { apiError, caller, json, registeredOnly } from "@/lib/lobby/route-helpers";

export const dynamic = "force-dynamic";

/**
 * Buy one starter kit (design §19): pistols, armor, ammo and meds for STARTER_KIT.PRICE_MINOR from
 * the market balance to the treasury, up to STARTER_KIT.DAILY_MAX a day. There is no free kit any
 * more; players without a kit drop with the basic gear. Any request body is ignored (old clients
 * sent `{ paid }`).
 */
export async function POST() {
  const c = await caller();
  const deny = registeredOnly(c);
  if (deny || c.kind !== "user") return deny!;
  const r = await buyStarterKit(db, c.userId);
  if (r.status === "no_user") return apiError(401, "no_user", "Sign in again.");
  if (r.status === "sale_paused") return apiError(503, "sale_paused", "Starter kit sales are paused for a moment. Try again later.");
  if (r.status === "daily_limit") return apiError(429, "daily_limit", `You can buy up to ${r.dailyMax} starter kits a day. Try again tomorrow.`);
  if (r.status === "insufficient_funds") {
    return apiError(402, "insufficient_funds", `The starter kit costs ${formatMinor(BigInt(r.priceMinor))}. Top up your wallet first.`);
  }
  return json({ status: "bought", itemIds: r.itemIds, kit: r.kit, paid: r.paidMinor, boughtToday: r.boughtToday });
}
