/**
 * The lobby's poll schedule, free of React so it can be tested (use-world.ts wraps it in a hook).
 *
 * - `start()` (mount, or another account) fetches once right away, visible or not: a tab the
 *   browser treats as hidden (background tab, some embedded webviews, headless) must still get its
 *   first answer, or the menu would wait on "PLAY…" forever.
 * - The interval only runs while `active` (tab visible and no battle running).
 * - Turning active again (visibilitychange → visible, battle over) fetches right away unless the
 *   last fetch is fresher than `minGapMs` (so mount + first activation do not double-fetch).
 */
export interface PollerTimers {
  now: () => number;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (id: unknown) => void;
}

export const POLL_MIN_GAP_MS = 3_000;

const realTimers: PollerTimers = {
  now: () => Date.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
};

export class Poller {
  private timer: unknown = null;
  private active = false;
  private lastAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly fn: () => void,
    private readonly ms: number,
    private readonly timers: PollerTimers = realTimers,
    private readonly minGapMs = POLL_MIN_GAP_MS,
  ) {}

  /** First fetch for this mount / account, regardless of visibility. */
  start(): void {
    this.fire();
  }

  /** Visible-and-in-menu flag; the interval runs only while true. */
  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    if (!active) {
      this.stopTimer();
      return;
    }
    if (this.timers.now() - this.lastAt >= this.minGapMs) this.fire();
    this.timer = this.timers.setInterval(() => this.fire(), this.ms);
  }

  /** Record a fetch made outside the schedule (a manual reload). */
  markFetched(): void {
    this.lastAt = this.timers.now();
  }

  dispose(): void {
    this.active = false;
    this.stopTimer();
  }

  private fire(): void {
    this.lastAt = this.timers.now();
    this.fn();
  }

  private stopTimer(): void {
    if (this.timer !== null) this.timers.clearInterval(this.timer);
    this.timer = null;
  }
}
