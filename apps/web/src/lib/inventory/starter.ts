import { sql } from "drizzle-orm";
import { GIVEAWAY, GIVEAWAY_KIT, itemDef, mulberry32, pickWeighted, type Rng } from "@extract/shared";
import { itemEvents, items, moneyLedger } from "../../db/schema";
import { credit } from "../economy/ledger";
import { giveawayLockRaids } from "../economy/config";
import type { Db, Tx } from "./db";
import { addStack } from "./transition";

/** Fungibles that come with the kit so the first raid is playable (ammo matches the weapon). */
const STARTER_STACKS: Record<string, Array<{ def: string; qty: number }>> = {
  rifle: [{ def: "ammo_light", qty: 90 }],
  shotgun: [{ def: "ammo_shell", qty: 30 }],
  common: [
    { def: "bandage", qty: 3 },
    { def: "medkit", qty: 1 },
  ],
};

export interface StarterRoll {
  weapon: { def: string; rarity: number };
  armor: { def: string; rarity: number };
  backpack: { def: string; rarity: number };
  stacks: Array<{ def: string; qty: number }>;
}

/** Pure kit roll from GIVEAWAY_KIT weights (testable with a seeded rng). */
export function rollStarterKit(rng: Rng): StarterRoll {
  const w = pickWeighted(rng, GIVEAWAY_KIT.weapon);
  const a = pickWeighted(rng, GIVEAWAY_KIT.armor);
  const b = pickWeighted(rng, GIVEAWAY_KIT.backpack);
  return {
    weapon: { def: w.def, rarity: w.rarity },
    armor: { def: a.def, rarity: itemDef(a.def)?.rarity ?? 0 },
    backpack: { def: b.def, rarity: itemDef(b.def)?.rarity ?? 0 },
    stacks: [...(STARTER_STACKS[w.def] ?? []), ...STARTER_STACKS.common!],
  };
}

export type StarterResult =
  | { status: "claimed"; itemIds: string[]; kit: StarterRoll; credits: number; bound: boolean; paidMinor: string }
  | { status: "already" }
  | { status: "no_user" }
  | { status: "sold_out" }
  | { status: "insufficient_funds"; priceMinor: string };

/** House account of the market money journal (lib/market/market.ts HOUSE_ACCOUNT). */
const HOUSE = "house";

/** Tradable giveaway kits issued so far (3 non-bound giveaway items per kit; items are never deleted). */
async function tradableKitsIssued(tx: Tx): Promise<number> {
  const r = await tx.execute<{ n: number }>(sql`select count(*)::int as n from items where origin = 'giveaway' and bound = false`);
  return Math.floor(Number(r.rows[0]?.n ?? 0) / 3);
}

/**
 * POST /api/stash/starter: one giveaway kit per account (economy memo §15.6). The claim stamp
 * `starter_claimed_at` is set by a guarded UPDATE … WHERE starter_claimed_at IS NULL, so two
 * concurrent clicks give one kit. Plus GIVEAWAY_KIT.cr credits.
 *
 * `paid: false` (default): the kit is BOUND and free: playable, never listable, destroyed instead of
 * entering the lost pool, 0 risk units. `paid: true`: the kit is TRADABLE (`giveaway` origin,
 * lock_raids 10 / demo 1, then listable) for GIVEAWAY.KIT_PRICE_MINOR from the market balance to the
 * house, while fewer than GIVEAWAY.KITS tradable kits exist (a transaction-scoped advisory lock keeps
 * the cap exact). Sold out or short of money → nothing is claimed, so the player can pick again.
 */
export async function claimStarter(
  db: Db,
  userId: string,
  opts: { paid?: boolean; rng?: Rng; lockRaids?: number; kitCap?: number; priceMinor?: bigint } = {},
): Promise<StarterResult> {
  const price = opts.priceMinor ?? BigInt(GIVEAWAY.KIT_PRICE_MINOR);
  return db.transaction(async (tx) => {
    const u = await tx.execute<{ balance_cents: string; claimed: boolean }>(
      sql`select balance_cents, starter_claimed_at is not null as claimed from users where id = ${userId} for update`,
    );
    const user = u.rows[0];
    if (!user) return { status: "no_user" } as const;
    if (user.claimed) return { status: "already" } as const;

    const bound = !opts.paid;
    if (opts.paid) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('giveaway_kits'))`);
      if ((await tradableKitsIssued(tx)) >= (opts.kitCap ?? GIVEAWAY.KITS)) return { status: "sold_out" } as const;
      if (BigInt(user.balance_cents) < price) return { status: "insufficient_funds", priceMinor: price.toString() } as const;
    }
    const stamp = await tx.execute(
      sql`update users set starter_claimed_at = now() where id = ${userId} and starter_claimed_at is null`,
    );
    if ((stamp.rowCount ?? 0) !== 1) return { status: "already" } as const;
    if (opts.paid && price > 0n) {
      await tx.execute(sql`update users set balance_cents = balance_cents - ${price} where id = ${userId}`);
      await tx.insert(moneyLedger).values([
        { account: userId, deltaMinor: -price, reason: "kit_buy", refId: "starter" },
        { account: HOUSE, deltaMinor: price, reason: "kit_sale", refId: userId },
      ]);
    }

    const kit = rollStarterKit(opts.rng ?? mulberry32((Math.random() * 2 ** 32) >>> 0));
    const lockRaids = bound ? 0 : (opts.lockRaids ?? giveawayLockRaids());
    const rows = await tx
      .insert(items)
      .values(
        [kit.weapon, kit.armor, kit.backpack].map((k) => ({
          defId: k.def,
          rarity: k.rarity,
          durability: 100,
          maxDurability: 100,
          state: "in_stash" as const,
          ownerId: userId,
          origin: "giveaway" as const,
          lockRaids,
          bound,
        })),
      )
      .returning({ id: items.id });
    await tx.insert(itemEvents).values(
      rows.map((r) => ({ itemId: r.id, toState: "in_stash" as const, toOwner: userId, reason: "grant", refId: "starter" })),
    );
    for (const s of kit.stacks) await addStack(tx, userId, s.def, s.qty);
    const c = await credit(tx, userId, GIVEAWAY_KIT.cr, "giveaway", "starter");
    return { status: "claimed", itemIds: rows.map((r) => r.id), kit, credits: c.ok ? c.balance : 0, bound, paidMinor: (opts.paid ? price : 0n).toString() } as const;
  });
}
