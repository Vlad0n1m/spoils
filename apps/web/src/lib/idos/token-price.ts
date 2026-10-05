/**
 * The SPOILS token's US dollar price, for the iDos edition's SPOILS shop (lib/idos/shop-rules.ts sets
 * prices in cents and converts them at this price).
 *
 * Source: Jupiter's public price API, `GET https://lite-api.jup.ag/price/v3?ids=<mint>` →
 * `{ "<mint>": { "usdPrice": 0.0000036, ... } }` (a mint Jupiter cannot price is simply absent).
 * The mint is IDOS_TOKEN_MINT, by default the SPOILS mint launched through iDos.
 *
 * Caching: one fetch per PRICE_CACHE_MS (60 s) per process, whatever the traffic. A failed fetch keeps
 * the last good price, but only while it is younger than PRICE_MAX_AGE_MS (10 min): after that the
 * shop refuses to sell rather than sell at a price the market left long ago. Concurrent callers share
 * one in-flight request.
 */
import { IDOS_SHOP } from "./shop-rules";

export const DEFAULT_SPOILS_MINT = "2jWPc277xY4HQSnqNBJK9Md6YGaxQBwas3ofjJURidos";
export const JUPITER_PRICE_URL = "https://lite-api.jup.ag/price/v3";

/** Base58, 32–44 characters: anything else in the env is a typo, and the default is used instead. */
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function spoilsMint(env: string | undefined = process.env.IDOS_TOKEN_MINT): string {
  const m = env?.trim();
  return m && MINT_RE.test(m) ? m : DEFAULT_SPOILS_MINT;
}

export interface TokenPrice {
  /** US dollars per one SPOILS. */
  usd: number;
  /** When it was fetched (ms epoch). */
  at: number;
}

export interface TokenPriceOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  mint?: string;
  timeoutMs?: number;
}

/** Reads usdPrice of `mint` from a Jupiter v3 body; null unless it is a positive finite number. */
export function parseJupiterPrice(body: unknown, mint: string): number | null {
  if (!body || typeof body !== "object") return null;
  const entry = (body as Record<string, unknown>)[mint];
  if (!entry || typeof entry !== "object") return null;
  const v = Number((entry as { usdPrice?: unknown }).usdPrice);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** One fetch of the price; null on any failure (network, timeout, non-2xx, missing mint). */
export async function fetchTokenPrice(opts: TokenPriceOptions = {}): Promise<number | null> {
  const mint = opts.mint ?? spoilsMint();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 5000);
  try {
    const res = await (opts.fetchImpl ?? fetch)(`${JUPITER_PRICE_URL}?ids=${encodeURIComponent(mint)}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "error",
      cache: "no-store",
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return parseJupiterPrice(await res.json().catch(() => null), mint);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A cached price source (one per process in production, a fresh one per test). `get()` answers the
 * cached price while it is younger than PRICE_CACHE_MS, else refetches; on a failed refetch it keeps
 * the last good price until PRICE_MAX_AGE_MS, then answers null (no price: no sales).
 */
export function createTokenPriceSource(opts: TokenPriceOptions = {}) {
  const now = opts.now ?? Date.now;
  let last: TokenPrice | null = null;
  let inflight: Promise<TokenPrice | null> | null = null;

  const usable = (): TokenPrice | null => (last && now() - last.at <= IDOS_SHOP.PRICE_MAX_AGE_MS ? last : null);

  async function refresh(): Promise<TokenPrice | null> {
    const usd = await fetchTokenPrice(opts);
    if (usd !== null) last = { usd, at: now() };
    return usable();
  }

  return {
    async get(): Promise<TokenPrice | null> {
      if (last && now() - last.at < IDOS_SHOP.PRICE_CACHE_MS) return last;
      inflight ??= refresh().finally(() => {
        inflight = null;
      });
      return inflight;
    },
    /** The last good price without fetching (null when none or too old). */
    peek(): TokenPrice | null {
      return usable();
    },
  };
}

export type TokenPriceSource = ReturnType<typeof createTokenPriceSource>;

/** The process-wide source the API routes use. */
export const spoilsPrice: TokenPriceSource = createTokenPriceSource();
