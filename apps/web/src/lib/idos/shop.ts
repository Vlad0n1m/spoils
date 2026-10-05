/**
 * The iDos edition's SPOILS shop (docs/IDOS_EDITION.md §3.5): quotes for a player and the buy flow.
 * Prices, limits and the pure pricing rules live in lib/idos/shop-rules.ts; the payment through the
 * iDos Title store in lib/idos/store-pay.ts.
 *
 * A buy is an idos_orders row (migration 017) keyed by (user, client request id), walked through:
 *   pending ──pay verified──▶ paid ──one DB transaction──▶ delivered
 *      │                         └─ delivery impossible now (crate sold out, daily cap) ─▶ refund_owed
 *      ├─ iDos took nothing ─▶ failed
 *      ├─ iDos took part of it (100k leg yes, 1k leg no) or not what we asked ─▶ refund_owed
 *      └─ iDos did not answer ─▶ stays pending; the same request id retries with the same iDos keys
 * Nothing is ever delivered on an unverified payment, and a replayed request id never pays twice:
 * a delivered order answers with its result, a failed one with its reason.
 *
 * Delivery reuses the game's own mechanisms, so the nightly invariants (lib/admin/invariants.ts) hold:
 * crate items move lost_pool → in_stash through applyMove (an item_events row, reason `idos_shop`, ref
 * the order id); the starter kit is grantStarterKit (the same kit and daily cap as the main build's);
 * the CR pack is one credit_ledger row (reason `idos_shop`); donation titles are pass_unlocks rows
 * (source `donation`). Crates are never minted: they only redistribute what raiders lost, and never
 * take the pool below its live floor (economy_params pool_min_reserve, POOL.MIN_RESERVE) or below
 * CRATE_MIN_PER_RARITY items of their rarity, so raids keep their loot.
 */
import { sql } from "drizzle-orm";
import { STARTER_KIT, mulberry32, type Rng } from "@extract/shared";
import { idosOrders } from "../../db/schema";
import type { Db, Tx } from "../inventory/db";
import { applyMove, isUuid, lockItem } from "../inventory/transition";
import { grantStarterKit, kitsBoughtToday } from "../inventory/starter";
import { credit } from "../economy/ledger";
import { PARAM, pausedParam } from "../economy/params";
import { readReleaseParams } from "../economy/pool";
import {
  IDOS_PRODUCTS,
  IDOS_SHOP,
  crateCents,
  decomposeSpoils,
  shopProduct,
  spoilsForCents,
  spoilsPerCent,
  type ShopProductDef,
  type ShopProductKind,
} from "./shop-rules";
import { payLegs, type IdosCallOptions, type IdosPlayer, type LegProgress, type PayFailCode } from "./store-pay";
import type { TokenPrice } from "./token-price";

// ---------------------------------------------------------------- quotes

/** Why a product cannot be bought right now. */
export type UnavailableReason = "sold_out" | "daily_limit" | "paused" | "no_price";

export interface ShopQuote {
  id: string;
  kind: ShopProductKind;
  name: string;
  blurb: string;
  /** Price now in US cents (crates after scarcity and demand). */
  usdCents: number;
  /** That price in SPOILS (a multiple of 1 000); null without a token price. */
  spoils: number | null;
  available: boolean;
  reason?: UnavailableReason;
  /** Crates: items of the crate's rarity in the lost pool. */
  stock?: number;
  /** Daily-capped products: bought today / the cap. */
  limit?: { used: number; max: number };
}

/** Everything a quote depends on besides the token price (shopState reads it; tests build it). */
export interface ShopState {
  /** Items in the lost pool, all rarities. */
  poolSize: number;
  /** Lost-pool items a crate may draw, by rarity 0..2. */
  poolByRarity: readonly number[];
  /** The live pool floor (economy_params pool_min_reserve). */
  minReserve: number;
  /** Crates delivered in the last 24 h, by product id. */
  sold24h: Readonly<Record<string, number>>;
  kitsToday: number;
  kitDailyMax: number;
  kitPaused: boolean;
  crPacksToday: number;
}

/** A crate of `rarity` may draw one item: the pool stays at its floor and keeps 5 of that rarity. */
export function crateAvailable(s: ShopState, rarity: number): boolean {
  const stock = s.poolByRarity[rarity] ?? 0;
  return s.poolSize - 1 >= s.minReserve && stock - 1 >= IDOS_SHOP.CRATE_MIN_PER_RARITY;
}

/** The price of `def` now in cents (crates move with the pool and the day's sales; the rest are fixed). */
export function productCents(def: ShopProductDef, s: ShopState): number {
  if (def.kind !== "crate") return def.usdCents;
  return crateCents(def.usdCents, s.poolByRarity[def.rarity ?? 0] ?? 0, s.sold24h[def.id] ?? 0);
}

/** Pure: every product's quote for a player in state `s` at `usdPerSpoils` (null = no price). */
export function quoteProducts(s: ShopState, usdPerSpoils: number | null): ShopQuote[] {
  return IDOS_PRODUCTS.map((def) => {
    const usdCents = productCents(def, s);
    const spoils = usdPerSpoils === null ? null : spoilsForCents(usdCents, usdPerSpoils);
    const q: ShopQuote = { id: def.id, kind: def.kind, name: def.name, blurb: def.blurb, usdCents, spoils, available: true };
    let reason: UnavailableReason | undefined;
    if (def.kind === "crate") {
      q.stock = s.poolByRarity[def.rarity ?? 0] ?? 0;
      if (!crateAvailable(s, def.rarity ?? 0)) reason = "sold_out";
    } else if (def.kind === "kit") {
      q.limit = { used: s.kitsToday, max: s.kitDailyMax };
      if (s.kitPaused) reason = "paused";
      else if (s.kitsToday >= s.kitDailyMax) reason = "daily_limit";
    } else if (def.kind === "credits") {
      q.limit = { used: s.crPacksToday, max: IDOS_SHOP.CR_PACK_DAILY_MAX };
      if (s.crPacksToday >= IDOS_SHOP.CR_PACK_DAILY_MAX) reason = "daily_limit";
    }
    if (!reason && spoils === null) reason = "no_price";
    if (reason) {
      q.available = false;
      q.reason = reason;
    }
    return q;
  });
}

function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** The lost-pool items a crate may draw (any unique there is tradable; worn-out ones are skipped). */
const CRATE_ITEM_SQL = sql`state = 'lost_pool' and not bound and durability > 0`;

export async function shopState(q: Db | Tx, userId: string, now = new Date()): Promise<ShopState> {
  const since24h = new Date(now.getTime() - IDOS_SHOP.DEMAND_WINDOW_MS).toISOString();
  const today = utcDayStart(now).toISOString();
  const [pool, sold, packs, kitsToday, kitPaused, release] = await Promise.all([
    q.execute<{ size: number; r0: number; r1: number; r2: number }>(sql`
      select count(*)::int as size,
             count(*) filter (where ${CRATE_ITEM_SQL} and rarity = 0)::int as r0,
             count(*) filter (where ${CRATE_ITEM_SQL} and rarity = 1)::int as r1,
             count(*) filter (where ${CRATE_ITEM_SQL} and rarity = 2)::int as r2
      from items where state = 'lost_pool'`),
    q.execute<{ product: string; n: number }>(sql`
      select product, count(*)::int as n from idos_orders
      where status = 'delivered' and product like 'crate_%' and created_at >= ${since24h}
      group by product`),
    q.execute<{ n: number }>(sql`
      select count(*)::int as n from idos_orders
      where user_id = ${userId} and product = 'cr_pack' and status = 'delivered' and created_at >= ${today}`),
    kitsBoughtToday(q, userId, now),
    pausedParam(q, PARAM.KIT_SALE_PAUSED),
    readReleaseParams(q as Tx),
  ]);
  const p = pool.rows[0];
  return {
    poolSize: Number(p?.size ?? 0),
    poolByRarity: [Number(p?.r0 ?? 0), Number(p?.r1 ?? 0), Number(p?.r2 ?? 0)],
    minReserve: release.minReserve,
    sold24h: Object.fromEntries(sold.rows.map((r) => [r.product, Number(r.n)])),
    kitsToday,
    kitDailyMax: STARTER_KIT.DAILY_MAX,
    kitPaused,
    crPacksToday: Number(packs.rows[0]?.n ?? 0),
  };
}

export interface ShopQuotes {
  products: ShopQuote[];
  /** SPOILS per US cent at the current price; null without one. */
  spoilsPerCent: number | null;
  /** When the token price was fetched (ms epoch); null without one. */
  priceAt: number | null;
}

/** GET /api/idos/shop. */
export async function quoteShop(db: Db, userId: string, price: TokenPrice | null, now = new Date()): Promise<ShopQuotes> {
  const s = await shopState(db, userId, now);
  return {
    products: quoteProducts(s, price?.usd ?? null),
    spoilsPerCent: price ? spoilsPerCent(price.usd) : null,
    priceAt: price?.at ?? null,
  };
}

// ---------------------------------------------------------------- orders

export type OrderStatus = "pending" | "paid" | "delivered" | "failed" | "refund_owed";

interface OrderDetail {
  legs?: LegProgress;
  code?: string;
  message?: string;
  item?: ShopItemDto;
  itemIds?: string[];
  credits?: number;
  granted?: boolean;
}

/** Raw idos_orders row (snake_case; bigint columns come back as strings). */
type OrderRow = {
  id: string;
  user_id: string;
  product: string;
  request_id: string;
  usd_cents: number;
  spoils_quoted: string | number;
  spoils_paid: string | number;
  status: OrderStatus;
  detail: OrderDetail | null;
  created_at: Date | string;
};

export interface ShopItemDto {
  id: string;
  def: string;
  rarity: number;
  dur: number;
}

export interface OrderDto {
  id: string;
  product: string;
  usdCents: number;
  spoils: number;
  spoilsPaid: number;
  status: OrderStatus;
  createdAt: number;
}

function toDto(r: OrderRow): OrderDto {
  return {
    id: r.id,
    product: r.product,
    usdCents: Number(r.usd_cents),
    spoils: Number(r.spoils_quoted),
    spoilsPaid: Number(r.spoils_paid),
    status: r.status,
    createdAt: new Date(r.created_at).getTime(),
  };
}

export type BuyCode =
  | "bad_product"
  | "bad_request"
  | "no_price"
  | "in_progress"
  | "idos_unavailable"
  | UnavailableReason
  | PayFailCode
  | "delivery_failed";

export type BuyResult =
  | { ok: true; status: "delivered"; order: OrderDto; item?: ShopItemDto; replay: boolean; message: string }
  | { ok: false; status: "rejected" | "pending" | "failed" | "refund_owed"; code: BuyCode; message: string; order?: OrderDto };

export interface BuyDeps {
  /** The token price (lib/idos/token-price.ts spoilsPrice.get in production). */
  price: () => Promise<TokenPrice | null>;
  /** The iDos payment (store-pay payLegs); tests pass a fake. */
  pay?: typeof payLegs;
  idos?: IdosCallOptions;
  now?: Date;
  rng?: Rng;
}

const REJECT_MESSAGES: Record<UnavailableReason | "bad_product" | "bad_request" | "no_price" | "in_progress", string> = {
  bad_product: "That item is not sold here.",
  bad_request: "Refresh the shop and try again.",
  no_price: "The SPOILS price is not available right now. Try again in a minute.",
  in_progress: "That purchase is already being processed.",
  sold_out: "Sold out for now: the lost pool is too thin. Check back after a few raids.",
  daily_limit: "Daily limit reached. Come back tomorrow (UTC).",
  paused: "This item is paused for a moment. Nothing was charged.",
};

/** Orders being paid by this process right now (a double-submitted request waits for the first). */
const inFlight = new Set<string>();

/** "8YECHSD4/abc" (users.idos_user_id, lib/idos/verify.ts idosAccountKey) → its Title and UserID. */
export function parseIdosAccountKey(key: string | null | undefined): { titleId: string; userId: string } | null {
  if (typeof key !== "string") return null;
  const i = key.indexOf("/");
  if (i <= 0 || i === key.length - 1) return null;
  return { titleId: key.slice(0, i), userId: key.slice(i + 1) };
}

async function findOrder(q: Db | Tx, userId: string, requestId: string, lock = false): Promise<OrderRow | null> {
  const r = await q.execute<OrderRow>(
    lock
      ? sql`select * from idos_orders where user_id = ${userId} and request_id = ${requestId} for update`
      : sql`select * from idos_orders where user_id = ${userId} and request_id = ${requestId}`,
  );
  return r.rows[0] ?? null;
}

async function setOrder(
  q: Db | Tx,
  id: string,
  from: OrderStatus,
  to: OrderStatus,
  patch: { spoilsPaid?: number; detail: OrderDetail },
): Promise<OrderRow | null> {
  const r = await q.execute<OrderRow>(sql`
    update idos_orders set
      status = ${to},
      spoils_paid = coalesce(${patch.spoilsPaid ?? null}::bigint, spoils_paid),
      detail = coalesce(detail, '{}'::jsonb) || ${JSON.stringify(patch.detail)}::jsonb,
      updated_at = now()
    where id = ${id} and status = ${from}
    returning *`);
  return r.rows[0] ?? null;
}

/** The answer for an order that already reached a final state (a replayed request id). */
function finalAnswer(o: OrderRow, replay: boolean): BuyResult | null {
  const d = o.detail ?? {};
  if (o.status === "delivered") {
    return { ok: true, status: "delivered", order: toDto(o), ...(d.item ? { item: d.item } : {}), replay, message: d.message ?? "Delivered." };
  }
  if (o.status === "failed" || o.status === "refund_owed") {
    return { ok: false, status: o.status, code: (d.code as BuyCode) ?? "refused", message: d.message ?? "The purchase failed.", order: toDto(o) };
  }
  return null;
}

/**
 * POST /api/idos/shop/buy. `player` is the iDos identity of `userId` (Title and UserID from
 * users.idos_user_id, the ticket from the client); `requestId` is the client's idempotency key (uuid).
 */
export async function buyProduct(
  db: Db,
  userId: string,
  player: IdosPlayer,
  productId: string,
  requestId: string,
  deps: BuyDeps,
): Promise<BuyResult> {
  const def = shopProduct(productId);
  if (!def) return { ok: false, status: "rejected", code: "bad_product", message: REJECT_MESSAGES.bad_product };
  if (!isUuid(requestId)) return { ok: false, status: "rejected", code: "bad_request", message: REJECT_MESSAGES.bad_request };
  const now = deps.now ?? new Date();

  let order = await findOrder(db, userId, requestId);
  if (order) {
    if (order.product !== def.id) return { ok: false, status: "rejected", code: "bad_request", message: REJECT_MESSAGES.bad_request };
    const done = finalAnswer(order, true);
    if (done) return done;
  } else {
    // A new order: quote it now and keep that quote (a retry pays what was quoted, never re-prices).
    const price = await deps.price();
    if (!price) return { ok: false, status: "rejected", code: "no_price", message: REJECT_MESSAGES.no_price };
    const quote = quoteProducts(await shopState(db, userId, now), price.usd).find((p) => p.id === def.id)!;
    if (!quote.available || quote.spoils === null) {
      const reason = quote.reason ?? "no_price";
      return { ok: false, status: "rejected", code: reason, message: REJECT_MESSAGES[reason] };
    }
    const inserted = await db
      .insert(idosOrders)
      .values({ userId, product: def.id, requestId, usdCents: quote.usdCents, spoilsQuoted: quote.spoils, status: "pending", detail: {} })
      .onConflictDoNothing()
      .returning({ id: idosOrders.id });
    if (inserted.length === 0) return { ok: false, status: "rejected", code: "in_progress", message: REJECT_MESSAGES.in_progress };
    order = await findOrder(db, userId, requestId);
    if (!order) throw new Error("idos shop: the new order vanished");
  }

  if (inFlight.has(order.id)) return { ok: false, status: "rejected", code: "in_progress", message: REJECT_MESSAGES.in_progress };
  inFlight.add(order.id);
  try {
    if (order.status === "pending") {
      const legs = decomposeSpoils(Number(order.spoils_quoted));
      if (!legs) {
        const failed = await setOrder(db, order.id, "pending", "failed", { detail: { code: "bad_request", message: "That price cannot be paid." } });
        return finalAnswer(failed ?? order, false)!;
      }
      const out = await (deps.pay ?? payLegs)(player, order.id, legs, order.detail?.legs ?? {}, deps.idos);
      if (out.status === "unknown") {
        await setOrder(db, order.id, "pending", "pending", { detail: { legs: out.legs } });
        return { ok: false, status: "pending", code: "idos_unavailable", message: out.message, order: toDto(order) };
      }
      if (out.status !== "paid") {
        const message =
          out.status === "refund_owed"
            ? `${out.message} ${out.paid.toLocaleString("en-US")} SPOILS were taken and will be refunded; nothing was delivered.`
            : out.message;
        const row = await setOrder(db, order.id, "pending", out.status, { spoilsPaid: out.paid, detail: { legs: out.legs, code: out.code, message } });
        return finalAnswer(row ?? order, false) ?? { ok: false, status: out.status, code: out.code, message };
      }
      const paid = await setOrder(db, order.id, "pending", "paid", { spoilsPaid: out.paid, detail: { legs: out.legs } });
      if (!paid) return { ok: false, status: "rejected", code: "in_progress", message: REJECT_MESSAGES.in_progress };
      order = paid;
    }
    return await deliver(db, order, def, now, deps.rng);
  } finally {
    inFlight.delete(order.id);
  }
}

// ---------------------------------------------------------------- delivery

type Delivered = { ok: true; detail: OrderDetail } | { ok: false; code: UnavailableReason | "delivery_failed"; message: string };

/**
 * Delivers a paid order in one transaction: the order row is locked and must still be `paid`, the
 * user row is locked (caps cannot race), the goods move, the order becomes `delivered`. When the goods
 * are no longer there (the last crate item went to a raid, the daily cap filled from another tab) the
 * order becomes `refund_owed` instead: the player paid, so it is on record.
 */
async function deliver(db: Db, order: OrderRow, def: ShopProductDef, now: Date, rng?: Rng): Promise<BuyResult> {
  const row = await db.transaction(async (tx) => {
    const o = (await tx.execute<OrderRow>(sql`select * from idos_orders where id = ${order.id} for update`)).rows[0];
    if (!o || o.status !== "paid") return o ?? null;
    await tx.execute(sql`select id from users where id = ${o.user_id} for update`);
    const d = await deliverGoods(tx, o, def, now, rng);
    if (d.ok) return setOrder(tx, o.id, "paid", "delivered", { detail: d.detail });
    const paid = Number(o.spoils_paid).toLocaleString("en-US");
    return setOrder(tx, o.id, "paid", "refund_owed", {
      detail: { code: d.code, message: `${d.message} Your ${paid} SPOILS will be refunded; nothing was delivered.` },
    });
  });
  if (!row) return { ok: false, status: "rejected", code: "in_progress", message: REJECT_MESSAGES.in_progress };
  return (
    finalAnswer(row, false) ?? { ok: false, status: "pending", code: "in_progress", message: REJECT_MESSAGES.in_progress, order: toDto(row) }
  );
}

async function deliverGoods(tx: Tx, o: OrderRow, def: ShopProductDef, now: Date, rng?: Rng): Promise<Delivered> {
  const userId = o.user_id;
  switch (def.kind) {
    case "crate": {
      const rarity = def.rarity ?? 0;
      const s = await shopState(tx, userId, now);
      if (!crateAvailable(s, rarity)) return { ok: false, code: "sold_out", message: REJECT_MESSAGES.sold_out };
      // One random item of the rarity; SKIP LOCKED so a raid release or another crate never waits on it.
      const pick = await tx.execute<{ id: string }>(sql`
        select id from items where ${CRATE_ITEM_SQL} and rarity = ${rarity}
        order by random() limit 1 for update skip locked`);
      const it = pick.rows[0] ? await lockItem(tx, pick.rows[0].id) : null;
      if (!it || it.state !== "lost_pool") return { ok: false, code: "sold_out", message: REJECT_MESSAGES.sold_out };
      const moved = await applyMove(
        tx,
        it,
        {
          state: "in_stash",
          ownerId: userId,
          matchId: null,
          loadoutId: null,
          lockRaidsDelta: Math.max(0, IDOS_SHOP.CRATE_LOCK_RAIDS - it.lockRaids),
        },
        { reason: "idos_shop", refId: o.id },
      );
      const item: ShopItemDto = { id: moved.id, def: moved.defId, rarity: moved.rarity, dur: moved.durability };
      return { ok: true, detail: { item, message: "The crate is in your stash." } };
    }
    case "kit": {
      if (await pausedParam(tx, PARAM.KIT_SALE_PAUSED)) return { ok: false, code: "paused", message: REJECT_MESSAGES.paused };
      if ((await kitsBoughtToday(tx, userId, now)) >= STARTER_KIT.DAILY_MAX) {
        return { ok: false, code: "daily_limit", message: REJECT_MESSAGES.daily_limit };
      }
      const { itemIds } = await grantStarterKit(tx, userId, o.id, now, { rng: rng ?? mulberry32((Math.random() * 2 ** 32) >>> 0) });
      return { ok: true, detail: { itemIds, message: "The starter kit is in your stash." } };
    }
    case "credits": {
      const n = await tx.execute<{ n: number }>(sql`
        select count(*)::int as n from idos_orders
        where user_id = ${userId} and product = 'cr_pack' and status = 'delivered' and created_at >= ${utcDayStart(now).toISOString()}`);
      if (Number(n.rows[0]?.n ?? 0) >= IDOS_SHOP.CR_PACK_DAILY_MAX) return { ok: false, code: "daily_limit", message: REJECT_MESSAGES.daily_limit };
      const c = await credit(tx, userId, IDOS_SHOP.CR_PACK_CR, "idos_shop", `idos:${o.id}`);
      if (!c.ok) return { ok: false, code: "delivery_failed", message: "Your account could not be credited." };
      return { ok: true, detail: { credits: c.balance, message: `+${IDOS_SHOP.CR_PACK_CR.toLocaleString("en-US")} CR.` } };
    }
    case "donation": {
      const r = await tx.execute<{ reward_id: string }>(sql`
        insert into pass_unlocks (user_id, reward_id, source, at) values (${userId}, ${def.cosmetic!}, 'donation', ${now})
        on conflict do nothing returning reward_id`);
      const granted = r.rows.length > 0;
      return {
        ok: true,
        detail: {
          granted,
          message: granted ? `Thank you! The ${def.name} title is yours: equip it in Rewards.` : "Thank you for supporting SPOILS!",
        },
      };
    }
  }
}
