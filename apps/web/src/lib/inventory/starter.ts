import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { STARTER_KIT, itemDef, mulberry32, pickWeighted, type Rng } from "@extract/shared";
import { itemEvents, items, moneyLedger } from "../../db/schema";
import { giveawayLockRaids } from "../economy/config";
import { PARAM, pausedParam } from "../economy/params";
import type { Db, Tx } from "./db";
import { addStack } from "./transition";

export interface StarterRoll {
  /** Every unique of the kit: the pistols, then the armor. */
  uniques: Array<{ def: string; rarity: number }>;
  stacks: Array<{ def: string; qty: number }>;
}

/** Pure kit roll from STARTER_KIT (testable with a seeded rng): fixed pistols, rolled armor. */
export function rollStarterKit(rng: Rng): StarterRoll {
  const a = pickWeighted(rng, STARTER_KIT.armor);
  return {
    uniques: [
      ...STARTER_KIT.weapons.map((w) => ({ def: w.def, rarity: w.rarity })),
      { def: a.def, rarity: itemDef(a.def)?.rarity ?? 0 },
    ],
    stacks: STARTER_KIT.stacks.map((s) => ({ def: s.def, qty: s.qty })),
  };
}

export type StarterResult =
  | { status: "bought"; purchaseId: string; itemIds: string[]; kit: StarterRoll; paidMinor: string; boughtToday: number }
  | { status: "no_user" }
  /** The admin paused kit sales (economy_params kit_sale_paused). */
  | { status: "sale_paused" }
  | { status: "daily_limit"; dailyMax: number }
  | { status: "insufficient_funds"; priceMinor: string };

/** House account of the market money journal (lib/market/market.ts HOUSE_ACCOUNT). */
const HOUSE = "house";

/** Start of the UTC day of `now`. */
function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Kits this user bought since the start of the UTC day: money_ledger kit_buy rows (market balance)
 * plus wallet payments in flight or done (onchain_ops kit, lib/onchain) plus kits delivered by the iDos
 * edition's SPOILS shop (idos_orders starter_kit, lib/idos/shop.ts): one daily cap however the kit
 * was paid.
 */
export async function kitsBoughtToday(db: Db | Tx, userId: string, now = new Date()): Promise<number> {
  const since = utcDayStart(now).toISOString();
  const r = await db.execute<{ n: number }>(
    sql`select (
          (select count(*) from money_ledger where account = ${userId} and reason = 'kit_buy' and at >= ${since})
          + (select count(*) from onchain_ops where user_id = ${userId} and action = 'kit'
               and status in ('sent', 'done') and created_at >= ${since})
          + (select count(*) from idos_orders where user_id = ${userId} and product = 'starter_kit'
               and status = 'delivered' and created_at >= ${since})
        )::int as n`,
  );
  return Number(r.rows[0]?.n ?? 0);
}

/**
 * POST /api/stash/starter: buy one starter kit (design §19, Vlad 04.10: always paid). The price goes
 * from the market balance to the house in one money_ledger pair (kit_buy / kit_sale, refId = the
 * purchase id) — treasury revenue; nothing ever flows back. Up to STARTER_KIT.DAILY_MAX kits per
 * account per UTC day, counted under the user's row lock so concurrent clicks cannot exceed it.
 * The uniques are tradable `giveaway` items with the trade lock (lock_raids 10 / demo 1); no CR.
 * users.starter_claimed_at is stamped on the first kit only (kept for stats; it gates nothing).
 */
export async function buyStarterKit(
  db: Db,
  userId: string,
  opts: { rng?: Rng; lockRaids?: number; priceMinor?: bigint; dailyMax?: number; now?: Date } = {},
): Promise<StarterResult> {
  const price = opts.priceMinor ?? BigInt(STARTER_KIT.PRICE_MINOR);
  const dailyMax = opts.dailyMax ?? STARTER_KIT.DAILY_MAX;
  const now = opts.now ?? new Date();
  // Admin stop-crane (/admin/params): nothing is charged or granted.
  if (await pausedParam(db, PARAM.KIT_SALE_PAUSED)) return { status: "sale_paused" };
  return db.transaction(async (tx) => {
    const u = await tx.execute<{ balance_cents: string }>(sql`select balance_cents from users where id = ${userId} for update`);
    const user = u.rows[0];
    if (!user) return { status: "no_user" } as const;
    const today = await kitsBoughtToday(tx, userId, now);
    if (today >= dailyMax) return { status: "daily_limit", dailyMax } as const;
    if (BigInt(user.balance_cents) < price) return { status: "insufficient_funds", priceMinor: price.toString() } as const;

    const purchaseId = randomUUID();
    if (price > 0n) {
      await tx.execute(sql`update users set balance_cents = balance_cents - ${price} where id = ${userId}`);
      await tx.insert(moneyLedger).values([
        { account: userId, deltaMinor: -price, reason: "kit_buy", refId: purchaseId, at: now },
        { account: HOUSE, deltaMinor: price, reason: "kit_sale", refId: purchaseId, at: now },
      ]);
    }
    const { kit, itemIds } = await grantStarterKit(tx, userId, purchaseId, now, opts);
    return {
      status: "bought",
      purchaseId,
      itemIds,
      kit,
      paidMinor: price.toString(),
      boughtToday: today + 1,
    } as const;
  });
}

/**
 * Puts one rolled kit into the stash (shared by the market-balance purchase above and the wallet
 * payment in lib/onchain): tradable `giveaway` uniques with the trade lock, the stacks, and the
 * first-kit stamp. Runs inside the caller's transaction.
 */
export async function grantStarterKit(
  tx: Tx,
  userId: string,
  purchaseId: string,
  now: Date,
  opts: { rng?: Rng; lockRaids?: number } = {},
): Promise<{ kit: StarterRoll; itemIds: string[] }> {
  await tx.execute(sql`update users set starter_claimed_at = ${now.toISOString()} where id = ${userId} and starter_claimed_at is null`);

  const kit = rollStarterKit(opts.rng ?? mulberry32((Math.random() * 2 ** 32) >>> 0));
  const lockRaids = opts.lockRaids ?? giveawayLockRaids();
  const rows = await tx
    .insert(items)
    .values(
      kit.uniques.map((k) => ({
        defId: k.def,
        rarity: k.rarity,
        durability: 100,
        maxDurability: 100,
        state: "in_stash" as const,
        ownerId: userId,
        origin: "giveaway" as const,
        lockRaids,
        bound: false,
      })),
    )
    .returning({ id: items.id });
  await tx.insert(itemEvents).values(
    rows.map((r) => ({ itemId: r.id, toState: "in_stash" as const, toOwner: userId, reason: "grant", refId: `kit:${purchaseId}` })),
  );
  for (const s of kit.stacks) await addStack(tx, userId, s.def, s.qty);
  return { kit, itemIds: rows.map((r) => r.id) };
}
