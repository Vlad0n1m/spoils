import type { JoinTicket } from "@extract/shared";

/**
 * /play stages (WORLD v6): the main menu, or a battle on the live map. There is no matchmaking
 * stage any more; an armed PLAY waiting for the next map lives in the menu's local state.
 * `roomId` is the shard's Colyseus room (joinById), `cycle` the map it belongs to.
 */
export type PlayStage =
  | { kind: "menu" }
  | { kind: "battle"; ticket: JoinTicket; roomId: string; cycle: number };

const MENU: PlayStage = { kind: "menu" };

/**
 * The stage to render for the signed-in user. A raid started under another account (or before
 * signing out) carries that account's signed ticket, so it must never resume for whoever is
 * signed in now: it falls back to the menu instead.
 */
export function stageForUser(stage: PlayStage, userId: string | null | undefined): PlayStage {
  if (stage.kind === "menu") return stage;
  return userId && stage.ticket.userId === userId ? stage : MENU;
}
