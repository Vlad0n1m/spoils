/**
 * Item definitions (code, not DB). One InvItem / SettledItem points at a def by id.
 * Slot model (critique "Inventory model"): 1 item or stack = 1 slot, pockets 4, backpacks 6/10/16,
 * no weight / speed penalty. Junk prices are the economy memo's CR table (×1) because the CR sinks
 * were balanced against them. Icons are file names in apps/web/public/sprites (checked by a test).
 */

import {
  AMMO,
  ARMOR,
  WEAPONS,
  WEAPON_IDS,
  type AmmoType,
  type HealKind,
  type LootRoll,
  type Rarity,
  type WeaponId,
} from "./items.js";

/** "throwable" = hand grenades (WEAPONS_V2 §4): a stackable consumable thrown with G. */
export type ItemCat = "weapon" | "armor" | "backpack" | "ammo" | "med" | "throwable" | "junk";

export interface ItemDef {
  id: string;
  cat: ItemCat;
  name: string;
  /** /sprites/<icon>.png */
  icon: string;
  /** Max units per slot; 1 = not stackable. */
  stack: number;
  /** Unique items carry a DB instance id (uid), can break on death and trade on the market. */
  unique: boolean;
  /** Base rarity (junk, backpacks, armor, meds); weapons carry their own per instance. */
  rarity: Rarity;
  weapon?: WeaponId;
  armorLevel?: 1 | 2 | 3;
  bpLevel?: 1 | 2 | 3;
  ammo?: AmmoType;
  med?: HealKind;
  /** Throwables only: what it is (only the hand grenade so far). */
  throwable?: "grenade";
  /** Junk only: CR per unit paid by the auto-sale at settlement (dogtag: see dogTagCr). */
  value?: number;
}

export const POCKET_SLOTS = 4;
/** Backpack slots by level (index 0 = no backpack). */
export const BACKPACK_SLOTS = [0, 6, 10, 16] as const;

/** The 16 junk names; ids are `junk_<name>` and match the sprite files. */
export const JUNK_NAMES = [
  "apple", "water", "canned", "bolts", "wires", "pills", "battery", "fuel",
  "circuit", "hdd", "toolbox", "keycard", "goldchain", "gpu", "coldwallet", "dogtag",
] as const;
export type JunkName = (typeof JUNK_NAMES)[number];
export type JunkId = `junk_${JunkName}`;

/**
 * Dog tags: every human corpse holds one (label = victim nickname, lvl = victim level), so it has
 * to be searched for. Value depends on the victim level; the 24 h pair-repeat rule is web-side.
 */
export const DOG_TAG = {
  BASE_CR: 150,
  PER_LEVEL_CR: 25,
  MAX_CR: 650,
  /** Same extractor + same victim within this window: tags after REPEAT_FREE are worth 0. */
  REPEAT_WINDOW_MS: 24 * 3600_000,
  REPEAT_FREE: 2,
  /**
   * WORLD v6 (D22): a tag pays full price only to its victim's killer (SettledItem.by, resolved by
   * the server); anyone else who extracts it gets this share (late free-kit corpse farming).
   */
  NON_KILLER_MULT: 0.25,
  /** WORLD v6 (D22): guest victims drop no dog tag. */
  GUEST_TAG: false,
} as const;

export function dogTagCr(victimLevel: number): number {
  return Math.min(DOG_TAG.MAX_CR, DOG_TAG.BASE_CR + DOG_TAG.PER_LEVEL_CR * Math.max(0, Math.floor(victimLevel)));
}

/**
 * Stack size rule (critique): 5 for items worth under 100 CR, 2–3 for 100–450, 1 for 650 and up,
 * so stacks raise capacity only for cheap junk.
 */
const junk = (name: JunkName, label: string, value: number, stack: number, rarity: Rarity): ItemDef => ({
  id: `junk_${name}`, cat: "junk", name: label, icon: `junk_${name}`, stack, unique: false, rarity, value,
});

// The weapon icon stays the side-view sprite <id> (ground items, HUD); the inventory may use the
// square icon_<id> art (weaponSlotIcon).
const WEAPON_DEFS: ItemDef[] = WEAPON_IDS.map((w) => ({
  id: w, cat: "weapon", name: WEAPONS[w].name, icon: w, stack: 1, unique: true, rarity: 0, weapon: w,
}));
const ARMOR_DEFS: ItemDef[] = ([1, 2, 3] as const).map((l) => ({
  id: `armor_${l}`, cat: "armor", name: `Armor Lv ${l}`, icon: `armor_${l}`, stack: 1, unique: true,
  rarity: (l - 1) as Rarity, armorLevel: l,
}));
const BACKPACK_DEFS: ItemDef[] = ([1, 2, 3] as const).map((l) => ({
  id: `backpack_${l}`, cat: "backpack", name: ["Daypack", "Hiking pack", "Raid pack"][l - 1]!,
  icon: `backpack_${l}`, stack: 1, unique: true, rarity: (l - 1) as Rarity, bpLevel: l,
}));

const ALL_DEFS: ItemDef[] = [
  ...WEAPON_DEFS,
  ...ARMOR_DEFS,
  ...BACKPACK_DEFS,
  // Weapons v2: one icon per ammo type (was the shared tinted "ammo" box).
  { id: "ammo_light", cat: "ammo", name: "Light ammo", icon: "ammo_light", stack: 60, unique: false, rarity: 0, ammo: "light" },
  { id: "ammo_shell", cat: "ammo", name: "Shells", icon: "ammo_shell", stack: 20, unique: false, rarity: 0, ammo: "shell" },
  { id: "ammo_heavy", cat: "ammo", name: "Heavy ammo", icon: "ammo_heavy", stack: 20, unique: false, rarity: 0, ammo: "heavy" },
  { id: "ammo_bolt", cat: "ammo", name: "Crossbow bolts", icon: "ammo_bolt", stack: 10, unique: false, rarity: 0, ammo: "bolt" },
  { id: "grenade", cat: "throwable", name: "Hand grenade", icon: "grenade", stack: 2, unique: false, rarity: 1, throwable: "grenade" },
  { id: "bandage", cat: "med", name: "Bandage", icon: "bandage", stack: 5, unique: false, rarity: 0, med: "bandage" },
  { id: "medkit", cat: "med", name: "Medkit", icon: "medkit", stack: 2, unique: false, rarity: 1, med: "medkit" },
  junk("apple", "Apple", 20, 5, 0),
  junk("water", "Water bottle", 35, 5, 0),
  junk("canned", "Canned food", 50, 5, 0),
  junk("bolts", "Nuts & bolts", 30, 5, 0),
  junk("wires", "Wires", 55, 5, 0),
  junk("pills", "Pills", 100, 3, 1),
  junk("battery", "Battery", 110, 3, 1),
  junk("fuel", "Fuel can", 200, 2, 1),
  junk("circuit", "Circuit board", 250, 2, 2),
  junk("hdd", "Hard drive", 350, 2, 2),
  junk("toolbox", "Toolbox", 450, 2, 1),
  junk("keycard", "Keycard", 650, 1, 2),
  junk("goldchain", "Gold chain", 1000, 1, 2),
  junk("gpu", "Graphics card", 1500, 1, 3),
  junk("coldwallet", "Cold wallet", 2800, 1, 3),
  // value 0: the price comes from dogTagCr(lvl). Never stacks (different labels).
  junk("dogtag", "Dog tag", 0, 1, 1),
];

export const ITEM_DEFS: Readonly<Record<string, ItemDef>> = Object.freeze(
  Object.fromEntries(ALL_DEFS.map((d) => [d.id, Object.freeze(d)])),
);
export const ITEM_IDS: readonly string[] = Object.freeze(ALL_DEFS.map((d) => d.id));
export const JUNK_IDS: readonly JunkId[] = Object.freeze(JUNK_NAMES.map((n) => `junk_${n}` as JunkId));

/** Safe lookup (no prototype keys like "constructor"). */
export function itemDef(id: string): ItemDef | undefined {
  return Object.prototype.hasOwnProperty.call(ITEM_DEFS, id) ? ITEM_DEFS[id] : undefined;
}

export function isJunk(id: string): id is JunkId {
  return itemDef(id)?.cat === "junk";
}

/** Def id of the ammo stack a weapon uses. */
export function ammoDefOf(weapon: WeaponId): string {
  return `ammo_${WEAPONS[weapon].ammo}`;
}

/** Item def id of the hand grenade (GRENADE in items.ts). */
export const GRENADE_DEF = "grenade";

/** Square inventory icon of a weapon (icon_<id>, rotated 30° to fill a slot); other defs: their icon. */
export function weaponSlotIcon(def: ItemDef): string {
  return def.cat === "weapon" && def.weapon ? `icon_${def.weapon}` : def.icon;
}

/** Max armor absorb points of an armor def (InvItem.dur of armor counts these). */
export function armorMaxPoints(def: ItemDef): number {
  return def.armorLevel ? ARMOR[def.armorLevel].durability : 0;
}

/**
 * Base CR value of junk at autosell mult 1 (no trader bonus). Same function on the API, in the
 * outcome UI and in the "would sell for N CR" guest hint. Dog tags use `lvl` (victim level).
 */
export function junkCredits(items: ReadonlyArray<{ def: string; qty: number; lvl?: number }>): number {
  let sum = 0;
  for (const it of items) {
    const d = itemDef(it.def);
    if (d?.cat !== "junk") continue;
    sum += (d.id === "junk_dogtag" ? dogTagCr(it.lvl ?? 0) : (d.value ?? 0)) * it.qty;
  }
  return sum;
}

/**
 * Demo mode: convert a v1 CHEST_TABLES roll to an item def + qty + rarity. Ammo qty follows the
 * v1 pickup amounts so demo loot feels the same as before.
 */
export function lootRollToItem(roll: LootRoll): { def: string; qty: number; rarity: Rarity } {
  switch (roll.kind) {
    case "weapon":
      return { def: roll.weapon, qty: 1, rarity: roll.rarity };
    case "armor":
      return { def: `armor_${roll.level}`, qty: 1, rarity: (roll.level - 1) as Rarity };
    case "ammo":
      return { def: `ammo_${roll.ammo}`, qty: AMMO[roll.ammo].pickup, rarity: 0 };
    case "bandage":
      return { def: "bandage", qty: 1, rarity: 0 };
    case "medkit":
      return { def: "medkit", qty: 1, rarity: 1 };
  }
}
