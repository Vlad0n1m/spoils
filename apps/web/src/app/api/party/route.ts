import { db } from "@/db/client";
import { json } from "@/lib/lobby/route-helpers";
import { getPartyState } from "@/lib/social/party";
import { socialCaller } from "@/lib/social/route";
import { worldNow } from "@/lib/world/clock";

export const dynamic = "force-dynamic";

/**
 * The menu's social poll (PartyStateDto): the caller's party, invites to them, the party's live drop
 * ("Leader is dropping in"), incoming friend requests; also the presence heartbeat. Polled every
 * PARTY.POLL_MS in a party, PARTY.IDLE_POLL_MS otherwise. Private, no-store.
 */
export async function GET() {
  const who = await socialCaller({ limit: false });
  if ("res" in who) return who.res;
  return json(await getPartyState(db, who.userId, worldNow()));
}
