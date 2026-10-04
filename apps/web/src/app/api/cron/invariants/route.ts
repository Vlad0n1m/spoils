import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { coreEnv, isCronAuthorized } from "@/lib/env";
import { runInvariants } from "@/lib/admin/invariants";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * B6 nightly invariant check (lib/admin/invariants.ts): read-only checks that items, CR and market
 * money agree with their journals and that the house only receives. Stores the run in
 * invariant_runs (shown on /admin/invariants) and alerts on a failure (log line + ALERT_WEBHOOK_URL).
 * Answers 200 with ok:false on failed checks: the run itself succeeded.
 */
export async function GET(req: Request) {
  if (!isCronAuthorized(req.headers.get("authorization"), coreEnv().CRON_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const r = await runInvariants(db, "cron");
    return NextResponse.json({
      ok: r.ok,
      runId: r.id,
      failed: r.checks.filter((c) => c.status !== "ok").map((c) => ({ key: c.key, status: c.status, count: c.count })),
      durationMs: r.durationMs,
    });
  } catch (err) {
    console.error("[cron/invariants] failed", err);
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
