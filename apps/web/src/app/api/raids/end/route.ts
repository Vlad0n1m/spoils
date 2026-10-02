import { db } from "@/db/client";
import { readSignedJson } from "@/lib/game-server-hmac";
import { matchEndReportSchema } from "@/lib/inventory/report-schemas";
import { applyEnd } from "@/lib/inventory/raids";

export const dynamic = "force-dynamic";

/**
 * Game server → web, HMAC-signed, at match end (after every exit report was posted). Idempotent
 * on raids.status; 409 once the raid was voided.
 */
export async function POST(req: Request) {
  const signed = await readSignedJson(req);
  if (!signed.ok) return signed.res;
  const parsed = matchEndReportSchema.safeParse(signed.json);
  if (!parsed.success) {
    return Response.json({ error: "bad_body", details: parsed.error.flatten() }, { status: 400 });
  }
  try {
    const r = await applyEnd(db, parsed.data);
    if (r.status === "voided") return Response.json({ error: "voided" }, { status: 409 });
    return Response.json({ ok: true, ...r });
  } catch (e) {
    console.error("[raids/end] failed", e);
    return Response.json({ error: "internal" }, { status: 500 });
  }
}
