/**
 * Seeker perk (docs/GAME_DESIGN.md §18g): a registered player whose linked wallet (lib/wallet, Sign-In
 * with Solana) holds a Seeker Genesis Token gets the "Seeker" badge next to their nickname (lobby,
 * party sheet, leaderboards) and may claim the Seeker Genesis frame once. Cosmetic only: no power,
 * no currency, nothing tradable.
 *
 * - getSeekerStatus (GET /api/seeker): the cached check of the linked wallet, refreshed on mainnet
 *   (sgt.ts findSgtMint) when older than SEEKER.CACHE_MS, or on request when older than
 *   SEEKER.REFRESH_MIN_MS. An RPC failure is never cached as "no SGT": the old answer stays and the
 *   DTO says `unavailable`.
 * - A positive check records the mint on this wallet and clears it on every other wallet (the SGT
 *   moved: the old holder loses the badge at once).
 * - claimSeekerFrame (POST /api/seeker): SEEKER_FRAME into pass_unlocks (source 'seeker'), once per
 *   SGT mint (seeker_claims primary key — the docs' anti-sybil rule: an SGT moved to another wallet
 *   cannot claim again) and once per account.
 *
 * Services take the database and the checker as parameters (tests use extract_test and fixtures).
 */
import { sql } from "drizzle-orm";
import { SEEKER_FRAME } from "@extract/shared";
import type { Db } from "../inventory/db";
import { findSgtMint } from "./sgt";
import type { SeekerDto } from "./types";

export const SEEKER = {
  /** A check is reused this long (both answers). */
  CACHE_MS: 6 * 60 * 60_000,
  /** "Check again" is honoured only when the last check is older than this. */
  REFRESH_MIN_MS: 60_000,
} as const;

/** Finds the SGT mint a wallet holds now (null = none); throws when the chain cannot be read. */
export type SgtChecker = (wallet: string) => Promise<string | null>;

type Q = Pick<Db, "execute">;

type CheckRow = { wallet: string; sgt_mint: string | null; checked_at: Date | string };

const ms = (v: Date | string): number => (v instanceof Date ? v.getTime() : new Date(v).getTime());

/** One RPC check per wallet at a time (two tabs polling at once share it). */
const inFlight = new Map<string, Promise<string | null>>();

function checkOnce(wallet: string, check: SgtChecker): Promise<string | null> {
  const running = inFlight.get(wallet);
  if (running) return running;
  const p = check(wallet).finally(() => inFlight.delete(wallet));
  inFlight.set(wallet, p);
  return p;
}

async function linkedWallet(q: Q, userId: string): Promise<string | null> {
  const r = await q.execute<{ wallet_pubkey: string | null }>(sql`select wallet_pubkey from users where id = ${userId}`);
  return r.rows[0]?.wallet_pubkey ?? null;
}

async function cachedCheck(q: Q, wallet: string): Promise<CheckRow | null> {
  const r = await q.execute<CheckRow>(sql`select wallet, sgt_mint, checked_at from seeker_checks where wallet = ${wallet}`);
  return r.rows[0] ?? null;
}

/** Stores a fresh answer; a held mint is cleared on every other wallet (it moved here). */
export async function recordSeekerCheck(db: Db, wallet: string, mint: string | null, now: Date): Promise<void> {
  await db.transaction(async (tx) => {
    if (mint) await tx.execute(sql`update seeker_checks set sgt_mint = null where sgt_mint = ${mint} and wallet <> ${wallet}`);
    await tx.execute(sql`
      insert into seeker_checks (wallet, sgt_mint, checked_at) values (${wallet}, ${mint}, ${now})
      on conflict (wallet) do update set sgt_mint = excluded.sgt_mint, checked_at = excluded.checked_at`);
  });
}

async function claimOf(q: Q, userId: string): Promise<{ claimed: boolean; mintClaimedByOther: (mint: string) => Promise<boolean> }> {
  const r = await q.execute<{ n: number }>(sql`
    select count(*)::int as n from pass_unlocks where user_id = ${userId} and reward_id = ${SEEKER_FRAME}`);
  return {
    claimed: Number(r.rows[0]?.n ?? 0) > 0,
    mintClaimedByOther: async (mint) => {
      const c = await q.execute<{ user_id: string }>(sql`select user_id from seeker_claims where sgt_mint = ${mint}`);
      const by = c.rows[0]?.user_id;
      return by !== undefined && String(by).toLowerCase() !== userId.toLowerCase();
    },
  };
}

export interface SeekerStatusOpts {
  check?: SgtChecker;
  now?: Date;
  /** The player pressed "Check again". */
  refresh?: boolean;
}

/** The caller's Seeker state; checks mainnet when the cache is stale (see SEEKER). */
export async function getSeekerStatus(db: Db, userId: string, opts: SeekerStatusOpts = {}): Promise<SeekerDto> {
  const now = opts.now ?? new Date();
  const check = opts.check ?? ((w: string) => findSgtMint(w));
  const wallet = await linkedWallet(db, userId);
  const base: SeekerDto = { wallet, verified: false, mint: null, checkedAt: null, claimed: false, claimable: false, reward: SEEKER_FRAME, unavailable: false };
  const claim = await claimOf(db, userId);
  base.claimed = claim.claimed;
  if (!wallet) return base;

  let row = await cachedCheck(db, wallet);
  const age = row ? now.getTime() - ms(row.checked_at) : Number.POSITIVE_INFINITY;
  const stale = age >= SEEKER.CACHE_MS || (opts.refresh === true && age >= SEEKER.REFRESH_MIN_MS);
  if (stale) {
    try {
      const mint = await checkOnce(wallet, check);
      await recordSeekerCheck(db, wallet, mint, now);
      row = { wallet, sgt_mint: mint, checked_at: now };
    } catch (e) {
      console.warn("[seeker] SGT check failed", e instanceof Error ? e.message : e);
      base.unavailable = true;
    }
  }
  if (!row) return base;
  const mint = row.sgt_mint;
  return {
    ...base,
    verified: mint !== null,
    mint,
    checkedAt: new Date(ms(row.checked_at)).toISOString(),
    claimable: mint !== null && !claim.claimed && !(await claim.mintClaimedByOther(mint)),
  };
}

export type ClaimSeekerResult =
  | { ok: true; status: SeekerDto }
  | { ok: false; error: "no_wallet" | "not_verified" | "already_claimed" | "mint_used" | "unavailable" };

/**
 * Grants SEEKER_FRAME once. Re-checks the chain when the cached answer is stale (getSeekerStatus), so
 * a claim never rests on an answer older than SEEKER.CACHE_MS.
 */
export async function claimSeekerFrame(db: Db, userId: string, opts: Omit<SeekerStatusOpts, "refresh"> = {}): Promise<ClaimSeekerResult> {
  const now = opts.now ?? new Date();
  const s = await getSeekerStatus(db, userId, { ...opts, now });
  if (!s.wallet) return { ok: false, error: "no_wallet" };
  if (s.claimed) return { ok: false, error: "already_claimed" };
  if (!s.verified || !s.mint) return { ok: false, error: s.unavailable ? "unavailable" : "not_verified" };
  const wallet = s.wallet;
  const mint = s.mint;

  const r = await db.transaction(async (tx): Promise<"ok" | "mint_used" | "already_claimed"> => {
    // The users row first, like every other writer of pass_unlocks (lib/pass lock order).
    await tx.execute(sql`select id from users where id = ${userId} for update`);
    const ins = await tx.execute(sql`
      insert into seeker_claims (sgt_mint, user_id, wallet, at) values (${mint}, ${userId}, ${wallet}, ${now})
      on conflict (sgt_mint) do nothing
      returning sgt_mint`);
    if (ins.rows.length === 0) return "mint_used";
    const g = await tx.execute(sql`
      insert into pass_unlocks (user_id, reward_id, source, at) values (${userId}, ${SEEKER_FRAME}, 'seeker', ${now})
      on conflict (user_id, reward_id) do nothing
      returning reward_id`);
    if (g.rows.length === 0) throw new AlreadyClaimed();
    return "ok";
  }).catch((e: unknown) => {
    if (e instanceof AlreadyClaimed) return "already_claimed" as const;
    throw e;
  });
  if (r !== "ok") return { ok: false, error: r };
  return { ok: true, status: { ...s, claimed: true, claimable: false } };
}

/** Rolls the claim transaction back when the account already owns the frame (no mint is used up). */
class AlreadyClaimed extends Error {}

/**
 * SQL: the user row `u` (users alias) has a linked wallet whose last check found an SGT. For the
 * badge in party and leaderboard queries; a stale positive keeps showing until the owner's next
 * check (the mint is cleared when it shows up on another wallet).
 */
export const SEEKER_BADGE_SQL = sql`exists (select 1 from seeker_checks sc where sc.wallet = u.wallet_pubkey and sc.sgt_mint is not null)`;
