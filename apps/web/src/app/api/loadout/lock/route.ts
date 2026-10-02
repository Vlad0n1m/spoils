import { db } from "@/db/client";
import { entriesSchema, lockAndIssueTicket } from "@/lib/lobby/join";
import { apiError, caller, json, readJson } from "@/lib/lobby/route-helpers";

export const dynamic = "force-dynamic";

/**
 * Locks a loadout (body `{entries}` or the saved draft) and returns the signed join ticket.
 * Same as POST /api/matches/join, plus an explicit entries list.
 */
export async function POST(req: Request) {
  const body = (await readJson(req)) as { entries?: unknown } | null;
  let entries;
  if (body?.entries !== undefined) {
    const parsed = entriesSchema.safeParse(body.entries);
    if (!parsed.success) return apiError(400, "bad_body", "Loadout data is malformed.");
    entries = parsed.data;
  }
  const r = await lockAndIssueTicket(db, await caller(), entries);
  if (!r.ok) return apiError(r.status, r.error, r.message, { key: r.key, matchId: r.matchId });
  return json({ ticket: r.ticket, roomName: r.roomName, loadoutId: r.loadoutId, entries: r.entries, pruned: r.pruned });
}
