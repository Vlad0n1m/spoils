import { z } from "zod";
import { db } from "@/db/client";
import { apiError, caller, json, readJson, registeredOnly } from "@/lib/lobby/route-helpers";
import { submitOp } from "@/lib/onchain/ops";
import { OFF, chainDeps, opErrorResponse } from "@/lib/onchain/server";

export const dynamic = "force-dynamic";
export const maxDuration = 40;

const bodySchema = z.object({ opId: z.string().uuid(), tx: z.string().min(1).max(4000) });

/** Relays a wallet-signed transaction the server prepared, waits for it and applies its effect. */
export async function POST(req: Request) {
  const c = await caller();
  const deny = registeredOnly(c);
  if (deny || c.kind !== "user") return deny!;
  const deps = chainDeps(req);
  if (!deps) return OFF();
  const parsed = bodySchema.safeParse(await readJson(req));
  if (!parsed.success) return apiError(400, "bad_body", "Bad request.");
  try {
    return json(await submitOp(db, deps, c.userId, parsed.data.opId, parsed.data.tx));
  } catch (e) {
    return opErrorResponse(e);
  }
}
