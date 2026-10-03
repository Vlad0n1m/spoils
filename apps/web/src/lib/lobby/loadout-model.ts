/**
 * Pure model of the Loadout page (inventory memo "Lobby"): a draft is a LoadoutEntry[] (slot key →
 * stash unique or a stack taken from the stash). Placement reuses the shared slot engine
 * (planPlace on a Map store) and validation reuses validateLoadout, i.e. the exact code that
 * POST /api/world/join runs authoritatively, so the page can never accept a draft the API
 * rejects (or the other way round). No React, no DOM: unit-tested with tsx --test.
 */
import {
  EQUIP_KEYS,
  bagKeys,
  isBagKey,
  itemDef,
  planPlace,
  validateLoadout,
  type EquipKey,
  type ItemLike,
  type LoadoutEntry,
  type LoadoutErrCode,
  type SlotKey,
  type StashUnique,
} from "@extract/shared";

export interface StashUniqueView {
  id: string;
  def: string;
  rarity: number;
  dur: number;
  state: string;
}

export interface StashView {
  uniques: readonly StashUniqueView[];
  /** def → qty in the stash (not counting what the draft uses). */
  stacks: Readonly<Record<string, number>>;
}

export type PlaceResult = { ok: true; entries: LoadoutEntry[] } | { ok: false; code: LoadoutErrCode | "full" };

function toLike(e: LoadoutEntry, rarity = 0): ItemLike {
  return { uid: e.itemId ?? "", def: e.def, qty: e.qty, rarity, dur: 100, mag: 0, flags: 0, label: "" };
}

/** Slot store of a draft, the shape planPlace / bpLevelOf read. */
export function storeOf(entries: readonly LoadoutEntry[]): Map<string, ItemLike> {
  return new Map(entries.map((e) => [e.key, toLike(e)]));
}

export function usedUniqueIds(entries: readonly LoadoutEntry[]): Set<string> {
  return new Set(entries.map((e) => e.itemId).filter((x): x is string => !!x));
}

/** def → qty the draft takes from the stash. */
export function stackUsage(entries: readonly LoadoutEntry[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of entries) if (!e.itemId) out[e.def] = (out[e.def] ?? 0) + e.qty;
  return out;
}

/** What is still in the stash after the draft (stash list badges, stepper limits). */
export function freeStacks(stash: StashView, entries: readonly LoadoutEntry[]): Record<string, number> {
  const used = stackUsage(entries);
  const out: Record<string, number> = {};
  for (const [def, qty] of Object.entries(stash.stacks)) out[def] = Math.max(0, qty - (used[def] ?? 0));
  return out;
}

/** Stash uniques that could still go into the draft (in the stash, unused, not worn out). */
export function freeUniques(stash: StashView, entries: readonly LoadoutEntry[]): StashUniqueView[] {
  const used = usedUniqueIds(entries);
  return stash.uniques.filter((u) => u.state === "in_stash" && u.dur > 0 && !used.has(u.id));
}

/** Backpack slot count the draft currently has. */
export function bagCapacity(entries: readonly LoadoutEntry[]): number {
  const bp = entries.find((e) => e.key === "bp");
  return bagKeys(bp ? (itemDef(bp.def)?.bpLevel ?? 0) : 0).length;
}

/**
 * Re-packs backpack entries into b0..b{cap-1} (order kept). Entries that no longer fit return to
 * the stash, which for a draft just means they are dropped.
 */
function repackBag(entries: readonly LoadoutEntry[]): LoadoutEntry[] {
  const cap = bagCapacity(entries);
  const bag = entries.filter((e) => isBagKey(e.key)).sort((a, b) => bagIndex(a.key) - bagIndex(b.key));
  const rest = entries.filter((e) => !isBagKey(e.key));
  return [...rest, ...bag.slice(0, cap).map((e, i) => ({ ...e, key: `b${i}` as SlotKey }))];
}

function bagIndex(k: string): number {
  return Number(k.slice(1));
}

/**
 * Click on a stash unique: armor and backpacks replace what is equipped (the old one goes back to
 * the stash; a smaller backpack keeps as much of the bag as fits); weapons fill w1, w2, then a
 * free storage slot (planPlace order). `prefer` places into one specific slot instead.
 */
export function placeUnique(entries: readonly LoadoutEntry[], u: StashUniqueView, prefer?: SlotKey): PlaceResult {
  const d = itemDef(u.def);
  if (!d || !d.unique) return { ok: false, code: "bad_item" };
  if (usedUniqueIds(entries).has(u.id)) return { ok: false, code: "item_unavailable" };
  if (u.state !== "in_stash" || u.dur <= 0) return { ok: false, code: "item_unavailable" };
  const entry = (key: SlotKey): LoadoutEntry => ({ key, itemId: u.id, def: u.def, qty: 1 });

  const equipKey: EquipKey | null = d.cat === "armor" ? "armor" : d.cat === "backpack" ? "bp" : null;
  if (!prefer && equipKey) {
    const without = entries.filter((e) => e.key !== equipKey);
    const next = [...without, entry(equipKey)];
    return { ok: true, entries: equipKey === "bp" ? repackBag(next) : next };
  }
  const plan = planPlace(storeOf(entries), { ...toLike(entry("p0"), u.rarity), uid: u.id }, 1, prefer);
  if (!plan.ok) return { ok: false, code: plan.code === "full" ? "full" : "bad_slot" };
  const step = plan.steps[0]!;
  return { ok: true, entries: [...entries.filter((e) => e.key !== step.key), entry(step.key)] };
}

/**
 * Click on a stash stack: takes up to `qty` units (default: one full slot) and places them with
 * planPlace (tops up existing stacks of the same def first, then empty pockets, then the bag).
 * Returns how many units were placed.
 */
export function placeStack(
  entries: readonly LoadoutEntry[],
  def: string,
  available: number,
  qty?: number,
): PlaceResult & { placed?: number } {
  const d = itemDef(def);
  if (!d || d.unique || d.cat === "junk") return { ok: false, code: "bad_item" };
  const want = Math.min(available, qty ?? d.stack);
  if (!(want > 0)) return { ok: false, code: "not_enough" };
  const plan = planPlace(storeOf(entries), { uid: "", def, qty: want, rarity: d.rarity, dur: 100, mag: 0, flags: 0, label: "" });
  if (!plan.ok) return { ok: false, code: plan.code === "full" ? "full" : "bad_slot" };
  const next = entries.map((e) => ({ ...e }));
  for (const s of plan.steps) {
    const cur = next.find((e) => e.key === s.key);
    if (s.merge && cur) cur.qty += s.qty;
    else next.push({ key: s.key, def, qty: s.qty });
  }
  return { ok: true, entries: next, placed: plan.placed };
}

/** Returns a slot to the stash. Taking the backpack off returns its contents too. */
export function removeAt(entries: readonly LoadoutEntry[], key: string): LoadoutEntry[] {
  if (key === "bp") return entries.filter((e) => e.key !== "bp" && !isBagKey(e.key));
  return entries.filter((e) => e.key !== key);
}

/** Stepper on a stack slot: clamps to 1..def.stack and to what the stash still has; 0 removes. */
export function setStackQty(
  entries: readonly LoadoutEntry[],
  key: string,
  qty: number,
  stash: StashView,
): LoadoutEntry[] {
  const cur = entries.find((e) => e.key === key);
  if (!cur || cur.itemId) return [...entries];
  const d = itemDef(cur.def);
  if (!d) return [...entries];
  if (qty <= 0) return removeAt(entries, key);
  const others = entries.filter((e) => e !== cur && !e.itemId && e.def === cur.def).reduce((s, e) => s + e.qty, 0);
  const max = Math.min(d.stack, Math.max(0, (stash.stacks[cur.def] ?? 0) - others));
  const q = Math.max(1, Math.min(max, Math.floor(qty)));
  if (max < 1) return removeAt(entries, key);
  return entries.map((e) => (e === cur ? { ...e, qty: q } : e));
}

/**
 * A saved draft against today's stash: drops uniques that are gone (sold, listed, lost in a raid),
 * trims stacks to what the stash still holds and bag slots beyond the backpack. Run when the page
 * loads a draft so a stale draft never blocks Deploy.
 */
export function pruneDraft(entries: readonly LoadoutEntry[], stash: StashView): LoadoutEntry[] {
  const byId = new Map(stash.uniques.map((u) => [u.id, u]));
  const seen = new Set<string>();
  const left: Record<string, number> = { ...stash.stacks };
  const kept: LoadoutEntry[] = [];
  const isEquip = (k: string) => (EQUIP_KEYS as readonly string[]).includes(k);
  const ordered = [...entries].sort((a, b) => Number(!isEquip(a.key)) - Number(!isEquip(b.key)));
  for (const e of ordered) {
    const d = itemDef(e.def);
    if (!d || d.cat === "junk" || kept.some((k) => k.key === e.key)) continue;
    if (d.unique) {
      const u = e.itemId ? byId.get(e.itemId) : undefined;
      if (!u || u.def !== e.def || u.state !== "in_stash" || u.dur <= 0 || seen.has(u.id)) continue;
      seen.add(u.id);
      kept.push({ key: e.key, itemId: u.id, def: e.def, qty: 1 });
    } else {
      const q = Math.min(e.qty, d.stack, left[e.def] ?? 0);
      if (q < 1) continue;
      left[e.def] = (left[e.def] ?? 0) - q;
      kept.push({ key: e.key, def: e.def, qty: q });
    }
  }
  const cap = bagCapacity(kept);
  return kept.filter((e) => !isBagKey(e.key) || bagIndex(e.key) < cap);
}

/** The authoritative check, run locally for live feedback. */
export function validateDraft(entries: readonly LoadoutEntry[], stash: StashView) {
  const uniques = new Map<string, StashUnique>(stash.uniques.map((u) => [u.id, { id: u.id, def: u.def, state: u.state, dur: u.dur }]));
  return validateLoadout(entries, uniques, stash.stacks);
}

export const LOADOUT_ERR_TEXT: Readonly<Record<LoadoutErrCode | "full" | "in_raid" | "conflict" | "no_user", string>> = {
  bad_item: "That item can't go into a loadout.",
  dup_slot: "Two items share one slot.",
  bad_slot: "That item doesn't fit that slot.",
  no_backpack_room: "No backpack slot for that — equip a bigger backpack.",
  item_unavailable: "An item is no longer in your stash (sold, listed or lost).",
  bad_qty: "Stack size is out of range.",
  not_enough: "Not enough of that in your stash.",
  full: "No free slot — remove something or equip a bigger backpack.",
  in_raid: "Your gear is in a running raid.",
  conflict: "Your loadout is being locked in another tab.",
  no_user: "Sign in with a registered account to use your stash.",
};

/** Same gear in the same slots (join route: is the locked loadout still what the page shows?). */
export function sameLoadout(
  draft: readonly LoadoutEntry[],
  locked: ReadonlyArray<{ key: string; uid: string; def: string; qty: number }>,
): boolean {
  if (draft.length !== locked.length) return false;
  const byKey = new Map(locked.map((e) => [e.key, e]));
  return draft.every((e) => {
    const l = byKey.get(e.key);
    return !!l && l.def === e.def && l.qty === e.qty && (l.uid || "") === (e.itemId ?? "");
  });
}

/** Locked snapshot → draft entries (read-only board while gear is locked or in a raid). */
export function draftFromLocked(locked: ReadonlyArray<{ key: string; uid: string; def: string; qty: number }>): LoadoutEntry[] {
  return locked.map((e) => ({ key: e.key as SlotKey, def: e.def, qty: e.qty, ...(e.uid ? { itemId: e.uid } : {}) }));
}
