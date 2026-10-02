export type Phase = "lockin" | "open" | "ended";

export type ExitType = "extract" | "dead" | "timeout";

export interface MatchSettlementParticipant {
  userId: string | null;
  isBot: boolean;
  entryCents: string;
  payoutCents: string;
  deltaCents: string;
  exitType: ExitType;
  exitOrder: number | null;
}

export interface MatchSettlementPayload {
  matchId: string;
  entryTierCents: string;
  startedAt: number;
  endedAt: number;
  participants: MatchSettlementParticipant[];
}

/** HMAC from game server when a human extracts — credit balance immediately; final settle trues up the delta. */
export interface MatchExtractInstantPayload {
  matchId: string;
  userId: string;
  payoutCents: string;
}

/** Sent to one client right after death or extract (before match `settled`). Extract payout uses extractors count *so far*; final totals may change if more players extract. */
export interface PlayerOutcomePayload {
  matchId: string;
  userId: string;
  entryCents: string;
  payoutCents: string;
  deltaCents: string;
  exitType: ExitType;
  exitOrder: number | null;
  provisional: boolean;
  totalExtractorsSoFar: number;
}

export interface MatchmakingJoinTicket {
  userId: string;
  nickname: string;
  entryTierCents: string;
  issuedAt: number;
  signature: string;
}
