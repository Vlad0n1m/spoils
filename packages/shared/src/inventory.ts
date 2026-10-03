/**
 * Pure inventory engine (inventory memo; prototype tested in the scratchpad). One flat
 * SlotKey → item map per player: every operation is a move between (bag, key) pairs, so the same
 * code runs on a Colyseus MapSchema<InvItem> (server), a JS Map (API validation, tests) and React
 * state (loadout page).
 *
 *   w1  w2  armor  bp        equipment (w1/w2 accept any weapon)
 *   p0  p1  p2  p3           pockets (always)
 *   b0 … b{cap-1}            backpack slots, cap = BACKPACK_SLOTS[level of the item in bp]
 */

import { SEARCH } from "./constants.js";
import { BACKPACK_SLOTS, POCKET_SLOTS, itemDef, type ItemDef } from "./item-defs.js";
import type { ContainerKind } from "./map/types.js";

/** InvItem.flags bits. FREE: free kit (never drops/extracts, vanishes). BROKEN: shown in a corpse, not takeable. */
export const ITEM_FLAG = { FREE: 1, BROKEN: 2 } as const;

export type EquipKey = "w1" | "w2" | "armor" | "bp";
export type SlotKey = EquipKey | `p${number}` | `b${number}`;
export const EQUIP_KEYS: readonly EquipKey[] = ["w1", "w2", "armor", "bp"];
export type WeaponKey = "w1" | "w2";

/** Same shape as the InvItem schema, DB snapshots and report items. */
export interface ItemLike {
  uid: string;
  def: string;
  qty: number;
  rarity: number;
  dur: number;
  mag: number;
  flags: number;
  label: string;
  /** Dog tags only (InvItem.lvl / InvItem.ref). */
  lvl?: number;
  ref?: string;
}

/** MapSchema<InvItem> and Map<string, ItemLike> both satisfy this. */
export interface SlotStore<T extends ItemLike = ItemLike> {
  get(k: string): T | undefined;
  set(k: string, v: T): unknown;
  delete(k: string): unknown;
}

export type InvErrCode =
  | "full" | "gone" | "range" | "not_searching" | "not_ready" | "not_revealed" | "broken"
  | "bad_slot" | "bp_not_empty" | "rate" | "dead"
  /** WORLD v6 (D11): the corpse of this user's own earlier entry cannot be searched. */
  | "own_body";

export function isSlotKey(k: unknown): k is SlotKey {
  return typeof k === "string" && (EQUIP_KEYS.includes(k as EquipKey) || /^p[0-3]$/.test(k) || /^b(?:\d|1[0-5])$/.test(k));
}

/** b0..b15 — NOT "bp" (a plain startsWith("b") check would treat the backpack slot as a bag slot). */
export function isBagKey(k: string): boolean {
  return /^b\d/.test(k);
}

export function bpLevelOf(s: SlotStore): 0 | 1 | 2 | 3 {
  const b = s.get("bp");
  return b ? (itemDef(b.def)?.bpLevel ?? 0) : 0;
}

export function bagKeys(level: number): SlotKey[] {
  return Array.from({ length: BACKPACK_SLOTS[level as 0 | 1 | 2 | 3] ?? 0 }, (_, i) => `b${i}` as SlotKey);
}

/** Pockets then backpack slots: the auto-place order. */
export function storageKeys(s: SlotStore): SlotKey[] {
  return [...Array.from({ length: POCKET_SLOTS }, (_, i) => `p${i}` as SlotKey), ...bagKeys(bpLevelOf(s))];
}

/** Fixed order (equipment, pockets, bag) — death builds the corpse list in this order. */
export function allKeys(s: SlotStore): SlotKey[] {
  return [...EQUIP_KEYS, ...storageKeys(s)];
}

export function accepts(key: string, d: ItemDef): boolean {
  if (key === "w1" || key === "w2") return d.cat === "weapon";
  if (key === "armor") return d.cat === "armor";
  if (key === "bp") return d.cat === "backpack";
  return /^p[0-3]$/.test(key) || /^b(?:\d|1[0-5])$/.test(key);
}

/** Same def, same label, same FREE bit, neither broken: FREE stacks never merge with paid ones. */
export function canMerge(a: ItemLike, b: ItemLike): boolean {
  const d = itemDef(a.def);
  return (
    !!d && !d.unique && d.stack > 1 && a.def === b.def && a.label === b.label &&
    (a.flags & ITEM_FLAG.FREE) === (b.flags & ITEM_FLAG.FREE) &&
    !((a.flags | b.flags) & ITEM_FLAG.BROKEN)
  );
}

export interface PlaceStep {
  key: SlotKey;
  qty: number;
  merge: boolean;
  /** The target holds a FREE pistol that this weapon replaces (the pistol vanishes). */
  replacesFree?: boolean;
}
export type PlacePlan = { ok: true; steps: PlaceStep[]; placed: number } | { ok: false; code: InvErrCode };

/**
 * Where `qty` units of `item` would go in `s`; never mutates. Order: matching empty equipment slot →
 * slot holding a FREE pistol (weapons) → merge into same stacks (pockets first) → empty pockets →
 * empty backpack slots. Stacks may be placed partially (placed < qty); uniques get `full`.
 * `prefer` = drag target; an occupied non-mergeable target returns `full` and the caller tries a swap.
 */
export function planPlace(s: SlotStore, item: ItemLike, qty = item.qty, prefer?: SlotKey): PlacePlan {
  if (item.flags & ITEM_FLAG.BROKEN) return { ok: false, code: "broken" };
  const d = itemDef(item.def);
  if (!d || !(qty > 0)) return { ok: false, code: "bad_slot" };
  if (prefer) {
    if (!accepts(prefer, d) || (isBagKey(prefer) && !bagKeys(bpLevelOf(s)).includes(prefer))) {
      return { ok: false, code: "bad_slot" };
    }
    const cur = s.get(prefer);
    const n0 = Math.min(qty, d.stack);
    if (!cur) return { ok: true, steps: [{ key: prefer, qty: n0, merge: false }], placed: n0 };
    if (cur.flags & ITEM_FLAG.FREE && d.cat === "weapon") {
      return { ok: true, steps: [{ key: prefer, qty: 1, merge: false, replacesFree: true }], placed: 1 };
    }
    if (canMerge(cur, item)) {
      const n = Math.min(qty, d.stack - cur.qty);
      return n > 0 ? { ok: true, steps: [{ key: prefer, qty: n, merge: true }], placed: n } : { ok: false, code: "full" };
    }
    return { ok: false, code: "full" };
  }
  const equip: SlotKey[] =
    d.cat === "weapon" ? ["w1", "w2"] : d.cat === "armor" ? ["armor"] : d.cat === "backpack" ? ["bp"] : [];
  for (const k of equip) if (!s.get(k)) return { ok: true, steps: [{ key: k, qty: 1, merge: false }], placed: 1 };
  if (d.cat === "weapon") {
    for (const k of equip) {
      if (s.get(k)!.flags & ITEM_FLAG.FREE) {
        return { ok: true, steps: [{ key: k, qty: 1, merge: false, replacesFree: true }], placed: 1 };
      }
    }
  }
  const keys = storageKeys(s);
  const steps: PlaceStep[] = [];
  let left = qty;
  if (!d.unique && d.stack > 1) {
    for (const k of keys) {
      const cur = s.get(k);
      if (!cur || !canMerge(cur, item)) continue;
      const n = Math.min(left, d.stack - cur.qty);
      if (n <= 0) continue;
      steps.push({ key: k, qty: n, merge: true });
      left -= n;
      if (!left) break;
    }
  }
  for (const k of keys) {
    if (!left) break;
    if (s.get(k)) continue;
    const n = Math.min(left, d.stack);
    steps.push({ key: k, qty: n, merge: false });
    left -= n;
  }
  const placed = qty - left;
  return placed > 0 ? { ok: true, steps, placed } : { ok: false, code: "full" };
}

/** Backpack contents belong to the player: a non-empty backpack cannot be unequipped. */
export function canRemoveBackpack(s: SlotStore): boolean {
  return bagKeys(bpLevelOf(s)).every((k) => !s.get(k));
}

/** Units of `def` the player carries (broken excluded). HUD ammo totals = countOf("ammo_<type>"). */
export function countOf(s: SlotStore, def: string): number {
  let n = 0;
  for (const k of allKeys(s)) {
    const it = s.get(k);
    if (it?.def === def && !(it.flags & ITEM_FLAG.BROKEN)) n += it.qty;
  }
  return n;
}

/**
 * Stack to consume from for reload / heal: FREE stacks first (so the free kit stops taking pocket
 * space), then the smallest stack (frees slots). Returns the slot key or undefined.
 */
export function consumeKey(s: SlotStore, def: string): SlotKey | undefined {
  let best: SlotKey | undefined;
  let bestFree = false;
  let bestQty = Infinity;
  for (const k of storageKeys(s)) {
    const it = s.get(k);
    if (!it || it.def !== def || it.qty <= 0 || it.flags & ITEM_FLAG.BROKEN) continue;
    const free = (it.flags & ITEM_FLAG.FREE) !== 0;
    if (best === undefined || (free && !bestFree) || (free === bestFree && it.qty < bestQty)) {
      best = k;
      bestFree = free;
      bestQty = it.qty;
    }
  }
  return best;
}

/**
 * Open delay of a static container (ms) before the first reveal: by MapData tier (tier 0 = the
 * 600 ms cache), safes add SEARCH.OPEN_MS.safeExtra. Corpses use SEARCH.OPEN_MS.corpse. One
 * function so the server timer and the client progress ring cannot disagree.
 */
export function containerOpenMs(spot: { kind: ContainerKind; tier: number }): number {
  const t = SEARCH.OPEN_MS.tier;
  const base = t[Math.max(0, Math.min(t.length - 1, Math.floor(spot.tier)))]!;
  return base + (spot.kind === "safe" ? SEARCH.OPEN_MS.safeExtra : 0);
}

/** Reveal time of one container slot (ms). */
export function revealMs(it: ItemLike): number {
  if (it.flags & ITEM_FLAG.BROKEN) return SEARCH.REVEAL_BROKEN_MS;
  const d = itemDef(it.def);
  if (!d) return SEARCH.REVEAL_STACK_MS;
  if (d.unique) return SEARCH.REVEAL_UNIQUE_MS + SEARCH.REVEAL_PER_RARITY_MS * it.rarity;
  if (d.cat === "junk") return SEARCH.REVEAL_JUNK_MS + SEARCH.REVEAL_JUNK_PER_RARITY_MS * d.rarity;
  return SEARCH.REVEAL_STACK_MS;
}

export interface LoadoutEntry {
  key: SlotKey;
  /** DB item id for uniques. */
  itemId?: string;
  def: string;
  qty: number;
}
export interface StashUnique {
  id: string;
  def: string;
  state: string;
  dur: number;
}
export type LoadoutErrCode =
  | "bad_item" | "dup_slot" | "bad_slot" | "no_backpack_room" | "item_unavailable" | "bad_qty" | "not_enough";

/** Shared by the loadout page (live validation) and POST /api/loadout/lock (authoritative). */
export function validateLoadout(
  entries: readonly LoadoutEntry[],
  uniques: ReadonlyMap<string, StashUnique>,
  stacks: Readonly<Record<string, number>>,
): { ok: true } | { ok: false; code: LoadoutErrCode; key?: string } {
  const store = new Map<string, ItemLike>();
  const seen = new Set<string>();
  const need: Record<string, number> = {};
  // Equipment first so the backpack level is known before b-slots are checked.
  const isEquip = (k: string) => EQUIP_KEYS.includes(k as EquipKey);
  const sorted = [...entries].sort((a, b) => Number(!isEquip(a.key)) - Number(!isEquip(b.key)));
  for (const e of sorted) {
    const d = itemDef(e.def);
    if (!d || d.cat === "junk") return { ok: false, code: "bad_item", key: e.key };
    if (store.has(e.key)) return { ok: false, code: "dup_slot", key: e.key };
    if (!isSlotKey(e.key) || !accepts(e.key, d)) return { ok: false, code: "bad_slot", key: e.key };
    if (isBagKey(e.key) && !bagKeys(bpLevelOf(store)).includes(e.key)) {
      return { ok: false, code: "no_backpack_room", key: e.key };
    }
    if (d.unique) {
      const u = e.itemId ? uniques.get(e.itemId) : undefined;
      if (!u || u.def !== e.def || u.state !== "in_stash" || u.dur <= 0 || seen.has(u.id)) {
        return { ok: false, code: "item_unavailable", key: e.key };
      }
      seen.add(u.id);
    } else {
      if (!Number.isInteger(e.qty) || e.qty < 1 || e.qty > d.stack) return { ok: false, code: "bad_qty", key: e.key };
      need[e.def] = (need[e.def] ?? 0) + e.qty;
    }
    store.set(e.key, { uid: e.itemId ?? "", def: e.def, qty: e.qty, rarity: 0, dur: 0, mag: 0, flags: 0, label: "" });
  }
  for (const [def, n] of Object.entries(need)) {
    if ((stacks[def] ?? 0) < n) return { ok: false, code: "not_enough", key: def };
  }
  return { ok: true };
}
