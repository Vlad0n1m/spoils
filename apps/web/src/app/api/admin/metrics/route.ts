import { db } from "@/db/client";
import { adminJson } from "@/lib/admin/guard";
import { adminMetrics } from "@/lib/admin/metrics";
import { adminRoute } from "@/lib/admin/server";

export const dynamic = "force-dynamic";

/** GET /api/admin/metrics: the /admin metrics as JSON (AdminMetrics). 404 unless the caller is an admin. */
export async function GET() {
  return adminRoute(async () => adminJson(await adminMetrics(db)));
}
