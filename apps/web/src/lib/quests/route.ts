/**
 * Route plumbing of /api/quests/**: registered players only (guests get "Register to get daily
 * tasks"), uniform error bodies, a per-user throttle on the POST routes (same shape as the social
 * routes: burst 20, then one every 3 s).
 */
import { NextResponse } from "next/server";
import { caller } from "../lobby/route-helpers";
import { SocialLimiter } from "../social/rate-limit";
import { QUEST_ERR, type QuestErr } from "./quests";

export const questLimiter = new SocialLimiter();

type ErrCode = QuestErr | "unauthenticated" | "bad_body" | "rate_limited" | "internal";

const EXTRA: Readonly<Record<Exclude<ErrCode, QuestErr>, { status: number; message: string }>> = {
  unauthenticated: { status: 401, message: "Sign in first." },
  bad_body: { status: 400, message: "Bad request." },
  rate_limited: { status: 429, message: "Too many requests. Try again in a moment." },
  internal: { status: 500, message: "Something went wrong. Try again." },
};

export function questError(code: ErrCode, retryAfterSec?: number) {
  const e = (QUEST_ERR as Record<string, { status: number; message: string }>)[code] ?? EXTRA[code as keyof typeof EXTRA];
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (retryAfterSec) headers["Retry-After"] = String(retryAfterSec);
  return NextResponse.json({ error: code, message: e.message }, { status: e.status, headers });
}

/** The registered caller's id, or the error response (401 anon, 403 guest, 429 throttled POSTs). */
export async function questCaller(opts: { limit: boolean }): Promise<{ userId: string } | { res: NextResponse }> {
  const c = await caller();
  if (c.kind === "anon") return { res: questError("unauthenticated") };
  if (c.kind === "guest") return { res: questError("no_user") };
  if (opts.limit) {
    const d = questLimiter.take(c.userId);
    if (!d.ok) return { res: questError("rate_limited", d.retryAfterSec) };
  }
  return { userId: c.userId };
}
