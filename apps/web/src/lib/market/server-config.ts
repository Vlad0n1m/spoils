import { MARKET } from "@extract/shared";
import { isDemoEconomyRules, sellUnlockLevel } from "../economy/config";

/**
 * Server-side market knobs. Every one is configuration (Vlad decides the fee and the currency),
 * read from the environment with the economy memo's defaults.
 */

/** Seller fee in basis points. MARKET_FEE_BPS overrides MARKET.FEE_BPS (5%); clamped to 0..20%. */
export function marketFeeBps(): number {
  const raw = Number(process.env.MARKET_FEE_BPS);
  if (!Number.isFinite(raw) || process.env.MARKET_FEE_BPS?.trim() === "" || process.env.MARKET_FEE_BPS === undefined) {
    return MARKET.FEE_BPS;
  }
  return Math.max(0, Math.min(2000, Math.round(raw)));
}

/**
 * Delay before a new lot becomes visible to other players (anti-sniper, economy memo §7). The
 * jury demo runs with ECONOMY_DEMO_RULES=1 and gets instant lots so a list → buy round trip can
 * be shown live; MARKET_VISIBLE_DELAY_MS=<n> pins it explicitly.
 */
export function visibleDelayMs(rng: () => number = Math.random): number {
  const pinned = process.env.MARKET_VISIBLE_DELAY_MS;
  if (pinned !== undefined && pinned.trim() !== "" && Number.isFinite(Number(pinned))) {
    return Math.max(0, Number(pinned));
  }
  if (isDemoEconomyRules()) return 0;
  const [lo, hi] = MARKET.VISIBLE_DELAY_MS;
  return Math.round(lo + rng() * (hi - lo));
}

export interface MarketRules {
  feeBps: number;
  sellUnlockLevel: number;
  maxActiveListings: number;
  listingTtlMs: number;
}

export function marketRules(): MarketRules {
  return {
    feeBps: marketFeeBps(),
    sellUnlockLevel: sellUnlockLevel(),
    maxActiveListings: MARKET.MAX_ACTIVE_LISTINGS,
    listingTtlMs: MARKET.LISTING_TTL_MS,
  };
}
