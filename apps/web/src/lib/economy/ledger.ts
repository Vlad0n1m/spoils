import { sql } from "drizzle-orm";
import { creditLedger } from "../../db/schema";
import type { Tx } from "../inventory/db";

/** credit_ledger.reason values in use (free text in the DB so new sinks need no migration). */
export type CreditReason =
  | "autosell"
  | "giveaway"
  | "consumables"
  | "bound"
  | "listing_fee"
  | "admin";

export type CreditResult =
  | { ok: true; applied: boolean; balance: number }
  | { ok: false; code: "insufficient_credits" | "no_user"; balance: number };

/**
 * Applies one CR change exactly once: UNIQUE(user, reason, ref) turns a replay into a no-op
 * (`applied: false`). A debit that would take the balance below zero is refused before anything
 * is written. Must run inside the caller's transaction so the ledger row and the balance commit
 * together.
 */
export async function credit(
  tx: Tx,
  userId: string,
  delta: number,
  reason: CreditReason,
  refId: string,
): Promise<CreditResult> {
  if (!Number.isSafeInteger(delta)) throw new Error(`credit: delta must be an integer, got ${delta}`);
  // Lock the user row first: concurrent credits for one user serialize here, so the
  // non-negative check below cannot race.
  const u = await tx.execute<{ credits: string }>(
    sql`select credits from users where id = ${userId} for update`,
  );
  const row = u.rows[0];
  if (!row) return { ok: false, code: "no_user", balance: 0 };
  const before = Number(row.credits);

  const existing = await tx.execute<{ balance_after: string }>(
    sql`select balance_after from credit_ledger where user_id = ${userId} and reason = ${reason} and ref_id = ${refId}`,
  );
  if (existing.rows[0]) return { ok: true, applied: false, balance: before };

  const after = before + delta;
  if (after < 0) return { ok: false, code: "insufficient_credits", balance: before };

  await tx.insert(creditLedger).values({ userId, delta, reason, refId, balanceAfter: after });
  await tx.execute(sql`update users set credits = ${after} where id = ${userId}`);
  return { ok: true, applied: true, balance: after };
}
