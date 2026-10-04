import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  MARKET,
  MARKET_HARD_FLOOR_MINOR,
  marketFeeMinor,
  priceBand,
  templateKey,
  trimmedMedian,
  type ItemCat,
  type PricePoint,
  type Rarity,
} from "@extract/shared";
import { listings, moneyLedger, trades } from "../../db/schema";
import type { Db, Tx } from "../inventory/db";
import { applyMove, isUuid, lockItem } from "../inventory/transition";
import { credit } from "../economy/ledger";
import { PARAM, pausedParam } from "../economy/params";
import type { ListingRowDto, TradeRowDto } from "../lobby/api-types";
import { MAX_PRICE_MINOR, listingFeeCr } from "./config";
import { defOfTemplate } from "./templates";

/**
 * Market v1 (economy memo §7, critique WP-W2): fixed-price lots of uniques, paid in the custodial
 * balance_cents unit. Every mutation is one Postgres transaction that row-locks the listing first,
 * so a lot can be sold once no matter how many buyers click at the same moment; the item moves
 * through the guarded transition helpers (listed → in_stash) with an item_events row per move.
 * Money moves are journalled in money_ledger (UNIQUE(account, reason, ref) = idempotent).
 */

/** The house account that collects fees and treasury sales. */
export const HOUSE_ACCOUNT = "house";

export type ListErr =
  | "no_user"
  | "level_locked"
  | "too_many_listings"
  | "not_found"
  | "not_in_stash"
  | "bound"
  | "trade_locked"
  | "broken"
  | "not_tradable"
  | "bad_price"
  | "price_out_of_band"
  | "insufficient_credits"
  | "market_paused";

export type BuyErr =
  | "not_found"
  | "gone"
  | "not_visible"
  | "expired"
  | "own_listing"
  | "rate_limited"
  | "insufficient_funds"
  | "no_user"
  | "market_paused";

export type CancelErr = "not_found" | "not_yours" | "gone";

export interface ListOpts {
  feeBps?: number;
  sellUnlockLevel: number;
  visibleDelayMs?: number;
  now?: Date;
}

export type ListResult =
  | { ok: true; listingId: string; feeCr: number; visibleAt: number; credits: number }
  | { ok: false; code: ListErr; band?: { min: string; max: string | null } };

class Abort<C extends string> extends Error {
  constructor(readonly code: C) {
    super(code);
  }
}

/**
 * Puts a stash unique up for sale. Rules: seller level ≥ unlock level, under the active-lot cap,
 * item owned and in_stash, not bound, giveaway lock spent (lock_raids = 0), durability > 0, price
 * inside the band around a valid price index (critique: "price band once the index is valid"),
 * CR listing fee paid. The user row is locked first so the cap and the CR fee cannot race.
 */
export async function createListing(
  db: Db,
  sellerId: string,
  itemId: string,
  price: bigint,
  opts: ListOpts,
): Promise<ListResult> {
  const now = opts.now ?? new Date();
  if (price <= 0n || price > MAX_PRICE_MINOR) return { ok: false, code: "bad_price" };
  if (!isUuid(sellerId)) return { ok: false, code: "no_user" };
  // Admin stop-crane (economy_params market_paused, /admin/params).
  if (await pausedParam(db, PARAM.MARKET_PAUSED)) return { ok: false, code: "market_paused" };
  try {
    return await db.transaction(async (tx) => {
      const u = await tx.execute<{ level: number }>(sql`select level from users where id = ${sellerId} for update`);
      const user = u.rows[0];
      if (!user) throw new Abort<ListErr>("no_user");
      if (Number(user.level) < opts.sellUnlockLevel) throw new Abort<ListErr>("level_locked");
      const open = await tx.execute<{ n: number }>(
        sql`select count(*)::int as n from listings where seller_id = ${sellerId} and status in ('pending', 'active')`,
      );
      if (Number(open.rows[0]?.n ?? 0) >= MARKET.MAX_ACTIVE_LISTINGS) throw new Abort<ListErr>("too_many_listings");

      const it = await lockItem(tx, itemId);
      if (!it || it.ownerId !== sellerId) throw new Abort<ListErr>("not_found");
      if (it.state !== "in_stash") throw new Abort<ListErr>("not_in_stash");
      if (it.bound) throw new Abort<ListErr>("bound");
      if (it.lockRaids > 0) throw new Abort<ListErr>("trade_locked");
      if (it.durability <= 0) throw new Abort<ListErr>("broken");
      const template = templateKey({ def: it.defId, rarity: it.rarity });
      if (!template) throw new Abort<ListErr>("not_tradable");

      const index = await priceIndex(tx, template, now);
      const band = priceBand(index, MARKET_HARD_FLOOR_MINOR[clampRarity(it.rarity)]);
      if (price < band.min || (band.max !== null && price > band.max)) {
        return {
          ok: false,
          code: "price_out_of_band",
          band: { min: band.min.toString(), max: band.max?.toString() ?? null },
        } as const;
      }

      const listingId = randomUUID();
      const feeCr = listingFeeCr(it.rarity);
      const c = await credit(tx, sellerId, -feeCr, "listing_fee", listingId);
      if (!c.ok) throw new Abort<ListErr>("insufficient_credits");
      await applyMove(tx, it, { state: "listed" }, { reason: "list", refId: listingId });
      const visibleAt = new Date(now.getTime() + Math.max(0, opts.visibleDelayMs ?? 0));
      await tx.insert(listings).values({
        id: listingId,
        itemId: it.id,
        sellerId,
        template,
        priceMinor: price,
        feeCr,
        status: "active",
        visibleAt,
        expiresAt: new Date(now.getTime() + MARKET.LISTING_TTL_MS),
        createdAt: now,
      });
      return { ok: true, listingId, feeCr, visibleAt: visibleAt.getTime(), credits: c.balance } as const;
    });
  } catch (e) {
    if (e instanceof Abort) return { ok: false, code: e.code as ListErr };
    // listings_one_open_item: the same item listed twice concurrently.
    if (pgCode(e) === "23505") return { ok: false, code: "not_in_stash" };
    throw e;
  }
}

export type BuyResult =
  | { ok: true; tradeId: string; itemId: string; price: string; fee: string; balance: string }
  | { ok: false; code: BuyErr };

type ListingLockRow = {
  id: string;
  item_id: string;
  seller_id: string | null;
  template: string;
  price_minor: string;
  status: string;
  visible_at: Date;
  expires_at: Date;
};

/**
 * Buys one lot. Lock order is listing → users (sorted by id) → item, the same in every market
 * path, so concurrent buys serialize on the listing row instead of deadlocking: the first buyer
 * flips it to `sold`, everyone queued behind the lock re-reads `sold` and gets `gone`.
 * Seller receives price − fee (fee rounded up for the house); a treasury lot pays the house.
 */
export async function buyListing(
  db: Db,
  buyerId: string,
  listingId: string,
  opts: { feeBps?: number; now?: Date } = {},
): Promise<BuyResult> {
  const now = opts.now ?? new Date();
  if (!isUuid(listingId)) return { ok: false, code: "not_found" };
  if (!isUuid(buyerId)) return { ok: false, code: "no_user" };
  // Admin stop-crane (economy_params market_paused, /admin/params).
  if (await pausedParam(db, PARAM.MARKET_PAUSED)) return { ok: false, code: "market_paused" };
  try {
    return await db.transaction(async (tx) => {
      const lr = await tx.execute<ListingLockRow>(
        sql`select id, item_id, seller_id, template, price_minor, status, visible_at, expires_at
            from listings where id = ${listingId} for update`,
      );
      const l = lr.rows[0];
      if (!l) throw new Abort<BuyErr>("not_found");
      if (l.status !== "active" && l.status !== "pending") throw new Abort<BuyErr>("gone");
      if (new Date(l.expires_at).getTime() <= now.getTime()) throw new Abort<BuyErr>("expired");
      if (l.seller_id === buyerId) throw new Abort<BuyErr>("own_listing");
      if (new Date(l.visible_at).getTime() > now.getTime()) throw new Abort<BuyErr>("not_visible");

      const ids = [buyerId, ...(l.seller_id ? [l.seller_id] : [])].sort();
      // One row at a time in id order: two buyers trading with each other cannot deadlock.
      let buyer: { id: string; balance_cents: string } | undefined;
      for (const id of ids) {
        const ur = await tx.execute<{ id: string; balance_cents: string }>(
          sql`select id, balance_cents from users where id = ${id} for update`,
        );
        if (id === buyerId) buyer = ur.rows[0];
      }
      if (!buyer) throw new Abort<BuyErr>("no_user");

      const hour = await tx.execute<{ n: number }>(
        sql`select count(*)::int as n from trades where buyer_id = ${buyerId} and at > ${new Date(now.getTime() - 3600_000)}`,
      );
      if (Number(hour.rows[0]?.n ?? 0) >= MARKET.MAX_BUYS_PER_HOUR) throw new Abort<BuyErr>("rate_limited");
      const day = await tx.execute<{ n: number }>(
        sql`select count(*)::int as n from trades where buyer_id = ${buyerId} and template = ${l.template}
            and at > ${new Date(now.getTime() - 24 * 3600_000)}`,
      );
      if (Number(day.rows[0]?.n ?? 0) >= MARKET.MAX_BUYS_PER_TEMPLATE_PER_DAY) throw new Abort<BuyErr>("rate_limited");

      const price = BigInt(l.price_minor);
      if (BigInt(buyer.balance_cents) < price) throw new Abort<BuyErr>("insufficient_funds");
      const fee = l.seller_id ? marketFeeMinor(price, opts.feeBps ?? MARKET.FEE_BPS) : 0n;
      const net = price - fee;

      const it = await lockItem(tx, l.item_id);
      // A listed item only leaves `listed` through this listing; anything else is corruption,
      // so the whole buy rolls back rather than charging for an item that cannot move.
      if (!it || it.state !== "listed" || it.ownerId !== l.seller_id) throw new Error(`market: listing ${l.id} item ${l.item_id} is not listed`);

      const after = await tx.execute<{ balance_cents: string }>(
        sql`update users set balance_cents = balance_cents - ${price} where id = ${buyerId} returning balance_cents`,
      );
      if (l.seller_id) {
        await tx.execute(sql`update users set balance_cents = balance_cents + ${net} where id = ${l.seller_id}`);
      }
      const journal: Array<typeof moneyLedger.$inferInsert> = [
        { account: buyerId, deltaMinor: -price, reason: "buy", refId: l.id, at: now },
      ];
      if (l.seller_id) {
        journal.push({ account: l.seller_id, deltaMinor: net, reason: "sale", refId: l.id, at: now });
        if (fee > 0n) journal.push({ account: HOUSE_ACCOUNT, deltaMinor: fee, reason: "fee", refId: l.id, at: now });
      } else {
        journal.push({ account: HOUSE_ACCOUNT, deltaMinor: price, reason: "treasury_sale", refId: l.id, at: now });
      }
      await tx.insert(moneyLedger).values(journal);

      await applyMove(tx, it, { state: "in_stash", ownerId: buyerId, matchId: null, loadoutId: null }, { reason: "buy", refId: l.id });
      await tx.execute(sql`update listings set status = 'sold', closed_at = ${now} where id = ${l.id}`);

      const pair = l.seller_id
        ? await tx.execute<{ n: number }>(
            sql`select count(*)::int as n from trades where seller_id = ${l.seller_id} and buyer_id = ${buyerId}
                and at > ${new Date(now.getTime() - MARKET.INDEX_WINDOW_DAYS * 86_400_000)}`,
          )
        : null;
      const counted =
        l.seller_id !== null &&
        it.durability >= MARKET.INDEX_MIN_DUR &&
        Number(pair?.rows[0]?.n ?? 0) < MARKET.INDEX_MAX_PAIR_TRADES;
      const [t] = await tx
        .insert(trades)
        .values({
          listingId: l.id,
          itemId: it.id,
          template: l.template,
          rarity: it.rarity,
          durability: it.durability,
          sellerId: l.seller_id,
          buyerId,
          priceMinor: price,
          feeMinor: fee,
          countedForIndex: counted,
          at: now,
        })
        .returning({ id: trades.id });
      return {
        ok: true,
        tradeId: t!.id,
        itemId: it.id,
        price: price.toString(),
        fee: fee.toString(),
        balance: String(after.rows[0]?.balance_cents ?? "0"),
      } as const;
    });
  } catch (e) {
    if (e instanceof Abort) return { ok: false, code: e.code as BuyErr };
    // trades_listing_once: belt and braces behind the row lock.
    if (pgCode(e) === "23505") return { ok: false, code: "gone" };
    throw e;
  }
}

export type CancelResult = { ok: true } | { ok: false; code: CancelErr };

/** Seller withdraws an open lot: the item goes back to the stash, the CR listing fee is kept. */
export async function cancelListing(db: Db, userId: string, listingId: string, now = new Date()): Promise<CancelResult> {
  if (!isUuid(listingId)) return { ok: false, code: "not_found" };
  return db.transaction(async (tx) => {
    const lr = await tx.execute<ListingLockRow>(
      sql`select id, item_id, seller_id, template, price_minor, status, visible_at, expires_at
          from listings where id = ${listingId} for update`,
    );
    const l = lr.rows[0];
    if (!l) return { ok: false, code: "not_found" } as const;
    if (l.seller_id !== userId) return { ok: false, code: "not_yours" } as const;
    if (l.status !== "active" && l.status !== "pending") return { ok: false, code: "gone" } as const;
    await closeListing(tx, l, "cancelled", "delist", now);
    return { ok: true } as const;
  });
}

/** Closes an open lot and returns its item: to the seller's stash, or to the treasury for NPC lots. */
async function closeListing(
  tx: Tx,
  l: Pick<ListingLockRow, "id" | "item_id" | "seller_id">,
  status: "cancelled" | "expired",
  reason: "delist" | "expire",
  now: Date,
): Promise<void> {
  await tx.execute(sql`update listings set status = ${status}, closed_at = ${now} where id = ${l.id}`);
  const it = await lockItem(tx, l.item_id);
  if (!it || it.state !== "listed") return;
  await applyMove(tx, it, { state: l.seller_id ? "in_stash" : "treasury" }, { reason, refId: l.id });
}

/**
 * Lazy expiry (no cron needed for the demo): lots past expires_at are closed whenever someone
 * browses. SKIP LOCKED so a lot that is being bought right now is left to the buyer.
 */
export async function expireListings(db: Db, now = new Date(), limit = 200): Promise<number> {
  return db.transaction(async (tx) => {
    const rows = await tx.execute<ListingLockRow>(
      sql`select id, item_id, seller_id from listings
          where status in ('pending', 'active') and expires_at <= ${now}
          order by expires_at limit ${limit} for update skip locked`,
    );
    for (const l of rows.rows) await closeListing(tx, l, "expired", "expire", now);
    return rows.rows.length;
  });
}

// ------------------------------------------------------------------ reads

type ListingReadRow = {
  id: string;
  item_id: string;
  def_id: string;
  rarity: number;
  durability: number;
  max_durability: number;
  seller_id: string | null;
  seller_nick: string | null;
  template: string;
  price_minor: string;
  status: ListingRowDto["status"];
  visible_at: Date;
  expires_at: Date;
  created_at: Date;
  closed_at: Date | null;
  fee_cr: number;
};

function toRow(r: ListingReadRow, viewerId: string | null): ListingRowDto {
  return {
    id: r.id,
    item: {
      id: r.item_id,
      def: r.def_id,
      rarity: Number(r.rarity),
      dur: Number(r.durability),
      maxDur: Number(r.max_durability),
    },
    template: r.template,
    seller: r.seller_id ? (r.seller_nick ?? "?") : "Treasury",
    isTreasury: r.seller_id === null,
    mine: viewerId !== null && r.seller_id === viewerId,
    price: String(r.price_minor),
    status: r.status,
    visibleAt: new Date(r.visible_at).getTime(),
    expiresAt: new Date(r.expires_at).getTime(),
    createdAt: new Date(r.created_at).getTime(),
    closedAt: r.closed_at ? new Date(r.closed_at).getTime() : null,
    feeCr: Number(r.fee_cr),
  };
}

export type ListingSort = "price_asc" | "price_desc" | "newest" | "rarity";

export interface BrowseQuery {
  viewerId: string | null;
  cat?: ItemCat | "all";
  /** Exact templateKey, e.g. "weapon:rifle:2". */
  template?: string;
  sort?: ListingSort;
  limit?: number;
  now?: Date;
}

const LISTING_COLUMNS = sql`l.id, l.item_id, i.def_id, i.rarity, i.durability, i.max_durability, l.seller_id,
  u.nickname as seller_nick, l.template, l.price_minor, l.status, l.visible_at, l.expires_at, l.created_at,
  l.closed_at, l.fee_cr`;

/**
 * Open lots visible to the viewer (their own pending lots included), filtered and sorted. Sorts on
 * listing columns pick the page from `listings` alone and join items / users for those rows only
 * (every listing has its item: FK, never deleted), so a page costs ~2 × limit primary-key lookups
 * instead of a hash join over every item and user (docs/DB_REVIEW.md). The rarity sort needs
 * items.rarity, so it joins first.
 */
export async function browseListings(db: Db, q: BrowseQuery): Promise<ListingRowDto[]> {
  const now = q.now ?? new Date();
  const limit = Math.max(1, Math.min(200, q.limit ?? 100));
  const prefix = q.cat && q.cat !== "all" ? `${q.cat}:` : null;
  const order =
    q.sort === "price_desc"
      ? sql`l.price_minor desc, l.created_at desc`
      : q.sort === "newest"
        ? sql`l.created_at desc`
        : q.sort === "rarity"
          ? sql`i.rarity desc, l.price_minor asc`
          : sql`l.price_minor asc, l.created_at asc`;
  const where = sql`l.status in ('pending', 'active')
      and l.expires_at > ${now}
      and (l.visible_at <= ${now} ${q.viewerId ? sql`or l.seller_id = ${q.viewerId}` : sql``})
      ${q.template ? sql`and l.template = ${q.template}` : sql``}
      ${prefix ? sql`and l.template like ${prefix + "%"}` : sql``}`;
  const res =
    q.sort === "rarity"
      ? await db.execute<ListingReadRow>(sql`
          select ${LISTING_COLUMNS}
          from listings l
          join items i on i.id = l.item_id
          left join users u on u.id = l.seller_id
          where ${where}
          order by ${order}
          limit ${limit}`)
      : await db.execute<ListingReadRow>(sql`
          select ${LISTING_COLUMNS}
          from (select * from listings l where ${where} order by ${order} limit ${limit}) l
          join items i on i.id = l.item_id
          left join users u on u.id = l.seller_id
          order by ${order}`);
  return res.rows.map((r) => toRow(r, q.viewerId));
}

/** The seller's lots: open ones first, then the latest closed (sold / cancelled / expired). */
export async function myListings(db: Db, userId: string, limit = 50): Promise<ListingRowDto[]> {
  const res = await db.execute<ListingReadRow>(sql`
    select ${LISTING_COLUMNS}
    from listings l
    join items i on i.id = l.item_id
    left join users u on u.id = l.seller_id
    where l.seller_id = ${userId}
    order by (l.status in ('pending', 'active')) desc, coalesce(l.closed_at, l.created_at) desc
    limit ${Math.max(1, Math.min(200, limit))}`);
  return res.rows.map((r) => toRow(r, userId));
}

/**
 * Price index of a template: trimmed median of index-eligible trades in the last 7 days, valid
 * only with ≥ INDEX_MIN_TRADES trades from ≥ INDEX_MIN_DISTINCT_SELLERS sellers (economy memo §7).
 * Until then there is no band beyond the hard floor.
 */
export async function priceIndex(db: Db | Tx, template: string, now = new Date()): Promise<bigint | null> {
  const since = new Date(now.getTime() - MARKET.INDEX_WINDOW_DAYS * 86_400_000);
  const res = await db.execute<{ price_minor: string; seller_id: string | null }>(sql`
    select price_minor, seller_id from trades
    where template = ${template} and counted_for_index and at > ${since} and durability >= ${MARKET.INDEX_MIN_DUR}`);
  const sellers = new Set(res.rows.map((r) => r.seller_id).filter(Boolean));
  if (res.rows.length < MARKET.INDEX_MIN_TRADES || sellers.size < MARKET.INDEX_MIN_DISTINCT_SELLERS) return null;
  return trimmedMedian(res.rows.map((r) => BigInt(r.price_minor)));
}

/** Last trades (all or one template) plus a 30-day daily median / volume series for the template. */
export async function marketHistory(
  db: Db,
  template: string | null,
  now = new Date(),
): Promise<{ trades: TradeRowDto[]; daily: PricePoint[]; index: bigint | null }> {
  const last = await db.execute<{
    id: string;
    template: string;
    def_id: string | null;
    rarity: number;
    durability: number;
    price_minor: string;
    at: Date;
  }>(sql`
    select t.id, t.template, i.def_id, t.rarity, t.durability, t.price_minor, t.at
    from trades t left join items i on i.id = t.item_id
    ${template ? sql`where t.template = ${template}` : sql``}
    order by t.at desc limit 20`);
  const tradesOut: TradeRowDto[] = last.rows.map((r) => ({
    id: r.id,
    template: r.template,
    def: r.def_id ?? defOfTemplate(r.template),
    rarity: Number(r.rarity),
    dur: Number(r.durability),
    price: String(r.price_minor),
    at: new Date(r.at).getTime(),
  }));
  if (!template) return { trades: tradesOut, daily: [], index: null };
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const rows = await db.execute<{ day: string; price_minor: string }>(sql`
    select to_char(date_trunc('day', at), 'YYYY-MM-DD') as day, price_minor
    from trades where template = ${template} and at > ${since} order by at`);
  const byDay = new Map<string, bigint[]>();
  for (const r of rows.rows) {
    const arr = byDay.get(r.day) ?? [];
    arr.push(BigInt(r.price_minor));
    byDay.set(r.day, arr);
  }
  const daily: PricePoint[] = [...byDay.entries()].map(([day, prices]) => ({
    day,
    median: trimmedMedian(prices)?.toString() ?? null,
    volume: prices.length,
    min: prices.reduce((a, b) => (b < a ? b : a)).toString(),
  }));
  return { trades: tradesOut, daily, index: await priceIndex(db, template, now) };
}

/** Allowed listing band for a template right now (list dialog hint). */
export async function bandFor(db: Db, template: string, rarity: number, now = new Date()) {
  const index = await priceIndex(db, template, now);
  const band = priceBand(index, MARKET_HARD_FLOOR_MINOR[clampRarity(rarity)]);
  return { index, band };
}

function clampRarity(r: number): Rarity {
  return Math.max(0, Math.min(3, Math.floor(r || 0))) as Rarity;
}

function pgCode(e: unknown): string | undefined {
  const x = e as { code?: string; cause?: { code?: string } };
  return x?.code ?? x?.cause?.code;
}
