/**
 * Bosses and their guards (loot economy v4, "risk drives reward"): the top loot of a raid sits on
 * NPCs that hold the contested POIs instead of lying in quiet containers.
 *
 * - Spawn: rolled once per match from the match seed (shared rollBossSpawns(matchSeed, map.bosses),
 *   the same call the matchmaking room makes before raids/start, so the web's allocation and the
 *   sim agree on who exists). A boss stands at its BossSpot, each guard at its guard post. No
 *   respawn, no extraction, no container looting.
 * - Runtimes: NPCs are appended after the roster (rosterIndex = roster.length + k), isBot = true,
 *   Player.role = NPC_ROLE.BOSS / GUARD and Player.maxHp = their HP (above PLAYER.MAX_HP). Their
 *   brains (BotBrain with an NpcInfo) live in BossSystem.brains, not in Match.bots, so roster bot
 *   counts and role splits are unchanged.
 * - Boss kit: its pool items from raids/start (containerLoot[bossLootKey(kind)], registered as
 *   "pool" by ContainerSystem.allocatePool) — the best pool weapon is wielded (non-FREE: it drops),
 *   everything else rides in storage, never worn (FREE armor / backpack are what get shot). Plus
 *   boss-only junk (rollBossJunk), its meds and BOSSES[kind].ammo rounds (all non-FREE: what is not
 *   used drops) and a FREE ammo reserve (consumed first, vanishes).
 * - Guard kit: FREE weapon / armor / backpack and a FREE ammo reserve (vanish), plus the non-FREE
 *   drop rollGuardLoot (one roll of its zone tier's crate table, ammo, a bandage).
 * - Death (death.ts): boss and guard bags are exempt from BREAK_CHANCE_ON_DEATH (BOSS_AI.NO_BREAK),
 *   so every pool item reaches the corpse; killing a boss credits stats.bossKills.
 * - Unlooted: a boss still alive at the end times out (bot settlement → leftOnMap, no wear); its
 *   corpse contents are leftOnMap through the containers; pool items of a boss that did not spawn
 *   stay in ContainerSystem and are leftOnMap too. Nothing a boss holds is minted.
 * - Alert: a group shares one alert (last-known position, BOSS_AI.ALERT_MS). Any member seeing an
 *   enemy (after the peace window), being hit, or hearing a gunshot within BOSS_AI.ALERT_HEAR_PX
 *   alerts all of them; guards converge inside their leash, the boss holds its room.
 * - Heal: the boss uses its medkits below BOSS_AI.HEAL_BELOW_FRAC of its own maxHp. The generic
 *   heal (actions.ts) caps at PLAYER.MAX_HP, so NPC heals are finished here first (each step, before
 *   Match runs finishHealIfDue) and cap at Player.maxHp.
 */

import {
  BOSSES,
  BOSS_AI,
  HEAL,
  ITEM_FLAG,
  NPC_ROLE,
  SoundKind,
  ammoDefOf,
  itemDef,
  rollBossJunk,
  rollGuardLoot,
  storageKeys,
  uniqueTierScore,
  zoneAt,
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
import type { Pt } from "./nav.js";
import { emitSound } from "./sound.js";
import type { PlayerRuntime } from "./types.js";

/** FREE rounds of its weapon's ammo every boss carries on top of BOSSES[kind].ammo (used first, vanish). */
export const BOSS_FREE_AMMO = 60;
/** FREE rounds every guard carries (used first, vanish); its non-FREE drop comes from rollGuardLoot. */
export const GUARD_FREE_AMMO = 90;

export interface BossGroup {
  kind: BossKind;
  spot: BossSpot;
  /** Tier of the boss's zone (guard drops roll that tier's crate table). */
  tier: number;
  boss: PlayerRuntime;
  guards: PlayerRuntime[];
  /** Group alert: active until this clock, toward the last-known enemy position. */
  alertUntil: number;
  alertAt: Pt | null;
}

/** What an NPC brain needs to know about itself. */
export interface NpcInfo {
  role: "boss" | "guard";
  kind: BossKind;
  group: BossGroup;
  /** Index into BOSSES[kind].guards (-1 for the boss). */
  guardIdx: number;
  /** Where it holds: the BossSpot (boss) or its guard post. */
  anchor: Pt;
  /** Leash radius around the anchor. */
  leash: number;
}

/** One NPC to create (match.ts turns it into a runtime at x / y). */
export interface NpcSpawn {
  nickname: string;
  x: number;
  y: number;
}

/** Guard posts actually used by a spawned boss (BossSpot.guards, at most BOSSES[kind].guards). */
export function guardCount(spot: BossSpot): number {
  return Math.min(spot.guards.length, BOSSES[spot.kind].guards.length);
}

/** NPC runtimes the spawned bosses add (boss + guards each). */
export function bossNpcCount(spawned: readonly BossSpot[]): number {
  return spawned.reduce((n, s) => n + 1 + guardCount(s), 0);
}

/** Is this runtime a boss or a boss guard? */
export function isNpc(rt: PlayerRuntime): boolean {
  return rt.pub.role !== NPC_ROLE.NONE;
}

/** Wielding order of pool weapons: tier score, rarity, then weapon class. */
const WEAPON_RANK: Readonly<Record<WeaponId, number>> = { pistol: 0, sniper: 1, shotgun: 2, rifle: 3 };
function weaponRank(it: ItemLike): number {
  const w = itemDef(it.def)?.weapon;
  return w ? uniqueTierScore(it.def, it.rarity) * 100 + it.rarity * 10 + WEAPON_RANK[w] : -1;
}

/** Put a unique straight into the first empty storage slot (never auto-equipped). */
function stow(rt: PlayerRuntime, it: ItemLike): boolean {
  const s = rt.self.slots;
  for (const k of storageKeys(s)) {
    if (s.get(k)) continue;
    s.set(k, cloneItem(it));
    return true;
  }
  return false;
}

export class BossSystem {
  readonly groups: BossGroup[] = [];
  /** NPC brains (created by the match; empty when brains are off). */
  readonly brains: Array<{ update(dtMs: number): void }> = [];
  private readonly npcs = new Map<PlayerRuntime, NpcInfo>();

  constructor(private readonly m: Match) {}

  info(rt: PlayerRuntime): NpcInfo | undefined {
    return this.npcs.get(rt);
  }

  /** Every NPC runtime (boss and guards of every group). */
  runtimes(): PlayerRuntime[] {
    return [...this.npcs.keys()];
  }

  /** A living boss within `r` px of (x, y) (PMC bots keep their goals out of that radius). */
  livingBossWithin(x: number, y: number, r: number): boolean {
    for (const g of this.groups) {
      const b = g.boss.pub;
      if (b.alive && (b.x - x) ** 2 + (b.y - y) ** 2 <= r * r) return true;
    }
    return false;
  }

  /** Alert the whole group toward (x, y) for BOSS_AI.ALERT_MS. */
  alert(g: BossGroup, x: number, y: number): void {
    g.alertUntil = this.m.clock + BOSS_AI.ALERT_MS;
    g.alertAt = { x, y };
  }

  /**
   * Create the groups of the spawned bosses. `add` creates a runtime (roster index, Player, self
   * entry) for one NPC; `brain` (null = no brains, rule tests) builds its BotBrain.
   */
  spawn(
    spawned: readonly BossSpot[],
    add: (n: NpcSpawn) => PlayerRuntime,
    brain: ((rt: PlayerRuntime, info: NpcInfo) => { update(dtMs: number): void }) | null,
  ): void {
    const m = this.m;
    let legacy = m.containers.takeLegacyBossPool();
    for (const spot of spawned) {
      const def = BOSSES[spot.kind];
      const tier = m.map.zones.find((z) => z.id === spot.zone)?.tier ?? zoneAt(m.map, spot.x, spot.y)?.tier ?? 0;
      const boss = add({ nickname: def.name, x: spot.x, y: spot.y });
      const group: BossGroup = { kind: spot.kind, spot, tier, boss, guards: [], alertUntil: 0, alertAt: null };
      const pool = [...m.containers.takeBossPool(spot.kind), ...legacy];
      legacy = [];
      this.equipBoss(boss, spot.kind, pool);
      this.npcs.set(boss, { role: "boss", kind: spot.kind, group, guardIdx: -1, anchor: { x: spot.x, y: spot.y }, leash: BOSS_AI.LEASH_BOSS_PX });
      for (let i = 0; i < guardCount(spot); i++) {
        const post = spot.guards[i]!;
        const g = add({ nickname: def.guardName, x: post.x, y: post.y });
        this.equipGuard(g, spot.kind, i, tier);
        group.guards.push(g);
        this.npcs.set(g, { role: "guard", kind: spot.kind, group, guardIdx: i, anchor: { x: post.x, y: post.y }, leash: BOSS_AI.LEASH_GUARD_PX });
      }
      this.groups.push(group);
    }
    // No boss spawned for legacy "boss" items: they stay listed in the containers (leftOnMap).
    if (legacy.length) m.containers.returnLegacyBossPool(legacy);
    if (brain) for (const [rt, info] of this.npcs) this.brains.push(brain(rt, info));
  }

  private equipBoss(rt: PlayerRuntime, kind: BossKind, pool: ItemLike[]): void {
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
    if (def.ammo > 0) placeItem(rt, makeItem(ammo, { qty: def.ammo }));
    if (def.meds.medkit > 0) placeItem(rt, makeItem("medkit", { qty: def.meds.medkit }));
    if (def.meds.bandage > 0) placeItem(rt, makeItem("bandage", { qty: def.meds.bandage }));
    for (const j of rollBossJunk(this.m.state.mapSeed, kind)) placeItem(rt, makeItem(j.def, { qty: j.qty, rarity: j.rarity }));
    rt.self.active = "w1";
    fixActive(rt);
    syncPublic(rt);
  }

  private equipGuard(rt: PlayerRuntime, kind: BossKind, idx: number, tier: number): void {
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
    for (const f of rollGuardLoot(this.m.state.mapSeed, kind, idx, tier)) placeItem(rt, makeItem(f.def, { qty: f.qty, rarity: f.rarity }));
    rt.self.active = "w1";
    fixActive(rt);
    syncPublic(rt);
  }

  /** Per step, before the match's reload / heal timers: NPC heals land (capped at maxHp), then brains. */
  update(dtMs: number): void {
    for (const rt of this.npcs.keys()) finishNpcHealIfDue(this.m, rt);
    for (const b of this.brains) b.update(dtMs);
  }
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
