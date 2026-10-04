import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { json } from "@/lib/lobby/route-helpers";
import { PASS_ERR, getPass } from "@/lib/pass/pass";
import { questCaller, questError } from "@/lib/quests/route";

export const dynamic = "force-dynamic";

/**
 * GET /api/pass (PassDto): the caller's Alpha Pass — AP, the 10 tiers (reached / claimed), the week's
 * three weekly tasks (issued at the first look of a week), today's daily-task AP and the tester tasks.
 * Registered players only; private, no-store.
 */
export async function GET() {
  const who = await questCaller({ limit: false });
  if ("res" in who) return who.res;
  try {
    const dto = await getPass(db, who.userId);
    if (!dto) return NextResponse.json({ error: "no_user", message: PASS_ERR.no_user.message }, { status: 403 });
    return json(dto);
  } catch (e) {
    console.error("[pass] get failed", e);
    return questError("internal");
  }
}
