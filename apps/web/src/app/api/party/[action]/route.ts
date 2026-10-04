import { db } from "@/db/client";
import { json, readJson } from "@/lib/lobby/route-helpers";
import { isPartyAction, partyAction, type PartyAction } from "@/lib/social/party";
import { socialCaller, socialError } from "@/lib/social/route";
import { parseNickname } from "@/lib/social/rules";
import type { SocialOkBody } from "@/lib/social/types";
import { worldNow } from "@/lib/world/clock";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NICK_ACTIONS: ReadonlySet<PartyAction> = new Set(["invite", "uninvite", "kick", "lead"]);

function okText(action: PartyAction, nick: string, follow: boolean): string {
  switch (action) {
    case "invite":
      return `Invited ${nick} to your party.`;
    case "uninvite":
      return `Invite to ${nick} cancelled.`;
    case "accept":
      return "You joined the party.";
    case "decline":
      return "Invite declined.";
    case "leave":
      return "You left the party.";
    case "kick":
      return `${nick} removed from the party.`;
    case "disband":
      return "Party disbanded.";
    case "lead":
      return `${nick} leads the party now.`;
    case "follow":
      return follow ? "You'll drop in when the leader does." : "Follow leader is off.";
  }
}

/**
 * POST /api/party/{invite|uninvite|accept|decline|leave|kick|disband|lead|follow}. Bodies:
 * `{ nickname }` (invite, uninvite, kick, lead), `{ partyId }` (accept, decline), `{ follow }` (follow),
 * none otherwise. Registered users only, throttled per user. 200 SocialOkBody; errors SocialErrorBody.
 */
export async function POST(req: Request, ctx: { params: Promise<{ action: string }> }) {
  const { action } = await ctx.params;
  if (!isPartyAction(action)) return socialError("bad_body");
  const who = await socialCaller({ limit: true });
  if ("res" in who) return who.res;
  const body = (await readJson(req)) as { nickname?: unknown; partyId?: unknown; follow?: unknown } | null;

  let nickname: string | undefined;
  if (NICK_ACTIONS.has(action)) {
    const n = parseNickname(body?.nickname);
    if (!n) return socialError(action === "invite" ? "not_found" : "bad_body");
    nickname = n;
  }
  let partyId: string | undefined;
  if (action === "accept" || action === "decline") {
    if (typeof body?.partyId !== "string" || !UUID_RE.test(body.partyId)) return socialError("no_invite");
    partyId = body.partyId.toLowerCase();
  }
  if (action === "follow" && typeof body?.follow !== "boolean") return socialError("bad_body");
  const follow = body?.follow === true;

  const r = await partyAction(db, who.userId, action, { nickname, partyId, follow }, worldNow());
  if (!r.ok) return socialError(r.code);
  return json({ ok: true, message: okText(action, r.nickname ?? nickname ?? "", follow) } satisfies SocialOkBody);
}
