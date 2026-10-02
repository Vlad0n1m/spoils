import { sql } from "drizzle-orm";
import {
  POOL,
  mulberry32,
  poolEntry,
  poolReleaseCount,
  takeTreasuryTax,
  type ContainerKind,
  type LootTier,
  type SettledItem,
} from "@extract/shared";
import type { Tx } from "../inventory/db";
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
 * surprise). Deterministic in `seed`. Items that find no home are left out (they stay in the pool).
 */
export function planAllocation(
  picks: ReadonlyArray<{ id: string; value: number }>,
  containers: readonly AllocContainer[],
  bossSlots: number,
  seed: number,
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
  const eligible = preferred.length > 0 ? preferred : [...containers];
  if (eligible.length === 0) return out;
  const rng = mulberry32((seed ^ 0x51ed270b) >>> 0);
  let unused = [...eligible].sort((a, b) => a.idx - b.idx);
  for (const p of rest) {
    if (unused.length === 0) unused = [...eligible].sort((a, b) => a.idx - b.idx);
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
    unused.splice(pick, 1);
    const key = String(c.idx);
    out.set(key, [...(out.get(key) ?? []), p.id]);
  }
  return out;
}

export interface AllocateResult {
  containerLoot: Record<string, SettledItem[]>;
  released: number;
}

/**
 * Releases lost-pool uniques into a starting match (critique: poolReleaseCount(pool, riskUnits),
 * boss share). Rows are picked at random with FOR UPDATE SKIP LOCKED so two matches starting at
 * once never get the same item, then moved lost_pool → in_raid (owner NULL, match set).
 */
export async function allocatePool(
  tx: Tx,
  req: { matchId: string; matchSeed: number; containers: readonly AllocContainer[]; bossSlots: number; riskUnits: number },
): Promise<AllocateResult> {
  const empty: AllocateResult = { containerLoot: {}, released: 0 };
  if (req.riskUnits <= 0 || (req.containers.length === 0 && req.bossSlots <= 0)) return empty;
  const sizeRes = await tx.execute<{ n: string }>(sql`select count(*)::int as n from items where state = 'lost_pool'`);
  const n = poolReleaseCount(Number(sizeRes.rows[0]?.n ?? 0), req.riskUnits);
  if (n <= 0) return empty;
  const picked = await tx.execute<{ id: string; def_id: string; rarity: number; durability: number }>(sql`
    select id, def_id, rarity, durability from items
    where state = 'lost_pool'
    order by random()
    limit ${n}
    for update skip locked`);
  const byId = new Map(picked.rows.map((r) => [r.id, r]));
  const plan = planAllocation(
    picked.rows.map((r) => ({ id: r.id, value: itemRefValueCr({ def: r.def_id, rarity: Number(r.rarity), dur: Number(r.durability) }) })),
    req.containers,
    req.bossSlots,
    req.matchSeed,
  );
  const containerLoot: Record<string, SettledItem[]> = {};
  let released = 0;
  for (const [key, ids] of plan) {
    for (const id of ids) {
      const it = await lockItem(tx, id);
      if (!it || it.state !== "lost_pool" || !byId.has(id)) continue;
      const moved = await applyMove(
        tx,
        it,
        { state: "in_raid", ownerId: null, matchId: req.matchId, loadoutId: null },
        { reason: "alloc", refId: req.matchId },
      );
      (containerLoot[key] ??= []).push({
        uid: moved.id,
        def: moved.defId,
        qty: 1,
        rarity: moved.rarity,
        dur: toRaidDur(moved.defId, moved.durability),
      });
      released++;
    }
  }
  return { containerLoot, released };
}
