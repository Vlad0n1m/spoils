/**
 * Friends and party rules (pure): pair keys, request / accept limits, presence, invite expiry and
 * invite / accept decisions, drop creation and following, the social throttle.
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/social/rules.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FRIENDS, PARTY, worldCycleOf } from "@extract/shared";
import { SocialLimiter } from "./rate-limit";
import {
  SOCIAL_ERR,
  acceptDecision,
  acceptLimit,
  buildPartyDrop,
  canFollowDrop,
  comparePresence,
  friendPair,
  inviteDecision,
  inviteExpiresAt,
  inviteLive,
  parseNickname,
  partyCanDrop,
  partyShouldDissolve,
  presenceOf,
  requestDecision,
  type RequestInput,
} from "./rules";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

describe("friendPair", () => {
  it("is unordered: both orders give the same (lo, hi) key", () => {
    assert.deepEqual(friendPair(A, B), { lo: A, hi: B });
    assert.deepEqual(friendPair(B, A), { lo: A, hi: B });
  });
  it("is case-insensitive and refuses a user and themselves", () => {
    assert.deepEqual(friendPair(B.toUpperCase(), A), { lo: A, hi: B });
    assert.equal(friendPair(A, A), null);
    assert.equal(friendPair(A, A.toUpperCase()), null);
  });
  it("matches Postgres uuid order (byte order = lowercase hex order)", () => {
    const x = "0fffffff-ffff-4fff-8fff-ffffffffffff";
    const y = "f0000000-0000-4000-8000-000000000000";
    assert.deepEqual(friendPair(y, x), { lo: x, hi: y });
  });
});

describe("parseNickname", () => {
  it("trims, drops a leading @ and keeps the register rule", () => {
    assert.equal(parseNickname("  @Raider_1 "), "Raider_1");
    assert.equal(parseNickname("ab"), "ab");
    assert.equal(parseNickname("a"), null);
    assert.equal(parseNickname("x".repeat(17)), null);
    assert.equal(parseNickname("bad name"), null);
    assert.equal(parseNickname("<script>"), null);
    assert.equal(parseNickname(42), null);
  });
});

describe("requestDecision", () => {
  const base: RequestInput = { me: A, target: B, existing: null, myFriends: 0, myPendingOut: 0, theirFriends: 0, theirPendingIn: 0 };

  it("a fresh pair is inserted; self is refused", () => {
    assert.deepEqual(requestDecision(base), { kind: "insert" });
    assert.deepEqual(requestDecision({ ...base, target: A }), { kind: "error", code: "self" });
  });
  it("an existing pair: already friends / already sent / their request is accepted instead", () => {
    assert.deepEqual(requestDecision({ ...base, existing: { status: "accepted", requestedBy: B } }), { kind: "error", code: "already_friends" });
    assert.deepEqual(requestDecision({ ...base, existing: { status: "pending", requestedBy: A } }), { kind: "error", code: "already_sent" });
    assert.deepEqual(requestDecision({ ...base, existing: { status: "pending", requestedBy: B } }), { kind: "accept" });
  });
  it("limits: 100 friends on either side, 20 pending sent by me / received by them", () => {
    assert.equal(FRIENDS.MAX_FRIENDS, 100);
    assert.equal(FRIENDS.MAX_PENDING, 20);
    assert.deepEqual(requestDecision({ ...base, myFriends: 99 }), { kind: "insert" });
    assert.deepEqual(requestDecision({ ...base, myFriends: 100 }), { kind: "error", code: "friend_limit" });
    assert.deepEqual(requestDecision({ ...base, theirFriends: 100 }), { kind: "error", code: "target_full" });
    assert.deepEqual(requestDecision({ ...base, myPendingOut: 19 }), { kind: "insert" });
    assert.deepEqual(requestDecision({ ...base, myPendingOut: 20 }), { kind: "error", code: "pending_limit" });
    assert.deepEqual(requestDecision({ ...base, theirPendingIn: 20 }), { kind: "error", code: "target_busy" });
  });
  it("accepting their request still respects the friend limit, not the pending one", () => {
    const theirs = { ...base, existing: { status: "pending" as const, requestedBy: B } };
    assert.deepEqual(requestDecision({ ...theirs, myPendingOut: 20, theirPendingIn: 20 }), { kind: "accept" });
    assert.deepEqual(requestDecision({ ...theirs, myFriends: 100 }), { kind: "error", code: "friend_limit" });
    assert.deepEqual(requestDecision({ ...theirs, theirFriends: 100 }), { kind: "error", code: "target_full" });
    assert.equal(acceptLimit(99, 99), null);
  });
});

describe("presence", () => {
  const now = 10_000_000;
  it("in a raid beats the menu; the menu counts for 2 minutes", () => {
    assert.equal(presenceOf(now - 1_000, true, now), "raid");
    assert.equal(presenceOf(null, true, now), "raid");
    assert.equal(presenceOf(now - FRIENDS.ONLINE_WINDOW_MS, false, now), "online");
    assert.equal(presenceOf(now - FRIENDS.ONLINE_WINDOW_MS - 1, false, now), "offline");
    assert.equal(presenceOf(null, false, now), "offline");
  });
  it("sorts on the map, online, offline, then by nickname", () => {
    const rows = [
      { presence: "offline" as const, nickname: "ann" },
      { presence: "online" as const, nickname: "zed" },
      { presence: "raid" as const, nickname: "bob" },
      { presence: "online" as const, nickname: "Abe" },
    ].sort(comparePresence);
    assert.deepEqual(rows.map((r) => r.nickname), ["bob", "Abe", "zed", "ann"]);
  });
});

describe("party invites", () => {
  const now = 50_000_000;
  it("expire after 10 minutes", () => {
    assert.equal(PARTY.INVITE_TTL_MS, 600_000);
    const exp = inviteExpiresAt(now);
    assert.equal(exp, now + 600_000);
    assert.equal(inviteLive(exp, now + 599_999), true);
    assert.equal(inviteLive(exp, exp), false);
  });

  const ok = { party: null, targetIsMe: false, friends: true, targetInParty: null, alreadyInvited: false } as const;
  it("friends only; leader only; a target in another party or already invited is refused", () => {
    assert.equal(inviteDecision(ok), null, "no party yet: inviting creates one");
    assert.equal(inviteDecision({ ...ok, targetIsMe: true }), "self");
    assert.equal(inviteDecision({ ...ok, friends: false }), "not_friends");
    assert.equal(inviteDecision({ ...ok, party: { isLeader: false, members: 2, liveInvites: 0 } }), "not_leader");
    assert.equal(inviteDecision({ ...ok, targetInParty: "other" }), "target_in_party");
    assert.equal(inviteDecision({ ...ok, targetInParty: "mine" }), "already_member");
    assert.equal(inviteDecision({ ...ok, alreadyInvited: true }), "already_invited");
  });
  it("members + live invites stay within 4", () => {
    assert.equal(inviteDecision({ ...ok, party: { isLeader: true, members: 3, liveInvites: 0 } }), null);
    assert.equal(inviteDecision({ ...ok, party: { isLeader: true, members: 2, liveInvites: 1 } }), null);
    assert.equal(inviteDecision({ ...ok, party: { isLeader: true, members: 2, liveInvites: 2 } }), "party_full");
    assert.equal(inviteDecision({ ...ok, party: { isLeader: true, members: 4, liveInvites: 0 } }), "party_full");
  });
  it("accept: live invite, room in the party, a party of one is left behind, a real party is not", () => {
    const inv = { expiresAt: now + 1 };
    const a = { invite: inv, now, members: 1, myParty: null, partyId: A };
    assert.equal(acceptDecision(a), null);
    assert.equal(acceptDecision({ ...a, invite: null }), "no_invite");
    assert.equal(acceptDecision({ ...a, invite: { expiresAt: now } }), "invite_expired");
    assert.equal(acceptDecision({ ...a, members: 4 }), "party_full");
    assert.equal(acceptDecision({ ...a, myParty: { id: B, members: 1 } }), null);
    assert.equal(acceptDecision({ ...a, myParty: { id: B, members: 2 } }), "in_other_party");
    assert.equal(acceptDecision({ ...a, myParty: { id: A, members: 2 } }), "already_member");
  });
  it("a party under 2 with nobody invited dissolves; drops need 2+", () => {
    assert.equal(partyShouldDissolve(1, 0), true);
    assert.equal(partyShouldDissolve(1, 1), false);
    assert.equal(partyShouldDissolve(2, 0), false);
    assert.equal(partyCanDrop(1), false);
    assert.equal(partyCanDrop(2), true);
  });
});

describe("party drops", () => {
  const now = 70_000_000;
  const drop = buildPartyDrop({ dropId: "d", partyId: "p", leaderId: B, members: [A, B, C, A], cycle: 7, matchId: "m", now });

  it("leader first, members de-duplicated, open for 60 s", () => {
    assert.deepEqual(drop, { dropId: "d", partyId: "p", cycle: 7, matchId: "m", leaderId: B, members: [B, A, C], createdAt: now, expiresAt: now + 60_000 });
    assert.equal(PARTY.DROP_TTL_MS, 60_000);
  });
  it("a member may follow a drop of the closing previous map until the window ends or that map wipes", () => {
    const k = 900_000;
    const wc = worldCycleOf(k);
    const late = buildPartyDrop({ dropId: "d", partyId: "p", leaderId: B, members: [A, B], cycle: k, matchId: "m", now: wc.entryClosesAt - 20_000 });
    assert.equal(canFollowDrop(late, A, k + 1, wc.entryClosesAt + 30_000), true, "the next map opened meanwhile");
    assert.equal(canFollowDrop(late, A, k + 1, late.expiresAt), false, "window over");
    assert.equal(canFollowDrop({ ...late, expiresAt: wc.wipeAt + 1 }, A, k + 1, wc.wipeAt), false, "the drop's map wiped");
    assert.equal(canFollowDrop(late, A, k + 2, wc.entryClosesAt + 30_000), false, "two maps on");
  });
  it("members listed at drop time may follow on the same map until it expires", () => {
    assert.equal(canFollowDrop(drop, A, 7, now + 1_000), true);
    assert.equal(canFollowDrop(drop, C, 7, now + 59_999), true);
    assert.equal(canFollowDrop(drop, A, 7, now + 60_000), false, "expired");
    assert.equal(canFollowDrop(drop, A, 6, now + 1_000), false, "a drop of a later map than the open one");
    assert.equal(canFollowDrop(drop, A, 9, now + 1_000), false, "two maps on");
    assert.equal(canFollowDrop(drop, "44444444-4444-4444-8444-444444444444", 7, now), false, "joined the party after the drop");
    assert.equal(canFollowDrop(null, A, 7, now), false);
  });
});

describe("SocialLimiter", () => {
  it("allows a burst of 20, then one request per 3 s", () => {
    const l = new SocialLimiter({ burst: 20, refillMs: 3_000, maxKeys: 100 });
    for (let i = 0; i < 20; i++) assert.equal(l.take("u", 0).ok, true);
    const d = l.take("u", 0);
    assert.equal(d.ok, false);
    assert.equal(!d.ok && d.retryAfterSec, 3);
    assert.equal(l.take("u", 3_000).ok, true);
    assert.equal(l.take("v", 0).ok, true, "per user");
  });
  it("keeps at most maxKeys users", () => {
    const l = new SocialLimiter({ burst: 1, refillMs: 1_000, maxKeys: 2 });
    l.take("a", 0);
    l.take("b", 0);
    l.take("c", 0);
    assert.equal(l.take("a", 0).ok, true, "a was evicted (least recently used)");
  });
});

describe("error table", () => {
  it("every code has an HTTP status and an English sentence", () => {
    for (const [code, e] of Object.entries(SOCIAL_ERR)) {
      assert.ok(e.status >= 400 && e.status < 500, code);
      assert.match(e.message, /^[A-Z].*[.]$/, code);
    }
  });
});
