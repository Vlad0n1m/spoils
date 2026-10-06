/**
 * JSON shapes of the social API (GET /api/friends, POST /api/friends/<action>, GET /api/party,
 * POST /api/party/<action>). Types only, so the menu and the route handlers share one contract.
 * Other players are named by nickname (unique, public on the leaderboards); user ids never leave
 * the server. Times are wall ms.
 */
import type { Presence } from "@extract/shared";

export type { Presence } from "@extract/shared";

export interface FriendDto {
  nickname: string;
  level: number;
  presence: Presence;
  /** The friend's party: the caller's own, another one, or none. */
  party: "mine" | "other" | null;
  /** A live invite from the caller's party is waiting for them. */
  invited: boolean;
  /** Friends since. */
  since: number;
}

export interface FriendRequestDto {
  nickname: string;
  level: number;
  at: number;
}

/** GET /api/friends */
export interface FriendsDto {
  serverTime: number;
  friends: FriendDto[];
  incoming: FriendRequestDto[];
  outgoing: FriendRequestDto[];
  limits: { maxFriends: number; maxPending: number };
}

export interface PartyMemberDto {
  nickname: string;
  level: number;
  leader: boolean;
  /** "Follow leader" is on (ready to drop with the leader). The leader is always ready. */
  follow: boolean;
  presence: Presence;
  you: boolean;
  /** Seeker badge (lib/seeker): the member's linked wallet holds a Seeker Genesis Token. */
  seeker?: boolean;
}

export interface PartyDto {
  id: string;
  /** Leader nickname. */
  leader: string;
  isLeader: boolean;
  /** The caller's own "Follow leader". */
  follow: boolean;
  /** Leader first, then by join time. */
  members: PartyMemberDto[];
  /** Live invites sent by this party. */
  invited: Array<{ nickname: string; expiresAt: number }>;
  maxSize: number;
}

/** An invite to the caller (live). */
export interface PartyInviteDto {
  partyId: string;
  /** Who sent it (the leader at the time). */
  from: string;
  /** Members right now. */
  size: number;
  expiresAt: number;
}

/**
 * The caller's party's live drop the caller can still join (`cycle` = its map: the open one, or the
 * closing previous one). `leader` = nickname of the member who started it (the first to press PLAY,
 * party leader or not); `mine` = that was the caller.
 */
export interface PartyDropDto {
  dropId: string;
  cycle: number;
  leader: string;
  expiresAt: number;
  mine: boolean;
}

/** GET /api/party: everything the menu polls (party strip, invites, drop prompt, Friends dot). */
export interface PartyStateDto {
  serverTime: number;
  party: PartyDto | null;
  invites: PartyInviteDto[];
  drop: PartyDropDto | null;
  /** Incoming friend requests. */
  requests: number;
  /** When to poll next (PARTY.POLL_MS in a party, else PARTY.IDLE_POLL_MS). */
  pollMs: number;
}

export type SocialErrCode =
  | "unauthenticated"
  | "guest"
  | "bad_body"
  | "rate_limited"
  | "not_found"
  | "self"
  | "already_friends"
  | "already_sent"
  | "friend_limit"
  | "pending_limit"
  | "target_full"
  | "target_busy"
  | "no_request"
  | "not_friends"
  | "not_leader"
  | "not_in_party"
  | "not_member"
  | "party_full"
  | "in_other_party"
  | "target_in_party"
  | "already_invited"
  | "already_member"
  | "no_invite"
  | "invite_expired";

export interface SocialErrorBody {
  error: SocialErrCode;
  message: string;
  retryAfterSec?: number;
}

/** POST /api/friends/<action> and /api/party/<action> success body. */
export interface SocialOkBody {
  ok: true;
  /** friends/request: "accepted" when they had already asked you (the pair is now friends). */
  status?: "sent" | "accepted";
  /** One line for the menu toast. */
  message: string;
}
