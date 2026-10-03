/**
 * Item instances and the unique-uid ledger (inventory memo §2.6).
 *
 * Two shapes of the same item: `InvItem` (schema, lives in SelfState.slots / loot maps) and plain
 * `ItemLike` (ground runtime, death lists, reports). Transfers always CLONE: a schema instance must
 * never sit under two parents (inventory memo §3).
 *
 * Every unique (weapon, armor, backpack) that is not FREE carries a uid and is registered in the
 * ledger when it enters the match (loadout, lost-pool allocation, demo mint). Each one must leave
 * through exactly one resolution: extract, lost (broke on death / timeout), destroyed or left on
 * the map. A double resolution is a duplication bug.
 */

import {
  ITEM_FLAG,
  InvItem,
  WEAPONS,
  armorMaxPoints,
  itemDef,
  type ItemLike,
  type MatchEndReport,
  type PlayerExitReport,
  type SettledItem,
} from "@extract/shared";
import type { UidOrigin, UidResolution } from "./types.js";

export interface ItemInit {
  uid?: string;
  qty?: number;
  rarity?: number;
  dur?: number;
  mag?: number;
  flags?: number;
  label?: string;
  lvl?: number;
  ref?: string;
}

/**
 * A plain item with the def's defaults: weapons full magazine and 100 % durability, armor full
 * absorb points, backpacks 100 %. Unknown defs throw (programming error, never client input).
 */
export function makeItem(def: string, init: ItemInit = {}): ItemLike {
  const d = itemDef(def);
  if (!d) throw new Error(`unknown item def ${def}`);
  const dur =
    init.dur ?? (d.cat === "armor" ? armorMaxPoints(d) : d.cat === "weapon" || d.cat === "backpack" ? 100 : 0);
  return {
    uid: init.uid ?? "",
    def,
    qty: init.qty ?? 1,
    rarity: init.rarity ?? d.rarity,
    dur,
    mag: init.mag ?? (d.weapon ? WEAPONS[d.weapon].magSize : 0),
    flags: init.flags ?? 0,
    label: init.label ?? "",
    lvl: init.lvl ?? 0,
    ref: init.ref ?? "",
  };
}

/** Plain → fresh schema instance. */
export function toInv(it: ItemLike): InvItem {
  const s = new InvItem();
  s.uid = it.uid;
  s.def = it.def;
  s.qty = it.qty;
  s.rarity = it.rarity;
  s.dur = it.dur;
  s.mag = it.mag;
  s.flags = it.flags;
  s.label = it.label;
  s.lvl = it.lvl ?? 0;
  s.ref = it.ref ?? "";
  return s;
}

/** Schema (or plain) → detached plain copy. */
export function toPlain(it: ItemLike): ItemLike {
  return {
    uid: it.uid, def: it.def, qty: it.qty, rarity: it.rarity, dur: it.dur, mag: it.mag,
    flags: it.flags, label: it.label, lvl: it.lvl ?? 0, ref: it.ref ?? "",
  };
}

/** Clone into a new schema instance (never re-parent an InvItem). */
export function cloneItem(it: ItemLike): InvItem {
  return toInv(it);
}

/**
 * Report shape. Dog tags carry label/lvl; `victim` (userId) is resolved by the reporter from
 * InvItem.ref because the sim does not put DB ids in synced state.
 */
export function toSettled(it: ItemLike): SettledItem {
  const out: SettledItem = { uid: it.uid, def: it.def, qty: it.qty, rarity: it.rarity, dur: it.dur };
  if (it.label) out.label = it.label;
  if (it.lvl) out.lvl = it.lvl;
  return out;
}

/** Tracked by the ledger: a non-FREE unique with a uid. */
export function isTrackedUnique(it: ItemLike): boolean {
  return !!it.uid && !(it.flags & ITEM_FLAG.FREE) && itemDef(it.def)?.unique === true;
}

export class Ledger {
  readonly known = new Map<string, { origin: UidOrigin; def: string }>();
  readonly resolved = new Map<string, UidResolution>();
  /** Demo-minted uniques, in mint order (MatchEndReport.minted). */
  readonly minted: SettledItem[] = [];
  /** Problems seen in non-strict mode (logged; tests run strict and throw instead). */
  readonly anomalies: string[] = [];

  constructor(readonly strict: boolean) {}

  register(it: ItemLike, origin: UidOrigin): void {
    if (!it.uid) return;
    if (this.known.has(it.uid)) return this.fail(`uid ${it.uid} registered twice`);
    this.known.set(it.uid, { origin, def: it.def });
    if (origin === "minted") this.minted.push(toSettled(it));
  }

  resolve(it: ItemLike, how: UidResolution): void {
    if (!isTrackedUnique(it)) return;
    if (!this.known.has(it.uid)) return this.fail(`resolve of unknown uid ${it.uid} (${how})`);
    const prev = this.resolved.get(it.uid);
    if (prev) return this.fail(`uid ${it.uid} resolved twice: ${prev} then ${how}`);
    this.resolved.set(it.uid, how);
  }

  private fail(msg: string): void {
    if (this.strict) throw new Error(`[ledger] ${msg}`);
    this.anomalies.push(msg);
    console.error(`[ledger] ${msg}`);
  }
}

/** A reported unique (SettledItem has no flags: FREE items carry no uid). */
function isReportedUnique(s: SettledItem): boolean {
  return !!s.uid && itemDef(s.def)?.unique === true;
}

/**
 * NPCs are never reported to the web (no PlayerExitReport). Match.end already settles what they
 * carry: a living NPC's pool uniques (boss bag, carrier) are leftOnMap (back to the pool, no wear),
 * a dead NPC's are in its corpse (leftOnMap unless a human took them) and nothing of theirs ever
 * breaks (NPC.NO_BREAK) or wears out (their armor is FREE). This is the safety net for anything an
 * NPC exit report still lists (`lost` / `extracted` of a timeout): appended to leftOnMap, once per
 * uid. It never produces the deprecated botLost / botDestroyed. Returns a new report.
 */
export function withNpcSettlement(
  report: MatchEndReport,
  runtimes: ReadonlyArray<{ isNpc: boolean; exitReport: PlayerExitReport | null }>,
): MatchEndReport {
  const seen = new Set(report.leftOnMap.map((s) => s.uid).filter(Boolean));
  const left: SettledItem[] = [];
  for (const rt of runtimes) {
    const r = rt.exitReport;
    if (!rt.isNpc || !r) continue;
    for (const s of [...r.extracted, ...r.lost]) {
      if (!isReportedUnique(s) || seen.has(s.uid)) continue;
      seen.add(s.uid);
      left.push(s);
    }
  }
  return left.length ? { ...report, leftOnMap: [...report.leftOnMap, ...left] } : report;
}
