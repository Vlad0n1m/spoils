import { RARITY_NAMES, itemDef, type ItemCat } from "@extract/shared";

/**
 * Market template keys ("weapon:rifle:2", "armor:3", "backpack:1", see shared templateKey) for
 * filters, history and labels. Client-safe.
 */

/** Best-effort def of a template (a trade whose item row is gone): "armor:3" → "armor_3". */
export function defOfTemplate(template: string): string {
  const [cat, a] = template.split(":");
  if (cat === "weapon" && a) return a;
  if ((cat === "armor" || cat === "backpack") && a) return `${cat}_${a}`;
  return template;
}

/** "Rifle · Epic", "Armor Lv 3", "Raid pack". */
export function templateLabel(template: string): string {
  const [cat, a, r] = template.split(":");
  if (cat === "weapon" && a) {
    const rn = RARITY_NAMES[Math.max(0, Math.min(3, Number(r) || 0)) as 0 | 1 | 2 | 3];
    return `${itemDef(a)?.name ?? a} · ${rn.charAt(0).toUpperCase()}${rn.slice(1)}`;
  }
  return itemDef(defOfTemplate(template))?.name ?? template;
}

/** Category part of a template key, or null for junk / unknown. */
export function templateCat(template: string): Extract<ItemCat, "weapon" | "armor" | "backpack"> | null {
  const cat = template.split(":")[0];
  return cat === "weapon" || cat === "armor" || cat === "backpack" ? cat : null;
}

export const MARKET_CATS = ["all", "weapon", "armor", "backpack"] as const;
export type MarketCat = (typeof MARKET_CATS)[number];
