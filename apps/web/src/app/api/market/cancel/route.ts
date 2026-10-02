import { z } from "zod";
import { db } from "@/db/client";
import { cancelListing } from "@/lib/market/market";
import { apiError, caller, json, readJson, registeredOnly } from "@/lib/lobby/route-helpers";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ listingId: z.string().uuid() });

/** Withdraws the caller's open lot; the item returns to the stash (the CR fee is not refunded). */
export async function POST(req: Request) {
  const c = await caller();
  const deny = registeredOnly(c);
  if (deny || c.kind !== "user") return deny!;
  const parsed = bodySchema.safeParse(await readJson(req));
  if (!parsed.success) return apiError(400, "bad_body", "Pick a lot.");
  const r = await cancelListing(db, c.userId, parsed.data.listingId);
  if (!r.ok) {
    const msg = r.code === "gone" ? "That lot already sold or closed." : r.code === "not_yours" ? "That's not your lot." : "That lot does not exist.";
    return apiError(r.code === "not_found" ? 404 : r.code === "not_yours" ? 403 : 409, r.code, msg);
  }
  return json(r);
}
