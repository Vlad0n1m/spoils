import { db } from "@/db/client";
import { apiError, json } from "@/lib/lobby/route-helpers";
import { isBoard, isPeriod, leaderboard } from "@/lib/world/leaderboards";

export const dynamic = "force-dynamic";

/**
 * Public top 100 (spec §4.9, D25): `?board=level|kills|npc&period=map|week|all` (defaults level,
 * week; the level board is all-time). CDN 30 s (+60 s stale). The caller's own rank is the private
 * /api/leaderboards/me.
 */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const board = q.get("board") ?? "level";
  const period = q.get("period") ?? "week";
  if (!isBoard(board) || !isPeriod(period)) return apiError(400, "bad_query", "Unknown board or period.");
  try {
    return json(await leaderboard(db, board, period), { cache: "public, s-maxage=30, stale-while-revalidate=60" });
  } catch (e) {
    console.error("[leaderboards] failed", e);
    return apiError(500, "internal");
  }
}
