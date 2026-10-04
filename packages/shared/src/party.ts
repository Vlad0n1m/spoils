/**
 * Friends and parties: the contract between the web (lib/social, POST /api/world/join) and the game
 * server. Social state (friend pairs, parties, invites, drops) lives in the web's Postgres; the game
 * server only ever sees what a signed JoinTicket carries.
 *
 * Party drop (spawn together), WORLD v6:
 *   1. The party leader presses PLAY → POST /api/world/join. With ≥ PARTY.MIN_SIZE members the web
 *      creates a PartyDropInfo (or reuses the party's live one) for this cycle and the leader's shard,
 *      and signs `dropId` + `partyId` into the leader's JoinTicket.
 *   2. Members learn about the drop by polling GET /api/party (every PARTY.POLL_MS while in a party):
 *      the menu prompts "Leader is dropping in — PLAY", or joins at once when the member turned on
 *      "Follow leader". Their /api/world/join is pinned to the drop's shard and their ticket carries the
 *      same `dropId` and `partyId`. After `expiresAt` (createdAt + PARTY.DROP_TTL_MS) a member drops on
 *      their own (ticket with `partyId` only).
 *   3. Game server (next step): the first admitted ticket of a `dropId` picks the spawn; later tickets
 *      with the same `dropId` spawn within PARTY.SPAWN_NEAR_PX of a living member of that drop.
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
  /** Members can follow a leader's drop this long after the leader pressed PLAY. */
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
  /** Later members of a drop spawn within this distance of a living member of the same drop. */
  SPAWN_NEAR_PX: 160,
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
 * One party drop (web table party_drops). `members` are userIds at drop time (leader first); only
 * they may join with this dropId. `matchId` = the shard the leader's join was issued for: members'
 * joins are pinned to it while it runs. Times are wall ms.
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
 * The party fields of a JoinTicket (both HMAC-signed, joinTicketPayload). `partyId`: the caller is in
 * a party of ≥ PARTY.MIN_SIZE (no friendly fire, S2C.PARTY). `dropId`: this join follows a live party
 * drop (spawn together). A ticket never carries a dropId without its partyId.
 */
export interface PartyTicketFields {
  dropId?: string;
  partyId?: string;
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

/** One party mate in S2C.PARTY: BattleState key ("p<rosterIndex>"), world px, alive. */
export interface PartyMatePos {
  key: string;
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
