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
 */

import { WORLD, type MapSide, type Rng } from "@extract/shared";
import type { Match } from "./match.js";

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
