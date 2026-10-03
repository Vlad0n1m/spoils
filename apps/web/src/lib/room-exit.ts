import { CLOSE_CODES, WORLD_JOIN_ERR } from "@extract/shared";

/** What the UI tells the player when a room kicks them or refuses the join. */
export interface RoomExit {
  title: string;
  message: string;
  /** "retry" = run the join again (fresh /api/world/join + ticket); "back" = only go back to the lobby. */
  action: "retry" | "back";
  /**
   * Machine code of the reason when known: a WORLD_JOIN_ERR code ("exit_settling", "world_full", …)
   * or a close reason ("wiped", "not_in_world", "joined_elsewhere"). The menu uses it, e.g. it re-runs
   * the join after 2 s (≤ 5 times) on "exit_settling".
   */
  code?: string;
}

/** Colyseus: the client (or the room's `disconnect()`) closed the connection on purpose. */
export const WS_CLOSE_CONSENTED = 4000;
/** Colyseus: the room was disposed while the client was in it (WS_CLOSE_WITH_ERROR). */
const WS_CLOSE_WITH_ERROR = 4002;

/**
 * Splits a game-server ServerError message "<code>" or "<code>:<detail>" (WORLD_JOIN_ERR, e.g.
 * "map_mismatch:<serverHash>", "loadout_rejected:expired") into its parts.
 */
export function splitJoinError(reason: string | undefined): { code: string; detail: string } {
  const r = (reason ?? "").trim();
  const i = r.indexOf(":");
  const code = (i < 0 ? r : r.slice(0, i)).toLowerCase();
  return { code, detail: i < 0 ? "" : r.slice(i + 1) };
}

/** Why the web refused a loadout at entry (EntryRejectReason) → a short sentence. */
const LOADOUT_DETAIL: Readonly<Record<string, string>> = {
  not_locked: "Your loadout was no longer locked (unlocked in another tab).",
  wrong_user: "That loadout belongs to another account.",
  expired: "The loadout lock expired before you got in.",
  already_active: "You already have a raider on the map.",
  entry_limit: "You've used every drop-in on this map.",
  shard_closed: "This map is closed for new entries.",
};

/** Join refusals of the battle room's onAuth (WORLD_JOIN_ERR), keyed by code. */
function worldJoinExit(code: string, detail: string): RoomExit | null {
  switch (code) {
    case WORLD_JOIN_ERR.ENTRY_CLOSED:
      return { code, title: "Entry is closed", message: "Entry is closed — the next map opens soon.", action: "back" };
    case WORLD_JOIN_ERR.WORLD_FULL:
      return { code, title: "The map is full", message: "The map is full right now. Try again in a moment.", action: "retry" };
    case WORLD_JOIN_ERR.MAP_GONE:
      return { code, title: "This map just wiped", message: "This map just wiped. The next one opens in a few seconds.", action: "back" };
    case WORLD_JOIN_ERR.EXIT_SETTLING:
      return { code, title: "Settling your last raid…", message: "Settling your last raid… You can drop in again in a moment.", action: "retry" };
    case WORLD_JOIN_ERR.IN_RAID:
      return {
        code,
        title: "Already on a map",
        message: "Your raider is still on another map. It settles shortly after that map wipes.",
        action: "back",
      };
    case WORLD_JOIN_ERR.ENTRY_LIMIT:
      return { code, title: "No drop-ins left", message: "You've dropped into this map 4 times. Wait for the next map.", action: "back" };
    case WORLD_JOIN_ERR.WEB_UNAVAILABLE:
      return { code, title: "Server busy", message: "The game server couldn't reach the account service. Try again.", action: "retry" };
    case WORLD_JOIN_ERR.LOADOUT_REJECTED:
      return {
        code,
        title: "Loadout not locked",
        message: `${LOADOUT_DETAIL[detail] ?? "Your loadout couldn't be locked for this map."} Your gear stayed in the stash. Try again to re-lock it.`,
        action: "retry",
      };
    case WORLD_JOIN_ERR.MAP_MISMATCH:
      return {
        code,
        title: "Update needed",
        message: "Your game files are out of date with the server's map. Reload the page and try again.",
        action: "back",
      };
    case WORLD_JOIN_ERR.INVALID_TICKET:
      return { code, title: "Join ticket expired", message: "Your ticket to this map is no longer valid. Try again.", action: "retry" };
    default:
      return null;
  }
}

/**
 * Maps a room close code / ServerError code (and the reason string the game server sends with
 * it, e.g. "entry_closed" or "loadout_rejected:expired") to a player-facing message. Returns null
 * for a normal close that needs no explanation (consented leave, normal WebSocket close, the
 * wipe close after the player already has an outcome — pass `hadOutcome`).
 */
export function describeRoomExit(code: number | undefined, reason?: string, opts: { hadOutcome?: boolean } = {}): RoomExit | null {
  const { code: r, detail } = splitJoinError(reason);
  if (code === CLOSE_CODES.WIPED || r === "wiped") {
    // The normal end of a map: with a result on screen there is nothing to explain.
    if (opts.hadOutcome) return null;
    return {
      code: "wiped",
      title: "The map wiped",
      message: "The map wiped. Anyone still on it was caught in the wipe.",
      action: "back",
    };
  }
  if (code === CLOSE_CODES.JOINED_ELSEWHERE || r === "joined_elsewhere") {
    return {
      code: "joined_elsewhere",
      title: "You joined from another tab",
      message: "This raider connected again from another tab or device, so this tab was disconnected.",
      action: "back",
    };
  }
  if (code === CLOSE_CODES.NOT_IN_WORLD || r === "not_in_world") {
    return {
      code: "not_in_world",
      title: "You're not on this map",
      message: "Your raider is no longer on this map. Drop in again from the menu.",
      action: "back",
    };
  }
  const world = worldJoinExit(r, detail);
  if (world) return world;
  // Legacy close code (a pre-v6 server): the loadout lock was released.
  if (code === CLOSE_CODES.LOADOUT_REJECTED) return worldJoinExit(WORLD_JOIN_ERR.LOADOUT_REJECTED, detail);
  if (code === undefined || code === WS_CLOSE_CONSENTED || code === 1000) return null;
  if (code === WS_CLOSE_WITH_ERROR) {
    return {
      title: "The room closed",
      message: "The game server closed the map unexpectedly. Try again.",
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
