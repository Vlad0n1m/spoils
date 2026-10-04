/**
 * Parties of 2–4 (registered users only) and party drops (@extract/shared party.ts).
 * - The leader invites friends (an invite lives PARTY.INVITE_TTL_MS); inviting without a party
 *   creates one with the inviter as leader. Members + live invites ≤ PARTY.MAX_SIZE.
 * - Members accept / decline / leave; the leader kicks, cancels invites, hands over or disbands.
 *   A leader who leaves hands over to the longest member. One party per user (party_members PK).
 * - A party below PARTY.MIN_SIZE with nobody invited dissolves (lazily, on the next read or change).
 * - Drops: the leader's /api/world/join creates (or reuses) the party's live drop for the map;
 *   members' joins follow it until it expires (partyJoinPlan / savePartyDrop, used by lib/lobby/join.ts).
 * Every change runs in one transaction holding the party row lock (and the actors' advisory locks).
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { PARTY, worldCycleAt, type PartyDropInfo } from "@extract/shared";
import type { Db, Tx } from "../inventory/db";
import { fail, findUserByNickname, inRaidSql, lockUsers, ms, touchPresence, type Q, type SocialResult } from "./common";
import { areFriends, incomingRequestCount } from "./friends";
import {
  acceptDecision,
  buildPartyDrop,
  canFollowDrop,
  inviteDecision,
  inviteExpiresAt,
  partyCanDrop,
  partyShouldDissolve,
  presenceOf,
} from "./rules";
import type { PartyDropDto, PartyDto, PartyInviteDto, PartyMemberDto, PartyStateDto } from "./types";

/** A real UUID (the ids are cast with ::uuid: anything looser, e.g. 36 dashes, would throw a 500). */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const PARTY_ACTIONS = ["invite", "uninvite", "accept", "decline", "leave", "kick", "disband", "lead", "follow"] as const;
export type PartyAction = (typeof PARTY_ACTIONS)[number];

export function isPartyAction(v: unknown): v is PartyAction {
  return typeof v === "string" && (PARTY_ACTIONS as readonly string[]).includes(v);
}

interface Membership {
  partyId: string;
  leaderId: string;
  follow: boolean;
}

async function membershipOf(q: Q, userId: string): Promise<Membership | null> {
  const r = await q.execute<{ party_id: string; leader_id: string; follow: boolean }>(sql`
    select m.party_id, p.leader_id, m.follow
    from party_members m join parties p on p.id = m.party_id
    where m.user_id = ${userId}::uuid`);
  const x = r.rows[0];
  return x ? { partyId: String(x.party_id), leaderId: String(x.leader_id).toLowerCase(), follow: Boolean(x.follow) } : null;
}

async function partyCounts(q: Q, partyId: string, now: number): Promise<{ members: number; liveInvites: number; deadInvites: number }> {
  const r = await q.execute<{ members: number; live: number; dead: number }>(sql`
    select (select count(*)::int from party_members where party_id = ${partyId}::uuid) as members,
           (select count(*)::int from party_invites where party_id = ${partyId}::uuid and expires_at > ${new Date(now)}) as live,
           (select count(*)::int from party_invites where party_id = ${partyId}::uuid and expires_at <= ${new Date(now)}) as dead`);
  const x = r.rows[0];
  return { members: Number(x?.members ?? 0), liveInvites: Number(x?.live ?? 0), deadInvites: Number(x?.dead ?? 0) };
}

/** Locks the party row; false when it is gone. */
async function lockParty(tx: Tx, partyId: string): Promise<boolean> {
  const r = await tx.execute(sql`select id from parties where id = ${partyId}::uuid for update`);
  return r.rows.length > 0;
}

/**
 * Inside a transaction holding the party lock: drops expired invites, gives a leaderless party to its
 * longest member, dissolves a party below PARTY.MIN_SIZE with nobody invited. Returns the members left
 * (0 = dissolved).
 */
async function settleParty(tx: Tx, partyId: string, now: number): Promise<number> {
  await tx.execute(sql`delete from party_invites where party_id = ${partyId}::uuid and expires_at <= ${new Date(now)}`);
  const c = await partyCounts(tx, partyId, now);
  if (c.members === 0 || partyShouldDissolve(c.members, c.liveInvites)) {
    await tx.execute(sql`delete from parties where id = ${partyId}::uuid`);
    return 0;
  }
  await tx.execute(sql`
    update parties p set leader_id = (
      select m.user_id from party_members m where m.party_id = p.id order by m.joined_at, m.user_id limit 1)
    where p.id = ${partyId}::uuid
      and not exists (select 1 from party_members m where m.party_id = p.id and m.user_id = p.leader_id)`);
  return c.members;
}

/** settleParty in its own transaction, only when something is due (expired invites, too small). */
async function tidyParty(db: Db, partyId: string, now: number): Promise<boolean> {
  const c = await partyCounts(db, partyId, now);
  if (c.deadInvites === 0 && !partyShouldDissolve(c.members, c.liveInvites)) return false;
  await db.transaction(async (tx) => {
    if (await lockParty(tx, partyId)) await settleParty(tx, partyId, now);
  });
  return true;
}

/** The caller's membership after tidying a dissolvable party (a party of one with no live invites). */
async function currentMembership(db: Db, userId: string, now: number): Promise<Membership | null> {
  const m = await membershipOf(db, userId);
  if (!m) return null;
  return (await tidyParty(db, m.partyId, now)) ? membershipOf(db, userId) : m;
}

// ---------------------------------------------------------------------------- GET /api/party

type MemberRow = { user_id: string; nickname: string; level: number; follow: boolean; joined_at: Date | string; seen_at: Date | string | null; in_raid: boolean };

/** Everything the menu polls: party, invites to me, the live drop, incoming friend requests. Heartbeat too. */
export async function getPartyState(db: Db, me: string, now: number): Promise<PartyStateDto> {
  await touchPresence(db, me, now);
  const self = me.toLowerCase();
  const m = await currentMembership(db, self, now);

  let party: PartyDto | null = null;
  let drop: PartyDropDto | null = null;
  if (m) {
    const rows = await db.execute<MemberRow>(sql`
      select u.id as user_id, u.nickname, u.level, pm.follow, pm.joined_at, p.seen_at, ${inRaidSql(sql`u.id`, now)} as in_raid
      from party_members pm join users u on u.id = pm.user_id
      left join user_presence p on p.user_id = u.id
      where pm.party_id = ${m.partyId}::uuid
      order by pm.joined_at, u.id`);
    const members: PartyMemberDto[] = rows.rows.map((x) => {
      const id = String(x.user_id).toLowerCase();
      return {
        nickname: x.nickname,
        level: Number(x.level),
        leader: id === m.leaderId,
        follow: id === m.leaderId ? true : Boolean(x.follow),
        presence: presenceOf(ms(x.seen_at), Boolean(x.in_raid), now),
        you: id === self,
      };
    });
    members.sort((a, b) => Number(b.leader) - Number(a.leader));
    const inv = await db.execute<{ nickname: string; expires_at: Date | string }>(sql`
      select u.nickname, i.expires_at from party_invites i join users u on u.id = i.to_id
      where i.party_id = ${m.partyId}::uuid and i.expires_at > ${new Date(now)}
      order by i.created_at`);
    const leader = members.find((x) => x.leader)?.nickname ?? "";
    party = {
      id: m.partyId,
      leader,
      isLeader: m.leaderId === self,
      follow: m.follow,
      members,
      invited: inv.rows.map((x) => ({ nickname: x.nickname, expiresAt: ms(x.expires_at) ?? 0 })),
      maxSize: PARTY.MAX_SIZE,
    };
    const d = await latestDrop(db, m.partyId, worldCycleAt(now).cycle, now);
    if (d && d.members.includes(self)) {
      drop = { dropId: d.dropId, cycle: d.cycle, leader: d.leaderId === m.leaderId ? leader : (await nicknameOf(db, d.leaderId)) ?? leader, expiresAt: d.expiresAt, mine: d.leaderId === self };
    }
  }

  const invRows = await db.execute<{ party_id: string; from_nick: string; expires_at: Date | string; size: number }>(sql`
    select i.party_id, u.nickname as from_nick, i.expires_at,
      (select count(*)::int from party_members m where m.party_id = i.party_id) as size
    from party_invites i join users u on u.id = i.from_id
    where i.to_id = ${self}::uuid and i.expires_at > ${new Date(now)}
    order by i.created_at desc`);
  const invites: PartyInviteDto[] = invRows.rows.map((x) => ({
    partyId: String(x.party_id),
    from: x.from_nick,
    size: Number(x.size),
    expiresAt: ms(x.expires_at) ?? 0,
  }));

  return {
    serverTime: now,
    party,
    invites,
    drop,
    requests: await incomingRequestCount(db, self),
    pollMs: party ? PARTY.POLL_MS : PARTY.IDLE_POLL_MS,
  };
}

async function nicknameOf(q: Q, userId: string): Promise<string | null> {
  const r = await q.execute<{ nickname: string }>(sql`select nickname from users where id = ${userId}::uuid`);
  return r.rows[0]?.nickname ?? null;
}

type DropRow = {
  drop_id: string;
  party_id: string;
  cycle: number;
  match_id: string;
  leader_id: string;
  members: string[];
  created_at: Date | string;
  expires_at: Date | string;
};

function dropOf(x: DropRow): PartyDropInfo {
  return {
    dropId: String(x.drop_id),
    partyId: String(x.party_id),
    cycle: Number(x.cycle),
    matchId: String(x.match_id),
    leaderId: String(x.leader_id).toLowerCase(),
    members: (Array.isArray(x.members) ? x.members : []).map((s) => String(s).toLowerCase()),
    createdAt: ms(x.created_at) ?? 0,
    expiresAt: ms(x.expires_at) ?? 0,
  };
}

/** The party's newest drop of `cycle` that is still open at `now`. */
async function latestDrop(q: Q, partyId: string, cycle: number, now: number, dropId?: string): Promise<PartyDropInfo | null> {
  const r = await q.execute<DropRow>(sql`
    select drop_id, party_id, cycle, match_id, leader_id, members, created_at, expires_at
    from party_drops
    where party_id = ${partyId}::uuid and cycle = ${cycle} and expires_at > ${new Date(now)}
      ${dropId ? sql`and drop_id = ${dropId}::uuid` : sql``}
    order by created_at desc
    limit 1`);
  const x = r.rows[0];
  return x ? dropOf(x) : null;
}

// ---------------------------------------------------------------------------- POST /api/party/<action>

export interface PartyActionInput {
  nickname?: string;
  partyId?: string;
  follow?: boolean;
}

/** One party action of `me`. Text for the toast comes from the route (SOCIAL_ERR / partyOkText). */
export async function partyAction(
  db: Db,
  me: string,
  action: PartyAction,
  input: PartyActionInput,
  now: number,
): Promise<SocialResult<{ nickname?: string; partyId?: string }>> {
  const self = me.toLowerCase();
  switch (action) {
    case "invite":
      return invite(db, self, input.nickname ?? "", now);
    case "accept":
      return acceptInvite(db, self, input.partyId ?? "", now);
    case "decline":
      return declineInvite(db, self, input.partyId ?? "", now);
    case "follow": {
      const m = await membershipOf(db, self);
      if (!m) return fail("not_in_party");
      await db.execute(sql`update party_members set follow = ${Boolean(input.follow)} where user_id = ${self}::uuid`);
      return { ok: true, partyId: m.partyId };
    }
    case "leave":
      return leave(db, self, now);
    case "disband": {
      const m = await membershipOf(db, self);
      if (!m) return fail("not_in_party");
      if (m.leaderId !== self) return fail("not_leader");
      await db.transaction(async (tx) => {
        if (await lockParty(tx, m.partyId)) await tx.execute(sql`delete from parties where id = ${m.partyId}::uuid`);
      });
      return { ok: true, partyId: m.partyId };
    }
    case "kick":
    case "lead":
    case "uninvite":
      return leaderOnTarget(db, self, action, input.nickname ?? "", now);
  }
}

async function invite(db: Db, me: string, nickname: string, now: number): Promise<SocialResult<{ nickname?: string; partyId?: string }>> {
  const target = await findUserByNickname(db, nickname);
  if (!target) return fail("not_found");
  const them = target.id.toLowerCase();
  if (them === me) return fail("self");
  // Tidy both sides first: a party of one with nobody invited does not count as a party.
  const mine0 = await currentMembership(db, me, now);
  await currentMembership(db, them, now);

  return db.transaction(async (tx) => {
    await lockUsers(tx, [me, them]);
    if (mine0) await lockParty(tx, mine0.partyId);
    const mine = await membershipOf(tx, me);
    const counts = mine ? await partyCounts(tx, mine.partyId, now) : null;
    const theirs = await membershipOf(tx, them);
    let targetInParty: "mine" | "other" | null = null;
    if (theirs) {
      if (mine && theirs.partyId === mine.partyId) targetInParty = "mine";
      else if ((await partyCounts(tx, theirs.partyId, now)).members > 1) targetInParty = "other";
    }
    let alreadyInvited = false;
    if (mine) {
      const r = await tx.execute(sql`
        select 1 from party_invites where party_id = ${mine.partyId}::uuid and to_id = ${them}::uuid and expires_at > ${new Date(now)}`);
      alreadyInvited = r.rows.length > 0;
    }
    const err = inviteDecision({
      party: mine && counts ? { isLeader: mine.leaderId === me, members: counts.members, liveInvites: counts.liveInvites } : null,
      targetIsMe: false,
      friends: await areFriends(tx, me, them),
      targetInParty,
      alreadyInvited,
    });
    if (err) return fail(err);

    let partyId = mine?.partyId;
    if (!partyId) {
      partyId = randomUUID();
      await tx.execute(sql`insert into parties (id, leader_id, created_at) values (${partyId}::uuid, ${me}::uuid, ${new Date(now)})`);
      await tx.execute(sql`insert into party_members (user_id, party_id, joined_at) values (${me}::uuid, ${partyId}::uuid, ${new Date(now)})`);
    }
    await tx.execute(sql`
      insert into party_invites (party_id, to_id, from_id, created_at, expires_at)
      values (${partyId}::uuid, ${them}::uuid, ${me}::uuid, ${new Date(now)}, ${new Date(inviteExpiresAt(now))})
      on conflict (party_id, to_id) do update
        set from_id = excluded.from_id, created_at = excluded.created_at, expires_at = excluded.expires_at`);
    return { ok: true, nickname: target.nickname, partyId };
  });
}

async function acceptInvite(db: Db, me: string, partyId: string, now: number): Promise<SocialResult<{ partyId?: string }>> {
  if (!UUID_RE.test(partyId)) return fail("no_invite");
  const mine0 = await currentMembership(db, me, now);
  return db.transaction(async (tx) => {
    await lockUsers(tx, [me]);
    // Lock order: parties by id, so two accepts across the same two parties never deadlock.
    const ids = [partyId.toLowerCase(), ...(mine0 && mine0.partyId !== partyId ? [mine0.partyId] : [])].sort();
    for (const id of ids) await lockParty(tx, id);
    const inv = await tx.execute<{ expires_at: Date | string }>(sql`
      select expires_at from party_invites where party_id = ${partyId}::uuid and to_id = ${me}::uuid`);
    const invite = inv.rows[0] ? { expiresAt: ms(inv.rows[0].expires_at) ?? 0 } : null;
    const target = await tx.execute(sql`select 1 from parties where id = ${partyId}::uuid`);
    const mine = await membershipOf(tx, me);
    const myCounts = mine ? await partyCounts(tx, mine.partyId, now) : null;
    const err = acceptDecision({
      invite: target.rows.length ? invite : null,
      now,
      members: (await partyCounts(tx, partyId, now)).members,
      myParty: mine && myCounts ? { id: mine.partyId, members: myCounts.members } : null,
      partyId,
    });
    if (err) {
      if (err === "invite_expired") await tx.execute(sql`delete from party_invites where party_id = ${partyId}::uuid and to_id = ${me}::uuid`);
      return fail(err);
    }
    // A party of one (only invites out) is dissolved; its invites go with it.
    if (mine) await tx.execute(sql`delete from parties where id = ${mine.partyId}::uuid`);
    await tx.execute(sql`delete from party_invites where party_id = ${partyId}::uuid and to_id = ${me}::uuid`);
    await tx.execute(sql`insert into party_members (user_id, party_id, joined_at) values (${me}::uuid, ${partyId}::uuid, ${new Date(now)})`);
    return { ok: true, partyId };
  });
}

async function declineInvite(db: Db, me: string, partyId: string, now: number): Promise<SocialResult<{ partyId?: string }>> {
  if (!UUID_RE.test(partyId)) return fail("no_invite");
  return db.transaction(async (tx) => {
    if (!(await lockParty(tx, partyId))) return fail("no_invite");
    const r = await tx.execute(sql`delete from party_invites where party_id = ${partyId}::uuid and to_id = ${me}::uuid returning party_id`);
    if (r.rows.length === 0) return fail("no_invite");
    await settleParty(tx, partyId, now);
    return { ok: true, partyId };
  });
}

async function leave(db: Db, me: string, now: number): Promise<SocialResult<{ partyId?: string }>> {
  const m = await membershipOf(db, me);
  if (!m) return fail("not_in_party");
  return db.transaction(async (tx) => {
    await lockUsers(tx, [me]);
    if (!(await lockParty(tx, m.partyId))) return fail("not_in_party");
    const r = await tx.execute(sql`delete from party_members where user_id = ${me}::uuid and party_id = ${m.partyId}::uuid returning user_id`);
    if (r.rows.length === 0) return fail("not_in_party");
    // A leader who leaves takes their invites back; settleParty hands the party to the longest member.
    if (m.leaderId === me) await tx.execute(sql`delete from party_invites where party_id = ${m.partyId}::uuid`);
    await settleParty(tx, m.partyId, now);
    return { ok: true, partyId: m.partyId };
  });
}

async function leaderOnTarget(
  db: Db,
  me: string,
  action: "kick" | "lead" | "uninvite",
  nickname: string,
  now: number,
): Promise<SocialResult<{ nickname?: string; partyId?: string }>> {
  const m = await membershipOf(db, me);
  if (!m) return fail("not_in_party");
  if (m.leaderId !== me) return fail("not_leader");
  const target = await findUserByNickname(db, nickname);
  if (!target) return fail("not_found");
  const them = target.id.toLowerCase();
  if (them === me) return fail("self");
  return db.transaction(async (tx) => {
    if (!(await lockParty(tx, m.partyId))) return fail("not_in_party");
    const lead = await tx.execute<{ leader_id: string }>(sql`select leader_id from parties where id = ${m.partyId}::uuid`);
    if (String(lead.rows[0]?.leader_id ?? "").toLowerCase() !== me) return fail("not_leader");
    if (action === "uninvite") {
      const r = await tx.execute(sql`delete from party_invites where party_id = ${m.partyId}::uuid and to_id = ${them}::uuid returning to_id`);
      if (r.rows.length === 0) return fail("no_invite");
      await settleParty(tx, m.partyId, now);
      return { ok: true, nickname: target.nickname, partyId: m.partyId };
    }
    const member = await tx.execute(sql`select 1 from party_members where party_id = ${m.partyId}::uuid and user_id = ${them}::uuid`);
    if (member.rows.length === 0) return fail("not_member");
    if (action === "lead") {
      await tx.execute(sql`update parties set leader_id = ${them}::uuid where id = ${m.partyId}::uuid`);
      await tx.execute(sql`update party_members set follow = false where user_id = ${them}::uuid`);
    } else {
      await tx.execute(sql`delete from party_members where user_id = ${them}::uuid and party_id = ${m.partyId}::uuid`);
      await settleParty(tx, m.partyId, now);
    }
    return { ok: true, nickname: target.nickname, partyId: m.partyId };
  });
}

// ---------------------------------------------------------------------------- party drops (world join)

/** What /api/world/join signs for a party member (null = solo: no party of ≥ PARTY.MIN_SIZE). */
export interface PartyJoinPlan {
  partyId: string;
  leader: boolean;
  /** The drop this join starts (leader, `isNew`), reuses or follows; null = drop on your own. */
  drop: PartyDropInfo | null;
  /** The leader's drop is new: save it (savePartyDrop) once the ticket is issued. */
  isNew: boolean;
}

/**
 * The party side of a world join on `cycle`, whose shard would be `matchId`:
 * - leader of a party of ≥ PARTY.MIN_SIZE: the party's live drop of this map, else a new one for
 *   `matchId` listing the current members;
 * - member: the drop `dropId` (or, without one, the party's newest live drop) when they may follow it
 *   (canFollowDrop); the caller pins the join to `drop.matchId` while that shard runs;
 * - otherwise null.
 */
export async function partyJoinPlan(
  db: Db,
  userId: string,
  p: { cycle: number; matchId: string; now: number; dropId?: string },
): Promise<PartyJoinPlan | null> {
  const self = userId.toLowerCase();
  const m = await membershipOf(db, self);
  if (!m) return null;
  const members = await db.execute<{ user_id: string }>(sql`
    select user_id from party_members where party_id = ${m.partyId}::uuid order by joined_at, user_id`);
  const ids = members.rows.map((x) => String(x.user_id).toLowerCase());
  if (!partyCanDrop(ids.length)) return null;

  if (m.leaderId === self) {
    const live = await latestDrop(db, m.partyId, p.cycle, p.now);
    if (live && live.leaderId === self) return { partyId: m.partyId, leader: true, drop: live, isNew: false };
    const drop = buildPartyDrop({ dropId: randomUUID(), partyId: m.partyId, leaderId: self, members: ids, cycle: p.cycle, matchId: p.matchId, now: p.now });
    return { partyId: m.partyId, leader: true, drop, isNew: true };
  }
  const want = p.dropId && UUID_RE.test(p.dropId) ? p.dropId.toLowerCase() : undefined;
  const d = await latestDrop(db, m.partyId, p.cycle, p.now, want);
  return { partyId: m.partyId, leader: false, drop: canFollowDrop(d, self, p.cycle, p.now) ? d : null, isNew: false };
}

/** Stores a new leader drop (idempotent per dropId; a party disbanded meanwhile just has no drop). */
export async function savePartyDrop(db: Db, d: PartyDropInfo): Promise<boolean> {
  try {
    const r = await db.execute(sql`
      insert into party_drops (drop_id, party_id, cycle, match_id, leader_id, members, created_at, expires_at)
      select ${d.dropId}::uuid, ${d.partyId}::uuid, ${d.cycle}, ${d.matchId}::uuid, ${d.leaderId}::uuid,
             ${JSON.stringify(d.members)}::jsonb, ${new Date(d.createdAt)}, ${new Date(d.expiresAt)}
      where exists (select 1 from parties where id = ${d.partyId}::uuid)
      on conflict (drop_id) do nothing
      returning drop_id`);
    // Old drops of the party are never read again (latestDrop only sees open ones).
    await db.execute(sql`delete from party_drops where party_id = ${d.partyId}::uuid and expires_at < ${new Date(d.createdAt - 60 * 60_000)}`);
    return r.rows.length > 0;
  } catch (e) {
    console.error("[party] drop not saved", e);
    return false;
  }
}
