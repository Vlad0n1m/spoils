import { z } from "zod";
import { db } from "@/db/client";
import { MAX_PACKS, buyConsumables } from "@/lib/market/trader";
import { apiError, caller, json, readJson, registeredOnly } from "@/lib/lobby/route-helpers";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  def: z.string().min(1).max(32),
  packs: z.number().int().min(1).max(MAX_PACKS),
  /** Client idempotency key (one per click). */
  requestId: z.string().uuid(),
});

/** Junker: ammo and meds for CR (CONSUMABLES_CR). */
export async function POST(req: Request) {
  const c = await caller();
  const deny = registeredOnly(c);
  if (deny || c.kind !== "user") return deny!;
  const parsed = bodySchema.safeParse(await readJson(req));
  if (!parsed.success) return apiError(400, "bad_body", "Pick an item and an amount.");
  const r = await buyConsumables(db, c.userId, parsed.data.def, parsed.data.packs, parsed.data.requestId);
  if (!r.ok) {
    const msg = r.code === "insufficient_credits" ? "Not enough CR." : r.code === "no_user" ? "Sign in again." : "The junker doesn't sell that.";
    return apiError(r.code === "insufficient_credits" ? 409 : r.code === "no_user" ? 401 : 400, r.code, msg);
  }
  return json(r);
}
