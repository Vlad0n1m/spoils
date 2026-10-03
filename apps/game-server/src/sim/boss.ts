/**
 * Bosses and their guards (loot economy v4, "risk drives reward"): the top loot of a raid sits on
 * NPCs that hold the contested POIs instead of lying in quiet containers. NPC MODEL v5 runs them
 * through the same NpcSystem / NpcBrain as the marauder squads (npc.ts): a boss group is a squad of
 * type "boss". This file holds what is boss-specific:
 *
 * - Spawn: rolled once per match from the match seed (shared rollBossSpawns(matchSeed, map.bosses),
 *   the same call the matchmaking room makes before raids/start, so the web's allocation and the
 *   sim agree on who exists). A boss stands at its BossSpot, each guard at its guard post. No
 *   respawn, no extraction, no container looting.
 * - Boss kit (equipBoss): its pool items from raids/start (containerLoot[bossLootKey(kind)],
 *   registered as "pool" by ContainerSystem.allocatePool) — the best pool weapon is wielded
 *   (non-FREE: it drops), everything else rides in storage, never worn (FREE armor / backpack are
 *   what get shot). Plus boss-only junk (rollBossJunk), its meds and BOSSES[kind].ammo rounds (all
 *   non-FREE: what is not used drops) and a FREE ammo reserve (consumed first, vanishes).
 * - Guard kit (equipGuard): FREE weapon / armor / backpack and a FREE ammo reserve (vanish), plus
 *   the non-FREE drop rollGuardLoot (one roll of its zone tier's crate table, GUARD_DROP ammo, a
 *   bandage at GUARD_DROP.BANDAGE_CHANCE).
 * - Death (death.ts): every NPC bag is exempt from BREAK_CHANCE_ON_DEATH (NPC.NO_BREAK), so every
 *   pool item reaches the corpse; killing a boss credits stats.bossKills.
 * - Heal: the boss uses its medkits below BOSS_AI.HEAL_BELOW_FRAC of its own maxHp. The generic
 *   heal (actions.ts) caps at PLAYER.MAX_HP, so NPC heals are finished here first (each step, before
 *   Match runs finishHealIfDue) and cap at Player.maxHp.
 */

import {
  BOSSES,
  HEAL,
  ITEM_FLAG,
  NPC,
  NPC_ROLE,
  SoundKind,
  ammoDefOf,
  itemDef,
  rollBossJunk,
  rollGuardLoot,
  storageKeys,
  uniqueTierScore,
  type BossKind,
  type BossSpot,
  type HealKind,
  type ItemLike,
  type WeaponId,
} from "@extract/shared";
import { cancelHeal } from "./actions.js";
import { consumeMed, fixActive, medCount, placeItem, syncPublic } from "./bag.js";
import { cloneItem, makeItem } from "./items.js";
import type { Match } from "./match.js";
import { emitSound } from "./sound.js";
import type { PlayerRuntime } from "./types.js";

/** FREE rounds of its weapon's ammo every boss carries on top of BOSSES[kind].ammo (used first, vanish). */
export const BOSS_FREE_AMMO = 60;
/** FREE rounds every guard carries (used first, vanish); its non-FREE drop comes from rollGuardLoot. */
export const GUARD_FREE_AMMO = 90;

/** Guard posts actually used by a spawned boss (BossSpot.guards, at most BOSSES[kind].guards). */
export function guardCount(spot: BossSpot): number {
  return Math.min(spot.guards.length, BOSSES[spot.kind].guards.length);
}

/** NPC runtimes the spawned bosses add (boss + guards each). */
export function bossNpcCount(spawned: readonly BossSpot[]): number {
  return spawned.reduce((n, s) => n + 1 + guardCount(s), 0);
}

/** Is this runtime an NPC (boss, guard or marauder: Player.role != NPC_ROLE.NONE)? */
export function isNpc(rt: PlayerRuntime): boolean {
  return rt.pub.role !== NPC_ROLE.NONE;
}

/** Wielding order of pool weapons: tier score, rarity, then weapon class. */
const WEAPON_RANK: Readonly<Record<WeaponId, number>> = { pistol: 0, sniper: 1, shotgun: 2, rifle: 3 };
function weaponRank(it: ItemLike): number {
  const w = itemDef(it.def)?.weapon;
  return w ? uniqueTierScore(it.def, it.rarity) * 100 + it.rarity * 10 + WEAPON_RANK[w] : -1;
}

/** Put an item straight into the first empty storage slot (never auto-equipped). */
export function stow(rt: PlayerRuntime, it: ItemLike): boolean {
  const s = rt.self.slots;
  for (const k of storageKeys(s)) {
    if (s.get(k)) continue;
    s.set(k, cloneItem(it));
    return true;
  }
  return false;
}

/**
 * FREE pistol sidearm (+ NPC.SIDEARM_AMMO FREE light rounds) in w2 for an NPC whose w1 is a
 * shotgun: it switches to it for targets beyond shotgun range (npc.ts manageWeapons). FREE: never
 * in the corpse, never extracted (v5 review: shotgun NPCs were free kills for a pistol at 520 px).
 */
export function giveSidearm(rt: PlayerRuntime): void {
  const s = rt.self.slots;
  const w1 = s.get("w1");
  if (!w1 || itemDef(w1.def)?.weapon !== "shotgun" || s.get("w2")) return;
  s.set("w2", cloneItem(makeItem("pistol", { flags: ITEM_FLAG.FREE })));
  placeItem(rt, makeItem(ammoDefOf("pistol"), { qty: NPC.SIDEARM_AMMO, flags: ITEM_FLAG.FREE }));
}

/** Boss kit: pool items (best weapon wielded, the rest stowed), FREE armor / backpack / reserve, boss junk and meds. */
export function equipBoss(m: Match, rt: PlayerRuntime, kind: BossKind, pool: ItemLike[]): void {
  const def = BOSSES[kind];
  const p = rt.pub;
  p.role = NPC_ROLE.BOSS;
  p.hp = def.hp;
  p.maxHp = def.hp;
  const s = rt.self.slots;
  const free = ITEM_FLAG.FREE;
  // The best pool weapon is wielded (non-FREE, never breaks: it drops with the corpse).
  const weapons = pool.filter((it) => itemDef(it.def)?.cat === "weapon").sort((a, b) => weaponRank(b) - weaponRank(a));
  const wield = weapons[0];
  const weapon: WeaponId = wield ? itemDef(wield.def)!.weapon! : def.weapon;
  s.set("w1", cloneItem(wield ?? makeItem(def.weapon, { rarity: def.weaponRarity, flags: free })));
  s.set("armor", cloneItem(makeItem(`armor_${def.armor}`, { flags: free })));
  s.set("bp", cloneItem(makeItem("backpack_3", { flags: free })));
  for (const it of pool) {
    if (it === wield) continue;
    if (!stow(rt, it)) console.error(`[boss] ${kind}: no room for pool item ${it.def} ${it.uid}`);
  }
  const ammo = ammoDefOf(weapon);
  placeItem(rt, makeItem(ammo, { qty: BOSS_FREE_AMMO, flags: free }));
  giveSidearm(rt);
  if (def.ammo > 0) placeItem(rt, makeItem(ammo, { qty: def.ammo }));
  if (def.meds.medkit > 0) placeItem(rt, makeItem("medkit", { qty: def.meds.medkit }));
  if (def.meds.bandage > 0) placeItem(rt, makeItem("bandage", { qty: def.meds.bandage }));
  for (const j of rollBossJunk(m.lootSeed, kind)) placeItem(rt, makeItem(j.def, { qty: j.qty, rarity: j.rarity }));
  rt.self.active = "w1";
  fixActive(rt);
  syncPublic(rt);
}

/** Guard kit: FREE weapon / armor / backpack / reserve, plus the non-FREE rollGuardLoot drop. */
export function equipGuard(m: Match, rt: PlayerRuntime, kind: BossKind, idx: number, tier: number): void {
  const g = BOSSES[kind].guards[idx]!;
  const p = rt.pub;
  p.role = NPC_ROLE.GUARD;
  p.hp = g.hp;
  p.maxHp = g.hp;
  const s = rt.self.slots;
  const free = ITEM_FLAG.FREE;
  s.set("w1", cloneItem(makeItem(g.weapon, { rarity: g.rarity, flags: free })));
  if (g.armor > 0) s.set("armor", cloneItem(makeItem(`armor_${g.armor}`, { flags: free })));
  s.set("bp", cloneItem(makeItem("backpack_1", { flags: free })));
  placeItem(rt, makeItem(ammoDefOf(g.weapon), { qty: GUARD_FREE_AMMO, flags: free }));
  giveSidearm(rt);
  for (const f of rollGuardLoot(m.lootSeed, kind, idx, tier)) placeItem(rt, makeItem(f.def, { qty: f.qty, rarity: f.rarity }));
  rt.self.active = "w1";
  fixActive(rt);
  syncPublic(rt);
}

/**
 * Start an NPC heal (same channel as a player's: SelfState.healUntil, heal sound, slowed walk),
 * allowed up to the NPC's own maxHp. Returns true when started.
 */
export function startNpcHeal(m: Match, rt: PlayerRuntime, kind: HealKind = "medkit"): boolean {
  const s = rt.self;
  if (!rt.pub.alive || s.healUntil > 0 || s.reloadUntil > 0) return false;
  if (rt.pub.hp >= rt.pub.maxHp) return false;
  if (medCount(rt, kind) <= 0) return false;
  s.healUntil = m.clock + HEAL[kind].MS;
  s.healKind = kind;
  emitSound(m, rt, SoundKind.heal, rt.pub.x, rt.pub.y, kind === "medkit" ? 1 : 0);
  return true;
}

/** Land a due NPC heal before actions.ts would (it caps at PLAYER.MAX_HP); caps at Player.maxHp. */
export function finishNpcHealIfDue(m: Match, rt: PlayerRuntime): void {
  const s = rt.self;
  if (!rt.pub.alive || s.healUntil <= 0 || m.clock < s.healUntil) return;
  const kind = s.healKind as HealKind;
  cancelHeal(rt);
  if ((kind === "bandage" || kind === "medkit") && consumeMed(rt, kind)) {
    rt.pub.hp = Math.min(rt.pub.maxHp, rt.pub.hp + HEAL[kind].HP);
  }
}
