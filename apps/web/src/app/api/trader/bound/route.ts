import { z } from "zod";
import { db } from "@/db/client";
import { buyBound } from "@/lib/market/trader";
import { apiError, caller, json, readJson, registeredOnly } from "@/lib/lobby/route-helpers";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  def: z.string().min(1).max(32),
  /** Client idempotency key (one per click). */
  requestId: z.string().uuid(),
});

/** Bound gear for CR (BOUND_OFFERS): never sellable, never enters the lost pool. */
export async function POST(req: Request) {
  const c = await caller();
  const deny = registeredOnly(c);
  if (deny || c.kind !== "user") return deny!;
  const parsed = bodySchema.safeParse(await readJson(req));
  if (!parsed.success) return apiError(400, "bad_body", "Pick an item.");
  const r = await buyBound(db, c.userId, parsed.data.def, parsed.data.requestId);
  if (!r.ok) {
    const msg =
      r.code === "insufficient_credits" ? "Not enough CR."
      : r.code === "no_user" ? "Sign in again."
      : r.code === "trader_level" ? "Reach a higher level to unlock this."
      : "The trader doesn't sell that.";
    const status = r.code === "insufficient_credits" || r.code === "trader_level" ? 409 : r.code === "no_user" ? 401 : 400;
    return apiError(status, r.code, msg);
  }
  return json(r);
}
