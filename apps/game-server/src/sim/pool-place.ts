/**
 * WORLD v6 lost-pool placement on the server (spec §3.5, D18 / D19).
 *
 * The web releases pool items per entry (raids/enter → EntryResponse.pool) and the boss bag once
 * per shard-cycle (EntryResponse.bossFill). Nothing goes onto the map at once:
 * - entry items wait POOL.APPLY_AFTER_MS after the entry (or until the entrant dies), then each is
 *   placed into a weighted-random valid target: an untouched pool-eligible T3/T4 container without
 *   a pool item this cycle (weight poolContainerWeight, guarded × GUARDED_WEIGHT near the living
 *   event boss) or a living T3/T4 POI marauder without a stowed pool item (npcCarrierWeight); every
 *   candidate at least POOL.PLACE_MIN_HUMAN_PX from each living human. A landed supply crate nobody
 *   touched yet is a target too (world-events.ts, DROP.POOL_WEIGHT, one item per crate). No target → retry every
 *   POOL.PLACE_RETRY_MS. An extract before placement hands them back (PlayerExitReport.unplaced →
 *   pool, untaxed); the wipe leaves the rest on the map (leftOnMap, untaxed).
 * - boss bag items are stowed on the event boss once nobody hit it for POOL.BOSS_ENGAGED_MS; never
 *   diverted elsewhere: boss dead (or absent) → leftOnMap at the wipe.
 *
 * Every item is registered in the ledger as "pool" when it arrives (a uid that left the map earlier
 * in this match starts a new life). Placement draws come from mulberry32(lootSeed ^ hash32(uid)),
 * so they never disturb the match rng.
 */

import {
  CONTAINER_STATE,
  POOL,
  containerGuarded,
  itemDef,
  mulberry32,
  npcCarrierEligible,
  npcCarrierWeight,
  poolContainerWeight,
  NPC_CARRIER,
  type ItemLike,
  type SettledItem,
} from "@extract/shared";
import { stow } from "./boss.js";
import { isTrackedUnique, makeItem } from "./items.js";
import type { Match } from "./match.js";
import type { PlayerRuntime } from "./types.js";
import type { DropRt } from "./world-events.js";

/** A released entry item waiting for a valid target (the entrant died, or the delay passed). */
export interface UnplacedPoolItem {
  it: ItemLike;
  nextTryAt: number;
}

/** FNV-1a of a string (placement rng stream per uid). */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Settled items → registered plain items (unknown defs and duplicate uids are skipped). */
function registerAll(m: Match, items: readonly SettledItem[]): ItemLike[] {
  const out: ItemLike[] = [];
  for (const s of items) {
    if (!itemDef(s.def)) continue;
    const it = makeItem(s.def, { uid: s.uid, qty: s.qty, rarity: s.rarity, dur: s.dur, label: s.label, lvl: s.lvl });
    if (!m.ledger.register(it, "pool")) continue;
    out.push(it);
  }
  return out;
}

/** raids/enter released `items` for this entry: they wait APPLY_AFTER_MS (D18). */
export function receiveEntryPool(m: Match, rt: PlayerRuntime, items: readonly SettledItem[]): void {
  rt.pendingPool = registerAll(m, items);
  rt.poolApplyAt = m.clock + POOL.APPLY_AFTER_MS;
}

/** raids/enter filled the boss bag (D19): stowed on the event boss once it is not engaged. */
export function receiveBossFill(m: Match, items: readonly SettledItem[]): void {
  m.pendingBossFill.push(...registerAll(m, items));
}

/** Extract: this entry's items that were never placed (→ PlayerExitReport.unplaced, ledger "returned"). */
export function takeUnplaced(m: Match, rt: PlayerRuntime): ItemLike[] {
  const out = rt.pendingPool;
  rt.pendingPool = [];
  for (const it of out) m.ledger.resolve(it, "returned");
  return out;
}

/** Wipe: everything still waiting (entries, unplaced, boss fill) — leftOnMap, removed from here. */
export function leftoverPool(m: Match): ItemLike[] {
  const out: ItemLike[] = [];
  for (const rt of m.allRuntimes()) {
    if (rt.pendingPool.length === 0) continue;
    out.push(...rt.pendingPool);
    rt.pendingPool = [];
  }
  out.push(...m.unplacedPool.map((u) => u.it));
  m.unplacedPool.length = 0;
  out.push(...m.pendingBossFill.splice(0));
  return out;
}

/** Once a second from Match.worldTick (world mode). */
export function poolTick(m: Match): void {
  const clock = m.clock;
  // 1. Due entry items (delay passed, or the entrant died) go to placement.
  for (const rt of m.allRuntimes()) {
    if (rt.isNpc || rt.pendingPool.length === 0) continue;
    if (rt.pub.alive ? clock < rt.poolApplyAt : !rt.exitReport || rt.exitReport.exit === "extract") continue;
    for (const it of rt.pendingPool) m.unplacedPool.push({ it, nextTryAt: clock });
    rt.pendingPool = [];
  }
  // 2. Place what is due.
  if (m.unplacedPool.length > 0) {
    const keep: UnplacedPoolItem[] = [];
    for (const u of m.unplacedPool) {
      if (u.nextTryAt > clock) keep.push(u);
      else if (!placeOne(m, u.it)) keep.push({ it: u.it, nextTryAt: clock + POOL.PLACE_RETRY_MS });
    }
    m.unplacedPool.length = 0;
    m.unplacedPool.push(...keep);
  }
  // 3. Boss bag: onto the living event boss once nobody has hit it for BOSS_ENGAGED_MS.
  if (m.pendingBossFill.length > 0) {
    const boss = m.eventBoss();
    if (boss?.pub.alive && clock - boss.lastHitAt >= POOL.BOSS_ENGAGED_MS) {
      const rest = m.pendingBossFill.filter((it) => !stow(boss, it));
      m.pendingBossFill.length = 0;
      m.pendingBossFill.push(...rest);
    }
  }
}

/** One placement candidate. */
interface Candidate {
  x: number;
  y: number;
  weight: number;
  container: number;
  npc: PlayerRuntime | null;
  /** A landed, untouched supply crate (world-events.ts): a pool target like a T3/T4 container. */
  drop?: DropRt;
}

/**
 * Valid targets now (spec §3.5): untouched eligible containers without a pool item this cycle and
 * living carrier-eligible marauders below NPC_CARRIER.MAX_PER_NPC pool items. `minHumanPx` > 0
 * also drops every candidate within that distance of a living human.
 */
export function poolCandidates(m: Match, minHumanPx: number): Candidate[] {
  const humans: Array<{ x: number; y: number }> = [];
  if (minHumanPx > 0) for (const rt of m.allRuntimes()) if (!rt.isNpc && rt.pub.alive) humans.push(rt.pub);
  const far = (x: number, y: number) => humans.every((h) => (h.x - x) ** 2 + (h.y - y) ** 2 >= minHumanPx * minHumanPx);
  const boss = m.eventBoss();
  const guardSpots = boss?.pub.alive && m.eventBossSpot ? [m.eventBossSpot] : [];
  const out: Candidate[] = [];
  m.map.containers.forEach((spot, idx) => {
    if (!m.containers.poolTargetOk(idx) || !far(spot.x, spot.y)) return;
    // In-raid objectives: an eligible container in a locked room weighs × LOCK.POOL_WEIGHT_MULT.
    const weight = poolContainerWeight({ tier: spot.tier, guarded: containerGuarded(spot, guardSpots) }) * m.objectives.poolWeightMult(idx);
    out.push({ x: spot.x, y: spot.y, weight, container: idx, npc: null });
  });
  for (const sq of m.npcs.squads) {
    const post = sq.post;
    if (sq.type !== "marauder" || !post || post.kind === "road" || !npcCarrierEligible(post.tier)) continue;
    for (const rt of sq.members) {
      if (!rt.pub.alive || !far(rt.pub.x, rt.pub.y)) continue;
      let carried = 0;
      for (const it of rt.self.slots.values()) if (isTrackedUnique(it)) carried++;
      if (carried >= NPC_CARRIER.MAX_PER_NPC) continue;
      out.push({ x: rt.pub.x, y: rt.pub.y, weight: npcCarrierWeight(post.tier), container: -1, npc: rt });
    }
  }
  // WORLD v6 supply crates: untouched landed crates below DROP.POOL_MAX pool items.
  for (const d of m.worldEvents.dropPoolCandidates()) {
    if (far(d.x, d.y)) out.push({ x: d.x, y: d.y, weight: d.weight, container: -1, npc: null, drop: d.drop });
  }
  return out;
}

/** Valid pool targets on the map now, without the human-distance rule (EntryRequest.targets). */
export function poolTargetCount(m: Match): number {
  return poolCandidates(m, 0).length;
}

/** Place one item; false when no valid target (or the chosen carrier had no free slot). */
export function placeOne(m: Match, it: ItemLike): boolean {
  const cands = poolCandidates(m, POOL.PLACE_MIN_HUMAN_PX);
  if (cands.length === 0) return false;
  const rng = mulberry32((m.lootSeed ^ hash32(it.uid)) >>> 0);
  const total = cands.reduce((s, c) => s + c.weight, 0);
  let roll = rng() * total;
  let pick = cands[cands.length - 1]!;
  for (const c of cands) {
    roll -= c.weight;
    if (roll <= 0) {
      pick = c;
      break;
    }
  }
  if (pick.npc) return stow(pick.npc, it);
  if (pick.drop) return m.worldEvents.placeInDrop(pick.drop, it);
  if (m.containers.stateOf(pick.container) !== CONTAINER_STATE.UNTOUCHED) return false;
  m.containers.placePoolItem(pick.container, it);
  return true;
}
