import { db } from "@/db/client";
import { readSignedJson } from "@/lib/game-server-hmac";
import { entryRequestSchema } from "@/lib/inventory/report-schemas";
import { enterRaid } from "@/lib/inventory/world";

export const dynamic = "force-dynamic";

/**
 * Game server (BattleRoom.onAuth admission) → web, HMAC-signed: admits one world entry (loadout
 * into the raid, lost-pool release, boss bag). Idempotent on entryId: a retry gets the stored
 * EntryResponse back. A rejection is a 200 with status "rejected" and a reason.
 */
export async function POST(req: Request) {
  const signed = await readSignedJson(req);
  if (!signed.ok) return signed.res;
  const parsed = entryRequestSchema.safeParse(signed.json);
  if (!parsed.success) {
    return Response.json({ error: "bad_body", details: parsed.error.flatten() }, { status: 400 });
  }
  try {
    return Response.json(await enterRaid(db, parsed.data));
  } catch (e) {
    // lock_timeout (55P03) under contention: a 503 the server retries with the same entryId.
    const code = (e as { code?: string; cause?: { code?: string } })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;
    if (code === "55P03" || code === "40P01") {
      console.warn("[raids/enter] lock contention", code);
      return Response.json({ error: "busy" }, { status: 503 });
    }
    console.error("[raids/enter] failed", e);
    return Response.json({ error: "internal" }, { status: 500 });
  }
}
