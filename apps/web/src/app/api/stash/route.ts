import { db } from "@/db/client";
import { getStash } from "@/lib/inventory/stash";
import { PARAM, getNumberParam, pausedParam } from "@/lib/economy/params";
import { kitsBoughtToday } from "@/lib/inventory/starter";
import { STARTER_KIT } from "@extract/shared";
import { apiError, caller, json, marketConfig, registeredOnly } from "@/lib/lobby/route-helpers";
import type { StashMoneyDto, StashResponse } from "@/lib/lobby/api-types";
import { stashResponse } from "@/lib/lobby/stash-response";
import { SOL_ECONOMY } from "@/lib/edition";
import { sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

/** Market wallet, market rules and the starter-kit offer of a user (main build only). */
async function stashMoney(userId: string): Promise<StashMoneyDto> {
  const [bal, boughtToday, paused] = await Promise.all([
    db.execute<{ balance_cents: string }>(sql`select balance_cents from users where id = ${userId}`),
    kitsBoughtToday(db, userId),
    pausedParam(db, PARAM.KIT_SALE_PAUSED),
  ]);
  return {
    balance: String(bal.rows[0]?.balance_cents ?? "0"),
    market: marketConfig(),
    kit: { priceMinor: String(STARTER_KIT.PRICE_MINOR), dailyMax: STARTER_KIT.DAILY_MAX, boughtToday, paused },
  };
}

/**
 * Lobby stash: uniques, stacks, CR, level, active loadout, saved draft, junker multiplier; in the main
 * build also the market wallet, market rules and the starter-kit offer (left out in the iDos edition).
 */
export async function GET() {
  const c = await caller();
  const deny = registeredOnly(c);
  if (deny || c.kind !== "user") return deny!;
  const stash = await getStash(db, c.userId);
  if (!stash) return apiError(401, "no_user", "Your account no longer exists. Sign in again.");
  const [autosellMult, money] = await Promise.all([
    getNumberParam(db, PARAM.AUTOSELL_MULT),
    SOL_ECONOMY ? stashMoney(c.userId) : Promise.resolve(null),
  ]);
  return json<StashResponse>(stashResponse(stash, autosellMult, money));
}
