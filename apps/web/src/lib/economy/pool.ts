import { sql, type SQL } from "drizzle-orm";
import {
  BOSSES,
  ITEM_IDS,
  POOL,
  bossKindOfLootKey,
  bossLootKey,
  bossSlotCount,
  itemDef,
  mulberry32,
  poolContainerEligible,
  poolContainerWeight,
  poolEntry,
  takeTreasuryTax,
  uniqueTierScore,
  type BossKind,
  type ContainerKind,
  type LootTier,
  type RaidStartRequest,
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
  /** item_events reason: break | timeout | left | sweep | guest. */
  reason: string;
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
    const moved = await poolOne(tx, it, c, matchId);
    if (moved.state === "destroyed") out.destroyed.push(it.id);
    else {
      out.pooled.push(it.id);
      entering.push({ uid: it.id, value: itemRefValueCr({ def: it.defId, rarity: it.rarity, dur: moved.durability }) });
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

// ---------------------------------------------------------------- pool release (raids/start)

export interface AllocContainer {
  idx: number;
  kind: ContainerKind;
  tier: LootTier;
  /** Within POOL.GUARDED_RADIUS_PX of a BossSpot (containerGuarded, sent by the game server). */
  guarded?: boolean;
}

/** A spawned boss and its pool slots (RaidStartRequest.bosses: min uniqueTierScore per slot). */
export interface AllocBoss {
  kind: BossKind;
  slots: readonly number[];
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
 * Commander, Foreman, Warden), then slot order. The best picks go to the first slots, so a slot
 * that wants a top item gets one while the pool has any, else the best available.
 */
export function rankBossSlots(bosses: readonly AllocBoss[]): Array<{ kind: BossKind; min: number }> {
  const slots: Array<{ kind: BossKind; min: number; hp: number; i: number }> = [];
  for (const b of bosses) b.slots.forEach((min, i) => slots.push({ kind: b.kind, min, hp: BOSSES[b.kind]?.hp ?? 0, i }));
  slots.sort((a, b) => b.min - a.min || b.hp - a.hp || a.i - b.i);
  return slots.map(({ kind, min }) => ({ kind, min }));
}

/**
 * Pure placement of released pool items (v4, "risk drives reward"):
 * 1. boss slots first: picks ranked by tier score desc (then value desc) fill rankBossSlots in
 *    order under bossLootKey(kind) ("boss:<kind>");
 * 2. the rest go one per container, value-descending, only into poolContainerEligible containers
 *    (tier >= POOL.CONTAINER_MIN_TIER, kind crate / toolbox / weapon_box / safe), each picked with
 *    weight poolContainerWeight = (tier+1)² × (guarded ? GUARDED_WEIGHT : 1); when every eligible
 *    container holds one, a second round starts. No eligible container → those items stay out
 *    (allocatePool never takes them from the pool).
 * Deterministic in `seed`.
 */
export function planAllocation(
  picks: readonly AllocPick[],
  containers: readonly AllocContainer[],
  bosses: readonly AllocBoss[],
  seed: number,
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
  if (eligible.length === 0) return out;
  const rng = mulberry32((seed ^ 0x51ed270b) >>> 0);
  const used = new Set<number>();
  for (const p of rest) {
    let unused = eligible.filter((c) => !used.has(c.idx));
    if (unused.length === 0) {
      used.clear();
      unused = [...eligible];
    }
    const total = unused.reduce((s, c) => s + poolContainerWeight(c), 0);
    let roll = rng() * total;
    let pick = unused.length - 1;
    for (let i = 0; i < unused.length; i++) {
      roll -= poolContainerWeight(unused[i]!);
      if (roll <= 0) {
        pick = i;
        break;
      }
    }
    const c = unused[pick]!;
    used.add(c.idx);
    const key = String(c.idx);
    out.set(key, [...(out.get(key) ?? []), p.id]);
  }
  return out;
}

/**
 * RaidStartRequest.bosses, sanitized: known and enabled kinds once each, slots are integer min
 * scores 0..2, at most BOSSES[kind].poolSlots.length per boss. Absent (an older game server that
 * only sends the legacy bossSlots) = no boss: nothing is released for bosses it cannot hold.
 */
export function normBosses(bosses: RaidStartRequest["bosses"]): AllocBoss[] {
  const out: AllocBoss[] = [];
  const seen = new Set<BossKind>();
  for (const b of bosses ?? []) {
    const def = BOSSES[b.kind];
    if (!def?.enabled || seen.has(b.kind)) continue;
    seen.add(b.kind);
    const slots = b.slots
      .slice(0, def.poolSlots.length)
      .map((s) => (Number.isFinite(s) ? Math.max(0, Math.min(2, Math.floor(s))) : 0));
    if (slots.length) out.push({ kind: b.kind, slots });
  }
  return out;
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

export interface AllocateResult {
  containerLoot: Record<string, SettledItem[]>;
  released: number;
  /** Of `released`, how many went into boss bags (keys "boss:<kind>"). */
  boss: number;
  /** The risk part of the release plan (round(k × riskUnits), capped). */
  risk: number;
}

type PoolRow = { id: string; def_id: string; rarity: number; durability: number };

/**
 * Releases lost-pool uniques into a starting live match (LOOT ECONOMY v4):
 * - count: releasePlan(pool size, riskUnits, Σ boss slots) — round(k × risk) plus a boss-only
 *   display top-up while someone risked gear and the pool keeps more than POOL.BOSS_MIN_POOL; a
 *   lobby of free kits gets nothing, not even on its bosses; there is no container floor;
 * - bosses first: min(Σ slots, total) rows `order by tier score desc, random()`;
 * - the rest random, only into T3/T4 containers (none eligible → they stay in the pool).
 * Rows are taken FOR UPDATE SKIP LOCKED, so two matches starting at once never share an item,
 * and move lost_pool → in_raid (owner NULL, match set; reason alloc_boss / alloc).
 */
export async function allocatePool(
  tx: Tx,
  req: {
    matchId: string;
    matchSeed: number;
    containers: readonly AllocContainer[];
    bosses?: RaidStartRequest["bosses"];
    riskUnits: number;
  },
): Promise<AllocateResult> {
  const empty: AllocateResult = { containerLoot: {}, released: 0, boss: 0, risk: 0 };
  const bosses = normBosses(req.bosses);
  const nSlots = bossSlotCount(bosses);
  const eligible = req.containers.filter(poolContainerEligible);
  if (eligible.length === 0 && nSlots === 0) return empty;
  const sizeRes = await tx.execute<{ n: string }>(sql`select count(*)::int as n from items where state = 'lost_pool'`);
  const rel = releasePlan(Number(sizeRes.rows[0]?.n ?? 0), Math.max(0, req.riskUnits), nSlots, await readReleaseParams(tx));
  const bossTake = Math.min(nSlots, rel.total);
  const contTake = eligible.length > 0 ? rel.total - bossTake : 0;
  if (bossTake + contTake <= 0) return { ...empty, risk: rel.risk };

  const bossRows =
    bossTake > 0
      ? (
          await tx.execute<PoolRow>(sql`
            select id, def_id, rarity, durability from items
            where state = 'lost_pool'
            order by ${TIER_SCORE_SQL} desc, random()
            limit ${bossTake}
            for update skip locked`)
        ).rows
      : [];
  const taken = bossRows.map((r) => r.id);
  const contRows =
    contTake > 0
      ? (
          await tx.execute<PoolRow>(sql`
            select id, def_id, rarity, durability from items
            where state = 'lost_pool'
              ${taken.length ? sql`and id not in (${sql.join(taken.map((id) => sql`${id}::uuid`), sql`, `)})` : sql``}
            order by random()
            limit ${contTake}
            for update skip locked`)
        ).rows
      : [];
  const rows = [...bossRows, ...contRows];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const plan = planAllocation(
    rows.map((r) => ({
      id: r.id,
      value: itemRefValueCr({ def: r.def_id, rarity: Number(r.rarity), dur: Number(r.durability) }),
      score: uniqueTierScore(r.def_id, Number(r.rarity)),
    })),
    req.containers,
    bosses,
    req.matchSeed,
  );
  const containerLoot: Record<string, SettledItem[]> = {};
  let released = 0;
  let boss = 0;
  for (const [key, ids] of plan) {
    const isBoss = bossKindOfLootKey(key) !== null;
    for (const id of ids) {
      const it = await lockItem(tx, id);
      if (!it || it.state !== "lost_pool" || !byId.has(id)) continue;
      const moved = await applyMove(
        tx,
        it,
        { state: "in_raid", ownerId: null, matchId: req.matchId, loadoutId: null },
        { reason: isBoss ? "alloc_boss" : "alloc", refId: req.matchId },
      );
      (containerLoot[key] ??= []).push({
        uid: moved.id,
        def: moved.defId,
        qty: 1,
        rarity: moved.rarity,
        dur: toRaidDur(moved.defId, moved.durability),
      });
      released++;
      if (isBoss) boss++;
    }
  }
  return { containerLoot, released, boss, risk: rel.risk };
}
