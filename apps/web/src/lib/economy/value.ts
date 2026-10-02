import { SCRAP_CR, armorMaxPoints, armorPct, armorPoints, itemDef } from "@extract/shared";

/**
 * Reference CR value of a unique (scrap table × durability). Used where the economy needs an
 * ordering or a weight without a market index: the 1% treasury tax accumulator and the
 * "best N go to the boss" pick. Scrapping itself is cut for v2; only the table is reused.
 */
export function itemRefValueCr(item: { def: string; rarity: number; dur: number }): number {
  const d = itemDef(item.def);
  if (!d) return 0;
  const pct = Math.max(0, Math.min(100, item.dur)) / 100;
  if (d.cat === "weapon") return SCRAP_CR.weapon[clampIdx(item.rarity, 3)]! * pct;
  if (d.cat === "armor" && d.armorLevel) return SCRAP_CR.armor[d.armorLevel] * pct;
  if (d.cat === "backpack" && d.bpLevel) return SCRAP_CR.backpack[d.bpLevel] * pct;
  return 0;
}

function clampIdx(v: number, max: number): number {
  return Math.max(0, Math.min(max, Math.floor(v)));
}

/**
 * DB durability (0..100 %) → in-raid InvItem.dur. Armor counts absorb points in a raid
 * (critique "Durability semantics"); everything else stays a percentage.
 */
export function toRaidDur(def: string, pct: number): number {
  const d = itemDef(def);
  if (d?.cat === "armor") return armorPoints(armorMaxPoints(d), pct);
  return Math.max(0, Math.min(100, pct));
}

/** In-raid InvItem.dur → DB durability %. Inverse of toRaidDur, clamped to 0..100. */
export function fromRaidDur(def: string, dur: number): number {
  const d = itemDef(def);
  if (!Number.isFinite(dur)) return 0;
  if (d?.cat === "armor") return armorPct(armorMaxPoints(d), dur);
  return Math.max(0, Math.min(100, dur));
}
