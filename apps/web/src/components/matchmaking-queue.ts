/**
 * Humans-only queue view (NPC MODEL v5) for the matchmaking panel. Pure: no React, no DOM.
 *
 * The "mm" queue holds real players only. A window (MATCH.QUEUE_WINDOW_MS) opens on the first join;
 * the raid launches at once with MATCH.MAX_HUMANS, early with MATCH.MIN_HUMANS once MIN_WAIT_MS has
 * passed, else when the window ends with whoever is queued (a solo raid against NPCs is legal).
 * Nothing fills empty seats: NPCs are already on the map and never count as players.
 */

import { MATCH } from "@extract/shared";

export interface QueueView {
  /** Humans in the queue (MmState.queued). */
  players: number;
  /** Server wall-clock ms the window opened (MmState.startedAt), 0 = unknown. */
  openedAt: number;
  /** Server wall-clock ms the window ends (MmState.deadlineAt). */
  deadlineAt: number;
  launching: boolean;
}

/** A deadline further out than this is a skewed clock or a bogus value: use the local fallback. */
const MAX_AHEAD_MS = MATCH.QUEUE_WINDOW_MS * 4;

/**
 * Reads the matchmaking room's state loosely (its schema belongs to the game server): a renamed or
 * missing field degrades the countdown instead of breaking the lobby.
 */
export function readQueueState(state: unknown, fallbackDeadline: number, now = Date.now()): QueueView {
  const s = (state ?? {}) as Record<string, unknown>;
  // MmState.queued (the count is all the server syncs); older servers synced the players list.
  const list = s.players as { length?: number; size?: number } | undefined;
  const players =
    typeof s.queued === "number" ? s.queued : typeof list?.length === "number" ? list.length : typeof list?.size === "number" ? list.size : 0;
  const raw = typeof s.deadlineAt === "number" ? s.deadlineAt : 0;
  const sane = raw > now - 10_000 && raw < now + MAX_AHEAD_MS;
  const opened = typeof s.startedAt === "number" && s.startedAt > now - MAX_AHEAD_MS && s.startedAt <= now + 10_000 ? s.startedAt : 0;
  const status = typeof s.status === "string" ? s.status : "waiting";
  return {
    players,
    openedAt: opened,
    deadlineAt: sane ? raw : fallbackDeadline,
    launching: status === "starting" || status === "started",
  };
}

export interface QueueStatus {
  /** Humans shown (at least 1: you), at most MATCH.MAX_HUMANS. */
  humans: number;
  max: number;
  /** Wall-clock ms the raid is expected to launch. */
  launchAt: number;
  /** Seconds to launchAt (0 = launching now). */
  secsLeft: number;
  /** "0:32". */
  countdown: string;
  /** Launch comes early because MIN_HUMANS are in. */
  early: boolean;
  launching: boolean;
  /** Only you so far: the raid starts solo against NPCs if nobody joins. */
  solo: boolean;
}

/** "m:ss" for a non-negative number of seconds. */
export function fmtQueueClock(secs: number): string {
  const s = Math.max(0, Math.ceil(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Expected launch and countdown under the queue rules (MATCH / mmShouldLaunch). */
export function queueStatus(v: QueueView, now: number): QueueStatus {
  const max = MATCH.MAX_HUMANS;
  const humans = Math.max(1, Math.min(max, v.players));
  let launchAt = v.deadlineAt;
  let early = false;
  if (humans >= max) {
    launchAt = now;
    early = true;
  } else if (humans >= MATCH.MIN_HUMANS) {
    const opened = v.openedAt > 0 ? v.openedAt : v.deadlineAt - MATCH.QUEUE_WINDOW_MS;
    const at = Math.max(now, opened + MATCH.MIN_WAIT_MS);
    if (at < launchAt) {
      launchAt = at;
      early = true;
    }
  }
  const secsLeft = Math.max(0, Math.ceil((launchAt - now) / 1000));
  return {
    humans,
    max,
    launchAt,
    secsLeft,
    countdown: fmtQueueClock(secsLeft),
    early,
    launching: v.launching || secsLeft === 0,
    solo: humans === 1,
  };
}

/** "Players in queue: 3 · launching in 0:32". Never mentions bots: there are none. */
export function queueLine(st: Pick<QueueStatus, "humans" | "countdown" | "launching">): string {
  return st.launching ? `Players in queue: ${st.humans} · launching now` : `Players in queue: ${st.humans} · launching in ${st.countdown}`;
}
