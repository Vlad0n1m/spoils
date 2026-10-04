/**
 * Level presentation for the menu (WORLD v6 spec §6.2, §6.6; docs/RETENTION.md §3): badge colours,
 * what a new level unlocks and the rewards table. Pure; the numbers come from the shared economy
 * (MARKET, BOUND_OFFERS, boundTraderLevel, LEVEL_REWARDS, MARK_REWARDS, COSMETICS).
 */
import {
  BOUND_OFFERS,
  LEVEL_REWARDS,
  MARK_REWARDS,
  MARKET,
  RARITY_NAMES,
  boundTraderLevel,
  cosmeticDef,
  itemDef,
  type CosmeticKind,
} from "@extract/shared";

/** Level badge colour (spec §6.2): 1–4 grey, 5–9 lime, 10–14 blue, 15–19 violet, 20+ gold. */
export function levelColor(level: number): string {
  const l = Number.isFinite(level) ? Math.floor(level) : 1;
  if (l >= 20) return "#ffc93c";
  if (l >= 15) return "#b07bff";
  if (l >= 10) return "#4cc9ff";
  if (l >= 5) return "#CCFF00";
  return "#cbd5e1";
}

const BADGE_BAND: Readonly<Record<number, string>> = { 5: "lime", 10: "blue", 15: "violet", 20: "gold" };

/** "feature" = something the game opens up (market, traders, badge colour); the rest are cosmetics. */
export type RewardKind = "feature" | CosmeticKind;
export interface RewardItem {
  kind: RewardKind;
  /** "Title: Raider", "Market selling unlocked". */
  label: string;
  /** Cosmetic id (COSMETICS), cosmetics only. */
  id?: string;
  /** Name colour / frame colour, cosmetics only. */
  hex?: string;
  /** Feature unlocks only: what opens up (drawn as its icon on the reward cards). */
  feature?: FeatureKind;
}

/** Market selling, a bound-trader tier, a new level badge colour. */
export type FeatureKind = "market" | "trader" | "band";

/** Which feature a feature-unlock line is ("Market selling unlocked", "Traders tier 2: …", "Level badge turns lime"). */
export function featureKindOf(label: string): FeatureKind {
  if (label.startsWith("Market")) return "market";
  if (label.startsWith("Traders")) return "trader";
  return "band";
}

const KIND_WORD: Readonly<Record<CosmeticKind, string>> = { title: "Title", color: "Name colour", frame: "Badge frame", skin: "Skin", badge: "Badge" };

/** "Title: Raider", "Name colour: Lime", "Badge frame: Rope" ("" for an unknown id). */
export function cosmeticLabel(id: string): string {
  const d = cosmeticDef(id);
  return d ? `${KIND_WORD[d.kind]}: ${d.name}` : "";
}

/** A cosmetic as a reward item, or null for an unknown id. */
export function cosmeticItem(id: string): RewardItem | null {
  const d = cosmeticDef(id);
  return d ? { kind: d.kind, label: cosmeticLabel(id), id, ...(d.hex ? { hex: d.hex } : {}) } : null;
}

/** Feature unlocks of exactly `level`: market selling, a new bound-trader tier with offers, badge colour. */
function featureUnlocks(l: number, sellUnlockLevel: number): string[] {
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
  const band = BADGE_BAND[l];
  if (band) out.push(`Level badge turns ${band}`);
  return out;
}

/** Everything reaching `level` gives: feature unlocks first, then cosmetics (LEVEL_REWARDS). */
export function levelRewards(level: number, sellUnlockLevel: number = MARKET.SELL_UNLOCK_LEVEL): RewardItem[] {
  const l = Math.floor(level);
  const out: RewardItem[] = featureUnlocks(l, sellUnlockLevel).map((label) => ({ kind: "feature" as const, label, feature: featureKindOf(label) }));
  for (const id of LEVEL_REWARDS.find((r) => r.level === l)?.ids ?? []) {
    const it = cosmeticItem(id);
    if (it) out.push(it);
  }
  return out;
}

/** What reaching `level` unlocks, as lines for the LEVEL N window (empty for most levels). */
export function levelUnlocks(level: number, sellUnlockLevel: number = MARKET.SELL_UNLOCK_LEVEL): string[] {
  return levelRewards(level, sellUnlockLevel).map((r) => r.label);
}

/** Unlocks of every level in (from, to]. */
export function unlocksBetween(from: number, to: number, sellUnlockLevel?: number): string[] {
  const out: string[] = [];
  for (let l = Math.floor(from) + 1; l <= Math.floor(to); l++) out.push(...levelUnlocks(l, sellUnlockLevel));
  return out;
}

/** Rewards of every level in (from, to], as items (the LEVEL N window's cards). */
export function rewardsBetween(from: number, to: number, sellUnlockLevel?: number): RewardItem[] {
  const out: RewardItem[] = [];
  for (let l = Math.floor(from) + 1; l <= Math.floor(to); l++) out.push(...levelRewards(l, sellUnlockLevel));
  return out;
}

/** Highest level the rewards table lists (the last cosmetic reward). */
export const REWARD_TABLE_TOP = Math.max(...LEVEL_REWARDS.map((r) => r.level));

/** Every level from 2 to REWARD_TABLE_TOP that gives something, in order (the Rewards view). */
export function rewardTable(sellUnlockLevel: number = MARKET.SELL_UNLOCK_LEVEL): Array<{ level: number; items: RewardItem[] }> {
  const out: Array<{ level: number; items: RewardItem[] }> = [];
  for (let l = 2; l <= REWARD_TABLE_TOP; l++) {
    const items = levelRewards(l, sellUnlockLevel);
    if (items.length > 0) out.push({ level: l, items });
  }
  return out;
}

/** The next level above `level` that gives something, or null past the table. */
export function nextReward(level: number, sellUnlockLevel: number = MARKET.SELL_UNLOCK_LEVEL): { level: number; items: RewardItem[] } | null {
  return rewardTable(sellUnlockLevel).find((r) => r.level > Math.floor(level)) ?? null;
}

/** Task-mark rewards (MARK_REWARDS) as reward items. */
export function markRewardTable(): Array<{ marks: number; items: RewardItem[] }> {
  return MARK_REWARDS.map((r) => ({ marks: r.marks, items: r.ids.map(cosmeticItem).filter((x): x is RewardItem => x !== null) }));
}

/** The equipped name colour as CSS, or undefined (default text colour). */
export function nameColorHex(id: string | null | undefined): string | undefined {
  const d = id ? cosmeticDef(id) : null;
  return d?.kind === "color" ? d.hex : undefined;
}

/** The equipped title's text, or null. */
export function titleName(id: string | null | undefined): string | null {
  const d = id ? cosmeticDef(id) : null;
  return d?.kind === "title" ? d.name : null;
}
