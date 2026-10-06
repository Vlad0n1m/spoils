/**
 * ALPHA LOOT (Vlad, 2026-10: "gameplay first, generous loot"). A layer on top of the LOOT ECONOMY v4
 * tables that is ON by default (game-server env ALPHA_LOOT, default ALPHA_LOOT.ENABLED) and works in
 * live mode too. With it off every roll is exactly the v4 one.
 *
 * What it adds:
 * - containers: higher FILL_CHANCE and a lower per-roll EMPTY_CHANCE for the fungibles (≈ 30 % of
 *   containers stay empty instead of ≈ 54 %), plus a weapon (WEAPON_CHANCE / WEAPON_RARITY by tier;
 *   a weapon_box of tier ≥ WEAPON_BOX_MIN_TIER always holds one) and an armor / backpack
 *   (GEAR_CHANCE, level GEAR_LEVEL by tier);
 * - supply drops: one guaranteed rare+ weapon and one armor piece on top of SUPPLY_DROP_LOOT;
 * - floor guns: FLOOR_GUN_CHANCE on loot spots of tier ≥ FLOOR_GUN_MIN_TIER (common / rare).
 *
 * These uniques are minted from nothing (accepted for the alpha). The server registers them in the
 * ledger with origin "alpha" and lists the extracted ones in PlayerExitReport.alphaFound; the web
 * creates the item rows on extract (origin 'alpha', tradable: the alpha market runs on CR and SOL
 * trades only go through the devnet escrow). NPC gear still never drops.
 *
 * Everything here is pure and deterministic in its seed (containers: (lootSeed, idx) alone, so the
 * open order never changes what is inside).
 */

import type { Rarity, WeaponId } from "./items.js";
import type { ContainerKind } from "./map/types.js";
import { mulberry32, pickWeighted, type Rng } from "./rng.js";

interface RarityW {
  rarity: Rarity;
  weight: number;
}
interface WeaponW {
  weapon: WeaponId;
  weight: number;
}
const R = (rarity: Rarity, weight: number): RarityW => ({ rarity, weight });
const W = (weapon: WeaponId, weight: number): WeaponW => ({ weapon, weight });

/**
 * Loot trim (owner, 2026-10, after looting the T4 Radar to an epic backpack and an epic rifle from
 * almost every case):
 * - DROP_MULT: every static container gives 10 % less: the fungible fill chance (v4 and alpha,
 *   economy.ts rollContainerFungibles), the alpha weapon and gear chances, and the weapon-box
 *   guarantee (now DROP_MULT instead of always) are all × DROP_MULT. Expected items per container
 *   (fungible stacks and uniques) are exactly × 0.9 at every tier; the draw order is unchanged.
 * - T4 on top: WEAPON_RARITY[4] epic 70 / legendary 30 → rare 70 / epic 25 / legendary 5 and
 *   GEAR_CHANCE[4] 0.2 → 0.1 (gear stays level 3: an epic backpack / armor is still a T4 find, just
 *   rarer). Epic+ per full Radar visit (55 containers, 30 weapon boxes; loot model, alpha-loot.test.ts):
 *   ≈ 56 → ≈ 17 (weapons 12.2 + gear 5.0). Fewer epic items per container, not fewer containers, so the map and its hash stay.
 * Prices and fees do not change.
 */
export const LOOT_TRIM = {
  DROP_MULT: 0.9,
} as const;

export const ALPHA_LOOT = {
  /** Default of the game server's ALPHA_LOOT env flag. */
  ENABLED: true,
  /** Container fungibles (replace CONTAINER.FILL_CHANCE / EMPTY_CHANCE while on). */
  FILL_CHANCE: [0.45, 0.65, 0.7, 0.85, 0.9] as readonly number[],
  EMPTY_CHANCE: 0.08,
  /** Weapon per opened container, by tier, and its rarity mix (rarity 0 common … 3 legendary). */
  WEAPON_CHANCE: [0, 0.08, 0.15, 0.35, 0.6] as readonly number[],
  WEAPON_RARITY: [
    [R(0, 100)],
    [R(0, 100)],
    [R(0, 70), R(1, 30)],
    [R(1, 60), R(2, 40)],
    [R(1, 70), R(2, 25), R(3, 5)], // LOOT_TRIM (2026-10): was epic 70 / legendary 30
  ] as ReadonlyArray<readonly RarityW[]>,
  /** A weapon_box of at least this tier always holds one weapon of its tier's mix. */
  WEAPON_BOX_MIN_TIER: 2,
  /**
   * Weapon types. T1 (common only) rolls the light guns; T2+ the whole arsenal. The crossbow is in
   * (bolts come from crates / weapon boxes / supply drops).
   */
  WEAPON_TYPES_LOW: [W("pistol", 30), W("smg", 25), W("shotgun", 25), W("rifle", 20)] as readonly WeaponW[],
  WEAPON_TYPES: [
    W("rifle", 24), W("smg", 18), W("shotgun", 18), W("pistol", 8), W("revolver", 10), W("sniper", 10), W("crossbow", 6), W("lmg", 6),
  ] as readonly WeaponW[],
  /** Armor or backpack per opened container, by tier; level by tier (0 = none); armor share of the draw. */
  GEAR_CHANCE: [0, 0, 0.08, 0.15, 0.1] as readonly number[], // LOOT_TRIM (2026-10): T4 0.2 → 0.1
  GEAR_LEVEL: [0, 0, 1, 2, 3] as readonly (0 | 1 | 2 | 3)[],
  GEAR_ARMOR_SHARE: 0.6,
  /** Supply crate: one weapon of this rarity mix (rare+) and one armor of this level mix. */
  DROP_WEAPON_RARITY: [R(1, 50), R(2, 35), R(3, 15)] as readonly RarityW[],
  DROP_ARMOR_LEVEL: [{ level: 2 as const, weight: 60 }, { level: 3 as const, weight: 40 }],
  /** Floor guns (match.ts rollFloorLoot): chance per loot spot of tier ≥ FLOOR_GUN_MIN_TIER. */
  FLOOR_GUN_CHANCE: 0.25,
  FLOOR_GUN_MIN_TIER: 2,
  FLOOR_GUN_RARITY: [R(0, 70), R(1, 30)] as readonly RarityW[],
  /** Container stream salt (independent of the fungible and demo streams). */
  SALT: 0xa1fa_1007,
  /** The web caps alphaFound at this many uids per exit report (bug guard, not anti-cheat: the report is signed). */
  MAX_PER_EXIT: 32,
} as const;

/** One alpha unique to mint (the server gives it a uid). Armor / backpack rarity = level − 1, as their defs. */
export interface AlphaUnique {
  def: string;
  rarity: Rarity;
}

function clampTier(tier: number): 0 | 1 | 2 | 3 | 4 {
  return Math.max(0, Math.min(4, Math.floor(tier))) as 0 | 1 | 2 | 3 | 4;
}

/** A weapon of `tier`'s type table (T0–T1: WEAPON_TYPES_LOW) with a rarity from `rarities`. Two draws. */
export function rollAlphaWeapon(rng: Rng, tier: number, rarities: readonly RarityW[]): AlphaUnique {
  const types = clampTier(tier) <= 1 ? ALPHA_LOOT.WEAPON_TYPES_LOW : ALPHA_LOOT.WEAPON_TYPES;
  const w = pickWeighted(rng, types);
  const r = pickWeighted(rng, rarities);
  return { def: w.weapon, rarity: r.rarity };
}

/** Armor or backpack of `level` (1..3). One draw. */
function rollGear(rng: Rng, level: 1 | 2 | 3): AlphaUnique {
  const armor = rng() < ALPHA_LOOT.GEAR_ARMOR_SHARE;
  return { def: armor ? `armor_${level}` : `backpack_${level}`, rarity: (level - 1) as Rarity };
}

/** Per-container stream of the alpha uniques (FNV-style mix of seed and index). */
function alphaRng(lootSeed: number, idx: number): Rng {
  return mulberry32((Math.imul((lootSeed ^ ALPHA_LOOT.SALT) >>> 0, 0x01000193) ^ Math.imul(idx + 11, 0x85ebca6b)) >>> 0);
}

/**
 * Alpha uniques of static container `idx` (rolled once, on first open). Fixed draw order: weapon
 * chance, weapon type, weapon rarity, gear chance, gear kind — always all five, so one result never
 * shifts another. Deterministic in (lootSeed, idx, spot).
 */
export function rollAlphaContainerUniques(lootSeed: number, idx: number, spot: { kind: ContainerKind; tier: number }): AlphaUnique[] {
  const tier = clampTier(spot.tier);
  const rng = alphaRng(lootSeed, idx);
  const out: AlphaUnique[] = [];
  const box = spot.kind === "weapon_box" && tier >= ALPHA_LOOT.WEAPON_BOX_MIN_TIER;
  // LOOT_TRIM: weapon / gear chances and the weapon-box guarantee × DROP_MULT (same draws).
  const rWeapon = rng();
  const weaponHit = rWeapon < (box ? 1 : ALPHA_LOOT.WEAPON_CHANCE[tier]!) * LOOT_TRIM.DROP_MULT;
  const weapon = rollAlphaWeapon(rng, tier, ALPHA_LOOT.WEAPON_RARITY[tier]!);
  if (weaponHit && ALPHA_LOOT.WEAPON_RARITY[tier]!.length > 0) out.push(weapon);
  const gearHit = rng() < ALPHA_LOOT.GEAR_CHANCE[tier]! * LOOT_TRIM.DROP_MULT;
  const level = ALPHA_LOOT.GEAR_LEVEL[tier]!;
  const gear = rollGear(rng, (level || 1) as 1 | 2 | 3);
  if (gearHit && level > 0) out.push(gear);
  return out;
}

/** Alpha uniques of a supply crate: one rare+ weapon (T4 type table) and one armor. Uses `rng` after the crate's own rolls. */
export function rollAlphaDropUniques(rng: Rng): AlphaUnique[] {
  const weapon = rollAlphaWeapon(rng, 4, ALPHA_LOOT.DROP_WEAPON_RARITY);
  const lv = pickWeighted(rng, ALPHA_LOOT.DROP_ARMOR_LEVEL).level;
  return [weapon, { def: `armor_${lv}`, rarity: (lv - 1) as Rarity }];
}

/**
 * Floor gun of a loot spot, or null: one chance draw on spots of tier ≥ FLOOR_GUN_MIN_TIER (none
 * below, no draw), then type and rarity. `rng` is the match's setup stream.
 */
export function rollAlphaFloorGun(rng: Rng, tier: number): AlphaUnique | null {
  if (clampTier(tier) < ALPHA_LOOT.FLOOR_GUN_MIN_TIER) return null;
  if (!(rng() < ALPHA_LOOT.FLOOR_GUN_CHANCE)) return null;
  return rollAlphaWeapon(rng, tier, ALPHA_LOOT.FLOOR_GUN_RARITY);
}

/**
 * Expected alpha weapons from opening containers of the given tiers, with `weaponBoxShare[t]` the
 * share of weapon boxes among the tier's containers (they always hold one at tier ≥ WEAPON_BOX_MIN_TIER).
 */
export function expectedAlphaWeapons(tiers: readonly number[], weaponBoxShare: readonly number[] = [0, 0, 0, 0, 0]): number {
  let e = 0;
  for (const t0 of tiers) {
    const t = clampTier(t0);
    const p = ALPHA_LOOT.WEAPON_CHANCE[t]!;
    const box = t >= ALPHA_LOOT.WEAPON_BOX_MIN_TIER ? (weaponBoxShare[t] ?? 0) : 0;
    e += (box + (1 - box) * p) * LOOT_TRIM.DROP_MULT;
  }
  return e;
}
