/**
 * Item presentation helpers shared by the in-raid inventory, the search panel, the outcome
 * receipt, the HUD and the lobby. Pure (no React, no DOM) so they are unit-tested with tsx.
 * Everything is derived from the shared ITEM_DEFS so names, icons and CR values can never drift
 * from what the server and the web API use.
 */

import {
  ARMOR,
  EQUIP_KEYS,
  ITEM_FLAG,
  RARITY_COLORS,
  RARITY_NAMES,
  WEAPONS,
  XP_LINE_LABEL,
  accepts,
  bagKeys,
  bpLevelOf,
  canRemoveBackpack,
  dogTagCr,
  itemDef,
  junkSellCr,
  weaponSlotIcon,
  type ContainerKind,
  type EquipKey,
  type InvErrCode,
  type ItemCat,
  type ItemLike,
  type SlotKey,
  type SlotStore,
  type SettledItem,
  type SoldLine,
  type XpLine,
  type KillWeapon,
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
  return Math.max(0, Math.min(3, Math.round(r || 0))) as 0 | 1 | 2 | 3;
}

export function isWeaponId(v: string): v is WeaponId {
  return Object.prototype.hasOwnProperty.call(WEAPONS, v);
}

/** Side-view gun sprite (HUD weapon cards, kill feed): the gun as it is held, muzzle right. */
export function weaponIcon(id: WeaponId): string {
  return `/sprites/${id}.png`;
}

/** Kill feed icon: the gun, or (Weapons v2) the hand grenade. */
export function killWeaponIcon(w: KillWeapon): string {
  return w === "grenade" ? "/sprites/grenade.png" : weaponIcon(w);
}

/** Kill feed / tooltip name of what killed: the gun's name or "Grenade". */
export function killWeaponName(w: KillWeapon): string {
  return w === "grenade" ? "Grenade" : (WEAPONS[w]?.name ?? w);
}

/** Is `v` something a kill can be credited to (a gun or "grenade")? */
export function isKillWeapon(v: string): v is KillWeapon {
  return v === "grenade" || isWeaponId(v);
}

export function armorIcon(level: number): string {
  const l = Math.max(1, Math.min(3, Math.round(level || 1)));
  return `/sprites/armor_${l}.png`;
}

/**
 * Sprite URL of an item def for a square tile (inventory, stash, receipts, market): weapons use
 * their square icon_<id> art (Weapons v2: the gun turned 30° to fill the slot), everything else its
 * def icon. Unknown defs fall back to a generic bag so the UI never 404s.
 */
export function itemIcon(def: string): string {
  const d = itemDef(def);
  return d ? `/sprites/${weaponSlotIcon(d)}.png` : "/sprites/backpack.png";
}

/** Anything that names an item: InvItem, SettledItem, SoldLine, ItemLike. */
export interface ItemRefLike {
  def: string;
  rarity?: number;
  /** Dog tag: victim nickname. */
  label?: string;
  /** Dog tag: victim level. */
  lvl?: number;
}

export interface ItemDescription {
  def: string;
  icon: string;
  /** Display name; dog tags read "Dog tag · Nick". */
  name: string;
  cat: ItemCat | "unknown";
  /** Instance rarity for uniques (weapons roll per instance), def rarity otherwise. */
  rarity: number;
  rarityName: string;
  color: string;
}

/** Icon + display name + rarity colour for any item reference. */
export function describeItem(ref: ItemRefLike): ItemDescription {
  const d = itemDef(ref.def);
  // Weapons carry their own rarity per instance; stackables and junk use the def's base rarity
  // unless the instance says otherwise (a server roll may override).
  const rarity = clampRarity(ref.rarity ?? d?.rarity ?? 0);
  let name = d?.name ?? ref.def;
  if (d?.id === "junk_dogtag" && ref.label) name = `Dog tag · ${ref.label}`;
  return {
    def: ref.def,
    icon: itemIcon(ref.def),
    name,
    cat: d?.cat ?? "unknown",
    rarity,
    rarityName: rarityName(rarity),
    color: rarityHex(rarity),
  };
}

export function isBroken(it: { flags?: number }): boolean {
  return ((it.flags ?? 0) & ITEM_FLAG.BROKEN) !== 0;
}

export function isFree(it: { flags?: number }): boolean {
  return ((it.flags ?? 0) & ITEM_FLAG.FREE) !== 0;
}

export interface DurInfo {
  /** 0..1 fill of the bar. */
  frac: number;
  /** Tooltip text: "Durability 73%" / "Armor 92/130". */
  text: string;
  /** Bar colour band: low < 25 %, mid < 60 %. */
  tone: "ok" | "mid" | "low";
}

/**
 * Durability bar for weapons (dur = 0..100 %) and armor (dur = remaining absorb points; the
 * max comes from ARMOR so the bar matches the HUD armor bar). Other items have no bar.
 */
export function durInfo(it: { def: string; dur: number }): DurInfo | null {
  const d = itemDef(it.def);
  if (!d) return null;
  let frac: number;
  let text: string;
  if (d.cat === "weapon") {
    frac = it.dur / 100;
    text = `Durability ${Math.round(Math.max(0, Math.min(100, it.dur)))}%`;
  } else if (d.cat === "armor" && d.armorLevel) {
    const max = ARMOR[d.armorLevel].durability;
    frac = max > 0 ? it.dur / max : 0;
    text = `Armor ${Math.round(Math.max(0, it.dur))}/${max}`;
  } else {
    return null;
  }
  frac = Math.max(0, Math.min(1, Number.isFinite(frac) ? frac : 0));
  return { frac, text, tone: frac < 0.25 ? "low" : frac < 0.6 ? "mid" : "ok" };
}

/** Auto-sale value of one junk slot at mult 1 (dog tags by victim level); 0 for non-junk. */
export function itemValueCr(it: { def: string; qty: number; lvl?: number }): number {
  const d = itemDef(it.def);
  if (d?.cat !== "junk") return 0;
  const unit = d.id === "junk_dogtag" ? dogTagCr(it.lvl ?? 0) : (d.value ?? 0);
  return unit * Math.max(0, it.qty);
}

/** "1 234 CR" style with a thin space so big receipts stay readable at a glance. */
export function fmtCr(n: number): string {
  const sign = n < 0 ? "−" : "";
  const s = Math.abs(Math.round(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${sign}${s} CR`;
}

const EQUIP_LABEL: Record<EquipKey, string> = { w1: "Primary", w2: "Secondary", armor: "Armor", bp: "Backpack" };

/** Human label for an empty slot ("Primary", "Pocket 2", "Bag 7"). */
export function slotLabel(key: string): string {
  if ((EQUIP_KEYS as readonly string[]).includes(key)) return EQUIP_LABEL[key as EquipKey];
  const n = Number(key.slice(1));
  if (key[0] === "p") return `Pocket ${n + 1}`;
  if (key[0] === "b") return `Bag ${n + 1}`;
  return key;
}

const CONTAINER_TITLE: Record<ContainerKind, string> = {
  crate: "Supply crate",
  toolbox: "Toolbox",
  fridge: "Fridge",
  pc: "Computer",
  med_case: "Med case",
  weapon_box: "Weapon box",
  safe: "Safe",
  stash: "Hidden stash",
};

export function containerTitle(kind: ContainerKind | string): string {
  return CONTAINER_TITLE[kind as ContainerKind] ?? "Container";
}

/** Tier 0..4 → frame colour (tier 0 = plain cache, 4 = legendary). */
export function tierName(tier: number): string {
  return ["Cache", "Common", "Rare", "Epic", "Legendary"][Math.max(0, Math.min(4, Math.round(tier)))]!;
}

/** Short, actionable toast text for every server InvErrCode (and client-side pre-checks). */
export const INV_ERR_TEXT: Readonly<Record<InvErrCode, string>> = {
  full: "No room — drop something or bring a bigger backpack",
  gone: "Too slow — someone else grabbed it",
  range: "Too far away",
  not_searching: "You are not searching anything",
  not_ready: "Still opening…",
  not_revealed: "Not revealed yet",
  broken: "Broken — can't be taken",
  bad_slot: "That doesn't fit there",
  bp_not_empty: "Empty the backpack first",
  rate: "Slow down",
  dead: "You're out of the raid",
  own_body: "That's your own body — you can't search it",
};

/** Read-only view of a player's slots (a plain record works as a SlotStore for the engine). */
export function recordStore<T extends ItemLike>(rec: Readonly<Record<string, T | undefined>>): SlotStore<T> {
  return {
    get: (k) => (Object.prototype.hasOwnProperty.call(rec, k) ? rec[k] : undefined),
    set: () => undefined,
    delete: () => undefined,
  };
}

/**
 * Where a single click on one of your own items sends it (keyboard/mouse "quick move"):
 * - weapon in storage → the active weapon slot (swap; the server re-places the old one),
 * - armor / backpack in storage → its equipment slot,
 * - equipped item → first free pocket/bag slot (backpack only when empty),
 * - pocket stack → first free bag slot, bag stack → first free pocket.
 * Returns null when there is nowhere sensible to go (the click is then a no-op).
 * The result is only a request: the server re-validates with planPlace.
 */
export function quickTarget(
  slots: SlotStore,
  key: SlotKey,
  active: "w1" | "w2" = "w1",
): SlotKey | "auto" | null {
  const it = slots.get(key);
  if (!it || isBroken(it)) return null;
  const d = itemDef(it.def);
  if (!d) return null;
  const isEquip = (EQUIP_KEYS as readonly string[]).includes(key);
  if (!isEquip) {
    if (d.cat === "weapon") {
      // Prefer an empty weapon slot, then the active one (swap).
      if (!slots.get("w1")) return "w1";
      if (!slots.get("w2")) return "w2";
      return active;
    }
    if (d.cat === "armor") return "armor";
    if (d.cat === "backpack") return "bp";
    const pockets = ["p0", "p1", "p2", "p3"] as SlotKey[];
    const bag = bagKeys(bpLevelOf(slots));
    const pool = key.startsWith("p") ? bag : pockets;
    const free = pool.find((k) => !slots.get(k) && accepts(k, d));
    return free ?? null;
  }
  if (key === "bp" && !canRemoveBackpack(slots)) return null;
  // Unequip: auto-place into storage. Bag slots of the backpack itself are not valid targets.
  const pockets = ["p0", "p1", "p2", "p3"] as SlotKey[];
  const bag = key === "bp" ? [] : bagKeys(bpLevelOf(slots));
  const free = [...pockets, ...bag].find((k) => !slots.get(k));
  return free ?? null;
}

export interface ReceiptLine extends SoldLine {
  name: string;
  icon: string;
  rarity: number;
}

export interface Receipt {
  /** Gear and stacks that go to the stash (everything extracted except junk). */
  kept: SettledItem[];
  /** Junk auto-sold at settlement, one line per extracted stack. */
  lines: ReceiptLine[];
  total: number;
  /** Victim nicknames of extracted dog tags (receipt badge row). */
  dogTags: string[];
  /** True once the web API's final numbers (autosell mult, repeat rule) replaced the estimate. */
  final: boolean;
  mult: number;
}

/**
 * Outcome receipt: the server sends `sold` lines at mult 1; the web API's applyExit may later
 * return the final credits / mult (`final`). Without server lines the receipt is rebuilt from
 * `extracted` with the shared junkSellCr so the numbers always match settlement's formula.
 */
export function buildReceipt(
  extracted: readonly SettledItem[],
  sold: readonly SoldLine[] | undefined,
  final?: { credits: number; mult: number; lines?: readonly SoldLine[] } | null,
): Receipt {
  const kept = extracted.filter((it) => itemDef(it.def)?.cat !== "junk");
  const base: readonly SoldLine[] =
    final?.lines ?? (sold && sold.length ? sold : junkSellCr(extracted, 1).lines);
  const lines: ReceiptLine[] = base.map((l) => {
    const d = describeItem({ def: l.def, label: l.label });
    return { ...l, name: d.name, icon: d.icon, rarity: d.rarity };
  });
  const sum = lines.reduce((a, l) => a + l.cr, 0);
  const dogTags = extracted.filter((it) => it.def === "junk_dogtag").map((it) => it.label || "Unknown");
  if (final && !final.lines) {
    // Only the total and mult came back: scale the estimate by the mult, and show whatever is
    // left (e.g. repeat dog tags paid 0) as one adjustment line so the receipt still sums up.
    if (final.mult !== 1) for (const l of lines) l.cr = Math.floor(l.cr * final.mult);
    const diff = final.credits - lines.reduce((a, l) => a + l.cr, 0);
    if (diff !== 0) lines.push({ def: "", qty: 1, cr: diff, name: "Adjustment", icon: "", rarity: 0 });
  }
  return {
    kept,
    lines,
    total: final ? final.credits : sum,
    dogTags,
    final: !!final,
    mult: final?.mult ?? 1,
  };
}

/** m:ss, clamped at zero. */
export function fmtClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * One line of the XP receipt on the outcome screen (WORLD v6): label from XP_LINE_LABEL, a short
 * detail of what it counts ("12 min on the map", "640 CR", "×3") and the signed XP text.
 */
export function xpLineText(l: XpLine): { label: string; detail: string; xp: string } {
  const qty = Math.max(0, Math.round(l.qty));
  let detail = "";
  if (l.key === "extract") detail = `${qty} min on the map`;
  else if (l.key === "haul") detail = fmtCr(qty);
  else if (l.key !== "first_extract" && l.key !== "daily_cap" && qty > 0) detail = `×${qty}`;
  const xp = Math.round(l.xp);
  return { label: XP_LINE_LABEL[l.key] ?? l.key, detail, xp: `${xp < 0 ? "−" : "+"}${Math.abs(xp)} XP` };
}
