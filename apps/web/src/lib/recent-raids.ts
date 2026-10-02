import type { ExitType, SettledItem } from "@extract/shared";

/** Row of GET /api/matches/recent (one human's result in a settled raid). */
export interface RecentRaidRow {
  matchId: string;
  endedAt: number;
  nickname: string;
  exitType: ExitType;
  kills: number;
  extracted: SettledItem[];
  /** Humans in that raid / how many of them got out. */
  humans: number;
  humansExtracted: number;
}
