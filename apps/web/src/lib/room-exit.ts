import { CLOSE_CODES } from "@extract/shared";

/** What the UI tells the player when a room kicks them or refuses the join. */
export interface RoomExit {
  title: string;
  message: string;
  /** "retry" = start a new search (fresh ticket); "back" = only go back to the lobby. */
  action: "retry" | "back";
}

/** Colyseus: the client (or the room's `disconnect()`) closed the connection on purpose. */
export const WS_CLOSE_CONSENTED = 4000;
/** Colyseus: the room was disposed while the client was in it (WS_CLOSE_WITH_ERROR). */
const WS_CLOSE_WITH_ERROR = 4002;

/**
 * Maps a room close code / ServerError code (and the reason string the game server sends with
 * it, e.g. "queue_closed") to a player-facing message. Returns null for a normal close that needs
 * no explanation (consented leave, normal WebSocket close).
 */
export function describeRoomExit(code: number | undefined, reason?: string): RoomExit | null {
  const r = (reason ?? "").toLowerCase();
  if (code === CLOSE_CODES.JOINED_ELSEWHERE || r === "joined_elsewhere") {
    return {
      title: "You joined from another tab",
      message: "This raider connected again from another tab or device, so this tab was disconnected.",
      action: "back",
    };
  }
  if (code === CLOSE_CODES.QUEUE_CLOSED || r === "queue_closed") {
    return {
      title: "This raid already started",
      message: "The lobby launched its raid before you got in. Find another one — it only takes a moment.",
      action: "retry",
    };
  }
  if (code === CLOSE_CODES.LAUNCH_FAILED || r === "launch_failed") {
    return {
      title: "The raid couldn't start",
      message: "The server failed to create the raid. Try again.",
      action: "retry",
    };
  }
  if (code === CLOSE_CODES.NOT_IN_ROSTER || r === "not_in_roster") {
    return {
      title: "You're not in this raid",
      message: "This raid was formed without you. Start a new search from the lobby.",
      action: "back",
    };
  }
  if (code === CLOSE_CODES.LOADOUT_REJECTED || r === "loadout_rejected") {
    return {
      title: "Loadout not locked",
      message:
        "Your loadout was no longer locked for this raid (unlocked in another tab, or the lock expired), so your gear stayed in the stash. Try again to re-lock it and find a new raid.",
      action: "retry",
    };
  }
  if (r === "invalid_ticket") {
    return {
      title: "Join ticket expired",
      message: "Your ticket to this raid is no longer valid. Start a new search from the lobby.",
      action: "retry",
    };
  }
  if (code === undefined || code === WS_CLOSE_CONSENTED || code === 1000) return null;
  if (code === WS_CLOSE_WITH_ERROR) {
    return {
      title: "The room closed",
      message: "The game server closed the room unexpectedly. Try again.",
      action: "retry",
    };
  }
  return {
    title: "Connection lost",
    message: `Lost the connection to the game server (code ${code}). Check your network and try again.`,
    action: "retry",
  };
}

/** Code + message of an error thrown by colyseus.js (ServerError on join, network errors, …). */
export function errorCodeAndReason(e: unknown): { code: number | undefined; reason: string } {
  if (e && typeof e === "object") {
    const code = (e as { code?: unknown }).code;
    const message = (e as { message?: unknown }).message;
    return {
      code: typeof code === "number" ? code : undefined,
      reason: typeof message === "string" ? message : "",
    };
  }
  return { code: undefined, reason: typeof e === "string" ? e : "" };
}
