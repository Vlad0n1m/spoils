/**
 * Economy v2.1 constants and pure functions (economy memo, trimmed per critique).
 * Two currencies:
 * - CR: soft, in-game only, never converts to money. Junk autosell, trader consumables, fees.
 * - market money: the existing custodial `users.balance_cents` unit ("minor" units, bigint);
 *   listings, trades and fees use it. The display label (SOL / USDC / iDos) is Vlad's call.
 * DB durability is a percentage 0..100 plus max_durability; in a raid InvItem.dur is weapon % or
 * armor absorb points — convert at the API boundary with armorPoints / armorPct.
 * REPAIR and SCRAP are cut for v2 (cut list 2): exported but unused. BOUND_OFFERS is live since
 * the v5 review (bound gear for CR, apps/web market/trader.ts buyBound).
 * Junk values, DOG_TAG and dogTagCr live in item-defs.ts (one source for the server and the API).
 * LOOT ECONOMY v4 ("risk drives reward"): CONTAINER / CONTAINER_LOOT / containerLootFor zone the
 * fungibles by tier, FLOOR_LOOT / rollFloorLoot replace the server's flat floor table, the pool
 * releases round(1.0 × riskUnits) with a boss-only top-up (poolReleasePlanV4), and BOSSES carry
 * the top pool items and the high-value junk.
 */

import { ALPHA_LOOT } from "./alpha-loot.js";
import { DOG_TAG, ammoDefOf, dogTagCr, itemDef } from "./item-defs.js";
import { ARMOR, WEAPONS, type Rarity, type WeaponId } from "./items.js";
import { BOSS_CHANCE } from "./map/steppe.js";
import { BOSS_KINDS, type BossKind, type BossSpot, type ContainerKind, type LootTier } from "./map/types.js";
import { mulberry32, pickWeighted, type Rng } from "./rng.js";
import type { ExitType } from "./types.js";

export const CR = { CODE: "CR", START_BALANCE: 1000 } as const;

// ---------------------------------------------------------------- junk autosell

/**
 * Junk autosell regulator. Re-tuned 04.10 for the paid starter kit (design §25): the band 400–900 CR on
 * the geared veterans' median, ±5 %/day, 0.4..1.0. The old band (2 000–8 000, ×0.6..1.3) never bit: the
 * median veteran sits at ≈ 1 000–1 900 CR while the CR surplus piles up in a rich tail, so the regulator
 * pushed autosell UP to 1.3 and CR inflow / outflow ran at 1.5. Never above ×1: the regulator only
 * drains. A stored multiplier outside the range is clamped on the next step.
 */
export const AUTOSELL = { BAL_LO: 400, BAL_HI: 900, STEP: 0.05, MIN: 0.4, MAX: 1.0, MIN_SAMPLE: 50 } as const;

/** Daily regulator: veterans' median CR balance steers the autosell multiplier (±STEP a day, clamped to MIN..MAX). */
export function nextAutosellMult(cur: number, veteranMedianCr: number, sample: number): number {
  const c = Math.min(AUTOSELL.MAX, Math.max(AUTOSELL.MIN, cur));
  if (sample < AUTOSELL.MIN_SAMPLE) return c;
  if (veteranMedianCr > AUTOSELL.BAL_HI) return Math.max(AUTOSELL.MIN, c * (1 - AUTOSELL.STEP));
  if (veteranMedianCr < AUTOSELL.BAL_LO) return Math.min(AUTOSELL.MAX, c * (1 + AUTOSELL.STEP));
  return c;
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
 *   Empty rate ≈ 1 − FILL × (1 − EMPTY^ROLLS): T0 ≈ 85 %, T1 62 %, T2 58 %, T3 17 %, T4 12 %.
 *   ALPHA LOOT (alpha-loot.ts, on by default) replaces FILL_CHANCE / EMPTY_CHANCE with its own and
 *   adds weapons / gear: then T0 ≈ 58 %, T1 37 %, T2 27 %, T3 7 %, T4 2 % stay empty (Steppe ≈ 29 %, v4 ≈ 54 %).
 * - JUNK_VALUE_CAP: junk entries whose unit value is above the tier cap are dropped from the table
 *   (weights renormalise over what is left; the draw count stays the same).
 * - AMMO_QTY_MULT: ammo stacks are scaled, qty = max(1, round(qty × mult)) (30 → 10 rounds in T0).
 * - MEDKIT_MIN_TIER: medkits come only from T3/T4 containers.
 * v5 tuning (NPC model iteration 2, loot-yield harness): T0 FILL 0.25 → 0.18 (rat ≤ 120 CR / ≤ 40 CR-eq
 * consumables), T3/T4 AMMO_QTY_MULT 0.67 / 0.5 → 0.25 / 0.2 (T3/T4 consumable surplus).
 * Model EV per container (junk CR / consumables CR-eq): T0 5.2 / 0.6, T1 12.8 / 1.0,
 * T2 19.2 / 2.1, T3 169 / 10, T4 173 / 23. Per match: ≈ 20k junk CR (was 77k), ≈ 79 % of it in
 * the elevator and the radar base; ≈ 1.9k CR-eq of consumables (v4 2.4k, pre-v4 13.1k).
 * v5 iteration 2 (lever K3 + the T3/T4 follow-up, with the CONTAINER_LOOT medical / heavy-ammo cuts
 * and the FLOOR_LOOT T3/T4 cut): T3/T4 AMMO_QTY_MULT 0.25 / 0.2 → 0.15 / 0.1. With one radar squad
 * fewer (C4) the T3/T4 looter loots the radar base freely, so K3 alone left it at found − used
 * +14; these cuts take it to ≈ −97 (target ≤ −100) without touching the rifle (light) ammo a boss
 * hunter lives on. Do not cut the T0–T2 values: that drops the T2 looter below 250 CR (K1 / K2).
 * Model EV after iteration 2 (junk CR / consumables CR-eq): T0 5.3 / 0.4, T1 13.0 / 0.8,
 * T2 20.7 / 1.1, T3 176 / 3.8, T4 191 / 6.1; per match ≈ 21.3k junk CR (80 % in the elevator and
 * the radar base), ≈ 0.69k CR-eq of consumables.
 */
export const CONTAINER = {
  ROLLS: [1, 1, 1, 2, 2] as readonly number[],
  FILL_CHANCE: [0.18, 0.45, 0.5, 0.85, 0.9] as readonly number[],
  /** Chance an individual roll is empty. */
  EMPTY_CHANCE: 0.15,
  /** Max junk unit value (CR) a container of this tier can hold. */
  JUNK_VALUE_CAP: [55, 55, 110, Infinity, Infinity] as readonly number[],
  /** Ammo stack multiplier by tier. */
  AMMO_QTY_MULT: [0.34, 0.5, 0.5, 0.15, 0.1] as readonly number[],
  /** Medkits only in containers of at least this tier. */
  MEDKIT_MIN_TIER: 3,
  /** Weapons v2: hand grenades only in containers of at least this tier (WEAPONS_V2 §7). */
  GRENADE_MIN_TIER: 2,
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
 * Steppe). Per-tier filtering and ammo scaling: containerLootFor. Uniques never come from here (ALPHA
 * LOOT mints its own, alpha-loot.ts): in
 * live mode they come only from the lost pool (WORLD v6: placed by the server, D18), in demo mode from
 * CHEST_TABLES (tier >= CONTAINER.DEMO_UNIQUE_MIN_TIER).
 */
export const CONTAINER_LOOT: Readonly<Record<ContainerKind, readonly ContainerLootEntry[]>> = {
  // Generic cache: village + industrial junk, a little ammo.
  crate: [
    { def: "junk_apple", weight: 100, qty: 1 }, { def: "junk_water", weight: 80, qty: 1 },
    { def: "junk_canned", weight: 70, qty: 1 }, { def: "junk_bolts", weight: 90, qty: 1 },
    { def: "junk_wires", weight: 60, qty: 1 }, { def: "junk_battery", weight: 40, qty: 1 },
    { def: "junk_fuel", weight: 25, qty: 1 },
    // Weapons v2: bolts (4) replace part of the light ammo (40 → 36); the table weight stays 537.
    { def: "ammo_light", weight: 36, qty: 30 }, { def: "ammo_shell", weight: 20, qty: 10 },
    { def: "bandage", weight: 12, qty: 1 }, { def: "ammo_bolt", weight: 4, qty: 6 },
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
  // v5 iteration 2: medical weights cut here (bandage 40 → 10, medkit 8 → 2, pills 50 → 100: the
  // radar base's many med cases were 70 % of its consumables), in crate (bandage 25 → 12) and in
  // stash (bandage 15 → 8).
  med_case: [
    { def: "bandage", weight: 10, qty: 1 }, { def: "medkit", weight: 2, qty: 1 },
    { def: "junk_pills", weight: 100, qty: 1 },
  ],
  // Military.
  weapon_box: [
    // v5 iteration 2: heavy (sniper) ammo 15 → 8: high CR-eq, no use to the rifle / shotgun kits.
    // Weapons v2: bolts 4 and grenades 4 (T2+ only, GRENADE_MIN_TIER) replace light 40 → 36 and
    // shells 25 → 21; the table weight stays 148 (value per tier: docs/WEAPONS_V2.md §6).
    { def: "ammo_light", weight: 36, qty: 30 }, { def: "ammo_shell", weight: 21, qty: 10 },
    { def: "ammo_heavy", weight: 8, qty: 10 }, { def: "junk_bolts", weight: 30, qty: 1 },
    { def: "junk_battery", weight: 40, qty: 1 }, { def: "junk_keycard", weight: 5, qty: 1 },
    { def: "ammo_bolt", weight: 4, qty: 6 }, { def: "grenade", weight: 4, qty: 1 },
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
    { def: "bandage", weight: 8, qty: 1 },
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
      if (d.cat === "throwable" && tier < CONTAINER.GRENADE_MIN_TIER) continue;
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
 * up to the def's stack size. `opts.alpha` (ALPHA LOOT, alpha-loot.ts) uses ALPHA_LOOT.FILL_CHANCE /
 * EMPTY_CHANCE instead (same draws, same tables); without it the roll is exactly the v4 one.
 */
export function rollContainerFungibles(
  matchSeed: number,
  idx: number,
  spot: { kind: ContainerKind; tier: LootTier },
  opts: { alpha?: boolean } = {},
): RolledFungible[] {
  // Mix seed and index (FNV-style) so neighbouring indexes get unrelated streams.
  const rng = mulberry32((Math.imul((matchSeed ^ 0x9e3779b9) >>> 0, 0x01000193) ^ Math.imul(idx + 1, 0x85ebca6b)) >>> 0);
  const tier = Math.max(0, Math.min(4, spot.tier));
  const fill = opts.alpha ? ALPHA_LOOT.FILL_CHANCE : CONTAINER.FILL_CHANCE;
  const emptyChance = opts.alpha ? ALPHA_LOOT.EMPTY_CHANCE : CONTAINER.EMPTY_CHANCE;
  if (rng() >= fill[tier]!) return [];
  const table = containerLootFor({ kind: spot.kind, tier });
  if (table.length === 0) return [];
  const out: RolledFungible[] = [];
  for (let i = 0; i < CONTAINER.ROLLS[tier]!; i++) {
    if (rng() < emptyChance) continue;
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
 * 15.6k), whole map ≈ 1.9k CR-eq of consumables (v4 3.5k, pre-v4 46k), medkits only on tier 3/4
 * spots (≈ 1.0). v5 tuning: SPAWN_CHANCE [0.05, 0.12, 0.2, 0.4, 0.45] → [0.03, 0.1, 0.16, 0.15, 0.2]
 * (rat yield, T2 / T3 / T4 consumable surplus; wilds ≈ 6 items). v5 iteration 2 (K3): T3/T4
 * 0.15 / 0.2 → 0.1 / 0.12, and HIGH heavy ammo 12 → 6, bandage 20 → 10, medkit 8 → 4 (whole map
 * ≈ 1.5k CR-eq, medkits ≈ 0.33 per match).
 * Demo mode: the common floor gun only on spots of tier >= DEMO_GUN_MIN_TIER.
 */
export const FLOOR_LOOT = {
  SPAWN_CHANCE: [0.03, 0.1, 0.16, 0.1, 0.12] as readonly number[],
  /** Tiers 0–1. */
  LOW: [
    { def: "ammo_light", qty: 10, weight: 45 }, { def: "ammo_shell", qty: 4, weight: 20 },
    { def: "bandage", qty: 1, weight: 15 }, { def: "junk_apple", qty: 1, weight: 10 },
    { def: "junk_bolts", qty: 1, weight: 10 },
  ] as readonly FloorLootEntry[],
  /** Tier 2. Weapons v2: bolts 3 replace light 40 → 37 (weight 92 kept). */
  MID: [
    { def: "ammo_light", qty: 15, weight: 37 }, { def: "ammo_shell", qty: 5, weight: 20 },
    { def: "ammo_heavy", qty: 5, weight: 5 }, { def: "bandage", qty: 1, weight: 12 },
    { def: "junk_wires", qty: 1, weight: 10 }, { def: "junk_pills", qty: 1, weight: 5 },
    { def: "ammo_bolt", qty: 3, weight: 3 },
  ] as readonly FloorLootEntry[],
  /** Tiers 3–4. Weapons v2: bolts 3 + grenade 2 replace light 35 → 32 and shells 18 → 16 (weight 80 kept). */
  HIGH: [
    { def: "ammo_light", qty: 30, weight: 32 }, { def: "ammo_shell", qty: 10, weight: 16 },
    { def: "ammo_heavy", qty: 10, weight: 6 }, { def: "bandage", qty: 1, weight: 10 },
    { def: "medkit", qty: 1, weight: 4 }, { def: "junk_battery", qty: 1, weight: 7 },
    { def: "ammo_bolt", qty: 3, weight: 3 }, { def: "grenade", qty: 1, weight: 2 },
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

/**
 * Weapons v2 (docs/WEAPONS_V2.md §9): guns whose market templates have NO reference price in the
 * market currency yet — Vlad sets them. Until then the demo seed never lists them (apps/web
 * economy/seed.ts npcPriceMinor → null) and the market shows "no reference price yet"; trades still
 * work and build the price index like any template. Remove a gun from here once it is priced.
 */
export const UNPRICED_WEAPONS: ReadonlySet<WeaponId> = new Set<WeaponId>(["smg", "lmg", "revolver", "crossbow"]);

/** Does this market template have a reference price (false = a Weapons v2 gun not priced yet)? */
export function templateRefPriced(template: string): boolean {
  const [cat, w] = template.split(":");
  return !(cat === "weapon" && w !== undefined && UNPRICED_WEAPONS.has(w as WeaponId));
}

/**
 * Every weapon template that exists in live play (WeaponDef.minRarity: no common LMG or crossbow),
 * in WEAPON_IDS × rarity order, with its reference-price status.
 */
export function liveWeaponTemplates(): Array<{ template: TemplateKey; weapon: WeaponId; rarity: Rarity; priced: boolean }> {
  const out: Array<{ template: TemplateKey; weapon: WeaponId; rarity: Rarity; priced: boolean }> = [];
  for (const w of Object.keys(WEAPONS) as WeaponId[]) {
    for (const r of [0, 1, 2, 3] as const) {
      if (r < (WEAPONS[w].minRarity ?? 0)) continue;
      out.push({ template: `weapon:${w}:${r}`, weapon: w, rarity: r, priced: !UNPRICED_WEAPONS.has(w) });
    }
  }
  return out;
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

export type ConsumableId = "bandage" | "medkit" | "ammo_light" | "ammo_shell" | "ammo_heavy" | "ammo_bolt" | "grenade";
/**
 * Junker offers (CR only, never SOL). Weapons v2: bolts and the hand grenade at the CR prices
 * proposed in docs/WEAPONS_V2.md §7 (Vlad to confirm).
 */
export const CONSUMABLES_CR: Readonly<Record<ConsumableId, { qty: number; cr: number }>> = {
  bandage: { qty: 1, cr: 60 },
  medkit: { qty: 1, cr: 220 },
  ammo_light: { qty: 30, cr: 45 },
  ammo_shell: { qty: 10, cr: 60 },
  ammo_heavy: { qty: 10, cr: 110 },
  ammo_bolt: { qty: 5, cr: 90 },
  grenade: { qty: 1, cr: 180 },
};

/**
 * Bound gear for CR (design §15 "[позже] привязанное снаряжение у торговцев", brought forward by the
 * v5 review as the CR sink the economy needs): BOUND_OFFERS sold by the junker's colleagues for CR.
 * A bound item is never listable, never enters the lost pool (destroyed instead) and adds 0 risk
 * units, so CR never leaks into SOL value. Trader level unlocks with the player level (boundTraderLevel).
 */
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
  // Weapons v2 (docs/WEAPONS_V2.md §7.3): CR prices are a proposal for Vlad. LMG and crossbow exist
  // only at rare and above (WeaponDef.minRarity); they fill the empty trader tier 4.
  { trader: "gunsmith", def: "smg", rarity: 0, cr: 1600, traderLevel: 2 },
  { trader: "gunsmith", def: "revolver", rarity: 0, cr: 2400, traderLevel: 3 },
  { trader: "gunsmith", def: "crossbow", rarity: 1, cr: 3600, traderLevel: 4 },
  { trader: "gunsmith", def: "lmg", rarity: 1, cr: 4500, traderLevel: 4 },
];

/**
 * Bound-trader level a player of `level` may buy from: 1–4 → 1, 5–9 → 2, 10–14 → 3, 15+ → 4 (the same
 * bands as the lobby level badge, spec §6.2; the rifle unlocks at level 5).
 */
export function boundTraderLevel(level: number): 1 | 2 | 3 | 4 {
  return Math.max(1, Math.min(4, 1 + Math.floor(Math.max(1, Math.floor(level)) / 5))) as 1 | 2 | 3 | 4;
}

/** The BOUND_OFFERS entry for `def`, or null. */
export function boundOffer(def: string): BoundOffer | null {
  return BOUND_OFFERS.find((o) => o.def === def) ?? null;
}

/**
 * The game's own CR price for `def` at `rarity`: what the bound traders ask for it (the cheapest offer
 * if a def were ever sold twice), or null when no trader sells that def at this rarity or better. A
 * player lot must never cost more CR than the game's own shelf for the same thing (the anti-arbitrage
 * cap of the player market, apps/web lib/market/market.ts), so gear that entered the game outside the
 * CR loop (the iDos edition's SPOILS crates) can't be resold above the trader. A rarer copy than the
 * trader's is not the same thing: an epic rifle is not capped at the common rifle's price and keeps
 * the ordinary market band.
 */
export function traderPriceCap(def: string, rarity = 0): bigint | null {
  let best: number | null = null;
  for (const o of BOUND_OFFERS) if (o.def === def && rarity <= o.rarity && (best === null || o.cr < best)) best = o.cr;
  return best === null ? null : BigInt(best);
}

/**
 * priceBand with the trader cap applied: max = min(band max, cap). If the band's floor sits above the
 * cap (a template whose index outgrew the trader), the floor drops to the cap, so exactly one price,
 * the trader's, stays allowed instead of none. No cap: the band unchanged.
 */
export function capBandAtTrader(
  band: { min: bigint; max: bigint | null },
  cap: bigint | null,
): { min: bigint; max: bigint | null } {
  if (cap === null) return band;
  const max = band.max === null || band.max > cap ? cap : band.max;
  return { min: band.min > max ? max : band.min, max };
}
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
  /**
   * v5 review: a loadout unique adds a risk unit only at this durability % or more (riskUnitOf), so
   * a worn-out 1 % backpack does not open the boss top-up and container release for a lobby.
   */
  RISK_MIN_DUR_PCT: 50,
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
  // ---- WORLD v6: per-entry release (D17), server placement (D18), boss bag (D19).
  /** Shard-cycle cap = min(CYCLE_MAX, CYCLE_BASE + ceil(CYCLE_PER_RISK_USER × riskUsers)). */
  CYCLE_BASE: 4,
  CYCLE_PER_RISK_USER: 0.5,
  CYCLE_MAX: 24,
  /** At most this many pool items released per user per UTC day (across maps and entries). */
  USER_DAILY_MAX: 8,
  /** Late taper: × clamp((entryCloseMs − atMs) / LATE_TAPER_MS, 0, 1). */
  LATE_TAPER_MS: 15 * 60_000,
  /** No release while the map has fewer valid pool targets than this… */
  MIN_TARGETS: 8,
  /** …and at most floor(targets / TARGETS_PER_ITEM) items per entry. */
  TARGETS_PER_ITEM: 3,
  /** Released items are placed this long after the entry (or at the entrant's death). */
  APPLY_AFTER_MS: 8 * 60_000,
  /** A pool target must be at least this far from every living human. */
  PLACE_MIN_HUMAN_PX: 1500,
  /** No valid target → retry this often. */
  PLACE_RETRY_MS: 10_000,
  /** A boss-bag slot may take a top item only while the pool holds more than this many top items. */
  TOP_RESERVE: 20,
  /**
   * Per-entry release never takes the pool below this many items (04.10, design §25): with the paid kit
   * most entries are basic gear, and pool items they capture arrive bound and never come back, so when
   * raiders wait out the 8-minute XP gate the pool drained to its unreleasable top in ≈ 30 days.
   */
  MIN_RESERVE: 150,
  /** The server stows the boss bag only when the boss has not been hit for this long. */
  BOSS_ENGAGED_MS: 60_000,
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
 * Risk units one loadout unique adds to its entry (raids/enter risk_units, v5 review): 1 when losing
 * it would really feed the lost pool — not bound (a bound item is destroyed, never pooled) and at
 * least POOL.RISK_MIN_DUR_PCT durability — else 0. Giveaway items under their trade lock DO count:
 * they enter the pool on death like any other unique (the starter kit is paid, STARTER_KIT).
 */
export function riskUnitOf(it: Pick<EconItem, "bound" | "dur">): 0 | 1 {
  return !it.bound && it.dur >= POOL.RISK_MIN_DUR_PCT ? 1 : 0;
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

/** WORLD v6: inputs of poolReleaseForEntry (web raids/enter, D17). */
export interface EntryReleaseInput {
  poolSize: number;
  /** Risk units of this entry (riskUnitOf sum). */
  entryRisk: number;
  /** Max risk_units of this user's earlier entries this cycle. */
  userCycleMaxRisk: number;
  /** Released by this user's earlier entries this cycle. */
  userCycleReleased: number;
  /** Released by this user today (UTC). */
  userDayReleased: number;
  /** Released on this shard-cycle so far. */
  shardReleased: number;
  /** Distinct users with risk ≥ 1 on this shard, including this entry. */
  riskUsers: number;
  /** Map clock at admission (0 = the map's opening). */
  atMs: number;
  /** Map clock of the entry close: MAP_MS − ENTRY_CLOSE_MS (clock 0 = the map's opening). */
  entryCloseMs: number;
  /** Valid pool targets on the map now (server count). */
  targets: number;
  /** economy_params pool_risk_k (default POOL.RISK_K). */
  k?: number;
  /** economy_params pool_min_reserve (default POOL.MIN_RESERVE). */
  minReserve?: number;
}

const nn = (v: number): number => (Number.isFinite(v) ? Math.max(0, v) : 0);

/**
 * WORLD v6 lost-pool release for one entry (D17). All terms ≥ 0:
 *   budget = round(K × max(userCycleMaxRisk, entryRisk)) − userCycleReleased   (re-entries add nothing)
 *   cap    = min(CYCLE_MAX, CYCLE_BASE + ceil(CYCLE_PER_RISK_USER × riskUsers)) − shardReleased
 *   daily  = USER_DAILY_MAX − userDayReleased
 *   tgt    = targets < MIN_TARGETS ? 0 : floor(targets / TARGETS_PER_ITEM)
 *   taper  = clamp((entryCloseMs − atMs) / LATE_TAPER_MS, 0, 1)
 *   n      = floor(max(0, min(budget, cap, daily, poolSize, tgt)) × taper)
 * The tier match (each item's tier score ≤ the user's max tier risked this cycle) is the caller's pick.
 */
export function poolReleaseForEntry(i: EntryReleaseInput): { n: number; budget: number; cap: number; taper: number } {
  const k = i.k ?? POOL.RISK_K;
  const maxRisk = Math.max(nn(i.userCycleMaxRisk), nn(i.entryRisk));
  const budget = nn(Math.round(k * maxRisk) - nn(i.userCycleReleased));
  const cycleCap = Math.min(POOL.CYCLE_MAX, POOL.CYCLE_BASE + Math.ceil(POOL.CYCLE_PER_RISK_USER * nn(i.riskUsers)));
  const cap = nn(cycleCap - nn(i.shardReleased));
  const daily = nn(POOL.USER_DAILY_MAX - nn(i.userDayReleased));
  const targets = Math.floor(nn(i.targets));
  const tgt = targets < POOL.MIN_TARGETS ? 0 : Math.floor(targets / POOL.TARGETS_PER_ITEM);
  const taper = Math.max(0, Math.min(1, (i.entryCloseMs - i.atMs) / POOL.LATE_TAPER_MS)) || 0;
  const n = Math.floor(nn(Math.min(budget, cap, daily, Math.floor(nn(i.poolSize)) - nn(i.minReserve ?? POOL.MIN_RESERVE), tgt)) * taper);
  return { n, budget, cap, taper };
}

/**
 * WORLD v6 boss bag (D19), once per shard-cycle. n = slots.length when !filled, Σ max risk of the
 * shard's distinct users (shardRiskSum) ≥ slots.length and poolSize − slots.length > BOSS_MIN_POOL;
 * else 0. maxTier: 2 (top allowed) only when some entrant risked a top item and the pool holds more
 * than TOP_RESERVE top items, else 1 (≤ rare); 0 when nothing is filled. maxTop: how many of the n
 * may be top items, so the fill never takes the pool's top tier below TOP_RESERVE (the rest ≤ rare).
 */
export function bossFillPlan(i: {
  slots: readonly number[];
  shardRiskSum: number;
  anyTopRisk: boolean;
  poolSize: number;
  topInPool: number;
  filled: boolean;
}): { n: number; maxTier: 0 | 1 | 2; maxTop: number } {
  const none = { n: 0, maxTier: 0, maxTop: 0 } as const;
  const need = i.slots.length;
  if (i.filled || need === 0) return none;
  if (!(i.shardRiskSum >= need)) return none;
  if (!(i.poolSize - need > POOL.BOSS_MIN_POOL)) return none;
  const top = Number.isFinite(i.topInPool) ? Math.floor(i.topInPool) : 0;
  if (!(i.anyTopRisk && top > POOL.TOP_RESERVE)) return { n: need, maxTier: 1, maxTop: 0 };
  return { n: need, maxTier: 2, maxTop: Math.min(need, top - POOL.TOP_RESERVE) };
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
 * effectiveHp): Commander 313, Foreman 369, Warden 375. v5 tuning (harness boss-kill bands with the
 * marauder squads at the POI): Commander 400 HP / armor 3 → 310 / armor 2 and three rifle guards
 * (armor 1, 100 HP, 80 since iteration 2; the sniper guard is gone; its kill rate is set by the guards and the radar
 * marauders, not by its HP: 250–310 HP all measure ≈ 3 % for a hunter kit), Foreman 300 → 240 HP with rifle + pistol guards
 * (armor 1, 90 HP), Warden 250 → 300 HP. v5 iteration 2 (lever C4, with NPC_CAMPS.radar.squads 2 → 1):
 * Commander 310 / armor 2 → 250 / armor 1 and its guards 100 → 80 HP. 250 HP with 100 HP guards
 * measured 16.4 % on 100 seeds but only 5.9 % on 180 seeds once the K3 loot cuts took the radar
 * floor ammo a hunter refills from; with 80 HP guards a hunter kit kills it in 14.7 % of the raids
 * it spawns in (180 seeds, target 12–25 %, survival 0.59), a starter kit 0 %, a free kit 0 %.
 * (200 HP with 100 HP guards measures the same 14.7 % but would rank the Commander's pool slots
 * below the Foreman's.)
 * web pool.ts rankBossSlots ranks equal pool slots by raw hp: Warden 300 > Commander 250 > Foreman 240.
 * Boss junk EV: Commander ≈ 2,980 CR, Foreman ≈ 2,150 CR, Warden ≈ 925 CR.
 */
export const BOSSES: Readonly<Record<BossKind, BossDef>> = {
  commander: {
    kind: "commander", name: "Commander", guardName: "Radar guard", enabled: true,
    spawnChance: BOSS_CHANCE.commander, hp: 250, armor: 1, weapon: "rifle", weaponRarity: 2,
    // Weapons v2 (WEAPONS_V2 §8): the third guard carries a FREE light machine gun (never drops).
    guards: [
      { weapon: "rifle", rarity: 1, armor: 1, hp: 80 },
      { weapon: "rifle", rarity: 0, armor: 1, hp: 80 },
      { weapon: "lmg", rarity: 0, armor: 1, hp: 80 },
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
    spawnChance: BOSS_CHANCE.foreman, hp: 240, armor: 2, weapon: "shotgun", weaponRarity: 1,
    // Weapons v2 (WEAPONS_V2 §8): the second guard's pistol becomes a FREE revolver.
    guards: [
      { weapon: "rifle", rarity: 0, armor: 1, hp: 90 },
      { weapon: "revolver", rarity: 0, armor: 1, hp: 90 },
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
    spawnChance: BOSS_CHANCE.warden, hp: 300, armor: 1, weapon: "shotgun", weaponRarity: 0,
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
  /**
   * Aim sloppiness (marauders 1.26–2.24, npc.ts MARAUDER). Alpha softening (2026-10, Vlad): boss
   * 0.7 → 0.84 (× 1.2), guards 0.85 → 1.19 (× 1.4), reaction [300, 550] → [500, 750] ms.
   */
  BOSS_SLOPPINESS: 0.84,
  GUARD_SLOPPINESS: 1.19,
  REACT_MS: [500, 750] as readonly [number, number],
  /** Leash around the BossSpot (boss) / the guard's post (guards). */
  LEASH_BOSS_PX: 600,
  LEASH_GUARD_PX: 900,
  /** A gunshot within this distance of a group member alerts the whole group… */
  ALERT_HEAR_PX: 1200,
  /** …for this long, with the last-known position. */
  ALERT_MS: 25_000,
  /** The boss heals (medkit) below this HP fraction. */
  HEAL_BELOW_FRAC: 0.5,
  /**
   * @deprecated NPC MODEL v5 removed the PMC player-bots that used it; delete with the bot code
   * (game-server sim/bot.ts).
   */
  BOT_AVOID_PX: 1500,
  /**
   * @deprecated alias of NPC.NO_BREAK (npc.ts): every NPC role (boss, guard, marauder) is exempt
   * from BREAK_CHANCE_ON_DEATH. Kept for one release.
   */
  NO_BREAK: true,
} as const;

/** Salt of the boss spawn roll: mulberry32(matchSeed ^ BOSS_SALT). */
export const BOSS_SALT = 0xb055_5a17;

/**
 * Which of the map's boss spots spawn this match. One draw per spot in array order (also for a
 * disabled boss, so toggling one never shifts the others): spawned when BOSSES[kind].enabled and
 * the draw < spot.chance. Deterministic in matchSeed. Legacy roster matches and the sim harness only:
 * WORLD v6 spawns exactly the event boss of bossEventOf.
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

// ---------------------------------------------------------------- boss events (WORLD v6, D12–D14)

/**
 * WORLD v6 boss events: exactly one boss map per block of BLOCK_CYCLES cycles; an event boss that
 * took no damage and has no human within its leash returns to full HP after RESET_AFTER_MS.
 */
export const BOSS_EVENT = { BLOCK_CYCLES: 3, RESET_AFTER_MS: 180_000 } as const;

/**
 * Boss fights (docs/GAME_DESIGN.md §7c, server sim/boss-fight.ts + npc.ts): two phases and one
 * signature move per boss. Phase 2 starts once at PHASE2_FRAC of the boss's max HP (announced to the
 * humans within ARENA_PX of the boss: roar + toast) and ends only when the HP reset rule (BOSS_EVENT)
 * puts it back to full. Every move is telegraphed (Player.bossTell) for its TELL_MS before it lands.
 * Index [0] / [1] of a pair = phase 1 / phase 2. Nothing here mints value: thrown grenades come from
 * a FREE stock that is never in the corpse, reinforcements carry only FREE gear (empty corpses).
 */
export const BOSS_FIGHT = {
  PHASE2_FRAC: 0.5,
  /** Humans within this distance of the boss get the phase / call events (toast + roar). */
  ARENA_PX: 1400,
  /** Phase 2: semi-auto press interval × this (never below the weapon's own fire interval)… */
  PHASE2_FIRE_MULT: 0.7,
  /** …and reaction delay × this. */
  PHASE2_REACT_MULT: 0.7,
  /** Foreman: server-authoritative grenades (the shared grenade system: fuse, bounces, walls, warning ring). */
  FOREMAN: {
    TELL_MS: 500,
    COOLDOWN_MS: [10_000, 7_000] as readonly [number, number],
    /** Throws only at a target point this far away (never at its own feet)… */
    MIN_PX: 200,
    /** …and within the hand-grenade range. */
    MAX_PX: 540,
    /** Only at someone it saw within this long (no throwing at sounds). */
    SEEN_MS: 3_000,
    /** FREE grenades per boss life (never in the corpse). */
    STOCK: 5,
  },
  /** Commander: radios for reinforcements once per boss life, in phase 2, while fighting. */
  COMMANDER: {
    TELL_MS: 1_200,
    CALL_COUNT: 2,
    /** FREE-only kit (no rollGuardLoot drop): the corpse holds nothing. */
    GUARD: { weapon: "rifle" as WeaponId, rarity: 0 as Rarity, armor: 1 as const, hp: 80 },
  },
  /** Warden: a telegraphed straight charge, then the shotgun; it ducks into cover between bursts. */
  WARDEN: {
    TELL_MS: 600,
    DASH_MS: 550,
    /** Walking speed × this while dashing (≈ 680 px/s, ≈ 370 px at most; walls and its leash stop it). */
    SPEED_MULT: 2.6,
    /** Charges at a visible target with a clear line between this far… */
    MIN_PX: 170,
    /** …and this far. */
    MAX_PX: 520,
    /** The dash stops this close to the target. */
    STOP_PX: 80,
    COOLDOWN_MS: [8_000, 5_000] as readonly [number, number],
    /** Cover after each shotgun shot before peeking again. */
    COVER_MS: [1_100, 700] as readonly [number, number],
  },
} as const;

/** Player.bossTell: the move a boss is winding up (or running) right now. */
export const BOSS_TELL = { NONE: 0, THROW: 1, CALL: 2, CHARGE: 3, DASH: 4 } as const;
export type BossTell = (typeof BOSS_TELL)[keyof typeof BOSS_TELL];

/** Permanent title granted for killing `kind` (killer + party mates who damaged it), COSMETICS id. */
export function bossTrophyId(kind: BossKind): string {
  return `t-${kind}-slayer`;
}

/** Seeded Fisher–Yates shuffle (mulberry32 of `seed`). */
function shuffleSeeded<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  const rng = mulberry32(seed >>> 0);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = out[i]!;
    out[i] = out[j]!;
    out[j] = t;
  }
  return out;
}

/**
 * The boss of `cycle`, or null. hash(label) → uint32 (the game server passes an HMAC of its world
 * secret; tests pass any deterministic function). Pure; same answer for every caller with the same hash.
 *   kinds = BOSS_KINDS.filter(k => BOSSES[k].enabled); none → null
 *   b = floor(cycle / 3); raw(b) = hash("pos|" + b) % 3
 *   pos(b) = raw(b) === 0 && raw(b − 1) === 2 ? 1 : raw(b)        (no two boss maps in a row)
 *   cycle % 3 !== pos(b) → null
 *   r = floor(b / kinds.length); perm(r) = seeded shuffle of kinds by hash("perm|" + r)
 *   if perm(r)[0] === perm(r − 1)[last] swap perm(r)[0] and perm(r)[1]   (length ≥ 3; the swap never
 *   touches the last element, so perm(r − 1)'s raw shuffle is the one to compare with)
 *   return perm(r)[b % kinds.length]
 * Two enabled kinds alternate (ordered by hash("perm|0")); one enabled kind is every boss map.
 * Gap between boss maps: 2–5 cycles.
 */
export function bossEventOf(cycle: number, hash: (label: string) => number): BossKind | null {
  const kinds = BOSS_KINDS.filter((k) => BOSSES[k].enabled);
  if (kinds.length === 0) return null;
  const B = BOSS_EVENT.BLOCK_CYCLES;
  const c = Math.floor(cycle);
  const b = Math.floor(c / B);
  const raw = (blk: number): number => (hash(`pos|${blk}`) >>> 0) % B;
  const rb = raw(b);
  const pos = rb === 0 && raw(b - 1) === B - 1 ? 1 : rb;
  if (((c % B) + B) % B !== pos) return null;
  const L = kinds.length;
  if (L === 1) return kinds[0]!;
  const idx = ((b % L) + L) % L;
  if (L === 2) {
    const base = shuffleSeeded(kinds, hash("perm|0"));
    return base[idx]!;
  }
  const r = Math.floor(b / L);
  const perm = shuffleSeeded(kinds, hash(`perm|${r}`));
  const prev = shuffleSeeded(kinds, hash(`perm|${r - 1}`));
  if (perm[0] === prev[L - 1]) {
    const t = perm[0]!;
    perm[0] = perm[1]!;
    perm[1] = t;
  }
  return perm[idx]!;
}

/** Legacy allocation input (planAllocation, sim harness): the spawned bosses and their poolSlots. */
export function raidBossSlots(spawned: ReadonlyArray<{ kind: BossKind }>): Array<{ kind: BossKind; slots: number[] }> {
  return spawned.map((b) => ({ kind: b.kind, slots: [...BOSSES[b.kind].poolSlots] }));
}

/** Σ pool slots of the spawned bosses (poolReleasePlanV4's bossNeed). */
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
 * Non-FREE guard drop (NPC MODEL v5 trim: "found < consumed" for every NPC kill): rounds of its
 * weapon's ammo per kind (was 30 / 10 / 10) and a bandage with BANDAGE_CHANCE (was always 1).
 */
export const GUARD_DROP = {
  AMMO: { light: 15, shell: 5, heavy: 5, bolt: 0 } as const,
  BANDAGE_CHANCE: 0.5,
} as const;

/**
 * Non-FREE drop of guard `guardIdx` of `kind` standing in a `tier` zone: one roll of the tier's
 * crate table (containerLootFor), GUARD_DROP.AMMO rounds of its weapon's ammo and a bandage with
 * GUARD_DROP.BANDAGE_CHANCE (that draw comes last, so the crate roll is the same as in v4). Its own
 * gear is FREE and vanishes. Deterministic in (matchSeed, kind, guardIdx).
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
  if (g) addFungible(out, ammoDefOf(g.weapon), GUARD_DROP.AMMO[WEAPONS[g.weapon].ammo]);
  if (rng() < GUARD_DROP.BANDAGE_CHANCE) addFungible(out, "bandage", 1);
  return out;
}

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

/**
 * Giveaway-era rules that outlive the giveaway (economy memo §15.6, design §19): the trade lock on
 * starter-kit items and the world seed. The free bound kit and the 1 000-kit cap are gone (Vlad,
 * 04.10): the starter kit is always paid (STARTER_KIT).
 */
export const GIVEAWAY = {
  /** Raids a starter-kit item must be extracted in (by anyone) before it can be listed (demo: 1). */
  LOCK_RAIDS: 10,
  LOCK_RAIDS_DEMO: 1,
  LEGENDARY_RAFFLE: 20,
  POOL_SEED_KITS: 250,
} as const;

/**
 * The starter kit (Vlad, 04.10: "always paid, 0.05 SOL, several pistols, armor, ammo, bandages and a
 * medkit"). Bought from the market balance to the house (treasury revenue; the game never pays SOL),
 * any number of times up to DAILY_MAX per account per UTC day. The uniques are TRADABLE with the
 * giveaway lock (GIVEAWAY.LOCK_RAIDS extracts before they can be listed), enter the lost pool on
 * death and count as risk units like any unique. No CR comes with it: CR is never sold for SOL. The
 * ammo and meds are CR-shop goods (≈ 640 CR at CONSUMABLES_CR) and cannot be sold back.
 * Value check (§19): 3 common pistols + armor Lv 1 (Lv 2 at 20 %) ≈ 10 primary-price units, the price
 * of the kit when 1 unit ≈ 0.005 SOL; reselling a kit after the lock and the 5 % fee loses money.
 */
export const STARTER_KIT = {
  /** Price in balance_cents (5 = 0.05 SOL, Vlad). Never a tuning lever. */
  PRICE_MINOR: 5,
  /** Kits one account may buy per UTC day (caps market flooding by a single wallet). */
  DAILY_MAX: 3,
  /** Weapons: every entry is one unique. */
  weapons: [
    { def: "pistol", rarity: 0 },
    { def: "pistol", rarity: 0 },
    { def: "pistol", rarity: 0 },
  ],
  armor: [{ def: "armor_1", weight: 80 }, { def: "armor_2", weight: 20 }],
  stacks: [
    { def: "ammo_light", qty: 120 },
    { def: "bandage", qty: 4 },
    { def: "medkit", qty: 1 },
  ],
} as const;

/** Weapon / armor / backpack weights of the world-seed kits (economy/seed.ts, the pool mirror). */
export const SEED_KIT = {
  weapon: [
    { def: "rifle", rarity: 0, weight: 40 },
    { def: "shotgun", rarity: 0, weight: 35 },
    { def: "rifle", rarity: 1, weight: 15 },
    { def: "shotgun", rarity: 1, weight: 10 },
  ],
  armor: [{ def: "armor_1", weight: 80 }, { def: "armor_2", weight: 20 }],
  backpack: [{ def: "backpack_1", weight: 100 }],
} as const;

// ---------------------------------------------------------------- progression

/**
 * WORLD v6 XP (D23), granted only by the web at exit (xpForExit). Extract and haul XP need an
 * extract after ≥ MIN_ONMAP_MS on the map; no XP for time alive or for entering. The grind lines
 * (extract, haul, containers, marauders, guards) are soft-capped per UTC day; boss and ranked PvP
 * kills are not. PVP_PAIR_PER_DAY: ranked kills per (killer, victim) pair per 24 h (D24).
 */
/** WORLD v6 hot zones (world-events.ts HOT.XP_MULT): container XP multiple inside an active hot zone. */
export const HOT_ZONE_XP_MULT = 1.5;

export const XP = {
  EXTRACT_BASE: 100,
  EXTRACT_PER_MIN: 10,
  EXTRACT_MAX_MIN: 25,
  MIN_ONMAP_MS: 8 * 60_000,
  HAUL_CR_PER_XP: 10,
  HAUL_MAX: 150,
  CONTAINER: 2,
  CONTAINER_MAX: 30,
  NPC: 20,
  GUARD: 40,
  /** In-raid objectives (objectives.ts): a room unlocked, a safe cracked, a hidden cache opened. */
  OBJECTIVE: 30,
  /** Objectives that pay per entry (the rest count 0). */
  OBJECTIVE_MAX: 5,
  BOSS: 400,
  PVP: 80,
  PVP_PAIR_PER_DAY: 2,
  /**
   * Ranked PvP (D24, review fix): the victim's account is at least this old and at least
   * PVP_VICTIM_MIN_LEVEL, so fresh unverified alts are never ranked victims (XP and Kills board).
   */
  PVP_VICTIM_MIN_AGE_MS: 72 * 3600_000,
  PVP_VICTIM_MIN_LEVEL: 5,
  /** Ranked kills per killer per UTC day that pay the pvp line (the Kills board counts them all). */
  PVP_DAILY_MAX: 10,
  FIRST_EXTRACT_MAX: 300,
  DAILY_SOFT_CAP: 2_500,
  /** Above the daily cap the activity lines (containers, marauders, guards) pay this share. */
  DAILY_OVER_MULT: 0.25,
  /**
   * Above the daily cap the time lines (extract, haul) pay this share: 0 = a hard cap, so a bot that
   * only hides and extracts all day stops earning once the day's grind is full (review fix).
   */
  DAILY_TIME_OVER_MULT: 0,
} as const;

/**
 * "quest" = daily tasks completed by this exit (quests.ts): added by the web after xpForExit, outside
 * the daily soft cap (xp_grind) and the first-extract bonus; qty = tasks completed.
 */
export type XpKey = "extract" | "haul" | "containers" | "objectives" | "npc" | "guard" | "boss" | "pvp" | "first_extract" | "daily_cap" | "quest";
/** One line of the XP receipt: `qty` units of `key` worth `xp` (daily_cap is negative). */
export interface XpLine {
  key: XpKey;
  qty: number;
  xp: number;
}
export const XP_LINE_LABEL: Readonly<Record<XpKey, string>> = {
  extract: "Extracted",
  haul: "Haul",
  containers: "Containers searched",
  objectives: "Objectives",
  npc: "Marauders",
  guard: "Guards",
  boss: "Boss",
  pvp: "Raiders",
  first_extract: "First extract today",
  daily_cap: "Daily limit",
  quest: "Daily task",
};

export interface XpInput {
  exit: ExitType;
  onMapMs: number;
  /** Junk CR of this exit's autosell receipt, dog tags excluded. */
  haulCr: number;
  /** RaidStats.containersSearched. */
  containers: number;
  /** RaidStats.hotContainers: of those, searched inside an active hot zone (× HOT_ZONE_XP_MULT). Default 0. */
  hotContainers?: number;
  /** RaidStats.objectives: rooms unlocked, safes cracked, caches opened (XP.OBJECTIVE each, ≤ OBJECTIVE_MAX). Default 0. */
  objectives?: number;
  /** npcKillCount(report) − guardKills. */
  marauders: number;
  guards: number;
  bosses: number;
  rankedPvp: number;
  /** Σ raid_exits.xp_grind today (UTC), this entry excluded. */
  grindToday: number;
  firstExtractToday: boolean;
}

const cnt = (v: number): number => (Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0);

/**
 * XP of one exit (D23):
 *   qualifies = exit === "extract" && onMapMs ≥ MIN_ONMAP_MS
 *   extract = qualifies ? EXTRACT_BASE + EXTRACT_PER_MIN × min(EXTRACT_MAX_MIN, floor(onMapMs / 60000)) : 0
 *   haul    = qualifies ? min(HAUL_MAX, floor(haulCr / HAUL_CR_PER_XP)) : 0
 *   containers = CONTAINER × min(CONTAINER_MAX, containers); npc = NPC × marauders; guard = GUARD × guards
 *   objectives = OBJECTIVE × min(OBJECTIVE_MAX, objectives)
 *   (exit "mia": containers = objectives = 0 — D9, a wiped player gets the kill lines only)
 *   time = extract + haul; act = containers + objectives + npc + guard; raw = time + act
 *   room = max(0, DAILY_SOFT_CAP − grindToday); the time lines fill the room first (the split that
 *   pays the player most): timeIn = min(time, room), actIn = min(act, room − timeIn)
 *   grind = timeIn + actIn + floor((time − timeIn) × DAILY_TIME_OVER_MULT) + floor((act − actIn) × DAILY_OVER_MULT)
 *   subtotal = grind + BOSS × bosses + PVP × rankedPvp   (rankedPvp: the caller applies PVP_DAILY_MAX)
 *   first = qualifies && firstExtractToday ? min(FIRST_EXTRACT_MAX, subtotal) : 0
 * Lines: every non-zero term in that order; "daily_cap" = grind − raw (negative) when the cap bit.
 * `grind` is what raid_exits.xp_grind stores (counts toward later grindToday).
 */
export function xpForExit(i: XpInput): { total: number; grind: number; lines: XpLine[] } {
  const onMap = Number.isFinite(i.onMapMs) ? Math.max(0, i.onMapMs) : 0;
  const qualifies = i.exit === "extract" && onMap >= XP.MIN_ONMAP_MS;
  const minutes = Math.min(XP.EXTRACT_MAX_MIN, Math.floor(onMap / 60_000));
  const extract = qualifies ? XP.EXTRACT_BASE + XP.EXTRACT_PER_MIN * minutes : 0;
  const haulCr = cnt(i.haulCr);
  const haul = qualifies ? Math.min(XP.HAUL_MAX, Math.floor(haulCr / XP.HAUL_CR_PER_XP)) : 0;
  const nCont = i.exit === "mia" ? 0 : Math.min(XP.CONTAINER_MAX, cnt(i.containers));
  // WORLD v6 hot zones: the hot ones among the counted containers pay × HOT_ZONE_XP_MULT.
  const nHot = Math.min(nCont, cnt(i.hotContainers ?? 0));
  const containers = XP.CONTAINER * nCont + Math.floor(XP.CONTAINER * (HOT_ZONE_XP_MULT - 1) * nHot);
  const nObj = i.exit === "mia" ? 0 : Math.min(XP.OBJECTIVE_MAX, cnt(i.objectives ?? 0));
  const objectives = XP.OBJECTIVE * nObj;
  const nNpc = cnt(i.marauders), nGuard = cnt(i.guards), nBoss = cnt(i.bosses), nPvp = cnt(i.rankedPvp);
  const npc = XP.NPC * nNpc;
  const guard = XP.GUARD * nGuard;
  const time = extract + haul;
  const act = containers + objectives + npc + guard;
  const raw = time + act;
  const room = Math.max(0, XP.DAILY_SOFT_CAP - cnt(i.grindToday));
  const timeIn = Math.min(time, room);
  const actIn = Math.min(act, room - timeIn);
  const grind =
    timeIn + actIn + Math.floor((time - timeIn) * XP.DAILY_TIME_OVER_MULT) + Math.floor((act - actIn) * XP.DAILY_OVER_MULT);
  const boss = XP.BOSS * nBoss;
  const pvp = XP.PVP * nPvp;
  const subtotal = grind + boss + pvp;
  const first = qualifies && i.firstExtractToday ? Math.min(XP.FIRST_EXTRACT_MAX, subtotal) : 0;
  const lines: XpLine[] = [];
  const push = (key: XpKey, qty: number, xp: number): void => {
    if (xp !== 0) lines.push({ key, qty, xp });
  };
  push("extract", minutes, extract);
  push("haul", haulCr, haul);
  push("containers", nCont, containers);
  push("objectives", nObj, objectives);
  push("npc", nNpc, npc);
  push("guard", nGuard, guard);
  push("daily_cap", 1, grind - raw);
  push("boss", nBoss, boss);
  push("pvp", nPvp, pvp);
  push("first_extract", 1, first);
  return { total: subtotal + first, grind, lines };
}

/** The XP lines a raid can grow while the player is on the map (the server counts them as they happen). */
export type RaidXpKey = "containers" | "objectives" | "npc" | "guard" | "boss" | "pvp";

/**
 * In-raid XP estimate of one counted action (EventsMsg.xp, SelfState.raidXp): the xpForExit term it
 * adds. `count` = this entry's count of that line after the action; a container past
 * XP.CONTAINER_MAX adds 0 (the per-entry cap). Extract / haul / first-extract, the daily soft cap,
 * the ranked-PvP checks the web makes and the MIA rule (no container XP) apply only at settlement,
 * so the outcome screen's settled XP is authoritative and can differ.
 */
export function raidXpGain(key: RaidXpKey, count: number, hot = false): number {
  switch (key) {
    case "containers":
      return count >= 1 && count <= XP.CONTAINER_MAX ? XP.CONTAINER + (hot ? Math.floor(XP.CONTAINER * (HOT_ZONE_XP_MULT - 1) + 1e-9) : 0) : 0;
    case "objectives":
      return count >= 1 && count <= XP.OBJECTIVE_MAX ? XP.OBJECTIVE : 0;
    case "npc":
      return XP.NPC;
    case "guard":
      return XP.GUARD;
    case "boss":
      return XP.BOSS;
    case "pvp":
      return XP.PVP;
  }
}

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

/**
 * Level bar of `xp` total: level = levelForXp(xp), into = XP earned inside that level, need =
 * xpToNext(level) (into < need), total = xp.
 */
export function levelProgress(xp: number): { level: number; into: number; need: number; total: number } {
  const total = Number.isFinite(xp) ? Math.max(0, Math.floor(xp)) : 0;
  let level = 1, need = xpToNext(1), into = total;
  while (into >= need) {
    into -= need;
    level++;
    need = xpToNext(level);
  }
  return { level, into, need, total };
}

export const STASH_CAPACITY = [20, 35, 55, 80] as const;

// ---------------------------------------------------------------- level rewards (earn-only cosmetics)

/**
 * Level and task-mark rewards (docs/RETENTION.md §3, §5.1): titles, name colours and level-badge
 * frames. Earn-only: never sold for SOL or CR, never tradable, and they change nothing in a raid (no
 * power for money). A player equips one of each kind from those unlocked (users.title / name_color /
 * badge_frame, checked on the web by cosmeticUnlocked). Marks count completed daily tasks
 * (quests.ts): a counter, not a currency. The feature unlocks that already exist (market selling,
 * bound traders) are listed by the web next to these (apps/web lib/lobby/levels.ts).
 */
export type CosmeticKind = "title" | "color" | "frame" | "skin" | "badge";
/** Kinds a player wears one of (users.title / name_color / badge_frame / skin). A badge is never worn: owning it shows it. */
export type WearableKind = Exclude<CosmeticKind, "badge">;
/** How a badge frame is drawn around the level shield (CSS / SVG only, no art). */
export type FrameStyle = "rope" | "rivets" | "stitch" | "solid" | "double" | "glow";
export interface CosmeticDef {
  id: string;
  kind: CosmeticKind;
  name: string;
  /** Name colour, or the frame's colour. */
  hex?: string;
  style?: FrameStyle;
  /** The frame pulses (prefers-reduced-motion keeps it still). */
  animated?: boolean;
  /**
   * Granted, not reached: Alpha Pass tiers, the alpha top-10 trophy and the invite reward (pass.ts),
   * and the iDos edition's donation titles (apps/web lib/idos/shop.ts, "donation").
   * Owned only through a pass_unlocks row (migration 011), which the alpha wipe never touches.
   */
  grant?: "pass" | "trophy" | "invite" | "donation";
}

const COSMETIC_LIST: readonly CosmeticDef[] = [
  { id: "t-scavenger", kind: "title", name: "Scavenger" },
  { id: "t-raider", kind: "title", name: "Raider" },
  { id: "t-runner", kind: "title", name: "Runner" },
  { id: "t-veteran", kind: "title", name: "Veteran" },
  { id: "t-pathfinder", kind: "title", name: "Pathfinder" },
  { id: "t-night-runner", kind: "title", name: "Night Runner" },
  { id: "t-legend", kind: "title", name: "Legend of the Outskirts" },
  { id: "t-ghost", kind: "title", name: "Ghost" },
  { id: "t-spoils-master", kind: "title", name: "Spoils Master" },
  { id: "t-fixer", kind: "title", name: "Fixer" },
  { id: "c-sand", kind: "color", name: "Sand", hex: "#e8d5a3" },
  { id: "c-lime", kind: "color", name: "Lime", hex: "#ccff00" },
  { id: "c-rust", kind: "color", name: "Rust", hex: "#e07a45" },
  { id: "c-sky", kind: "color", name: "Sky", hex: "#4cc9ff" },
  { id: "c-violet", kind: "color", name: "Violet", hex: "#b07bff" },
  { id: "c-gold", kind: "color", name: "Gold", hex: "#ffc93c" },
  { id: "c-ember", kind: "color", name: "Ember", hex: "#ff7a50" },
  { id: "c-contract", kind: "color", name: "Contract Blue", hex: "#6f9bff" },
  { id: "f-rope", kind: "frame", name: "Rope", hex: "#c8a26a", style: "rope" },
  { id: "f-riveted", kind: "frame", name: "Riveted", hex: "#9ca3af", style: "rivets" },
  { id: "f-stitched", kind: "frame", name: "Stitched", hex: "#f5f5f4", style: "stitch" },
  { id: "f-steel", kind: "frame", name: "Steel", hex: "#cbd5e1", style: "solid" },
  { id: "f-brass", kind: "frame", name: "Brass", hex: "#d4a537", style: "solid" },
  { id: "f-gilded", kind: "frame", name: "Gilded", hex: "#ffc93c", style: "double" },
  { id: "f-spoils", kind: "frame", name: "Spoils", hex: "#ccff00", style: "glow", animated: true },
  { id: "f-contract", kind: "frame", name: "Contract", hex: "#6f9bff", style: "double" },
  { id: "f-fixer", kind: "frame", name: "Fixer", hex: "#6f9bff", style: "glow", animated: true },
  // Alpha Pass (pass.ts PASS_TIERS): alpha-only, granted when a tier is claimed, permanent.
  { id: "t-alpha-raider", kind: "title", name: "Alpha Raider", grant: "pass" },
  { id: "t-field-tester", kind: "title", name: "Field Tester", grant: "pass" },
  { id: "f-founder", kind: "frame", name: "Founder", hex: "#5cf2c6", style: "double", grant: "pass" },
  { id: "t-bug-hunter", kind: "title", name: "Bug Hunter", grant: "pass" },
  { id: "c-alpha-mint", kind: "color", name: "Alpha Mint", hex: "#5cf2c6", grant: "pass" },
  { id: "t-signal-runner", kind: "title", name: "Signal Runner", grant: "pass" },
  { id: "f-alpha-signal", kind: "frame", name: "Alpha Signal", hex: "#5cf2c6", style: "glow", animated: true, grant: "pass" },
  { id: "s-alpha-veteran", kind: "skin", name: "Alpha Veteran", hex: "#5cf2c6", grant: "pass" },
  { id: "c-alpha-dawn", kind: "color", name: "Alpha Dawn", hex: "#ffb38a", grant: "pass" },
  { id: "b-founder", kind: "badge", name: "Founder", hex: "#5cf2c6", grant: "pass" },
  // Alpha trophy (pass.ts ALPHA_TROPHY) and the invite reward (PASS.INVITE_RAIDS).
  { id: "t-alpha-top10", kind: "title", name: "Alpha Top 10", grant: "trophy" },
  { id: "t-recruiter", kind: "title", name: "Recruiter", grant: "invite" },
  // Boss trophies (BOSS_FIGHT, bossTrophyId): granted at settlement to the killer and the party mates
  // who damaged the boss; permanent, one row each however many kills.
  { id: "t-foreman-slayer", kind: "title", name: "Foreman Slayer", grant: "trophy" },
  { id: "t-commander-slayer", kind: "title", name: "Commander Slayer", grant: "trophy" },
  { id: "t-warden-slayer", kind: "title", name: "Warden Slayer", grant: "trophy" },
  // iDos edition SPOILS shop (apps/web lib/idos/shop-rules.ts): a donation to the developers leaves a
  // thank-you title, once per account (buying again only records the donation). A title only: no
  // power and nothing tradable, so "no power for money" above still holds.
  { id: "supporter", kind: "title", name: "Supporter", grant: "donation" },
  { id: "patron", kind: "title", name: "Patron", grant: "donation" },
];

/** Every cosmetic by id. */
export const COSMETICS: Readonly<Record<string, CosmeticDef>> = Object.fromEntries(COSMETIC_LIST.map((c) => [c.id, c]));

/** Cosmetics reached at a player level (RETENTION.md §3). Levels not listed give none. */
export const LEVEL_REWARDS: ReadonlyArray<{ level: number; ids: readonly string[] }> = [
  { level: 2, ids: ["t-scavenger"] },
  { level: 3, ids: ["f-rope"] },
  { level: 4, ids: ["c-sand"] },
  { level: 5, ids: ["t-raider", "c-lime"] },
  { level: 6, ids: ["f-riveted"] },
  { level: 7, ids: ["t-runner"] },
  { level: 8, ids: ["c-rust"] },
  { level: 9, ids: ["f-stitched"] },
  { level: 10, ids: ["t-veteran", "c-sky"] },
  { level: 12, ids: ["f-steel"] },
  { level: 14, ids: ["t-pathfinder"] },
  { level: 15, ids: ["c-violet", "f-brass"] },
  { level: 17, ids: ["t-night-runner"] },
  { level: 20, ids: ["t-legend", "c-gold", "f-gilded"] },
  { level: 25, ids: ["c-ember", "t-ghost"] },
  { level: 30, ids: ["f-spoils", "t-spoils-master"] },
];

/** Cosmetics reached at a number of task marks (completed daily tasks, RETENTION.md §5.1). */
export const MARK_REWARDS: ReadonlyArray<{ marks: number; ids: readonly string[] }> = [
  { marks: 10, ids: ["c-contract"] },
  { marks: 25, ids: ["f-contract"] },
  { marks: 50, ids: ["t-fixer"] },
  { marks: 100, ids: ["f-fixer"] },
];

/** The cosmetic `id`, or null (unknown ids, non-strings). */
export function cosmeticDef(id: unknown): CosmeticDef | null {
  return typeof id === "string" && Object.prototype.hasOwnProperty.call(COSMETICS, id) ? COSMETICS[id]! : null;
}

/**
 * Where `id` unlocks: at a level, at a number of marks, or by a grant (pass tier, trophy, invite:
 * `at` 0); null for an unknown id or one no table lists.
 */
export function cosmeticUnlock(id: string): { by: "level" | "marks" | "grant"; at: number } | null {
  if (cosmeticDef(id)?.grant) return { by: "grant", at: 0 };
  const l = LEVEL_REWARDS.find((r) => r.ids.includes(id));
  if (l) return { by: "level", at: l.level };
  const m = MARK_REWARDS.find((r) => r.ids.includes(id));
  return m ? { by: "marks", at: m.marks } : null;
}

/**
 * True when a player of `level` with `marks` task marks owns cosmetic `id`. Granted cosmetics are
 * owned only when `granted` (the player's pass_unlocks ids) holds them.
 */
export function cosmeticUnlocked(id: string, level: number, marks: number, granted: ReadonlySet<string> = EMPTY_SET): boolean {
  const u = cosmeticDef(id) ? cosmeticUnlock(id) : null;
  if (!u) return false;
  if (u.by === "grant") return granted.has(id);
  const have = u.by === "level" ? level : marks;
  return Number.isFinite(have) && have >= u.at;
}

const EMPTY_SET: ReadonlySet<string> = new Set<string>();

/** Ids a player of `level` with `marks` owns, in table order (levels, marks, then grants they hold). */
export function unlockedCosmetics(level: number, marks: number, granted: Iterable<string> = []): string[] {
  const g = new Set(granted);
  return [
    ...LEVEL_REWARDS.filter((r) => level >= r.level).flatMap((r) => r.ids),
    ...MARK_REWARDS.filter((r) => marks >= r.marks).flatMap((r) => r.ids),
    ...COSMETIC_LIST.filter((c) => c.grant && g.has(c.id)).map((c) => c.id),
  ];
}

/** Cosmetics reached exactly at `level` (empty for most levels). */
export function levelRewardIds(level: number): string[] {
  return [...(LEVEL_REWARDS.find((r) => r.level === Math.floor(level))?.ids ?? [])];
}

/** The first level above `level` with a cosmetic reward, or null past the table. */
export function nextLevelReward(level: number): { level: number; ids: string[] } | null {
  const r = LEVEL_REWARDS.find((x) => x.level > Math.floor(level));
  return r ? { level: r.level, ids: [...r.ids] } : null;
}

/** The first mark reward above `marks`, or null past the table. */
export function nextMarkReward(marks: number): { marks: number; ids: string[] } | null {
  const r = MARK_REWARDS.find((x) => x.marks > Math.floor(marks));
  return r ? { marks: r.marks, ids: [...r.ids] } : null;
}
