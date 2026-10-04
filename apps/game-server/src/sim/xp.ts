/**
 * In-raid XP (HUD estimate): whenever the server counts an XP action for a human — a container
 * searched past its open delay (containers.ts countSearch), a marauder / guard / boss / ranked-looking
 * PvP kill (death.ts) — it adds raidXpGain to SelfState.raidXp (owner-only) and emits a personal
 * `xp` event for the "+N XP" popup. Guests earn no XP at all (the web skips them), so they get
 * neither. The web still settles the real XP at exit (xpForExit: daily cap, ranked-PvP checks).
 */

import { XP, raidXpGain, type RaidXpKey } from "@extract/shared";
import type { Match } from "./match.js";
import type { PlayerRuntime } from "./types.js";

/** Add one counted action of line `k` (`count` = the entry's count of that line after it). */
export function creditRaidXp(m: Match, rt: PlayerRuntime, k: RaidXpKey, count: number, hot = false): void {
  if (rt.isNpc || rt.guest) return;
  const xp = raidXpGain(k, count, hot);
  if (xp > 0) rt.self.raidXp = Math.min(0xffff, rt.self.raidXp + xp);
  m.emit({ type: "xp", to: rt.rosterIndex, msg: { k, xp, n: count } });
}

/**
 * Would the web likely rank this PvP kill (XP.PVP)? What the server can know: a registered victim
 * of at least XP.PVP_VICTIM_MIN_LEVEL, and at most XP.PVP_PAIR_PER_DAY kills of that victim in this
 * entry (`victims` already holds this kill). Account age and the daily limits are the web's.
 */
export function pvpLikelyRanked(killer: PlayerRuntime, victim: PlayerRuntime): boolean {
  if (victim.isNpc || victim.guest || !victim.userId || victim.level < XP.PVP_VICTIM_MIN_LEVEL) return false;
  let pair = 0;
  for (const v of killer.victims) if (v === victim.userId) pair++;
  return pair <= XP.PVP_PAIR_PER_DAY;
}
