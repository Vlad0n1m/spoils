/**
 * Game server → web API calls, HMAC-signed over `${ts}.${body}` (headers in shared HEADERS).
 * Flow (critique "Settlement and loadout flow"): process boot → POST /api/raids/void-orphans,
 * MatchmakingRoom.launch → POST /api/raids/start, each human leaving the map → POST /api/raids/exit,
 * match end → POST /api/raids/end.
 *
 * Every call is idempotent on the web side (raids row per matchId, raid_exits per (match, user),
 * raids.status for the end), so retrying the exact same body is always safe. A 409 means the raid
 * was voided: stop retrying. Nothing here throws: a missing or broken web API never stalls a room.
 * With WEB_API_BASE_URL / GAME_SERVER_HMAC_SECRET unset nothing is posted (local dev, demo).
 */

import { setTimeout as delay } from "node:timers/promises";
import { createHmac, randomUUID } from "node:crypto";
import {
  HEADERS,
  type GameServerBoot,
  type MatchEndReport,
  type PlayerExitReport,
  type RaidStartRequest,
  type RaidStartResponse,
  type SoldLine,
} from "@extract/shared";
import { getWebApiBaseUrl } from "./web-api-base.js";

const DEFAULT_ATTEMPTS = 5;
const BACKOFF_MS = 400;
const REQUEST_TIMEOUT_MS = 10_000;

export type PostResult<T = unknown> =
  | { status: "ok"; body: T }
  | { status: "skipped" }
  /** 4xx other than 408 / 429: retrying will not help (409 = raid voided). */
  | { status: "rejected"; code: number; body: string }
  | { status: "failed"; error: string };

export interface PostOptions {
  attempts?: number;
  backoffMs?: number;
  /** Per-attempt timeout (default 10 s). */
  timeoutMs?: number;
}

export interface ExitPostOptions extends PostOptions {
  /** How long a failing exit keeps being re-posted after the fast retries (default 10 min). */
  retryWindowMs?: number;
  /** First pause between those slow rounds; doubles up to EXIT_SLOW_BACKOFF_MAX_MS. */
  slowBackoffMs?: number;
}

/**
 * POST `body` as JSON to `${WEB_API_BASE_URL}${path}`, signed with GAME_SERVER_HMAC_SECRET.
 * A fresh timestamp per attempt (the API rejects stale signatures). Never throws.
 */
export async function postSigned<T = unknown>(path: string, body: unknown, opts: PostOptions = {}): Promise<PostResult<T>> {
  const base = getWebApiBaseUrl();
  const secret = process.env.GAME_SERVER_HMAC_SECRET;
  if (!base || !secret) return { status: "skipped" };
  const url = `${base}${path}`;
  const json = JSON.stringify(body);
  const attempts = opts.attempts ?? DEFAULT_ATTEMPTS;
  const backoff = opts.backoffMs ?? BACKOFF_MS;
  let lastErr = "";
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await delay(backoff * 2 ** (attempt - 1));
    const ts = Date.now().toString();
    const sig = createHmac("sha256", secret).update(`${ts}.${json}`).digest("hex");
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", [HEADERS.GAME_SERVER_TS]: ts, [HEADERS.GAME_SERVER_SIG]: sig },
        body: json,
        signal: AbortSignal.timeout(opts.timeoutMs ?? REQUEST_TIMEOUT_MS),
      });
      const text = await res.text();
      if (res.ok) {
        let parsed: unknown = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          parsed = text;
        }
        return { status: "ok", body: parsed as T };
      }
      lastErr = `status=${res.status} body=${text.slice(0, 500)}`;
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        return { status: "rejected", code: res.status, body: text.slice(0, 500) };
      }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  console.error(`[web-api] POST ${url} failed: ${lastErr}`);
  return { status: "failed", error: lastErr };
}

// ---------------------------------------------------------------- boot (void-orphans)

/**
 * Identity of this game-server process. serverId is stable per deployment (env GAME_SERVER_ID);
 * instanceId is new on every boot and goes into every RaidStartRequest, so the web can tell the
 * raids of a crashed previous process (same serverId, other instanceId) from live ones.
 */
export const SERVER_INSTANCE: Readonly<GameServerBoot> = Object.freeze({
  serverId: (process.env.GAME_SERVER_ID?.trim() || "default").slice(0, 64),
  instanceId: randomUUID(),
  bootedAt: Date.now(),
});

/** Boot announce: the web may still be starting (dev), so retry for ≈1 min. */
const BOOT_ATTEMPTS = 8;
const BOOT_BACKOFF_MS = 500;

/**
 * POST /api/raids/void-orphans once at process boot (index.ts): raids started by a previous
 * process of this serverId can never report their end, so the web voids them at once (gear back
 * to its owners, pool items back to the pool) instead of after the stale-raid timeout. Returns
 * the voided match ids ([] when skipped / failed). Never throws.
 */
export async function announceBoot(boot: GameServerBoot = SERVER_INSTANCE, opts: PostOptions = {}): Promise<string[]> {
  const r = await postSigned<unknown>("/api/raids/void-orphans", boot, {
    attempts: BOOT_ATTEMPTS,
    backoffMs: BOOT_BACKOFF_MS,
    ...opts,
  });
  if (r.status !== "ok") {
    if (r.status === "rejected") console.error(`[web-api] raids/void-orphans refused: ${r.code} ${r.body}`);
    return [];
  }
  const v = (r.body as { voided?: unknown } | null)?.voided;
  const voided = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  if (voided.length) console.log(`[web-api] voided ${voided.length} raid(s) orphaned by a previous process: ${voided.join(", ")}`);
  return voided;
}

// ---------------------------------------------------------------- raids/start

/** raids/start: 1 attempt + 3 retries, short timeouts (players wait in the queue meanwhile). */
const START_ATTEMPTS = 4;
const START_TIMEOUT_MS = 5_000;

/**
 * POST /api/raids/start. Returns the response, or null when the API is not configured, unreachable
 * after the retries, or refused the request: the caller then falls back to demo mode. The web side
 * stores its response per matchId, so a retry after a lost reply gets the same allocation back.
 */
export async function startRaid(req: RaidStartRequest, opts: PostOptions = {}): Promise<RaidStartResponse | null> {
  const r = await postSigned<unknown>("/api/raids/start", req, {
    attempts: START_ATTEMPTS,
    timeoutMs: START_TIMEOUT_MS,
    ...opts,
  });
  if (r.status !== "ok") {
    if (r.status === "rejected") console.error(`[web-api] raids/start ${req.matchId} refused: ${r.code} ${r.body}`);
    return null;
  }
  const b = r.body as Partial<RaidStartResponse> | null;
  if (!b || typeof b !== "object" || !Array.isArray(b.accepted) || !Array.isArray(b.rejected)) {
    console.error(`[web-api] raids/start ${req.matchId}: malformed reply`);
    return null;
  }
  return {
    accepted: b.accepted,
    rejected: b.rejected,
    containerLoot: b.containerLoot && typeof b.containerLoot === "object" ? b.containerLoot : {},
    autosellMult: typeof b.autosellMult === "number" && Number.isFinite(b.autosellMult) ? b.autosellMult : 1,
  };
}

// ---------------------------------------------------------------- raids/exit, raids/end

/** The part of the web's exit reply the game shows: final CR and the autosell receipt. */
export interface ExitSettled {
  credits: number;
  sold: SoldLine[];
  guest: boolean;
}

/** Shape check of the web's exit reply (ours, but a version skew must not crash a room). */
export function parseExitSettled(body: unknown): ExitSettled | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.credits !== "number" || !Number.isFinite(b.credits) || !Array.isArray(b.sold)) return null;
  const sold: SoldLine[] = [];
  for (const l of b.sold.slice(0, 64)) {
    const r = l as Record<string, unknown> | null;
    if (!r || typeof r.def !== "string" || typeof r.qty !== "number" || typeof r.cr !== "number") continue;
    const line: SoldLine = { def: r.def.slice(0, 32), qty: r.qty, cr: r.cr };
    if (typeof r.label === "string" && r.label) line.label = r.label.slice(0, 32);
    sold.push(line);
  }
  return { credits: b.credits, sold, guest: b.guest === true };
}

type ExitListener = (userId: string, r: ExitSettled) => void;
/** Battle rooms listen for their own matchId (inventory-handlers.ts) to refresh OUTCOME. */
const exitListeners = new Map<string, ExitListener>();

export function onExitSettled(matchId: string, fn: ExitListener): void {
  exitListeners.set(matchId, fn);
}

export function offExitSettled(matchId: string): void {
  exitListeners.delete(matchId);
}

/**
 * Exit posts still in flight per match. The end report must land after every exit: the web's end
 * sweep moves whatever is still in_raid to the lost pool, which would swallow the items of a
 * player whose extract report was still on its way (the last human extracting ends the match in
 * the same tick, so both posts start together).
 */
const pendingExits = new Map<string, Set<Promise<PostResult>>>();
/**
 * Matches with an exit report that never got through (web down for the whole retry window). Their
 * end report is not sent: its sweep would move that player's extracted items into the lost pool.
 * The raid is left to the web's void (stale timeout / void-orphans), which returns gear instead.
 */
const unsettledExits = new Set<string>();

const EXIT_RETRY_WINDOW_MS = 10 * 60_000;
const EXIT_SLOW_BACKOFF_MS = 5_000;
const EXIT_SLOW_BACKOFF_MAX_MS = 60_000;

/**
 * POST /api/raids/exit (retried; 409 = voided → stop). A brief outage (deploy, cold start) must
 * not lose the report: after the fast retries it keeps re-posting with a slow backoff for
 * retryWindowMs. Never throws.
 */
export function reportExit(report: PlayerExitReport, opts: ExitPostOptions = {}): Promise<PostResult> {
  const p = postExitDurable(report, opts);
  let set = pendingExits.get(report.matchId);
  if (!set) pendingExits.set(report.matchId, (set = new Set()));
  set.add(p);
  void p.finally(() => {
    set.delete(p);
    if (set.size === 0 && pendingExits.get(report.matchId) === set) pendingExits.delete(report.matchId);
  });
  return p;
}

async function postExitDurable(report: PlayerExitReport, opts: ExitPostOptions): Promise<PostResult> {
  const until = Date.now() + (opts.retryWindowMs ?? EXIT_RETRY_WINDOW_MS);
  let wait = opts.slowBackoffMs ?? EXIT_SLOW_BACKOFF_MS;
  for (;;) {
    const r = await postExit(report, opts);
    if (r.status !== "failed") return r;
    if (Date.now() + wait > until) {
      unsettledExits.add(report.matchId);
      console.error(`[web-api] raids/exit ${report.matchId}/${report.userId} gave up: the end report will not be sent`);
      return r;
    }
    await delay(wait);
    wait = Math.min(wait * 2, EXIT_SLOW_BACKOFF_MAX_MS);
  }
}

async function postExit(report: PlayerExitReport, opts: PostOptions): Promise<PostResult> {
  const r = await postSigned("/api/raids/exit", report, opts);
  if (r.status === "ok") {
    const settled = parseExitSettled(r.body);
    const fn = exitListeners.get(report.matchId);
    if (settled && fn) {
      try {
        fn(report.userId, settled);
      } catch (e) {
        console.error(`[web-api] exit listener ${report.matchId} failed:`, e);
      }
    }
  } else if (r.status === "rejected") {
    console.error(`[web-api] raids/exit ${report.matchId}/${report.userId} refused: ${r.code} ${r.body}`);
  }
  return r;
}

/**
 * POST /api/raids/end after every pending exit of the match settled (retried; 409 = voided → stop).
 * Not sent at all when an exit of this match never got through (see unsettledExits).
 */
export async function reportEnd(report: MatchEndReport, opts: PostOptions = {}): Promise<PostResult> {
  const pending = pendingExits.get(report.matchId);
  if (pending) await Promise.allSettled([...pending]);
  if (unsettledExits.delete(report.matchId)) {
    offExitSettled(report.matchId);
    console.error(`[web-api] raids/end ${report.matchId} withheld: an exit report never reached the web (raid left to its void)`);
    return { status: "failed", error: "exit_unsettled" };
  }
  const r = await postSigned("/api/raids/end", report, opts);
  if (r.status === "rejected") console.error(`[web-api] raids/end ${report.matchId} refused: ${r.code} ${r.body}`);
  // Exit replies still in flight may arrive later; they then just find no listener.
  offExitSettled(report.matchId);
  return r;
}
