/**
 * Paying with SPOILS through the iDos Title store (docs/idos-token-research.md §3, "variant B").
 *
 * iDos keeps the token balance (crypto currency "Main") and offers no server API to debit it. Its
 * store does debit it, atomically, when the player buys an offer priced in Main. Our Title store has
 * two such offers in Fixed slots (lib/idos/shop-rules.ts IDOS_STORE): `pay_100k` and `pay_1k`, costing
 * exactly 100 000 and 1 000 SPOILS and granting a record-only virtual currency that nothing reads.
 * Our server calls `Store/Purchase` with the player's own session ticket, the way the SDK does
 * (POST {base}/api/v2/{TitleID}/Client/Store/Purchase/{UserID}, Bearer ticket), so iDos checks the
 * ticket on every payment: a wrong or expired ticket is refused by iDos itself.
 *
 * Trust: the only proof of payment is the purchase response's `Resources.Consume` (verified live,
 * 05.10: `{Success:true, Data:{OfferID, Count, Resources:{Consume:{Standard:{Entries:[{Type:
 * "CryptoCurrency", CurrencyID:"Main", Amount}]}}}}}`). iDos has no USD price for our token, so a price
 * option with an AmountUsd debits 0 and still answers Success: a Success alone proves nothing. A leg
 * counts as paid only when the Main debited equals exactly what we asked (Count × the offer's price);
 * anything else is a failed payment, and whatever Main it did take is recorded as owed back.
 *
 * Legs are paid biggest first, each with its own idempotency key (RelatedEntityID `${orderId}:100k`,
 * `${orderId}:1k`), so a retry of the same order after a network error re-sends the same keys instead
 * of paying twice. If the 1k leg fails after the 100k leg was taken, the order is `refund_owed`: we
 * deliver nothing and the paid amount is on record for a manual refund (there is no iDos API to give
 * SPOILS back, research §4).
 */
import { IDOS_API_BASE_DEFAULT } from "./verify";
import { IDOS_STORE, type PaymentLeg } from "./shop-rules";

export interface IdosPlayer {
  titleId: string;
  /** The iDos UserID (from users.idos_user_id, never from the client). */
  userId: string;
  /** The player's ClientSessionTicket, sent by our client for this call and never stored. */
  ticket: string;
}

export interface IdosCallOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

export type IdosCallResult =
  | { kind: "ok"; data: unknown }
  /** iDos answered Success:false (insufficient balance, unknown offer…), with its Error text. */
  | { kind: "refused"; error: string }
  /** 401 / 403: the ticket is wrong, expired or not this player's. */
  | { kind: "invalid_session" }
  /** Network error, timeout, 5xx or an unreadable body: the outcome is unknown. */
  | { kind: "unavailable" };

/** The request of one authenticated iDos Client API call (exported for tests). */
export function idosClientRequest(
  p: IdosPlayer,
  path: string,
  body: Record<string, unknown>,
  baseUrl: string = IDOS_API_BASE_DEFAULT,
): { url: string; init: RequestInit } {
  const base = baseUrl.replace(/\/+$/, "");
  return {
    url: `${base}/api/v2/${p.titleId}/Client/${path}/${encodeURIComponent(p.userId)}`,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${p.ticket}`,
        "X-IG-Platform": "Web",
      },
      body: JSON.stringify({ UserID: p.userId, ClientSessionTicket: p.ticket, ...body }),
      redirect: "error",
      cache: "no-store",
    },
  };
}

export async function callIdos(
  p: IdosPlayer,
  path: string,
  body: Record<string, unknown>,
  opts: IdosCallOptions = {},
): Promise<IdosCallResult> {
  const { url, init } = idosClientRequest(p, path, body, opts.baseUrl ?? (process.env.IDOS_API_BASE_URL?.trim() || undefined));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await (opts.fetchImpl ?? fetch)(url, { ...init, signal: ctrl.signal });
    if (res.status === 401 || res.status === 403) return { kind: "invalid_session" };
    const json = (await res.json().catch(() => null)) as { Success?: unknown; Error?: unknown; Data?: unknown } | null;
    if (json && typeof json === "object" && json.Success === true) return res.ok ? { kind: "ok", data: json.Data } : { kind: "unavailable" };
    // A 4xx with a readable refusal (iDos answers business errors as Success:false) is a refusal; a 5xx
    // or a body we cannot read leaves the outcome unknown.
    if (json && typeof json === "object" && json.Success === false && res.status < 500) {
      return { kind: "refused", error: typeof json.Error === "string" ? json.Error.slice(0, 300) : "refused" };
    }
    return { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}

/** The Store/Purchase body of one payment leg (exported for tests). */
export function purchaseBody(leg: PaymentLeg, relatedId: string): Record<string, unknown> {
  return {
    OfferID: leg.offerId,
    Count: leg.count,
    SelectedOptionID: IDOS_STORE.optionId,
    StoreID: IDOS_STORE.storeId,
    SectionID: IDOS_STORE.sectionId,
    SlotID: leg.offerId,
    RelatedEntityID: relatedId,
  };
}

/** Σ Main debited by a purchase response (`Data.Resources.Consume.Standard.Entries`), 0 when none. */
export function mainDebited(data: unknown): number {
  const entries = (data as { Resources?: { Consume?: { Standard?: { Entries?: unknown } } } } | null)?.Resources?.Consume?.Standard?.Entries;
  if (!Array.isArray(entries)) return 0;
  let sum = 0;
  for (const e of entries) {
    const x = e as { Type?: unknown; CurrencyID?: unknown; Amount?: unknown };
    if (x?.Type !== "CryptoCurrency" || x.CurrencyID !== IDOS_STORE.currencyId) continue;
    const n = Number(x.Amount);
    if (Number.isFinite(n) && n > 0) sum += n;
  }
  return sum;
}

export type LegCheck = { ok: true; debited: number } | { ok: false; debited: number; why: string };

/**
 * Whether a Success response really paid `leg`: the Main debited must be exactly leg.spoils, and the
 * OfferID / Count iDos echoes (when present) must be the ones we asked for. `debited` is what iDos
 * says it took either way (recorded as owed back when the check fails).
 */
export function checkLeg(data: unknown, leg: PaymentLeg): LegCheck {
  const debited = mainDebited(data);
  const d = (data ?? {}) as { OfferID?: unknown; Count?: unknown };
  if (d.OfferID !== undefined && d.OfferID !== leg.offerId) return { ok: false, debited, why: `offer ${String(d.OfferID)} instead of ${leg.offerId}` };
  if (d.Count !== undefined && Number(d.Count) !== leg.count) return { ok: false, debited, why: `count ${String(d.Count)} instead of ${leg.count}` };
  if (debited !== leg.spoils) return { ok: false, debited, why: `debited ${debited} SPOILS instead of ${leg.spoils}` };
  return { ok: true, debited };
}

export type PayFailCode = "insufficient_spoils" | "store_missing" | "invalid_session" | "refused" | "debit_mismatch";

/** Per-leg progress, kept in idos_orders.detail.legs so a retried order skips the legs already paid. */
export type LegProgress = Partial<Record<PaymentLeg["key"], { debited: number; ok: boolean }>>;

export type PayOutcome =
  | { status: "paid"; paid: number; legs: LegProgress }
  /** Nothing was taken: the order failed cleanly. */
  | { status: "failed"; code: PayFailCode; message: string; paid: 0; legs: LegProgress }
  /** Some SPOILS were taken but not the whole price (or not as asked): deliver nothing, owe it back. */
  | { status: "refund_owed"; code: PayFailCode; message: string; paid: number; legs: LegProgress }
  /** iDos did not answer a leg: the outcome is unknown. The order stays pending; retry the same order. */
  | { status: "unknown"; paid: number; legs: LegProgress; message: string };

/** The player-facing reason of an iDos refusal. */
export function refusalCode(error: string): PayFailCode {
  if (/insufficient/i.test(error)) return "insufficient_spoils";
  if (/offer|slot|section|store/i.test(error)) return "store_missing";
  return "refused";
}

export const PAY_MESSAGES: Record<PayFailCode, string> = {
  insufficient_spoils: "Not enough SPOILS on your iDos game balance.",
  store_missing:
    "This iDos title's store has no SPOILS offers (the -DEV copy has its own, empty store). The SPOILS shop works on the live title.",
  invalid_session: "Your iDos session has expired. Reload the game and sign in again.",
  refused: "iDos refused the payment.",
  debit_mismatch: "iDos did not take the expected amount of SPOILS.",
};

/**
 * Pays `legs` in order (skipping those `done` already holds as paid), stopping at the first leg that
 * does not verify. See the file comment for the states.
 */
export async function payLegs(
  p: IdosPlayer,
  orderId: string,
  legs: readonly PaymentLeg[],
  done: LegProgress = {},
  opts: IdosCallOptions = {},
): Promise<PayOutcome> {
  const progress: LegProgress = { ...done };
  const paidSoFar = () => Object.values(progress).reduce((s, l) => s + (l?.debited ?? 0), 0);
  const fail = (code: PayFailCode, message: string): PayOutcome => {
    const paid = paidSoFar();
    return paid > 0 ? { status: "refund_owed", code, message, paid, legs: progress } : { status: "failed", code, message, paid: 0, legs: progress };
  };
  for (const leg of legs) {
    if (progress[leg.key]?.ok) continue;
    const r = await callIdos(p, "Store/Purchase", purchaseBody(leg, `${orderId}:${leg.key}`), opts);
    if (r.kind === "unavailable") return { status: "unknown", paid: paidSoFar(), legs: progress, message: "iDos did not answer. Try again in a moment." };
    if (r.kind === "invalid_session") return fail("invalid_session", PAY_MESSAGES.invalid_session);
    if (r.kind === "refused") {
      const code = refusalCode(r.error);
      return fail(code, code === "refused" ? `${PAY_MESSAGES.refused} ${r.error}` : PAY_MESSAGES[code]);
    }
    const c = checkLeg(r.data, leg);
    progress[leg.key] = { debited: c.debited, ok: c.ok };
    if (!c.ok) return fail("debit_mismatch", `${PAY_MESSAGES.debit_mismatch} (${c.why})`);
  }
  return { status: "paid", paid: paidSoFar(), legs: progress };
}

export type BalanceResult = { ok: true; spoils: number } | { ok: false; reason: "invalid_session" | "unavailable" | "refused" };

/** `Data.CryptoBalances.Main.Amount` (a decimal string, absent when 0) of Blockchain/GetUserState. */
export function parseSpoilsBalance(data: unknown): number {
  const amount = (data as { CryptoBalances?: Record<string, { Amount?: unknown } | undefined> } | null)?.CryptoBalances?.[IDOS_STORE.currencyId]?.Amount;
  const n = Number(amount ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export async function readSpoilsBalance(p: IdosPlayer, opts: IdosCallOptions = {}): Promise<BalanceResult> {
  const r = await callIdos(p, "Blockchain/GetUserState", {}, opts);
  if (r.kind === "ok") return { ok: true, spoils: parseSpoilsBalance(r.data) };
  return { ok: false, reason: r.kind === "refused" ? "refused" : r.kind };
}
