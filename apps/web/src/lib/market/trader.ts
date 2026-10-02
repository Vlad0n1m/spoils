import { sql } from "drizzle-orm";
import { CONSUMABLES_CR, type ConsumableId } from "@extract/shared";
import { credit } from "../economy/ledger";
import type { Db } from "../inventory/db";
import { addStack, isUuid } from "../inventory/transition";

/** Packs per purchase: enough for a full backpack of ammo, small enough that a misclick is cheap. */
export const MAX_PACKS = 20;

export function isConsumableId(v: string): v is ConsumableId {
  return Object.prototype.hasOwnProperty.call(CONSUMABLES_CR, v);
}

export type JunkerBuyResult =
  | { ok: true; applied: boolean; credits: number; qty: number; def: ConsumableId }
  | { ok: false; code: "bad_item" | "bad_qty" | "insufficient_credits" | "no_user" | "bad_request" };

/**
 * Junker shop (critique cut 2: consumables only). Debits CR and adds the stack in one
 * transaction. `requestId` is the client's idempotency key: the credit ledger is
 * UNIQUE(user, "consumables", ref), so a double-submitted click charges and delivers once.
 */
export async function buyConsumables(
  db: Db,
  userId: string,
  def: string,
  packs: number,
  requestId: string,
): Promise<JunkerBuyResult> {
  if (!isConsumableId(def)) return { ok: false, code: "bad_item" };
  if (!Number.isInteger(packs) || packs < 1 || packs > MAX_PACKS) return { ok: false, code: "bad_qty" };
  if (!isUuid(requestId)) return { ok: false, code: "bad_request" };
  const offer = CONSUMABLES_CR[def];
  return db.transaction(async (tx) => {
    const c = await credit(tx, userId, -offer.cr * packs, "consumables", `junker:${requestId}`);
    if (!c.ok) return { ok: false, code: c.code } as const;
    if (c.applied) await addStack(tx, userId, def, offer.qty * packs);
    const s = await tx.execute<{ qty: number }>(
      sql`select qty from stash_stacks where user_id = ${userId} and def_id = ${def}`,
    );
    return { ok: true, applied: c.applied, credits: c.balance, qty: Number(s.rows[0]?.qty ?? 0), def } as const;
  });
}
