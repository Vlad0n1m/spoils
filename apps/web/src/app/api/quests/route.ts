import { db } from "@/db/client";
import { json } from "@/lib/lobby/route-helpers";
import { getQuests } from "@/lib/quests/quests";
import { questCaller, questError } from "@/lib/quests/route";

export const dynamic = "force-dynamic";

/**
 * GET /api/quests (QuestsDto): the caller's three daily tasks for this UTC day (issued at the first
 * look of the day), the free swap, task XP today, task marks, level and equipped cosmetics.
 * Registered players only; private, no-store.
 */
export async function GET() {
  const who = await questCaller({ limit: false });
  if ("res" in who) return who.res;
  try {
    const dto = await getQuests(db, who.userId);
    if (!dto) return questError("no_user");
    return json(dto);
  } catch (e) {
    console.error("[quests] get failed", e);
    return questError("internal");
  }
}
