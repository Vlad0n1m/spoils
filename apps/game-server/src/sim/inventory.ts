/**
 * Items: creation (with economy uids), ground items, chests, pickups and death drops.
 * Every valuable item (non-free weapon, armor) is registered in Match.ledger on creation so the
 * conservation invariant (each uid ends in exactly one place) can be checked.
 */

import {
  AMMO,
  ARMOR,
  BREAK_CHANCE_ON_DEATH,
  CHEST_TABLES,
  GroundItem,
  HEAL,
  PLAYER,
  WEAPONS,
  WORLD,
  circleIsFree,
  pickWeighted,
  type AmmoType,
  type Chest,
  type HealKind,
  type ItemRef,
  type Player,
  type Rarity,
  type WeaponId,
  type WeaponSlot,
} from "@extract/shared";
import type { Match } from "./match.js";
import type { LootDrop, PlayerRuntime } from "./types.js";

/** How many bandages / medkits one loot roll or floor spot gives. */
const MED_QTY: Record<HealKind, number> = { bandage: 2, medkit: 1 };

export function weaponRef(uid: string, weapon: string, rarity: number): ItemRef {
  return { uid, kind: "weapon", type: weapon, rarity };
}

/** Armor has no rarity of its own; level 1..3 maps to rarity 0..2 so "rare+" checks work. */
export function armorRef(uid: string, level: number): ItemRef {
  return { uid, kind: "armor", type: "armor", rarity: Math.max(0, level - 1), level };
}

export function newWeaponDrop(m: Match, weapon: WeaponId, rarity: Rarity): LootDrop {
  const uid = m.newUid();
  m.ledger.set(uid, weaponRef(uid, weapon, rarity));
  return { kind: "weapon", weapon, rarity, mag: WEAPONS[weapon].magSize, uid };
}

export function newArmorDrop(m: Match, level: 1 | 2 | 3): LootDrop {
  const uid = m.newUid();
  m.ledger.set(uid, armorRef(uid, level));
  return { kind: "armor", level, dur: ARMOR[level].durability, uid };
}

/** Roll a chest's contents once at match setup so it can be audited before anyone opens it. */
export function rollChest(m: Match, rarity: Rarity): LootDrop[] {
  const table = CHEST_TABLES[rarity];
  const out: LootDrop[] = [];
  for (let i = 0; i < table.rolls; i++) {
    const roll = pickWeighted(m.rng, table.loot);
    switch (roll.kind) {
      case "weapon":
        out.push(newWeaponDrop(m, roll.weapon, roll.rarity));
        break;
      case "armor":
        out.push(newArmorDrop(m, roll.level));
        break;
      case "ammo":
        out.push({ kind: "ammo", ammo: roll.ammo, qty: AMMO[roll.ammo].pickup });
        break;
      default:
        out.push({ kind: roll.kind, qty: MED_QTY[roll.kind] });
    }
  }
  return out;
}

const FLOOR_LOOT = [
  { kind: "ammo" as const, ammo: "light" as AmmoType, weight: 36 },
  { kind: "ammo" as const, ammo: "shell" as AmmoType, weight: 18 },
  { kind: "ammo" as const, ammo: "heavy" as AmmoType, weight: 8 },
  { kind: "bandage" as const, weight: 22 },
  { kind: "medkit" as const, weight: 6 },
];

/** Floor loot: mostly ammo and meds, ~10% a common weapon. */
export function rollFloorLoot(m: Match): LootDrop {
  if (m.rng() < 0.1) {
    return newWeaponDrop(m, m.rng() < 0.55 ? "rifle" : "shotgun", 0);
  }
  const roll = pickWeighted(m.rng, FLOOR_LOOT);
  if (roll.kind === "ammo") return { kind: "ammo", ammo: roll.ammo, qty: AMMO[roll.ammo].pickup };
  return { kind: roll.kind, qty: MED_QTY[roll.kind] };
}

/**
 * Position for the n-th item scattered around (x, y): a golden-angle spiral, skipping spots inside
 * solids so dropped loot never ends up unreachable inside a crate or wall.
 */
export function dropSpot(m: Match, x: number, y: number, n: number): { x: number; y: number } {
  const B = WORLD.BORDER + 16;
  for (let attempt = 0; attempt < 16; attempt++) {
    const k = n + attempt * 3;
    const a = k * 2.399963 + 0.7;
    const r = 34 + 13 * Math.sqrt(k);
    const px = x + Math.cos(a) * r;
    const py = y + Math.sin(a) * r;
    if (px < B || py < B || px > m.map.width - B || py > m.map.height - B) continue;
    if (circleIsFree(m.idx, px, py, 12)) return { x: px, y: py };
  }
  return { x, y };
}

export function spawnGroundItem(m: Match, drop: LootDrop, x: number, y: number): GroundItem {
  const g = new GroundItem();
  g.id = m.newEntityId("g");
  g.kind = drop.kind;
  g.x = x;
  g.y = y;
  switch (drop.kind) {
    case "weapon":
      g.weapon = drop.weapon;
      g.rarity = drop.rarity;
      g.mag = drop.mag;
      g.uid = drop.uid;
      g.qty = 1;
      break;
    case "armor":
      g.armor = drop.level;
      g.armorDur = drop.dur;
      g.uid = drop.uid;
      g.qty = 1;
      break;
    case "ammo":
      g.ammoType = drop.ammo;
      g.qty = drop.qty;
      break;
    default:
      g.qty = drop.qty;
  }
  m.state.items.set(g.id, g);
  return g;
}

export function openChest(m: Match, rt: PlayerRuntime, chest: Chest): void {
  if (chest.opened) return;
  chest.opened = true;
  const contents = m.chestContents.get(chest.id) ?? [];
  m.chestContents.delete(chest.id);
  contents.forEach((drop, i) => {
    const p = dropSpot(m, chest.x, chest.y, i);
    spawnGroundItem(m, drop, p.x, p.y);
  });
  m.emit({ type: "chest", msg: { id: chest.id, by: rt.id } });
}

export function ammoOf(p: Player, type: AmmoType): number {
  return type === "light" ? p.ammoLight : type === "shell" ? p.ammoShell : p.ammoHeavy;
}

export function setAmmo(p: Player, type: AmmoType, value: number): void {
  if (type === "light") p.ammoLight = value;
  else if (type === "shell") p.ammoShell = value;
  else p.ammoHeavy = value;
}

/**
 * Ammo and meds are picked up by walking over them, up to the carry cap; whatever does not fit
 * stays on the ground with the reduced quantity.
 */
export function autoPickup(m: Match, p: Player): void {
  const r2 = PLAYER.AUTO_PICKUP_RADIUS * PLAYER.AUTO_PICKUP_RADIUS;
  for (const item of [...m.state.items.values()]) {
    if (item.kind !== "ammo" && item.kind !== "bandage" && item.kind !== "medkit") continue;
    const dx = item.x - p.x;
    const dy = item.y - p.y;
    if (dx * dx + dy * dy > r2) continue;
    let room: number;
    if (item.kind === "ammo") {
      const type = item.ammoType as AmmoType;
      if (!(type in AMMO)) continue;
      room = AMMO[type].maxCarry - ammoOf(p, type);
      const take = Math.min(room, item.qty);
      if (take <= 0) continue;
      setAmmo(p, type, ammoOf(p, type) + take);
      item.qty -= take;
    } else if (item.kind === "bandage") {
      const take = Math.min(HEAL.bandage.MAX_CARRY - p.bandages, item.qty);
      if (take <= 0) continue;
      p.bandages += take;
      item.qty -= take;
    } else {
      const take = Math.min(HEAL.medkit.MAX_CARRY - p.medkits, item.qty);
      if (take <= 0) continue;
      p.medkits += take;
      item.qty -= take;
    }
    if (item.qty <= 0) m.state.items.delete(item.id);
  }
}

function clearSlot(slot: WeaponSlot): void {
  slot.uid = "";
  slot.weapon = "";
  slot.rarity = 0;
  slot.mag = 0;
  slot.free = false;
}

/**
 * Weapon goes into an empty slot, else replaces the active slot. The replaced weapon drops where
 * the new one was lying (a swap); a free-kit pistol is worth nothing and simply disappears.
 */
export function pickupWeapon(m: Match, rt: PlayerRuntime, p: Player, item: GroundItem): boolean {
  if (!(item.weapon in WEAPONS) || !item.uid) return false;
  let idx = p.slots.findIndex((s) => !s.weapon);
  if (idx < 0) {
    idx = p.active;
    const old = p.slots[idx]!;
    if (!old.free && old.uid) {
      spawnGroundItem(
        m,
        { kind: "weapon", weapon: old.weapon as WeaponId, rarity: old.rarity as Rarity, mag: old.mag, uid: old.uid },
        item.x,
        item.y,
      );
    }
    if (p.reloadUntil > 0 && rt.reloadSlot === idx) p.reloadUntil = 0;
  }
  const slot = p.slots[idx]!;
  slot.uid = item.uid;
  slot.weapon = item.weapon;
  slot.rarity = item.rarity;
  slot.mag = Math.min(item.mag, WEAPONS[item.weapon as WeaponId].magSize);
  slot.free = false;
  m.state.items.delete(item.id);
  return true;
}

export function armorIsUpgrade(p: Player, level: number, dur: number): boolean {
  return level > p.armor || (level === p.armor && dur > p.armorDur);
}

export function pickupArmor(m: Match, p: Player, item: GroundItem): boolean {
  if (item.armor < 1 || item.armor > 3 || !item.uid) return false;
  if (!armorIsUpgrade(p, item.armor, item.armorDur)) return false;
  if (p.armor > 0 && p.armorUid) {
    spawnGroundItem(
      m,
      { kind: "armor", level: p.armor as 1 | 2 | 3, dur: p.armorDur, uid: p.armorUid },
      item.x,
      item.y,
    );
  }
  p.armor = item.armor;
  p.armorDur = item.armorDur;
  p.armorUid = item.uid;
  m.state.items.delete(item.id);
  return true;
}

/** F: nearest unopened chest in reach, else the nearest weapon / armor (armor only if it is an upgrade). */
export function interact(m: Match, rt: PlayerRuntime, p: Player): boolean {
  const reach2 = PLAYER.INTERACT_RADIUS * PLAYER.INTERACT_RADIUS;
  const d2 = (x: number, y: number) => (x - p.x) ** 2 + (y - p.y) ** 2;

  let chest: Chest | null = null;
  let best = reach2;
  for (const c of m.state.chests.values()) {
    if (c.opened) continue;
    const d = d2(c.x, c.y);
    if (d <= best) { best = d; chest = c; }
  }
  if (chest) {
    openChest(m, rt, chest);
    return true;
  }

  let item: GroundItem | null = null;
  best = reach2;
  for (const g of m.state.items.values()) {
    if (g.kind === "armor") {
      if (!armorIsUpgrade(p, g.armor, g.armorDur)) continue;
    } else if (g.kind !== "weapon") {
      continue;
    }
    const d = d2(g.x, g.y);
    if (d <= best) { best = d; item = g; }
  }
  if (!item) return false;
  return item.kind === "weapon" ? pickupWeapon(m, rt, p, item) : pickupArmor(m, p, item);
}

/** Valuable items the player carries right now (non-free weapons and armor). */
export function carriedRefs(p: Player): ItemRef[] {
  const out: ItemRef[] = [];
  for (const s of p.slots) {
    if (s.weapon && !s.free && s.uid) out.push(weaponRef(s.uid, s.weapon, s.rarity));
  }
  if (p.armor > 0 && p.armorUid) out.push(armorRef(p.armorUid, p.armor));
  return out;
}

/**
 * Death: every valuable item independently breaks (lost for good) or drops near the body for
 * others; ammo and meds always drop. The free pistol stays with the corpse — it is worth nothing.
 */
export function dropOnDeath(m: Match, rt: PlayerRuntime, p: Player): void {
  let n = 0;
  const at = () => dropSpot(m, p.x, p.y, n++);

  for (const s of p.slots) {
    if (!s.weapon || s.free || !s.uid) continue;
    const ref = weaponRef(s.uid, s.weapon, s.rarity);
    if (m.rng() < BREAK_CHANCE_ON_DEATH) {
      rt.lost.push(ref);
    } else {
      const pos = at();
      spawnGroundItem(
        m,
        { kind: "weapon", weapon: s.weapon as WeaponId, rarity: s.rarity as Rarity, mag: s.mag, uid: s.uid },
        pos.x,
        pos.y,
      );
      rt.dropped.push(ref);
    }
    clearSlot(s);
  }

  if (p.armor > 0 && p.armorUid) {
    const ref = armorRef(p.armorUid, p.armor);
    if (m.rng() < BREAK_CHANCE_ON_DEATH) {
      rt.lost.push(ref);
    } else {
      const pos = at();
      spawnGroundItem(m, { kind: "armor", level: p.armor as 1 | 2 | 3, dur: p.armorDur, uid: p.armorUid }, pos.x, pos.y);
      rt.dropped.push(ref);
    }
  }
  p.armor = 0;
  p.armorDur = 0;
  p.armorUid = "";

  for (const type of ["light", "shell", "heavy"] as const) {
    const qty = ammoOf(p, type);
    if (qty > 0) {
      const pos = at();
      spawnGroundItem(m, { kind: "ammo", ammo: type, qty }, pos.x, pos.y);
      setAmmo(p, type, 0);
    }
  }
  if (p.bandages > 0) {
    const pos = at();
    spawnGroundItem(m, { kind: "bandage", qty: p.bandages }, pos.x, pos.y);
    p.bandages = 0;
  }
  if (p.medkits > 0) {
    const pos = at();
    spawnGroundItem(m, { kind: "medkit", qty: p.medkits }, pos.x, pos.y);
    p.medkits = 0;
  }
}
