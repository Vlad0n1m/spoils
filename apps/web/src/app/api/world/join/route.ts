import { db } from "@/db/client";
import { entriesSchema, worldJoin } from "@/lib/lobby/join";
import { caller, json, readJson } from "@/lib/lobby/route-helpers";
import { UUID_RE } from "@/lib/social/party";
import { worldNow } from "@/lib/world/clock";

export const dynamic = "force-dynamic";

/**
 * WORLD v6 PLAY (spec §4.7): body `{ entries?, dropId? }` (the loadout to lock, else the saved draft;
 * the party drop to follow, else the party's newest live one — lib/social/party.ts).
 * 200 WorldJoinResponse (a fresh entry, or `rejoin: true` for the caller's active entry); errors
 * `{ error, message, serverTime, openAt?, retryInMs?, settlesAt?, key? }` (WorldJoinErrorBody).
 * Private: never cached.
 */
export async function POST(req: Request) {
  const body = (await readJson(req)) as { entries?: unknown; dropId?: unknown } | null;
  let entries;
  if (body?.entries !== undefined) {
    const parsed = entriesSchema.safeParse(body.entries);
    if (!parsed.success) {
      return json({ error: "bad_body", message: "Loadout data is malformed.", serverTime: worldNow() }, { status: 400 });
    }
    entries = parsed.data;
  }
  const dropId = typeof body?.dropId === "string" && UUID_RE.test(body.dropId) ? body.dropId : undefined;
  const r = await worldJoin(db, await caller(), entries, undefined, { dropId });
  return json(r.body, { status: r.ok ? 200 : r.status });
}
