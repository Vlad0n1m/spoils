/**
 * Friends and parties: the contract between the web (lib/social, POST /api/world/join) and the game
 * server. Social state (friend pairs, parties, invites, drops) lives in the web's Postgres; the game
 * server only ever sees what a signed JoinTicket carries.
 *
 * Party drop (spawn together), WORLD v6:
 *   1. The first party member to press PLAY (leader or not) → POST /api/world/join. With ≥
 *      PARTY.MIN_SIZE members and no live drop, the web claims a new PartyDropInfo (one live drop per
 *      party, under the party row lock) for the open cycle and a shard with room for the whole party,
 *      and signs `dropId` + `partyId` into that member's JoinTicket.
 *   2. The others learn about the drop by polling GET /api/party (every PARTY.POLL_MS while in a
 *      party): the menu prompts "Rook dropped into Map #N — PLAY to join them", or joins at once with
 *      "Follow leader" on. Any member's PLAY while the drop is open is pinned to the drop's own cycle and
 *      shard — also when that map has stopped taking entries meanwhile (maps overlap: the closing map
 *      still admits a drop's later members, below) — and their ticket carries the same `dropId` and
 *      `partyId`. After `expiresAt` (createdAt + PARTY.DROP_TTL_MS), or when the drop's map is gone,
 *      the next member's PLAY starts a fresh drop. A member who joined the party after the drop
 *      started drops on their own (ticket with `partyId` only).
 *   3. Game server (apps/game-server world/directory.ts, sim/spawn.ts): the first admitted ticket of a
 *      `dropId` picks a normal spawn (the landing zone, kept off the bodies of the party) and holds
 *      `dropSize` seats on the shard for 60 s; later tickets with the same `dropId` spawn
 *      PARTY.SPAWN_MIN_PX–PARTY.SPAWN_NEAR_PX from the landing zone on its side (same extracts),
 *      even when the first member has moved on or a stranger stands nearby. A member who already
 *      landed with the drop and re-enters takes a normal spawn. After the shard's entry close (a
 *      closing map) only later members of a drop admitted there get in, while its window runs and a
 *      held seat is free; everyone else gets entry_closed.
 * Each member still locks their own loadout; the risk rule, pool limits and settlement stay per player.
 * Party members on the same shard: no damage between them (PARTY.FRIENDLY_FIRE = false, see
 * partyMates) and S2C.PARTY with their positions at ~PARTY.POS_HZ. Rejoin tickets (an active entry)
 * carry no party fields: the runtime keeps the party it was admitted with.
 * The party is a convenience feature: nothing in it is bought, and it never changes loot, prices or
 * damage against anyone outside the party.
 */

export const PARTY = {
  /** A party drops together from this many members (a party of one drops solo). */
  MIN_SIZE: 2,
  /** Members of one party, leader included. Pending invites count toward it. */
  MAX_SIZE: 4,
  /** A party invite expires this long after it was sent. */
  INVITE_TTL_MS: 10 * 60_000,
  /** Members can follow a party drop this long after the first member pressed PLAY. */
  DROP_TTL_MS: 60_000,
  /** Menu poll of GET /api/party while in a party (drop prompt, members, ready state). */
  POLL_MS: 5_000,
  /** Menu poll of GET /api/party outside a party (incoming invites and friend requests, presence). */
  IDLE_POLL_MS: 20_000,
  /** S2C.PARTY rate (party mates' positions), per member. */
  POS_HZ: 2,
  /**
   * CONTRACT FLAG: party members cannot damage each other (bullets and any future area damage). The
   * game server checks partyMates(attacker, victim) before applying damage: a mate's HP, armor and
   * gear durability never change from a party mate's hit. Whether the bullet stops at the mate or
   * passes through is the server's choice.
   */
  FRIENDLY_FIRE: false,
  /**
   * Later members of a drop spawn at most this far from the drop's landing zone (its first
   * member's spot; game server spawn.ts PARTY_SPAWN_MAX_PX)…
   */
  SPAWN_NEAR_PX: 300,
  /** …and at least this far (spawn.ts PARTY_SPAWN_MIN_PX). */
  SPAWN_MIN_PX: 150,
} as const;

export const FRIENDS = {
  /** Accepted friends per user. */
  MAX_FRIENDS: 100,
  /** Pending requests per user, counted separately for sent and received. */
  MAX_PENDING: 20,
  /** "Online": the menu polled the social API this recently. */
  ONLINE_WINDOW_MS: 2 * 60_000,
} as const;

/** Friend / party member presence: in the menu recently, on the map now (active entry), or neither. */
export type Presence = "online" | "raid" | "offline";

/**
 * One party drop (web table party_drops). `leaderId` = the member who started it (the first to press
 * PLAY, party leader or not). `members` are userIds at drop time (starter first); only they may join
 * with this dropId. `matchId` = the shard the starter's join was issued for: the others' joins are
 * pinned to it (and to `cycle`) while it runs. Times are wall ms.
 */
export interface PartyDropInfo {
  dropId: string;
  partyId: string;
  cycle: number;
  matchId: string;
  leaderId: string;
  members: string[];
  createdAt: number;
  expiresAt: number;
}

/**
 * The party fields of a JoinTicket (all HMAC-signed, joinTicketPayload). `partyId`: the caller is in
 * a party of ≥ PARTY.MIN_SIZE (no friendly fire, S2C.PARTY). `dropId`: this join follows a live party
 * drop (spawn together). `dropSize`: the drop's member count (seats the shard holds for it). A ticket
 * never carries a dropId without its partyId, nor a dropSize without its dropId.
 */
export interface PartyTicketFields {
  dropId?: string;
  partyId?: string;
  dropSize?: number;
}

/** A drop can still be followed at `now`. */
export function partyDropLive(d: Pick<PartyDropInfo, "createdAt" | "expiresAt">, now: number): boolean {
  return now >= d.createdAt - 5_000 && now < d.expiresAt;
}

/**
 * The no-friendly-fire rule (PARTY.FRIENDLY_FIRE = false): true when two players on the same shard
 * are in the same party (the same non-empty partyId in their admission tickets), so neither can
 * damage the other. Always false when either side has no partyId (solo players, guests, NPCs).
 */
export function partyMates(a: string | undefined | null, b: string | undefined | null): boolean {
  return !PARTY.FRIENDLY_FIRE && typeof a === "string" && a.length > 0 && a === b;
}

/**
 * One party mate in S2C.PARTY: BattleState self key ("p<rosterIndex>"), the mate's current
 * BattleState.players key `id` (links the marker to the mate's entity while in view), nickname
 * `name` (the name tag), world px, alive.
 */
export interface PartyMatePos {
  key: string;
  id: string;
  name: string;
  x: number;
  y: number;
  alive: boolean;
}

/**
 * S2C.PARTY, to one party member at ~PARTY.POS_HZ while at least one mate shares the shard: the
 * positions of their party mates (never themselves, never anyone outside the party). Allies see each
 * other through walls and fog by design; nobody else learns these positions.
 */
export interface PartyMsg {
  mates: PartyMatePos[];
}
