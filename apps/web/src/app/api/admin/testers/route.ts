import { db } from "@/db/client";
import { adminJson } from "@/lib/admin/guard";
import { adminRoute } from "@/lib/admin/server";
import { grantAlphaTrophies, listBugReports, reviewBugReport } from "@/lib/pass/pass";

export const dynamic = "force-dynamic";

/** GET /api/admin/testers: open bug reports (Alpha Pass "Report a bug"). Admins only (else 404). */
export async function GET() {
  return adminRoute(async () => adminJson({ bugs: await listBugReports(db, "open") }));
}

/**
 * POST /api/admin/testers
 *   `{ action: "bug", id, accept }`: accept (completes the reporter's tester task, once) or reject a report.
 *   `{ action: "trophies" }`: grants the alpha trophy title to the top ranks of every all-time board.
 * Both write admin_audit. Admins only (else 404); the CSRF middleware refuses cross-site requests.
 */
export async function POST(req: Request) {
  return adminRoute(async (admin) => {
    let body: Record<string, unknown> | null = null;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      body = null;
    }
    if (body?.action === "bug" && typeof body.id === "number" && Number.isSafeInteger(body.id) && typeof body.accept === "boolean") {
      const r = await reviewBugReport(db, admin, body.id, body.accept);
      if (!r.ok) return adminJson({ ok: false, error: r.code, message: r.code === "reviewed" ? "Уже разобран." : "Не найден." }, r.code === "reviewed" ? 409 : 404);
      console.info(`[admin] ${admin.nickname} ${body.accept ? "accepted" : "rejected"} bug #${body.id}`);
      return adminJson(r);
    }
    if (body?.action === "trophies") {
      const r = await grantAlphaTrophies(db, admin);
      console.info(`[admin] ${admin.nickname} granted alpha trophies to ${r.granted.length}`);
      return adminJson({ ok: true, ...r });
    }
    return adminJson({ ok: false, error: "bad_body", message: "Неверный запрос." }, 400);
  });
}
