/**
 * WORLD v6 "now" for world logic on the web (orchestrator addendum A1). Outside production, env
 * WORLD_DEV_CLOCK_OFFSET_MS (integer ms, may be negative) is added, so E2E runs and demo recordings
 * can jump to a minute before entry close or the wipe; the game server's worldNow() reads the same
 * variable. In production the variable is ignored (logged once). The shared cycle math stays pure:
 * callers pass worldNow() into worldCycleAt / worldPhase.
 */
let warned = false;

export function worldClockOffsetMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.WORLD_DEV_CLOCK_OFFSET_MS?.trim();
  if (!raw) return 0;
  if (env.NODE_ENV === "production") {
    if (!warned) {
      warned = true;
      console.warn("[world/clock] WORLD_DEV_CLOCK_OFFSET_MS is ignored in production");
    }
    return 0;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** Wall-clock ms for world logic (Date.now() plus the dev offset). */
export function worldNow(): number {
  return Date.now() + worldClockOffsetMs();
}

/** worldNow() as a Date (DB timestamps of world rows, void clocks). */
export function worldDate(): Date {
  return new Date(worldNow());
}
