/**
 * Friends and party rules as pure functions (the DB services in friends.ts / party.ts feed them
 * counts and rows; the tests cover every branch). Limits come from @extract/shared FRIENDS / PARTY.
 */
import { FRIENDS, PARTY, type PartyDropInfo, type Presence } from "@extract/shared";
import type { SocialErrCode } from "./types";

/** Same rule as registration (api/auth/register): 2–16 letters, digits, underscores. */
export const NICKNAME_RE = /^[A-Za-z0-9_]{2,16}$/;

/** A typed nickname ("  @Raider_1 " → "Raider_1"), or null when it cannot be one. */
export function parseNickname(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().replace(/^@/, "");
  return NICKNAME_RE.test(s) ? s : null;
}

/**
 * The unordered pair key: user_lo < user_hi (lowercase uuid text order = Postgres uuid order, since
 * the dashes sit at the same places). null for a user and themselves.
 */
export function friendPair(a: string, b: string): { lo: string; hi: string } | null {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) return null;
  return x < y ? { lo: x, hi: y } : { lo: y, hi: x };
}

export type PairRow = { status: "pending" | "accepted"; requestedBy: string } | null;

export interface RequestInput {
  me: string;
  target: string;
  existing: PairRow;
  myFriends: number;
  myPendingOut: number;
  theirFriends: number;
  theirPendingIn: number;
}

export type RequestDecision = { kind: "insert" } | { kind: "accept" } | { kind: "error"; code: SocialErrCode };

/**
 * A friend request to `target`: a pending request from them is accepted instead (both asked), an
 * existing pair or request is reported, otherwise the limits decide (FRIENDS.MAX_FRIENDS on both
 * sides, FRIENDS.MAX_PENDING sent by me and received by them).
 */
export function requestDecision(i: RequestInput): RequestDecision {
  if (i.me.toLowerCase() === i.target.toLowerCase()) return { kind: "error", code: "self" };
  if (i.existing?.status === "accepted") return { kind: "error", code: "already_friends" };
  if (i.existing?.status === "pending") {
    if (i.existing.requestedBy.toLowerCase() === i.me.toLowerCase()) return { kind: "error", code: "already_sent" };
    const limit = acceptLimit(i.myFriends, i.theirFriends);
    return limit ? { kind: "error", code: limit } : { kind: "accept" };
  }
  if (i.myFriends >= FRIENDS.MAX_FRIENDS) return { kind: "error", code: "friend_limit" };
  if (i.theirFriends >= FRIENDS.MAX_FRIENDS) return { kind: "error", code: "target_full" };
  if (i.myPendingOut >= FRIENDS.MAX_PENDING) return { kind: "error", code: "pending_limit" };
  if (i.theirPendingIn >= FRIENDS.MAX_PENDING) return { kind: "error", code: "target_busy" };
  return { kind: "insert" };
}

/** Accepting makes both sides one friend more: null when both still fit. */
export function acceptLimit(myFriends: number, theirFriends: number): SocialErrCode | null {
  if (myFriends >= FRIENDS.MAX_FRIENDS) return "friend_limit";
  if (theirFriends >= FRIENDS.MAX_FRIENDS) return "target_full";
  return null;
}

/** On the map now (an active entry of a running shard) beats the menu; the menu counts for 2 min. */
export function presenceOf(seenAt: number | null, inRaid: boolean, now: number): Presence {
  if (inRaid) return "raid";
  if (seenAt !== null && now - seenAt <= FRIENDS.ONLINE_WINDOW_MS && seenAt <= now + 60_000) return "online";
  return "offline";
}

const PRESENCE_ORDER: Record<Presence, number> = { raid: 0, online: 1, offline: 2 };

/** Friends list order: on the map, then online, then offline; by nickname (case-insensitive) within. */
export function comparePresence(a: { presence: Presence; nickname: string }, b: { presence: Presence; nickname: string }): number {
  return PRESENCE_ORDER[a.presence] - PRESENCE_ORDER[b.presence] || a.nickname.toLowerCase().localeCompare(b.nickname.toLowerCase());
}

// ---------------------------------------------------------------------------- party

export function inviteExpiresAt(now: number): number {
  return now + PARTY.INVITE_TTL_MS;
}

export function inviteLive(expiresAt: number, now: number): boolean {
  return now < expiresAt;
}

export interface InviteInput {
  /** The inviter's party (null = none yet: inviting creates one with them as leader). */
  party: { isLeader: boolean; members: number; liveInvites: number } | null;
  targetIsMe: boolean;
  friends: boolean;
  /** The target is in a party with someone else (a party of one with no live invites does not count). */
  targetInParty: "mine" | "other" | null;
  alreadyInvited: boolean;
}

/** Leader only; friends only; members + live invites stay within PARTY.MAX_SIZE. */
export function inviteDecision(i: InviteInput): SocialErrCode | null {
  if (i.targetIsMe) return "self";
  if (i.party && !i.party.isLeader) return "not_leader";
  if (!i.friends) return "not_friends";
  if (i.targetInParty === "mine") return "already_member";
  if (i.targetInParty === "other") return "target_in_party";
  if (i.alreadyInvited) return "already_invited";
  const used = i.party ? i.party.members + i.party.liveInvites : 1;
  if (used >= PARTY.MAX_SIZE) return "party_full";
  return null;
}

/**
 * Accepting an invite. `myParty` = the caller's current party: a party of one (no other members) is
 * dissolved on accept; one with others has to be left first.
 */
export function acceptDecision(i: {
  invite: { expiresAt: number } | null;
  now: number;
  members: number;
  myParty: { id: string; members: number } | null;
  partyId: string;
}): SocialErrCode | null {
  if (!i.invite) return "no_invite";
  if (!inviteLive(i.invite.expiresAt, i.now)) return "invite_expired";
  if (i.myParty && i.myParty.id === i.partyId) return "already_member";
  if (i.myParty && i.myParty.members > 1) return "in_other_party";
  if (i.members >= PARTY.MAX_SIZE) return "party_full";
  return null;
}

/** A party with fewer than PARTY.MIN_SIZE members and nobody invited is dissolved. */
export function partyShouldDissolve(members: number, liveInvites: number): boolean {
  return members < PARTY.MIN_SIZE && liveInvites === 0;
}

/** The leader starts a drop only for a real party (≥ PARTY.MIN_SIZE members). */
export function partyCanDrop(members: number): boolean {
  return members >= PARTY.MIN_SIZE;
}

/** A new drop: leader first, members de-duplicated, open for PARTY.DROP_TTL_MS. */
export function buildPartyDrop(p: {
  dropId: string;
  partyId: string;
  leaderId: string;
  members: readonly string[];
  cycle: number;
  matchId: string;
  now: number;
}): PartyDropInfo {
  const members = [p.leaderId, ...p.members.filter((m) => m !== p.leaderId)].filter((m, i, a) => a.indexOf(m) === i);
  return {
    dropId: p.dropId,
    partyId: p.partyId,
    cycle: p.cycle,
    matchId: p.matchId,
    leaderId: p.leaderId,
    members,
    createdAt: p.now,
    expiresAt: p.now + PARTY.DROP_TTL_MS,
  };
}

/** `userId` may follow `drop` at `now` on cycle `cycle` (listed at drop time, still open, same map). */
export function canFollowDrop(drop: PartyDropInfo | null, userId: string, cycle: number, now: number): boolean {
  if (!drop) return false;
  return drop.cycle === cycle && now >= drop.createdAt - 5_000 && now < drop.expiresAt && drop.members.includes(userId);
}

// ---------------------------------------------------------------------------- error text and status

export const SOCIAL_ERR: Readonly<Record<SocialErrCode, { status: number; message: string }>> = {
  unauthenticated: { status: 401, message: "Sign in first." },
  guest: { status: 403, message: "Register to add friends and play in a party." },
  bad_body: { status: 400, message: "That request is malformed." },
  rate_limited: { status: 429, message: "Too many requests. Wait a moment and try again." },
  not_found: { status: 404, message: "No raider with that nickname." },
  self: { status: 400, message: "That's you." },
  already_friends: { status: 409, message: "You're already friends." },
  already_sent: { status: 409, message: "Request already sent." },
  friend_limit: { status: 409, message: `You have ${FRIENDS.MAX_FRIENDS} friends — remove one first.` },
  pending_limit: { status: 409, message: `You have ${FRIENDS.MAX_PENDING} requests waiting. Cancel some first.` },
  target_full: { status: 409, message: "Their friends list is full." },
  target_busy: { status: 409, message: "They have too many requests waiting. Try later." },
  no_request: { status: 404, message: "That request is gone." },
  not_friends: { status: 409, message: "You can only invite friends." },
  not_leader: { status: 403, message: "Only the party leader can do that." },
  not_in_party: { status: 409, message: "You're not in a party." },
  not_member: { status: 404, message: "They're not in your party." },
  party_full: { status: 409, message: `A party holds ${PARTY.MAX_SIZE} raiders.` },
  in_other_party: { status: 409, message: "Leave your current party first." },
  target_in_party: { status: 409, message: "They're already in a party." },
  already_invited: { status: 409, message: "Already invited." },
  already_member: { status: 409, message: "Already in the party." },
  no_invite: { status: 404, message: "That invite is gone." },
  invite_expired: { status: 410, message: "That invite expired." },
};
