import type { CosmeticBadgesDto } from "@extract/shared";
import { db } from "@/db/client";
import { apiError, json } from "@/lib/lobby/route-helpers";
import { cosmeticBadges } from "@/lib/quests/quests";
import { NICKNAME_RE } from "@/lib/social/rules";

export const dynamic = "force-dynamic";

/**
 * GET /api/quests/badges?n=<nickname>&n=… (≤ 100): equipped titles, name colours and badge frames of
 * those players, for the leaderboard rows. Public like the boards (nicknames are public there);
 * CDN 30 s (+60 s stale). Unknown or plain players are left out.
 */
export async function GET(req: Request) {
  const names = new URL(req.url).searchParams.getAll("n").filter((n) => NICKNAME_RE.test(n));
  if (names.length > 100) return apiError(400, "bad_query", "At most 100 nicknames.");
  try {
    const body: CosmeticBadgesDto = { badges: await cosmeticBadges(db, names) };
    return json(body, { cache: "public, s-maxage=30, stale-while-revalidate=60" });
  } catch (e) {
    console.error("[quests] badges failed", e);
    return apiError(500, "internal");
  }
}
