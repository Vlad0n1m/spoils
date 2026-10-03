import { db } from "@/db/client";
import { readSignedJson } from "@/lib/game-server-hmac";
import { playerExitReportSchema } from "@/lib/inventory/report-schemas";
import { applyExit } from "@/lib/inventory/raids";

export const dynamic = "force-dynamic";

/**
 * Game server → web, HMAC-signed, once per entry leaving the map (extract, death, MIA at the wipe).
 * Idempotent on the entry (raid_exits.entry_id; legacy reports: legacyEntryId(matchId, userId)): a
 * replay answers 200 with status "duplicate" and the stored receipt. 409 once the raid was voided,
 * or for an entry the web does not hold (`unknown_entry`), so the server stops retrying.
 */
export async function POST(req: Request) {
  const signed = await readSignedJson(req);
  if (!signed.ok) return signed.res;
  const parsed = playerExitReportSchema.safeParse(signed.json);
  if (!parsed.success) {
    return Response.json({ error: "bad_body", details: parsed.error.flatten() }, { status: 400 });
  }
  try {
    const r = await applyExit(db, parsed.data);
    if (r.status === "voided") return Response.json({ error: "voided" }, { status: 409 });
    if (r.status === "unknown_entry") return Response.json({ error: "unknown_entry" }, { status: 409 });
    return Response.json({ ok: true, ...r });
  } catch (e) {
    console.error("[raids/exit] failed", e);
    return Response.json({ error: "internal" }, { status: 500 });
  }
}
