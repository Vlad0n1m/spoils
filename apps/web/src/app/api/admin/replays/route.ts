import { db } from "@/db/client";
import { adminJson } from "@/lib/admin/guard";
import { LIST_MAX, listReplays } from "@/lib/admin/replay";
import { adminRoute } from "@/lib/admin/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/replays?limit=50&before=<ISO startedAt>&beforeId=<matchId>: recorded shard-cycles,
 * newest first; the cursor is the last row of the previous page (`next`). Admins only (else 404).
 */
export async function GET(req: Request) {
  return adminRoute(async () => {
    const q = new URL(req.url).searchParams;
    const limit = Number(q.get("limit") ?? "50");
    const beforeRaw = q.get("before");
    const before = beforeRaw ? new Date(beforeRaw) : null;
    if (!Number.isFinite(limit) || limit < 1 || (before && Number.isNaN(before.getTime()))) {
      return adminJson({ error: "bad_query", message: "limit: 1.." + LIST_MAX + ", before: ISO-время." }, 400);
    }
    const rows = await listReplays(db, { limit, before, beforeId: q.get("beforeId") });
    const last = rows.length >= Math.min(limit, LIST_MAX) ? rows.at(-1) : undefined;
    return adminJson({ replays: rows, next: last ? { before: last.startedAt, beforeId: last.matchId } : null });
  });
}
