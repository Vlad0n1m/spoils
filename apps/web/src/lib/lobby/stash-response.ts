import type { StashDto, StashMoneyDto, StashResponse } from "./api-types";

/**
 * Body of GET /api/stash. `money` (market wallet, market rules, starter-kit offer) is null in the iDos
 * edition (no SOL economy, docs/IDOS_EDITION.md §3.5): those keys are then left out entirely, not
 * sent as zeros, so nothing in the edition can show or act on them.
 */
export function stashResponse(stash: StashDto, autosellMult: number, money: StashMoneyDto | null): StashResponse {
  return money ? { ...stash, ...money, autosellMult } : { ...stash, autosellMult };
}

/** Whether a /api/stash body carries the SOL-economy fields (main build) — false in the iDos edition. */
export function hasStashMoney<T extends Partial<StashMoneyDto>>(s: T): s is T & StashMoneyDto {
  return typeof s.balance === "string" && s.market !== undefined && s.kit !== undefined;
}
