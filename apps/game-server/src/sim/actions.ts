/**
 * Player intents that run over time: reload, heal, weapon switch. Timers live in the synced state
 * (reloadUntil / healUntil) so clients can draw progress bars without extra messages.
 */

import { HEAL, PLAYER, WEAPONS, type HealKind, type Player, type WeaponId } from "@extract/shared";
import { ammoOf, setAmmo } from "./inventory.js";
import type { Match } from "./match.js";
import type { PlayerRuntime } from "./types.js";

export function cancelReload(p: Player): void {
  p.reloadUntil = 0;
}

/** Cancelled heals do not consume the item: it is only used up when the heal completes. */
export function cancelHeal(p: Player): void {
  p.healUntil = 0;
  p.healKind = "";
}

export function startReload(m: Match, rt: PlayerRuntime, p: Player): boolean {
  if (!p.alive || p.reloadUntil > 0 || p.healUntil > 0) return false;
  const slot = p.slots[p.active];
  if (!slot?.weapon) return false;
  const def = WEAPONS[slot.weapon as WeaponId];
  if (slot.mag >= def.magSize || ammoOf(p, def.ammo) <= 0) return false;
  p.reloadUntil = m.clock + def.reloadMs;
  rt.reloadSlot = p.active;
  return true;
}

export function finishReloadIfDue(m: Match, rt: PlayerRuntime, p: Player): void {
  if (p.reloadUntil <= 0 || m.clock < p.reloadUntil) return;
  p.reloadUntil = 0;
  const slot = p.slots[rt.reloadSlot];
  if (!slot?.weapon) return;
  const def = WEAPONS[slot.weapon as WeaponId];
  const take = Math.min(def.magSize - slot.mag, ammoOf(p, def.ammo));
  if (take <= 0) return;
  slot.mag += take;
  setAmmo(p, def.ammo, ammoOf(p, def.ammo) - take);
}

export function switchSlot(rt: PlayerRuntime, p: Player, slot: number): boolean {
  if (!p.alive || (slot !== 0 && slot !== 1) || slot === p.active) return false;
  if (!p.slots[slot]?.weapon) return false;
  p.active = slot;
  cancelReload(p);
  cancelHeal(p);
  // A press made for the old weapon must not fire the new one.
  rt.pressPending = false;
  return true;
}

export function startHeal(m: Match, p: Player, kind: HealKind): boolean {
  if (!p.alive || p.healUntil > 0 || p.reloadUntil > 0) return false;
  if (p.hp >= PLAYER.MAX_HP) return false;
  const count = kind === "bandage" ? p.bandages : p.medkits;
  if (count <= 0) return false;
  p.healUntil = m.clock + HEAL[kind].MS;
  p.healKind = kind;
  return true;
}

export function finishHealIfDue(m: Match, p: Player): void {
  if (p.healUntil <= 0 || m.clock < p.healUntil) return;
  const kind = p.healKind as HealKind;
  cancelHeal(p);
  if (kind === "bandage" && p.bandages > 0) {
    p.bandages -= 1;
    p.hp = Math.min(PLAYER.MAX_HP, p.hp + HEAL.bandage.HP);
  } else if (kind === "medkit" && p.medkits > 0) {
    p.medkits -= 1;
    p.hp = Math.min(PLAYER.MAX_HP, p.hp + HEAL.medkit.HP);
  }
}
