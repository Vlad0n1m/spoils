import type { JoinTicket } from "@extract/shared";

export type PlayStage =
  | { kind: "lobby" }
  | { kind: "matchmaking"; ticket: JoinTicket; roomName: string; searchId: number }
  | { kind: "battle"; ticket: JoinTicket; battleRoomId: string };

const LOBBY: PlayStage = { kind: "lobby" };

/**
 * The stage to render for the signed-in user. A search or raid started under another account (or
 * before signing out) carries that account's signed ticket, so it must never resume for whoever
 * is signed in now: it falls back to the lobby instead.
 */
export function stageForUser(stage: PlayStage, userId: string | null | undefined): PlayStage {
  if (stage.kind === "lobby") return stage;
  return userId && stage.ticket.userId === userId ? stage : LOBBY;
}
