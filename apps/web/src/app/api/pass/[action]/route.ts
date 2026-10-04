import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { json, readJson } from "@/lib/lobby/route-helpers";
import { PASS_ERR, claimPassTier, submitBugReport, submitSurvey, type PassErr } from "@/lib/pass/pass";
import { questCaller, questError } from "@/lib/quests/route";

export const dynamic = "force-dynamic";

function passError(code: PassErr) {
  const e = PASS_ERR[code];
  return NextResponse.json({ error: code, message: e.message }, { status: e.status, headers: { "Cache-Control": "no-store" } });
}

/**
 * POST /api/pass/claim `{ tier }`: take a reached tier's cosmetic (permanent).
 * POST /api/pass/bug `{ text, context? }`: a bug report for review in /admin.
 * POST /api/pass/survey `{ answers }`: the alpha survey (once).
 * Registered players only, throttled like the quest routes. Nothing here pays CR, items or SOL.
 */
export async function POST(req: Request, ctx: { params: Promise<{ action: string }> }) {
  const { action } = await ctx.params;
  const who = await questCaller({ limit: true });
  if ("res" in who) return who.res;
  const body = (await readJson(req)) as Record<string, unknown> | null;
  try {
    if (action === "claim") {
      const tier = body?.tier;
      if (typeof tier !== "number" || !Number.isInteger(tier)) return questError("bad_body");
      const r = await claimPassTier(db, who.userId, tier);
      return r.ok ? json({ ok: true, reward: r.reward }) : passError(r.code);
    }
    if (action === "bug") {
      const text = body?.text;
      const context = body?.context;
      if (typeof text !== "string" || text.length > 4000) return questError("bad_body");
      const r = await submitBugReport(db, who.userId, text, typeof context === "string" ? context : null);
      return r.ok ? json({ ok: true, id: r.id }) : passError(r.code);
    }
    if (action === "survey") {
      const r = await submitSurvey(db, who.userId, body?.answers);
      return r.ok ? json({ ok: true }) : passError(r.code);
    }
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  } catch (e) {
    console.error(`[pass] ${action} failed`, e);
    return questError("internal");
  }
}
