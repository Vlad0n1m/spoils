import { db } from "@/db/client";
import { adminJson } from "@/lib/admin/guard";
import { parseParamSetBody, readAdminParams, setAdminParam } from "@/lib/admin/params";
import { adminRoute } from "@/lib/admin/server";
import type { AdminParamSetResult } from "@/lib/admin/types";

export const dynamic = "force-dynamic";

/** GET /api/admin/params: stop-cranes, the read-only economy_params rows and the audit tail. Admins only (else 404). */
export async function GET() {
  return adminRoute(async () => adminJson(await readAdminParams(db)));
}

const STATUS: Record<Exclude<AdminParamSetResult, { ok: true }>["error"], number> = {
  bad_body: 400,
  unknown_param: 400,
  out_of_range: 400,
  stale: 409,
};

/**
 * POST /api/admin/params `{ key, value, expected, note? }`: sets one stop-crane with an admin_audit
 * row. 409 `stale` when the value changed since the admin loaded it. Admins only (else 404); the
 * CSRF middleware already refuses cross-site and form-body requests.
 */
export async function POST(req: Request) {
  return adminRoute(async (admin) => {
    let raw: unknown = null;
    try {
      raw = await req.json();
    } catch {
      raw = null;
    }
    const body = parseParamSetBody(raw);
    if (!body) {
      const r: AdminParamSetResult = { ok: false, error: "bad_body", message: "Нужны key, value и expected (числа)." };
      return adminJson(r, STATUS.bad_body);
    }
    const r = await setAdminParam(db, admin, body);
    if (r.ok) console.info(`[admin] ${admin.nickname} set ${r.audit.target}: ${JSON.stringify(r.audit.oldValue)} -> ${JSON.stringify(r.audit.newValue)}`);
    return adminJson(r, r.ok ? 200 : STATUS[r.error]);
  });
}
