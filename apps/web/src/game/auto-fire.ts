/**
 * Phone auto-fire (touch mode only). The aim stick only aims; the client pulls the trigger by
 * itself while the aim line is on an enemy, and releases it as soon as it is not. The server stays
 * authoritative: it just receives fire=true inputs as from a pressed trigger, and its own rules
 * (reload, roll, ammo, fire interval, party friendly fire off) apply as usual.
 *
 * "On an enemy" (autoFireTarget), all of:
 * - a living entity the client is currently drawing (in its synced state and faded in by the fog,
 *   i.e. what the player actually sees: never one behind the fog or out of view);
 * - not a party mate (S2C.PARTY, game/party.ts), never the player itself;
 * - its centre within the active weapon's range (the distance a bullet flies);
 * - the aim ray passes within its body circle (PLAYER.RADIUS, the server's bullet hit circle) plus
 *   AUTO_FIRE_SLACK_PX of tolerance (half a body radius): a near-miss still counts, a ray clearly
 *   beside the body does not;
 * - no bullet-blocking solid (SOLID.SHOT, shared DDA ray) between the player and the point where the
 *   ray passes the target. Windows (MOVE|VAULT) and fences (MOVE|SIGHT) do not block bullets, so they
 *   do not block auto-fire either.
 * The nearest such target along the ray wins (it is also what the crosshair marks as locked).
 */

import { PLAYER, SOLID, raycastSolidsDDA, type CollisionIndex } from "@extract/shared";

/** Extra px beyond the body radius in which the aim ray still counts as on target. */
export const AUTO_FIRE_SLACK_PX = PLAYER.RADIUS / 2;
/** A mate whose players-map id is not known yet: a human this close to its marker is treated as that mate. */
export const AUTO_FIRE_MATE_NEAR_PX = PLAYER.RADIUS * 2;

export interface AutoFireCandidate {
  id: string;
  x: number;
  y: number;
  alive: boolean;
  /** Drawn by the client this frame (synced and not faded out by the fog). */
  visible: boolean;
  /** A party mate (never fired at). */
  mate: boolean;
  /** Body radius; default PLAYER.RADIUS. */
  r?: number;
}

/** The enemy the aim ray from (ox, oy) along `angle` is on, or null (see the module comment). */
export function autoFireTarget<T extends AutoFireCandidate>(
  idx: CollisionIndex | null,
  ox: number,
  oy: number,
  angle: number,
  range: number,
  candidates: Iterable<T>,
): T | null {
  if (!Number.isFinite(angle) || !Number.isFinite(ox) || !Number.isFinite(oy) || !(range > 0)) return null;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  let best: T | null = null;
  let bestAlong = Infinity;
  for (const t of candidates) {
    if (!t.alive || !t.visible || t.mate) continue;
    const dx = t.x - ox;
    const dy = t.y - oy;
    const along = dx * c + dy * s;
    if (!(along > 0) || along >= bestAlong) continue;
    if (dx * dx + dy * dy > range * range) continue;
    const perp = Math.abs(dx * s - dy * c);
    if (perp > (t.r ?? PLAYER.RADIUS) + AUTO_FIRE_SLACK_PX) continue;
    if (idx && raycastSolidsDDA(idx, ox, oy, ox + c * along, oy + s * along, SOLID.SHOT) !== Infinity) continue;
    best = t;
    bestAlong = along;
  }
  return best;
}

/**
 * Whether a players-map entity is a party mate: its id is one of the mates' ids (S2C.PARTY; ids
 * seen this raid are kept, so a stale party message never turns a mate into a target), or, for a
 * mate whose id is not known, a human standing right at that mate's marker. NPCs are never mates.
 */
export function isPartyMate(
  id: string,
  x: number,
  y: number,
  role: number,
  mateIds: ReadonlySet<string>,
  mates: ReadonlyArray<{ id: string; x: number; y: number }>,
): boolean {
  if (role !== 0) return false;
  if (mateIds.has(id)) return true;
  for (const m of mates) {
    if (m.id) continue;
    if ((m.x - x) ** 2 + (m.y - y) ** 2 <= AUTO_FIRE_MATE_NEAR_PX ** 2) return true;
  }
  return false;
}
