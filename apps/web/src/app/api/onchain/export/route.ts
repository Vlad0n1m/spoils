import { z } from "zod";
import { db } from "@/db/client";
import { apiError, caller, json, readJson, registeredOnly } from "@/lib/lobby/route-helpers";
import { exportItem } from "@/lib/onchain/ops";
import { OFF, chainDeps, opErrorResponse } from "@/lib/onchain/server";

export const dynamic = "force-dynamic";
export const maxDuration = 40;

const bodySchema = z.object({ itemId: z.string().uuid() });

/** Sends an epic+ stash item to the caller's linked wallet (server-signed: the player pays nothing). */
export async function POST(req: Request) {
  const c = await caller();
  const deny = registeredOnly(c);
  if (deny || c.kind !== "user") return deny!;
  const deps = chainDeps(req);
  if (!deps) return OFF();
  const parsed = bodySchema.safeParse(await readJson(req));
  if (!parsed.success) return apiError(400, "bad_body", "Pick an item.");
  try {
    return json(await exportItem(db, deps, c.userId, parsed.data.itemId));
  } catch (e) {
    return opErrorResponse(e);
  }
}
