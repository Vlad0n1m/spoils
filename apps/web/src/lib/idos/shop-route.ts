/**
 * Plumbing of the SPOILS shop routes (app/api/idos/shop, shop/buy, balance): who may call them and
 * the per-player rate limits. Edition only (IDOS_BUILD; the main build answers 404, like
 * /api/idos/session and middleware.ts), signed-in players whose account came from the iDos sign-in
 * bridge (users.idos_user_id): the shop pays from that iDos account's SPOILS balance, so an account
 * made by email/password in the edition has nothing to pay with.
 *
 * The iDos identity used for payments is the one stored on the account, never one the client sends:
 * the client only sends its current session ticket, and iDos itself checks that the ticket belongs to
 * that UserID on every call (a wrong ticket → iDos 401 → our 401 invalid_session).
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { KeyedBucket } from "../auth-rate-limit";
import { IDOS_BUILD } from "../edition";
import { caller, registeredOnly } from "../lobby/route-helpers";
import { checkSameOriginRequest } from "../request-guard";
import { parseIdosAccountKey } from "./shop";
import { IDOS_SHOP } from "./shop-rules";

const NO_STORE = { "Cache-Control": "no-store" };

export function reply(status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return NextResponse.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

/** Buys per player: 10 at once, then one every 6 s (≈ 10 a minute). */
export const buyLimiter = new KeyedBucket({ burst: IDOS_SHOP.BUY_BURST, refillMs: IDOS_SHOP.BUY_REFILL_MS, maxKeys: 10_000 });
/** Balance reads per player (each one is an iDos call): 20 at once, then one every 3 s. */
export const balanceLimiter = new KeyedBucket({ burst: 20, refillMs: 3_000, maxKeys: 10_000 });

export type ShopCaller = { ok: true; userId: string; titleId: string; idosUserId: string } | { ok: false; res: Response };

/**
 * The calling player of a shop route, or the response to send instead: 404 outside the edition,
 * the CSRF / JSON guard for POSTs (the iDos client's origin is allowed, request-guard.ts), 401 / 403
 * for anonymous callers and guests, 403 not_idos_account for an account without an iDos identity.
 */
export async function shopCaller(req: Request, opts: { post: boolean }): Promise<ShopCaller> {
  if (!IDOS_BUILD) return { ok: false, res: reply(404, { error: "not_found" }) };
  if (opts.post) {
    const blocked = checkSameOriginRequest(req, { json: true });
    if (blocked) return { ok: false, res: reply(blocked.status, { error: blocked.error }) };
  }
  const c = await caller();
  const deny = registeredOnly(c);
  if (deny || c.kind !== "user") return { ok: false, res: deny! };
  const [u] = await db.select({ idos: users.idosUserId }).from(users).where(eq(users.id, c.userId)).limit(1);
  const acct = parseIdosAccountKey(u?.idos);
  if (!acct) {
    return {
      ok: false,
      res: reply(403, { error: "not_idos_account", message: "The SPOILS shop needs an account signed in through iDos Games." }),
    };
  }
  return { ok: true, userId: c.userId, titleId: acct.titleId, idosUserId: acct.userId };
}

export function rateLimited(retryAfterSec: number) {
  return reply(429, { error: "rate_limited", message: "Too many requests. Wait a few seconds." }, { "Retry-After": String(retryAfterSec) });
}
