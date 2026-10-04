import { db } from "@/db/client";
import { getStash } from "@/lib/inventory/stash";
import { PARAM, getNumberParam, pausedParam } from "@/lib/economy/params";
import { kitsBoughtToday } from "@/lib/inventory/starter";
import { STARTER_KIT } from "@extract/shared";
import { apiError, caller, json, marketConfig, registeredOnly } from "@/lib/lobby/route-helpers";
import type { StashResponse } from "@/lib/lobby/api-types";
import { sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

/** Lobby stash: uniques, stacks, CR, level, active loadout, saved draft, market wallet, starter-kit offer. */
export async function GET() {
  const c = await caller();
  const deny = registeredOnly(c);
  if (deny || c.kind !== "user") return deny!;
  const stash = await getStash(db, c.userId);
  if (!stash) return apiError(401, "no_user", "Your account no longer exists. Sign in again.");
  const [bal, autosellMult, boughtToday, paused] = await Promise.all([
    db.execute<{ balance_cents: string }>(sql`select balance_cents from users where id = ${c.userId}`),
    getNumberParam(db, PARAM.AUTOSELL_MULT),
    kitsBoughtToday(db, c.userId),
    pausedParam(db, PARAM.KIT_SALE_PAUSED),
  ]);
  return json<StashResponse>({
    ...stash,
    balance: String(bal.rows[0]?.balance_cents ?? "0"),
    market: marketConfig(),
    autosellMult,
    kit: { priceMinor: String(STARTER_KIT.PRICE_MINOR), dailyMax: STARTER_KIT.DAILY_MAX, boughtToday, paused },
  });
}
