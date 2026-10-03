/**
 * Level presentation for the menu (WORLD v6 spec §6.2, §6.6): badge colours and what a new level
 * unlocks. Pure; the numbers come from the shared economy (MARKET, BOUND_OFFERS, boundTraderLevel).
 */
import { BOUND_OFFERS, MARKET, RARITY_NAMES, boundTraderLevel, itemDef } from "@extract/shared";

/** Level badge colour (spec §6.2): 1–4 grey, 5–9 lime, 10–14 blue, 15–19 violet, 20+ gold. */
export function levelColor(level: number): string {
  const l = Number.isFinite(level) ? Math.floor(level) : 1;
  if (l >= 20) return "#ffc93c";
  if (l >= 15) return "#b07bff";
  if (l >= 10) return "#4cc9ff";
  if (l >= 5) return "#CCFF00";
  return "#cbd5e1";
}

/** What reaching `level` unlocks (empty for most levels). */
export function levelUnlocks(level: number, sellUnlockLevel: number = MARKET.SELL_UNLOCK_LEVEL): string[] {
  const l = Math.floor(level);
  const out: string[] = [];
  if (l === sellUnlockLevel) out.push("Market selling unlocked");
  if (l > 1) {
    const tier = boundTraderLevel(l);
    if (tier > boundTraderLevel(l - 1)) {
      const offers = BOUND_OFFERS.filter((o) => o.traderLevel === tier);
      if (offers.length > 0) {
        const names = offers.map((o) => {
          const r = o.rarity > 0 ? RARITY_NAMES[o.rarity] ?? "" : "";
          const word = r ? `${r.charAt(0).toUpperCase()}${r.slice(1)} ` : "";
          return `${word}${itemDef(o.def)?.name ?? o.def}`;
        });
        out.push(`Traders tier ${tier}: ${names.join(", ")}`);
      }
    }
  }
  return out;
}

/** Unlocks of every level in (from, to]. */
export function unlocksBetween(from: number, to: number, sellUnlockLevel?: number): string[] {
  const out: string[] = [];
  for (let l = Math.floor(from) + 1; l <= Math.floor(to); l++) out.push(...levelUnlocks(l, sellUnlockLevel));
  return out;
}
