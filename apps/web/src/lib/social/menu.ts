/**
 * Pure helpers of the menu's social UI (Friends panel, party strip, invite and drop prompts). No
 * React, no fetch: the tests cover them and the components only render what they return.
 */
import { mapNumber } from "@extract/shared";
import { mapLabel } from "../lobby/world-clock";
import type { FriendDto, PartyDropDto, PartyDto, PartyInviteDto, PartyMemberDto, PartyStateDto, Presence } from "./types";

export const PRESENCE_LABEL: Readonly<Record<Presence, string>> = {
  raid: "In a raid",
  online: "Online",
  offline: "Offline",
};

export type ChipTone = "lime" | "sky" | "amber" | "grey";

/** One member chip of the party strip: the short state word and its colour. */
export function memberChip(m: PartyMemberDto): { label: string; tone: ChipTone } {
  if (m.presence === "raid") return { label: "IN RAID", tone: "sky" };
  if (m.presence === "offline") return { label: "OFFLINE", tone: "grey" };
  if (m.leader) return { label: "LEADER", tone: "lime" };
  return m.follow ? { label: "READY", tone: "lime" } : { label: "NOT READY", tone: "amber" };
}

/** "2/4 ready" for the strip's screen-reader line and the leader's PLAY hint. Offline / in a raid don't count. */
export function readyCount(p: PartyDto): { ready: number; total: number } {
  const ready = p.members.filter((m) => m.presence !== "offline" && m.presence !== "raid" && (m.leader || m.follow)).length;
  return { ready, total: p.members.length };
}

/** The Friends button's dot: incoming friend requests + live party invites. */
export function socialDotCount(s: PartyStateDto | null): number {
  if (!s) return 0;
  return s.requests + s.invites.length;
}

/** Invites that were not in the previous poll (toast once each). The first poll toasts nothing. */
export function freshInvites(prev: readonly PartyInviteDto[] | null, next: readonly PartyInviteDto[]): PartyInviteDto[] {
  if (prev === null) return [];
  const seen = new Set(prev.map((i) => `${i.partyId}:${i.expiresAt}`));
  return next.filter((i) => !seen.has(`${i.partyId}:${i.expiresAt}`));
}

/** More incoming friend requests than in the previous poll (first poll: no toast). */
export function moreRequests(prev: number | null, next: number): boolean {
  return prev !== null && next > prev;
}

/** Whole seconds until `at` (never negative). */
export function secondsLeft(at: number, now: number): number {
  return Math.max(0, Math.ceil((at - now) / 1000));
}

/**
 * "Rook dropped into Map #N — PLAY to join them": a member's prompt while another member's drop (the
 * first in the party to press PLAY, `leader`) is open and PLAY could join. `map` = the drop's map.
 */
export function dropPrompt(i: {
  drop: PartyDropDto | null;
  /** The PLAY state's kind (an error's base kind). */
  playKind: string;
  now: number;
  /** A drop the player closed the prompt of. */
  dismissed: string | null;
}): { dropId: string; leader: string; map: string; secondsLeft: number } | null {
  const d = i.drop;
  if (!d || d.mine || d.dropId === i.dismissed) return null;
  if (i.now >= d.expiresAt) return null;
  if (i.playKind !== "ready") return null;
  return { dropId: d.dropId, leader: d.leader, map: mapLabel(mapNumber(d.cycle)), secondsLeft: secondsLeft(d.expiresAt, i.now) };
}

/**
 * "Follow leader" auto-enter: once per drop, only when PLAY could join right now (a visible tab;
 * a hidden one is pinged instead, like an armed PLAY).
 */
export function autoFollow(i: {
  drop: PartyDropDto | null;
  follow: boolean;
  playKind: string;
  now: number;
  attempted: string | null;
}): string | null {
  const d = i.drop;
  if (!d || d.mine || !i.follow || d.dropId === i.attempted) return null;
  if (i.now >= d.expiresAt || i.playKind !== "ready") return null;
  return d.dropId;
}

/**
 * The Invite button on a friend's row: the caller has no party (inviting starts one) or leads one with
 * room; the friend is in no party and not invited yet; friends offline can still be invited (the
 * invite waits 10 min).
 */
export function canInvite(f: FriendDto, party: PartyDto | null): boolean {
  if (f.party !== null || f.invited) return false;
  if (!party) return true;
  return party.isLeader && party.members.length + party.invited.length < party.maxSize;
}

/** Why the Invite button is missing (screen-reader hint and the row's small text), or null. */
export function inviteBlockReason(f: FriendDto, party: PartyDto | null): string | null {
  if (f.party === "mine") return "In your party";
  if (f.invited) return "Invited";
  if (f.party === "other") return "In another party";
  if (party && !party.isLeader) return null;
  if (party && party.members.length + party.invited.length >= party.maxSize) return "Party full";
  return null;
}

/** The error text of a social API answer (falls back to a generic line). */
export function socialErrorText(status: number, body: unknown): string {
  const m = (body as { message?: unknown } | null)?.message;
  if (typeof m === "string" && m) return m;
  if (status === 0) return "Couldn't reach the server. Check your connection.";
  if (status === 401) return "Sign in first.";
  if (status === 429) return "Too many requests. Wait a moment and try again.";
  return `Something went wrong (HTTP ${status}).`;
}
