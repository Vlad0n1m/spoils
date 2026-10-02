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
