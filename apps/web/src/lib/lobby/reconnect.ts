/**
 * Getting a raider back on the map after a page reload or a dropped socket. The game server keeps a
 * raider who drops out of combat hidden and safe for WORLD.DISCONNECT_SHELTER_MS (Match.detach), so
 * the client should be back well inside that window, without a button press:
 * - page load: the menu joins by itself once, on its first answer, when /api/me/world says the
 *   raider is rejoinable (autoRejoinStep); the REJOIN button stays as the fallback;
 * - mid-raid socket drop: the battle screen fetches a rejoin-only ticket and reconnects a few times
 *   with backoff (reconnectDelayMs) before it shows the exit screen.
 * Pure parts here (tests: reconnect.test.ts); fetchRejoinTicket is the one network call.
 */
import type { JoinTicket, WorldJoinResponse } from "@extract/shared";
import type { RoomExit } from "../room-exit";

export const RECONNECT = {
  /** Automatic reconnects after a mid-raid socket drop before the exit screen shows. */
  MAX_TRIES: 3,
  /** Backoff of try n (1-based): BASE_MS × 2^(n−1) → 1 s, 2 s, 4 s. */
  BASE_MS: 1_000,
} as const;

export function reconnectDelayMs(attempt: number): number {
  return RECONNECT.BASE_MS * 2 ** Math.max(0, Math.floor(attempt) - 1);
}

/**
 * Reconnect by itself after the room closed on us? Only an abnormal socket close ("connection_lost":
 * not a kick, a wipe, another tab or the room's own close) while the raider is still on the map as far
 * as this client knows (no death / extract outcome yet).
 */
export function shouldAutoReconnect(exit: RoomExit | null, hadOutcome: boolean): boolean {
  return !!exit && exit.code === "connection_lost" && !hadOutcome;
}

/**
 * A failed rejoin-only POST /api/world/join: stop trying (true) or try again after the backoff.
 * Final: the raider is not on the map any more (not_on_map, in_raid), or the session is gone.
 * Network errors (status 0), 5xx, world_starting and the like are worth another try.
 */
export function rejoinFailureIsFinal(status: number, error: string): boolean {
  if (status === 401 || status === 403) return true;
  return ["not_on_map", "in_raid", "unauthenticated", "no_user", "entry_limit", "entry_closed", "guest_play_disabled"].includes(error);
}

export type AutoRejoinStep = "wait" | "join" | "skip";

/**
 * Page-load auto-rejoin, decided once per page load on the menu's first settled PLAY state:
 * "join" when it is REJOIN and the tab is visible, "wait" while loading / joining / hidden, "skip"
 * (decided: never again this load) for any other state. A raider the player left on purpose later in
 * the same page load (Leave → menu → REJOIN) is never joined by itself.
 */
export function autoRejoinStep(baseKind: string, visible: boolean): AutoRejoinStep {
  if (baseKind === "loading" || baseKind === "joining") return "wait";
  if (baseKind !== "rejoin") return "skip";
  return visible ? "join" : "wait";
}

export type RejoinTicketResult =
  | { ok: true; ticket: JoinTicket; roomId: string; matchId: string }
  | { ok: false; final: boolean; status: number; error: string };

/** POST /api/world/join { rejoinOnly: true }: a fresh ticket for the caller's active entry, never a new entry. */
export async function fetchRejoinTicket(): Promise<RejoinTicketResult> {
  let status = 0;
  let body: unknown = null;
  try {
    const res = await fetch("/api/world/join", {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rejoinOnly: true }),
    });
    status = res.status;
    body = await res.json().catch(() => null);
  } catch {
    status = 0;
  }
  const r = body as Partial<WorldJoinResponse> | null;
  if (status >= 200 && status < 300 && r && r.rejoin === true && r.ticket && typeof r.roomId === "string" && r.roomId) {
    return { ok: true, ticket: r.ticket, roomId: r.roomId, matchId: typeof r.matchId === "string" ? r.matchId : "" };
  }
  const error = typeof (body as { error?: unknown } | null)?.error === "string" ? (body as { error: string }).error : "";
  return { ok: false, final: rejoinFailureIsFinal(status, error), status, error };
}
