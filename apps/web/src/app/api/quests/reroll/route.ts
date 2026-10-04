import { db } from "@/db/client";
import { json, readJson } from "@/lib/lobby/route-helpers";
import { rerollQuest } from "@/lib/quests/quests";
import { questCaller, questError } from "@/lib/quests/route";

export const dynamic = "force-dynamic";

/**
 * POST /api/quests/reroll `{ slot }`: the day's one free swap of an open task (progress starts
 * over). No paid swap exists. 200 `{ ok, message }`; 409 reroll_used / task_done.
 */
export async function POST(req: Request) {
  const who = await questCaller({ limit: true });
  if ("res" in who) return who.res;
  const body = (await readJson(req)) as { slot?: unknown } | null;
  if (typeof body?.slot !== "number" || !Number.isInteger(body.slot)) return questError("bad_body");
  try {
    const r = await rerollQuest(db, who.userId, body.slot);
    if (!r.ok) return questError(r.code);
    return json({ ok: true, message: "Task swapped." });
  } catch (e) {
    console.error("[quests] reroll failed", e);
    return questError("internal");
  }
}
