/**
 * Battle-room glue of the inventory lane (WP-B). battle-room.ts only imports this module:
 * - registerInventoryHandlers: SEARCH_CLOSE / INV_MOVE / INV_TAKE_ALL / INV_DROP handlers. Shapes
 *   are validated here (untrusted input); the rules live in sim (containers.ts for search
 *   sessions, Match.invMove / invDrop for the player's own slots), which answer errors with INV_ERR.
 *   It also refreshes a player's OUTCOME once the web API settled their exit (final CR + receipt).
 * - raidOptions: the launch data MatchmakingRoom passes to createRoom (matchId, seed, live/demo
 *   mode, accepted loadout snapshots, pool allocation), sanitized again here because onCreate
 *   options are plain JSON (defence in depth; only matchmaking can create battles anyway).
 * - optional dev hooks (GAME_TEST_HOOKS=1, never in production) for scripted smoke tests.
 */

import type { Client, Room } from "@colyseus/core";
import {
  C2S,
  S2C,
  isSlotKey,
  itemDef,
  type InvDropMsg,
  type InvMoveMsg,
  type LoadoutSnapshot,
  type OutcomeMsg,
  type RaidMode,
  type SettledItem,
} from "@extract/shared";
import { offExitSettled, onExitSettled, type ExitSettled } from "../net/web-api.js";
import { killPlayer } from "../sim/death.js";
import { dropSpot } from "../sim/inventory.js";
import type { Match, MatchOptions } from "../sim/match.js";
import type { RosterEntry } from "../sim/types.js";

const str = (v: unknown, max = 64): v is string => typeof v === "string" && v.length <= max;
const qtyOk = (v: unknown) => v === undefined || (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 999);
const intIn = (v: unknown, lo: number, hi: number): v is number => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

export function parseInvMove(raw: unknown): InvMoveMsg | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if ((r.from !== "self" && r.from !== "loot") || !str(r.key, 8) || !str(r.uid) || !str(r.def)) return null;
  if (r.to !== undefined && !isSlotKey(r.to)) return null;
  if (!qtyOk(r.qty)) return null;
  const out: InvMoveMsg = { from: r.from, key: r.key, uid: r.uid, def: r.def };
  if (r.to !== undefined) out.to = r.to as InvMoveMsg["to"];
  if (r.qty !== undefined) out.qty = r.qty as number;
  return out;
}

export function parseInvDrop(raw: unknown): InvDropMsg | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!isSlotKey(r.key) || !str(r.uid) || !str(r.def) || !qtyOk(r.qty)) return null;
  const out: InvDropMsg = { key: r.key, uid: r.uid, def: r.def };
  if (r.qty !== undefined) out.qty = r.qty as number;
  return out;
}

/** Dev-only scripted-test hook message (GAME_TEST_HOOKS=1 and NODE_ENV !== "production"). */
export const DEV_HOOK = "dev_hook";

export function testHooksEnabled(): boolean {
  return process.env.GAME_TEST_HOOKS === "1" && process.env.NODE_ENV !== "production";
}

export function registerInventoryHandlers(room: Room, match: () => Match, intentOk: (client: Client) => boolean = () => true): void {
  room.onMessage(C2S.SEARCH_CLOSE, (client) => {
    if (intentOk(client)) match().searchClose(client.sessionId);
  });
  room.onMessage(C2S.INV_MOVE, (client, raw: unknown) => {
    const msg = parseInvMove(raw);
    if (!msg) return;
    // Match.invMove routes from:"loot" to the search session and from:"self" to the bag.
    match().invMove(client.sessionId, msg);
  });
  room.onMessage(C2S.INV_TAKE_ALL, (client) => match().invTakeAll(client.sessionId));
  room.onMessage(C2S.INV_DROP, (client, raw: unknown) => {
    const msg = parseInvDrop(raw);
    if (msg) match().invDrop(client.sessionId, msg);
  });

  // The web settles each exit (autosell multiplier, dog-tag repeat rule, guest status): refresh
  // the player's result with the final numbers (reconnects get rt.outcome as well).
  const matchId = match().state.matchId;
  offExitSettled(matchId);
  onExitSettled(matchId, (userId, r) => applyExitSettled(room, match(), userId, r));

  if (testHooksEnabled()) {
    room.onMessage(DEV_HOOK, (client, raw: unknown) => devHook(match(), client, raw));
  }
}

/** Merge the web's settlement into the player's OUTCOME and resend it. Exported for tests. */
export function applyExitSettled(room: Pick<Room, "clients">, m: Match, userId: string, r: ExitSettled): OutcomeMsg | null {
  const rt = m.allRuntimes().find((x) => !x.isNpc && x.userId === userId);
  if (!rt?.outcome) return null;
  rt.outcome = { ...rt.outcome, credits: r.credits, sold: r.sold, guest: r.guest };
  const client = room.clients.find((c: Client) => c.sessionId === rt.id);
  client?.send(S2C.OUTCOME, rt.outcome);
  return rt.outcome;
}

/**
 * Scripted smoke tests only: { op: "tp", x, y } moves the player to a free spot next to (x, y);
 * { op: "kill" } kills them (no killer). Never registered in production.
 */
function devHook(m: Match, client: Client, raw: unknown): void {
  if (m.ended || !raw || typeof raw !== "object") return;
  const rt = m.runtime(client.sessionId);
  if (!rt?.pub.alive) return;
  const r = raw as Record<string, unknown>;
  if (r.op === "tp" && typeof r.x === "number" && typeof r.y === "number" && Number.isFinite(r.x) && Number.isFinite(r.y)) {
    const at = dropSpot(m, r.x, r.y, 0);
    rt.pub.x = at.x;
    rt.pub.y = at.y;
  } else if (r.op === "kill") {
    killPlayer(m, rt, null, "");
  }
}

// ---------------------------------------------------------------- launch options

/** What MatchmakingRoom.launch adds to the battle's create options. */
export interface RaidLaunchOptions {
  matchId: string;
  mapSeed: number;
  /** Server-secret loot / NPC seed (Match.lootSeed; never synced to clients). */
  lootSeed: number;
  mode: RaidMode;
  /** raids/start accepted snapshots (live only). */
  loadouts: LoadoutSnapshot[];
  /** raids/start pool allocation by container index (live only). */
  containerLoot: Record<string, SettledItem[]>;
  /** raids/start autosell multiplier (1 in demo). */
  autosellMult: number;
}

const MAX_ENTRIES = 4 + 4 + 16;
const MAX_POOL_PER_CONTAINER = 16;
/**
 * containerLoot keys raids/start may use: a container index, a boss bag "boss:<kind>" (v4), the
 * legacy "boss" share, or a marauder carrier "npc:<post>.<member>" (v5). Anything else is dropped
 * (never registered: the web sweeps it back to the pool).
 */
const POOL_KEY_RE = /^(?:\d{1,6}|boss|boss:[a-z]{1,16}|npc:\d{1,5}\.\d{1,2})$/;

function sanitizeItem(raw: unknown, seen: Set<string>, needUid: boolean): SettledItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!str(r.def, 32) || !str(r.uid, 64)) return null;
  const d = itemDef(r.def);
  if (!d) return null;
  if (d.unique) {
    // A uid twice would put one DB item into the match twice (duplication).
    if (!r.uid || seen.has(r.uid)) return null;
    seen.add(r.uid);
  } else if (needUid || r.uid !== "") {
    return null;
  }
  const qty = d.unique ? 1 : r.qty;
  if (!intIn(qty, 1, d.stack)) return null;
  const rarity = intIn(r.rarity, 0, 3) ? r.rarity : 0;
  const dur = typeof r.dur === "number" && Number.isFinite(r.dur) && r.dur >= 0 && r.dur <= 10_000 ? r.dur : 0;
  const out: SettledItem = { uid: r.uid, def: r.def, qty, rarity, dur };
  if (str(r.label, 32) && r.label) out.label = r.label;
  if (intIn(r.lvl, 0, 1000) && r.lvl) out.lvl = r.lvl;
  return out;
}

/**
 * Sanitize the launch part of the battle's create options against the (already sanitized) roster.
 * Unknown / malformed parts fall back to the safe default: demo mode, no loadouts, no pool.
 */
export function raidOptions(raw: unknown, roster: readonly RosterEntry[]): Partial<MatchOptions> {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: Partial<MatchOptions> = {};
  if (str(o.matchId, 64) && /^[0-9a-zA-Z-]{8,64}$/.test(o.matchId)) out.matchId = o.matchId;
  if (intIn(o.mapSeed, 0, 0xffffffff)) out.mapSeed = o.mapSeed;
  if (intIn(o.lootSeed, 0, 0xffffffff)) out.lootSeed = o.lootSeed;
  const mode: RaidMode = o.mode === "live" ? "live" : "demo";
  out.mode = mode;
  if (mode !== "live") return out;

  const seen = new Set<string>();
  const loadouts: LoadoutSnapshot[] = [];
  const byUser = new Map(roster.filter((r) => r.isBot !== true && r.userId).map((r) => [r.userId!, r.loadoutId ?? ""]));
  for (const s of Array.isArray(o.loadouts) ? o.loadouts.slice(0, roster.length) : []) {
    if (!s || typeof s !== "object") continue;
    const snap = s as Record<string, unknown>;
    if (!str(snap.userId) || !str(snap.loadoutId) || !snap.loadoutId) continue;
    // Only the loadout this seat's signed ticket locked, once per user.
    if (byUser.get(snap.userId) !== snap.loadoutId || loadouts.some((l) => l.userId === snap.userId)) continue;
    const entries: LoadoutSnapshot["entries"] = [];
    const keys = new Set<string>();
    for (const e of Array.isArray(snap.entries) ? snap.entries.slice(0, MAX_ENTRIES) : []) {
      const key = (e as Record<string, unknown> | null)?.key;
      if (!isSlotKey(key) || keys.has(key)) continue;
      const it = sanitizeItem(e, seen, false);
      if (!it) continue;
      keys.add(key);
      entries.push({ ...it, key });
    }
    loadouts.push({ loadoutId: snap.loadoutId, userId: snap.userId, level: intIn(snap.level, 0, 1000) ? snap.level : 0, entries });
  }
  out.loadouts = loadouts;

  const pool: Record<string, SettledItem[]> = {};
  const cl = o.containerLoot && typeof o.containerLoot === "object" ? (o.containerLoot as Record<string, unknown>) : {};
  for (const [k, list] of Object.entries(cl)) {
    if (!POOL_KEY_RE.test(k) || !Array.isArray(list)) continue;
    const items: SettledItem[] = [];
    for (const raw of list.slice(0, MAX_POOL_PER_CONTAINER)) {
      const it = sanitizeItem(raw, seen, true);
      if (it) items.push(it);
    }
    if (items.length) pool[k] = items;
  }
  out.containerLoot = pool;
  return out;
}
