import { z } from "zod";
import { db } from "@/db/client";
import { claimStarter } from "@/lib/inventory/starter";
import { formatMinor } from "@/lib/market/config";
import { apiError, caller, json, readJson, registeredOnly } from "@/lib/lobby/route-helpers";

export const dynamic = "force-dynamic";

const bodySchema = z
  .object({
    /** true = the tradable kit for GIVEAWAY.KIT_PRICE_MINOR; false / missing = the free bound kit. */
    paid: z.boolean().optional(),
  })
  .nullable();

/**
 * One giveaway kit per account (weapon + armor + backpack + ammo/meds + CR): free and bound, or
 * tradable after N raids for a small price from the market balance while the giveaway lasts.
 */
export async function POST(req: Request) {
  const c = await caller();
  const deny = registeredOnly(c);
  if (deny || c.kind !== "user") return deny!;
  const parsed = bodySchema.safeParse(await readJson(req));
  if (!parsed.success) return apiError(400, "bad_body", "Pick a kit.");
  const r = await claimStarter(db, c.userId, { paid: parsed.data?.paid ?? false });
  if (r.status === "no_user") return apiError(401, "no_user", "Sign in again.");
  if (r.status === "already") return apiError(409, "already_claimed", "You already claimed your starter kit.");
  if (r.status === "sold_out") return apiError(409, "sold_out", "Tradable kits are sold out. The free kit is still yours to claim.");
  if (r.status === "insufficient_funds") {
    return apiError(402, "insufficient_funds", `The tradable kit costs ${formatMinor(BigInt(r.priceMinor))}. Top up your wallet or take the free kit.`);
  }
  return json({ status: "claimed", itemIds: r.itemIds, kit: r.kit, credits: r.credits, bound: r.bound, paid: r.paidMinor });
}
