import { NextResponse } from "next/server";
import { getSession } from "../session";
import { MARKET_CURRENCY, listingFeeCr } from "../market/config";
import { marketRules } from "../market/server-config";
import type { ApiError, MarketConfigDto } from "./api-types";

/** Lobby route plumbing: who is calling, uniform JSON errors, market config for the UI. */

export type Caller =
  | { kind: "user"; userId: string; nickname: string }
  | { kind: "guest"; userId: string; nickname: string }
  | { kind: "anon" };

export async function caller(): Promise<Caller> {
  const s = await getSession();
  if (!s.userId || !s.nickname) return { kind: "anon" };
  return s.guest ? { kind: "guest", userId: s.userId, nickname: s.nickname } : { kind: "user", userId: s.userId, nickname: s.nickname };
}

export function apiError(status: number, error: string, message?: string, extra: Partial<ApiError> = {}) {
  return NextResponse.json({ error, ...(message ? { message } : {}), ...extra } satisfies ApiError, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/** 401 for anonymous callers, 403 for guests (no stash, no market wallet). */
export function registeredOnly(c: Caller) {
  if (c.kind === "anon") return apiError(401, "unauthenticated", "Sign in first.");
  if (c.kind === "guest") return apiError(403, "guest", "Register to get a stash, a loadout and market access.");
  return null;
}

export function json<T>(body: T, init: { status?: number; cache?: string } = {}) {
  return NextResponse.json(body, { status: init.status ?? 200, headers: { "Cache-Control": init.cache ?? "no-store" } });
}

/** Body parse that never throws (an empty or non-JSON body is just `null`). */
export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

export function marketConfig(): MarketConfigDto {
  const r = marketRules();
  return {
    currency: MARKET_CURRENCY.code,
    decimals: MARKET_CURRENCY.decimals,
    feeBps: r.feeBps,
    sellUnlockLevel: r.sellUnlockLevel,
    maxActiveListings: r.maxActiveListings,
    listingFeeCr: [0, 1, 2, 3].map(listingFeeCr),
  };
}
