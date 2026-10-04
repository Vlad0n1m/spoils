import { eq, sql } from "drizzle-orm";
import { POOL } from "@extract/shared";
import { economyParams } from "../../db/schema";
import type { Db, Tx } from "../inventory/db";

/** Keys in economy_params. Numbers are stored as plain JSON numbers. */
export const PARAM = {
  /** Junk autosell multiplier, steered daily by nextAutosellMult (0.6..1.3). */
  AUTOSELL_MULT: "autosell_mult",
  /** Fractional CR accumulator of the 1% treasury tax (takeTreasuryTax). */
  TAX_ACC: "tax_acc",
  /** ISO timestamp of the last seed-economy run. */
  SEEDED_AT: "seeded_at",
  /**
   * Pool release factor k: risk part = round(k × riskUnits) (v4 default POOL.RISK_K = 1.0, clamped
   * 0..2). The lever if the pool swells (economy memo §13): 1.25. Never a free floor.
   */
  POOL_RISK_K: "pool_risk_k",
  /** Cap of pool items released into one match (v4 default POOL.MAX_PER_MATCH = 8, clamped 0..16). */
  POOL_MAX_PER_MATCH: "pool_max_per_match",
  /** UTC day (YYYY-MM-DD) the daily regulator last ran (runEconomyDaily, once per day). */
  DAILY_RAN_ON: "daily_ran_on",
  /**
   * Stop-crane (ALPHA_PLAN B7): 1 = the player market takes no new lots and sells none (list / buy
   * answer 503 market_paused); cancelling a lot still works. 0 (default) = open.
   */
  MARKET_PAUSED: "market_paused",
  /** Stop-crane (ALPHA_PLAN B7): 1 = the paid (tradable) starter kit is not sold; the free kit still is. */
  KIT_SALE_PAUSED: "kit_sale_paused",
} as const;

const DEFAULTS: Record<string, number> = {
  [PARAM.AUTOSELL_MULT]: 1,
  [PARAM.TAX_ACC]: 0,
  [PARAM.POOL_RISK_K]: POOL.RISK_K,
  [PARAM.POOL_MAX_PER_MATCH]: POOL.MAX_PER_MATCH,
  [PARAM.MARKET_PAUSED]: 0,
  [PARAM.KIT_SALE_PAUSED]: 0,
};

/** Reads a numeric param (no lock). Missing or malformed rows fall back to the default. */
export async function getNumberParam(db: Db | Tx, key: string): Promise<number> {
  const rows = await db.select({ value: economyParams.value }).from(economyParams).where(eq(economyParams.key, key));
  const v = rows[0]?.value;
  return typeof v === "number" && Number.isFinite(v) ? v : (DEFAULTS[key] ?? 0);
}

/**
 * Reads a numeric param under a row lock, creating the row first so the lock always exists.
 * Used for accumulators (tax_acc) that concurrent settlements update read-modify-write.
 */
export async function lockNumberParam(tx: Tx, key: string): Promise<number> {
  await tx
    .insert(economyParams)
    .values({ key, value: DEFAULTS[key] ?? 0 })
    .onConflictDoNothing();
  const rows = await tx.execute<{ value: unknown }>(
    sql`select value from economy_params where key = ${key} for update`,
  );
  const v = rows.rows[0]?.value;
  return typeof v === "number" && Number.isFinite(v) ? v : (DEFAULTS[key] ?? 0);
}

/** A 0/1 stop-crane param (PARAM.MARKET_PAUSED, PARAM.KIT_SALE_PAUSED) is on. */
export async function pausedParam(db: Db | Tx, key: string): Promise<boolean> {
  return (await getNumberParam(db, key)) >= 1;
}

export async function setParam(db: Db | Tx, key: string, value: unknown): Promise<void> {
  await db
    .insert(economyParams)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: economyParams.key, set: { value, updatedAt: new Date() } });
}
