/**
 * Game server → web API calls, HMAC-signed over `${ts}.${body}` (headers in shared HEADERS).
 * Flow (WORLD v6): process boot → POST /api/raids/void-orphans; WorldDirectory opens a shard →
 * POST /api/raids/open; BattleRoom.onAuth admits an entry → POST /api/raids/enter; each entry
 * leaving the map → POST /api/raids/exit; the event boss dies → POST /api/world/event; the wipe →
 * POST /api/raids/end.
 *
 * Every call is idempotent on the web side (raids row per matchId, raid_entries / raid_exits per
 * entryId, raids.status for the end), so retrying the exact same body is always safe. A 409 means
 * the raid was voided (or the entry is unknown): stop retrying. Nothing here throws: a missing or
 * broken web API never stalls a room. With WEB_API_BASE_URL / GAME_SERVER_HMAC_SECRET unset nothing
 * is posted (local dev, demo).
 */

import { setTimeout as delay } from "node:timers/promises";
import { createHmac, randomUUID } from "node:crypto";
import {
  HEADERS,
  type EntryRejectReason,
  type EntryRequest,
  type EntryResponse,
  type GameServerBoot,
  type LoadoutSnapshot,
  type MatchEndReport,
  type PlayerExitReport,
  type ShardOpenRequest,
  type ShardOpenResponse,
  type SoldLine,
  type WorldEventReport,
  type XpKey,
  type XpLine,
} from "@extract/shared";
import { getWebApiBaseUrl } from "./web-api-base.js";
import { sanitizeSnapshot, sanitizeUniques } from "./sanitize.js";

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

/** The web API is configured (WEB_API_BASE_URL and GAME_SERVER_HMAC_SECRET both set). */
export function webApiConfigured(): boolean {
  return !!getWebApiBaseUrl() && !!process.env.GAME_SERVER_HMAC_SECRET;
}

/**
 * An error reply body for the log: a JSON / text answer as is (≤ 300 chars); an HTML page (Next's
 * error page when the web failed before the route handler, e.g. a dev server mid-compile) as its
 * <title> and size instead of 500 chars of markup.
 */
export function errorBodyForLog(text: string): string {
  const t = text.trimStart();
  if (/^<(!doctype|html)/i.test(t)) {
    const title = /<title[^>]*>([^<]*)<\/title>/i.exec(t)?.[1]?.trim();
    return `[html error page${title ? ` "${title.slice(0, 80)}"` : ""}, ${text.length} bytes]`;
  }
  return text.slice(0, 300);
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
      lastErr = `status=${res.status} body=${errorBodyForLog(text)}`;
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
 * Identity of this game-server process. serverId is stable per deployment (env GAME_SERVER_ID,
 * required in production: env.ts); instanceId is new on every boot and goes into every
 * ShardOpenRequest, so the web can tell the shards of a crashed previous process (same serverId,
 * other instanceId) from live ones.
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
 * After those attempts fail, index.ts keeps announcing in the background this often until the web
 * takes it: until then the web cannot tell that the previous process' shards are gone.
 */
export const BOOT_RETRY_MS = 30_000;

export interface AnnounceBootOptions extends PostOptions {
  /**
   * > 0: when every attempt failed (web unreachable / 5xx), try again in the background after this
   * long, round after round, until it lands or is refused (4xx). The returned promise does not wait.
   */
  retryEveryMs?: number;
}

/**
 * POST /api/raids/void-orphans at process boot (index.ts): raids started by a previous process of
 * this serverId can never report their end, so the web voids them at once (gear back to its
 * owners, pool items back to the pool) instead of after the stale-raid timeout. Returns the voided
 * match ids ([] when skipped / failed / handed to the background retry). Never throws.
 */
export async function announceBoot(boot: GameServerBoot = SERVER_INSTANCE, opts: AnnounceBootOptions = {}): Promise<string[]> {
  const { retryEveryMs = 0, ...post } = opts;
  const r = await postSigned<unknown>("/api/raids/void-orphans", boot, {
    attempts: BOOT_ATTEMPTS,
    backoffMs: BOOT_BACKOFF_MS,
    ...post,
  });
  if (r.status !== "ok") {
    if (r.status === "rejected") console.error(`[web-api] raids/void-orphans refused: ${r.code} ${r.body}`);
    if (r.status === "failed" && retryEveryMs > 0) {
      console.error(`[web-api] raids/void-orphans did not land: retrying every ${Math.round(retryEveryMs / 1000)} s in the background`);
      const h = setTimeout(() => void announceBoot(boot, opts), retryEveryMs);
      h.unref?.();
    }
    return [];
  }
  const v = (r.body as { voided?: unknown } | null)?.voided;
  const voided = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  if (voided.length) console.log(`[web-api] voided ${voided.length} raid(s) orphaned by a previous process: ${voided.join(", ")}`);
  return voided;
}

// ---------------------------------------------------------------- WORLD v6: raids/open, raids/enter, world/event

/** raids/open result: the response, "rejected" (4xx: retrying will not help), or null (retry later). */
export type ShardOpenOutcome = ShardOpenResponse | "rejected" | null;

/**
 * POST /api/raids/open (5 fast attempts). The directory keeps retrying a null every 10 s until the
 * wipe; until it lands /api/world/join finds no running row, so nobody enters the shard.
 */
export async function openShard(req: ShardOpenRequest, opts: PostOptions = {}): Promise<ShardOpenOutcome> {
  const r = await postSigned<unknown>("/api/raids/open", req, opts);
  if (r.status === "rejected") {
    console.error(`[web-api] raids/open ${req.matchId} refused: ${r.code} ${r.body}`);
    return "rejected";
  }
  if (r.status !== "ok") return null;
  const b = r.body as Partial<ShardOpenResponse> | null;
  if (!b || (b.status !== "opened" && b.status !== "exists")) {
    console.error(`[web-api] raids/open ${req.matchId}: malformed reply`);
    return null;
  }
  return { status: b.status, autosellMult: typeof b.autosellMult === "number" && Number.isFinite(b.autosellMult) ? b.autosellMult : 1 };
}

/** raids/enter: 2 attempts × 4 s, 1 s backoff (the player waits on the join meanwhile). */
const ENTER_ATTEMPTS = 2;
const ENTER_TIMEOUT_MS = 4_000;
const ENTER_BACKOFF_MS = 1_000;
/** Most pool items one entry may carry in (D17 caps it far lower) and boss bag items (D19). */
export const MAX_ENTRY_POOL = 32;
export const MAX_BOSS_FILL = 4;
const REJECT_REASONS: readonly EntryRejectReason[] = ["not_locked", "wrong_user", "expired", "already_active", "entry_limit", "shard_closed"];

/**
 * Shape check of the web's EntryResponse against the request: the snapshot must be the ticket's
 * loadout of the ticket's user, uids unique across snapshot / pool / boss bag, at most
 * MAX_ENTRY_POOL pool and MAX_BOSS_FILL boss items. null = malformed.
 */
export function parseEntryResponse(body: unknown, req: Pick<EntryRequest, "userId" | "loadoutId">): EntryResponse | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const level = Number.isInteger(b.level) && (b.level as number) >= 0 && (b.level as number) <= 1000 ? (b.level as number) : 0;
  const autosellMult = typeof b.autosellMult === "number" && Number.isFinite(b.autosellMult) ? b.autosellMult : 1;
  const guest = b.guest === true;
  if (b.status === "rejected") {
    const reason = REJECT_REASONS.includes(b.reason as EntryRejectReason) ? (b.reason as EntryRejectReason) : undefined;
    return { status: "rejected", ...(reason ? { reason } : {}), snapshot: null, level, guest, pool: [], bossFill: [], autosellMult };
  }
  if (b.status !== "accepted") return null;
  const seen = new Set<string>();
  let snapshot: LoadoutSnapshot | null = null;
  if (b.snapshot !== null && b.snapshot !== undefined) {
    snapshot = sanitizeSnapshot(b.snapshot, req.userId, req.loadoutId, seen);
    // An accepted loadout the server cannot place would sit in_raid on the web with nobody carrying it.
    if (!snapshot) return null;
  }
  // snapshot null = free kit (also a locked loadout entering a demo shard: it stays in the stash).
  return {
    status: "accepted",
    snapshot,
    level,
    guest,
    pool: sanitizeUniques(b.pool, MAX_ENTRY_POOL, seen),
    bossFill: sanitizeUniques(b.bossFill, MAX_BOSS_FILL, seen),
    autosellMult,
  };
}

/**
 * POST /api/raids/enter. Returns the (sanitized) response, a rejection included, or null when the
 * API is not configured, unreachable, busy, refused the body or replied garbage: the admission then
 * answers web_unavailable. The web stores its response per entryId, so the player's next PLAY (same
 * entryId) gets a committed entry back (D6).
 */
export async function enterRaid(req: EntryRequest, opts: PostOptions = {}): Promise<EntryResponse | null> {
  const r = await postSigned<unknown>("/api/raids/enter", req, {
    attempts: ENTER_ATTEMPTS,
    timeoutMs: ENTER_TIMEOUT_MS,
    backoffMs: ENTER_BACKOFF_MS,
    ...opts,
  });
  if (r.status !== "ok") {
    if (r.status === "rejected") console.error(`[web-api] raids/enter ${req.matchId}/${req.entryId} refused: ${r.code} ${r.body}`);
    return null;
  }
  const res = parseEntryResponse(r.body, req);
  if (!res) console.error(`[web-api] raids/enter ${req.matchId}/${req.entryId}: malformed reply`);
  return res;
}

/** POST /api/world/event, fire-and-forget (3 attempts; 404 unknown_match → dropped). Never throws. */
export async function reportWorldEvent(req: WorldEventReport, opts: PostOptions = {}): Promise<boolean> {
  const r = await postSigned("/api/world/event", req, { attempts: 3, ...opts });
  if (r.status === "rejected") console.error(`[web-api] world/event ${req.matchId} ${req.kind} refused: ${r.code} ${r.body}`);
  return r.status === "ok";
}

// ---------------------------------------------------------------- raids/exit, raids/end

/**
 * The part of the web's exit reply the game shows: final CR, the autosell receipt and (WORLD v6)
 * the XP of this exit with its lines, the level after it and whether it went up.
 */
export interface ExitSettled {
  credits: number;
  sold: SoldLine[];
  guest: boolean;
  xp?: number;
  xpLines?: XpLine[];
  level?: number;
  levelUp?: boolean;
}

const XP_KEYS: readonly XpKey[] = ["extract", "haul", "containers", "npc", "guard", "boss", "pvp", "first_extract", "daily_cap", "quest"];
const MAX_XP_LINES = 16;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Shape check of the web's exit reply (ours, but a version skew must not crash a room). */
export function parseExitSettled(body: unknown): ExitSettled | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (!finite(b.credits) || !Array.isArray(b.sold)) return null;
  const sold: SoldLine[] = [];
  for (const l of b.sold.slice(0, 64)) {
    const r = l as Record<string, unknown> | null;
    if (!r || typeof r.def !== "string" || typeof r.qty !== "number" || typeof r.cr !== "number") continue;
    const line: SoldLine = { def: r.def.slice(0, 32), qty: r.qty, cr: r.cr };
    if (typeof r.label === "string" && r.label) line.label = r.label.slice(0, 32);
    sold.push(line);
  }
  const out: ExitSettled = { credits: b.credits, sold, guest: b.guest === true };
  if (finite(b.xp)) out.xp = Math.trunc(b.xp);
  if (Array.isArray(b.xpLines)) {
    const lines: XpLine[] = [];
    for (const l of b.xpLines.slice(0, MAX_XP_LINES)) {
      const r = l as Record<string, unknown> | null;
      if (!r || !XP_KEYS.includes(r.key as XpKey) || !finite(r.qty) || !finite(r.xp)) continue;
      lines.push({ key: r.key as XpKey, qty: r.qty, xp: r.xp });
    }
    out.xpLines = lines;
  }
  if (Number.isInteger(b.level) && (b.level as number) >= 0 && (b.level as number) <= 1000) out.level = b.level as number;
  if (typeof b.levelUp === "boolean") out.levelUp = b.levelUp;
  return out;
}

/** `key` = the report's entryId (world) or userId (legacy roster matches). */
type ExitListener = (key: string, r: ExitSettled) => void;
/**
 * Battle rooms listen for their own matchId (inventory-handlers.ts) to refresh OUTCOME. World
 * receipts are keyed by entryId: one user may have several entries in one match.
 */
const exitListeners = new Map<string, ExitListener>();

/** The key an exit receipt is routed by: entryId when set (world), else userId. */
export function exitKeyOf(report: Pick<PlayerExitReport, "entryId" | "userId">): string {
  return report.entryId || report.userId;
}

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
      console.error(`[web-api] raids/exit ${report.matchId}/${exitKeyOf(report)} gave up: the end report will not be sent`);
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
        fn(exitKeyOf(report), settled);
      } catch (e) {
        console.error(`[web-api] exit listener ${report.matchId} failed:`, e);
      }
    }
  } else if (r.status === "rejected") {
    console.error(`[web-api] raids/exit ${report.matchId}/${exitKeyOf(report)} refused: ${r.code} ${r.body}`);
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
