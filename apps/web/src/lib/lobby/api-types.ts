/**
 * JSON shapes of the lobby API routes (/api/stash, /api/loadout/*, /api/market/*, /api/trader/*,
 * /api/economy/stats, WORLD v6 /api/world/*, /api/me/world, /api/leaderboards). Types only, so
 * client components and route handlers share one contract. The WORLD v6 DTOs themselves live in
 * @extract/shared (WorldStatusDto, WorldJoinResponse, MeWorldDto, LeaderboardDto, WorldEventsDto).
 * Money is a decimal string of balance_cents minor units (bigint does not survive JSON).
 */
import type { LoadoutEntry, LoadoutErrCode, PricePoint, WorldJoinError } from "@extract/shared";
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

/** The paid starter kit (design §19): price (minor units), today's purchases and the daily cap. */
export interface StarterKitOfferDto {
  priceMinor: string;
  dailyMax: number;
  boughtToday: number;
  paused: boolean;
}

/**
 * The SOL-economy part of GET /api/stash. Sent in the main build only: the iDos edition has no
 * market, wallet or paid kit (docs/IDOS_EDITION.md §3.5), so its /api/stash omits all three fields
 * and the client must treat them as optional.
 */
export interface StashMoneyDto {
  /** Market wallet (minor units). */
  balance: string;
  market: MarketConfigDto;
  kit: StarterKitOfferDto;
}

/** GET /api/stash */
export interface StashResponse extends StashDto, Partial<StashMoneyDto> {
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
  /** Viewer's CR (lots are priced in CR), null for guests / signed-out viewers. */
  credits: number | null;
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
  /** The allowed listing band now (already capped at traderCap). */
  band: { min: string; max: string | null } | null;
  /** The bound traders' CR price for the template's def: no lot may ask more. Null when no trader sells it. */
  traderCap?: string | null;
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

/**
 * Error body of POST /api/world/join (spec §4.7). Every response carries `serverTime` (world clock,
 * ms) so the lobby can correct its countdowns.
 * - entry_closed: `openAt` = when the next entry window opens.
 * - world_starting: `retryInMs` (the shard of this cycle is not registered yet).
 * - in_raid: `settlesAt` = when the entry's shard is voided at the latest (ends_at + RAID_USER_VOID_GRACE_MS, 12 min), if known.
 * - loadout codes: `key` = the offending slot.
 */
export interface WorldJoinErrorBody {
  /** not_on_map: a `rejoinOnly` join found no active entry to rejoin (nothing was locked). */
  error: WorldJoinError | "conflict" | "no_user" | "guest_play_disabled" | "not_on_map";
  message: string;
  serverTime: number;
  openAt?: number;
  retryInMs?: number;
  settlesAt?: number;
  key?: string;
}
