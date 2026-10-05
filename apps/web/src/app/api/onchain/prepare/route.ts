import { z } from "zod";
import { db } from "@/db/client";
import { apiError, caller, json, readJson, registeredOnly } from "@/lib/lobby/route-helpers";
import { prepareOp } from "@/lib/onchain/ops";
import { OFF, chainDeps, opErrorResponse } from "@/lib/onchain/server";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  action: z.enum(["import", "kit", "list", "buy", "cancel"]),
  asset: z.string().min(32).max(44).optional(),
  price: z.string().max(20).optional(),
});

/** Builds the transaction the caller's wallet will sign (see lib/onchain/ops.ts). */
export async function POST(req: Request) {
  const c = await caller();
  const deny = registeredOnly(c);
  if (deny || c.kind !== "user") return deny!;
  const deps = chainDeps(req);
  if (!deps) return OFF();
  const parsed = bodySchema.safeParse(await readJson(req));
  if (!parsed.success) return apiError(400, "bad_body", "Bad request.");
  try {
    const { action, ...p } = parsed.data;
    return json(await prepareOp(db, deps, c.userId, action, p));
  } catch (e) {
    return opErrorResponse(e);
  }
}
