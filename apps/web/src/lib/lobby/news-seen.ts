/**
 * Per-viewer "seen" markers of the menu (WORLD v6 spec §6.4–§6.6), in browser storage. Every read
 * and write is wrapped: private windows and blocked storage throw, and the menu must work without
 * it (the News dot then stays lit until the panel is opened, the last-raid card shows once per
 * page load). Never used for state that must persist reliably.
 */

const NEWS_KEY = "spoils.news.seen";
const LAST_RAID_KEY = "spoils.lastRaidSeen";
const ARMED_KEY = "spoils.armed";

type Kind = "local" | "session";

function store(kind: Kind): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

export function storageGet(kind: Kind, key: string): string | null {
  try {
    return store(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function storageSet(kind: Kind, key: string, value: string | null): void {
  try {
    const s = store(kind);
    if (!s) return;
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
  } catch {
    /* storage unavailable: the marker is per page load only */
  }
}

export interface NewsSeen {
  /** Id of the newest patch note the viewer opened. */
  patch: string | null;
  /** Wall ms of the newest world event the viewer saw. */
  event: number;
}

export function parseNewsSeen(raw: string | null): NewsSeen | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<NewsSeen> | null;
    if (!v || typeof v !== "object") return null;
    return {
      patch: typeof v.patch === "string" ? v.patch : null,
      event: typeof v.event === "number" && Number.isFinite(v.event) ? v.event : 0,
    };
  } catch {
    return null;
  }
}

export function readNewsSeen(): NewsSeen | null {
  return parseNewsSeen(storageGet("local", NEWS_KEY));
}

export function writeNewsSeen(s: NewsSeen): void {
  storageSet("local", NEWS_KEY, JSON.stringify(s));
}

/**
 * The News dot: a patch note the viewer has not opened, or a boss event newer than the last visit.
 * Nothing stored yet → lit while there is anything to read.
 */
export function hasUnseenNews(seen: NewsSeen | null, latestPatchId: string | null, latestEventAt: number | null): boolean {
  if (latestPatchId && latestPatchId !== (seen?.patch ?? null)) return true;
  return latestEventAt !== null && latestEventAt > (seen?.event ?? 0);
}

export function readLastRaidSeen(): string | null {
  return storageGet("local", LAST_RAID_KEY);
}

export function writeLastRaidSeen(entryId: string): void {
  storageSet("local", LAST_RAID_KEY, entryId);
}

/** The cycle an armed PLAY waits for (session storage: a reload keeps it, closing the tab drops it). */
export function readArmedCycle(): number | null {
  const raw = storageGet("session", ARMED_KEY);
  const n = raw === null ? NaN : Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function writeArmedCycle(cycle: number | null): void {
  storageSet("session", ARMED_KEY, cycle === null ? null : String(cycle));
}
