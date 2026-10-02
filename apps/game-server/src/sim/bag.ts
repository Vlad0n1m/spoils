/**
 * The player's inventory: SelfState.slots driven by the shared slot engine (inventory.ts in
 * @extract/shared). One flat SlotKey → InvItem map, so every operation is a move between
 * (bag, key) pairs and the same rules run here, in the API and on the loadout page.
 *
 * syncPublic() is the ONE place the derived public Player fields (weapon, weaponRarity, armor,
 * armorDur, bp, act) are written: everything else mutates SelfState and calls it.
 */

import {
  ACT,
  BACKPACK_SLOTS,
  FREE_KIT,
  ITEM_FLAG,
  SEARCH,
  WEAPONS,
  accepts,
  allKeys,
  ammoDefOf,
  bagKeys,
  bpLevelOf,
  canRemoveBackpack,
  consumeKey,
  countOf,
  isBagKey,
  isSlotKey,
  itemDef,
  planPlace,
  type AmmoType,
  type HealKind,
  type InvDropMsg,
  type InvErrCode,
  type InvItem,
  type InvMoveMsg,
  type ItemLike,
  type PlacePlan,
  type SlotKey,
  type SlotStore,
  type WeaponDef,
} from "@extract/shared";
import { cloneItem, makeItem, toPlain } from "./items.js";
import type { PlayerRuntime } from "./types.js";

export function store(rt: PlayerRuntime): SlotStore<InvItem> {
  return rt.self.slots;
}

/** The item in the active weapon slot, if it is a weapon. */
export function activeWeapon(rt: PlayerRuntime): InvItem | undefined {
  const it = rt.self.slots.get(rt.self.active);
  return it && itemDef(it.def)?.weapon ? it : undefined;
}

export function weaponDefOf(it: ItemLike | undefined): WeaponDef | undefined {
  const w = it ? itemDef(it.def)?.weapon : undefined;
  return w ? WEAPONS[w] : undefined;
}

export function ammoCount(rt: PlayerRuntime, ammo: AmmoType): number {
  return countOf(rt.self.slots, `ammo_${ammo}`);
}

export function medCount(rt: PlayerRuntime, kind: HealKind): number {
  return countOf(rt.self.slots, kind);
}

/** Remove up to `n` units of `def` (FREE stacks first, then the smallest). Returns units taken. */
export function consumeUnits(rt: PlayerRuntime, def: string, n: number): number {
  const s = rt.self.slots;
  let taken = 0;
  while (taken < n) {
    const k = consumeKey(s, def);
    if (!k) break;
    const it = s.get(k)!;
    const t = Math.min(it.qty, n - taken);
    taken += t;
    if (it.qty - t <= 0) s.delete(k);
    else it.qty -= t;
  }
  return taken;
}

/** Ammo for a weapon's reload. */
export function takeAmmo(rt: PlayerRuntime, ammo: AmmoType, n: number): number {
  return consumeUnits(rt, `ammo_${ammo}`, n);
}

/** Heal completion: the stack is looked up again now (it may have moved since the heal started). */
export function consumeMed(rt: PlayerRuntime, kind: HealKind): boolean {
  return consumeUnits(rt, kind, 1) === 1;
}

/** Apply a successful plan for `qty` units of `item` (clones; never re-parents). */
export function applyPlan(rt: PlayerRuntime, item: ItemLike, plan: Extract<PlacePlan, { ok: true }>): void {
  const s = rt.self.slots;
  for (const step of plan.steps) {
    const cur = s.get(step.key);
    if (step.merge && cur) {
      cur.qty += step.qty;
    } else {
      // replacesFree: the FREE pistol in the target vanishes (it is worth nothing).
      const c = cloneItem(item);
      c.qty = step.qty;
      s.set(step.key, c);
    }
  }
}

/**
 * Auto-place (or place at `prefer`) `qty` units into the player's inventory. Stacks may be placed
 * partially (`placed` < qty); uniques all or nothing.
 */
export function placeItem(
  rt: PlayerRuntime,
  item: ItemLike,
  qty = item.qty,
  prefer?: SlotKey,
): { placed: number; code?: InvErrCode } {
  const plan = planPlace(rt.self.slots, item, qty, prefer);
  if (!plan.ok) return { placed: 0, code: plan.code };
  applyPlan(rt, item, plan);
  return { placed: plan.placed };
}

/** Pick a sensible active slot: keep the current one if it holds a weapon, else w1, else w2. */
export function fixActive(rt: PlayerRuntime): void {
  const s = rt.self.slots;
  if (s.get(rt.self.active)) return;
  const next = s.get("w1") ? "w1" : s.get("w2") ? "w2" : "w1";
  if (rt.self.active !== next) rt.self.active = next;
}

/**
 * Free kit fills EMPTY spots only (inventory memo §1.3): a FREE pistol in the first empty weapon
 * slot, FREE light ammo and a FREE bandage into empty storage. FREE stacks never merge with paid ones.
 */
export function giveFreeKit(rt: PlayerRuntime): void {
  const s = rt.self.slots;
  const wKey = (["w1", "w2"] as const).find((k) => !s.get(k));
  if (wKey) s.set(wKey, cloneItem(makeItem(FREE_KIT.WEAPON, { flags: ITEM_FLAG.FREE })));
  placeItem(rt, makeItem(ammoDefOf(FREE_KIT.WEAPON), { qty: FREE_KIT.AMMO_LIGHT, flags: ITEM_FLAG.FREE }));
  placeItem(rt, makeItem("bandage", { qty: FREE_KIT.BANDAGES, flags: ITEM_FLAG.FREE }));
  fixActive(rt);
}

/** Everything carried, in the fixed death/report order (equipment, pockets, bag), as plain copies. */
export function carriedItems(rt: PlayerRuntime): Array<{ key: SlotKey; item: ItemLike }> {
  const s = rt.self.slots;
  const out: Array<{ key: SlotKey; item: ItemLike }> = [];
  for (const k of allKeys(s)) {
    const it = s.get(k);
    if (it) out.push({ key: k, item: toPlain(it) });
  }
  return out;
}

export function clearSlots(rt: PlayerRuntime): void {
  rt.self.slots.clear();
}

/** ACT bits from the owner state (remote animation and sound viz). */
export function actFlags(rt: PlayerRuntime): number {
  const s = rt.self;
  if (!rt.pub.alive) return ACT.IDLE;
  let a = 0;
  if (s.reloadUntil > 0) a |= ACT.RELOAD;
  if (s.healUntil > 0) a |= ACT.HEAL;
  if (s.extractStartedAt > 0) a |= ACT.EXTRACT;
  if (s.rollLeft > 0) a |= ACT.ROLL;
  if (s.searching) a |= ACT.LOOT;
  if (s.walking) a |= ACT.WALK;
  return a;
}

/**
 * Mirror the owner-only state onto the public Player. The single writer of weapon / weaponRarity /
 * armor / armorDur / bp / act; writes only changed fields so an idle player produces no patches.
 */
export function syncPublic(rt: PlayerRuntime): void {
  const p = rt.pub;
  const s = rt.self.slots;
  const w = activeWeapon(rt);
  const weapon = w?.def ?? "";
  const weaponRarity = w?.rarity ?? 0;
  const armorItem = s.get("armor");
  const armor = armorItem ? (itemDef(armorItem.def)?.armorLevel ?? 0) : 0;
  const armorDur = armorItem ? armorItem.dur : 0;
  const bp = bpLevelOf(s);
  const act = actFlags(rt);
  if (p.weapon !== weapon) p.weapon = weapon;
  if (p.weaponRarity !== weaponRarity) p.weaponRarity = weaponRarity;
  if (p.armor !== armor) p.armor = armor;
  if (p.armorDur !== armorDur) p.armorDur = armorDur;
  if (p.bp !== bp) p.bp = bp;
  if (p.act !== act) p.act = act;
}

/** INV_* token bucket (SEARCH.OPS_PER_SEC, burst OPS_BURST) on the match clock. */
export function takeOpToken(rt: PlayerRuntime, clockMs: number): boolean {
  const b = rt.opsBucket;
  b.tokens = Math.min(SEARCH.OPS_BURST, b.tokens + ((clockMs - b.at) / 1000) * SEARCH.OPS_PER_SEC);
  b.at = clockMs;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

/** Highest occupied b-slot fits the backpack level. */
function bagFits(s: SlotStore): boolean {
  const cap = BACKPACK_SLOTS[bpLevelOf(s)];
  for (let i = cap; i < 16; i++) if (s.get(`b${i}`)) return false;
  return true;
}

/** A SlotStore view of `s` where `key` reads as `as` (undefined = empty). Plans never mutate. */
function overlay(s: SlotStore, key: string, as: ItemLike | undefined): SlotStore {
  return { get: (k) => (k === key ? as : s.get(k)), set: () => undefined, delete: () => undefined };
}

export interface MoveResult {
  code?: InvErrCode;
  /** The active weapon slot was touched (the caller cancels a running reload). */
  touchedActive: boolean;
}

/**
 * INV_MOVE from the player's own slots (rearrange). Order (inventory memo §2.3): stale-click guard →
 * plan the move as if the source were already gone → targeted occupied slot = swap when both items
 * fit each other's slots and the backpack invariant holds. `from: "loot"` belongs to the search
 * sessions (containers.ts takeFromLoot) and is not handled here.
 */
export function moveOwn(rt: PlayerRuntime, msg: InvMoveMsg): MoveResult {
  const s = rt.self.slots;
  const src = isSlotKey(msg.key) ? s.get(msg.key) : undefined;
  if (!src || src.uid !== msg.uid || src.def !== msg.def) return { code: "gone", touchedActive: false };
  const from = msg.key as SlotKey;
  const to = msg.to;
  if (to !== undefined && !isSlotKey(to)) return { code: "bad_slot", touchedActive: false };
  const qty = msg.qty ?? src.qty;
  if (!Number.isInteger(qty) || qty < 1 || qty > src.qty) return { code: "bad_slot", touchedActive: false };
  if (to === from) return { touchedActive: false };
  if (from === "bp" && !canRemoveBackpack(s)) return { code: "bp_not_empty", touchedActive: false };
  const whole = qty === src.qty;
  const item = toPlain(src);
  // Whole move: the source reads as empty. Split: it stays occupied but must not merge with itself.
  const view = overlay(s, from, whole ? undefined : { ...item, label: `${item.label}\u0000split` });
  const touched = from === rt.self.active || to === rt.self.active;
  const plan = planPlace(view, item, qty, to);
  if (plan.ok) {
    // Moving the backpack item itself (bp → storage) must still leave a valid bag afterwards.
    const after = new Map<string, ItemLike>();
    for (const k of allKeys(s)) {
      const it = s.get(k);
      if (it && k !== from) after.set(k, it);
    }
    if (!whole) after.set(from, { ...item, qty: item.qty - qty });
    for (const st of plan.steps) after.set(st.key, { ...item, qty: st.qty });
    if (!bagFits(after)) return { code: "bp_not_empty", touchedActive: false };
    if (whole) s.delete(from);
    else src.qty -= qty;
    applyPlan(rt, item, plan);
    fixActive(rt);
    return { touchedActive: touched };
  }
  if (plan.code !== "full" || !to || !whole) return { code: plan.code, touchedActive: false };
  // Targeted onto an occupied slot: swap.
  const other = s.get(to);
  if (!other) return { code: "full", touchedActive: false };
  const od = itemDef(other.def);
  const sd = itemDef(src.def);
  if (!od || !sd || !accepts(from, od) || !accepts(to, sd)) return { code: "bad_slot", touchedActive: false };
  const after = new Map<string, ItemLike>();
  for (const k of allKeys(s)) {
    const it = s.get(k);
    if (it) after.set(k, it);
  }
  after.set(from, other);
  after.set(to, src);
  if (isBagKey(from) && !bagKeys(bpLevelOf(after)).includes(from)) return { code: "bad_slot", touchedActive: false };
  if (isBagKey(to) && !bagKeys(bpLevelOf(after)).includes(to)) return { code: "bad_slot", touchedActive: false };
  if (!bagFits(after)) return { code: "bp_not_empty", touchedActive: false };
  const a = cloneItem(src);
  const b = cloneItem(other);
  s.set(from, b);
  s.set(to, a);
  fixActive(rt);
  return { touchedActive: touched };
}

/**
 * INV_DROP validation + removal. Returns the removed units as a plain item to put on the ground
 * (null for FREE items, which just vanish) or an error code.
 */
export function removeForDrop(rt: PlayerRuntime, msg: InvDropMsg): { item: ItemLike | null; touchedActive: boolean } | { code: InvErrCode } {
  const s = rt.self.slots;
  const src = isSlotKey(msg.key) ? s.get(msg.key) : undefined;
  if (!src || src.uid !== msg.uid || src.def !== msg.def) return { code: "gone" };
  const qty = msg.qty ?? src.qty;
  if (!Number.isInteger(qty) || qty < 1 || qty > src.qty) return { code: "bad_slot" };
  if (msg.key === "bp" && !canRemoveBackpack(s)) return { code: "bp_not_empty" };
  const out = { ...toPlain(src), qty };
  if (qty === src.qty) s.delete(msg.key);
  else src.qty -= qty;
  fixActive(rt);
  return { item: out.flags & ITEM_FLAG.FREE ? null : out, touchedActive: msg.key === rt.self.active };
}
