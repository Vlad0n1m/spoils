/**
 * Party mates on a shard (shared party.ts): who sees whom in S2C.PARTY. A party is the set of human
 * runtimes admitted with the same partyId (JoinTicket.partyId; a rejoin keeps the runtime's own).
 * Each member gets the positions of their mates only — never their own, never anyone outside the
 * party — at ~PARTY.POS_HZ (battle-room.ts sends them). Mates see each other through walls and fog by
 * design (they are allies); fog and the StateView rules are unchanged for everyone else, and nothing
 * here touches BattleState.
 *
 * Listed mates: the user's current runtime (Match.currentOf) while it stands on the map, and for
 * MATE_DOWN_MS after it died (alive: false, at the body) so the client can mark where a mate fell.
 * Extracted, MIA and older entries of a user are left out.
 */

import type { PartyMatePos } from "@extract/shared";
import type { Match } from "./match.js";
import type { PlayerRuntime } from "./types.js";

/** A dead mate stays in S2C.PARTY (alive: false) this long after their death. */
export const MATE_DOWN_MS = 10_000;

/**
 * One mate as sent: the shared PartyMatePos plus the mate's nickname (name tag) and their current
 * BattleState.players key `id` (the client links the marker to the mate's entity while it is in view).
 * Cross-owner: both fields belong in packages/shared PartyMatePos.
 */
export interface PartyMateWire extends PartyMatePos {
  name: string;
  id: string;
}

export interface PartyWireMsg {
  mates: PartyMateWire[];
}

/** The runtime is listed for its mates (see the module comment). */
function listed(m: Match, rt: PlayerRuntime): boolean {
  if (rt.pub.alive) return true;
  return rt.exitReport?.exit === "dead" && m.clock - rt.pub.diedAt <= MATE_DOWN_MS;
}

/**
 * S2C.PARTY per recipient rosterIndex: every party member (current runtime of its user, any state)
 * whose party has at least one listed mate besides them. Members without mates are absent.
 */
export function partyPositions(m: Match): Map<number, PartyWireMsg> {
  const parties = new Map<string, PlayerRuntime[]>();
  for (const rt of m.allRuntimes()) {
    if (rt.isNpc || !rt.partyId || !rt.userId || m.currentOf(rt.userId) !== rt) continue;
    let list = parties.get(rt.partyId);
    if (!list) parties.set(rt.partyId, (list = []));
    list.push(rt);
  }
  const out = new Map<number, PartyWireMsg>();
  for (const members of parties.values()) {
    if (members.length < 2) continue;
    const shown = members.filter((rt) => listed(m, rt));
    for (const to of members) {
      const mates: PartyMateWire[] = [];
      for (const rt of shown) {
        if (rt === to) continue;
        mates.push({ key: rt.selfKey, id: rt.id, name: rt.nickname, x: Math.round(rt.pub.x), y: Math.round(rt.pub.y), alive: rt.pub.alive });
      }
      if (mates.length > 0) out.set(to.rosterIndex, { mates });
    }
  }
  return out;
}
