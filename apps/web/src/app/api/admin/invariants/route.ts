import { db } from "@/db/client";
import { adminJson } from "@/lib/admin/guard";
import { latestInvariantRuns, runInvariants } from "@/lib/admin/invariants";
import { adminRoute } from "@/lib/admin/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** GET /api/admin/invariants: the last 10 invariant runs, newest first. Admins only (else 404). */
export async function GET() {
  return adminRoute(async () => adminJson({ runs: await latestInvariantRuns(db, 10) }));
}

/**
 * POST /api/admin/invariants: runs the invariant check now (the same read-only checks as the
 * nightly cron, stored with trigger 'admin', alerting on failure). Admins only (else 404).
 */
export async function POST() {
  return adminRoute(async (admin) => {
    const r = await runInvariants(db, "admin");
    console.info(`[admin] ${admin.nickname} ran the invariant check: run ${r.id}, ${r.ok ? "ok" : `${r.failed} failed`}`);
    return adminJson({ ok: r.ok, runId: r.id, failed: r.failed });
  });
}
