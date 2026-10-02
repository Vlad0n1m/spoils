import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { signJoinTicket } from "@/lib/join-ticket";

export const dynamic = "force-dynamic";

/** Colyseus matchmaking room name registered by the game server. */
const MATCHMAKING_ROOM = "mm";

/**
 * Issues a signed join ticket for the demo raid. No stake is debited in this phase: everyone drops
 * with the free kit, so the ticket only proves who the player is.
 */
export async function POST() {
  const session = await getSession();
  if (!session.userId || !session.nickname) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const ticket = signJoinTicket({ userId: session.userId, nickname: session.nickname });
  return NextResponse.json({ ticket, roomName: MATCHMAKING_ROOM });
}
