import { sql, type SQL } from "drizzle-orm";
import {
  BOSSES,
  ITEM_IDS,
  POOL,
  WORLD,
  bossFillPlan,
  poolReleaseForEntry,
  bossLootKey,
  itemDef,
  mulberry32,
  npcCarrierEligible,
  npcCarrierWeight,
  parseNpcCarrierKey,
  NPC_CARRIER,
  poolContainerEligible,
  poolContainerWeight,
  poolEntry,
  takeTreasuryTax,
  uniqueTierScore,
  type BossKind,
  type ContainerKind,
  type LootTier,
  type SettledItem,
} from "@extract/shared";
import type { Tx } from "../inventory/db";
import { applyMove, lockItem, type LockedItem } from "../inventory/transition";
import { PARAM, getNumberParam, lockNumberParam, setParam } from "./params";
import { itemRefValueCr, toRaidDur } from "./value";

// ---------------------------------------------------------------- pool entry

export interface PoolCandidate {
  id: string;
  /** Durability % reported by the game server (min with the DB value, never raises it). */
  reportedPct?: number;
  /** Broke on death: enters at −POOL.BREAK_DUR_LOSS. Left on map / timeout: no wear. */
  broke: boolean;
  /** item_events reason: break | timeout | mia | left | sweep | guest | return | expire. */
  reason: string;
  /** item_events ref_id of the move (WORLD v6: the entryId for exit settlement); default the matchId. */
  refId?: string;
  /**
   * Counts toward the 1% treasury tax (default true). WORLD v6 D20: items that never belonged to a
   * player in this match (pool allocations left on the map, unplaced, swept, voided-entry
   * allocations, NPC-corpse expiry) re-enter untaxed.
   */
  taxable?: boolean;
}

export interface PoolEntryResult {
  pooled: string[];
  destroyed: string[];
  taxed: string[];
  /** Unknown uids, or items not in_raid in this match (already resolved / never allocated). */
  skipped: string[];
}

/**
 * Moves in-raid items of `matchId` into the lost pool (economy memo §6): poolEntry decides the
 * durability (−8 when broke) or destruction (bound, or worn out). Then the 1% treasury tax runs
 * on the value that entered: the accumulator in economy_params takes whole items into `treasury`
 * once it covers them. Caller supplies the transaction; every move is guarded by
 * state = in_raid AND match_id = matchId, so a replay finds nothing to move.
 */
export async function enterPool(tx: Tx, matchId: string, cands: readonly PoolCandidate[]): Promise<PoolEntryResult> {
  const out: PoolEntryResult = { pooled: [], destroyed: [], taxed: [], skipped: [] };
  const entering: Array<{ uid: string; value: number }> = [];
  for (const c of cands) {
    const it = await lockItem(tx, c.id);
    if (!it || it.state !== "in_raid" || it.matchId !== matchId) {
      out.skipped.push(c.id);
      continue;
    }
    const moved = await poolOne(tx, it, c, c.refId ?? matchId);
    if (moved.state === "destroyed") out.destroyed.push(it.id);
    else {
      out.pooled.push(it.id);
      if (c.taxable !== false) {
        entering.push({ uid: it.id, value: itemRefValueCr({ def: it.defId, rarity: it.rarity, dur: moved.durability }) });
      }
    }
  }
  if (entering.length > 0) out.taxed = await applyTreasuryTax(tx, matchId, entering);
  return out;
}

async function poolOne(tx: Tx, it: LockedItem, c: PoolCandidate, refId: string): Promise<LockedItem> {
  const cur =
    c.reportedPct !== undefined && Number.isFinite(c.reportedPct) ? Math.min(it.durability, c.reportedPct) : it.durability;
  const dur = poolEntry({ dur: cur, bound: it.bound }, c.broke);
  if (dur === null) {
    return applyMove(
      tx,
      it,
      { state: "destroyed", ownerId: null, matchId: null, loadoutId: null, durability: Math.max(0, cur) },
      { reason: "destroy", refId },
    );
  }
  return applyMove(
    tx,
    it,
    { state: "lost_pool", ownerId: null, matchId: null, loadoutId: null, durability: dur },
    { reason: c.reason, refId },
  );
}

/** 1% tax on entering value; taken items lost_pool → treasury. Returns the taken ids. */
async function applyTreasuryTax(
  tx: Tx,
  refId: string,
  entering: Array<{ uid: string; value: number }>,
): Promise<string[]> {
  const acc = await lockNumberParam(tx, PARAM.TAX_ACC);
  const res = takeTreasuryTax(acc, entering);
  for (const uid of res.taken) {
    const it = await lockItem(tx, uid);
    if (!it || it.state !== "lost_pool") continue;
    await applyMove(tx, it, { state: "treasury" }, { reason: "tax", refId });
  }
  await setParam(tx, PARAM.TAX_ACC, res.acc);
  return res.taken;
}

// ---------------------------------------------------------------- expiry (WORLD v6, addendum A6)

export interface ExpireCandidate {
  id: string;
  /** Durability % reported by the game server (min with the DB value). */
  reportedPct?: number;
}

/**
 * A6: uniques that vanished with an expired player corpse or as loose ground items a player dropped
 * go to the treasury at once — no wear, no 1% tax step (the treasury sells them on the market like a
 * player). Guarded like enterPool (in_raid in `matchId`); journal reason `expire`, ref = matchId.
 * A bound item never reaches the market: it is destroyed instead (as poolEntry would). Worn-out
 * items (0 %) are destroyed too.
 */
export async function expireToTreasury(
  tx: Tx,
  matchId: string,
  cands: readonly ExpireCandidate[],
): Promise<{ treasury: string[]; destroyed: string[]; skipped: string[] }> {
  const out = { treasury: [] as string[], destroyed: [] as string[], skipped: [] as string[] };
  for (const c of cands) {
    const it = await lockItem(tx, c.id);
    if (!it || it.state !== "in_raid" || it.matchId !== matchId) {
      out.skipped.push(c.id);
      continue;
    }
    const dur =
      c.reportedPct !== undefined && Number.isFinite(c.reportedPct) ? Math.min(it.durability, c.reportedPct) : it.durability;
    if (it.bound || !(dur > 0)) {
      await applyMove(
        tx,
        it,
        { state: "destroyed", ownerId: null, matchId: null, loadoutId: null, durability: Math.max(0, dur) },
        { reason: "destroy", refId: matchId },
      );
      out.destroyed.push(it.id);
      continue;
    }
    await applyMove(
      tx,
      it,
      { state: "treasury", ownerId: null, matchId: null, loadoutId: null, durability: dur },
      { reason: "expire", refId: matchId },
    );
    out.treasury.push(it.id);
  }
  return out;
}

// ---------------------------------------------------------------- WORLD v6 release (raids/enter)

/** Counts of the lost pool: size and top items (tier score 2). */
export async function poolCounts(tx: Tx): Promise<{ size: number; top: number }> {
  const r = await tx.execute<{ size: number; top: number }>(sql`
    select count(*)::int as size, count(*) filter (where ${TIER_SCORE_SQL} = 2)::int as top
    from items where state = 'lost_pool'`);
  return { size: Number(r.rows[0]?.size ?? 0), top: Number(r.rows[0]?.top ?? 0) };
}

/**
 * Takes `n` random lost-pool rows with tier score ≤ maxTier (FOR UPDATE SKIP LOCKED, so two
 * entries never share an item; order `random()` or best tier first) and moves them lost_pool →
 * in_raid (owner NULL, match set) with `reason`, ref = entryId. Returns them as SettledItems.
 */
async function takeFromPool(
  tx: Tx,
  a: { matchId: string; entryId: string; n: number; maxTier: number; reason: "alloc" | "alloc_boss"; bestFirst: boolean },
): Promise<SettledItem[]> {
  const n = Math.max(0, Math.floor(a.n));
  if (n === 0) return [];
  const maxTier = Math.max(0, Math.min(2, Math.floor(a.maxTier)));
  const rows = (
    await tx.execute<PoolRow>(sql`
      select id, def_id, rarity, durability from items
      where state = 'lost_pool' and ${TIER_SCORE_SQL} <= ${maxTier}
      order by ${a.bestFirst ? sql`${TIER_SCORE_SQL} desc, random()` : sql`random()`}
      limit ${n}
      for update skip locked`)
  ).rows;
  const out: SettledItem[] = [];
  for (const r of rows) {
    const it = await lockItem(tx, r.id);
    if (!it || it.state !== "lost_pool") continue;
    const moved = await applyMove(
      tx,
      it,
      { state: "in_raid", ownerId: null, matchId: a.matchId, loadoutId: null },
      { reason: a.reason, refId: a.entryId },
    );
    out.push({ uid: moved.id, def: moved.defId, qty: 1, rarity: moved.rarity, dur: toRaidDur(moved.defId, moved.durability) });
  }
  return out;
}

export interface ReleaseForEntryArgs {
  matchId: string;
  cycleId: number;
  entryId: string;
  userId: string;
  /** This entry's risk units / max tier score of its risk items. */
  riskUnits: number;
  maxTier: number;
  /** Cycle clock at admission. */
  atMs: number;
  /** Valid pool targets on the map (Match.poolTargetCount()). */
  targets: number;
  now: Date;
}

export interface ReleaseForEntryResult {
  items: SettledItem[];
  n: number;
  plan: ReturnType<typeof poolReleaseForEntry>;
  /** Pool size before the release. */
  poolSize: number;
}

/**
 * WORLD v6 release for one entry (spec §4.2 step 6, D17). The caller holds the shard's raids row
 * lock (`for no key update`) so only this part serializes per shard, and has already written the
 * entry's risk_units / max_tier. Aggregates: the user's earlier entries this cycle (max risk, max
 * tier, Σ released), the user's Σ released since UTC midnight, the shard's Σ released and its
 * distinct users with risk ≥ 1 (this entry included). Items: tier score ≤ max(user cycle max tier,
 * entry max tier), random, reason `alloc`, ref entryId.
 */
export async function releaseForEntry(tx: Tx, a: ReleaseForEntryArgs): Promise<ReleaseForEntryResult> {
  const u = await tx.execute<{ max_risk: number; max_tier: number; released: number }>(sql`
    select coalesce(max(risk_units), 0)::int as max_risk, coalesce(max(max_tier), 0)::int as max_tier,
           coalesce(sum(released), 0)::int as released
    from raid_entries where cycle_id = ${a.cycleId} and user_id = ${a.userId} and entry_id <> ${a.entryId}`);
  const dayStart = new Date(Date.UTC(a.now.getUTCFullYear(), a.now.getUTCMonth(), a.now.getUTCDate()));
  const d = await tx.execute<{ released: number }>(sql`
    select coalesce(sum(released), 0)::int as released
    from raid_entries where user_id = ${a.userId} and created_at >= ${dayStart} and entry_id <> ${a.entryId}`);
  const sh = await tx.execute<{ released: number; risk_users: number }>(sql`
    select coalesce(sum(released), 0)::int as released,
           count(distinct user_id) filter (where risk_units >= 1)::int as risk_users
    from raid_entries where match_id = ${a.matchId} and entry_id <> ${a.entryId}`);
  const userRow = u.rows[0];
  const shardRow = sh.rows[0];
  const otherRiskUser = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from raid_entries
    where match_id = ${a.matchId} and user_id = ${a.userId} and risk_units >= 1 and entry_id <> ${a.entryId}`);
  const riskUsers =
    Number(shardRow?.risk_users ?? 0) + (a.riskUnits >= 1 && Number(otherRiskUser.rows[0]?.n ?? 0) === 0 ? 1 : 0);
  const { size } = await poolCounts(tx);
  const k = (await readReleaseParams(tx)).k;
  const plan = poolReleaseForEntry({
    poolSize: size,
    entryRisk: a.riskUnits,
    userCycleMaxRisk: Number(userRow?.max_risk ?? 0),
    userCycleReleased: Number(userRow?.released ?? 0),
    userDayReleased: Number(d.rows[0]?.released ?? 0),
    shardReleased: Number(shardRow?.released ?? 0),
    riskUsers,
    atMs: a.atMs,
    entryCloseMs: WORLD.CYCLE_MS - WORLD.ENTRY_CLOSE_MS,
    targets: a.targets,
    k,
  });
  const maxTier = Math.max(Number(userRow?.max_tier ?? 0), a.maxTier);
  const items = await takeFromPool(tx, { matchId: a.matchId, entryId: a.entryId, n: plan.n, maxTier, reason: "alloc", bestFirst: false });
  return { items, n: items.length, plan, poolSize: size };
}

export interface FillBossBagArgs {
  matchId: string;
  entryId: string;
  boss: BossKind;
  /** raids.boss_bag_filled. */
  filled: boolean;
}

/**
 * WORLD v6 boss bag (spec §4.2 step 7, D19), once per shard-cycle; the caller holds the raids row
 * lock and sets boss_bag_filled when items come back. Gate: bossFillPlan over Σ (max risk of each
 * distinct user on the shard), any entrant's max_tier = 2, the pool size and its top items. Picks
 * `order by tier score desc, random()` with tier score ≤ maxTier, reason `alloc_boss`, ref entryId.
 */
export async function fillBossBag(tx: Tx, a: FillBossBagArgs): Promise<SettledItem[]> {
  const def = BOSSES[a.boss];
  if (!def?.enabled || a.filled) return [];
  const r = await tx.execute<{ risk_sum: number; any_top: boolean }>(sql`
    select coalesce(sum(m), 0)::int as risk_sum, coalesce(bool_or(t), false) as any_top from (
      select user_id, max(risk_units) as m, bool_or(max_tier = 2) as t
      from raid_entries where match_id = ${a.matchId} and status <> 'voided' group by user_id) x`);
  const { size, top } = await poolCounts(tx);
  const plan = bossFillPlan({
    slots: def.poolSlots,
    shardRiskSum: Number(r.rows[0]?.risk_sum ?? 0),
    anyTopRisk: !!r.rows[0]?.any_top,
    poolSize: size,
    topInPool: top,
    filled: a.filled,
  });
  if (plan.n === 0) return [];
  return takeFromPool(tx, { matchId: a.matchId, entryId: a.entryId, n: plan.n, maxTier: plan.maxTier, reason: "alloc_boss", bestFirst: true });
}

// ---------------------------------------------------------------- legacy v4/v5 release math
// Pure helpers of the pre-v6 per-match allocation (raids/start and allocatePool were removed in WORLD v6
// S8). Kept because the economy tests and the sim harness's pool mirror still check the same rules;
// WORLD v6 releases per entry (releaseForEntry) and the game server places the items (D18).

export interface AllocContainer {
  idx: number;
  kind: ContainerKind;
  tier: LootTier;
  /** Within POOL.GUARDED_RADIUS_PX of a BossSpot (containerGuarded, sent by the game server). */
  guarded?: boolean;
}

/** A spawned boss and its pool slots (min uniqueTierScore per slot). */
export interface AllocBoss {
  kind: BossKind;
  slots: readonly number[];
}

/**
 * A spawned T3/T4 marauder that may carry ONE pool unique (NPC MODEL v5 §3.3).
 * Key npcCarrierKey(postId, member) = "npc:<postId>.<member>"; weight npcCarrierWeight(tier) (T3 80, T4 125).
 */
export interface AllocCarrier {
  key: string;
  tier: number;
}

export interface AllocPick {
  id: string;
  /** itemRefValueCr: the order inside a tier score and of container placement. */
  value: number;
  /** uniqueTierScore: 2 top, 1 rare, 0 the rest. */
  score: number;
}

/** Release knobs (economy_params pool_risk_k / pool_max_per_match, default POOL.RISK_K / MAX_PER_MATCH). */
export interface ReleaseParams {
  k: number;
  max: number;
}
export const DEFAULT_RELEASE: ReleaseParams = { k: POOL.RISK_K, max: POOL.MAX_PER_MATCH };

/**
 * poolReleasePlanV4 with the knobs from economy_params (identical to the shared function at
 * DEFAULT_RELEASE; the game server's bench mirror uses the shared one). P = pool size, R = risk
 * units, B = Σ pool slots of the spawned bosses:
 *   risk  = min(P, max, round(k × R))
 *   boss  = R >= BOSS_MIN_RISK && P − risk > BOSS_MIN_POOL ? max(0, min(B, max) − risk) : 0
 * Lever if the pool swells (economy memo §13): k → 1.25 or max → 10. Never a free floor.
 */
export function releasePlan(
  poolSize: number,
  riskUnits: number,
  bossNeed: number,
  p: ReleaseParams = DEFAULT_RELEASE,
): { total: number; risk: number; boss: number } {
  const P = Math.max(0, Math.floor(poolSize));
  const R = Math.max(0, riskUnits);
  const risk = Math.max(0, Math.min(P, p.max, Math.round(p.k * R)));
  const gate = R >= POOL.BOSS_MIN_RISK && P - risk > POOL.BOSS_MIN_POOL;
  const boss = gate ? Math.max(0, Math.min(Math.max(0, Math.floor(bossNeed)), p.max) - risk) : 0;
  return { total: risk + boss, risk, boss };
}

/** Reads the release knobs, clamped to sane ranges (k 0..2, max 0..16). */
export async function readReleaseParams(tx: Tx): Promise<ReleaseParams> {
  const k = await getNumberParam(tx, PARAM.POOL_RISK_K);
  const max = await getNumberParam(tx, PARAM.POOL_MAX_PER_MATCH);
  return {
    k: Number.isFinite(k) ? Math.max(0, Math.min(2, k)) : POOL.RISK_K,
    max: Number.isFinite(max) ? Math.max(0, Math.min(16, Math.floor(max))) : POOL.MAX_PER_MATCH,
  };
}

/**
 * Boss slots in fill order: minimum tier score desc, then the tougher boss first (BOSSES hp:
 * Warden 300, Commander 250, Foreman 240), then slot order. The best picks go to the first slots, so a slot
 * that wants a top item gets one while the pool has any, else the best available.
 */
export function rankBossSlots(bosses: readonly AllocBoss[]): Array<{ kind: BossKind; min: number }> {
  const slots: Array<{ kind: BossKind; min: number; hp: number; i: number }> = [];
  for (const b of bosses) b.slots.forEach((min, i) => slots.push({ kind: b.kind, min, hp: BOSSES[b.kind]?.hp ?? 0, i }));
  slots.sort((a, b) => b.min - a.min || b.hp - a.hp || a.i - b.i);
  return slots.map(({ kind, min }) => ({ kind, min }));
}

/**
 * Pure placement of released pool items (v4 "risk drives reward", v5 carriers):
 * 1. boss slots first: picks ranked by tier score desc (then value desc) fill rankBossSlots in
 *    order under bossLootKey(kind) ("boss:<kind>");
 * 2. the rest go one per destination, value-descending, each drawn by weight among
 *    - poolContainerEligible containers (tier >= POOL.CONTAINER_MIN_TIER, kind crate / toolbox /
 *      weapon_box / safe), weight poolContainerWeight = (tier+1)² × (guarded ? GUARDED_WEIGHT : 1),
 *      and
 *    - v5 carriers (spawned T3/T4 marauders, normCarriers), weight npcCarrierWeight = NPC_CARRIER.WEIGHT_MULT (5) × (tier+1)²,
 *      at most NPC_CARRIER.MAX_PER_NPC (1) each, ever.
 *    When every eligible container holds one, a second container round starts (carriers never
 *    refill). No destination left → those items stay out (allocatePool never takes them).
 * Deterministic in `seed`; with no carriers the draws are exactly the v4 ones.
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
      // Every container holds one: a new container round; a carrier never takes a second item.
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

/**
 * RaidStartRequest.carriers, sanitized: well-formed "npc:<postId>.<member>" keys once each, tier
 * at least NPC_CARRIER.MIN_TIER (3) and at most 4, sorted by key (deterministic whatever the
 * server's order). Absent (a pre-v5 game server, or demo) = none.
 */
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

/** How many released items carriers can hold at most: one each (NPC_CARRIER.MAX_PER_NPC = 1). */
export function carrierCapacity(carriers: readonly AllocCarrier[]): number {
  return carriers.length * Math.min(1, NPC_CARRIER.MAX_PER_NPC);
}

const UNIQUE_DEFS = ITEM_IDS.filter((id) => itemDef(id)?.unique);
const WEAPON_DEFS = UNIQUE_DEFS.filter((id) => itemDef(id)!.cat === "weapon");
const FIXED_TOP = UNIQUE_DEFS.filter((id) => itemDef(id)!.cat !== "weapon" && uniqueTierScore(id, 0) === 2);
const FIXED_RARE = UNIQUE_DEFS.filter((id) => itemDef(id)!.cat !== "weapon" && uniqueTierScore(id, 0) === 1);
function defIn(ids: readonly string[]): SQL {
  return ids.length ? sql`def_id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})` : sql`false`;
}
/** uniqueTierScore(def_id, rarity) as SQL over `items` (the boss pick's `order by`). */
export const TIER_SCORE_SQL: SQL = sql`(case
  when ${defIn(WEAPON_DEFS)} then (case when rarity >= 2 then 2 when rarity = 1 then 1 else 0 end)
  when ${defIn(FIXED_TOP)} then 2
  when ${defIn(FIXED_RARE)} then 1
  else 0 end)`;

type PoolRow = { id: string; def_id: string; rarity: number; durability: number };
