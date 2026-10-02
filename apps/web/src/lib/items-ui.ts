import {
  RARITY_COLORS,
  RARITY_NAMES,
  WEAPONS,
  type ItemRef,
  type WeaponId,
} from "@extract/shared";

/** RARITY_COLORS are Pixi numbers; CSS needs hex strings. */
export function rarityHex(rarity: number): string {
  const c = RARITY_COLORS[clampRarity(rarity)];
  return `#${c.toString(16).padStart(6, "0")}`;
}

export function rarityName(rarity: number): string {
  return RARITY_NAMES[clampRarity(rarity)];
}

function clampRarity(r: number): 0 | 1 | 2 | 3 {
  return Math.max(0, Math.min(3, Math.round(r))) as 0 | 1 | 2 | 3;
}

export function isWeaponId(v: string): v is WeaponId {
  return Object.prototype.hasOwnProperty.call(WEAPONS, v);
}

export function weaponIcon(id: WeaponId): string {
  return `/sprites/${id}.png`;
}

export function armorIcon(level: number): string {
  const l = Math.max(1, Math.min(3, Math.round(level || 1)));
  return `/sprites/armor_${l}.png`;
}

/** Icon + display name for an item from an outcome / settlement. */
export function describeItem(ref: ItemRef): { icon: string; name: string } {
  if (ref.kind === "weapon" && isWeaponId(ref.type)) {
    return { icon: weaponIcon(ref.type), name: WEAPONS[ref.type].name };
  }
  if (ref.kind === "armor") {
    const level = ref.level ?? 1;
    return { icon: armorIcon(level), name: `Armor Lv ${level}` };
  }
  return { icon: "/sprites/backpack.png", name: ref.type };
}

/** m:ss, clamped at zero. */
export function fmtClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
