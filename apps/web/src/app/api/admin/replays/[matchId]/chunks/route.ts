import { REPLAY } from "@extract/shared";
import { db } from "@/db/client";
import { adminJson } from "@/lib/admin/guard";
import { readReplayChunks } from "@/lib/admin/replay";
import { adminRoute } from "@/lib/admin/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/replays/:matchId/chunks?from=0&to=44: chunks seq ∈ [from, to] with their data
 * (base64 deflate-raw; decode with @extract/shared decodeReplayChunk), at most REPLAY.READ_MAX_CHUNKS
 * per call; `next` = the seq to continue from. Admins only (else 404).
 */
export async function GET(req: Request, ctx: { params: Promise<{ matchId: string }> }) {
  return adminRoute(async () => {
    const { matchId } = await ctx.params;
    const q = new URL(req.url).searchParams;
    const from = Number(q.get("from") ?? "0");
    const to = Number(q.get("to") ?? String(REPLAY.MAX_SEQ));
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) {
      return adminJson({ error: "bad_query", message: "from и to: целые, 0 ≤ from ≤ to." }, 400);
    }
    const r = await readReplayChunks(db, matchId, from, to);
    if (!r) return adminJson({ error: "not_found", message: "Такого реплея нет." }, 404);
    return adminJson({ matchId: matchId.toLowerCase(), ...r });
  });
}
