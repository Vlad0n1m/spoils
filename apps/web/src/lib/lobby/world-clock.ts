/**
 * Lobby clock helpers (WORLD v6 spec §6.4–§6.5). Pure: no React, no DOM, so the menu, the PLAY
 * state and the tests share one implementation.
 *
 * The browser never trusts its own clock for the world: every countdown runs on
 * `Date.now() + offset`, where the offset comes from the `serverTime` of /api/world/status (plus the
 * CDN `Age` header, since that response may be up to s-maxage seconds old), and is replaced by the
 * offset of any /api/world/join or /api/me/world response (never cached). The server's clock
 * already includes the dev offset (addendum A1), so E2E jumps reach the browser automatically.
 * Without any status the phase and countdowns still come from `worldCycleAt` on the local clock.
 */
import {
  WORLD,
  mapNumber,
  worldCycleAt,
  worldCycleOf,
  worldPhase,
  type WorldPhase,
  type WorldStatusDto,
} from "@extract/shared";

/** Seconds from an `Age` response header (missing / garbage → 0). */
export function parseAgeSec(age: string | number | null | undefined): number {
  if (age === null || age === undefined || age === "") return 0;
  const n = typeof age === "number" ? age : Number(String(age).trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Offset to add to the local clock: `serverTime + age × 1000 − localNow`. A cached status was
 * generated `age` seconds ago, so the server's clock is that much further on.
 */
export function clockOffsetMs(serverTime: number, age: string | number | null | undefined, localNow: number): number {
  if (!Number.isFinite(serverTime) || serverTime <= 0) return 0;
  return Math.round(serverTime + parseAgeSec(age) * 1000 - localNow);
}

/** Whole seconds from `now` until `at` (rounded up, never negative). */
export function secsUntil(at: number, now: number): number {
  return Math.max(0, Math.ceil((at - now) / 1000));
}

/** "m:ss" for a number of seconds ("31:12", "7:42", "0:14"). */
export function fmtClockS(secs: number): string {
  const s = Math.max(0, Math.ceil(Number.isFinite(secs) ? secs : 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Local wall time "15:00" of a wall-clock ms (`timeZone` / `locale` for tests). */
export function fmtLocalHm(ms: number, opts: { timeZone?: string; locale?: string } = {}): string {
  try {
    return new Intl.DateTimeFormat(opts.locale ?? "en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      ...(opts.timeZone ? { timeZone: opts.timeZone } : {}),
    }).format(new Date(ms));
  } catch {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
}

/** What the lobby shows about the world at `now` (status merged with the cycle clock). */
export interface WorldView {
  cycle: number;
  mapNumber: number;
  phase: WorldPhase;
  startAt: number;
  openAt: number;
  entryClosesAt: number;
  wipeAt: number;
  /**
   * When entry opens next: this cycle's openAt while resetting, the next cycle's openAt while
   * closing (and this cycle's, already past, while open).
   */
  entryOpensAt: number;
  /** The cycle an armed PLAY waits for: this one while resetting, else the next one. */
  armCycle: number;
  /** The status belongs to this cycle (humans / boss / online are current). */
  fresh: boolean;
  /** A running shard exists for this cycle; null = unknown (no status, or it is from another cycle). */
  online: boolean | null;
  /** Raiders on the map; null = unknown. */
  humans: number | null;
  capacity: number;
  /** 0..1 of the cycle elapsed. */
  elapsed: number;
  /** 0..1 position of the entry close on the cycle bar. */
  closeMark: number;
}

/**
 * The world at `now`: phase and countdowns always come from the cycle clock (`now` is already
 * server-corrected); the status only adds what the clock cannot know (online, humans, boss) and
 * only while it belongs to the current cycle.
 */
export function worldView(status: WorldStatusDto | null, now: number): WorldView {
  const wc = worldCycleAt(now);
  const phase = worldPhase(wc, now);
  const next = worldCycleOf(wc.cycle + 1);
  const fresh = status !== null && status.cycle === wc.cycle;
  return {
    cycle: wc.cycle,
    mapNumber: mapNumber(wc.cycle),
    phase,
    startAt: wc.startAt,
    openAt: wc.openAt,
    entryClosesAt: wc.entryClosesAt,
    wipeAt: wc.wipeAt,
    entryOpensAt: phase === "closing" ? next.openAt : wc.openAt,
    armCycle: phase === "resetting" ? wc.cycle : wc.cycle + 1,
    fresh,
    online: fresh ? status.online : null,
    humans: fresh ? Math.max(0, Math.floor(status.humans)) : null,
    capacity: status?.capacity ?? WORLD.CAPACITY * WORLD.MAX_SHARDS,
    elapsed: Math.min(1, Math.max(0, (now - wc.startAt) / WORLD.CYCLE_MS)),
    closeMark: (WORLD.CYCLE_MS - WORLD.ENTRY_CLOSE_MS) / WORLD.CYCLE_MS,
  };
}
