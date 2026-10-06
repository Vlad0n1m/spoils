/**
 * The big PLAY button's state (WORLD v6 spec §6.5). Pure: the menu feeds it the session, the stash,
 * the world status, /api/me/world, its local flags and the server-corrected clock; the tests cover
 * every row. The button only renders what this returns.
 */
import type { LoadoutErrCode, MeWorldDto, WorldStatusDto } from "@extract/shared";
import type { WorldJoinErrorBody } from "./api-types";
import { fmtLocalHm, secsUntil, worldView } from "./world-clock";

export type PlayState =
  | { kind: "loading" }
  | { kind: "signed_out" }
  | { kind: "offline" }
  /** amber: wipe < 15 min ("Short raid · 4 items at risk"); the countdown itself is on the world card. */
  | { kind: "ready"; sub: string; tone: "lime" | "amber" }
  | { kind: "joining" }
  /** Entry is closed (closing) or the new map is starting (resetting), not armed. */
  | { kind: "closed"; label: "NEXT MAP" | "NEW MAP"; nextInS: number }
  /** "READY ✓ mm:ss" + Cancel: auto-enter when the map opens (tab visible). */
  | { kind: "armed"; nextInS: number }
  /** The caller's raider is still on this map (meWorld.activeEntry.rejoinable). */
  | { kind: "rejoin" }
  /** Gear is held by a raid that has not settled; `settlesAtLocal` "" = unknown. */
  | { kind: "gear_in_raid"; settlesAtLocal: string }
  | { kind: "error"; base: Exclude<PlayState, { kind: "error" }>; message: string; fix?: PlayFix };

export type PlayFix = "inventory" | "retry" | "signin";
export interface PlayError {
  message: string;
  fix?: PlayFix;
}

export type SessionKind = "anon" | "guest" | "user";

export interface PlayInput {
  session: { loading: boolean; kind: SessionKind };
  /**
   * Registered users only (null for guests and anon). `loaded` = /api/stash answered (or failed);
   * `inRaid` = the active loadout is in a raid; `atRisk` = uniques in the loadout PLAY would lock.
   */
  stash: { loaded: boolean; inRaid: boolean; atRisk: number; starterClaimed: boolean } | null;
  world: WorldStatusDto | null;
  /** /api/world/status keeps failing and nothing usable is cached. */
  worldError: boolean;
  /** /api/me/world: undefined while loading, null when unavailable (anon, or the call failed). */
  me: MeWorldDto | null | undefined;
  local: {
    /** POST /api/world/join (or the room join) is in flight. */
    joining: boolean;
    /** The cycle an armed PLAY waits for (sessionStorage `spoils.armed`), else null. */
    armedCycle: number | null;
    /** The last join failed with this (cleared by the next action). */
    error: PlayError | null;
    /** document.visibilityState !== "visible". */
    hidden: boolean;
    /** The last join answered in_raid: when the gear settles at the latest (wall ms). */
    inRaidUntil: number | null;
  };
  /** Server-corrected wall clock (ms). */
  now: number;
  /** Local "HH:mm" formatter (injectable for tests). */
  fmtTime?: (ms: number) => string;
}

/** A wipe closer than this makes the raid "short" (amber PLAY). */
export const SHORT_RAID_MS = 15 * 60_000;
/**
 * A finished shard frees its entries' gear at the latest this long after the wipe (web
 * RAID_USER_VOID_GRACE_MS in lib/inventory/raids.ts; a server module, so the number is mirrored).
 */
export const SETTLE_GRACE_MS = 12 * 60_000;

const LOADING = { kind: "loading" } as const;

/** The risk half of the ready line: what the player stands to lose. */
export function riskLine(kind: SessionKind, atRisk: number): string {
  if (kind === "guest") return "Basic gear · loot isn't kept";
  if (atRisk <= 0) return "Basic gear · nothing at risk";
  return `${atRisk} ${atRisk === 1 ? "item" : "items"} at risk`;
}

function baseState(i: PlayInput): Exclude<PlayState, { kind: "error" }> {
  if (i.session.loading) return LOADING;
  if (i.session.kind === "anon") return { kind: "signed_out" };
  if (i.local.joining) return { kind: "joining" };
  if (i.me === undefined) return LOADING;
  if (i.session.kind === "user" && !i.stash?.loaded) return LOADING;

  const fmt = i.fmtTime ?? ((ms: number) => fmtLocalHm(ms));
  const active = i.me?.activeEntry ?? null;
  if (active?.rejoinable) return { kind: "rejoin" };
  if (active) return { kind: "gear_in_raid", settlesAtLocal: fmt(active.wipeAt + SETTLE_GRACE_MS) };
  if (i.local.inRaidUntil !== null && i.now < i.local.inRaidUntil) {
    return { kind: "gear_in_raid", settlesAtLocal: fmt(i.local.inRaidUntil) };
  }
  if (i.stash?.inRaid) return { kind: "gear_in_raid", settlesAtLocal: "" };

  const v = worldView(i.world, i.now);
  if (v.phase !== "open") {
    const nextInS = secsUntil(v.entryOpensAt, i.now);
    if (i.local.armedCycle === v.armCycle) return { kind: "armed", nextInS };
    return { kind: "closed", label: v.phase === "resetting" ? "NEW MAP" : "NEXT MAP", nextInS };
  }
  if ((i.worldError && !i.world) || v.online === false) return { kind: "offline" };
  // Armed for this cycle and the map just opened: the menu fires the auto-enter after its jitter.
  // A hidden tab never auto-enters (the menu turns it into a plain "ready" and pings the player).
  if (i.local.armedCycle === v.cycle && !i.local.hidden) return { kind: "armed", nextInS: 0 };
  // The wipe countdown lives on the world card right above: the sub-line only says what is at stake.
  const risk = riskLine(i.session.kind, i.stash?.atRisk ?? 0);
  if (v.wipeAt - i.now < SHORT_RAID_MS) return { kind: "ready", sub: `Short raid · ${risk}`, tone: "amber" };
  return { kind: "ready", sub: risk, tone: "lime" };
}

/** PLAY state at `i.now`. A join error wraps whatever the button would show otherwise. */
export function derivePlayState(i: PlayInput): PlayState {
  const base = baseState(i);
  const err = i.local.error;
  if (!err || base.kind === "loading" || base.kind === "joining" || base.kind === "signed_out") return base;
  return { kind: "error", base, message: err.message, ...(err.fix ? { fix: err.fix } : {}) };
}

/** Pressing the button: what the menu does in this state (null = nothing, the button is inert). */
export type PlayAction = "join" | "arm" | "disarm" | "signin" | "retry_status" | null;

export function playAction(s: PlayState): PlayAction {
  switch (s.kind) {
    case "ready":
    case "rejoin":
      return "join";
    case "closed":
      return "arm";
    case "armed":
      return "disarm";
    case "signed_out":
      return "signin";
    case "offline":
      return "retry_status";
    case "error":
      return playAction(s.base);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------- join failures

const LOADOUT_CODES: ReadonlySet<string> = new Set<LoadoutErrCode>([
  "bad_item",
  "dup_slot",
  "bad_slot",
  "no_backpack_room",
  "item_unavailable",
  "bad_qty",
  "not_enough",
]);

/** How the menu reacts to a failed POST /api/world/join (`status` 0 = network error). */
export type JoinFailure =
  /** entry_closed: adopt the server clock; the button shows NEXT MAP / NEW MAP by itself. */
  | { kind: "closed" }
  /** world_starting / world_full: try again after `afterMs` (the menu gives up after 3 tries). */
  | { kind: "retry"; afterMs: number; message: string }
  /** in_raid: gear held by an unsettled raid. */
  | { kind: "in_raid"; settlesAt: number | null }
  | { kind: "error"; error: PlayError };

export function classifyJoinFailure(status: number, body: Partial<WorldJoinErrorBody> | null): JoinFailure {
  const code: string = typeof body?.error === "string" ? body.error : "";
  const message = typeof body?.message === "string" && body.message ? body.message : "";
  if (status === 401 || code === "unauthenticated" || code === "no_user") {
    return { kind: "error", error: { message: message || "Your session expired — sign in again.", fix: "signin" } };
  }
  if (code === "entry_closed") return { kind: "closed" };
  if (code === "world_starting" || code === "world_full") {
    const after = typeof body?.retryInMs === "number" && body.retryInMs > 0 ? Math.min(body.retryInMs, 15_000) : 3_000;
    return { kind: "retry", afterMs: after, message: message || "The map is starting up. Try again in a few seconds." };
  }
  if (code === "in_raid") {
    return { kind: "in_raid", settlesAt: typeof body?.settlesAt === "number" ? body.settlesAt : null };
  }
  if (code === "entry_limit") {
    return { kind: "error", error: { message: message || "You've dropped into this map too many times. The next map opens soon." } };
  }
  if (LOADOUT_CODES.has(code)) {
    return { kind: "error", error: { message: message || "Your loadout needs fixing.", fix: "inventory" } };
  }
  if (code === "conflict") {
    return { kind: "error", error: { message: message || "Your loadout is being locked in another tab.", fix: "retry" } };
  }
  if (status === 0) {
    return { kind: "error", error: { message: "Couldn't reach the server. Check your connection.", fix: "retry" } };
  }
  return { kind: "error", error: { message: message || `Couldn't drop in (HTTP ${status}).`, fix: "retry" } };
}
