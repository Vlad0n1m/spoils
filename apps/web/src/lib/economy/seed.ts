import { sql } from "drizzle-orm";
import {
  SEED_KIT,
  MARKET,
  itemDef,
  pickWeighted,
  templateKey,
  templateRefPriced,
  type Rng,
} from "@extract/shared";
import { itemEvents, items, listings, type NewItem } from "../../db/schema";
import type { Db } from "../inventory/db";
import { PARAM, setParam } from "./params";

/**
 * NPC reference prices in market minor units (balance_cents) at 100 % durability. Placeholders
 * until Vlad sets the primary-sale prices (economy memo §16): weapons by rarity, armor and
 * backpacks by level. Weapons v2 guns (shared UNPRICED_WEAPONS: SMG, LMG, revolver, crossbow) have
 * NO reference price: npcPriceMinor returns null for them and the seed never lists them.
 */
export const NPC_PRICE_MINOR = {
  weapon: [300, 900, 2500, 6000],
  armor: [0, 400, 1100, 2800],
  backpack: [0, 300, 900, 2200],
} as const;

export function npcPriceMinor(def: string, rarity: number, dur: number, rng: Rng): bigint | null {
  const d = itemDef(def);
  if (!d) return 0n;
  const template = templateKey({ def, rarity });
  if (template && !templateRefPriced(template)) return null;
  const base =
    d.cat === "weapon"
      ? NPC_PRICE_MINOR.weapon[Math.max(0, Math.min(3, rarity))]!
      : d.cat === "armor"
        ? NPC_PRICE_MINOR.armor[d.armorLevel ?? 1]
        : NPC_PRICE_MINOR.backpack[d.bpLevel ?? 1];
  const k = (0.6 + (0.4 * dur) / 100) * (0.9 + rng() * 0.3);
  return BigInt(Math.max(5, Math.round((base * k) / 5) * 5));
}

/** Treasury listing price; unpriced templates never reach a listing (filtered when rolled). */
function listingPrice(def: string, rarity: number, dur: number, rng: Rng): bigint {
  const p = npcPriceMinor(def, rarity, dur, rng);
  if (p === null) throw new Error(`no reference price for ${def}:${rarity}`);
  return p;
}

/**
 * One seed piece, rolled like a giveaway kit part (weapon / armor / backpack in turn) so the pool
 * mirrors what players will carry, with some rarer weapons sprinkled in (pool seed, memo §10).
 */
function rollPiece(i: number, rng: Rng): { def: string; rarity: number } {
  const slot = i % 3;
  if (slot === 0) {
    if (rng() < 0.12) return { def: rng() < 0.5 ? "sniper" : "rifle", rarity: rng() < 0.3 ? 3 : 2 };
    const w = pickWeighted(rng, SEED_KIT.weapon);
    return { def: w.def, rarity: w.rarity };
  }
  if (slot === 1) {
    const a = rng() < 0.08 ? { def: "armor_3" } : pickWeighted(rng, SEED_KIT.armor);
    return { def: a.def, rarity: itemDef(a.def)?.rarity ?? 0 };
  }
  const lv = rng() < 0.15 ? 2 : 1;
  return { def: `backpack_${lv}`, rarity: lv - 1 };
}

export interface SeedResult {
  status: "seeded" | "already";
  poolItems: number;
  listings: number;
}

/**
 * Demo seed (critique "Live vs demo economy mode"): a starter-kit lost pool (≈700 items, so
 * raids/enter has something to release on day 1) and NPC treasury listings (seller NULL) so the
 * market and /economy are not empty. Idempotent through economy_params.seeded_at unless `force`.
 */
export async function seedEconomy(
  db: Db,
  opts: { poolItems?: number; listings?: number; rng: Rng; force?: boolean; now?: Date },
): Promise<SeedResult> {
  const nPool = opts.poolItems ?? 700;
  const nList = opts.listings ?? 20;
  const now = opts.now ?? new Date();
  return db.transaction(async (tx) => {
    // Serialize concurrent seeders on the params row.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('seed-economy'))`);
    const done = await tx.execute(sql`select 1 from economy_params where key = ${PARAM.SEEDED_AT}`);
    if (done.rows[0] && !opts.force) return { status: "already", poolItems: 0, listings: 0 };

    const rows: NewItem[] = [];
    for (let i = 0; i < nPool + nList; i++) {
      const p = rollPiece(i, opts.rng);
      const dur = Math.round(55 + opts.rng() * 45);
      rows.push({
        defId: p.def,
        rarity: p.rarity,
        durability: dur,
        maxDurability: 100,
        // A template without a reference price (Weapons v2) is never listed by the treasury.
        state: i < nPool || !templateRefPriced(templateKey(p) ?? "") ? "lost_pool" : "listed",
        ownerId: null,
        origin: "seed",
      });
    }
    const inserted: Array<{ id: string; defId: string; rarity: number; durability: number; state: string }> = [];
    for (let i = 0; i < rows.length; i += 500) {
      inserted.push(
        ...(await tx
          .insert(items)
          .values(rows.slice(i, i + 500))
          .returning({ id: items.id, defId: items.defId, rarity: items.rarity, durability: items.durability, state: items.state })),
      );
    }
    for (let i = 0; i < inserted.length; i += 500) {
      await tx.insert(itemEvents).values(
        inserted.slice(i, i + 500).map((r) => ({
          itemId: r.id,
          toState: r.state as "lost_pool" | "listed",
          reason: "seed",
          refId: now.toISOString(),
        })),
      );
    }
    const listed = inserted.filter((r) => r.state === "listed");
    if (listed.length) {
      await tx.insert(listings).values(
        listed.map((r) => ({
          itemId: r.id,
          sellerId: null,
          template: templateKey({ def: r.defId, rarity: r.rarity }) ?? r.defId,
          priceMinor: listingPrice(r.defId, r.rarity, r.durability, opts.rng),
          feeCr: 0,
          status: "active" as const,
          visibleAt: now,
          expiresAt: new Date(now.getTime() + MARKET.LISTING_TTL_MS),
        })),
      );
    }
    await setParam(tx, PARAM.SEEDED_AT, now.toISOString());
    return { status: "seeded", poolItems: nPool, listings: listed.length };
  });
}
