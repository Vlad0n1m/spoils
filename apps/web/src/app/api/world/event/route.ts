import { db } from "@/db/client";
import { readSignedJson } from "@/lib/game-server-hmac";
import { worldEventReportSchema } from "@/lib/inventory/report-schemas";
import { recordWorldEvent } from "@/lib/inventory/world";

export const dynamic = "force-dynamic";

/**
 * Game server → web, HMAC-signed, fire-and-forget: the event boss of a shard was killed (lobby
 * "killed by" line, News feed). Idempotent: only the first report is stored.
 */
export async function POST(req: Request) {
  const signed = await readSignedJson(req);
  if (!signed.ok) return signed.res;
  const parsed = worldEventReportSchema.safeParse(signed.json);
  if (!parsed.success) {
    return Response.json({ error: "bad_body", details: parsed.error.flatten() }, { status: 400 });
  }
  try {
    const r = await recordWorldEvent(db, parsed.data);
    if (r.status === "unknown") return Response.json({ error: "unknown_match" }, { status: 404 });
    return Response.json({ ok: true, ...r });
  } catch (e) {
    console.error("[world/event] failed", e);
    return Response.json({ error: "internal" }, { status: 500 });
  }
}
