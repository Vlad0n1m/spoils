/**
 * JSON shapes of the lobby API routes (/api/stash, /api/loadout/*, /api/market/*, /api/trader/*,
 * /api/economy/stats). Types only, so client components and route handlers share one contract.
 * Money is a decimal string of balance_cents minor units (bigint does not survive JSON).
 */
import type { LoadoutEntry, LoadoutErrCode, PricePoint } from "@extract/shared";
import type { StashDto } from "../inventory/stash";

export type { StashDto, StashItemDto } from "../inventory/stash";

export interface MarketConfigDto {
  currency: string;
  decimals: number;
  feeBps: number;
  sellUnlockLevel: number;
  maxActiveListings: number;
  /** CR listing fee by rarity 0..3. */
  listingFeeCr: readonly number[];
}

/** GET /api/stash */
export interface StashResponse extends StashDto {
  /** Market wallet (minor units). */
  balance: string;
  market: MarketConfigDto;
  /** Junk autosell multiplier currently paid by the junker. */
  autosellMult: number;
}

export interface ListingItemDto {
  id: string;
  def: string;
  rarity: number;
  /** DB durability % 0..100. */
  dur: number;
  maxDur: number;
}

export interface ListingRowDto {
  id: string;
  item: ListingItemDto;
  template: string;
  /** Seller nickname; "Treasury" for NPC lots. */
  seller: string;
  isTreasury: boolean;
  mine: boolean;
  price: string;
  status: "pending" | "active" | "sold" | "cancelled" | "expired";
  /** ms epoch: before this only the seller sees the lot. */
  visibleAt: number;
  expiresAt: number;
  createdAt: number;
  closedAt: number | null;
  feeCr: number;
}

/** GET /api/market/listings */
export interface ListingsResponse {
  listings: ListingRowDto[];
  market: MarketConfigDto;
  /** Viewer's market wallet, null for guests / signed-out viewers. */
  balance: string | null;
}

export interface TradeRowDto {
  id: string;
  template: string;
  def: string;
  rarity: number;
  dur: number;
  price: string;
  at: number;
}

/** GET /api/market/history */
export interface HistoryResponse {
  template: string | null;
  trades: TradeRowDto[];
  daily: PricePoint[];
  /** Trimmed-median price index, null until enough independent trades exist. */
  index: string | null;
  band: { min: string; max: string | null } | null;
}

/** Error body of every lobby mutation: `error` is a stable code, `message` is UI text. */
export interface ApiError {
  error: string;
  message?: string;
  key?: string;
  matchId?: string;
}

export interface DraftResponse {
  entries: LoadoutEntry[];
}

export type LoadoutLockError = LoadoutErrCode | "in_raid" | "conflict" | "no_user";

/** GET /api/economy/stats */
export interface EconomyStatsDto {
  generatedAt: number;
  currency: string;
  players: { registered: number; active24h: number; raids24h: number; extractRate24h: number | null };
  credits: {
    circulating: number;
    in24h: number;
    out24h: number;
    inAll: number;
    outAll: number;
    byReason: Array<{ reason: string; in24h: number; out24h: number; inAll: number; outAll: number }>;
  };
  items: {
    byState: Record<string, number>;
    /** in_stash + listed + in_raid: items players can still use or trade. */
    circulating: number;
    poolSize: number;
    treasury: number;
    destroyed: number;
  };
  market: {
    activeListings: number;
    trades24h: number;
    tradesAll: number;
    volume24h: string;
    volumeAll: string;
    fees24h: string;
    feesAll: string;
  };
  autosellMult: number;
  daily: Array<{ day: string; data: Record<string, unknown> }>;
}
