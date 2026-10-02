import { db } from "@/db/client";
import { getEconomyStats } from "@/lib/lobby/economy-stats";
import { apiError, json } from "@/lib/lobby/route-helpers";
import type { EconomyStatsDto } from "@/lib/lobby/api-types";

export const dynamic = "force-dynamic";

/** Public economy numbers for /economy (CR flows, items by state, pool, treasury, trades). */
export async function GET() {
  try {
    return json<EconomyStatsDto>(await getEconomyStats(db), { cache: "public, max-age=0, s-maxage=60" });
  } catch (e) {
    console.error("[economy/stats] failed", e);
    return apiError(503, "unavailable", "Economy stats are unavailable right now.");
  }
}
