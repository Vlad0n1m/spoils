/**
 * WebSocket close codes the rooms use when kicking a client. Kept above 4100: Colyseus reserves
 * 4000–4010 (e.g. 4002 = WS_CLOSE_WITH_ERROR), and the client tells these apart to show a reason.
 */
export const CLOSE = {
  /** Battle: the ticket's user is not in this match's roster. */
  NOT_IN_ROSTER: 4101,
  /** Matchmaking: the queue already launched its battle. */
  QUEUE_CLOSED: 4102,
  /** The same user connected again from another tab / device; the old connection is dropped. */
  JOINED_ELSEWHERE: 4103,
  /** Matchmaking: the battle room could not be created. */
  LAUNCH_FAILED: 4150,
} as const;
