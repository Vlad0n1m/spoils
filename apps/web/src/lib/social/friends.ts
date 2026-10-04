/**
 * Friends (registered users only): request by nickname, accept / decline / cancel / remove, and the
 * list with presence. One row per unordered pair (friendships, user_lo < user_hi). Every change runs
 * in one transaction under the advisory locks of both users, so the limits (FRIENDS.MAX_FRIENDS,
 * FRIENDS.MAX_PENDING) hold under concurrent requests.
 */
import { sql } from "drizzle-orm";
import { FRIENDS } from "@extract/shared";
import type { Db, Tx } from "../inventory/db";
import { fail, findUserByNickname, inRaidSql, lockUsers, ms, touchPresence, type SocialResult } from "./common";
import { acceptLimit, comparePresence, friendPair, presenceOf, requestDecision, type PairRow } from "./rules";
import type { FriendDto, FriendRequestDto, FriendsDto } from "./types";

export const FRIEND_ACTIONS = ["request", "accept", "decline", "cancel", "remove"] as const;
export type FriendAction = (typeof FRIEND_ACTIONS)[number];

export function isFriendAction(v: unknown): v is FriendAction {
  return typeof v === "string" && (FRIEND_ACTIONS as readonly string[]).includes(v);
}

type Row = {
  nickname: string;
  level: number;
  status: "pending" | "accepted";
  requested_by: string;
  created_at: Date | string;
  accepted_at: Date | string | null;
  seen_at: Date | string | null;
  in_raid: boolean;
  party_id: string | null;
  invited: boolean;
};

/** GET /api/friends: friends with presence, incoming and outgoing requests. Also a presence heartbeat. */
export async function listFriends(db: Db, me: string, now: number): Promise<FriendsDto> {
  await touchPresence(db, me, now);
  const mine = await db.execute<{ party_id: string }>(sql`select party_id from party_members where user_id = ${me}`);
  const myParty = mine.rows[0]?.party_id ?? null;
  const r = await db.execute<Row>(sql`
    select u.nickname, u.level, f.status, f.requested_by, f.created_at, f.accepted_at, p.seen_at,
      ${inRaidSql(sql`u.id`, now)} as in_raid,
      pm.party_id,
      exists (select 1 from party_invites i
              where i.to_id = u.id and i.party_id = ${myParty}::uuid and i.expires_at > ${new Date(now)}) as invited
    from friendships f
    join users u on u.id = case when f.user_lo = ${me}::uuid then f.user_hi else f.user_lo end
    left join user_presence p on p.user_id = u.id
    left join party_members pm on pm.user_id = u.id
    where f.user_lo = ${me}::uuid or f.user_hi = ${me}::uuid`);

  const friends: FriendDto[] = [];
  const incoming: FriendRequestDto[] = [];
  const outgoing: FriendRequestDto[] = [];
  for (const x of r.rows) {
    if (x.status === "accepted") {
      friends.push({
        nickname: x.nickname,
        level: Number(x.level),
        presence: presenceOf(ms(x.seen_at), Boolean(x.in_raid), now),
        party: x.party_id ? (myParty && x.party_id === myParty ? "mine" : "other") : null,
        invited: Boolean(x.invited),
        since: ms(x.accepted_at) ?? ms(x.created_at) ?? 0,
      });
    } else {
      const req = { nickname: x.nickname, level: Number(x.level), at: ms(x.created_at) ?? 0 };
      if (String(x.requested_by).toLowerCase() === me.toLowerCase()) outgoing.push(req);
      else incoming.push(req);
    }
  }
  friends.sort(comparePresence);
  incoming.sort((a, b) => b.at - a.at);
  outgoing.sort((a, b) => b.at - a.at);
  return { serverTime: now, friends, incoming, outgoing, limits: { maxFriends: FRIENDS.MAX_FRIENDS, maxPending: FRIENDS.MAX_PENDING } };
}

async function pairRow(tx: Tx, lo: string, hi: string): Promise<PairRow> {
  const r = await tx.execute<{ status: "pending" | "accepted"; requested_by: string }>(sql`
    select status, requested_by from friendships where user_lo = ${lo}::uuid and user_hi = ${hi}::uuid`);
  const x = r.rows[0];
  return x ? { status: x.status, requestedBy: String(x.requested_by) } : null;
}

async function friendCount(tx: Tx, userId: string): Promise<number> {
  const r = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from friendships
    where (user_lo = ${userId}::uuid or user_hi = ${userId}::uuid) and status = 'accepted'`);
  return Number(r.rows[0]?.n ?? 0);
}

async function pendingCounts(tx: Tx, userId: string): Promise<{ out: number; in: number }> {
  const r = await tx.execute<{ out_n: number; in_n: number }>(sql`
    select count(*) filter (where requested_by = ${userId}::uuid)::int as out_n,
           count(*) filter (where requested_by <> ${userId}::uuid)::int as in_n
    from friendships
    where (user_lo = ${userId}::uuid or user_hi = ${userId}::uuid) and status = 'pending'`);
  return { out: Number(r.rows[0]?.out_n ?? 0), in: Number(r.rows[0]?.in_n ?? 0) };
}

async function acceptPair(tx: Tx, lo: string, hi: string, now: number): Promise<void> {
  await tx.execute(sql`
    update friendships set status = 'accepted', accepted_at = ${new Date(now)}
    where user_lo = ${lo}::uuid and user_hi = ${hi}::uuid`);
}

/**
 * One friend action on the user called `nickname`:
 * - request: a new pending request, or accepts theirs if they already asked (`status: "accepted"`);
 * - accept / decline: their pending request to me;
 * - cancel: my pending request to them;
 * - remove: an accepted pair (also drops live party invites between the two).
 */
export async function friendAction(
  db: Db,
  me: string,
  action: FriendAction,
  nickname: string,
  now: number,
): Promise<SocialResult<{ status?: "sent" | "accepted"; nickname: string }>> {
  const target = await findUserByNickname(db, nickname);
  if (!target) return fail("not_found");
  const pair = friendPair(me, target.id);
  if (!pair) return fail("self");
  const them = target.id.toLowerCase();
  const self = me.toLowerCase();

  return db.transaction(async (tx) => {
    await lockUsers(tx, [self, them]);
    const existing = await pairRow(tx, pair.lo, pair.hi);
    switch (action) {
      case "request": {
        const [myFriends, theirFriends, mineP, theirsP] = await Promise.all([
          friendCount(tx, self),
          friendCount(tx, them),
          pendingCounts(tx, self),
          pendingCounts(tx, them),
        ]);
        const d = requestDecision({
          me: self,
          target: them,
          existing,
          myFriends,
          myPendingOut: mineP.out,
          theirFriends,
          theirPendingIn: theirsP.in,
        });
        if (d.kind === "error") return fail(d.code);
        if (d.kind === "accept") {
          await acceptPair(tx, pair.lo, pair.hi, now);
          return { ok: true, status: "accepted", nickname: target.nickname } as const;
        }
        await tx.execute(sql`
          insert into friendships (user_lo, user_hi, requested_by, status, created_at)
          values (${pair.lo}::uuid, ${pair.hi}::uuid, ${self}::uuid, 'pending', ${new Date(now)})
          on conflict do nothing`);
        return { ok: true, status: "sent", nickname: target.nickname } as const;
      }
      case "accept": {
        if (existing?.status !== "pending" || existing.requestedBy.toLowerCase() !== them) return fail("no_request");
        const limit = acceptLimit(await friendCount(tx, self), await friendCount(tx, them));
        if (limit) return fail(limit);
        await acceptPair(tx, pair.lo, pair.hi, now);
        return { ok: true, nickname: target.nickname } as const;
      }
      case "decline":
      case "cancel": {
        const from = action === "decline" ? them : self;
        if (existing?.status !== "pending" || existing.requestedBy.toLowerCase() !== from) return fail("no_request");
        await tx.execute(sql`delete from friendships where user_lo = ${pair.lo}::uuid and user_hi = ${pair.hi}::uuid`);
        return { ok: true, nickname: target.nickname } as const;
      }
      case "remove": {
        if (existing?.status !== "accepted") return fail("not_friends");
        await tx.execute(sql`delete from friendships where user_lo = ${pair.lo}::uuid and user_hi = ${pair.hi}::uuid`);
        await tx.execute(sql`
          delete from party_invites
          where (from_id = ${self}::uuid and to_id = ${them}::uuid) or (from_id = ${them}::uuid and to_id = ${self}::uuid)`);
        return { ok: true, nickname: target.nickname } as const;
      }
    }
  });
}

/** The two users are friends (accepted pair). */
export async function areFriends(q: Db | Tx, a: string, b: string): Promise<boolean> {
  const pair = friendPair(a, b);
  if (!pair) return false;
  const r = await q.execute<{ ok: boolean }>(sql`
    select true as ok from friendships
    where user_lo = ${pair.lo}::uuid and user_hi = ${pair.hi}::uuid and status = 'accepted'`);
  return r.rows.length > 0;
}

/** Incoming pending requests (the Friends button's dot). */
export async function incomingRequestCount(q: Db | Tx, me: string): Promise<number> {
  const r = await q.execute<{ n: number }>(sql`
    select count(*)::int as n from friendships
    where (user_lo = ${me}::uuid or user_hi = ${me}::uuid) and status = 'pending' and requested_by <> ${me}::uuid`);
  return Number(r.rows[0]?.n ?? 0);
}
