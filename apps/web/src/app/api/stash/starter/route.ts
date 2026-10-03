import { db } from "@/db/client";
import { claimStarter } from "@/lib/inventory/starter";
import { apiError, caller, json, registeredOnly } from "@/lib/lobby/route-helpers";

export const dynamic = "force-dynamic";

/**
 * One giveaway kit per account (weapon + armor + backpack + ammo/meds + CR): trade-locked for N raids
 * when the account passes the giveaway gates (GIVEAWAY: cap + deposit), else bound (never listable).
 */
export async function POST() {
  const c = await caller();
  const deny = registeredOnly(c);
  if (deny || c.kind !== "user") return deny!;
  const r = await claimStarter(db, c.userId);
  if (r.status === "no_user") return apiError(401, "no_user", "Sign in again.");
  if (r.status === "already") return apiError(409, "already_claimed", "You already claimed your starter kit.");
  return json({ status: "claimed", itemIds: r.itemIds, kit: r.kit, credits: r.credits, bound: r.bound });
}
