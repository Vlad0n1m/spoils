/**
 * Shooting, server-side bullets, damage and death. Bullets are never synced: clients draw tracers
 * from the SHOT message and the state (hp, alive) is the truth about hits.
 */

import {
  PLAYER,
  RARITY_DAMAGE_MULT,
  WEAPONS,
  applyDamage,
  raycastSolids,
  segmentCircleT,
  type Player,
  type WeaponId,
} from "@extract/shared";
import { cancelHeal, cancelReload, startReload } from "./actions.js";
import { ammoOf, armorRef, dropOnDeath } from "./inventory.js";
import type { Match } from "./match.js";
import type { PlayerRuntime } from "./types.js";

/**
 * A semi-auto press made slightly before the weapon is ready still fires when it becomes ready,
 * but not much later — a shot long after the click would feel like a misfire.
 */
export const PRESS_BUFFER_MS = 150;

/**
 * Called once per applied input, after the trigger state was updated from that input, so shots
 * leave from the position and aim of the input that fired them.
 */
export function tryFire(m: Match, rt: PlayerRuntime, p: Player): void {
  if (rt.pressPending && m.clock - rt.pressAt > PRESS_BUFFER_MS) rt.pressPending = false;
  const slot = p.slots[p.active];
  if (!slot?.weapon) return;
  const def = WEAPONS[slot.weapon as WeaponId];
  const wants = def.auto ? rt.triggerHeld : rt.pressPending;
  if (!wants || p.reloadUntil > 0) return;

  if (slot.mag <= 0) {
    rt.pressPending = false;
    if (ammoOf(p, def.ammo) > 0) {
      cancelHeal(p);
      startReload(m, rt, p);
    }
    return;
  }
  if (m.clock < rt.nextFireAt) return;

  cancelHeal(p);
  rt.pressPending = false;
  // Strictly clock + interval: ticks quantize shots, and the rule is "never faster than the interval".
  rt.nextFireAt = m.clock + def.fireIntervalMs;
  slot.mag -= 1;

  const damage = def.damage * RARITY_DAMAGE_MULT[slot.rarity as 0 | 1 | 2 | 3];
  const angles: number[] = [];
  for (let i = 0; i < def.pellets; i++) {
    const a = p.aim + (m.rng() * 2 - 1) * def.spread;
    angles.push(a);
    // Pellets start at the player center (not the muzzle) so a muzzle poking through a wall
    // cannot shoot through it.
    m.bullets.push({
      owner: rt,
      weapon: def.id,
      x: p.x,
      y: p.y,
      dx: Math.cos(a),
      dy: Math.sin(a),
      speed: def.bulletSpeed,
      remaining: def.range,
      damage,
    });
  }
  m.emit({
    type: "shot",
    msg: {
      s: rt.id,
      w: def.id,
      x: p.x + Math.cos(p.aim) * def.muzzle,
      y: p.y + Math.sin(p.aim) * def.muzzle,
      a: angles,
      cx: p.x,
      cy: p.y,
    },
  });

  if (slot.mag <= 0 && ammoOf(p, def.ammo) > 0) startReload(m, rt, p);
}

export function stepBullets(m: Match, dtMs: number): void {
  const R = PLAYER.RADIUS;
  const keep = [];
  for (const b of m.bullets) {
    const len = Math.min((b.speed * dtMs) / 1000, b.remaining);
    const sx = b.dx * len;
    const sy = b.dy * len;
    const tWall = raycastSolids(m.idx, b.x, b.y, b.x + sx, b.y + sy);

    let hitT = Infinity;
    let hitPlayer: Player | null = null;
    for (const p of m.state.players.values()) {
      if (!p.alive || p.sessionId === b.owner.id) continue;
      const t = segmentCircleT(b.x, b.y, sx, sy, p.x, p.y, R);
      if (t < hitT) { hitT = t; hitPlayer = p; }
    }

    if (hitPlayer && hitT <= tWall) {
      damagePlayer(m, hitPlayer, b.damage, b.owner, b.weapon, b.x + sx * hitT, b.y + sy * hitT);
      continue;
    }
    if (tWall !== Infinity) continue;
    b.x += sx;
    b.y += sy;
    b.remaining -= len;
    if (b.remaining > 1e-6) keep.push(b);
  }
  m.bullets = keep;
}

export function damagePlayer(
  m: Match,
  p: Player,
  raw: number,
  attacker: PlayerRuntime | null,
  weapon: WeaponId | "",
  hx: number,
  hy: number,
): void {
  if (!p.alive) return;
  const rt = m.runtime(p.sessionId);
  if (!rt) return;
  const { hpLoss, armorUsed } = applyDamage(raw, p.armor, p.armorDur);
  p.hp = Math.max(0, round2(p.hp - hpLoss));
  if (armorUsed > 0) {
    p.armorDur = round2(p.armorDur - armorUsed);
    if (p.armorDur <= 0) {
      // Armor worn down to nothing is destroyed for good: it counts as lost by its wearer.
      if (p.armorUid) rt.lost.push(armorRef(p.armorUid, p.armor, 0));
      p.armor = 0;
      p.armorDur = 0;
      p.armorUid = "";
    }
  }
  if (attacker && attacker !== rt) {
    rt.lastHitBy = attacker;
    rt.lastHitAt = m.clock;
  }
  // Taking damage restarts the extraction channel.
  if (p.extractId) p.extractStartedAt = m.clock;

  m.emit({
    type: "hit",
    msg: { t: rt.id, s: attacker?.id ?? "", x: hx, y: hy, d: round2(hpLoss), ar: armorUsed > 0 },
  });
  if (p.hp <= 0) killPlayer(m, rt, p, attacker, weapon);
}

export function killPlayer(
  m: Match,
  rt: PlayerRuntime,
  p: Player,
  killer: PlayerRuntime | null,
  weapon: WeaponId | "",
): void {
  if (!p.alive) return;
  p.alive = false;
  p.hp = 0;
  p.diedAt = m.clock;
  p.extractStartedAt = 0;
  p.extractId = "";
  cancelReload(p);
  cancelHeal(p);
  rt.exit = "dead";
  rt.queue.length = 0;
  rt.triggerHeld = false;
  rt.pressPending = false;

  const killerPlayer = killer ? m.state.players.get(killer.id) : undefined;
  if (killer && killerPlayer && killer !== rt) {
    killerPlayer.kills = Math.min(255, killerPlayer.kills + 1);
    rt.killedBy = killer.nickname;
    // A bullet still in flight can kill after its shooter already extracted or died: keep their
    // frozen result in line with the settlement (which reads state kills) and resend it.
    if (killer.outcome) {
      killer.outcome = { ...killer.outcome, kills: killerPlayer.kills };
      if (!killer.isBot) m.emit({ type: "outcome", to: killer.id, msg: killer.outcome });
    }
  }
  dropOnDeath(m, rt, p);
  m.emit({
    type: "kill",
    msg: {
      victim: rt.nickname,
      victimId: rt.id,
      killer: killer && killer !== rt ? killer.nickname : "",
      killerId: killer && killer !== rt ? killer.id : "",
      weapon,
    },
  });
  m.finishPlayer(rt, "dead");
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
