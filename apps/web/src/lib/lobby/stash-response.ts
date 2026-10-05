import type { MarketConfigDto, StashDto, StashMoneyDto, StashResponse } from "./api-types";

/**
 * Body of GET /api/stash. `money` (market wallet, market rules, starter-kit offer) is null in the iDos
 * edition (no SOL economy, docs/IDOS_EDITION.md §3.5): the wallet and the kit offer are then left out
 * entirely, not sent as zeros, so nothing in the edition can show or act on them. The CR market's
 * rules (`market`) are still sent there: the player market runs on CR in both builds.
 */
export function stashResponse(
  stash: StashDto,
  autosellMult: number,
  money: StashMoneyDto | null,
  market: MarketConfigDto | null = null,
): StashResponse {
  if (money) return { ...stash, ...money, autosellMult };
  return market ? { ...stash, market, autosellMult } : { ...stash, autosellMult };
}

/** Whether a /api/stash body carries the SOL-economy fields (main build) — false in the iDos edition. */
export function hasStashMoney<T extends Partial<StashMoneyDto>>(s: T): s is T & StashMoneyDto {
  return typeof s.balance === "string" && s.market !== undefined && s.kit !== undefined;
}

/** Whether a /api/stash body carries the CR market's rules (both builds; absent only in old bodies). */
export function hasStashMarket<T extends Partial<StashMoneyDto>>(s: T): s is T & Pick<StashMoneyDto, "market"> {
  return s.market !== undefined;
}
