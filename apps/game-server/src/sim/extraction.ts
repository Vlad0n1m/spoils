/**
 * Extraction points and the end-of-match timeout.
 * An extract is open when clock >= openAt and (closeAt == 0 or clock < closeAt), and usable by a
 * player when its bit is set in SelfState.extractMask (bit i = MapData.extracts[i]; WP-M2 makes the
 * mask side-based). Standing with the player centre inside an open circle for
 * MATCH.EXTRACT_CHANNEL_MS takes the player off the map with everything non-FREE they carry.
 * Leaving resets the channel; damage restarts it (combat.ts).
 */

import { ITEM_FLAG, MATCH, SOUND, SoundKind, type Extract, type ItemLike } from "@extract/shared";
import { cancelHeal, cancelReload } from "./actions.js";
import { carriedItems, clearSlots, syncPublic } from "./bag.js";
import { closeSearch } from "./containers.js";
import type { Match } from "./match.js";
import { emitSound } from "./sound.js";
import type { PlayerRuntime } from "./types.js";

export function extractIsOpen(e: Extract, clock: number): boolean {
  return clock >= e.openAt && (e.closeAt === 0 || clock < e.closeAt);
}

/**
 * May this player use extract `e`? NPCs never extract; extracts outside MapData (tests) are always
 * allowed. WORLD v6 (D8): a player's extracts arm SelfState.extractArmAt after their own entry
 * (0 for legacy roster humans).
 */
export function extractAllowed(m: Match, rt: PlayerRuntime, e: Extract): boolean {
  if (rt.isNpc || m.clock < rt.self.extractArmAt) return false;
  const bit = m.extractBit.get(e.id);
  return bit === undefined || (rt.self.extractMask & (1 << bit)) !== 0;
}

export function openExtractAt(m: Match, rt: PlayerRuntime, x: number, y: number): Extract | null {
  for (const e of m.state.extracts.values()) {
    if (!extractIsOpen(e, m.clock) || !extractAllowed(m, rt, e)) continue;
    const dx = x - e.x;
    const dy = y - e.y;
    if (dx * dx + dy * dy <= e.r * e.r) return e;
  }
  return null;
}

export function stepExtraction(m: Match): void {
  for (const rt of m.allRuntimes()) {
    const p = rt.pub;
    if (!p.alive) continue;
    const s = rt.self;
    const e = openExtractAt(m, rt, p.x, p.y);
    if (!e) {
      if (s.extractId !== "") s.extractId = "";
      if (s.extractStartedAt !== 0) s.extractStartedAt = 0;
      continue;
    }
    if (s.extractId !== e.id) {
      s.extractId = e.id;
      s.extractStartedAt = m.clock;
      rt.nextExtractSoundAt = m.clock;
    }
    if (m.clock >= rt.nextExtractSoundAt) {
      emitSound(m, rt, SoundKind.extract, p.x, p.y);
      rt.nextExtractSoundAt = m.clock + SOUND.EXTRACT_REPEAT_MS;
    }
    if (m.clock - s.extractStartedAt >= MATCH.EXTRACT_CHANNEL_MS) extractPlayer(m, rt);
  }
}

function leaveMap(m: Match, rt: PlayerRuntime): void {
  const s = rt.self;
  rt.pub.alive = false;
  s.extractStartedAt = 0;
  s.extractId = "";
  cancelReload(rt);
  cancelHeal(rt);
  closeSearch(m, rt, "left");
  rt.queue.length = 0;
  rt.pendingThrow = null;
  rt.triggerHeld = false;
  rt.pressPending = false;
}

/** Everything non-FREE the player carries (FREE kit never leaves the raid). */
function nonFree(rt: PlayerRuntime): ItemLike[] {
  return carriedItems(rt).map((c) => c.item).filter((it) => !(it.flags & ITEM_FLAG.FREE));
}

export function extractPlayer(m: Match, rt: PlayerRuntime): void {
  if (!rt.pub.alive) return;
  const extracted = nonFree(rt);
  leaveMap(m, rt);
  rt.self.extractedAt = m.clock;
  clearSlots(rt);
  syncPublic(rt);
  m.finishPlayer(rt, "extract", { extracted });
}

/**
 * Match over: whoever is still on the map loses everything they carry (GDD §6). Legacy roster
 * matches: "timeout"; WORLD v6 wipe: "mia" (D9, the same soft rule: everything to the pool, no wear).
 */
export function timeoutPlayer(m: Match, rt: PlayerRuntime, exit: "timeout" | "mia" = "timeout"): void {
  if (!rt.pub.alive) return;
  const lost = nonFree(rt);
  leaveMap(m, rt);
  clearSlots(rt);
  syncPublic(rt);
  m.finishPlayer(rt, exit, { lost });
}
