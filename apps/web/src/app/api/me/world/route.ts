import { db } from "@/db/client";
import { apiError, caller, json } from "@/lib/lobby/route-helpers";
import { meWorld } from "@/lib/world/me";

export const dynamic = "force-dynamic";

/** The caller's world state (spec §4.9): active entry (rejoin) and last raid card. Private, no-store. */
export async function GET() {
  const c = await caller();
  if (c.kind === "anon") return apiError(401, "unauthenticated", "Sign in first.");
  return json(await meWorld(db, c.userId));
}
