import { db } from "@/db/client";
import { handleReplayIngest } from "@/lib/admin/replay-ingest";
import { coreEnv } from "@/lib/env";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Game server (world/replay-upload.ts) → web: one replay chunk (@extract/shared ReplayChunkUpload),
 * HMAC-signed with GAME_SERVER_HMAC_SECRET like raids/*. Not an admin-session route: the signature
 * is its guard (lib/admin/replay-ingest.ts). Idempotent by (matchId, seq).
 */
export async function POST(req: Request) {
  return handleReplayIngest(req, db, coreEnv().GAME_SERVER_HMAC_SECRET);
}
