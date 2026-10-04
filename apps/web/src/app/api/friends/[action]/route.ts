import { db } from "@/db/client";
import { json, readJson } from "@/lib/lobby/route-helpers";
import { friendAction, isFriendAction, type FriendAction } from "@/lib/social/friends";
import { socialCaller, socialError } from "@/lib/social/route";
import { parseNickname } from "@/lib/social/rules";
import type { SocialOkBody } from "@/lib/social/types";
import { worldNow } from "@/lib/world/clock";

export const dynamic = "force-dynamic";

const OK_TEXT: Record<FriendAction, (nick: string, status?: "sent" | "accepted") => string> = {
  request: (n, s) => (s === "accepted" ? `You and ${n} are friends now.` : `Friend request sent to ${n}.`),
  accept: (n) => `You and ${n} are friends now.`,
  decline: (n) => `Declined ${n}'s request.`,
  cancel: (n) => `Request to ${n} cancelled.`,
  remove: (n) => `${n} removed from friends.`,
};

/**
 * POST /api/friends/{request|accept|decline|cancel|remove}, body `{ nickname }`. Registered users only,
 * throttled per user. 200 SocialOkBody; errors `{ error, message }` (SocialErrorBody).
 */
export async function POST(req: Request, ctx: { params: Promise<{ action: string }> }) {
  const { action } = await ctx.params;
  if (!isFriendAction(action)) return socialError("bad_body");
  const who = await socialCaller({ limit: true });
  if ("res" in who) return who.res;
  const body = (await readJson(req)) as { nickname?: unknown } | null;
  const nickname = parseNickname(body?.nickname);
  if (!nickname) return socialError(action === "request" ? "not_found" : "bad_body");
  const r = await friendAction(db, who.userId, action, nickname, worldNow());
  if (!r.ok) return socialError(r.code);
  return json({ ok: true, ...(r.status ? { status: r.status } : {}), message: OK_TEXT[action](r.nickname, r.status) } satisfies SocialOkBody);
}
