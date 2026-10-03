import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { coreEnv } from "@/lib/env";
import { runEconomyDaily } from "@/lib/economy/daily";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Daily economy controller: steers the junk autosell multiplier from the veterans' median CR and
 * stores the KPI snapshot shown on /economy. Safe to call more often: runEconomyDaily applies once
 * per UTC day and answers "already" afterwards.
 */
export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  const cronSecret = coreEnv().CRON_SECRET;
  if (cronSecret && auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const r = await runEconomyDaily(db);
    return NextResponse.json({ ok: true, ...r });
  } catch (err) {
    console.error("[cron/economy-daily] failed", err);
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
