/**
 * Menu helpers of the social UI (pure): member chips, ready count, the Friends dot, fresh-invite
 * toasts, the drop prompt, Follow-leader auto-enter, the Invite button, error text.
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/social/menu.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WORLD } from "@extract/shared";
import {
  autoFollow,
  canInvite,
  dropPrompt,
  freshInvites,
  inviteBlockReason,
  memberChip,
  moreRequests,
  readyCount,
  secondsLeft,
  socialDotCount,
  socialErrorText,
} from "./menu";
import type { FriendDto, PartyDropDto, PartyDto, PartyMemberDto, PartyStateDto } from "./types";

const member = (over: Partial<PartyMemberDto> = {}): PartyMemberDto => ({
  nickname: "m",
  level: 3,
  leader: false,
  follow: false,
  presence: "online",
  you: false,
  ...over,
});

const partyOf = (over: Partial<PartyDto> = {}): PartyDto => ({
  id: "p",
  leader: "lead",
  isLeader: true,
  follow: false,
  members: [member({ nickname: "lead", leader: true, you: true })],
  invited: [],
  maxSize: 4,
  ...over,
});

const friend = (over: Partial<FriendDto> = {}): FriendDto => ({ nickname: "f", level: 2, presence: "online", party: null, invited: false, since: 0, ...over });

describe("memberChip / readyCount", () => {
  it("raid and offline win; then leader; members are READY when following", () => {
    assert.deepEqual(memberChip(member({ presence: "raid", leader: true })), { label: "IN RAID", tone: "sky" });
    assert.deepEqual(memberChip(member({ presence: "offline", follow: true })), { label: "OFFLINE", tone: "grey" });
    assert.deepEqual(memberChip(member({ leader: true })), { label: "LEADER", tone: "lime" });
    assert.deepEqual(memberChip(member({ follow: true })), { label: "READY", tone: "lime" });
    assert.deepEqual(memberChip(member()), { label: "NOT READY", tone: "amber" });
  });
  it("counts the leader and following members who are in the menu", () => {
    const p = partyOf({
      members: [
        member({ leader: true }),
        member({ follow: true }),
        member({ follow: false }),
        member({ follow: true, presence: "offline" }),
      ],
    });
    assert.deepEqual(readyCount(p), { ready: 2, total: 4 });
  });
});

describe("Friends dot and toasts", () => {
  const state = (requests: number, invites: number): PartyStateDto => ({
    serverTime: 0,
    party: null,
    invites: Array.from({ length: invites }, (_, i) => ({ partyId: `p${i}`, from: "x", size: 1, expiresAt: 1_000 })),
    drop: null,
    requests,
    pollMs: 20_000,
  });
  it("dot = requests + invites", () => {
    assert.equal(socialDotCount(null), 0);
    assert.equal(socialDotCount(state(0, 0)), 0);
    assert.equal(socialDotCount(state(2, 1)), 3);
  });
  it("toasts only invites and requests that arrive after the first poll", () => {
    const a = { partyId: "a", from: "x", size: 1, expiresAt: 5 };
    const b = { partyId: "b", from: "y", size: 2, expiresAt: 6 };
    assert.deepEqual(freshInvites(null, [a]), []);
    assert.deepEqual(freshInvites([a], [a, b]), [b]);
    assert.deepEqual(freshInvites([a, b], [b]), []);
    assert.deepEqual(freshInvites([a], [{ ...a, expiresAt: 9 }]).length, 1, "a re-sent invite counts again");
    assert.equal(moreRequests(null, 3), false);
    assert.equal(moreRequests(1, 2), true);
    assert.equal(moreRequests(2, 1), false);
  });
});

describe("drop prompt and Follow leader", () => {
  const now = 1_000_000;
  const drop: PartyDropDto = { dropId: "d1", cycle: 5, leader: "lead", expiresAt: now + 42_000, mine: false };

  it("shows another member's live drop while PLAY could join, with its map and the seconds left", () => {
    assert.deepEqual(dropPrompt({ drop, playKind: "ready", now, dismissed: null }), { dropId: "d1", leader: "lead", map: "Preview map", secondsLeft: 42 });
    const n = 4_000;
    const live = { ...drop, cycle: n - 1 + Math.floor(WORLD.NUMBER_EPOCH_MS / WORLD.CYCLE_MS) };
    assert.equal(dropPrompt({ drop: live, playKind: "ready", now, dismissed: null })?.map, `Map #${n}`);
  });
  it("hidden for the leader, after expiry, when dismissed, or when PLAY cannot join", () => {
    assert.equal(dropPrompt({ drop: { ...drop, mine: true }, playKind: "ready", now, dismissed: null }), null);
    assert.equal(dropPrompt({ drop, playKind: "ready", now: drop.expiresAt, dismissed: null }), null);
    assert.equal(dropPrompt({ drop, playKind: "ready", now, dismissed: "d1" }), null);
    for (const k of ["rejoin", "gear_in_raid", "closed", "joining", "loading", "offline"]) {
      assert.equal(dropPrompt({ drop, playKind: k, now, dismissed: null }), null, k);
    }
    assert.equal(dropPrompt({ drop: null, playKind: "ready", now, dismissed: null }), null);
  });
  it("auto-enters once per drop, only with Follow leader on and PLAY ready", () => {
    assert.equal(autoFollow({ drop, follow: true, playKind: "ready", now, attempted: null }), "d1");
    assert.equal(autoFollow({ drop, follow: true, playKind: "ready", now, attempted: "d1" }), null);
    assert.equal(autoFollow({ drop, follow: false, playKind: "ready", now, attempted: null }), null);
    assert.equal(autoFollow({ drop, follow: true, playKind: "gear_in_raid", now, attempted: null }), null);
    assert.equal(autoFollow({ drop: { ...drop, mine: true }, follow: true, playKind: "ready", now, attempted: null }), null);
    assert.equal(autoFollow({ drop, follow: true, playKind: "ready", now: drop.expiresAt, attempted: null }), null);
    assert.equal(autoFollow({ drop: { ...drop, dropId: "d2" }, follow: true, playKind: "ready", now, attempted: "d1" }), "d2", "a new drop");
  });
  it("secondsLeft rounds up and never goes negative", () => {
    assert.equal(secondsLeft(now + 1, now), 1);
    assert.equal(secondsLeft(now - 5_000, now), 0);
  });
});

describe("Invite button", () => {
  it("no party: any free friend; a leader with room; never a member", () => {
    assert.equal(canInvite(friend(), null), true);
    assert.equal(canInvite(friend({ presence: "offline" }), null), true, "the invite waits 10 min");
    assert.equal(canInvite(friend(), partyOf()), true);
    assert.equal(canInvite(friend(), partyOf({ isLeader: false })), false);
    assert.equal(canInvite(friend({ party: "other" }), null), false);
    assert.equal(canInvite(friend({ party: "mine" }), partyOf()), false);
    assert.equal(canInvite(friend({ invited: true }), partyOf()), false);
  });
  it("members + invites fill the party at 4", () => {
    const full = partyOf({
      members: [member({ leader: true }), member(), member()],
      invited: [{ nickname: "x", expiresAt: 1 }],
    });
    assert.equal(canInvite(friend(), full), false);
    assert.equal(inviteBlockReason(friend(), full), "Party full");
    assert.equal(inviteBlockReason(friend({ party: "mine" }), full), "In your party");
    assert.equal(inviteBlockReason(friend({ invited: true }), full), "Invited");
    assert.equal(inviteBlockReason(friend({ party: "other" }), null), "In another party");
    assert.equal(inviteBlockReason(friend(), null), null);
  });
});

describe("socialErrorText", () => {
  it("uses the server's sentence, else a fallback by status", () => {
    assert.equal(socialErrorText(409, { error: "already_sent", message: "Request already sent." }), "Request already sent.");
    assert.equal(socialErrorText(0, null), "Couldn't reach the server. Check your connection.");
    assert.equal(socialErrorText(429, {}), "Too many requests. Wait a moment and try again.");
    assert.equal(socialErrorText(500, null), "Something went wrong (HTTP 500).");
  });
});
