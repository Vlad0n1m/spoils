/**
 * WORLD v6 late-join spawn (spec D10). A raider dropping into a live map takes a MapData spawn spot
 * as far as possible from the people already there:
 *
 *   threats = living humans + spots handed out in the last RECENT_MS (two admissions in one second
 *             must not land together) + the user's own corpses of this cycle (no "respawn on my body")
 *   d(spot) = distance to the nearest threat (Infinity with none)
 *   tier 1: d ≥ WORLD.LATE_SPAWN_MIN_HUMAN_PX; tier 2: d ≥ WORLD.LATE_SPAWN_FALLBACK_PX; tier 3: any
 *   pick uniformly among the top 25 % (by d) of the first non-empty tier.
 *
 * Spots inside NPC camps are dropped first (spawnsClearOfNpcs, same rule as the roster spawn).
 * Pure apart from the rng draw; Match owns the recent-spawn list.
 *
 * Party drop (shared party.ts, JoinTicket.dropId): the first admitted member of a drop picks a spot
 * with the rules above and opens the drop; members of the same drop (same partyId) admitted within
 * PARTY.DROP_TTL_MS of it land PARTY_SPAWN_MIN_PX–PARTY_SPAWN_MAX_PX from a LIVING member of the drop
 * (the one nearest the drop's first spot: the group may have walked on; the stored first spot only
 * when nobody of the drop is alive) — partySpawnNear: a fixed spread per member slot, walk-grid cell
 * centres only, the anchor's connected walk component, re-checked against the solids, apart from
 * each other — on that member's side, so the whole drop shares its extracts. No rng: the same drop
 * always spreads the same way.
 * The late-spawn safety rules still hold for a drop spot (dropSpawnSafe): no living human outside the
 * party within PARTY_SPAWN_SAFE_PX (1200) and none of the user's own corpses of this cycle within
 * PARTY_SPAWN_CORPSE_PX (2000). A member who died at the drop and re-enters, or follows into a fight,
 * takes a normal entry spot instead.
 * After the window a member of the drop spawns as above (a new anchor for anyone after them).
 */

import {
  PARTY,
  PLAYER,
  VISION,
  WORLD,
  nearestWalkCell,
  resolveCircle,
  walkCellOf,
  type CollisionIndex,
  type MapSide,
  type Rng,
  type WalkGrid,
} from "@extract/shared";
import type { Match } from "./match.js";
import type { RegionGraph } from "./regions.js";

/** A spot handed out this recently still counts as occupied. */
export const RECENT_SPAWN_MS = 5_000;
/** Share of the best spots of a tier the pick is drawn from. */
export const SPAWN_TOP_SHARE = 0.25;

export interface SpawnSpot {
  x: number;
  y: number;
  side: MapSide;
}

/** Pick the entry spot of `userId` (see the module comment) and remember it as recently handed out. */
export function pickEntrySpawn(m: Match, rng: Rng, userId: string): SpawnSpot {
  const clock = m.clock;
  const recent = m.recentSpawns;
  while (recent.length > 0 && clock - recent[0]!.at > RECENT_SPAWN_MS) recent.shift();
  const threats: Array<{ x: number; y: number }> = [];
  for (const rt of m.allRuntimes()) if (!rt.isNpc && rt.pub.alive) threats.push(rt.pub);
  for (const r of recent) threats.push(r);
  for (const t of m.containers.corpses()) if (t.ownerUser !== null && t.ownerUser === userId) threats.push(t);
  const spots = m.entrySpots();
  const spot = chooseSpawn(rng, spots, threats) ?? { x: m.map.width / 2, y: m.map.height / 2, side: 0 as MapSide };
  recent.push({ x: spot.x, y: spot.y, at: clock });
  return spot;
}

/** The tiered top-25 % pick of pickEntrySpawn over `spots` (exported for tests); null without spots. */
export function chooseSpawn<T extends { x: number; y: number }>(rng: Rng, spots: readonly T[], threats: ReadonlyArray<{ x: number; y: number }>): T | null {
  if (spots.length === 0) return null;
  const scored = spots.map((s) => {
    let d = Infinity;
    for (const t of threats) d = Math.min(d, Math.hypot(t.x - s.x, t.y - s.y));
    return { s, d };
  });
  const tiers = [WORLD.LATE_SPAWN_MIN_HUMAN_PX, WORLD.LATE_SPAWN_FALLBACK_PX, -Infinity];
  for (const min of tiers) {
    const tier = scored.filter((c) => c.d >= min);
    if (tier.length === 0) continue;
    tier.sort((a, b) => b.d - a.d);
    // Ties at the cut stay in (an empty map: every spot is "infinitely" far, all are candidates).
    const cut = tier[Math.max(1, Math.ceil(tier.length * SPAWN_TOP_SHARE)) - 1]!.d;
    const top = tier.filter((c) => c.d >= cut);
    return top[Math.floor(rng() * top.length)]!.s;
  }
  return null;
}

// ---------------------------------------------------------------- party drop

/** Later members of a party drop land at least this far from the living member they join… */
export const PARTY_SPAWN_MIN_PX = PARTY.SPAWN_MIN_PX;
/** …and at most this far. */
export const PARTY_SPAWN_MAX_PX = PARTY.SPAWN_NEAR_PX;
/** Members of one drop never land closer than this to each other (two bodies plus a step). */
export const PARTY_SPAWN_GAP_PX = 2 * PLAYER.RADIUS + 16;
/**
 * A drop spot needs this much room from every living human outside the party: beyond a stranger's
 * view (VISION.RANGE plus a margin), so nobody pops in next to them and no member lands in their
 * sights. Wider would cost the drop most of the time on a full shard (24 raiders on the map: a 2000 px
 * radius has someone in it about two times in three, this one about one time in nine).
 */
export const PARTY_SPAWN_SAFE_PX = VISION.RANGE + 200;
/** …and this much from the user's own corpses of this cycle (D10 "no respawn on my body", tier 2). */
export const PARTY_SPAWN_CORPSE_PX = WORLD.LATE_SPAWN_FALLBACK_PX;
/** Ring radii tried in order (each candidate is snapped to its walk cell centre, then range-checked). */
const PARTY_RING_PX = [210, 250, 175, 285, 160] as const;
/** Directions tried per radius: the slot's own bearing, then ± k · 22.5° around it. */
const PARTY_RING_STEPS = 16;
/** Golden angle: slot k's bearing, so up to 3 later members fan out evenly around the anchor. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** One party drop on a shard (Match.partyDrops, keyed by dropId). */
export interface PartyDropAnchor {
  partyId: string;
  /** The first member's spot. */
  x: number;
  y: number;
  side: MapSide;
  /** Match clock of the first member's spawn. */
  at: number;
  /** Spots handed out to this drop so far (anchor first). */
  spots: Array<{ x: number; y: number }>;
}

/**
 * Entry spot of a party drop member (module comment): the drop's first member (or the first after
 * the window) picks a normal entry spot and anchors the drop; later members land near the anchor.
 */
export function pickDropSpawn(m: Match, rng: Rng, userId: string, dropId: string, partyId: string): SpawnSpot {
  const clock = m.clock;
  for (const [id, d] of m.partyDrops) if (clock - d.at > PARTY.DROP_TTL_MS) m.partyDrops.delete(id);
  const d = m.partyDrops.get(dropId);
  if (!d) {
    const spot = pickEntrySpawn(m, rng, userId);
    m.partyDrops.set(dropId, { partyId, x: spot.x, y: spot.y, side: spot.side, at: clock, spots: [{ x: spot.x, y: spot.y }] });
    return spot;
  }
  // A ticket can only carry a dropId of its own party (both signed by the web); anything else drops solo.
  if (d.partyId !== partyId) return pickEntrySpawn(m, rng, userId);
  // Land next to a living member of the drop: the one nearest the drop's first spot.
  let anchor: { x: number; y: number; side: MapSide } = d;
  let best = Infinity;
  const taken: Array<{ x: number; y: number }> = [...d.spots];
  for (const rt of m.allRuntimes()) {
    if (rt.isNpc || !rt.pub.alive || rt.dropId !== dropId || rt.partyId !== partyId || rt.userId === userId) continue;
    taken.push(rt.pub);
    const dist = Math.hypot(rt.pub.x - d.x, rt.pub.y - d.y);
    if (dist < best) {
      best = dist;
      anchor = { x: rt.pub.x, y: rt.pub.y, side: rt.self.side as MapSide };
    }
  }
  const p = partySpawnNear({ walk: m.mapRt.walk, regions: m.mapRt.regions, idx: m.idx, width: m.map.width, height: m.map.height }, anchor, d.spots.length, taken);
  if (!dropSpawnSafe(m, p, userId, partyId)) return pickEntrySpawn(m, rng, userId);
  d.spots.push(p);
  m.recentSpawns.push({ x: p.x, y: p.y, at: clock });
  return { x: p.x, y: p.y, side: anchor.side };
}

/**
 * The late-spawn threat rules for a party drop spot: no living human outside `partyId` within
 * PARTY_SPAWN_SAFE_PX and none of `userId`'s own corpses within PARTY_SPAWN_CORPSE_PX.
 */
export function dropSpawnSafe(m: Match, p: { x: number; y: number }, userId: string, partyId: string): boolean {
  const within = (q: { x: number; y: number }, r: number) => (q.x - p.x) ** 2 + (q.y - p.y) ** 2 < r * r;
  for (const rt of m.allRuntimes()) {
    if (rt.isNpc || !rt.pub.alive || rt.userId === userId || (partyId !== "" && rt.partyId === partyId)) continue;
    if (within(rt.pub, PARTY_SPAWN_SAFE_PX)) return false;
  }
  for (const c of m.containers.corpses()) {
    if (c.ownerUser !== null && c.ownerUser === userId && within(c, PARTY_SPAWN_CORPSE_PX)) return false;
  }
  return true;
}

/** What partySpawnNear needs of a map runtime. */
export interface PartySpawnMap {
  walk: WalkGrid;
  regions: Pick<RegionGraph, "region" | "comp">;
  idx: CollisionIndex;
  width: number;
  height: number;
}

/**
 * Deterministic spot for member `slot` (1, 2, 3 …) of a drop anchored at `anchor`: the first
 * candidate (ring radii × directions around the slot's golden-angle bearing) that is a walkable walk
 * cell centre PARTY_SPAWN_MIN_PX–PARTY_SPAWN_MAX_PX from the anchor, in the anchor's connected walk
 * component (never behind a wall it cannot walk around), clear of every solid (resolveCircle leaves
 * it in place) and PARTY_SPAWN_GAP_PX from every spot in `taken`. Fallbacks: the nearest such cell
 * closer than the ring, then the anchor itself.
 */
export function partySpawnNear(
  rt: PartySpawnMap,
  anchor: { x: number; y: number },
  slot: number,
  taken: ReadonlyArray<{ x: number; y: number }>,
): { x: number; y: number } {
  const g = rt.walk;
  const home = nearestWalkCell(g, anchor.x, anchor.y, 96);
  const compOf = (cell: number) => {
    const r = rt.regions.region[cell] ?? -1;
    return r < 0 ? -1 : (rt.regions.comp[r] ?? -1);
  };
  const comp = home >= 0 ? compOf(home) : -1;
  const margin = PLAYER.RADIUS + 8;
  const clear = (x: number, y: number) => {
    if (x < margin || y < margin || x > rt.width - margin || y > rt.height - margin) return false;
    const cell = walkCellOf(g, x, y);
    if (g.blocked[cell]) return false;
    if (comp >= 0 && compOf(cell) !== comp) return false;
    const r = resolveCircle(rt.idx, x, y, PLAYER.RADIUS);
    if (Math.abs(r.x - x) > 1e-6 || Math.abs(r.y - y) > 1e-6) return false;
    for (const t of taken) if (Math.hypot(t.x - x, t.y - y) < PARTY_SPAWN_GAP_PX) return false;
    return true;
  };
  const centre = (x: number, y: number) => {
    const cell = walkCellOf(g, x, y);
    return { x: ((cell % g.cols) + 0.5) * g.cell, y: (Math.floor(cell / g.cols) + 0.5) * g.cell };
  };
  const bearing = Math.max(1, slot) * GOLDEN_ANGLE;
  for (const radius of PARTY_RING_PX) {
    for (let j = 0; j < PARTY_RING_STEPS; j++) {
      const a = bearing + (j % 2 === 1 ? 1 : -1) * Math.ceil(j / 2) * ((2 * Math.PI) / PARTY_RING_STEPS);
      const c = centre(anchor.x + Math.cos(a) * radius, anchor.y + Math.sin(a) * radius);
      const d = Math.hypot(c.x - anchor.x, c.y - anchor.y);
      if (d < PARTY_SPAWN_MIN_PX || d > PARTY_SPAWN_MAX_PX) continue;
      if (clear(c.x, c.y)) return c;
    }
  }
  // A cramped anchor (corridor, building): the nearest free cell centre inside the ring's reach.
  const reach = Math.ceil(PARTY_SPAWN_MAX_PX / g.cell);
  const c0 = Math.floor(anchor.x / g.cell);
  const r0 = Math.floor(anchor.y / g.cell);
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (let dr = -reach; dr <= reach; dr++) {
    for (let dc = -reach; dc <= reach; dc++) {
      const col = c0 + dc;
      const row = r0 + dr;
      if (col < 0 || row < 0 || col >= g.cols || row >= g.rows) continue;
      const x = (col + 0.5) * g.cell;
      const y = (row + 0.5) * g.cell;
      const d = Math.hypot(x - anchor.x, y - anchor.y);
      if (d > PARTY_SPAWN_MAX_PX || d >= bestD) continue;
      if (clear(x, y)) {
        best = { x, y };
        bestD = d;
      }
    }
  }
  return best ?? { x: anchor.x, y: anchor.y };
}
