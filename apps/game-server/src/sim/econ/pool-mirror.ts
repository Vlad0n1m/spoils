/**
 * In-process mirror of the web's legacy (pre-v6, per-match) lost-pool release for the economy
 * benches' roster raids: the v4/v5 allocatePool that raids/start used to run (removed from the web in
 * WORLD v6; its pure helpers releasePlan / planAllocation / normCarriers / rankBossSlots stay in
 * apps/web/src/lib/economy/pool.ts), plus seed.ts seedEconomy and value.ts. The WORLD v6 per-entry
 * release (releaseForEntry / fillBossBag) is mirrored in world-harness.ts. The game server must not import the
 * web app (drizzle, DB), so the few pure pieces are mirrored here and the shared pure functions
 * (poolReleasePlanV4, uniqueTierScore, poolContainerEligible / Weight, armorPoints, SCRAP_CR, SEED_KIT) are reused as-is.
 *
 * KEEP IN SYNC with apps/web/src/lib/economy/{pool,seed,value}.ts when those change:
 * - planAllocation / rankBossSlots / normCarriers: verbatim copies of the web functions (v4 boss
 *   slots first by tier score, the rest only into T3/T4 crate / toolbox / weapon_box / safe,
 *   guarded ×4; v5 NPC carriers — spawned T3/T4 marauders — in the same draw at
 *   npcCarrierWeight, one item each, never refilled);
 * - mirrorAllocatePool: the legacy allocatePool with poolReleasePlanV4 (the web's releasePlan at its default
 *   knobs) and the DB picks (`order by tier score desc, random()` for bosses, random for the rest;
 *   with no eligible container the rest is capped at the carrier capacity);
 * - seedPiece: seed.ts rollPiece (giveaway-kit-like pieces, ~12% rarer weapons) + dur 55..100;
 * - refValueCr: value.ts itemRefValueCr (SCRAP_CR × dur);
 * - npcPriceMinor: seed.ts NPC_PRICE_MINOR (without the ±15% listing jitter).
 */

import {
  BOSSES,
  SEED_KIT,
  SCRAP_CR,
  armorMaxPoints,
  armorPoints,
  bossKindOfLootKey,
  bossLootKey,
  itemDef,
  mulberry32,
  npcCarrierEligible,
  npcCarrierWeight,
  parseNpcCarrierKey,
  NPC_CARRIER,
  pickWeighted,
  poolContainerEligible,
  poolContainerWeight,
  poolReleasePlanV4,
  uniqueTierScore,
  type BossKind,
  type ContainerKind,
  type LootTier,
  type Rng,
  type SettledItem,
} from "@extract/shared";

/** A lost-pool row (DB shape: durability in %). */
export interface PoolItem {
  uid: string;
  def: string;
  rarity: number;
  /** 0..100 %. */
  dur: number;
}

/**
 * pool: a T3/T4 container release; carrier: a pool item stowed on a marauder (v5); boss: a boss bag;
 * own: the extractor's own loadout; looted: another human's loadout (PvP, multi-human runs);
 * floor: deprecated (v3 free floor); other: anything else (should stay 0 in live mode).
 */
export type UniqueOrigin = "pool" | "floor" | "boss" | "carrier" | "own" | "looted" | "other";

/** seed.ts rollPiece: weapon / armor / backpack in turn, like the giveaway kits the pool mirrors. */
function seedPiece(i: number, rng: Rng): { def: string; rarity: number } {
  const slot = i % 3;
  if (slot === 0) {
    if (rng() < 0.12) return { def: rng() < 0.5 ? "sniper" : "rifle", rarity: rng() < 0.3 ? 3 : 2 };
    const w = pickWeighted(rng, SEED_KIT.weapon);
    return { def: w.def, rarity: w.rarity };
  }
  if (slot === 1) {
    const a = rng() < 0.08 ? { def: "armor_3" } : pickWeighted(rng, SEED_KIT.armor);
    return { def: a.def, rarity: itemDef(a.def)?.rarity ?? 0 };
  }
  const lv = rng() < 0.15 ? 2 : 1;
  return { def: `backpack_${lv}`, rarity: lv - 1 };
}

/** A pool like seedEconomy's (default 700 items, dur 55..100 %). */
export function seedPool(n: number, rng: Rng, uidPrefix = "pool"): PoolItem[] {
  const out: PoolItem[] = [];
  for (let i = 0; i < n; i++) {
    const p = seedPiece(i, rng);
    out.push({ uid: `${uidPrefix}-${i}`, def: p.def, rarity: p.rarity, dur: Math.round(55 + rng() * 45) });
  }
  return out;
}

/** value.ts itemRefValueCr: SCRAP_CR × durability (the pool's ordering / tax value). */
export function refValueCr(item: { def: string; rarity: number; dur: number }): number {
  const d = itemDef(item.def);
  if (!d) return 0;
  const pct = Math.max(0, Math.min(100, item.dur)) / 100;
  if (d.cat === "weapon") return SCRAP_CR.weapon[Math.max(0, Math.min(3, Math.floor(item.rarity)))]! * pct;
  if (d.cat === "armor" && d.armorLevel) return SCRAP_CR.armor[d.armorLevel] * pct;
  if (d.cat === "backpack" && d.bpLevel) return SCRAP_CR.backpack[d.bpLevel] * pct;
  return 0;
}

/** seed.ts NPC_PRICE_MINOR: market reference price (minor units, "SOL cents") at 100 %. */
export const NPC_PRICE_MINOR = {
  weapon: [300, 900, 2500, 6000],
  armor: [0, 400, 1100, 2800],
  backpack: [0, 300, 900, 2200],
} as const;

/** Market reference value in minor units: NPC price × (0.6 + 0.4 × dur%), no listing jitter. */
export function npcPriceMinor(item: { def: string; rarity: number; dur: number }): number {
  const d = itemDef(item.def);
  if (!d) return 0;
  const base =
    d.cat === "weapon"
      ? NPC_PRICE_MINOR.weapon[Math.max(0, Math.min(3, item.rarity))]!
      : d.cat === "armor"
        ? NPC_PRICE_MINOR.armor[d.armorLevel ?? 1]
        : d.cat === "backpack"
          ? NPC_PRICE_MINOR.backpack[d.bpLevel ?? 1]
          : 0;
  return Math.round(base * (0.6 + (0.4 * Math.max(0, Math.min(100, item.dur))) / 100));
}

/** value.ts toRaidDur: DB % → in-raid dur (armor counts absorb points). */
export function toRaidDur(def: string, pct: number): number {
  const d = itemDef(def);
  if (d?.cat === "armor") return armorPoints(armorMaxPoints(d), pct);
  return Math.max(0, Math.min(100, pct));
}

/** value.ts fromRaidDur: in-raid dur → DB %. */
export function fromRaidDur(def: string, dur: number): number {
  const d = itemDef(def);
  if (!Number.isFinite(dur)) return 0;
  if (d?.cat === "armor") {
    const max = armorMaxPoints(d);
    return max > 0 ? Math.max(0, Math.min(100, (dur / max) * 100)) : 0;
  }
  return Math.max(0, Math.min(100, dur));
}

// ---------------------------------------------------------------- planAllocation (verbatim mirror, v4)

export interface AllocContainer {
  idx: number;
  kind: ContainerKind;
  tier: LootTier;
  /** Within POOL.GUARDED_RADIUS_PX of a BossSpot (containerGuarded; sent by the game server). */
  guarded?: boolean;
}

/** A spawned boss and its pool slots (RaidStartRequest.bosses). */
export interface AllocBoss {
  kind: BossKind;
  slots: readonly number[];
}

export interface AllocPick {
  id: string;
  value: number;
  score: number;
}

/** pool.ts rankBossSlots: min tier score desc, then the tougher boss (BOSSES hp), then slot order. */
export function rankBossSlots(bosses: readonly AllocBoss[]): Array<{ kind: BossKind; min: number }> {
  const slots: Array<{ kind: BossKind; min: number; hp: number; i: number }> = [];
  for (const b of bosses) b.slots.forEach((min, i) => slots.push({ kind: b.kind, min, hp: BOSSES[b.kind]?.hp ?? 0, i }));
  slots.sort((a, b) => b.min - a.min || b.hp - a.hp || a.i - b.i);
  return slots.map(({ kind, min }) => ({ kind, min }));
}

/** A v5 allocation carrier (RaidStartRequest.carriers entry). */
export interface AllocCarrier {
  key: string;
  tier: number;
}

/** pool.ts normCarriers: well-formed keys once each, tier 3..4, sorted by key. */
export function normCarriers(carriers: readonly AllocCarrier[] | undefined): AllocCarrier[] {
  const seen = new Set<string>();
  const out: AllocCarrier[] = [];
  for (const c of carriers ?? []) {
    if (!c || typeof c.key !== "string" || !parseNpcCarrierKey(c.key) || seen.has(c.key)) continue;
    const tier = Math.floor(Number(c.tier));
    if (!Number.isFinite(tier) || !npcCarrierEligible(tier) || tier > 4) continue;
    seen.add(c.key);
    out.push({ key: c.key, tier });
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** pool.ts carrierCapacity: one item per carrier (NPC_CARRIER.MAX_PER_NPC). */
export function carrierCapacity(carriers: readonly AllocCarrier[]): number {
  return carriers.length * Math.min(1, NPC_CARRIER.MAX_PER_NPC);
}

/**
 * pool.ts planAllocation (v4 + v5 carriers): boss slots first (picks ranked by tier score, then
 * value), the rest one per destination value-descending, each drawn by weight among the
 * poolContainerEligible containers (tier >= 3, crate / toolbox / weapon_box / safe; weight
 * poolContainerWeight = (tier+1)² × guarded ×4) and the carriers (npcCarrierWeight = 2 × (tier+1)²,
 * one each, ever). When every container holds one a new container round starts; carriers never refill.
 */
export function planAllocation(
  picks: readonly AllocPick[],
  containers: readonly AllocContainer[],
  bosses: readonly AllocBoss[],
  seed: number,
  carriers: readonly AllocCarrier[] = [],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const ranked = [...picks].sort((a, b) => b.score - a.score || b.value - a.value || (a.id < b.id ? -1 : 1));
  const slots = rankBossSlots(bosses);
  const nBoss = Math.min(slots.length, ranked.length);
  for (let i = 0; i < nBoss; i++) {
    const key = bossLootKey(slots[i]!.kind);
    out.set(key, [...(out.get(key) ?? []), ranked[i]!.id]);
  }
  const rest = ranked.slice(nBoss).sort((a, b) => b.value - a.value || (a.id < b.id ? -1 : 1));
  const eligible = containers.filter(poolContainerEligible).sort((a, b) => a.idx - b.idx);
  const npcs = normCarriers(carriers);
  if (eligible.length === 0 && npcs.length === 0) return out;
  type Dest = { key: string; w: number; carrier: boolean };
  const dests: Dest[] = [
    ...eligible.map((c) => ({ key: String(c.idx), w: poolContainerWeight(c), carrier: false })),
    ...npcs.map((c) => ({ key: c.key, w: npcCarrierWeight(c.tier), carrier: true })),
  ];
  const rng = mulberry32((seed ^ 0x51ed270b) >>> 0);
  const used = new Set<string>();
  for (const p of rest) {
    let unused = dests.filter((d) => !used.has(d.key));
    if (eligible.length > 0 && !unused.some((d) => !d.carrier)) {
      for (const d of dests) if (!d.carrier) used.delete(d.key);
      unused = dests.filter((d) => !used.has(d.key));
    }
    if (unused.length === 0) break;
    const total = unused.reduce((s, d) => s + d.w, 0);
    let roll = rng() * total;
    let pick = unused.length - 1;
    for (let i = 0; i < unused.length; i++) {
      roll -= unused[i]!.w;
      if (roll <= 0) {
        pick = i;
        break;
      }
    }
    const d = unused[pick]!;
    used.add(d.key);
    out.set(d.key, [...(out.get(d.key) ?? []), p.id]);
  }
  return out;
}

/** Top-tier (uniqueTierScore 2) items in a pool. */
export function topTierCount(pool: readonly PoolItem[]): number {
  let n = 0;
  for (const p of pool) if (uniqueTierScore(p.def, p.rarity) === 2) n++;
  return n;
}

export interface MirrorAllocation {
  /** RaidStartResponse.containerLoot (keys: container idx, "boss:<kind>"). */
  containerLoot: Record<string, SettledItem[]>;
  released: number;
  /** poolReleasePlanV4 risk part. */
  risk: number;
  /** Items placed in boss bags. */
  boss: number;
  /** Items placed in containers. */
  container: number;
  /** Items stowed on marauder carriers (v5). */
  carrier: number;
  /** Carriers offered (spawned T3/T4 marauders). */
  carriersOffered: number;
  /** Of `container`, how many in guarded containers. */
  guarded: number;
  /** @deprecated v4 has no free floor (always 0; kept for old reports). */
  floor: number;
  /** uid → where it came from ("pool" container release, "boss" boss bag, "carrier" marauder). */
  origin: Map<string, UniqueOrigin>;
  /** Released items by uid (DB view: dur %). */
  items: Map<string, PoolItem>;
}

/**
 * allocatePool (v4) without the DB: poolReleasePlanV4(P, R, Σ boss slots); bosses first
 * (`order by tier score desc, random()` → a shuffle then a stable sort by score), the rest a
 * uniform random pick (`order by random()`), only when an eligible container exists; then
 * planAllocation. Picked items leave `pool` (in_raid); unplaced ones go back.
 */
export function mirrorAllocatePool(
  pool: PoolItem[],
  req: {
    matchSeed: number;
    containers: readonly AllocContainer[];
    bosses: readonly AllocBoss[];
    riskUnits: number;
    /** v5 RaidStartRequest.carriers (raidNpcCarriers); absent = none. */
    carriers?: readonly AllocCarrier[];
  },
  rng: Rng,
): MirrorAllocation {
  const carriers = normCarriers(req.carriers);
  const out: MirrorAllocation = {
    containerLoot: {}, released: 0, risk: 0, boss: 0, container: 0, carrier: 0, carriersOffered: carriers.length,
    guarded: 0, floor: 0, origin: new Map(), items: new Map(),
  };
  const nSlots = req.bosses.reduce((n, b) => n + b.slots.length, 0);
  const eligible = req.containers.filter(poolContainerEligible);
  if (eligible.length === 0 && nSlots === 0 && carriers.length === 0) return out;
  const rel = poolReleasePlanV4(pool.length, Math.max(0, req.riskUnits), nSlots);
  out.risk = rel.risk;
  const bossTake = Math.min(nSlots, rel.total);
  const contTake = eligible.length > 0 ? rel.total - bossTake : Math.min(rel.total - bossTake, carrierCapacity(carriers));
  if (bossTake + contTake <= 0) return out;
  // Random order first (Fisher-Yates), then bosses take the best tier scores (stable sort keeps the shuffle as tie-break).
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  const byScore = pool.map((p, i) => ({ p, i, s: uniqueTierScore(p.def, p.rarity) })).sort((a, b) => b.s - a.s || a.i - b.i);
  const bossPicks = byScore.slice(0, bossTake).map((e) => e.p);
  const bossSet = new Set(bossPicks);
  const contPicks: PoolItem[] = [];
  for (const p of pool) {
    if (contPicks.length >= contTake) break;
    if (!bossSet.has(p)) contPicks.push(p);
  }
  const picked = [...bossPicks, ...contPicks];
  const pickedSet = new Set(picked);
  const keep = pool.filter((p) => !pickedSet.has(p));
  pool.length = 0;
  pool.push(...keep);
  const byId = new Map(picked.map((p) => [p.uid, p]));
  const guardedIdx = new Set(req.containers.filter((c) => c.guarded).map((c) => String(c.idx)));
  const plan = planAllocation(
    picked.map((p) => ({ id: p.uid, value: refValueCr(p), score: uniqueTierScore(p.def, p.rarity) })),
    req.containers,
    req.bosses,
    req.matchSeed,
    carriers,
  );
  const placed = new Set<string>();
  for (const [key, ids] of plan) {
    const isBoss = bossKindOfLootKey(key) !== null;
    const isCarrier = parseNpcCarrierKey(key) !== null;
    for (const id of ids) {
      const p = byId.get(id)!;
      placed.add(id);
      (out.containerLoot[key] ??= []).push({ uid: p.uid, def: p.def, qty: 1, rarity: p.rarity, dur: toRaidDur(p.def, p.dur) });
      out.items.set(id, p);
      out.origin.set(id, isBoss ? "boss" : isCarrier ? "carrier" : "pool");
      out.released++;
      if (isBoss) out.boss++;
      else if (isCarrier) out.carrier++;
      else {
        out.container++;
        if (guardedIdx.has(key)) out.guarded++;
      }
    }
  }
  // Items without a home stay in the pool (allocatePool never moves them).
  for (const p of picked) if (!placed.has(p.uid)) pool.push(p);
  return out;
}
