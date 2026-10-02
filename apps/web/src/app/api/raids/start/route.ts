import { db } from "@/db/client";
import { readSignedJson } from "@/lib/game-server-hmac";
import { raidStartRequestSchema } from "@/lib/inventory/report-schemas";
import { startRaid } from "@/lib/inventory/raids";

export const dynamic = "force-dynamic";

/**
 * Game server (MatchmakingRoom.launch) → web, HMAC-signed. Accepts/rejects locked loadouts and
 * releases lost-pool items into containers. Idempotent per matchId: a retry gets the stored
 * RaidStartResponse back.
 */
export async function POST(req: Request) {
  const signed = await readSignedJson(req);
  if (!signed.ok) return signed.res;
  const parsed = raidStartRequestSchema.safeParse(signed.json);
  if (!parsed.success) {
    return Response.json({ error: "bad_body", details: parsed.error.flatten() }, { status: 400 });
  }
  try {
    return Response.json(await startRaid(db, parsed.data));
  } catch (e) {
    console.error("[raids/start] failed", e);
    return Response.json({ error: "internal" }, { status: 500 });
  }
}
