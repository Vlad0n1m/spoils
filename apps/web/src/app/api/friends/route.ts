import { db } from "@/db/client";
import { json } from "@/lib/lobby/route-helpers";
import { listFriends } from "@/lib/social/friends";
import { socialCaller } from "@/lib/social/route";
import { worldNow } from "@/lib/world/clock";

export const dynamic = "force-dynamic";

/** The caller's friends with presence, incoming and outgoing requests (FriendsDto). Private, no-store. */
export async function GET() {
  const who = await socialCaller({ limit: false });
  if ("res" in who) return who.res;
  return json(await listFriends(db, who.userId, worldNow()));
}
