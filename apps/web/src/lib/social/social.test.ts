/**
 * Friends, parties and party drops against the isolated `extract_test` database (see
 * lib/inventory/test-db.ts): the unordered pair, request / accept / decline / cancel / remove, limits,
 * presence, party invites (expiry, size, one party per user), leave / kick / lead / disband, and the
 * drop signed into world join tickets.
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/social/social.test.ts
 */
process.env.GAME_SERVER_HMAC_SECRET ??= "social-test-secret-0123456789abcdef";
process.env.DATABASE_URL ??= "postgresql://localhost:5432/extract_test";
process.env.SOLANA_RPC_URL ??= "http://127.0.0.1:8899";
process.env.SESSION_SECRET ??= "social-test-session-secret-0123456789";

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { FRIENDS, PARTY, joinTicketPayload, worldCycleAt, worldCycleOf, type JoinTicket, type ShardOpenRequest } from "@extract/shared";
import { friendships, partyDrops, raidEntries } from "../../db/schema";
import { closeTestDb, lockTestDb, makeUser, openTestDb, resetDb } from "../inventory/test-db";
import { openShard } from "../inventory/world";
import { worldJoin } from "../lobby/join";
import type { Caller } from "../lobby/route-helpers";
import { friendAction, listFriends } from "./friends";
import { UUID_RE, getPartyState, partyAction } from "./party";
import { friendPair } from "./rules";

const { db, pool } = openTestDb();
before(() => lockTestDb(pool));
after(() => closeTestDb(pool));
beforeEach(() => resetDb(db));

const C = worldCycleAt(Date.now()).cycle;
const WC = worldCycleOf(C);
const NOW = WC.openAt + 60_000;

type U = Caller & { kind: "user" };
async function user(nick?: string): Promise<U> {
  const n = nick ?? `u${randomUUID().slice(0, 8)}`;
  return { kind: "user", userId: await makeUser(db, n), nickname: n };
}

async function befriend(a: U, b: U, now = NOW) {
  const q = await friendAction(db, a.userId, "request", b.nickname, now);
  if (!q.ok && q.code === "already_friends") return;
  assert.deepEqual(q, { ok: true, status: "sent", nickname: b.nickname });
  const r = await friendAction(db, b.userId, "accept", a.nickname, now);
  assert.ok(r.ok, JSON.stringify(r));
}

/** a leads a party with every other user as a member. */
async function party(a: U, ...others: U[]) {
  for (const o of others) {
    await befriend(a, o);
    const inv = await partyAction(db, a.userId, "invite", { nickname: o.nickname }, NOW);
    assert.ok(inv.ok, JSON.stringify(inv));
    const acc = await partyAction(db, o.userId, "accept", { partyId: inv.ok ? inv.partyId : "" }, NOW);
    assert.ok(acc.ok, JSON.stringify(acc));
  }
  const s = await getPartyState(db, a.userId, NOW);
  return s.party!.id;
}

function shardReq(over: Partial<ShardOpenRequest> = {}): ShardOpenRequest {
  return {
    matchId: randomUUID(),
    cycleId: C,
    shard: 0,
    roomId: `room-${C}-${randomUUID().slice(0, 4)}`,
    mode: "live",
    mapId: "steppe",
    matchSeed: 7,
    startsAt: WC.startAt,
    entryClosesAt: WC.entryClosesAt,
    endsAt: WC.wipeAt,
    boss: null,
    nextBoss: null,
    serverId: "eu-1",
    instanceId: "inst-1",
    ...over,
  };
}

function sigOk(t: JoinTicket): boolean {
  const { sig, ...rest } = t;
  return createHmac("sha256", process.env.GAME_SERVER_HMAC_SECRET!).update(joinTicketPayload(rest)).digest("hex") === sig;
}

// ============================================================================ friends

describe("friends", () => {
  test("request → pending on both lists; accept → friends; the pair is stored once, ordered", async () => {
    const a = await user("Alpha");
    const b = await user("Bravo");
    // Nickname lookup is case-insensitive.
    assert.deepEqual(await friendAction(db, a.userId, "request", "bravo", NOW), { ok: true, status: "sent", nickname: "Bravo" });
    const la = await listFriends(db, a.userId, NOW);
    const lb = await listFriends(db, b.userId, NOW);
    assert.deepEqual(la.outgoing.map((x) => x.nickname), ["Bravo"]);
    assert.deepEqual(lb.incoming.map((x) => x.nickname), ["Alpha"]);
    assert.equal(la.friends.length, 0);
    assert.deepEqual(await friendAction(db, a.userId, "request", "Bravo", NOW), { ok: false, code: "already_sent" });

    assert.ok((await friendAction(db, b.userId, "accept", "Alpha", NOW)).ok);
    const rows = await db.select().from(friendships);
    assert.equal(rows.length, 1);
    const pair = friendPair(a.userId, b.userId)!;
    assert.deepEqual([rows[0]!.userLo, rows[0]!.userHi, rows[0]!.status], [pair.lo, pair.hi, "accepted"]);
    assert.deepEqual((await listFriends(db, a.userId, NOW)).friends.map((f) => [f.nickname, f.presence]), [["Bravo", "online"]]);
    assert.deepEqual(await friendAction(db, b.userId, "request", "Alpha", NOW), { ok: false, code: "already_friends" });
  });

  test("both asking at once makes them friends (one unordered pair, never two rows)", async () => {
    const a = await user();
    const b = await user();
    const [x, y] = await Promise.all([
      friendAction(db, a.userId, "request", b.nickname, NOW),
      friendAction(db, b.userId, "request", a.nickname, NOW),
    ]);
    assert.ok(x.ok && y.ok);
    assert.deepEqual([x.ok && x.status, y.ok && y.status].sort(), ["accepted", "sent"]);
    const rows = await db.select().from(friendships);
    assert.deepEqual(rows.map((r) => r.status), ["accepted"]);
  });

  test("decline / cancel delete the request; remove deletes the pair; wrong side → no_request", async () => {
    const a = await user();
    const b = await user();
    await friendAction(db, a.userId, "request", b.nickname, NOW);
    assert.deepEqual(await friendAction(db, a.userId, "accept", b.nickname, NOW), { ok: false, code: "no_request" });
    assert.deepEqual(await friendAction(db, b.userId, "cancel", a.nickname, NOW), { ok: false, code: "no_request" });
    assert.ok((await friendAction(db, b.userId, "decline", a.nickname, NOW)).ok);
    assert.equal((await db.select().from(friendships)).length, 0);

    await friendAction(db, a.userId, "request", b.nickname, NOW);
    assert.ok((await friendAction(db, a.userId, "cancel", b.nickname, NOW)).ok);
    assert.equal((await db.select().from(friendships)).length, 0);

    assert.deepEqual(await friendAction(db, a.userId, "remove", b.nickname, NOW), { ok: false, code: "not_friends" });
    await befriend(a, b);
    assert.ok((await friendAction(db, b.userId, "remove", a.nickname, NOW)).ok);
    assert.equal((await db.select().from(friendships)).length, 0);
  });

  test("unknown nickname and self are refused", async () => {
    const a = await user();
    assert.deepEqual(await friendAction(db, a.userId, "request", "nobody_here", NOW), { ok: false, code: "not_found" });
    assert.deepEqual(await friendAction(db, a.userId, "request", a.nickname, NOW), { ok: false, code: "self" });
  });

  test("limits: 20 pending sent, 20 pending received, 100 friends", async () => {
    const a = await user();
    const t = await user();
    const others: string[] = [];
    for (let i = 0; i < FRIENDS.MAX_FRIENDS; i++) others.push(await makeUser(db, `f${i}_${randomUUID().slice(0, 6)}`));

    const insertPairs = async (me: string, ids: string[], status: "pending" | "accepted", requestedByMe: boolean) => {
      for (const id of ids) {
        const p = friendPair(me, id)!;
        await db.insert(friendships).values({ userLo: p.lo, userHi: p.hi, requestedBy: requestedByMe ? me : id, status });
      }
    };

    await insertPairs(a.userId, others.slice(0, FRIENDS.MAX_PENDING), "pending", true);
    assert.deepEqual(await friendAction(db, a.userId, "request", t.nickname, NOW), { ok: false, code: "pending_limit" });
    await db.delete(friendships);

    await insertPairs(t.userId, others.slice(0, FRIENDS.MAX_PENDING), "pending", false);
    assert.deepEqual(await friendAction(db, a.userId, "request", t.nickname, NOW), { ok: false, code: "target_busy" });
    await db.delete(friendships);

    await insertPairs(a.userId, others, "accepted", true);
    assert.deepEqual(await friendAction(db, a.userId, "request", t.nickname, NOW), { ok: false, code: "friend_limit" });
    // Their request to a full list cannot be accepted either.
    await db.execute(sql`delete from friendships where user_lo = ${friendPair(a.userId, others[0]!)!.lo}::uuid and user_hi = ${friendPair(a.userId, others[0]!)!.hi}::uuid`);
    await friendAction(db, t.userId, "request", a.nickname, NOW);
    await insertPairs(a.userId, [others[0]!], "accepted", true);
    assert.deepEqual(await friendAction(db, a.userId, "accept", t.nickname, NOW), { ok: false, code: "friend_limit" });
  });

  test("presence: online within 2 minutes of the last poll, raid with an active entry on a running shard", async () => {
    const a = await user();
    const b = await user();
    await befriend(a, b);
    const s = shardReq();
    await openShard(db, s);
    await listFriends(db, b.userId, NOW - 3 * 60_000); // b's last poll: 3 min ago
    assert.equal((await listFriends(db, a.userId, NOW)).friends[0]!.presence, "offline");
    await listFriends(db, b.userId, NOW - 60_000);
    assert.equal((await listFriends(db, a.userId, NOW)).friends[0]!.presence, "online");
    await db.insert(raidEntries).values({ entryId: randomUUID(), matchId: s.matchId, cycleId: C, userId: b.userId, status: "active" });
    assert.equal((await listFriends(db, a.userId, NOW)).friends[0]!.presence, "raid");
  });
});

// ============================================================================ parties

describe("party", () => {
  test("invite creates a party led by the inviter; friends only; accept joins; state lists members and invites", async () => {
    const a = await user("Lead");
    const b = await user("Mate");
    const c = await user("Stranger");
    assert.deepEqual(await partyAction(db, a.userId, "invite", { nickname: c.nickname }, NOW), { ok: false, code: "not_friends" });
    await befriend(a, b);
    const inv = await partyAction(db, a.userId, "invite", { nickname: "mate" }, NOW);
    assert.ok(inv.ok && inv.partyId);
    if (!inv.ok) return;
    assert.deepEqual(await partyAction(db, a.userId, "invite", { nickname: "Mate" }, NOW), { ok: false, code: "already_invited" });

    const sa = await getPartyState(db, a.userId, NOW);
    assert.equal(sa.party?.isLeader, true);
    assert.deepEqual(sa.party?.invited.map((i) => [i.nickname, i.expiresAt]), [["Mate", NOW + PARTY.INVITE_TTL_MS]]);
    assert.equal(sa.pollMs, PARTY.POLL_MS);
    const sb = await getPartyState(db, b.userId, NOW);
    assert.equal(sb.party, null);
    assert.equal(sb.pollMs, PARTY.IDLE_POLL_MS);
    assert.deepEqual(sb.invites.map((i) => [i.partyId, i.from, i.size]), [[inv.partyId, "Lead", 1]]);

    assert.ok((await partyAction(db, b.userId, "accept", { partyId: inv.partyId }, NOW)).ok);
    const after = await getPartyState(db, b.userId, NOW);
    assert.deepEqual(after.party?.members.map((m) => [m.nickname, m.leader, m.you]), [["Lead", true, false], ["Mate", false, true]]);
    assert.equal(after.party?.isLeader, false);
    assert.equal(after.invites.length, 0);
    // Only the leader invites.
    const d = await user();
    await befriend(b, d);
    assert.deepEqual(await partyAction(db, b.userId, "invite", { nickname: d.nickname }, NOW), { ok: false, code: "not_leader" });
  });

  test("invites expire after 10 minutes; a declined or expired invite leaves no party of one behind", async () => {
    const a = await user();
    const b = await user();
    await befriend(a, b);
    const inv = await partyAction(db, a.userId, "invite", { nickname: b.nickname }, NOW);
    assert.ok(inv.ok);
    const pid = inv.ok ? inv.partyId! : "";
    assert.deepEqual(await partyAction(db, b.userId, "accept", { partyId: pid }, NOW + PARTY.INVITE_TTL_MS), { ok: false, code: "invite_expired" });
    // The leader's next poll dissolves the party (one member, nobody invited).
    assert.equal((await getPartyState(db, a.userId, NOW + PARTY.INVITE_TTL_MS + 1)).party, null);

    const again = await partyAction(db, a.userId, "invite", { nickname: b.nickname }, NOW);
    assert.ok(again.ok);
    assert.ok((await partyAction(db, b.userId, "decline", { partyId: again.ok ? again.partyId : "" }, NOW)).ok);
    assert.equal((await getPartyState(db, a.userId, NOW)).party, null);
  });

  test("2–4 members: members + live invites never exceed 4", async () => {
    const [a, b, c, d, e] = [await user(), await user(), await user(), await user(), await user()];
    await party(a, b, c);
    await befriend(a, d);
    await befriend(a, e);
    assert.ok((await partyAction(db, a.userId, "invite", { nickname: d.nickname }, NOW)).ok);
    assert.deepEqual(await partyAction(db, a.userId, "invite", { nickname: e.nickname }, NOW), { ok: false, code: "party_full" });
    assert.ok((await partyAction(db, a.userId, "uninvite", { nickname: d.nickname }, NOW)).ok);
    assert.ok((await partyAction(db, a.userId, "invite", { nickname: e.nickname }, NOW)).ok);
  });

  test("one party per user: a member of another party must leave first; a party of one is dropped on accept", async () => {
    const [a, b, c, d] = [await user(), await user(), await user(), await user()];
    await party(a, b);
    await befriend(c, b);
    assert.deepEqual(await partyAction(db, c.userId, "invite", { nickname: b.nickname }, NOW), { ok: false, code: "target_in_party" });

    // c leads a party of one (an invite out to d) and accepts a's invite: c's own party goes away.
    await befriend(c, d);
    const cInv = await partyAction(db, c.userId, "invite", { nickname: d.nickname }, NOW);
    assert.ok(cInv.ok);
    await befriend(a, c);
    const inv = await partyAction(db, a.userId, "invite", { nickname: c.nickname }, NOW);
    assert.ok(inv.ok);
    assert.ok((await partyAction(db, c.userId, "accept", { partyId: inv.ok ? inv.partyId : "" }, NOW)).ok);
    assert.equal((await getPartyState(db, d.userId, NOW)).invites.length, 0, "c's old invite went with its party");
    assert.equal((await getPartyState(db, c.userId, NOW)).party?.members.length, 3);

    // b (in a's party of 3) cannot accept another party's invite.
    await befriend(d, b);
    const dInv = await partyAction(db, d.userId, "invite", { nickname: b.nickname }, NOW);
    assert.deepEqual(dInv, { ok: false, code: "target_in_party" });
  });

  test("leave hands the lead to the longest member; kick, lead and disband are leader only", async () => {
    const [a, b, c] = [await user("Ann"), await user("Ben"), await user("Cid")];
    await party(a, b, c);
    assert.deepEqual(await partyAction(db, b.userId, "kick", { nickname: c.nickname }, NOW), { ok: false, code: "not_leader" });
    assert.deepEqual(await partyAction(db, b.userId, "disband", {}, NOW), { ok: false, code: "not_leader" });
    assert.ok((await partyAction(db, a.userId, "leave", {}, NOW)).ok);
    const sb = await getPartyState(db, b.userId, NOW);
    assert.equal(sb.party?.leader, "Ben");
    assert.equal(sb.party?.isLeader, true);
    assert.ok((await partyAction(db, b.userId, "lead", { nickname: "Cid" }, NOW)).ok);
    assert.equal((await getPartyState(db, b.userId, NOW)).party?.leader, "Cid");
    assert.ok((await partyAction(db, c.userId, "kick", { nickname: "Ben" }, NOW)).ok);
    // Two left the party of three: the last one is not a party.
    assert.equal((await getPartyState(db, c.userId, NOW)).party, null);
    assert.equal((await getPartyState(db, b.userId, NOW)).party, null);

    const pid = await party(a, b, c);
    assert.ok(pid);
    assert.ok((await partyAction(db, a.userId, "disband", {}, NOW)).ok);
    for (const u of [a, b, c]) assert.equal((await getPartyState(db, u.userId, NOW)).party, null);
  });

  test("follow leader is the member's ready state", async () => {
    const [a, b] = [await user(), await user()];
    await party(a, b);
    assert.ok((await partyAction(db, b.userId, "follow", { follow: true }, NOW)).ok);
    const s = await getPartyState(db, a.userId, NOW);
    assert.deepEqual(s.party?.members.map((m) => m.follow), [true, true]);
    assert.deepEqual(await partyAction(db, (await user()).userId, "follow", { follow: true }, NOW), { ok: false, code: "not_in_party" });
  });
});

// ============================================================================ party drops

describe("party drop", () => {
  test("the leader's PLAY creates a 60 s drop signed into the ticket; members follow it into the same shard", async () => {
    const [a, b, c] = [await user(), await user(), await user()];
    const pid = await party(a, b, c);
    const s1 = shardReq();
    await openShard(db, s1);

    const la = await worldJoin(db, a, undefined, NOW);
    assert.ok(la.ok, JSON.stringify(la));
    if (!la.ok) return;
    const drop = la.body.party;
    assert.equal(drop?.partyId, pid);
    assert.equal(drop?.leader, true);
    assert.match(drop?.dropId ?? "", /^[0-9a-f-]{36}$/);
    assert.equal(drop?.dropExpiresAt, NOW + PARTY.DROP_TTL_MS);
    assert.equal(la.body.ticket.dropId, drop?.dropId);
    assert.equal(la.body.ticket.partyId, pid);
    assert.equal(la.body.ticket.dropSize, 3, "the drop's member count: the shard holds 3 seats, not 4");
    assert.ok(sigOk(la.body.ticket), "dropId and partyId are signed");
    assert.ok(!sigOk({ ...la.body.ticket, dropSize: 4 }), "a re-sized drop fails the signature");
    assert.ok(!sigOk({ ...la.body.ticket, dropId: randomUUID() }), "a re-pointed drop fails the signature");
    const rows = await db.select().from(partyDrops);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.members[0], a.userId, "leader first");
    assert.deepEqual([...rows[0]!.members].sort(), [a.userId, b.userId, c.userId].sort());

    // A second shard opens later: the member still follows the leader into the first one.
    await openShard(db, shardReq({ shard: 1 }));
    const sb = await getPartyState(db, b.userId, NOW + 2_000);
    assert.deepEqual([sb.drop?.dropId, sb.drop?.mine], [drop?.dropId, false]);
    assert.equal((await getPartyState(db, a.userId, NOW + 2_000)).drop?.mine, true);
    const lb = await worldJoin(db, b, undefined, NOW + 2_000, { dropId: drop!.dropId! });
    assert.ok(lb.ok, JSON.stringify(lb));
    if (!lb.ok) return;
    assert.equal(lb.body.matchId, s1.matchId);
    assert.deepEqual([lb.body.ticket.dropId, lb.body.ticket.partyId, lb.body.party?.leader], [drop?.dropId, pid, false]);
    assert.ok(sigOk(lb.body.ticket));

    // Without a dropId the member still finds the party's live drop.
    const lc = await worldJoin(db, c, undefined, NOW + 30_000);
    assert.ok(lc.ok);
    if (lc.ok) assert.equal(lc.body.ticket.dropId, drop?.dropId);

    // The leader's PLAY again inside the window reuses the drop.
    const again = await worldJoin(db, a, undefined, NOW + 10_000);
    assert.ok(again.ok);
    if (again.ok) assert.equal(again.body.ticket.dropId, drop?.dropId);
    assert.equal((await db.select().from(partyDrops)).length, 1);
  });

  test("several shards: a new drop goes to the fullest shard with room for the whole party; members follow it there", async () => {
    const [a, b, c] = [await user(), await user(), await user()];
    await party(a, b, c);
    const s0 = shardReq({ shard: 0 });
    const s1 = shardReq({ shard: 1 });
    await openShard(db, s0);
    await openShard(db, s1);
    // Shard 0 has 2 free seats (too few for 3), shard 1 has plenty.
    for (let i = 0; i < 22; i++) {
      await db.insert(raidEntries).values({ entryId: randomUUID(), matchId: s0.matchId, cycleId: C, userId: (await user()).userId, status: "active" });
    }
    const solo = await worldJoin(db, await user(), undefined, NOW);
    assert.ok(solo.ok && solo.body.matchId === s0.matchId, "a solo player takes a seat on the fuller shard");
    const la = await worldJoin(db, a, undefined, NOW);
    assert.ok(la.ok, JSON.stringify(la));
    if (!la.ok) return;
    assert.equal(la.body.matchId, s1.matchId, "the party fits only on shard 1");
    const rows = await db.select().from(partyDrops);
    assert.equal(rows[0]!.matchId, s1.matchId, "the drop is saved on the picked shard");
    const lb = await worldJoin(db, b, undefined, NOW + 1_000);
    assert.ok(lb.ok && lb.body.matchId === s1.matchId && lb.body.ticket.dropId === la.body.ticket.dropId);
    const again = await worldJoin(db, a, undefined, NOW + 2_000);
    assert.ok(again.ok && again.body.matchId === s1.matchId, "the leader's next PLAY in the window stays on the drop's shard");
  });

  test("a malformed dropId (36 dashes, not a UUID) is ignored: the member's PLAY follows the live drop, never a 500", async () => {
    assert.equal(UUID_RE.test("-".repeat(36)), false);
    assert.ok(UUID_RE.test(randomUUID()));
    const [a, b] = [await user(), await user()];
    await party(a, b);
    await openShard(db, shardReq());
    const la = await worldJoin(db, a, undefined, NOW);
    assert.ok(la.ok);
    const lb = await worldJoin(db, b, undefined, NOW + 1_000, { dropId: "-".repeat(36) });
    assert.ok(lb.ok, JSON.stringify(lb));
    if (lb.ok && la.ok) assert.equal(lb.body.ticket.dropId, la.body.ticket.dropId, "the party's live drop");
  });

  test("after 60 s a member drops on their own (partyId only); solo players get no party fields", async () => {
    const [a, b, solo] = [await user(), await user(), await user()];
    const pid = await party(a, b);
    await openShard(db, shardReq());
    const la = await worldJoin(db, a, undefined, NOW);
    assert.ok(la.ok);
    assert.equal((await getPartyState(db, b.userId, NOW + PARTY.DROP_TTL_MS)).drop, null);
    const lb = await worldJoin(db, b, undefined, NOW + PARTY.DROP_TTL_MS);
    assert.ok(lb.ok);
    if (!lb.ok) return;
    assert.equal(lb.body.ticket.dropId, undefined);
    assert.equal(lb.body.ticket.partyId, pid);
    assert.deepEqual(lb.body.party, { partyId: pid, dropId: null, dropExpiresAt: null, leader: false });
    assert.ok(sigOk(lb.body.ticket));

    const ls = await worldJoin(db, solo, undefined, NOW);
    assert.ok(ls.ok);
    if (!ls.ok) return;
    assert.equal(ls.body.party, undefined);
    assert.equal("dropId" in ls.body.ticket, false);
    assert.equal("partyId" in ls.body.ticket, false);
    // Old-format payload: exactly the six pre-party fields.
    const { sig: _sig, ...rest } = ls.body.ticket;
    assert.equal(joinTicketPayload(rest).split(".").length, 6);
  });

  test("a member who joined after the drop cannot follow it", async () => {
    const [a, b, c] = [await user(), await user(), await user()];
    await party(a, b);
    await openShard(db, shardReq());
    const la = await worldJoin(db, a, undefined, NOW);
    assert.ok(la.ok);
    await befriend(a, c);
    const inv = await partyAction(db, a.userId, "invite", { nickname: c.nickname }, NOW + 1_000);
    assert.ok((await partyAction(db, c.userId, "accept", { partyId: inv.ok ? inv.partyId : "" }, NOW + 1_000)).ok);
    assert.equal((await getPartyState(db, c.userId, NOW + 2_000)).drop, null);
    const lc = await worldJoin(db, c, undefined, NOW + 2_000);
    assert.ok(lc.ok);
    if (lc.ok) assert.equal(lc.body.ticket.dropId, undefined);
  });
});
