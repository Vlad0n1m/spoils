/**
 * Boss fights (docs/GAME_DESIGN.md §7c; numbers in shared economy.ts BOSS_FIGHT). The boss brain
 * (npc.ts NpcBrain.bossMove) runs the signature moves; this file holds the fight state of a boss
 * group and the rules around it:
 *
 * - Phases: phase 1 at spawn; phase 2 once the boss is at or below BOSS_FIGHT.PHASE2_FRAC of its max
 *   HP. The switch is announced (EventsMsg.boss "phase2": roar + toast) to the living humans within
 *   BOSS_FIGHT.ARENA_PX of the boss; nothing else learns of it. Player.bossPhase carries the phase to
 *   the clients that see the boss (the HUD bar's pips). The HP reset rule (BOSS_EVENT, npc.ts
 *   resetEventBoss) puts a boss back to full HP and phase 1; the move stock and the Commander's call
 *   are per boss life and never come back.
 * - Telegraphs: Player.bossTell is the move being wound up (THROW, CALL, CHARGE) or run (DASH).
 * - Foreman: grenade.ts throwNpcGrenade from a FREE stock (BOSS_FIGHT.FOREMAN.STOCK, no item).
 * - Commander: one reinforcement call per life in phase 2 (NpcSystem.spawnReinforcements): up to
 *   CALL_COUNT guards with FREE-only kits (equipReinforcement: nothing in their corpses), within
 *   NPC.MAX_PER_RAID living NPCs and the match's runtime capacity.
 * - Warden: a straight dash (Player speed × SPEED_MULT through PlayerRuntime.moveMult, the normal
 *   movement collision: walls and its leash stop it), then its shotgun; cover between bursts.
 * - Trophies: the human who kills a boss and the killer's party mates who damaged it this life
 *   (PlayerRuntime.bossDamagers, combat.ts) get the kind in PlayerRuntime.bossTrophies →
 *   PlayerExitReport.bossTrophies → the web grants the title (bossTrophyId) once.
 */

import {
  BOSS_FIGHT,
  BOSS_TELL,
  ITEM_FLAG,
  ammoDefOf,
  partyMates,
  type BossEvMsg,
  type BossKind,
  type BossTell,
} from "@extract/shared";
import { fixActive, placeItem, syncPublic } from "./bag.js";
import { cloneItem, makeItem } from "./items.js";
import type { Match } from "./match.js";
import type { PlayerRuntime } from "./types.js";

/** Fight state of one boss group (BossGroup.fight). */
export interface BossFight {
  phase: 1 | 2;
  /** Commander: reinforcements already called this life. */
  called: boolean;
  /** Foreman: FREE grenades left this life. */
  stock: number;
}

export function newBossFight(kind: BossKind): BossFight {
  return { phase: 1, called: false, stock: kind === "foreman" ? BOSS_FIGHT.FOREMAN.STOCK : 0 };
}

/** Set the telegraph a boss shows (Player.bossTell). */
export function setTell(rt: PlayerRuntime, tell: BossTell): void {
  if (rt.pub.bossTell !== tell) rt.pub.bossTell = tell;
}

/** Living humans within BOSS_FIGHT.ARENA_PX of (x, y): who hears the roar / the radio. */
export function arenaHumans(m: Match, x: number, y: number): PlayerRuntime[] {
  const r2 = BOSS_FIGHT.ARENA_PX * BOSS_FIGHT.ARENA_PX;
  return m.allRuntimes().filter((h) => !h.isNpc && h.pub.alive && (h.pub.x - x) ** 2 + (h.pub.y - y) ** 2 <= r2);
}

/** EventsMsg.boss to every human in the boss's arena. */
export function announce(m: Match, boss: PlayerRuntime, kind: BossKind, e: BossEvMsg["e"]): void {
  for (const h of arenaHumans(m, boss.pub.x, boss.pub.y)) m.emit({ type: "boss", to: h.rosterIndex, msg: { k: kind, e } });
}

/**
 * Phase bookkeeping, every step: 1 → 2 at PHASE2_FRAC of max HP (announced). Only the HP reset rule
 * goes back to phase 1 (resetBossPhase); a medkit never does. Returns true on the 1 → 2 switch.
 */
export function updateBossPhase(m: Match, boss: PlayerRuntime, kind: BossKind, fight: BossFight): boolean {
  const p = boss.pub;
  if (!p.alive) {
    if (p.bossTell !== BOSS_TELL.NONE) p.bossTell = BOSS_TELL.NONE;
    boss.moveMult = 1;
    return false;
  }
  if (fight.phase === 1 && p.hp <= p.maxHp * BOSS_FIGHT.PHASE2_FRAC) {
    fight.phase = 2;
    p.bossPhase = 2;
    announce(m, boss, kind, "phase2");
    return true;
  }
  if (p.bossPhase !== fight.phase) p.bossPhase = fight.phase;
  return false;
}

/** The HP reset rule refilled the boss (npc.ts resetEventBoss): phase 1 again, no move under way. */
export function resetBossPhase(boss: PlayerRuntime, fight: BossFight): void {
  fight.phase = 1;
  boss.pub.bossPhase = 1;
}

/** How many reinforcements fit now: CALL_COUNT, the living-NPC cap and the runtime capacity. */
export function reinforcementRoom(m: Match, maxPerRaid: number): number {
  let alive = 0;
  for (const rt of m.allRuntimes()) if (rt.isNpc && rt.pub.alive) alive++;
  const byCap = maxPerRaid - alive;
  const byRuntimes = m.runtimeCapacity - m.allRuntimes().length;
  return Math.max(0, Math.min(BOSS_FIGHT.COMMANDER.CALL_COUNT, byCap, byRuntimes));
}

/** FREE-only guard kit (BOSS_FIGHT.COMMANDER.GUARD): weapon, armor, backpack and ammo all vanish; the corpse is empty. */
export function equipReinforcement(rt: PlayerRuntime, role: number): void {
  const g = BOSS_FIGHT.COMMANDER.GUARD;
  const p = rt.pub;
  p.role = role;
  p.hp = g.hp;
  p.maxHp = g.hp;
  const s = rt.self.slots;
  const free = ITEM_FLAG.FREE;
  s.set("w1", cloneItem(makeItem(g.weapon, { rarity: g.rarity, flags: free })));
  s.set("armor", cloneItem(makeItem(`armor_${g.armor}`, { flags: free })));
  s.set("bp", cloneItem(makeItem("backpack_1", { flags: free })));
  placeItem(rt, makeItem(ammoDefOf(g.weapon), { qty: 90, flags: free }));
  rt.self.active = "w1";
  fixActive(rt);
  syncPublic(rt);
}

/**
 * The boss died to `killer`: the killer (a human) and the killer's party mates who damaged it this
 * life earn the trophy. A report already sent (extracted / dead before the kill landed) is updated
 * in place like its stats (death.ts).
 */
export function grantBossTrophies(boss: PlayerRuntime, kind: BossKind, killer: PlayerRuntime): PlayerRuntime[] {
  if (killer.isNpc) return [];
  const out = [killer];
  for (const d of boss.bossDamagers ?? []) {
    if (d !== killer && !d.isNpc && partyMates(killer.partyId, d.partyId)) out.push(d);
  }
  for (const rt of out) {
    rt.bossTrophies.add(kind);
    if (rt.exitReport) rt.exitReport.bossTrophies = [...rt.bossTrophies];
  }
  return out;
}
