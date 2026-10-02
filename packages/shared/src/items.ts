/** Weapons, armor, ammo, rarity and chest loot tables. */

export type WeaponId = "pistol" | "rifle" | "shotgun" | "sniper";
export type AmmoType = "light" | "shell" | "heavy";
export type HealKind = "bandage" | "medkit";
export type GroundItemKind = "weapon" | "armor" | "ammo" | "bandage" | "medkit";

/** 0 common, 1 rare, 2 epic, 3 legendary. */
export type Rarity = 0 | 1 | 2 | 3;
export const RARITY_NAMES = ["common", "rare", "epic", "legendary"] as const;
export const RARITY_COLORS = [0xb8c0c8, 0x3d8bff, 0xa64dff, 0xffc21a] as const;
/** Damage multiplier by rarity. */
export const RARITY_DAMAGE_MULT = [1.0, 1.1, 1.2, 1.3] as const;

export interface WeaponDef {
  id: WeaponId;
  name: string;
  ammo: AmmoType;
  /** Damage per pellet before rarity and armor. */
  damage: number;
  pellets: number;
  /** Minimum time between shots. */
  fireIntervalMs: number;
  /** Full-auto when the trigger is held; otherwise one shot per press. */
  auto: boolean;
  /** Projectile speed, px/s. */
  bulletSpeed: number;
  /** Max projectile travel distance, px. */
  range: number;
  /** Max random deviation of each pellet from the aim, radians (uniform in [-spread, spread]). */
  spread: number;
  magSize: number;
  reloadMs: number;
  /** Distance from the player center to the muzzle along the aim. */
  muzzle: number;
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  pistol: {
    id: "pistol", name: "Pistol", ammo: "light",
    damage: 15, pellets: 1, fireIntervalMs: 280, auto: false,
    bulletSpeed: 1700, range: 750, spread: 0.035,
    magSize: 12, reloadMs: 1200, muzzle: 44,
  },
  rifle: {
    id: "rifle", name: "Assault rifle", ammo: "light",
    damage: 12, pellets: 1, fireIntervalMs: 100, auto: true,
    bulletSpeed: 1900, range: 900, spread: 0.06,
    magSize: 30, reloadMs: 2000, muzzle: 58,
  },
  shotgun: {
    id: "shotgun", name: "Shotgun", ammo: "shell",
    damage: 9, pellets: 7, fireIntervalMs: 850, auto: false,
    bulletSpeed: 1500, range: 420, spread: 0.2,
    magSize: 5, reloadMs: 2600, muzzle: 56,
  },
  sniper: {
    id: "sniper", name: "Sniper rifle", ammo: "heavy",
    damage: 75, pellets: 1, fireIntervalMs: 1400, auto: false,
    bulletSpeed: 3200, range: 1700, spread: 0.004,
    magSize: 5, reloadMs: 2800, muzzle: 66,
  },
};

export const WEAPON_IDS = Object.keys(WEAPONS) as WeaponId[];

export interface ArmorDef {
  level: 1 | 2 | 3;
  /** Share of incoming damage absorbed while durability lasts. */
  absorb: number;
  /** Damage points the armor can absorb before it breaks. */
  durability: number;
}

export const ARMOR: Record<1 | 2 | 3, ArmorDef> = {
  1: { level: 1, absorb: 0.2, durability: 80 },
  2: { level: 2, absorb: 0.35, durability: 130 },
  3: { level: 3, absorb: 0.5, durability: 180 },
};

export const AMMO = {
  light: { pickup: 30, maxCarry: 180 },
  shell: { pickup: 10, maxCarry: 40 },
  heavy: { pickup: 10, maxCarry: 30 },
} as const satisfies Record<AmmoType, { pickup: number; maxCarry: number }>;

/** One possible drop inside a chest; `weight` is relative within its table. */
export type LootRoll =
  | { kind: "weapon"; weapon: WeaponId; rarity: Rarity; weight: number }
  | { kind: "armor"; level: 1 | 2 | 3; weight: number }
  | { kind: "ammo"; ammo: AmmoType; weight: number }
  | { kind: "bandage" | "medkit"; weight: number };

export interface ChestTable {
  /** How many rolls a chest of this rarity gives. */
  rolls: number;
  loot: LootRoll[];
}

/**
 * Chest contents by chest rarity. In the full economy chests are filled from the pool of lost
 * items (docs/GAME_DESIGN.md §7); in the demo they roll from these tables.
 */
export const CHEST_TABLES: Record<Rarity, ChestTable> = {
  0: {
    rolls: 2,
    loot: [
      { kind: "ammo", ammo: "light", weight: 30 },
      { kind: "ammo", ammo: "shell", weight: 12 },
      { kind: "bandage", weight: 25 },
      { kind: "weapon", weapon: "rifle", rarity: 0, weight: 10 },
      { kind: "weapon", weapon: "shotgun", rarity: 0, weight: 10 },
      { kind: "armor", level: 1, weight: 10 },
      { kind: "medkit", weight: 3 },
    ],
  },
  1: {
    rolls: 3,
    loot: [
      { kind: "weapon", weapon: "rifle", rarity: 1, weight: 14 },
      { kind: "weapon", weapon: "shotgun", rarity: 1, weight: 12 },
      { kind: "weapon", weapon: "sniper", rarity: 0, weight: 6 },
      { kind: "armor", level: 2, weight: 12 },
      { kind: "ammo", ammo: "light", weight: 18 },
      { kind: "ammo", ammo: "heavy", weight: 8 },
      { kind: "medkit", weight: 10 },
    ],
  },
  2: {
    rolls: 3,
    loot: [
      { kind: "weapon", weapon: "rifle", rarity: 2, weight: 12 },
      { kind: "weapon", weapon: "sniper", rarity: 1, weight: 10 },
      { kind: "weapon", weapon: "shotgun", rarity: 2, weight: 10 },
      { kind: "armor", level: 3, weight: 8 },
      { kind: "armor", level: 2, weight: 10 },
      { kind: "ammo", ammo: "heavy", weight: 10 },
      { kind: "medkit", weight: 12 },
    ],
  },
  3: {
    rolls: 4,
    loot: [
      { kind: "weapon", weapon: "rifle", rarity: 3, weight: 10 },
      { kind: "weapon", weapon: "sniper", rarity: 3, weight: 10 },
      { kind: "weapon", weapon: "shotgun", rarity: 3, weight: 6 },
      { kind: "armor", level: 3, weight: 14 },
      { kind: "medkit", weight: 12 },
      { kind: "ammo", ammo: "heavy", weight: 8 },
    ],
  },
};

/**
 * Should F take this armor over what is worn? Remaining durability is the total damage a vest can
 * still absorb, so it decides first; the level only breaks ties. A worn-out high-level vest never
 * blocks a fresh lower-level one. One rule for the server, the bots and the HUD hint.
 */
export function armorIsUpgrade(
  worn: { armor: number; armorDur: number },
  level: number,
  dur: number,
): boolean {
  const wornDur = worn.armor > 0 ? worn.armorDur : 0;
  return dur > wornDur || (dur === wornDur && level > worn.armor);
}

/** Damage after rarity and armor. Returns the HP loss and how much armor durability was used. */
export function applyDamage(
  rawDamage: number,
  armorLevel: number,
  armorDur: number,
): { hpLoss: number; armorUsed: number } {
  if (armorLevel < 1 || armorLevel > 3 || armorDur <= 0) {
    return { hpLoss: rawDamage, armorUsed: 0 };
  }
  const def = ARMOR[armorLevel as 1 | 2 | 3];
  const absorbed = Math.min(rawDamage * def.absorb, armorDur);
  return { hpLoss: rawDamage - absorbed, armorUsed: absorbed };
}
