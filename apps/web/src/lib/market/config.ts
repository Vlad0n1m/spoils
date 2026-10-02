import { MARKET, marketFeeMinor } from "@extract/shared";

/**
 * Market money display. Prices live in `users.balance_cents` minor units (critique "SOL/market
 * balance unit"); which real currency settles the market (SOL, USDC or iDos) is Vlad's call, so
 * the label is configuration, not code. Client-safe: only NEXT_PUBLIC_* is read here.
 */
export const MARKET_CURRENCY = {
  /** Placeholder label until the settlement currency is decided. */
  code: (process.env.NEXT_PUBLIC_MARKET_CURRENCY || "SOL").slice(0, 8),
  /** Minor units per whole unit: balance_cents is a hundredths ledger. */
  decimals: 2,
} as const;

const MINOR_PER_UNIT = 10n ** BigInt(MARKET_CURRENCY.decimals);
/** Upper bound on one listing price (1 000 000 whole units): keeps typos from creating absurd lots. */
export const MAX_PRICE_MINOR = 1_000_000n * MINOR_PER_UNIT;

/** "1250" minor → "12.50". Accepts bigint, decimal string or a safe number. */
export function minorToText(minor: bigint | string | number): string {
  let v: bigint;
  try {
    v = BigInt(minor);
  } catch {
    return "0." + "0".repeat(MARKET_CURRENCY.decimals);
  }
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = (abs / MINOR_PER_UNIT).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const frac = (abs % MINOR_PER_UNIT).toString().padStart(MARKET_CURRENCY.decimals, "0");
  return `${neg ? "−" : ""}${whole}.${frac}`;
}

/** "12.50 SOL". */
export function formatMinor(minor: bigint | string | number): string {
  return `${minorToText(minor)} ${MARKET_CURRENCY.code}`;
}

/**
 * Parses what a seller types ("12", "12.5", "12,50", " 0.05 ") into minor units. Returns null for
 * anything that is not a positive amount with at most `decimals` fraction digits: silently
 * rounding a price would sell an item for something the seller did not type.
 */
export function parsePriceToMinor(text: string): bigint | null {
  const t = text.trim().replace(",", ".");
  const m = /^(\d{1,9})(?:\.(\d*))?$/.exec(t);
  if (!m) return null;
  const frac = m[2] ?? "";
  if (frac.length > MARKET_CURRENCY.decimals) return null;
  const v = BigInt(m[1]!) * MINOR_PER_UNIT + BigInt(frac.padEnd(MARKET_CURRENCY.decimals, "0") || "0");
  return v > 0n && v <= MAX_PRICE_MINOR ? v : null;
}

/** What the seller receives for a sale at `price` with the given fee (rounded up for the house). */
export function saleBreakdown(price: bigint, feeBps: number): { fee: bigint; net: bigint } {
  const fee = marketFeeMinor(price, feeBps);
  return { fee, net: price - fee };
}

/** CR listing fee by rarity (not refunded on cancel or expiry). */
export function listingFeeCr(rarity: number): number {
  const i = Math.max(0, Math.min(MARKET.LISTING_FEE_CR.length - 1, Math.floor(rarity || 0)));
  return MARKET.LISTING_FEE_CR[i]!;
}
