import { db } from "@/db/client";
import { readSignedJson } from "@/lib/game-server-hmac";
import { shardOpenRequestSchema } from "@/lib/inventory/report-schemas";
import { openShard } from "@/lib/inventory/world";

export const dynamic = "force-dynamic";

/**
 * Game server (WorldDirectory.openShard) → web, HMAC-signed: registers a world shard (one raids row
 * per shard-cycle, kind 'world'). Idempotent on matchId: a retry answers `exists`. Until this lands,
 * /api/world/join finds no running row and nobody enters the shard.
 */
export async function POST(req: Request) {
  const signed = await readSignedJson(req);
  if (!signed.ok) return signed.res;
  const parsed = shardOpenRequestSchema.safeParse(signed.json);
  if (!parsed.success) {
    return Response.json({ error: "bad_body", details: parsed.error.flatten() }, { status: 400 });
  }
  try {
    return Response.json(await openShard(db, parsed.data));
  } catch (e) {
    console.error("[raids/open] failed", e);
    return Response.json({ error: "internal" }, { status: 500 });
  }
}
