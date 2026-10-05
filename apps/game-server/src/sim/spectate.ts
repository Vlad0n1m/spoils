/**
 * Spectating a party mate after your own run ended (C2S.SPECTATE / S2C.SPECTATE). Pure rules; the
 * room (battle-room.ts) keeps who watches whom, ViewSync mirrors the state view (views.ts) and
 * spectatorBatch below mirrors the `ev` batch.
 *
 * Who may watch whom:
 * - the spectator is a human whose CURRENT runtime on this shard left the map dead or extracted (an
 *   older entry of a user who came back in, a runtime still on the map, an MIA after the wipe: no);
 * - the target is the current runtime of another human with the same non-empty partyId, still on
 *   the map (alive). Anyone outside the party, an NPC, yourself: refused.
 *
 * Fog: the spectator gets the mate's view, never more. Players = the mate's published vision row
 * (the same row the mate's own client decodes), items / corpses = the mate's AOI ring with the
 * mate's disclosure rights, events = the mate's own batch (clipped shots, blanked ids, sounds as
 * heard by the mate). The mate's owner-only data never crosses: no SelfState entry, no search
 * loot entry, no XP, no personal outcome. Allies already see each other's positions through
 * S2C.PARTY, so a mate's view tells a party member nothing the mate could not tell them on voice.
 */

import type { EventsMsg, SpectateEndReason } from "@extract/shared";
import { offMap } from "./audience.js";
import type { Match } from "./match.js";
import type { PlayerRuntime } from "./types.js";

export type SpectateRefusal = "not_out" | "no_party" | "not_mate" | "mate_gone" | "ended";

export type SpectateCheck = { ok: true; target: PlayerRuntime } | { ok: false; reason: SpectateRefusal };

/** The spectator's run is over (dead / extracted) and this is still the user's current runtime. */
function outOfRun(m: Match, s: PlayerRuntime): boolean {
  if (s.isNpc || !s.userId || s.pub.alive) return false;
  const exit = s.exitReport?.exit;
  if (exit !== "dead" && exit !== "extract") return false;
  return m.currentOf(s.userId) === s;
}

/** A human's current runtime, still on the map. */
function onMapNow(m: Match, t: PlayerRuntime): boolean {
  return !t.isNpc && !!t.userId && t.pub.alive && m.currentOf(t.userId) === t;
}

/** May roster `spectator` watch the party mate whose self key is `key`? */
export function spectateTarget(m: Match, spectator: number, key: unknown): SpectateCheck {
  if (m.ended || m.state.phase === "ended") return { ok: false, reason: "ended" };
  const s = m.rosterRuntime(spectator);
  if (!s || !outOfRun(m, s)) return { ok: false, reason: "not_out" };
  if (!s.partyId) return { ok: false, reason: "no_party" };
  if (typeof key !== "string" || key.length === 0 || key.length > 16) return { ok: false, reason: "not_mate" };
  const t = m.allRuntimes().find((rt) => rt.selfKey === key);
  if (!t || t === s || t.isNpc || t.partyId !== s.partyId) return { ok: false, reason: "not_mate" };
  if (!onMapNow(m, t)) return { ok: false, reason: "mate_gone" };
  return { ok: true, target: t };
}

/**
 * Why watching `target` must stop now, or null while it may go on. Checked every tick after the
 * step: the tick in which the mate dies or extracts still counts as on the map (offMap), so the
 * spectator decodes the mate's final patch (alive = false) before the view is let go.
 */
export function spectateEnd(m: Match, spectator: number, target: number): SpectateEndReason | null {
  const s = m.rosterRuntime(spectator);
  const t = m.rosterRuntime(target);
  if (!s || !t || !outOfRun(m, s) || t.partyId !== s.partyId || !s.partyId) return "stopped";
  if (t.userId && m.currentOf(t.userId) !== t) return "mate_out";
  if (!offMap(m, target)) return m.ended || m.state.phase === "ended" ? "wipe" : null;
  const exit = t.exitReport?.exit;
  if (exit === "extract") return "mate_out";
  if (exit === "mia" || exit === "timeout") return "wipe";
  return "mate_down";
}

/**
 * The `ev` batch a spectator gets: the world part of the mate's batch (what the mate sees and
 * hears) plus the spectator's own personal lines (kill feed, XP). Undefined when both are empty.
 */
export function spectatorBatch(own: EventsMsg | undefined, mate: EventsMsg | undefined): EventsMsg | undefined {
  const out: EventsMsg = {};
  if (mate) {
    if (mate.shots) out.shots = mate.shots;
    if (mate.hits) out.hits = mate.hits;
    if (mate.chest) out.chest = mate.chest;
    if (mate.snd) out.snd = mate.snd;
    if (mate.nades) out.nades = mate.nades;
    if (mate.booms) out.booms = mate.booms;
    if (mate.boss) out.boss = mate.boss;
    if (mate.fight) out.fight = mate.fight;
  }
  if (own?.kills) out.kills = own.kills;
  if (own?.xp) out.xp = own.xp;
  return Object.keys(out).length > 0 ? out : undefined;
}
