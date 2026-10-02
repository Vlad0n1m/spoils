/**
 * Extraction points and the end-of-match timeout.
 * An extract is open when clock >= openAt and (closeAt == 0 or clock < closeAt). Standing with the
 * player center inside an open circle for MATCH.EXTRACT_CHANNEL_MS takes the player off the map
 * with everything valuable they carry. Leaving resets the channel; damage restarts it (combat.ts).
 */

import { MATCH, type Extract, type Player } from "@extract/shared";
import { cancelHeal, cancelReload } from "./actions.js";
import { carriedRefs } from "./inventory.js";
import type { Match } from "./match.js";
import type { PlayerRuntime } from "./types.js";

export function extractIsOpen(e: Extract, clock: number): boolean {
  return clock >= e.openAt && (e.closeAt === 0 || clock < e.closeAt);
}

export function openExtractAt(m: Match, x: number, y: number): Extract | null {
  for (const e of m.state.extracts.values()) {
    if (!extractIsOpen(e, m.clock)) continue;
    const dx = x - e.x;
    const dy = y - e.y;
    if (dx * dx + dy * dy <= e.r * e.r) return e;
  }
  return null;
}

export function stepExtraction(m: Match): void {
  for (const p of [...m.state.players.values()]) {
    if (!p.alive) continue;
    const e = openExtractAt(m, p.x, p.y);
    if (!e) {
      p.extractId = "";
      p.extractStartedAt = 0;
      continue;
    }
    if (p.extractId !== e.id) {
      p.extractId = e.id;
      p.extractStartedAt = m.clock;
      continue;
    }
    if (m.clock - p.extractStartedAt >= MATCH.EXTRACT_CHANNEL_MS) {
      const rt = m.runtime(p.sessionId);
      if (rt) extractPlayer(m, rt, p);
    }
  }
}

function leaveMap(rt: PlayerRuntime, p: Player): void {
  p.alive = false;
  p.extractStartedAt = 0;
  p.extractId = "";
  cancelReload(p);
  cancelHeal(p);
  rt.queue.length = 0;
  rt.triggerHeld = false;
  rt.pressPending = false;
}

export function extractPlayer(m: Match, rt: PlayerRuntime, p: Player): void {
  if (!p.alive) return;
  rt.extracted.push(...carriedRefs(p));
  leaveMap(rt, p);
  p.extractedAt = m.clock;
  m.finishPlayer(rt, "extract");
}

/** Match over: whoever is still on the map loses everything valuable they carry. */
export function timeoutPlayer(m: Match, rt: PlayerRuntime, p: Player): void {
  if (!p.alive) return;
  rt.lost.push(...carriedRefs(p));
  leaveMap(rt, p);
  m.finishPlayer(rt, "timeout");
}
