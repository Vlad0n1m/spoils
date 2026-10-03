import { db } from "@/db/client";
import { json } from "@/lib/lobby/route-helpers";
import { worldStatus } from "@/lib/world/status";

export const dynamic = "force-dynamic";

/**
 * Lobby world card (spec §4.8, D26): public and identical for every viewer, so the CDN may serve
 * it for 5 s (+10 s stale while it refreshes). The client corrects its clock with `serverTime`
 * plus the `Age` header.
 */
export async function GET() {
  try {
    return json(await worldStatus(db), { cache: "public, s-maxage=5, stale-while-revalidate=10" });
  } catch (e) {
    console.error("[world/status] failed", e);
    return json({ error: "internal" }, { status: 500 });
  }
}
