import { db } from "@/db/client";
import { readSignedJson } from "@/lib/game-server-hmac";
import { gameServerBootSchema } from "@/lib/inventory/report-schemas";
import { voidOrphans } from "@/lib/inventory/raids";

export const dynamic = "force-dynamic";

/**
 * Game server → web, HMAC-signed, once at process boot (GameServerBoot). Raids the same serverId
 * started under another instanceId belong to a dead process and can never report their end: they
 * are voided now (gear back to owners, pool items back to the pool). Idempotent.
 */
export async function POST(req: Request) {
  const signed = await readSignedJson(req);
  if (!signed.ok) return signed.res;
  const parsed = gameServerBootSchema.safeParse(signed.json);
  if (!parsed.success) {
    return Response.json({ error: "bad_body", details: parsed.error.flatten() }, { status: 400 });
  }
  try {
    const r = await voidOrphans(db, parsed.data);
    return Response.json({ ok: true, ...r });
  } catch (e) {
    console.error("[raids/void-orphans] failed", e);
    return Response.json({ error: "internal" }, { status: 500 });
  }
}
