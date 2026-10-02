import { createHmac } from "node:crypto";
import { joinTicketPayload, type JoinTicket } from "@extract/shared";
import { coreEnv } from "@/lib/env";

/**
 * Server-only (node:crypto + the shared HMAC secret): the game server trusts a player's identity
 * only through this signature, so the secret must never reach the client bundle.
 */
export function signJoinTicket(who: { userId: string; nickname: string; loadoutId: string }): JoinTicket {
  // loadoutId "" = free kit (guests, empty loadout); it is signed so a ticket cannot be re-pointed
  // at someone else's locked gear.
  const unsigned = { userId: who.userId, nickname: who.nickname, issuedAt: Date.now(), loadoutId: who.loadoutId };
  const sig = createHmac("sha256", coreEnv().GAME_SERVER_HMAC_SECRET)
    .update(joinTicketPayload(unsigned))
    .digest("hex");
  return { ...unsigned, sig };
}
