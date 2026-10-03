import { sql } from "drizzle-orm";
import { GIVEAWAY, GIVEAWAY_KIT, itemDef, mulberry32, pickWeighted, type Rng } from "@extract/shared";
import { itemEvents, items } from "../../db/schema";
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
  | { status: "claimed"; itemIds: string[]; kit: StarterRoll; credits: number; bound: boolean }
  | { status: "already" }
  | { status: "no_user" };

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
 * v5 review (sybil kits → SOL): the kit is TRADABLE (`giveaway` origin, lock_raids 10 / demo 1, then
 * listable) only while fewer than GIVEAWAY.KITS tradable kits exist and the account deposited at
 * least GIVEAWAY.MIN_DEPOSIT_MINOR (confirmed / swept); a transaction-scoped advisory lock keeps the
 * cap exact under concurrent claims. Otherwise the same kit is BOUND: playable, never listable,
 * destroyed instead of entering the lost pool, 0 risk units — an alt farm gains nothing sellable.
 */
export async function claimStarter(
  db: Db,
  userId: string,
  opts: { rng?: Rng; lockRaids?: number; kitCap?: number } = {},
): Promise<StarterResult> {
  return db.transaction(async (tx) => {
    const exists = await tx.execute(sql`select 1 from users where id = ${userId}`);
    if (!exists.rows[0]) return { status: "no_user" } as const;
    const stamp = await tx.execute(
      sql`update users set starter_claimed_at = now() where id = ${userId} and starter_claimed_at is null`,
    );
    if ((stamp.rowCount ?? 0) !== 1) return { status: "already" } as const;

    const kit = rollStarterKit(opts.rng ?? mulberry32((Math.random() * 2 ** 32) >>> 0));
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('giveaway_kits'))`);
    const dep = await tx.execute<{ minor: string }>(
      sql`select coalesce(sum(amount_cents), 0)::text as minor from deposits where user_id = ${userId} and status in ('confirmed', 'swept')`,
    );
    const deposited = BigInt(dep.rows[0]?.minor ?? "0");
    const tradable = deposited >= BigInt(GIVEAWAY.MIN_DEPOSIT_MINOR) && (await tradableKitsIssued(tx)) < (opts.kitCap ?? GIVEAWAY.KITS);
    const bound = !tradable;
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
    return { status: "claimed", itemIds: rows.map((r) => r.id), kit, credits: c.ok ? c.balance : 0, bound } as const;
  });
}
