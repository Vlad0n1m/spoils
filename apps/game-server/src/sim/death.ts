/**
 * Death (critique "Durability semantics and death wear", inventory memo §2.4):
 * - every non-FREE unique breaks with BREAK_CHANCE_ON_DEATH: flagged BROKEN, NOT put into the
 *   corpse, resolved as `lost` and reported in PlayerExitReport.lost (web: → lost pool at −8 dur);
 * - survivors keep their durability (and magazine) and stay in the corpse for others;
 * - fungibles (ammo, meds, junk) never break; FREE items vanish;
 * - every human corpse holds a dog tag (label = nickname, lvl = level, ref = self key → the victim
 *   userId in reports), so it has to be searched for; NPCs leave none (no NPC farming);
 * - every NPC bag (boss, guard, marauder) is exempt from the break roll (NPC.NO_BREAK): pool items
 *   on bosses and carriers always reach the corpse; NPC gear is FREE and vanishes.
 * Kill credit: `kills` (HUD, reports, XP_KILL) counts human victims only; a human's NPC kills go to
 * stats.bossKills (bosses) and stats.npcKills (guards, marauders). KillMsg carries both roles.
 * Party mates (partyMates) never credit each other: no kill, no victims entry (ranked PvP XP), no
 * killerUserId (full dog tag price). combat.ts already keeps them from damaging each other.
 * Nothing is scattered on the ground: the body is a searchable Corpse (state.corpses, AOI-filtered)
 * whose contents go through the searchers' loot entry k<id> (containers.ts).
 */

import { BREAK_CHANCE_ON_DEATH, DOG_TAG, ITEM_FLAG, NPC, NPC_ROLE, SoundKind, partyMates, type ItemLike, type KillWeapon } from "@extract/shared";
import { cancelHeal, cancelReload } from "./actions.js";
import { carriedItems, clearSlots, syncPublic } from "./bag.js";
import { closeSearch } from "./containers.js";
import { isTrackedUnique, makeItem } from "./items.js";
import type { Match } from "./match.js";
import { emitSound } from "./sound.js";
import type { PlayerRuntime } from "./types.js";

export function killPlayer(m: Match, rt: PlayerRuntime, killer: PlayerRuntime | null, weapon: KillWeapon | ""): void {
  const p = rt.pub;
  if (!p.alive) return;
  const s = rt.self;
  p.alive = false;
  p.hp = 0;
  p.diedAt = m.clock;
  s.extractStartedAt = 0;
  s.extractId = "";
  cancelReload(rt);
  cancelHeal(rt);
  closeSearch(m, rt, "death");
  rt.queue.length = 0;
  rt.triggerHeld = false;
  rt.pressPending = false;

  if (killer && killer !== rt) {
    rt.killedBy = killer.nickname;
    if (!killer.isNpc && !partyMates(killer.partyId, rt.partyId)) {
      // Kill credit (web XP): human victims → kills (XP_KILL); bosses → bossKills (XP_BOSS);
      // guards and marauders → npcKills (XP_NPC; guards also guardKills → XP_GUARD). NPCs earn nothing.
      if (p.role === NPC_ROLE.NONE) killer.self.kills = Math.min(255, killer.self.kills + 1);
      else if (p.role === NPC_ROLE.BOSS) killer.stats.bossKills++;
      else {
        killer.stats.npcKills++;
        if (p.role === NPC_ROLE.GUARD) killer.stats.guardKills++;
      }
      if (rt.isNpc) m.npcs.creditKill(rt);
      // WORLD v6 (D22 / spec §3.4): who killed whom, for dog tag prices (SettledItem.by) and ranked
      // PvP (PlayerExitReport.victims; guests included, the web filters).
      if (!rt.isNpc && rt.userId) {
        rt.killerUserId = killer.userId;
        killer.victims.push(rt.userId);
      }
    }
    // A bullet still in flight can kill after its shooter already extracted or died: keep their
    // frozen result in line and resend it.
    if (killer.exitReport) {
      killer.exitReport.kills = killer.self.kills;
      killer.exitReport.stats = { ...killer.stats };
      if (killer.exitReport.victims) killer.exitReport.victims = [...killer.victims];
    }
    if (killer.outcome) {
      killer.outcome = { ...killer.outcome, kills: killer.self.kills };
      if (!killer.isNpc) m.emit({ type: "outcome", to: killer.rosterIndex, msg: killer.outcome });
    }
  }
  const { lost, dropped } = buildCorpse(m, rt);
  const by = killer && killer !== rt ? killer : null;
  m.emit({
    type: "kill",
    src: by?.rosterIndex ?? -1,
    msg: {
      victim: rt.nickname,
      victimId: rt.id,
      killer: by ? by.nickname : "",
      killerId: by ? by.id : "",
      weapon,
      killerRole: by?.pub.role ?? NPC_ROLE.NONE,
      victimRole: p.role,
    },
  });
  emitSound(m, rt, SoundKind.death, p.x, p.y);
  // WORLD v6 (D13): the event boss died → BattleState.bossState = killed, world event for the lobby.
  if (m.world && p.role === NPC_ROLE.BOSS && m.state.bossState === 1) {
    m.state.bossState = 2;
    const kind = m.npcs.info(rt)?.kind;
    if (kind) {
      const human = by && !by.isNpc ? by : null;
      // byUserId only for a registered raider: a guest's userId is a throwaway session id.
      m.emit({ type: "world", kind: "boss_killed", boss: kind, by: human ? human.nickname : "", byUserId: human && !human.guest && human.userId ? human.userId : null });
    }
  }
  syncPublic(rt);
  m.finishPlayer(rt, "dead", { lost, dropped });
}

/**
 * What happens to a carried list on death; pure apart from the rng draws (one per unique, none
 * with `noBreak`: every NPC bag, NPC.NO_BREAK — every pool item reaches the corpse).
 */
export function deathSplit(
  carried: readonly ItemLike[],
  rng: () => number,
  noBreak = false,
): { lost: ItemLike[]; dropped: ItemLike[]; remains: ItemLike[] } {
  const lost: ItemLike[] = [];
  const dropped: ItemLike[] = [];
  const remains: ItemLike[] = [];
  for (const item of carried) {
    if (item.flags & ITEM_FLAG.FREE) continue;
    if (isTrackedUnique(item)) {
      if (!noBreak && rng() < BREAK_CHANCE_ON_DEATH) {
        lost.push({ ...item, flags: item.flags | ITEM_FLAG.BROKEN });
        continue;
      }
      dropped.push(item);
    }
    remains.push(item);
  }
  return { lost, dropped, remains };
}

/**
 * Break roll per unique, then the remains (fixed order: w1 w2 armor bp p0..p3 b0..) plus the dog
 * tag become the corpse. Returns the broken uniques (`lost`) and the surviving uniques (`dropped`,
 * for the outcome screen: "left in your body").
 */
export function buildCorpse(m: Match, rt: PlayerRuntime): { lost: ItemLike[]; dropped: ItemLike[] } {
  const noBreak = NPC.NO_BREAK && rt.isNpc;
  const { lost, dropped, remains } = deathSplit(carriedItems(rt).map((c) => c.item), m.rng, noBreak);
  clearSlots(rt);
  // Guests drop no tag (WORLD v6 D22, DOG_TAG.GUEST_TAG).
  if (!rt.isNpc && (!rt.guest || DOG_TAG.GUEST_TAG)) remains.push(makeItem("junk_dogtag", { label: rt.nickname, lvl: rt.level, ref: rt.selfKey }));
  m.containers.addCorpse(rt, remains);
  return { lost, dropped };
}
