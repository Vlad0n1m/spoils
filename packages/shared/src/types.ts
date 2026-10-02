import type { ExitType, ItemRef } from "./protocol.js";

export interface MatchSettlementParticipant {
  /** null for bots. */
  userId: string | null;
  nickname: string;
  isBot: boolean;
  exitType: ExitType;
  kills: number;
  extracted: ItemRef[];
  lost: ItemRef[];
}

/** Game server → web API (HMAC-signed) when a match ends. */
export interface MatchSettlementPayload {
  matchId: string;
  mapSeed: number;
  startedAt: number;
  endedAt: number;
  participants: MatchSettlementParticipant[];
  /**
   * Valuable items still on the map at the end: on the ground (dropped by the dead, swapped out)
   * or inside unopened chests. In the economy they go to the lost pool (docs/GAME_DESIGN.md §5, §7).
   */
  leftOnMap: ItemRef[];
}

/**
 * Issued by the web API (POST /api/matches/join) and verified by the game server in onAuth.
 * `sig` = hex HMAC-SHA256 over `${userId}.${nickname}.${issuedAt}` with GAME_SERVER_HMAC_SECRET.
 */
export interface JoinTicket {
  userId: string;
  nickname: string;
  issuedAt: number;
  sig: string;
}

/** Payload string that a JoinTicket signature covers. */
export function joinTicketPayload(t: Pick<JoinTicket, "userId" | "nickname" | "issuedAt">): string {
  return `${t.userId}.${t.nickname}.${t.issuedAt}`;
}
