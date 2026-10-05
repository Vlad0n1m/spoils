/**
 * Shooting, server-side bullets and damage. Bullets are never synced: clients draw tracers from
 * the ShotMsg in their `ev` batch, and the state (hp, alive) is the truth about hits.
 * Weapons v2: the crossbow bolt is an ordinary slow bullet (1100 px/s); a weapon without a muzzle
 * flash (WeaponDef.flash false) sets lastShotAt VISION.FLASH_MS back, so the shot cancels bush
 * concealment but never shows the shooter to the full VISION.RANGE. Grenade blasts (grenade.ts)
 * deal their damage through damagePlayer with weapon "grenade".
 *
 * Party (shared party.ts, PARTY.FRIENDLY_FIRE = false): a bullet passes through its shooter's party
 * mates exactly as NPC bullets pass through NPCs (no hit, no damage, no hit marker, it flies on to
 * whoever stands behind), and damagePlayer refuses any mate-on-mate damage as a backstop.
 */

import {
  NPC,
  NPC_ROLE,
  PLAYER,
  RARITY_DAMAGE_MULT,
  SERVER_TICK_MS,
  SoundKind,
  VISION,
  applyDamage,
  itemDef,
  partyMates,
  raycastSolids,
  segmentCircleT,
  weaponHasFlash,
  weaponVariant,
  type KillWeapon,
  isSupplyDropKey,
} from "@extract/shared";
import { cancelHeal, startReload } from "./actions.js";
import { activeWeapon, ammoCount, syncPublic, weaponDefOf } from "./bag.js";
import { closeSearch } from "./containers.js";
import { killPlayer } from "./death.js";
import { recordHit } from "./recap.js";
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
  // Semi-auto: strictly clock + interval (ticks quantize shots; "never faster than the interval").
  // Automatic fire held through (Weapons v2: the SMG's 75 ms and the LMG's 110 ms are not multiples
  // of the 50 ms tick): a shot that went out less than one tick after it was due carries the
  // schedule on, so the held rate averages exactly the interval (never two shots in one tick)
  // instead of rounding up to the next tick (75 → 100 ms, 110 → 150 ms). The rifle's 100 ms is unchanged.
  const due = rt.nextFireAt;
  rt.nextFireAt = (def.auto && m.clock - due < SERVER_TICK_MS ? Math.max(due, m.clock - SERVER_TICK_MS + 1) : m.clock) + def.fireIntervalMs;
  // No flash (crossbow): the bush reveal (SHOT_REVEAL_MS) still applies, the flash (FLASH_MS) never.
  rt.lastShotAt = weaponHasFlash(def.id) ? m.clock : Math.max(rt.lastShotAt, m.clock - VISION.FLASH_MS);
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
      rarity: Math.max(0, Math.min(3, w.rarity)),
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
    // NPCs are one faction (NPC.FRIENDLY_FIRE false): their bullets pass through other NPCs, so
    // luring squads into a crossfire gives nothing.
    const npcShot = b.owner.isNpc && !NPC.FRIENDLY_FIRE;
    const party = b.owner.partyId;
    for (const rt of m.allRuntimes()) {
      // A sheltered (disconnected, hidden) raider is not there for bullets either.
      if (!rt.pub.alive || rt === b.owner || (npcShot && rt.isNpc) || rt.shelterUntil >= 0) continue;
      // Party mates are transparent to each other's bullets (PARTY.FRIENDLY_FIRE = false).
      if (party && partyMates(party, rt.partyId)) continue;
      const t = segmentCircleT(b.x, b.y, sx, sy, rt.pub.x, rt.pub.y, R);
      if (t < hitT) { hitT = t; hit = rt; }
    }

    if (hit && hitT <= tWall) {
      damagePlayer(m, hit, b.damage, b.owner, b.weapon, b.x + sx * hitT, b.y + sy * hitT, undefined, b.rarity);
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

/**
 * Apply `raw` damage (before armor) to `rt`. `from` = where the damage came from for the target's
 * damage arc (default: the attacker's position; grenades pass the blast centre).
 */
export function damagePlayer(
  m: Match,
  rt: PlayerRuntime,
  raw: number,
  attacker: PlayerRuntime | null,
  weapon: KillWeapon | "",
  hx: number,
  hy: number,
  from?: { x: number; y: number },
  rarity = -1,
): void {
  const p = rt.pub;
  if (!p.alive) return;
  // Disconnect shelter (Match.detach): a hidden raider takes no damage from any source.
  if (rt.shelterUntil >= 0) return;
  // No damage between party mates from any source (HP, armor and its durability stay untouched).
  if (attacker && attacker !== rt && partyMates(attacker.partyId, rt.partyId)) return;
  // "In combat" for the disconnect shelter: both sides of any damage.
  rt.combatAt = m.clock;
  if (attacker) attacker.combatAt = m.clock;
  const s = rt.self;
  const armor = s.slots.get("armor");
  const level = armor ? (itemDef(armor.def)?.armorLevel ?? 0) : 0;
  const { hpLoss, armorUsed } = applyDamage(raw, level, armor ? armor.dur : 0);
  const hpBefore = p.hp;
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
    // Boss trophies (boss-fight.ts): the killer's party mates who damaged the boss share it.
    if (p.role === NPC_ROLE.BOSS && !attacker.isNpc && hpLoss > 0) (rt.bossDamagers ??= new Set()).add(attacker);
  }
  // Death recap (recap.ts): every hit that cost HP or armor, with the HP it actually took (no overkill).
  if (hpLoss > 0 || armorUsed > 0) recordHit(m, rt, attacker, weapon, rarity, round2(hpBefore - p.hp));
  // Taking damage restarts the extraction channel.
  if (s.extractId) s.extractStartedAt = m.clock;
  // WORLD v6: damage interrupts the supply crate's open channel (contests happen at the crate).
  if (hpLoss > 0 && rt.search && m.clock < rt.search.readyAt && isSupplyDropKey(rt.search.key)) closeSearch(m, rt, "hit");
  // In-raid objectives: damage breaks an unlock / crack channel.
  if (hpLoss > 0) m.objectives.onHit(rt);

  m.emit({
    type: "hit",
    src: attacker?.rosterIndex ?? -1,
    target: rt.rosterIndex,
    msg: { t: rt.id, s: attacker?.id ?? "", x: hx, y: hy, d: round2(hpLoss), ar: armorUsed > 0 },
    fa: from
      ? Math.atan2(from.y - p.y, from.x - p.x)
      : attacker && attacker !== rt ? Math.atan2(attacker.pub.y - p.y, attacker.pub.x - p.x) : undefined,
    ...(weapon === "grenade" && from ? { area: { x: from.x, y: from.y } } : {}),
  });
  emitSound(m, rt, SoundKind.hurt, p.x, p.y);
  syncPublic(rt);
  if (p.hp <= 0) {
    killPlayer(m, rt, attacker ?? selfKillCredit(m, rt, weapon), weapon);
    // The thud of the body: shorter range than the death cry, heard as a separate cue.
    emitSound(m, rt, SoundKind.bodyFall, p.x, p.y);
  }
}

/** A self-inflicted kill (own grenade) within this long of an enemy's last hit credits that enemy. */
export const SELF_KILL_CREDIT_MS = 10_000;

/**
 * Who gets the kill when a player dies to their own grenade (attacker null): the last enemy who hit
 * them within SELF_KILL_CREDIT_MS, so blowing yourself up never denies the attacker the kill, the
 * victims entry (ranked PvP XP) or the full dog tag price. Null otherwise (a plain suicide).
 */
function selfKillCredit(m: Match, rt: PlayerRuntime, weapon: KillWeapon | ""): PlayerRuntime | null {
  if (weapon !== "grenade") return null;
  const by = rt.lastHitBy;
  if (!by || by === rt || m.clock - rt.lastHitAt > SELF_KILL_CREDIT_MS) return null;
  return by;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
