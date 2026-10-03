import { db } from "@/db/client";
import { json } from "@/lib/lobby/route-helpers";
import { WORLD_EVENTS_DEFAULT_LIMIT, worldEvents } from "@/lib/world/events";

export const dynamic = "force-dynamic";

/** News feed of world events (spec §4.9, D27): `?limit=20` (1..50), public, CDN 30 s. */
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("limit");
  const limit = raw === null ? WORLD_EVENTS_DEFAULT_LIMIT : Number(raw);
  try {
    return json(await worldEvents(db, Number.isFinite(limit) ? limit : WORLD_EVENTS_DEFAULT_LIMIT), {
      cache: "public, s-maxage=30, stale-while-revalidate=60",
    });
  } catch (e) {
    console.error("[world/events] failed", e);
    return json({ error: "internal" }, { status: 500 });
  }
}
