import { sql } from "drizzle-orm";
import { CONSUMABLES_CR, boundOffer, boundTraderLevel, itemDef, type ConsumableId } from "@extract/shared";
import { itemEvents, items } from "../../db/schema";
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

export type BoundBuyResult =
  | { ok: true; applied: boolean; credits: number; itemId: string | null; def: string }
  | { ok: false; code: "bad_item" | "trader_level" | "insufficient_credits" | "no_user" | "bad_request" };

/**
 * Bound gear for CR (BOUND_OFFERS, v5 review): debits the offer's CR and adds one BOUND unique
 * (origin "trader", full durability) to the stash in one transaction. Bound = never listable, never
 * enters the lost pool (destroyed instead), 0 risk units: a CR sink that can never become SOL value.
 * The offer's traderLevel must be unlocked by the player level (boundTraderLevel). `requestId` is
 * the idempotency key (credit ledger UNIQUE(user, "bound", ref)): a double click charges and
 * delivers once (the replay returns itemId null).
 */
export async function buyBound(db: Db, userId: string, def: string, requestId: string): Promise<BoundBuyResult> {
  const offer = boundOffer(def);
  const d = itemDef(def);
  if (!offer || !d?.unique) return { ok: false, code: "bad_item" };
  if (!isUuid(requestId)) return { ok: false, code: "bad_request" };
  return db.transaction(async (tx) => {
    const u = await tx.execute<{ level: number }>(sql`select level from users where id = ${userId} for update`);
    if (!u.rows[0]) return { ok: false, code: "no_user" } as const;
    if (offer.traderLevel > boundTraderLevel(Number(u.rows[0].level))) return { ok: false, code: "trader_level" } as const;
    const c = await credit(tx, userId, -offer.cr, "bound", `bound:${requestId}`);
    if (!c.ok) return { ok: false, code: c.code } as const;
    let itemId: string | null = null;
    if (c.applied) {
      const [row] = await tx
        .insert(items)
        .values({
          defId: def,
          rarity: offer.rarity,
          durability: 100,
          maxDurability: 100,
          state: "in_stash",
          ownerId: userId,
          origin: "trader",
          lockRaids: 0,
          bound: true,
        })
        .returning({ id: items.id });
      itemId = row!.id;
      await tx.insert(itemEvents).values({ itemId, toState: "in_stash", toOwner: userId, reason: "grant", refId: `bound:${requestId}` });
    }
    return { ok: true, applied: c.applied, credits: c.balance, itemId, def } as const;
  });
}
