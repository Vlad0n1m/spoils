/**
 * Death (critique "Durability semantics and death wear", inventory memo §2.4):
 * - every non-FREE unique breaks with BREAK_CHANCE_ON_DEATH: flagged BROKEN, NOT put into the
 *   corpse, resolved as `lost` and reported in PlayerExitReport.lost (web: → lost pool at −8 dur);
 * - survivors keep their durability (and magazine) and stay in the corpse for others;
 * - fungibles (ammo, meds, junk) never break; FREE items vanish;
 * - every human corpse holds a dog tag (label = nickname, lvl = level, ref = self key → the victim
 *   userId in reports), so it has to be searched for; bots leave none (no bot farming).
 * Nothing is scattered on the ground: the body is a searchable Corpse (state.corpses, AOI-filtered)
 * whose contents go through the searchers' loot entry k<id> (containers.ts).
 */

import { BREAK_CHANCE_ON_DEATH, ITEM_FLAG, SoundKind, type ItemLike, type WeaponId } from "@extract/shared";
import { cancelHeal, cancelReload } from "./actions.js";
import { carriedItems, clearSlots, syncPublic } from "./bag.js";
import { closeSearch } from "./containers.js";
import { isTrackedUnique, makeItem } from "./items.js";
import type { Match } from "./match.js";
import { emitSound } from "./sound.js";
import type { PlayerRuntime } from "./types.js";

export function killPlayer(m: Match, rt: PlayerRuntime, killer: PlayerRuntime | null, weapon: WeaponId | ""): void {
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
    killer.self.kills = Math.min(255, killer.self.kills + 1);
    rt.killedBy = killer.nickname;
    // A bullet still in flight can kill after its shooter already extracted or died: keep their
    // frozen result in line and resend it.
    if (killer.exitReport) killer.exitReport.kills = killer.self.kills;
    if (killer.outcome) {
      killer.outcome = { ...killer.outcome, kills: killer.self.kills };
      if (!killer.isBot) m.emit({ type: "outcome", to: killer.rosterIndex, msg: killer.outcome });
    }
  }
  const { lost, dropped } = buildCorpse(m, rt);
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
  emitSound(m, rt, SoundKind.death, p.x, p.y);
  syncPublic(rt);
  m.finishPlayer(rt, "dead", { lost, dropped });
}

/** What happens to a carried list on death; pure apart from the rng draws (one per unique). */
export function deathSplit(
  carried: readonly ItemLike[],
  rng: () => number,
): { lost: ItemLike[]; dropped: ItemLike[]; remains: ItemLike[] } {
  const lost: ItemLike[] = [];
  const dropped: ItemLike[] = [];
  const remains: ItemLike[] = [];
  for (const item of carried) {
    if (item.flags & ITEM_FLAG.FREE) continue;
    if (isTrackedUnique(item)) {
      if (rng() < BREAK_CHANCE_ON_DEATH) {
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
  const { lost, dropped, remains } = deathSplit(carriedItems(rt).map((c) => c.item), m.rng);
  clearSlots(rt);
  if (!rt.isBot) remains.push(makeItem("junk_dogtag", { label: rt.nickname, lvl: rt.level, ref: rt.selfKey }));
  m.containers.addCorpse(rt, remains);
  return { lost, dropped };
}
