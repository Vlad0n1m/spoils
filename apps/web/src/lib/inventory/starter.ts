import { sql } from "drizzle-orm";
import { GIVEAWAY_KIT, itemDef, mulberry32, pickWeighted, type Rng } from "@extract/shared";
import { itemEvents, items } from "../../db/schema";
import { credit } from "../economy/ledger";
import { giveawayLockRaids } from "../economy/config";
import type { Db } from "./db";
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
  | { status: "claimed"; itemIds: string[]; kit: StarterRoll; credits: number }
  | { status: "already" }
  | { status: "no_user" };

/**
 * POST /api/stash/starter: one giveaway kit per account (economy memo §15.6). The claim stamp
 * `starter_claimed_at` is set by a guarded UPDATE … WHERE starter_claimed_at IS NULL, so two
 * concurrent clicks give one kit. Items are `giveaway` origin with lock_raids (10, demo 1): they
 * must be extracted that many times before they can be listed. Plus GIVEAWAY_KIT.cr credits.
 */
export async function claimStarter(
  db: Db,
  userId: string,
  opts: { rng?: Rng; lockRaids?: number } = {},
): Promise<StarterResult> {
  return db.transaction(async (tx) => {
    const exists = await tx.execute(sql`select 1 from users where id = ${userId}`);
    if (!exists.rows[0]) return { status: "no_user" } as const;
    const stamp = await tx.execute(
      sql`update users set starter_claimed_at = now() where id = ${userId} and starter_claimed_at is null`,
    );
    if ((stamp.rowCount ?? 0) !== 1) return { status: "already" } as const;

    const kit = rollStarterKit(opts.rng ?? mulberry32((Math.random() * 2 ** 32) >>> 0));
    const lockRaids = opts.lockRaids ?? giveawayLockRaids();
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
        })),
      )
      .returning({ id: items.id });
    await tx.insert(itemEvents).values(
      rows.map((r) => ({ itemId: r.id, toState: "in_stash" as const, toOwner: userId, reason: "grant", refId: "starter" })),
    );
    for (const s of kit.stacks) await addStack(tx, userId, s.def, s.qty);
    const c = await credit(tx, userId, GIVEAWAY_KIT.cr, "giveaway", "starter");
    return { status: "claimed", itemIds: rows.map((r) => r.id), kit, credits: c.ok ? c.balance : 0 } as const;
  });
}
