import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { purgeOldReplays } from "@/lib/admin/replay";
import { coreEnv, isCronAuthorized } from "@/lib/env";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Admin replay retention: deletes replays whose cycle started more than REPLAY.RETENTION_DAYS (14)
 * days ago, chunks included (bounded batches per call). Bearer CRON_SECRET; scheduled daily in
 * deploy/cron/schedule.json and apps/web/vercel.json.
 */
export async function GET(req: Request) {
  if (!isCronAuthorized(req.headers.get("authorization"), coreEnv().CRON_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const r = await purgeOldReplays(db);
    return NextResponse.json({ ok: true, ...r });
  } catch (err) {
    console.error("[cron/replays-retention] failed", err);
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
