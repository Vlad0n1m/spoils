/**
 * Hand grenades (Weapons v2, docs/WEAPONS_V2.md §4; numbers in shared items.ts GRENADE).
 *
 * - throwGrenade (C2S.THROW): a living human, not rolling, not reloading, GRENADE.COOLDOWN_MS after
 *   the last throw and with a grenade in the inventory. One grenade is used up, the throw cancels a
 *   heal and closes a search, and the gun stays locked for GRENADE.FIRE_LOCK_MS. The whole flight
 *   is computed at once (shared items.ts grenadePath, which the client's aim preview also draws):
 *   players never stop a grenade, only SHOT walls do.
 * - stepGrenades (every tick): bounce sounds as the flight passes them, landing copies for humans
 *   who see the resting grenade but not the thrower, and the explosion at the fuse.
 * - explode: every living runtime within GRENADE.EDGE_PX whose centre the blast centre sees through
 *   SHOT walls (a window lets the blast through, like a bullet) takes grenadeDamageAt(distance)
 *   through damagePlayer: armor absorbs as usual, party mates are never hurt, the kill is credited
 *   to the thrower with weapon "grenade". The thrower is hurt too (attacker null: no hit marker on
 *   oneself; dying to one's own grenade credits the last enemy who hit them within
 *   SELF_KILL_CREDIT_MS, combat.ts, so a suicide never denies the attacker the kill). A thrower
 *   who does not see a victim gets a position-less "hit confirmed" only (audience.ts).
 *
 * Visibility (audience rules, protocol GrenadeMsg / BoomMsg): the full flight goes to the thrower
 * and to every human who sees the thrower at the throw; a human who sees only the resting grenade
 * gets a landing copy (s = "", just the resting point), so a hidden thrower's position never leaks.
 * The blast goes to everyone who got the grenade and to every human on the map who sees the point.
 * Its audio is a world SoundKind.explosion entry (sound.ts, always hidden: sector + band).
 */

import {
  GRENADE,
  GRENADE_DEF,
  GRENADE_SOUND,
  PLAYER,
  SOLID,
  SoundKind,
  VISION,
  consumeKey,
  grenadeDamageAt,
  grenadePath,
  grenadeThrowPx,
  raycastSolids,
  raycastSolidsDDA,
  type BoomMsg,
  type GrenadeMsg,
  type GrenadePoint,
} from "@extract/shared";
import { cancelHeal } from "./actions.js";
import { syncPublic } from "./bag.js";
import { damagePlayer } from "./combat.js";
import { closeSearch } from "./containers.js";
import type { Match } from "./match.js";
import { emitSound } from "./sound.js";
import type { PlayerRuntime } from "./types.js";

/** A thrown grenade on the match (Match.grenades). Clocks are match clocks. */
export interface LiveGrenade {
  id: number;
  owner: PlayerRuntime;
  thrownAt: number;
  explodeAt: number;
  /** Flight; the last point is where it rests. */
  path: GrenadePoint[];
  /** Index of the next path point whose bounce sound is still due. */
  nextPoint: number;
  /** Roster indexes that got a GrenadeMsg for it (thrower, viewers, landing copies). */
  told: Set<number>;
}

/** Wire form of a grenade for one recipient (full flight, or only the resting point). */
function grenadeMsg(m: Match, g: LiveGrenade, full: boolean, viewerSeesThrower: boolean): GrenadeMsg {
  const fuse = g.explodeAt - g.thrownAt;
  if (full) {
    const p: number[] = [];
    for (const q of g.path) p.push(round1(q.x), round1(q.y), Math.round(q.t));
    return { id: g.id, s: viewerSeesThrower ? g.owner.id : "", p, fuse, at: 0 };
  }
  const rest = g.path[g.path.length - 1]!;
  const at = Math.max(Math.round(rest.t), Math.round(m.clock - g.thrownAt));
  return { id: g.id, s: "", p: [round1(rest.x), round1(rest.y), at], fuse, at };
}

/** Humans who are on the map and connected (event recipients). */
function viewers(m: Match): PlayerRuntime[] {
  return m.allRuntimes().filter((r) => !r.isNpc && r.pub.alive && r.connected);
}

/** Does a human at (lx, ly) see the point (x, y): within VISION.RANGE and a clear SIGHT ray. */
function seesPoint(m: Match, lx: number, ly: number, x: number, y: number): boolean {
  const dx = x - lx;
  const dy = y - ly;
  const R = VISION.RANGE + PLAYER.RADIUS;
  if (dx * dx + dy * dy > R * R) return false;
  return raycastSolidsDDA(m.idx, lx, ly, x, y, SOLID.SIGHT) === Infinity;
}

export type ThrowRefusal = "dead" | "npc" | "rolling" | "reloading" | "cooldown" | "no_grenade";

/**
 * C2S.THROW: throw one grenade toward `angle`, `frac` (0..1) of the way from GRENADE.MIN_PX to MAX_PX.
 * Returns the grenade or why it was refused (nothing changes on a refusal).
 */
export function throwGrenade(m: Match, rt: PlayerRuntime, angle: number, frac: number): LiveGrenade | ThrowRefusal {
  const p = rt.pub;
  const s = rt.self;
  if (!p.alive) return "dead";
  if (rt.isNpc) return "npc";
  if (s.rollLeft > 0) return "rolling";
  if (s.reloadUntil > 0) return "reloading";
  if (m.clock < rt.nextThrowAt) return "cooldown";
  const key = consumeKey(s.slots, GRENADE_DEF);
  const it = key ? s.slots.get(key) : undefined;
  if (!key || !it) return "no_grenade";
  if (it.qty <= 1) s.slots.delete(key);
  else it.qty -= 1;

  cancelHeal(rt);
  closeSearch(m, rt, "fired");
  rt.nextThrowAt = m.clock + GRENADE.COOLDOWN_MS;
  rt.nextFireAt = Math.max(rt.nextFireAt, m.clock + GRENADE.FIRE_LOCK_MS);
  rt.pressPending = false;
  const a = Number.isFinite(angle) ? Math.atan2(Math.sin(angle), Math.cos(angle)) : p.aim;
  const path = grenadePath(m.idx, p.x, p.y, a, grenadeThrowPx(frac), { width: m.map.width, height: m.map.height });
  const g: LiveGrenade = {
    id: ++m.grenadeSeq,
    owner: rt,
    thrownAt: m.clock,
    explodeAt: m.clock + GRENADE.FUSE_MS,
    path,
    nextPoint: 1,
    told: new Set(),
  };
  m.grenades.push(g);
  emitSound(m, rt, SoundKind.grenade, p.x, p.y, GRENADE_SOUND.THROW);
  // The thrower and everyone who sees them get the whole flight now.
  for (const v of viewers(m)) {
    const seesThrower = v === rt || m.vision.sees(v.rosterIndex, rt.rosterIndex);
    if (!seesThrower) continue;
    g.told.add(v.rosterIndex);
    m.emit({ type: "nade", to: v.rosterIndex, msg: grenadeMsg(m, g, true, true) });
  }
  syncPublic(rt);
  return g;
}

/** Per tick: bounce sounds, landing copies, explosions. */
export function stepGrenades(m: Match): void {
  if (m.grenades.length === 0) return;
  const keep: LiveGrenade[] = [];
  for (const g of m.grenades) {
    const since = m.clock - g.thrownAt;
    while (g.nextPoint < g.path.length && g.path[g.nextPoint]!.t <= since) {
      const q = g.path[g.nextPoint]!;
      if (q.bounce) emitSound(m, null, SoundKind.grenade, q.x, q.y, GRENADE_SOUND.BOUNCE);
      g.nextPoint++;
    }
    const rest = g.path[g.path.length - 1]!;
    if (since >= rest.t) {
      // Landed: humans who see it lying there (and were not told yet) learn about it now.
      for (const v of viewers(m)) {
        if (g.told.has(v.rosterIndex) || !seesPoint(m, v.pub.x, v.pub.y, rest.x, rest.y)) continue;
        g.told.add(v.rosterIndex);
        m.emit({ type: "nade", to: v.rosterIndex, msg: grenadeMsg(m, g, false, false) });
      }
    }
    if (m.clock >= g.explodeAt) {
      explode(m, g);
      continue;
    }
    keep.push(g);
  }
  m.grenades = keep;
}

/** Blast at the resting point: damage, sound, BoomMsg. */
export function explode(m: Match, g: LiveGrenade): void {
  const rest = g.path[g.path.length - 1]!;
  const x = rest.x;
  const y = rest.y;
  const boom: BoomMsg = { id: g.id, x: round1(x), y: round1(y) };
  // Recipients before the damage (a victim killed by it still sees its own blast).
  const to = new Set<number>();
  for (const v of viewers(m)) {
    if (g.told.has(v.rosterIndex) || seesPoint(m, v.pub.x, v.pub.y, x, y)) to.add(v.rosterIndex);
  }
  for (const r of to) m.emit({ type: "boom", to: r, msg: boom });
  emitSound(m, null, SoundKind.explosion, x, y);
  const R = GRENADE.EDGE_PX;
  for (const rt of [...m.allRuntimes()]) {
    if (!rt.pub.alive) continue;
    const dx = rt.pub.x - x;
    const dy = rt.pub.y - y;
    if (dx * dx + dy * dy > R * R) continue;
    const dmg = grenadeDamageAt(Math.hypot(dx, dy));
    if (dmg <= 0) continue;
    // Walls stop the blast (SHOT mask: the same rule as bullets, windows let it through).
    if (raycastSolids(m.idx, x, y, rt.pub.x, rt.pub.y, SOLID.SHOT) !== Infinity) continue;
    const self = rt === g.owner;
    damagePlayer(m, rt, dmg, self ? null : g.owner, "grenade", rt.pub.x, rt.pub.y, { x, y });
  }
}

/** Live grenades of `rt` (the exit report waits for them, like bullets in flight). */
export function hasLiveGrenade(m: Match, rt: PlayerRuntime): boolean {
  return m.grenades.some((g) => g.owner === rt);
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
