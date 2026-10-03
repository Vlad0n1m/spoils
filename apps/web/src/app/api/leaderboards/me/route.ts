import type { LeaderboardMeDto } from "@extract/shared";
import { db } from "@/db/client";
import { apiError, caller, json } from "@/lib/lobby/route-helpers";
import { isBoard, isPeriod, leaderboardMe } from "@/lib/world/leaderboards";

export const dynamic = "force-dynamic";

/**
 * The caller's own rank on a board (spec §4.9): LeaderboardMeDto, `null` when they are not on it
 * (guests never are: boards are for registered users). Private, never cached.
 */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const board = q.get("board") ?? "level";
  const period = q.get("period") ?? "week";
  if (!isBoard(board) || !isPeriod(period)) return apiError(400, "bad_query", "Unknown board or period.");
  const c = await caller();
  if (c.kind === "anon") return apiError(401, "unauthenticated", "Sign in first.");
  if (c.kind === "guest") return json<LeaderboardMeDto>(null);
  return json<LeaderboardMeDto>(await leaderboardMe(db, c.userId, board, period));
}
