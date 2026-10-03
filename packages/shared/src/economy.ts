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
 * LOOT ECONOMY v4 ("risk drives reward"): CONTAINER / CONTAINER_LOOT / containerLootFor zone the
 * fungibles by tier, FLOOR_LOOT / rollFloorLoot replace the server's flat floor table, the pool
 * releases round(1.0 × riskUnits) with a boss-only top-up (poolReleasePlanV4), and BOSSES carry
 * the top pool items and the high-value junk.
 */

import { DOG_TAG, ammoDefOf, dogTagCr, itemDef } from "./item-defs.js";
import { ARMOR, WEAPONS, type Rarity, type WeaponId } from "./items.js";
import { BOSS_CHANCE } from "./map/steppe.js";
import { BOSS_KINDS, type BossKind, type BossSpot, type ContainerKind, type LootTier } from "./map/types.js";
import { mulberry32, pickWeighted, type Rng } from "./rng.js";

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
 * Container contents rolls, LOOT ECONOMY v4 ("risk drives reward"; scratchpad econ4/v4model.mts).
 * Indexed by LootTier 0..4 (zone class: 0 wilds, 1 dachas/fuel/hunter cabins, 2 ordinary POIs,
 * 3 Grain Elevator, 4 Radar Base). Value is zoned by tier: the wilds and T1 give almost nothing,
 * T2 pays a small wage, only T3/T4 hold high-value container loot.
 * - FILL_CHANCE: the container rolls empty otherwise; then ROLLS rolls, each empty with EMPTY_CHANCE.
 *   Empty rate ≈ 1 − FILL × (1 − EMPTY^ROLLS): T0 ≈ 79 %, T1 62 %, T2 58 %, T3 17 %, T4 12 %.
 * - JUNK_VALUE_CAP: junk entries whose unit value is above the tier cap are dropped from the table
 *   (weights renormalise over what is left; the draw count stays the same).
 * - AMMO_QTY_MULT: ammo stacks are scaled, qty = max(1, round(qty × mult)) (30 → 10 rounds in T0).
 * - MEDKIT_MIN_TIER: medkits come only from T3/T4 containers.
 * Model EV per container (junk CR / consumables CR-eq): T0 6.7 / 0.9, T1 12.8 / 1.0,
 * T2 19.2 / 2.1, T3 169 / 15, T4 173 / 30. Per match: ≈ 20k junk CR (was 77k), ≈ 79 % of it in
 * the elevator and the radar base; ≈ 2.5k CR-eq of consumables (was 13.1k).
 */
export const CONTAINER = {
  ROLLS: [1, 1, 1, 2, 2] as readonly number[],
  FILL_CHANCE: [0.25, 0.45, 0.5, 0.85, 0.9] as readonly number[],
  /** Chance an individual roll is empty. */
  EMPTY_CHANCE: 0.15,
  /** Max junk unit value (CR) a container of this tier can hold. */
  JUNK_VALUE_CAP: [55, 55, 110, Infinity, Infinity] as readonly number[],
  /** Ammo stack multiplier by tier. */
  AMMO_QTY_MULT: [0.34, 0.5, 0.5, 0.67, 0.5] as readonly number[],
  /** Medkits only in containers of at least this tier. */
  MEDKIT_MIN_TIER: 3,
  /** Demo mode: CHEST_TABLES unique rolls only in containers of at least this tier. */
  DEMO_UNIQUE_MIN_TIER: 3,
} as const;

/** One weighted fungible entry of a container table (junk, ammo or meds; qty per roll). */
export interface ContainerLootEntry {
  def: string;
  weight: number;
  qty: number;
}

/**
 * Fungibles by container kind (map memo §7: "a fridge gives food and a PC gives computer parts").
 * v4: high-value junk (gold chain, GPU, cold wallet) left the ordinary containers — it drops from
 * bosses (BOSSES[kind].junk), and a little gold chain / GPU stays in safes (T3/T4 only on the
 * Steppe). Per-tier filtering and ammo scaling: containerLootFor. Uniques never come from here: in
 * live mode they come only from the lost pool (RaidStartResponse.containerLoot), in demo mode from
 * CHEST_TABLES (tier >= CONTAINER.DEMO_UNIQUE_MIN_TIER).
 */
export const CONTAINER_LOOT: Readonly<Record<ContainerKind, readonly ContainerLootEntry[]>> = {
  // Generic cache: village + industrial junk, a little ammo.
  crate: [
    { def: "junk_apple", weight: 100, qty: 1 }, { def: "junk_water", weight: 80, qty: 1 },
    { def: "junk_canned", weight: 70, qty: 1 }, { def: "junk_bolts", weight: 90, qty: 1 },
    { def: "junk_wires", weight: 60, qty: 1 }, { def: "junk_battery", weight: 40, qty: 1 },
    { def: "junk_fuel", weight: 25, qty: 1 },
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
  // Office: computer parts (GPU / cold wallet moved to bosses).
  pc: [
    { def: "junk_wires", weight: 60, qty: 1 }, { def: "junk_circuit", weight: 20, qty: 1 },
    { def: "junk_hdd", weight: 14, qty: 1 }, { def: "junk_keycard", weight: 5, qty: 1 },
  ],
  med_case: [
    { def: "bandage", weight: 40, qty: 1 }, { def: "medkit", weight: 8, qty: 1 },
    { def: "junk_pills", weight: 50, qty: 1 },
  ],
  // Military.
  weapon_box: [
    { def: "ammo_light", weight: 40, qty: 30 }, { def: "ammo_shell", weight: 25, qty: 10 },
    { def: "ammo_heavy", weight: 15, qty: 10 }, { def: "junk_bolts", weight: 30, qty: 1 },
    { def: "junk_battery", weight: 40, qty: 1 }, { def: "junk_keycard", weight: 5, qty: 1 },
  ],
  // Long search, valuables only (T3/T4 safes keep a little gold chain and GPU).
  safe: [
    { def: "junk_keycard", weight: 5, qty: 1 }, { def: "junk_hdd", weight: 14, qty: 1 },
    { def: "junk_goldchain", weight: 4, qty: 1 }, { def: "junk_gpu", weight: 2, qty: 1 },
  ],
  // Wilderness ground stash: survival kit only.
  stash: [
    { def: "junk_apple", weight: 100, qty: 1 }, { def: "junk_water", weight: 80, qty: 1 },
    { def: "junk_canned", weight: 70, qty: 1 }, { def: "ammo_light", weight: 15, qty: 30 },
    { def: "bandage", weight: 15, qty: 1 },
  ],
};

const lootForCache = new Map<string, readonly ContainerLootEntry[]>();

/**
 * The effective fungible table of a container of `kind` in a `tier` zone: CONTAINER_LOOT[kind]
 * without junk above CONTAINER.JUNK_VALUE_CAP[tier] and without medkits below MEDKIT_MIN_TIER,
 * ammo quantities scaled by AMMO_QTY_MULT[tier]. Memoized; may be empty (then the container is
 * always empty). Weights are the table's own (pickWeighted renormalises).
 */
export function containerLootFor(spot: { kind: ContainerKind; tier: number }): readonly ContainerLootEntry[] {
  const tier = Math.max(0, Math.min(4, Math.floor(spot.tier)));
  const key = `${spot.kind}:${tier}`;
  let t = lootForCache.get(key);
  if (!t) {
    const out: ContainerLootEntry[] = [];
    for (const e of CONTAINER_LOOT[spot.kind]) {
      const d = itemDef(e.def);
      if (!d) continue;
      if (d.cat === "junk" && (d.value ?? 0) > CONTAINER.JUNK_VALUE_CAP[tier]!) continue;
      if (e.def === "medkit" && tier < CONTAINER.MEDKIT_MIN_TIER) continue;
      const qty = d.cat === "ammo" ? Math.max(1, Math.round(e.qty * CONTAINER.AMMO_QTY_MULT[tier]!)) : e.qty;
      out.push({ def: e.def, weight: e.weight, qty: Math.min(qty, d.stack) });
    }
    t = Object.freeze(out);
    lootForCache.set(key, t);
  }
  return t;
}

/** A fungible rolled into a container (uid "" — never a DB item). */
export interface RolledFungible {
  def: string;
  qty: number;
  rarity: Rarity;
}

/** Adds `qty` of `def` to `out`, merging into a stack with room (never two half stacks of apples). */
function addFungible(out: RolledFungible[], def: string, qty: number): void {
  const d = itemDef(def);
  if (!d || qty <= 0) return;
  const prev = out.find((o) => o.def === def && o.qty + qty <= d.stack);
  if (prev) prev.qty += qty;
  else out.push({ def, qty: Math.min(qty, d.stack), rarity: d.rarity });
}

/**
 * Contents of static container `idx` for this match, fungibles only. Rolled lazily on first open
 * (critique) and deterministic in (matchSeed, idx) alone, so the order containers are opened in
 * never changes what is inside, and a ledger audit can re-roll any container. Draw order: fill roll,
 * then per roll an empty roll and a pickWeighted over containerLootFor(spot). Same-def rolls merge
 * up to the def's stack size.
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
  const table = containerLootFor({ kind: spot.kind, tier });
  if (table.length === 0) return [];
  const out: RolledFungible[] = [];
  for (let i = 0; i < CONTAINER.ROLLS[tier]!; i++) {
    if (rng() < CONTAINER.EMPTY_CHANCE) continue;
    const e = pickWeighted(rng, table);
    addFungible(out, e.def, e.qty);
  }
  return out;
}

// ---------------------------------------------------------------- floor loot (MapData.lootSpots)

/** One weighted floor-loot entry (one ground stack). */
export interface FloorLootEntry {
  def: string;
  qty: number;
  weight: number;
}

/**
 * Loose floor loot, v4 (moved here from the game server's match.ts). Most spots stay empty: each
 * spot spawns with SPAWN_CHANCE[spot.tier], then rolls its tier's table. Loot spots are tier 0 in
 * the wilds, tier zone−1 outdoors in a POI and the zone tier indoors, so floor loot concentrates
 * inside contested buildings. Per match (Steppe): wilds ≈ 9 items / ≈ 200 CR-eq (was 185 items /
 * 15.6k), whole map ≈ 3.5k CR-eq of consumables (was 46k), medkits only on tier 3/4 spots (≈ 2.6).
 * Demo mode: the common floor gun only on spots of tier >= DEMO_GUN_MIN_TIER.
 */
export const FLOOR_LOOT = {
  SPAWN_CHANCE: [0.05, 0.12, 0.2, 0.4, 0.45] as readonly number[],
  /** Tiers 0–1. */
  LOW: [
    { def: "ammo_light", qty: 10, weight: 45 }, { def: "ammo_shell", qty: 4, weight: 20 },
    { def: "bandage", qty: 1, weight: 15 }, { def: "junk_apple", qty: 1, weight: 10 },
    { def: "junk_bolts", qty: 1, weight: 10 },
  ] as readonly FloorLootEntry[],
  /** Tier 2. */
  MID: [
    { def: "ammo_light", qty: 15, weight: 40 }, { def: "ammo_shell", qty: 5, weight: 20 },
    { def: "ammo_heavy", qty: 5, weight: 5 }, { def: "bandage", qty: 1, weight: 12 },
    { def: "junk_wires", qty: 1, weight: 10 }, { def: "junk_pills", qty: 1, weight: 5 },
  ] as readonly FloorLootEntry[],
  /** Tiers 3–4. */
  HIGH: [
    { def: "ammo_light", qty: 30, weight: 35 }, { def: "ammo_shell", qty: 10, weight: 18 },
    { def: "ammo_heavy", qty: 10, weight: 12 }, { def: "bandage", qty: 1, weight: 20 },
    { def: "medkit", qty: 1, weight: 8 }, { def: "junk_battery", qty: 1, weight: 7 },
  ] as readonly FloorLootEntry[],
  /** Demo mode: chance of a common rifle/shotgun instead, on spots of tier >= DEMO_GUN_MIN_TIER. */
  DEMO_GUN_CHANCE: 0.1,
  DEMO_GUN_MIN_TIER: 3,
} as const;

/** The floor table of a loot spot tier (LOW for 0–1, MID for 2, HIGH for 3–4). */
export function floorLootTable(tier: number): readonly FloorLootEntry[] {
  return tier <= 1 ? FLOOR_LOOT.LOW : tier === 2 ? FLOOR_LOOT.MID : FLOOR_LOOT.HIGH;
}

/**
 * Floor loot of one spot: a spawn roll, then (if it spawned) a pickWeighted over the tier's table.
 * Uses the caller's match rng (two draws when it spawns, one otherwise). null = nothing spawns.
 */
export function rollFloorLoot(rng: Rng, tier: number): { def: string; qty: number } | null {
  const t = Math.max(0, Math.min(4, Math.floor(tier)));
  if (rng() >= FLOOR_LOOT.SPAWN_CHANCE[t]!) return null;
  const e = pickWeighted(rng, floorLootTable(t));
  return { def: e.def, qty: e.qty };
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
  /**
   * v4: items released per match = round(RISK_K × riskUnits), capped. K = 1.0 (was 1.5): container
   * uniques never exceed the gear at stake, and a lobby of free kits gets none. If the pool swells,
   * raise K to 1.25 or MAX to 10 (economy memo §13); never reintroduce a free floor.
   */
  RISK_K: 1.0,
  MAX_PER_MATCH: 8,
  /** 1% of the value entering the pool accrues to the treasury. */
  TAX_SHARE: 0.01,
  /**
   * Boss display top-up (poolReleasePlanV4): bosses that spawned get their poolSlots filled even
   * beyond the risk count, but only when someone in the lobby risked gear (riskUnits >=
   * BOSS_MIN_RISK) and the pool keeps more than BOSS_MIN_POOL items after the risk release.
   * Unlooted boss items return to the pool with no wear (leftOnMap): on display, not minted.
   */
  BOSS_MIN_RISK: 1,
  BOSS_MIN_POOL: 150,
  /** Container uniques only in containers of at least this tier (T3 elevator, T4 radar). */
  CONTAINER_MIN_TIER: 3,
  /** A container within this distance of a BossSpot is "guarded"… */
  GUARDED_RADIUS_PX: 1600,
  /** …and gets this weight multiplier in planAllocation (≈ 68 % of container uniques on the Steppe). */
  GUARDED_WEIGHT: 4,
  /** @deprecated v4 removed the free release floor (0 = risk-only); kept for the legacy poolReleasePlan. */
  MIN_RELEASE_PER_MATCH: 0,
  /** @deprecated v4: use BOSS_MIN_POOL. */
  FLOOR_MIN_POOL: 150,
  /** @deprecated v4: use CONTAINER_MIN_TIER. */
  FLOOR_MIN_TIER: 3,
  /** @deprecated v4: boss slots come from BOSSES[kind].poolSlots (raidBossSlots). */
  BOSS_SHARE: 2,
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
 * @deprecated v4 — use poolReleasePlanV4. Legacy shape: the risk count topped up to `minRelease`
 * (default POOL.MIN_RELEASE_PER_MATCH = 0, i.e. risk-only) while the pool stays above
 * FLOOR_MIN_POOL.
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
 * Pool items released into one match, v4 ("risk drives reward"). P = pool size, R = riskUnits,
 * B = bossNeed (Σ poolSlots of the bosses that spawned, raidBossSlots):
 *   risk  = min(P, MAX_PER_MATCH, round(RISK_K × R))
 *   gate  = R >= BOSS_MIN_RISK && P − risk > BOSS_MIN_POOL
 *   boss  = gate ? max(0, min(B, MAX_PER_MATCH) − risk) : 0     (display top-up for bosses only)
 *   total = risk + boss
 * Allocation: boss slots first (best tier score), the rest of `risk` to T3/T4 containers. A free-kit
 * lobby (R = 0) gets nothing, not even on its bosses.
 */
export function poolReleasePlanV4(
  poolSize: number,
  riskUnits: number,
  bossNeed: number,
): { total: number; risk: number; boss: number } {
  const P = Math.max(0, Math.floor(poolSize));
  const R = Math.max(0, riskUnits);
  const risk = poolReleaseCount(P, R);
  const gate = R >= POOL.BOSS_MIN_RISK && P - risk > POOL.BOSS_MIN_POOL;
  const boss = gate ? Math.max(0, Math.min(Math.max(0, Math.floor(bossNeed)), POOL.MAX_PER_MATCH) - risk) : 0;
  return { total: risk + boss, risk, boss };
}

/**
 * Pool tier score of a unique: 2 = top (weapon of rarity >= 2, armor_3, backpack_3), 1 = rare
 * (weapon r1, armor_2, backpack_2), 0 = everything else (incl. non-uniques). Boss slots are filled
 * `order by tier score desc, random()`, falling back to the best available.
 */
export function uniqueTierScore(def: string, rarity: number): 0 | 1 | 2 {
  const d = itemDef(def);
  if (!d?.unique) return 0;
  if (d.cat === "weapon") return rarity >= 2 ? 2 : rarity >= 1 ? 1 : 0;
  const lvl = d.cat === "armor" ? d.armorLevel : d.cat === "backpack" ? d.bpLevel : undefined;
  return lvl === 3 ? 2 : lvl === 2 ? 1 : 0;
}

/** Container kinds that may hold a pool unique (no fridge / PC / med case, no wild stash). */
export const POOL_CONTAINER_KINDS: readonly ContainerKind[] = ["crate", "toolbox", "weapon_box", "safe"];

/** True when the container lies within POOL.GUARDED_RADIUS_PX of any of `bosses` (BossSpot x/y). */
export function containerGuarded(c: { x: number; y: number }, bosses: ReadonlyArray<{ x: number; y: number }>): boolean {
  const r2 = POOL.GUARDED_RADIUS_PX * POOL.GUARDED_RADIUS_PX;
  return bosses.some((b) => (b.x - c.x) * (b.x - c.x) + (b.y - c.y) * (b.y - c.y) <= r2);
}

/** May a pool unique be placed in this container (kind in POOL_CONTAINER_KINDS, tier >= CONTAINER_MIN_TIER)? */
export function poolContainerEligible(c: { kind: ContainerKind; tier: number }): boolean {
  return c.tier >= POOL.CONTAINER_MIN_TIER && POOL_CONTAINER_KINDS.includes(c.kind);
}

/** planAllocation weight of an eligible container: (tier + 1)² × (guarded ? GUARDED_WEIGHT : 1). */
export function poolContainerWeight(c: { tier: number; guarded?: boolean }): number {
  return (c.tier + 1) * (c.tier + 1) * (c.guarded ? POOL.GUARDED_WEIGHT : 1);
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

// ---------------------------------------------------------------- bosses (v4: top loot on bosses)

/** A boss guard's kit. Its gear is FREE (vanishes on death); it drops rollGuardLoot. */
export interface BossGuardDef {
  weapon: WeaponId;
  rarity: Rarity;
  /** Armor level 0..3 (0 = none). */
  armor: 0 | 1 | 2 | 3;
  hp: number;
}

/** One boss-only junk roll: `qty` of `def` with `chance`. */
export interface BossJunkRoll {
  def: string;
  qty: number;
  chance: number;
}

export interface BossDef {
  kind: BossKind;
  /** Display name (Player.nickname of the boss). */
  name: string;
  /** Display name of its guards. */
  guardName: string;
  /** false = the boss never spawns (rollBossSpawns still draws for it, so others do not shift). */
  enabled: boolean;
  /** Spawn chance per match (= BOSS_CHANCE[kind], copied into BossSpot.chance by the generator). */
  spawnChance: number;
  /** Max HP (above PLAYER.MAX_HP: needs the per-runtime maxHp; heals cap at this). */
  hp: number;
  /** Armor level 1..3; the boss's armor is FREE (vanishes), so no pool item ever breaks on it. */
  armor: 1 | 2 | 3;
  /** Weapon it uses when no pool weapon sits in its bag (FREE). */
  weapon: WeaponId;
  weaponRarity: Rarity;
  guards: readonly BossGuardDef[];
  /**
   * Pool slots, one per entry: the minimum uniqueTierScore wanted for that slot (fallback: best
   * available). Filled first by allocatePool (key bossLootKey(kind)), never break on death.
   */
  poolSlots: readonly (0 | 1 | 2)[];
  /** Boss-only junk (rollBossJunk), the only map source of cold wallets. */
  junk: readonly BossJunkRoll[];
  /** Meds it carries (uses medkits below BOSS_AI.HEAL_BELOW_FRAC; leftovers drop, non-FREE). */
  meds: { medkit: number; bandage: number };
  /** Rounds of its weapon's ammo it carries (leftovers drop, non-FREE). */
  ammo: number;
}

/**
 * The three Steppe bosses (scratchpad design §2). Spawn is rolled once per match from the match
 * seed (rollBossSpawns), never respawns, never extracts, never loots. Effective HP (damage to kill,
 * effectiveHp): Commander 580, Foreman 430, Warden 312.
 * Boss junk EV: Commander ≈ 2,980 CR, Foreman ≈ 2,150 CR, Warden ≈ 925 CR.
 */
export const BOSSES: Readonly<Record<BossKind, BossDef>> = {
  commander: {
    kind: "commander", name: "Commander", guardName: "Radar guard", enabled: true,
    spawnChance: BOSS_CHANCE.commander, hp: 400, armor: 3, weapon: "rifle", weaponRarity: 2,
    guards: [
      { weapon: "rifle", rarity: 1, armor: 2, hp: 120 },
      { weapon: "rifle", rarity: 1, armor: 2, hp: 120 },
      { weapon: "sniper", rarity: 0, armor: 1, hp: 120 },
    ],
    poolSlots: [2, 1, 1],
    junk: [
      { def: "junk_coldwallet", qty: 1, chance: 0.35 }, { def: "junk_gpu", qty: 1, chance: 0.5 },
      { def: "junk_goldchain", qty: 1, chance: 0.6 }, { def: "junk_keycard", qty: 1, chance: 1 },
    ],
    meds: { medkit: 2, bandage: 0 },
    ammo: 90,
  },
  foreman: {
    kind: "foreman", name: "Foreman", guardName: "Elevator thug", enabled: true,
    spawnChance: BOSS_CHANCE.foreman, hp: 300, armor: 2, weapon: "shotgun", weaponRarity: 1,
    guards: [
      { weapon: "rifle", rarity: 0, armor: 1, hp: 110 },
      { weapon: "shotgun", rarity: 0, armor: 1, hp: 110 },
    ],
    poolSlots: [2, 1],
    junk: [
      { def: "junk_goldchain", qty: 1, chance: 0.6 }, { def: "junk_gpu", qty: 1, chance: 0.35 },
      { def: "junk_keycard", qty: 1, chance: 0.5 }, { def: "junk_hdd", qty: 2, chance: 1 },
    ],
    meds: { medkit: 1, bandage: 0 },
    ammo: 30,
  },
  warden: {
    kind: "warden", name: "Warden", guardName: "Depot watchman", enabled: true,
    spawnChance: BOSS_CHANCE.warden, hp: 250, armor: 1, weapon: "shotgun", weaponRarity: 0,
    guards: [
      { weapon: "rifle", rarity: 0, armor: 0, hp: 100 },
      { weapon: "pistol", rarity: 0, armor: 0, hp: 100 },
    ],
    poolSlots: [1],
    junk: [
      { def: "junk_goldchain", qty: 1, chance: 0.4 }, { def: "junk_keycard", qty: 1, chance: 0.3 },
      { def: "junk_battery", qty: 3, chance: 1 },
    ],
    meds: { medkit: 0, bandage: 2 },
    ammo: 20,
  },
};

/** Boss / guard AI tuning (server sim/boss.ts). */
export const BOSS_AI = {
  /** Aim sloppiness (regular bots 0.85–1.25). */
  BOSS_SLOPPINESS: 0.7,
  GUARD_SLOPPINESS: 0.85,
  REACT_MS: [300, 550] as readonly [number, number],
  /** Leash around the BossSpot (boss) / the guard's post (guards). */
  LEASH_BOSS_PX: 600,
  LEASH_GUARD_PX: 900,
  /** A gunshot within this distance of a group member alerts the whole group… */
  ALERT_HEAR_PX: 1200,
  /** …for this long, with the last-known position. */
  ALERT_MS: 25_000,
  /** The boss heals (medkit) below this HP fraction. */
  HEAL_BELOW_FRAC: 0.5,
  /** PMC bots drop any goal within this distance of a living boss. */
  BOT_AVOID_PX: 1500,
  /** Boss and guard bags are exempt from BREAK_CHANCE_ON_DEATH. */
  NO_BREAK: true,
} as const;

/** Salt of the boss spawn roll: mulberry32(matchSeed ^ BOSS_SALT). */
export const BOSS_SALT = 0xb055_5a17;

/**
 * Which of the map's boss spots spawn this match. One draw per spot in array order (also for a
 * disabled boss, so toggling one never shifts the others): spawned when BOSSES[kind].enabled and
 * the draw < spot.chance. Deterministic in matchSeed: the matchmaking room (raids/start bosses[])
 * and the match setup must call it with the same seed and get the same answer.
 */
export function rollBossSpawns(matchSeed: number, spots: readonly BossSpot[]): BossSpot[] {
  const rng = mulberry32((matchSeed ^ BOSS_SALT) >>> 0);
  const out: BossSpot[] = [];
  for (const s of spots) {
    const r = rng();
    if (BOSSES[s.kind]?.enabled && r < s.chance) out.push(s);
  }
  return out;
}

/** RaidStartRequest.bosses for the spawned bosses: their poolSlots (min tier scores). */
export function raidBossSlots(spawned: ReadonlyArray<{ kind: BossKind }>): Array<{ kind: BossKind; slots: number[] }> {
  return spawned.map((b) => ({ kind: b.kind, slots: [...BOSSES[b.kind].poolSlots] }));
}

/** Σ pool slots of the spawned bosses (poolReleasePlanV4's bossNeed; legacy RaidStartRequest.bossSlots). */
export function bossSlotCount(bosses: ReadonlyArray<{ slots: readonly number[] }>): number {
  return bosses.reduce((n, b) => n + b.slots.length, 0);
}

function bossRng(matchSeed: number, kind: BossKind, salt: number): Rng {
  const k = BOSS_KINDS.indexOf(kind) + 1;
  return mulberry32((Math.imul((matchSeed ^ BOSS_SALT) >>> 0, 0x01000193) ^ Math.imul(k * 31 + salt, 0x85ebca6b)) >>> 0);
}

/** Boss-only junk on the boss's corpse: one draw per BOSSES[kind].junk entry; deterministic in (matchSeed, kind). */
export function rollBossJunk(matchSeed: number, kind: BossKind): RolledFungible[] {
  const rng = bossRng(matchSeed, kind, 0);
  const out: RolledFungible[] = [];
  for (const j of BOSSES[kind].junk) if (rng() < j.chance) addFungible(out, j.def, j.qty);
  return out;
}

/**
 * Non-FREE drop of guard `guardIdx` of `kind` standing in a `tier` zone: one roll of the tier's
 * crate table (containerLootFor), one pickup of its weapon's ammo (light 30 / shells 10 / heavy 10)
 * and one bandage. Its own gear is FREE and vanishes. Deterministic in (matchSeed, kind, guardIdx).
 */
export function rollGuardLoot(matchSeed: number, kind: BossKind, guardIdx: number, tier: number): RolledFungible[] {
  const rng = bossRng(matchSeed, kind, 1 + guardIdx);
  const out: RolledFungible[] = [];
  const table = containerLootFor({ kind: "crate", tier });
  if (table.length > 0) {
    const e = pickWeighted(rng, table);
    addFungible(out, e.def, e.qty);
  }
  const g = BOSSES[kind].guards[guardIdx];
  if (g) addFungible(out, ammoDefOf(g.weapon), GUARD_AMMO[WEAPONS[g.weapon].ammo]);
  addFungible(out, "bandage", 1);
  return out;
}
const GUARD_AMMO = { light: 30, shell: 10, heavy: 10 } as const;

/**
 * Damage needed to kill `hp` behind fresh armor of `armorLevel` (ARMOR absorb / durability):
 * the armor takes `absorb` of each hit until its points run out, the rest goes to HP.
 */
export function effectiveHp(hp: number, armorLevel: 0 | 1 | 2 | 3): number {
  if (armorLevel === 0) return hp;
  const a = ARMOR[armorLevel];
  const hpWhileArmored = (a.durability / a.absorb) * (1 - a.absorb);
  return hp <= hpWhileArmored ? hp / (1 - a.absorb) : hp + a.durability;
}

/** Spawn-kit light ammo of every bot (FREE: vanishes, never extracts; humans keep FREE_KIT). */
export const BOT_FREE_AMMO_LIGHT = 90;

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
