/**
 * Matchmaking guards shared by the rooms. Colyseus exposes POST /matchmake/* to everyone and
 * reserves a seat (which counts toward maxClients) before the WebSocket join, so the checks have
 * to happen before that: the static onAuth (runs before any room is found, created or reserved)
 * and _reserveSeat (runs inside the chosen room, so it can see the roster).
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { ServerError, type Room } from "@colyseus/core";
import type { JoinTicket } from "@extract/shared";
import { verifyJoinTicket } from "../auth/ticket.js";

/**
 * Process-local secret that only MatchmakingRoom passes to matchMaker.createRoom: battle rooms
 * refuse to be created without it, so a client can never create one or write its roster.
 */
export const LAUNCH_KEY = randomBytes(32).toString("hex");
const LAUNCH_KEY_BUF = Buffer.from(LAUNCH_KEY, "utf8");

export function isLaunchKey(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  const given = Buffer.from(raw, "utf8");
  return given.length === LAUNCH_KEY_BUF.length && timingSafeEqual(given, LAUNCH_KEY_BUF);
}

/** Body of the rooms' static onAuth: the verified ticket becomes the client's auth data. */
export function authenticate(options: unknown): JoinTicket {
  const ticket = verifyJoinTicket((options as { ticket?: unknown } | null)?.ticket);
  if (!ticket) throw new ServerError(401, "invalid_ticket");
  return ticket;
}

/** Room internals the seat guard touches (protected in Room, so they are reached through a cast). */
interface SeatBook {
  reservedSeats: Record<string, [unknown, unknown, boolean?, boolean?]>;
  reservedSeatTimeouts: Record<string, NodeJS.Timeout>;
  _decrementClientCount(): Promise<boolean>;
}

/**
 * One pending (not yet connected) seat per user: a newer reservation by the same user cancels the
 * older one, exactly as its timeout would. With the "second tab replaces the first" rule in onJoin
 * a user holds at most two seats, which is what maxClients is sized for.
 */
export async function releasePendingSeatsOf(room: Room, userId: string): Promise<void> {
  const book = room as unknown as SeatBook;
  for (const [sessionId, seat] of Object.entries(book.reservedSeats)) {
    const [, auth, consumed, reconnecting] = seat;
    if (consumed || reconnecting || (auth as JoinTicket | undefined)?.userId !== userId) continue;
    clearTimeout(book.reservedSeatTimeouts[sessionId]);
    delete book.reservedSeatTimeouts[sessionId];
    delete book.reservedSeats[sessionId];
    await book._decrementClientCount();
  }
}
