/**
 * Shape checks of item lists the web sends to the game server (raids/enter: loadout snapshot, pool
 * release, boss bag). Ours, but a version skew or a bug must never put a malformed or duplicated
 * item into a match: a uid twice would put one DB item on the map twice.
 */

import { isSlotKey, itemDef, type LoadoutSnapshot, type SettledItem } from "@extract/shared";

const str = (v: unknown, max = 64): v is string => typeof v === "string" && v.length <= max;
const intIn = (v: unknown, lo: number, hi: number): v is number => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

/** Slots of a loadout: 4 gear + 4 pockets + 16 bag. */
export const MAX_SNAPSHOT_ENTRIES = 4 + 4 + 16;

/**
 * One item, or null. Uniques need a uid not in `seen` (added); fungibles carry uid "" and are
 * refused when `needUid` (pool items are always uniques).
 */
export function sanitizeItem(raw: unknown, seen: Set<string>, needUid: boolean): SettledItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!str(r.def, 32) || !str(r.uid, 64)) return null;
  const d = itemDef(r.def);
  if (!d) return null;
  if (d.unique) {
    if (!r.uid || seen.has(r.uid)) return null;
  } else if (needUid || r.uid !== "") {
    return null;
  }
  const qty = d.unique ? 1 : r.qty;
  if (!intIn(qty, 1, d.stack)) return null;
  if (d.unique) seen.add(r.uid);
  const rarity = intIn(r.rarity, 0, 3) ? r.rarity : 0;
  const dur = typeof r.dur === "number" && Number.isFinite(r.dur) && r.dur >= 0 && r.dur <= 10_000 ? r.dur : 0;
  const out: SettledItem = { uid: r.uid, def: r.def, qty, rarity, dur };
  if (str(r.label, 32) && r.label) out.label = r.label;
  if (intIn(r.lvl, 0, 1000) && r.lvl) out.lvl = r.lvl;
  return out;
}

/** Up to `max` valid unique items of a list (malformed ones are dropped). */
export function sanitizeUniques(raw: unknown, max: number, seen: Set<string>): SettledItem[] {
  const out: SettledItem[] = [];
  for (const it of Array.isArray(raw) ? raw : []) {
    if (out.length >= max) break;
    const s = sanitizeItem(it, seen, true);
    if (s) out.push(s);
  }
  return out;
}

/**
 * A loadout snapshot for exactly (userId, loadoutId), or null when it is for anyone or anything
 * else. Duplicate slot keys and malformed entries are dropped.
 */
export function sanitizeSnapshot(raw: unknown, userId: string, loadoutId: string, seen: Set<string>): LoadoutSnapshot | null {
  if (!raw || typeof raw !== "object" || !loadoutId) return null;
  const snap = raw as Record<string, unknown>;
  if (snap.userId !== userId || snap.loadoutId !== loadoutId) return null;
  const entries: LoadoutSnapshot["entries"] = [];
  const keys = new Set<string>();
  for (const e of Array.isArray(snap.entries) ? snap.entries.slice(0, MAX_SNAPSHOT_ENTRIES) : []) {
    const key = (e as Record<string, unknown> | null)?.key;
    if (!isSlotKey(key) || keys.has(key)) continue;
    const it = sanitizeItem(e, seen, false);
    if (!it) continue;
    keys.add(key);
    entries.push({ ...it, key });
  }
  return { loadoutId, userId, level: intIn(snap.level, 0, 1000) ? snap.level : 0, entries };
}
