import { sql } from "drizzle-orm";
import {
  POOL,
  mulberry32,
  poolEntry,
  poolReleasePlan,
  takeTreasuryTax,
  type ContainerKind,
  type LootTier,
  type SettledItem,
} from "@extract/shared";
import type { Tx } from "../inventory/db";
import { poolMinReleasePerMatch } from "./config";
import { applyMove, lockItem, type LockedItem } from "../inventory/transition";
import { PARAM, lockNumberParam, setParam } from "./params";
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
}

/** Container kinds that may hold a pool unique (a rifle in a fridge reads wrong). */
const POOL_KINDS: ReadonlySet<ContainerKind> = new Set<ContainerKind>(["crate", "toolbox", "weapon_box", "safe", "stash"]);

/**
 * Pure placement of released pool items: the best POOL.BOSS_SHARE (by value) go to the boss stash
 * when one spawns, the rest go one per container, value-descending, each to a container picked
 * with weight (tier+1)² among the unused eligible ones (better loot in better containers, still a
 * surprise). Floor items (`floorIds`, POOL.MIN_RELEASE_PER_MATCH) only go to dangerous containers
 * (tier >= POOL.FLOOR_MIN_TIER) or the boss stash, so a free-kit farmer still has to fight for
 * them. Deterministic in `seed`. Items that find no home are left out (they stay in the pool).
 */
export function planAllocation(
  picks: ReadonlyArray<{ id: string; value: number }>,
  containers: readonly AllocContainer[],
  bossSlots: number,
  seed: number,
  floorIds: ReadonlySet<string> = new Set(),
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const sorted = [...picks].sort((a, b) => b.value - a.value || (a.id < b.id ? -1 : 1));
  let rest = sorted;
  if (bossSlots > 0) {
    const boss = sorted.slice(0, POOL.BOSS_SHARE);
    if (boss.length) out.set("boss", boss.map((p) => p.id));
    rest = sorted.slice(POOL.BOSS_SHARE);
  }
  const preferred = containers.filter((c) => POOL_KINDS.has(c.kind));
  const eligible = (preferred.length > 0 ? preferred : [...containers]).sort((a, b) => a.idx - b.idx);
  const dangerous = eligible.filter((c) => c.tier >= POOL.FLOOR_MIN_TIER);
  const rng = mulberry32((seed ^ 0x51ed270b) >>> 0);
  const used = new Set<number>();
  for (const p of rest) {
    const from = floorIds.has(p.id) ? dangerous : eligible;
    if (from.length === 0) continue;
    let unused = from.filter((c) => !used.has(c.idx));
    if (unused.length === 0) {
      // Every candidate already holds one: start a second round over the same set.
      for (const c of from) used.delete(c.idx);
      unused = [...from];
    }
    const total = unused.reduce((s, c) => s + (c.tier + 1) ** 2, 0);
    let roll = rng() * total;
    let pick = unused.length - 1;
    for (let i = 0; i < unused.length; i++) {
      roll -= (unused[i]!.tier + 1) ** 2;
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

export interface AllocateResult {
  containerLoot: Record<string, SettledItem[]>;
  released: number;
  /** Of `released`, how many came from the per-match floor (T3/T4 / boss only). */
  floor: number;
}

/**
 * Releases lost-pool uniques into a starting match: poolReleasePlan = the risk-driven count
 * (poolReleaseCount(pool, riskUnits), boss share) topped up to the per-match floor
 * (POOL.MIN_RELEASE_PER_MATCH, env POOL_MIN_RELEASE_PER_MATCH) while the pool holds more than
 * POOL.FLOOR_MIN_POOL; floor items land only in T3/T4 containers / boss stashes. Rows are picked at
 * random with FOR UPDATE SKIP LOCKED so two matches starting at once never get the same item, then
 * moved lost_pool → in_raid (owner NULL, match set).
 */
export async function allocatePool(
  tx: Tx,
  req: { matchId: string; matchSeed: number; containers: readonly AllocContainer[]; bossSlots: number; riskUnits: number },
): Promise<AllocateResult> {
  const empty: AllocateResult = { containerLoot: {}, released: 0, floor: 0 };
  if (req.containers.length === 0 && req.bossSlots <= 0) return empty;
  const sizeRes = await tx.execute<{ n: string }>(sql`select count(*)::int as n from items where state = 'lost_pool'`);
  const rel = poolReleasePlan(Number(sizeRes.rows[0]?.n ?? 0), Math.max(0, req.riskUnits), poolMinReleasePerMatch());
  if (rel.total <= 0) return empty;
  const picked = await tx.execute<{ id: string; def_id: string; rarity: number; durability: number }>(sql`
    select id, def_id, rarity, durability from items
    where state = 'lost_pool'
    order by random()
    limit ${rel.total}
    for update skip locked`);
  const byId = new Map(picked.rows.map((r) => [r.id, r]));
  // Rows come back in random order: the first `risk` are risk releases, the rest the floor.
  const floorIds = new Set(picked.rows.slice(rel.risk).map((r) => r.id));
  const plan = planAllocation(
    picked.rows.map((r) => ({ id: r.id, value: itemRefValueCr({ def: r.def_id, rarity: Number(r.rarity), dur: Number(r.durability) }) })),
    req.containers,
    req.bossSlots,
    req.matchSeed,
    floorIds,
  );
  const containerLoot: Record<string, SettledItem[]> = {};
  let released = 0;
  let floor = 0;
  for (const [key, ids] of plan) {
    for (const id of ids) {
      const it = await lockItem(tx, id);
      if (!it || it.state !== "lost_pool" || !byId.has(id)) continue;
      const moved = await applyMove(
        tx,
        it,
        { state: "in_raid", ownerId: null, matchId: req.matchId, loadoutId: null },
        { reason: floorIds.has(id) ? "alloc_floor" : "alloc", refId: req.matchId },
      );
      (containerLoot[key] ??= []).push({
        uid: moved.id,
        def: moved.defId,
        qty: 1,
        rarity: moved.rarity,
        dur: toRaidDur(moved.defId, moved.durability),
      });
      released++;
      if (floorIds.has(id)) floor++;
    }
  }
  return { containerLoot, released, floor };
}
