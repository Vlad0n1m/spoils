/**
 * Route plumbing of /api/friends/** and /api/party/**: registered callers only (guests get
 * "Register to add friends"), uniform error bodies, the per-user throttle on every POST.
 */
import { NextResponse } from "next/server";
import { caller } from "../lobby/route-helpers";
import { socialLimiter } from "./rate-limit";
import { SOCIAL_ERR } from "./rules";
import type { SocialErrCode, SocialErrorBody } from "./types";

export function socialError(code: SocialErrCode, extra: Partial<SocialErrorBody> = {}) {
  const e = SOCIAL_ERR[code];
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (extra.retryAfterSec) headers["Retry-After"] = String(extra.retryAfterSec);
  return NextResponse.json({ error: code, message: e.message, ...extra } satisfies SocialErrorBody, { status: e.status, headers });
}

/** The registered caller's id, or the error response (401 anon, 403 guest, 429 throttled POSTs). */
export async function socialCaller(opts: { limit: boolean }): Promise<{ userId: string } | { res: NextResponse }> {
  const c = await caller();
  if (c.kind === "anon") return { res: socialError("unauthenticated") };
  if (c.kind === "guest") return { res: socialError("guest") };
  if (opts.limit) {
    const d = socialLimiter.take(c.userId);
    if (!d.ok) return { res: socialError("rate_limited", { retryAfterSec: d.retryAfterSec }) };
  }
  return { userId: c.userId };
}
