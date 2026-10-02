/**
 * Shooting, server-side bullets and damage. Bullets are never synced: clients draw tracers from
 * the ShotMsg in their `ev` batch, and the state (hp, alive) is the truth about hits.
 */

import {
  PLAYER,
  RARITY_DAMAGE_MULT,
  SoundKind,
  applyDamage,
  itemDef,
  raycastSolids,
  segmentCircleT,
  weaponVariant,
  type WeaponId,
} from "@extract/shared";
import { cancelHeal, startReload } from "./actions.js";
import { activeWeapon, ammoCount, syncPublic, weaponDefOf } from "./bag.js";
import { closeSearch } from "./containers.js";
import { killPlayer } from "./death.js";
import { toPlain } from "./items.js";
import type { Match } from "./match.js";
import { emitSound } from "./sound.js";
import type { PlayerRuntime } from "./types.js";

/**
 * A semi-auto press made slightly before the weapon is ready still fires when it becomes ready,
 * but not much later — a shot long after the click would feel like a misfire.
 */
export const PRESS_BUFFER_MS = 150;

/**
 * Called once per applied (non-roll) input, after the trigger state was updated from that input,
 * so shots leave from the position and aim of the input that fired them.
 */
export function tryFire(m: Match, rt: PlayerRuntime): void {
  if (rt.pressPending && m.clock - rt.pressAt > PRESS_BUFFER_MS) rt.pressPending = false;
  const w = activeWeapon(rt);
  const def = weaponDefOf(w);
  if (!w || !def) return;
  const wants = def.auto ? rt.triggerHeld : rt.pressPending;
  const s = rt.self;
  if (!wants || s.reloadUntil > 0) return;
  // Firing closes an open search first (inventory memo §2.2), then the shot is processed.
  closeSearch(m, rt, "fired");

  if (w.mag <= 0) {
    // Only a fresh press clicks (a held auto trigger would click 30 times a second).
    const pressed = rt.pressPending;
    rt.pressPending = false;
    if (ammoCount(rt, def.ammo) > 0) {
      cancelHeal(rt);
      startReload(m, rt);
    } else if (pressed) {
      emitSound(m, rt, SoundKind.dryFire, rt.pub.x, rt.pub.y);
    }
    return;
  }
  if (m.clock < rt.nextFireAt) return;

  cancelHeal(rt);
  rt.pressPending = false;
  // Strictly clock + interval: ticks quantize shots, and the rule is "never faster than the interval".
  rt.nextFireAt = m.clock + def.fireIntervalMs;
  rt.lastShotAt = m.clock;
  rt.stats.shotsFired++;
  w.mag -= 1;

  const p = rt.pub;
  const damage = def.damage * RARITY_DAMAGE_MULT[Math.max(0, Math.min(3, w.rarity)) as 0 | 1 | 2 | 3];
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
    src: rt.rosterIndex,
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
  emitSound(m, rt, SoundKind.shot, p.x, p.y, weaponVariant(def.id));

  if (w.mag <= 0 && ammoCount(rt, def.ammo) > 0) startReload(m, rt);
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
    let hit: PlayerRuntime | null = null;
    for (const rt of m.allRuntimes()) {
      if (!rt.pub.alive || rt === b.owner) continue;
      const t = segmentCircleT(b.x, b.y, sx, sy, rt.pub.x, rt.pub.y, R);
      if (t < hitT) { hitT = t; hit = rt; }
    }

    if (hit && hitT <= tWall) {
      damagePlayer(m, hit, b.damage, b.owner, b.weapon, b.x + sx * hitT, b.y + sy * hitT);
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
  rt: PlayerRuntime,
  raw: number,
  attacker: PlayerRuntime | null,
  weapon: WeaponId | "",
  hx: number,
  hy: number,
): void {
  const p = rt.pub;
  if (!p.alive) return;
  const s = rt.self;
  const armor = s.slots.get("armor");
  const level = armor ? (itemDef(armor.def)?.armorLevel ?? 0) : 0;
  const { hpLoss, armorUsed } = applyDamage(raw, level, armor ? armor.dur : 0);
  p.hp = Math.max(0, round2(p.hp - hpLoss));
  if (armor && armorUsed > 0) {
    armor.dur = round2(armor.dur - armorUsed);
    if (armor.dur <= 0) {
      // Armor worn down to nothing is destroyed for good (PlayerExitReport.destroyed).
      const gone = { ...toPlain(armor), dur: 0 };
      s.slots.delete("armor");
      rt.destroyed.push(gone);
      m.ledger.resolve(gone, "destroyed");
    }
  }
  if (attacker && attacker !== rt) {
    rt.lastHitBy = attacker;
    rt.lastHitAt = m.clock;
    attacker.stats.dmgDealt += hpLoss;
  }
  // Taking damage restarts the extraction channel.
  if (s.extractId) s.extractStartedAt = m.clock;

  m.emit({
    type: "hit",
    src: attacker?.rosterIndex ?? -1,
    target: rt.rosterIndex,
    msg: { t: rt.id, s: attacker?.id ?? "", x: hx, y: hy, d: round2(hpLoss), ar: armorUsed > 0 },
    fa: attacker && attacker !== rt ? Math.atan2(attacker.pub.y - p.y, attacker.pub.x - p.x) : undefined,
  });
  emitSound(m, rt, SoundKind.hurt, p.x, p.y);
  syncPublic(rt);
  if (p.hp <= 0) {
    killPlayer(m, rt, attacker, weapon);
    // The thud of the body: shorter range than the death cry, heard as a separate cue.
    emitSound(m, rt, SoundKind.bodyFall, p.x, p.y);
  }
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
