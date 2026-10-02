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
 * Bots are never reported to the web (no PlayerExitReport), so uniques they picked up (lost-pool
 * allocations, a dead player's gear) would stay in_raid on the web and be swept as anomalies by
 * raids/end. Their resolutions ride on the MatchEndReport instead:
 * - extract / timeout: the items left the match with nobody to own them → leftOnMap (pool, no wear);
 * - death: uniques that broke → botLost (pool with the death wear; survivors are in the corpse,
 *   already in leftOnMap through the containers);
 * - armor worn to 0 → botDestroyed.
 * Returns a new report; leftOnMap keeps its order with the bot items appended. Idempotent per uid.
 */
export function withBotSettlement(
  report: MatchEndReport,
  bots: ReadonlyArray<{ isBot: boolean; exitReport: PlayerExitReport | null }>,
): MatchEndReport {
  const seen = new Set(report.leftOnMap.map((s) => s.uid).filter(Boolean));
  const left: SettledItem[] = [];
  const lost: SettledItem[] = [...(report.botLost ?? [])];
  const destroyed: SettledItem[] = [...(report.botDestroyed ?? [])];
  for (const s of [...lost, ...destroyed]) seen.add(s.uid);
  const add = (to: SettledItem[], list: readonly SettledItem[]) => {
    for (const s of list) {
      if (!isReportedUnique(s) || seen.has(s.uid)) continue;
      seen.add(s.uid);
      to.push(s);
    }
  };
  for (const b of bots) {
    const r = b.exitReport;
    if (!b.isBot || !r) continue;
    add(destroyed, r.destroyed);
    if (r.exit === "extract") add(left, r.extracted);
    else if (r.exit === "dead") add(lost, r.lost);
    else add(left, r.lost);
  }
  return { ...report, leftOnMap: [...report.leftOnMap, ...left], botLost: lost, botDestroyed: destroyed };
}
