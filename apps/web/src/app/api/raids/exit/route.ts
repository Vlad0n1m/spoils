import { db } from "@/db/client";
import { readSignedJson } from "@/lib/game-server-hmac";
import { playerExitReportSchema } from "@/lib/inventory/report-schemas";
import { applyExit } from "@/lib/inventory/raids";

export const dynamic = "force-dynamic";

/**
 * Game server → web, HMAC-signed, once per human leaving the map. Idempotent on (matchId, userId):
 * a replay answers 200 with status "duplicate" and the stored receipt. 409 once the raid was
 * voided, so the server stops retrying.
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
    return Response.json({ ok: true, ...r });
  } catch (e) {
    console.error("[raids/exit] failed", e);
    return Response.json({ error: "internal" }, { status: 500 });
  }
}
