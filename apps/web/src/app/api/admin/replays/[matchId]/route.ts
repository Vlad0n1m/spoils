import { db } from "@/db/client";
import { adminJson } from "@/lib/admin/guard";
import { readReplay } from "@/lib/admin/replay";
import { adminRoute } from "@/lib/admin/server";

export const dynamic = "force-dynamic";

/** GET /api/admin/replays/:matchId: the replay row and its chunk index (no data). Admins only (else 404). */
export async function GET(_req: Request, ctx: { params: Promise<{ matchId: string }> }) {
  return adminRoute(async () => {
    const { matchId } = await ctx.params;
    const r = await readReplay(db, matchId);
    if (!r) return adminJson({ error: "not_found", message: "Такого реплея нет (или он старше 14 дней)." }, 404);
    return adminJson(r);
  });
}
