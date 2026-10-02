/**
 * Player intents that run over time: reload, heal, weapon switch. Timers live in SelfState
 * (reloadUntil / healUntil) so the owner's HUD draws progress bars without extra messages; others
 * only see the ACT bits (syncPublic).
 */

import { HEAL, PLAYER, SoundKind, type HealKind } from "@extract/shared";
import { activeWeapon, ammoCount, consumeMed, medCount, syncPublic, takeAmmo, weaponDefOf } from "./bag.js";
import type { Match } from "./match.js";
import { emitSound } from "./sound.js";
import type { PlayerRuntime } from "./types.js";

export function cancelReload(rt: PlayerRuntime): void {
  if (rt.self.reloadUntil !== 0) rt.self.reloadUntil = 0;
  rt.reloadKey = "";
}

/** Cancelled heals do not consume the item: it is only used up when the heal completes. */
export function cancelHeal(rt: PlayerRuntime): void {
  if (rt.self.healUntil !== 0) rt.self.healUntil = 0;
  if (rt.self.healKind !== "") rt.self.healKind = "";
}

export function startReload(m: Match, rt: PlayerRuntime): boolean {
  const s = rt.self;
  if (!rt.pub.alive || s.reloadUntil > 0 || s.healUntil > 0) return false;
  const w = activeWeapon(rt);
  const def = weaponDefOf(w);
  if (!w || !def) return false;
  if (w.mag >= def.magSize || ammoCount(rt, def.ammo) <= 0) return false;
  s.reloadUntil = m.clock + def.reloadMs;
  rt.reloadKey = s.active as "w1" | "w2";
  emitSound(m, rt, SoundKind.reload, rt.pub.x, rt.pub.y);
  return true;
}

/** Ammo moves into the magazine of the weapon that started the reload (if it is still there). */
export function finishReloadIfDue(m: Match, rt: PlayerRuntime): void {
  const s = rt.self;
  if (s.reloadUntil <= 0 || m.clock < s.reloadUntil) return;
  s.reloadUntil = 0;
  const key = rt.reloadKey;
  rt.reloadKey = "";
  const w = key ? s.slots.get(key) : undefined;
  const def = weaponDefOf(w);
  if (!w || !def) return;
  const need = def.magSize - w.mag;
  if (need <= 0) return;
  const took = takeAmmo(rt, def.ammo, need);
  if (took > 0) w.mag += took;
}

/** `m` (optional so callers without a match keep working) makes the switch audible nearby. */
export function switchSlot(rt: PlayerRuntime, slot: "w1" | "w2", m?: Match): boolean {
  const s = rt.self;
  if (!rt.pub.alive || slot === s.active) return false;
  if (!s.slots.get(slot)) return false;
  s.active = slot;
  cancelReload(rt);
  cancelHeal(rt);
  // A press made for the old weapon must not fire the new one.
  rt.pressPending = false;
  syncPublic(rt);
  if (m) emitSound(m, rt, SoundKind.switch, rt.pub.x, rt.pub.y);
  return true;
}

export function startHeal(m: Match, rt: PlayerRuntime, kind: HealKind): boolean {
  const s = rt.self;
  if (!rt.pub.alive || s.healUntil > 0 || s.reloadUntil > 0) return false;
  if (rt.pub.hp >= PLAYER.MAX_HP) return false;
  if (medCount(rt, kind) <= 0) return false;
  s.healUntil = m.clock + HEAL[kind].MS;
  s.healKind = kind;
  emitSound(m, rt, SoundKind.heal, rt.pub.x, rt.pub.y, kind === "medkit" ? 1 : 0);
  return true;
}

/** HP lands only when the channel completes, and only if a matching med is still carried. */
export function finishHealIfDue(m: Match, rt: PlayerRuntime): void {
  const s = rt.self;
  if (s.healUntil <= 0 || m.clock < s.healUntil) return;
  const kind = s.healKind as HealKind;
  cancelHeal(rt);
  if ((kind === "bandage" || kind === "medkit") && consumeMed(rt, kind)) {
    rt.pub.hp = Math.min(PLAYER.MAX_HP, rt.pub.hp + HEAL[kind].HP);
  }
}
