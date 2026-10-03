/**
 * Battle-room glue of the inventory lane (WP-B). battle-room.ts only imports this module:
 * - registerInventoryHandlers: SEARCH_CLOSE / INV_MOVE / INV_TAKE_ALL / INV_DROP handlers. Shapes
 *   are validated here (untrusted input); the rules live in sim (containers.ts for search
 *   sessions, Match.invMove / invDrop for the player's own slots), which answer errors with INV_ERR.
 *   It also refreshes a player's OUTCOME once the web API settled their exit (final CR, receipt,
 *   XP), keyed by entryId (one user may have several entries in one world match).
 * - optional dev hooks (GAME_TEST_HOOKS=1, never in production) for scripted smoke tests.
 */

import type { Client, Room } from "@colyseus/core";
import { C2S, S2C, isSlotKey, type InvDropMsg, type InvMoveMsg, type OutcomeMsg } from "@extract/shared";
import { offExitSettled, onExitSettled, type ExitSettled } from "../net/web-api.js";
import { killPlayer } from "../sim/death.js";
import { dropSpot } from "../sim/inventory.js";
import type { Match } from "../sim/match.js";

const str = (v: unknown, max = 64): v is string => typeof v === "string" && v.length <= max;
const qtyOk = (v: unknown) => v === undefined || (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 999);

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

  // The web settles each exit (autosell multiplier, dog-tag rules, guest status, XP): refresh the
  // player's result with the final numbers (reconnects get rt.outcome as well).
  const matchId = match().state.matchId;
  offExitSettled(matchId);
  onExitSettled(matchId, (key, r) => applyExitSettled(room, match(), key, r));

  if (testHooksEnabled()) {
    room.onMessage(DEV_HOOK, (client, raw: unknown) => devHook(match(), client, raw));
  }
}

/**
 * Merge the web's settlement into the OUTCOME of the runtime that exit belonged to and resend it.
 * `key` = the exit report's entryId (world) or userId (legacy roster match). Exported for tests.
 */
export function applyExitSettled(room: Pick<Room, "clients">, m: Match, key: string, r: ExitSettled): OutcomeMsg | null {
  const rt = m.world ? m.entryById(key) : m.allRuntimes().find((x) => !x.isNpc && x.userId === key);
  if (!rt) return null;
  rt.exitSettled = true;
  if (!rt.outcome) return null;
  const merged: OutcomeMsg = { ...rt.outcome, credits: r.credits, sold: r.sold, guest: r.guest };
  if (r.xp !== undefined) merged.xp = r.xp;
  if (r.xpLines !== undefined) merged.xpLines = r.xpLines;
  if (r.level !== undefined) merged.level = r.level;
  if (r.levelUp !== undefined) merged.levelUp = r.levelUp;
  rt.outcome = merged;
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
