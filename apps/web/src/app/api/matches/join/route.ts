import { db } from "@/db/client";
import { lockAndIssueTicket } from "@/lib/lobby/join";
import { apiError, caller, json } from "@/lib/lobby/route-helpers";

export const dynamic = "force-dynamic";

/**
 * Raid tab "Play": locks the saved loadout (Loadout tab draft) and issues a join ticket carrying
 * its loadoutId. Guests, and players with an empty loadout, drop with the free kit (loadoutId "").
 */
export async function POST() {
  const r = await lockAndIssueTicket(db, await caller());
  if (!r.ok) return apiError(r.status, r.error, r.message, { key: r.key, matchId: r.matchId });
  return json({ ticket: r.ticket, roomName: r.roomName, loadoutId: r.loadoutId, entries: r.entries, pruned: r.pruned });
}
