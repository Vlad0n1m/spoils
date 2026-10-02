/**
 * Economy v2.1 constants and pure functions (economy memo, trimmed per critique).
 * Two currencies:
 * - CR: soft, in-game only, never converts to money. Junk autosell, trader consumables, fees.
 * - market money: the existing custodial `users.balance_cents` unit ("minor" units, bigint);
 *   listings, trades and fees use it. The display label (SOL / USDC / iDos) is Vlad's call.
 * DB durability is a percentage 0..100 plus max_durability; in a raid InvItem.dur is weapon % or
 * armor absorb points — convert at the API boundary with armorPoints / armorPct.
 * REPAIR, SCRAP and BOUND_OFFERS are cut for v2 (cut list 2): exported but unused.
 * Junk values, DOG_TAG and dogTagCr live in item-defs.ts (one source for the server and the API).
 */

import { DOG_TAG, dogTagCr, itemDef } from "./item-defs.js";
import type { Rarity, WeaponId } from "./items.js";
import type { ContainerKind, LootTier } from "./map/types.js";
import { mulberry32, pickWeighted } from "./rng.js";

export const CR = { CODE: "CR", START_BALANCE: 1000 } as const;

// ---------------------------------------------------------------- junk autosell

export const AUTOSELL = { BAL_LO: 2_000, BAL_HI: 8_000, STEP: 0.03, MIN: 0.6, MAX: 1.3, MIN_SAMPLE: 50 } as const;

/** Daily regulator: veterans' median CR balance steers the autosell multiplier (±3%/day). */
export function nextAutosellMult(cur: number, veteranMedianCr: number, sample: number): number {
  if (sample < AUTOSELL.MIN_SAMPLE) return cur;
  if (veteranMedianCr > AUTOSELL.BAL_HI) return Math.max(AUTOSELL.MIN, cur * (1 - AUTOSELL.STEP));
  if (veteranMedianCr < AUTOSELL.BAL_LO) return Math.min(AUTOSELL.MAX, cur * (1 + AUTOSELL.STEP));
  return cur;
}

export interface JunkSellLine {
  def: string;
  qty: number;
  cr: number;
  /** Dog tags only: victim nickname (receipt line). */
  label?: string;
}

/**
 * CR paid for extracted junk at settlement (applyExit). Values come from ITEM_DEFS; dog tags use
 * dogTagCr(lvl) and may be zeroed by the caller's pair-repeat rule via `dogTagMult` (0 or 1 per
 * line, same order as `items`). Non-junk items are ignored. Floors per line, so the receipt sums.
 */
export function junkSellCr(
  items: ReadonlyArray<{ def: string; qty: number; lvl?: number; label?: string }>,
  mult: number,
  traderBonus = 0,
  dogTagMult?: (index: number) => number,
): { total: number; lines: JunkSellLine[] } {
  const k = mult * (1 + traderBonus);
  const lines: JunkSellLine[] = [];
  items.forEach((it, i) => {
    const d = itemDef(it.def);
    if (d?.cat !== "junk") return;
    const unit = d.id === "junk_dogtag" ? dogTagCr(it.lvl ?? 0) * (dogTagMult ? dogTagMult(i) : 1) : (d.value ?? 0);
    const line: JunkSellLine = { def: d.id, qty: it.qty, cr: Math.floor(unit * it.qty * k) };
    if (it.label) line.label = it.label;
    lines.push(line);
  });
  return { total: lines.reduce((a, l) => a + l.cr, 0), lines };
}

/**
 * Dog-tag pair-repeat rule (applyExit, web-side): the same extractor bringing out tags of the same
 * victim within DOG_TAG.REPEAT_WINDOW_MS gets paid for the first REPEAT_FREE only (alt feeding).
 * `priorSamePair` = tags of this pair already paid inside the window. Use as junkSellCr's dogTagMult.
 */
export function dogTagPairMult(priorSamePair: number): 0 | 1 {
  return priorSamePair < DOG_TAG.REPEAT_FREE ? 1 : 0;
}

/**
 * Container contents rolls (owned by the economy owner, retuned after econ-sim with the slot
 * capacities). Indexed by LootTier 0..4. FILL_CHANCE: a container rolls empty otherwise (Tarkov).
 * Hackathon retune (playtest: "loot feels empty"): ≈12 % of Steppe containers roll empty
 * (was ≈37 %) and T2+ get more junk lines, close to the demo-mode CHEST_TABLES item count
 * (2–3 rolls per chest). Per-tier empty rate ≈ 1 − FILL × (1 − EMPTY^ROLLS): T0 19 %, T1 13 %,
 * T2 12 %, T3 8 %, T4 5 %.
 */
export const CONTAINER = {
  ROLLS: [1, 2, 3, 3, 4] as readonly number[],
  FILL_CHANCE: [0.88, 0.88, 0.88, 0.92, 0.95] as readonly number[],
  /** Chance an individual roll is empty. */
  EMPTY_CHANCE: 0.08,
} as const;

/** One weighted fungible entry of a container table (junk, ammo or meds; qty per roll). */
export interface ContainerLootEntry {
  def: string;
  weight: number;
  qty: number;
}

/**
 * Fungibles by container kind (map memo §7: "a fridge gives food and a PC gives computer parts").
 * Junk weights are the economy memo's JUNK spawn weights (its zones mapped onto map container
 * kinds), so the econ-sim calibration carries over; consumables are new. Uniques never come from
 * here: in live mode they come only from the lost pool (RaidStartResponse.containerLoot), in demo
 * mode from CHEST_TABLES. Retuned by the economy owner together with CONTAINER.ROLLS.
 */
export const CONTAINER_LOOT: Readonly<Record<ContainerKind, readonly ContainerLootEntry[]>> = {
  // Generic cache: village + industrial junk, a little ammo.
  crate: [
    { def: "junk_apple", weight: 100, qty: 1 }, { def: "junk_water", weight: 80, qty: 1 },
    { def: "junk_canned", weight: 70, qty: 1 }, { def: "junk_bolts", weight: 90, qty: 1 },
    { def: "junk_wires", weight: 60, qty: 1 }, { def: "junk_battery", weight: 40, qty: 1 },
    { def: "junk_fuel", weight: 25, qty: 1 }, { def: "junk_goldchain", weight: 4, qty: 1 },
    { def: "ammo_light", weight: 40, qty: 30 }, { def: "ammo_shell", weight: 20, qty: 10 },
    { def: "bandage", weight: 25, qty: 1 },
  ],
  // Industrial.
  toolbox: [
    { def: "junk_bolts", weight: 90, qty: 1 }, { def: "junk_wires", weight: 60, qty: 1 },
    { def: "junk_battery", weight: 40, qty: 1 }, { def: "junk_fuel", weight: 25, qty: 1 },
    { def: "junk_circuit", weight: 20, qty: 1 }, { def: "junk_toolbox", weight: 12, qty: 1 },
  ],
  // Village kitchens.
  fridge: [
    { def: "junk_apple", weight: 100, qty: 1 }, { def: "junk_water", weight: 80, qty: 1 },
    { def: "junk_canned", weight: 70, qty: 1 }, { def: "junk_pills", weight: 40, qty: 1 },
  ],
  // Office: computer parts and the rare high-value junk.
  pc: [
    { def: "junk_wires", weight: 60, qty: 1 }, { def: "junk_circuit", weight: 20, qty: 1 },
    { def: "junk_hdd", weight: 14, qty: 1 }, { def: "junk_keycard", weight: 5, qty: 1 },
    { def: "junk_gpu", weight: 3, qty: 1 }, { def: "junk_coldwallet", weight: 1, qty: 1 },
  ],
  med_case: [
    { def: "bandage", weight: 60, qty: 1 }, { def: "medkit", weight: 25, qty: 1 },
    { def: "junk_pills", weight: 40, qty: 1 },
  ],
  // Military.
  weapon_box: [
    { def: "ammo_light", weight: 60, qty: 30 }, { def: "ammo_shell", weight: 35, qty: 10 },
    { def: "ammo_heavy", weight: 20, qty: 10 }, { def: "junk_battery", weight: 40, qty: 1 },
    { def: "junk_keycard", weight: 5, qty: 1 }, { def: "junk_gpu", weight: 3, qty: 1 },
    { def: "junk_coldwallet", weight: 1, qty: 1 },
  ],
  // Long search, valuables only.
  safe: [
    { def: "junk_goldchain", weight: 4, qty: 1 }, { def: "junk_keycard", weight: 5, qty: 1 },
    { def: "junk_hdd", weight: 14, qty: 1 }, { def: "junk_gpu", weight: 3, qty: 1 },
    { def: "junk_coldwallet", weight: 1, qty: 1 },
  ],
  // Wilderness ground stash (economy memo "forest" zone + survival kit).
  stash: [
    { def: "junk_apple", weight: 100, qty: 1 }, { def: "junk_water", weight: 80, qty: 1 },
    { def: "junk_canned", weight: 70, qty: 1 }, { def: "junk_goldchain", weight: 4, qty: 1 },
    { def: "ammo_light", weight: 30, qty: 30 }, { def: "bandage", weight: 30, qty: 1 },
  ],
};

/** A fungible rolled into a container (uid "" — never a DB item). */
export interface RolledFungible {
  def: string;
  qty: number;
  rarity: Rarity;
}

/**
 * Contents of static container `idx` for this match, fungibles only. Rolled lazily on first open
 * (critique) and deterministic in (matchSeed, idx) alone, so the order containers are opened in
 * never changes what is inside, and a ledger audit can re-roll any container. Same-def rolls merge
 * up to the def's stack size so a container never shows two half stacks of apples.
 */
export function rollContainerFungibles(
  matchSeed: number,
  idx: number,
  spot: { kind: ContainerKind; tier: LootTier },
): RolledFungible[] {
  // Mix seed and index (FNV-style) so neighbouring indexes get unrelated streams.
  const rng = mulberry32((Math.imul((matchSeed ^ 0x9e3779b9) >>> 0, 0x01000193) ^ Math.imul(idx + 1, 0x85ebca6b)) >>> 0);
  const tier = Math.max(0, Math.min(4, spot.tier));
  if (rng() >= CONTAINER.FILL_CHANCE[tier]!) return [];
  const table = CONTAINER_LOOT[spot.kind];
  const out: RolledFungible[] = [];
  for (let i = 0; i < CONTAINER.ROLLS[tier]!; i++) {
    if (rng() < CONTAINER.EMPTY_CHANCE) continue;
    const e = pickWeighted(rng, table);
    const d = itemDef(e.def);
    if (!d) continue;
    const prev = out.find((o) => o.def === e.def && o.qty + e.qty <= d.stack);
    if (prev) prev.qty += e.qty;
    else out.push({ def: e.def, qty: Math.min(e.qty, d.stack), rarity: d.rarity });
  }
  return out;
}

// ---------------------------------------------------------------- items & durability

export type EconKind = "weapon" | "armor" | "backpack";
export type TemplateKey = `weapon:${WeaponId}:${Rarity}` | `armor:${1 | 2 | 3}` | `backpack:${1 | 2 | 3}`;

/** Market template of a unique: weapons by type and rarity, armor/backpacks by level. */
export function templateKey(item: { def: string; rarity: number }): TemplateKey | null {
  const d = itemDef(item.def);
  if (!d) return null;
  if (d.cat === "weapon" && d.weapon) return `weapon:${d.weapon}:${Math.max(0, Math.min(3, item.rarity)) as Rarity}`;
  if (d.cat === "armor" && d.armorLevel) return `armor:${d.armorLevel}`;
  if (d.cat === "backpack" && d.bpLevel) return `backpack:${d.bpLevel}`;
  return null;
}

/** DB % → in-raid armor absorb points. */
export function armorPoints(maxPoints: number, durPct: number): number {
  return (maxPoints * Math.max(0, Math.min(100, durPct))) / 100;
}
/** In-raid armor absorb points → DB %. */
export function armorPct(maxPoints: number, points: number): number {
  return maxPoints > 0 ? Math.max(0, Math.min(100, (points / maxPoints) * 100)) : 0;
}

/** Economy view of a unique (DB row). */
export interface EconItem {
  uid: string;
  def: string;
  rarity: Rarity;
  /** 0..100 percent. */
  dur: number;
  /** Starts at 100, only goes down (repairs). */
  maxDur: number;
  /** Trader item bought for CR: never tradable, never enters the lost pool. */
  bound: boolean;
  /** Giveaway lock: raids the ITEM must still be extracted in (by anyone) before listing. */
  lockRaids: number;
}

// ---------------------------------------------------------------- traders (consumables only in v2)

export type ConsumableId = "bandage" | "medkit" | "ammo_light" | "ammo_shell" | "ammo_heavy";
export const CONSUMABLES_CR: Readonly<Record<ConsumableId, { qty: number; cr: number }>> = {
  bandage: { qty: 1, cr: 60 },
  medkit: { qty: 1, cr: 220 },
  ammo_light: { qty: 30, cr: 45 },
  ammo_shell: { qty: 10, cr: 60 },
  ammo_heavy: { qty: 10, cr: 110 },
};

/** CUT for v2 (cut list 2) — exported but unused. */
export type TraderId = "junker" | "gunsmith" | "outfitter";
export interface BoundOffer { trader: TraderId; def: string; rarity: Rarity; cr: number; traderLevel: 1 | 2 | 3 | 4 }
export const BOUND_OFFERS: readonly BoundOffer[] = [
  { trader: "outfitter", def: "backpack_1", rarity: 0, cr: 700, traderLevel: 1 },
  { trader: "outfitter", def: "armor_1", rarity: 0, cr: 900, traderLevel: 1 },
  { trader: "gunsmith", def: "shotgun", rarity: 0, cr: 1500, traderLevel: 1 },
  { trader: "gunsmith", def: "rifle", rarity: 0, cr: 1800, traderLevel: 2 },
  { trader: "outfitter", def: "backpack_2", rarity: 1, cr: 2200, traderLevel: 3 },
  { trader: "outfitter", def: "armor_2", rarity: 1, cr: 2600, traderLevel: 3 },
  { trader: "gunsmith", def: "sniper", rarity: 0, cr: 3200, traderLevel: 3 },
];
/** CUT for v2 — exported but unused. Index: weapon by rarity, armor/backpack by level. */
export const REPAIR_CR_PER_POINT = { weapon: [4, 8, 14, 24], armor: [0, 1.5, 2.5, 4], backpack: [0, 1, 2, 3] } as const;
export const REPAIR_MAX_DECAY = 0.1;
/** CUT for v2 — exported but unused. */
export const SCRAP_CR = { weapon: [300, 700, 1600, 3500], armor: [0, 200, 500, 1200], backpack: [0, 150, 450, 1100] } as const;

// ---------------------------------------------------------------- lost pool

export const POOL = {
  /** A unique that breaks on death enters the pool with −8 dur. */
  BREAK_DUR_LOSS: 8,
  /** Items released per match = round(RISK_K × riskUnits), capped. */
  RISK_K: 1.5,
  MAX_PER_MATCH: 10,
  /** 1% of the value entering the pool accrues to the treasury. */
  TAX_SHARE: 0.01,
  /** Best N released items go to the boss stash when a boss spawns. */
  BOSS_SHARE: 2,
  /**
   * Release FLOOR per match (hackathon tunable, see docs): even a lobby of free kits gets at least
   * this many pool uniques, but only in dangerous spots (containers of tier >= FLOOR_MIN_TIER and
   * boss stashes), so farming them still means fighting through T3/T4 POIs. Drawn only while the
   * pool holds more than FLOOR_MIN_POOL items (the seeded reserve is never drained to zero by it).
   * The web may override it with POOL_MIN_RELEASE_PER_MATCH.
   */
  MIN_RELEASE_PER_MATCH: 6,
  FLOOR_MIN_POOL: 100,
  FLOOR_MIN_TIER: 3,
} as const;

/** Durability the item enters the pool with, or null if it does not enter (bound or worn out). */
export function poolEntry(i: Pick<EconItem, "dur" | "bound">, broke: boolean): number | null {
  if (i.bound) return null;
  const dur = broke ? i.dur - POOL.BREAK_DUR_LOSS : i.dur;
  return dur > 0 ? dur : null;
}

/** riskUnits = non-FREE uniques across accepted loadouts; free-kit players add nothing. */
export function poolReleaseCount(poolSize: number, riskUnits: number): number {
  return Math.max(0, Math.min(poolSize, POOL.MAX_PER_MATCH, Math.round(POOL.RISK_K * riskUnits)));
}

/**
 * Pool items released into one match: the risk-driven count (poolReleaseCount) topped up to the
 * floor `minRelease` while the pool is above FLOOR_MIN_POOL (never below it because of the floor).
 * `floor` = how many of `total` are floor items (placed only in tier >= FLOOR_MIN_TIER / boss).
 */
export function poolReleasePlan(
  poolSize: number,
  riskUnits: number,
  minRelease: number = POOL.MIN_RELEASE_PER_MATCH,
): { total: number; risk: number; floor: number } {
  const risk = poolReleaseCount(poolSize, riskUnits);
  const above = Math.max(0, poolSize - risk - POOL.FLOOR_MIN_POOL);
  const want = Math.max(0, Math.min(POOL.MAX_PER_MATCH, Math.floor(minRelease)) - risk);
  const floor = Math.max(0, Math.min(want, above));
  return { total: risk + floor, risk, floor };
}

/**
 * Accrues TAX_SHARE of the entering value and takes whole items (most valuable first) into the
 * treasury while the accumulator covers them. Returns taken uids and the new accumulator.
 */
export function takeTreasuryTax(
  acc: number,
  entering: ReadonlyArray<{ uid: string; value: number }>,
): { taken: string[]; acc: number } {
  let a = acc + entering.reduce((s, e) => s + e.value, 0) * POOL.TAX_SHARE;
  const taken: string[] = [];
  for (const e of [...entering].sort((x, y) => y.value - x.value)) {
    if (e.value > 0 && a >= e.value) {
      taken.push(e.uid);
      a -= e.value;
    }
  }
  return { taken, acc: a };
}

// ---------------------------------------------------------------- market (minor units, bigint)

export const MARKET = {
  /** 5% fee (decided by Vlad). */
  FEE_BPS: 500,
  /** CR listing fee by rarity. */
  LISTING_FEE_CR: [50, 150, 400, 1000] as const,
  /** Cut 1 candidate: delayed lot visibility. */
  VISIBLE_DELAY_MS: [30_000, 90_000] as const,
  LISTING_TTL_MS: 7 * 24 * 3600_000,
  MAX_ACTIVE_LISTINGS: 20,
  MAX_BUYS_PER_HOUR: 10,
  MAX_BUYS_PER_TEMPLATE_PER_DAY: 30,
  /** Demo: 1. */
  SELL_UNLOCK_LEVEL: 5,
  BAND_MIN: 0.5,
  BAND_MAX: 4,
  INDEX_WINDOW_DAYS: 7,
  INDEX_MIN_TRADES: 10,
  INDEX_MIN_DISTINCT_SELLERS: 5,
  INDEX_MAX_PAIR_TRADES: 2,
  INDEX_MIN_DUR: 50,
} as const;

/** Per-rarity hard price floor in minor units (decided by Vlad; null = none). */
export const MARKET_HARD_FLOOR_MINOR: Readonly<Record<Rarity, bigint | null>> = { 0: null, 1: null, 2: null, 3: null };

/** Fee rounded up so the house never loses a minor unit to rounding. */
export function marketFeeMinor(price: bigint, feeBps: number = MARKET.FEE_BPS): bigint {
  return (price * BigInt(feeBps) + 9_999n) / 10_000n;
}

/** Median after dropping the top and bottom 10% (price index). */
export function trimmedMedian(prices: readonly bigint[]): bigint | null {
  if (prices.length === 0) return null;
  const s = [...prices].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const cut = Math.floor(s.length * 0.1);
  const t = s.slice(cut, s.length - cut);
  return t[Math.floor(t.length / 2)] ?? null;
}

/** Allowed listing price band around the index (anti wash-trading / RMT). */
export function priceBand(index: bigint | null, hardFloor: bigint | null): { min: bigint; max: bigint | null } {
  const floor = hardFloor ?? 1n;
  if (index === null) return { min: floor, max: null };
  const min = (index * BigInt(Math.round(MARKET.BAND_MIN * 100))) / 100n;
  const max = (index * BigInt(Math.round(MARKET.BAND_MAX * 100))) / 100n;
  return { min: min > floor ? min : floor, max };
}

export type ListingStatus = "pending" | "active" | "sold" | "cancelled" | "expired";
export interface ListingDto {
  id: string;
  item: EconItem;
  template: TemplateKey;
  sellerNick: string;
  /** Minor units as a decimal string (bigint over JSON). */
  price: string;
  status: ListingStatus;
  visibleAt: number;
  expiresAt: number;
  isTreasury: boolean;
}
export interface PricePoint {
  day: string;
  median: string | null;
  volume: number;
  min: string | null;
}

// ---------------------------------------------------------------- giveaway / starter kit

export const GIVEAWAY = {
  KITS: 1000,
  /** Raids the item must be extracted in before it can be listed (demo: 1). */
  LOCK_RAIDS: 10,
  LOCK_RAIDS_DEMO: 1,
  MIN_WALLET_AGE_DAYS: 30,
  MIN_WALLET_SOL: 0.05,
  LEGENDARY_RAFFLE: 20,
  POOL_SEED_KITS: 250,
} as const;

export const GIVEAWAY_KIT = {
  weapon: [
    { def: "rifle", rarity: 0, weight: 40 },
    { def: "shotgun", rarity: 0, weight: 35 },
    { def: "rifle", rarity: 1, weight: 15 },
    { def: "shotgun", rarity: 1, weight: 10 },
  ],
  armor: [{ def: "armor_1", weight: 80 }, { def: "armor_2", weight: 20 }],
  backpack: [{ def: "backpack_1", weight: 100 }],
  cr: 1000,
} as const;

// ---------------------------------------------------------------- progression

export const PROGRESSION = { XP_RAID: 100, XP_EXTRACT: 250, XP_KILL: 80, XP_BOSS: 400 } as const;

/** XP from level L to L+1. ~180 XP/raid: L5 ≈ 14 raids, L10 ≈ 50, L15 ≈ 105. */
export function xpToNext(level: number): number {
  return 250 + 150 * level;
}

export function levelForXp(xp: number): number {
  let l = 1, need = xpToNext(1), rest = xp;
  while (rest >= need) {
    rest -= need;
    l++;
    need = xpToNext(l);
  }
  return l;
}

export const STASH_CAPACITY = [20, 35, 55, 80] as const;
