import { db } from "@/db/client";
import { unlockLoadout } from "@/lib/inventory/loadout";
import { apiError, caller, json } from "@/lib/lobby/route-helpers";

export const dynamic = "force-dynamic";

/** Search cancelled: a locked (not yet started) loadout goes back to the stash. Guests: no-op. */
export async function POST() {
  const c = await caller();
  if (c.kind === "anon") return apiError(401, "unauthenticated", "Sign in first.");
  if (c.kind === "guest") return json({ ok: true, unlocked: false });
  const r = await unlockLoadout(db, c.userId);
  if (!r.ok) return apiError(409, "in_raid", "Your gear is already in a running raid.", { matchId: r.matchId });
  return json(r);
}
