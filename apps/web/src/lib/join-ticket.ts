import { createHmac } from "node:crypto";
import { joinTicketPayload, type JoinTicket } from "@extract/shared";
import { coreEnv } from "./env";

/**
 * Server-only (node:crypto + the shared HMAC secret): the game server trusts a player's identity
 * only through this signature, so the secret must never reach the client bundle.
 *
 * WORLD v6: a world ticket also carries the shard (`matchId`) and the entry minted at join
 * (`entryId`); both are covered by the signature (joinTicketPayload), so a ticket cannot be
 * re-pointed at another shard or entry. Legacy tickets leave both out (signed as "").
 */
export function signJoinTicket(who: {
  userId: string;
  nickname: string;
  loadoutId: string;
  matchId?: string;
  entryId?: string;
  /** Party (party.ts): signed after the WORLD v6 fields; absent for solo joins. */
  dropId?: string;
  partyId?: string;
}): JoinTicket {
  // loadoutId "" = free kit (guests, empty loadout); it is signed so a ticket cannot be re-pointed
  // at someone else's locked gear. issuedAt is real wall time (ticket freshness, not world logic).
  const unsigned: Omit<JoinTicket, "sig"> = {
    userId: who.userId,
    nickname: who.nickname,
    issuedAt: Date.now(),
    loadoutId: who.loadoutId,
  };
  if (who.matchId) unsigned.matchId = who.matchId;
  if (who.entryId) unsigned.entryId = who.entryId;
  if (who.partyId) {
    unsigned.partyId = who.partyId;
    if (who.dropId) unsigned.dropId = who.dropId;
  }
  const sig = createHmac("sha256", coreEnv().GAME_SERVER_HMAC_SECRET)
    .update(joinTicketPayload(unsigned))
    .digest("hex");
  return { ...unsigned, sig };
}
