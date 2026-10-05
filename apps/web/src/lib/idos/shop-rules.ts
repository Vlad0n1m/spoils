/**
 * The iDos edition's SPOILS shop: every number and every pure rule in one place (docs/IDOS_EDITION.md
 * §3.5, "SPOILS shop"). Client-safe: the lobby's SPOILS tab reads the product names from here, the
 * server (lib/idos/shop.ts) the prices and limits.
 *
 * Why this shape. The SPOILS token lives in the player's custodial iDos balance (crypto currency
 * "Main" of the Title, docs/idos-token-research.md §2–3). iDos has no server API to debit it, but its
 * store can: our Title store has two fixed-price offers, `pay_1k` and `pay_100k`, costing exactly
 * 1 000 and 100 000 SPOILS and granting a record-only virtual currency. Our server buys `a × pay_100k +
 * b × pay_1k` with the player's own ticket, checks what iDos says it debited, and only then delivers
 * in our database. So every price is a whole multiple of 1 000 SPOILS, and at most 100 of each offer
 * per purchase (the store's Count limit).
 *
 * Prices are set in US cents, not in SPOILS: the token's dollar price moves, and a crate should cost
 * the player about the same real value whatever the token does. Each quote converts cents to SPOILS at
 * the live Jupiter price (lib/idos/token-price.ts) and rounds UP to the next 1 000, so rounding never
 * undercharges. Every product stays between 1¢ and $1: small, impulse-sized, never a big-ticket sale.
 */

/** The fixed payment offers of the Title store (storefront "spoils", section "pay", Fixed slots). */
export const IDOS_STORE = {
  storeId: "spoils",
  sectionId: "pay",
  /** The PriceOptions key of both offers (the SPOILS price). */
  optionId: "spoils",
  /** Offer (and slot) ids with their exact SPOILS price, biggest first: the order we pay them in. */
  offers: [
    { id: "pay_100k", spoils: 100_000 },
    { id: "pay_1k", spoils: 1_000 },
  ],
  /** iDos Store/Purchase accepts Count 1..100. */
  maxCount: 100,
  /** The Title's crypto currency id of the SPOILS token. */
  currencyId: "Main",
} as const;

/** The smallest payable step: every SPOILS price is a multiple of the smallest offer. */
export const SPOILS_STEP = IDOS_STORE.offers[IDOS_STORE.offers.length - 1]!.spoils;
/** The largest payable amount: 100 × 100 000 + 99 × 1 000 (a 100th 1k payment would be a 100k one). */
export const SPOILS_MAX_PAYABLE = IDOS_STORE.maxCount * 100_000 + (100_000 / SPOILS_STEP - 1) * SPOILS_STEP;

export const IDOS_SHOP = {
  /** Every product price after dynamics, in US cents. */
  MIN_CENTS: 1,
  MAX_CENTS: 100,
  /** Token price: refetched after 60 s; no purchase on a price older than 10 minutes. */
  PRICE_CACHE_MS: 60_000,
  PRICE_MAX_AGE_MS: 10 * 60_000,
  /** Crates: the pool stock (items of that rarity in the lost pool) the base price is set for. */
  CRATE_TARGET_STOCK: 40,
  /** scarcity = clamp(sqrt(TARGET / stock), 0.8, 1.5): a thin pool costs more, a fat one a bit less. */
  SCARCITY_MIN: 0.8,
  SCARCITY_MAX: 1.5,
  /** demand = min(1.5, 1 + 0.02 × crates of that kind sold in the last 24 h). */
  DEMAND_STEP: 0.02,
  DEMAND_MAX: 1.5,
  DEMAND_WINDOW_MS: 24 * 60 * 60_000,
  /** A crate never takes the last 5 items of its rarity from the pool (the total floor is POOL.MIN_RESERVE). */
  CRATE_MIN_PER_RARITY: 5,
  /** A crate item must ride 3 raids before it can be listed: bought gear is for playing, not flipping. */
  CRATE_LOCK_RAIDS: 3,
  /** CR pack: +2 000 CR, at most 5 per player per UTC day. */
  CR_PACK_CR: 2_000,
  CR_PACK_DAILY_MAX: 5,
  /** Buy calls per player: 10 at once, then one every 6 s (10 a minute). */
  BUY_BURST: 10,
  BUY_REFILL_MS: 6_000,
} as const;

export type ShopProductKind = "crate" | "kit" | "credits" | "donation";

export interface ShopProductDef {
  id: string;
  kind: ShopProductKind;
  /** Base price in US cents (crates move from it with scarcity and demand; the rest are fixed). */
  usdCents: number;
  name: string;
  blurb: string;
  /** Crates: the item rarity drawn from the lost pool (0 common, 1 rare, 2 epic; legendary is never sold). */
  rarity?: 0 | 1 | 2;
  /** Donations: the title cosmetic granted once (@extract/shared COSMETICS, grant "donation"). */
  cosmetic?: string;
}

export const IDOS_PRODUCTS: readonly ShopProductDef[] = [
  {
    id: "crate_common",
    kind: "crate",
    usdCents: 5,
    rarity: 0,
    name: "Common supply crate",
    blurb: "A random common item recovered from the lost pool. Tradable after 3 raids.",
  },
  {
    id: "crate_rare",
    kind: "crate",
    usdCents: 15,
    rarity: 1,
    name: "Rare supply crate",
    blurb: "A random rare item recovered from the lost pool. Tradable after 3 raids.",
  },
  {
    id: "crate_epic",
    kind: "crate",
    usdCents: 40,
    rarity: 2,
    name: "Epic supply crate",
    blurb: "A random epic item recovered from the lost pool. Tradable after 3 raids.",
  },
  {
    id: "starter_kit",
    kind: "kit",
    usdCents: 10,
    name: "Starter kit",
    blurb: "Two pistols, armor, ammo and meds. Up to 3 kits a day.",
  },
  {
    id: "cr_pack",
    kind: "credits",
    usdCents: 5,
    name: "Credit pack",
    blurb: "+2,000 CR for the traders. Up to 5 packs a day.",
  },
  {
    id: "supporter",
    kind: "donation",
    usdCents: 25,
    cosmetic: "supporter",
    name: "Supporter",
    blurb: "Tip the developers. Unlocks the Supporter title.",
  },
  {
    id: "patron",
    kind: "donation",
    usdCents: 100,
    cosmetic: "patron",
    name: "Patron",
    blurb: "Back the developers. Unlocks the Patron title.",
  },
];

export function shopProduct(id: unknown): ShopProductDef | null {
  return typeof id === "string" ? (IDOS_PRODUCTS.find((p) => p.id === id) ?? null) : null;
}

/** A price in cents held inside [MIN_CENTS, MAX_CENTS] and made whole. */
export function clampCents(c: number): number {
  if (!Number.isFinite(c)) return IDOS_SHOP.MAX_CENTS;
  return Math.max(IDOS_SHOP.MIN_CENTS, Math.min(IDOS_SHOP.MAX_CENTS, Math.round(c)));
}

/** clamp(sqrt(TARGET / stock), 0.8, 1.5); an empty pool is the most scarce (1.5). */
export function crateScarcity(stock: number): number {
  const s = Math.max(0, Math.floor(stock));
  if (s === 0) return IDOS_SHOP.SCARCITY_MAX;
  return Math.max(IDOS_SHOP.SCARCITY_MIN, Math.min(IDOS_SHOP.SCARCITY_MAX, Math.sqrt(IDOS_SHOP.CRATE_TARGET_STOCK / s)));
}

/** min(1.5, 1 + 0.02 × crates of that kind sold in the last 24 h). */
export function crateDemand(sold24h: number): number {
  return Math.min(IDOS_SHOP.DEMAND_MAX, 1 + IDOS_SHOP.DEMAND_STEP * Math.max(0, Math.floor(sold24h)));
}

/** A crate's price now: base × scarcity × demand, rounded to whole cents and clamped to [1, 100]. */
export function crateCents(baseCents: number, stock: number, sold24h: number): number {
  return clampCents(baseCents * crateScarcity(stock) * crateDemand(sold24h));
}

/**
 * Cents → SPOILS at `usdPerSpoils`, rounded UP to a multiple of SPOILS_STEP (1 000) and never below
 * one step. Null when the price is not a positive finite number or the amount cannot be paid with
 * the two offers (above SPOILS_MAX_PAYABLE: the token would have to be worth almost nothing). The
 * tiny epsilon keeps an exact multiple (e.g. 13 000.000000001 from float division) from jumping a
 * whole step.
 */
export function spoilsForCents(cents: number, usdPerSpoils: number): number | null {
  if (!(usdPerSpoils > 0) || !Number.isFinite(usdPerSpoils) || !(cents > 0)) return null;
  const raw = cents / 100 / usdPerSpoils;
  const steps = Math.max(1, Math.ceil(raw / SPOILS_STEP - 1e-9));
  const amount = steps * SPOILS_STEP;
  return Number.isSafeInteger(amount) && amount <= SPOILS_MAX_PAYABLE ? amount : null;
}

/** SPOILS per US cent at `usdPerSpoils` (display only: "1¢ ≈ 2,750 SPOILS"). */
export function spoilsPerCent(usdPerSpoils: number): number {
  return usdPerSpoils > 0 && Number.isFinite(usdPerSpoils) ? 0.01 / usdPerSpoils : 0;
}

export interface PaymentLeg {
  offerId: string;
  /** Store/Purchase Count, 1..100. */
  count: number;
  /** count × the offer's price: what iDos must report as debited. */
  spoils: number;
  /** Suffix of the leg's RelatedEntityID (`${orderId}:${key}`), iDos' idempotency key. */
  key: "100k" | "1k";
}

/**
 * `amount` as `a × pay_100k + b × pay_1k` (biggest first, legs with count 0 left out). Null when the
 * amount is not a positive multiple of 1 000 or needs more than 100 of an offer.
 */
export function decomposeSpoils(amount: number): PaymentLeg[] | null {
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount % SPOILS_STEP !== 0) return null;
  const a = Math.floor(amount / 100_000);
  const b = (amount - a * 100_000) / 1_000;
  if (a > IDOS_STORE.maxCount || b > IDOS_STORE.maxCount) return null;
  const legs: PaymentLeg[] = [];
  if (a > 0) legs.push({ offerId: "pay_100k", count: a, spoils: a * 100_000, key: "100k" });
  if (b > 0) legs.push({ offerId: "pay_1k", count: b, spoils: b * 1_000, key: "1k" });
  return legs;
}

/** "$0.05". */
export function formatUsdCents(cents: number): string {
  return `$${(Math.max(0, Math.round(cents)) / 100).toFixed(2)}`;
}

/** "13,000". */
export function formatSpoils(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** Where to get SPOILS (Jupiter, SOL → SPOILS) and where the client says to deposit them. */
export const SPOILS_SWAP_URL = "https://jup.ag/swap/SOL-2jWPc277xY4HQSnqNBJK9Md6YGaxQBwas3ofjJURidos";
