import { GIVEAWAY, MARKET, POOL } from "@extract/shared";

/**
 * Demo economy rules (critique "Live vs demo economy mode"): for the jury window the giveaway
 * lock is 1 raid and the market opens at level 1. Driven by ECONOMY_DEMO_RULES=1 so production
 * keeps the memo's values without a code change.
 */
export function isDemoEconomyRules(): boolean {
  return process.env.ECONOMY_DEMO_RULES === "1";
}

/** lock_raids given to giveaway (starter kit) items. */
export function giveawayLockRaids(): number {
  return isDemoEconomyRules() ? GIVEAWAY.LOCK_RAIDS_DEMO : GIVEAWAY.LOCK_RAIDS;
}

/** Minimum level to list on the market (WP-W2). */
export function sellUnlockLevel(): number {
  return isDemoEconomyRules() ? 1 : MARKET.SELL_UNLOCK_LEVEL;
}

/**
 * Pool release floor per match (POOL.MIN_RELEASE_PER_MATCH; hackathon tunable). Override with
 * POOL_MIN_RELEASE_PER_MATCH (integer >= 0; 0 = the risk-only rule).
 */
export function poolMinReleasePerMatch(): number {
  const raw = process.env.POOL_MIN_RELEASE_PER_MATCH;
  const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : POOL.MIN_RELEASE_PER_MATCH;
}
