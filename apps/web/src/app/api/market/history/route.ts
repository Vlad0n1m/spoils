import { db } from "@/db/client";
import { bandFor, marketHistory } from "@/lib/market/market";
import { json } from "@/lib/lobby/route-helpers";
import type { HistoryResponse } from "@/lib/lobby/api-types";

export const dynamic = "force-dynamic";

const TEMPLATE_RE = /^(weapon:[a-z_]+:[0-3]|armor:[1-3]|backpack:[1-3])$/;

/**
 * Last 20 trades (all, or one template with `?template=`), plus for a template the 30-day daily
 * median / volume, the price index and the allowed listing band. Public, cached 60 s.
 */
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("template");
  const template = raw && TEMPLATE_RE.test(raw) ? raw : null;
  const h = await marketHistory(db, template);
  let band: HistoryResponse["band"] = null;
  if (template) {
    const rarity = template.startsWith("weapon:") ? Number(template.split(":")[2]) : 0;
    const b = await bandFor(db, template, rarity);
    band = { min: b.band.min.toString(), max: b.band.max?.toString() ?? null };
  }
  return json<HistoryResponse>(
    { template, trades: h.trades, daily: h.daily, index: h.index?.toString() ?? null, band },
    { cache: "public, max-age=0, s-maxage=60" },
  );
}
