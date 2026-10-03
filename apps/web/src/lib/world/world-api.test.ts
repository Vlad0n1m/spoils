/**
 * WORLD v6 web world API (spec §4.7–§4.9, test T22) against the isolated `extract_test` database:
 * worldJoin states, the status DTO, leaderboards and the events feed.
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/world/world-api.test.ts
 */
process.env.GAME_SERVER_HMAC_SECRET ??= "world-api-test-secret-0123456789";
process.env.DATABASE_URL ??= "postgresql://localhost:5432/extract_test";
process.env.SOLANA_RPC_URL ??= "http://127.0.0.1:8899";
process.env.SESSION_SECRET ??= "world-api-test-session-secret-0123456789";

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  WORLD,
  joinTicketPayload,
  levelForXp,
  mapNumber,
  worldCycleAt,
  worldCycleOf,
  type PlayerExitReport,
  type ShardOpenRequest,
} from "@extract/shared";
import { pvpKills, raidEntries, raidExits, raids, users } from "../../db/schema";
import { lockLoadout } from "../inventory/loadout";
import { RAID_USER_VOID_GRACE_MS } from "../inventory/raids";
import { closeTestDb, lockTestDb, makeItem, makeUser, openTestDb, resetDb } from "../inventory/test-db";
import { enterRaid, openShard, recordWorldEvent } from "../inventory/world";
import { getEconomyStats } from "../lobby/economy-stats";
import { worldJoin } from "../lobby/join";
import type { Caller } from "../lobby/route-helpers";
import { worldEvents } from "./events";
import { leaderboard, leaderboardMe, weekStartUtc } from "./leaderboards";
import { meWorld } from "./me";
import { worldStatus } from "./status";

const { db, pool } = openTestDb();
before(() => lockTestDb(pool));
after(() => closeTestDb(pool));
beforeEach(() => resetDb(db));

// The real current cycle: lockAndIssueTicket runs the stash's lazy maintenance with the real clock,
// which would void a shard row of a cycle in the past.
const C = worldCycleAt(Date.now()).cycle;
const WC = worldCycleOf(C);
const OPEN_NOW = WC.openAt + 60_000;

function shardReq(over: Partial<ShardOpenRequest> = {}): ShardOpenRequest {
  const wc = worldCycleOf(over.cycleId ?? C);
  return {
    matchId: randomUUID(),
    cycleId: wc.cycle,
    shard: 0,
    roomId: `room-${wc.cycle}`,
    mode: "live",
    mapId: "steppe",
    matchSeed: 7,
    startsAt: wc.startAt,
    entryClosesAt: wc.entryClosesAt,
    endsAt: wc.wipeAt,
    boss: null,
    nextBoss: null,
    serverId: "eu-1",
    instanceId: "inst-1",
    ...over,
  };
}

async function user(nick?: string): Promise<Caller & { kind: "user" }> {
  const n = nick ?? `u${randomUUID().slice(0, 8)}`;
  return { kind: "user", userId: await makeUser(db, n), nickname: n };
}

function sigOk(t: { sig: string } & Parameters<typeof joinTicketPayload>[0]): boolean {
  const { sig, ...rest } = t;
  const want = createHmac("sha256", process.env.GAME_SERVER_HMAC_SECRET!).update(joinTicketPayload(rest)).digest("hex");
  return want === sig;
}

async function addEntry(v: { matchId: string; cycleId: number; userId: string; status?: "active" | "exited" | "voided"; loadoutId?: string | null }) {
  const entryId = randomUUID();
  await db.insert(raidEntries).values({
    entryId,
    matchId: v.matchId,
    cycleId: v.cycleId,
    userId: v.userId,
    loadoutId: v.loadoutId ?? null,
    status: v.status ?? "active",
  });
  return entryId;
}

function report(matchId: string, userId: string, exit: PlayerExitReport["exit"], kills = 0): PlayerExitReport {
  return {
    matchId,
    userId,
    exit,
    atMs: 900_000,
    kills,
    level: 1,
    extracted: [],
    lost: [],
    destroyed: [],
    stats: { shotsFired: 0, dmgDealt: 0, containersSearched: 0, corpsesSearched: 0, bossKills: 0 },
  };
}

async function addExit(v: {
  matchId: string;
  cycleId: number;
  userId: string;
  exit: PlayerExitReport["exit"];
  guest?: boolean;
  npcKills?: number;
  bossKills?: number;
  xp?: number;
  at?: Date;
  entryId?: string;
  kills?: number;
}) {
  const entryId = v.entryId ?? randomUUID();
  await db.insert(raidExits).values({
    entryId,
    matchId: v.matchId,
    userId: v.userId,
    exit: v.exit,
    report: report(v.matchId, v.userId, v.exit, v.kills ?? 0),
    guest: v.guest ?? false,
    cycleId: v.cycleId,
    npcKills: v.npcKills ?? 0,
    bossKills: v.bossKills ?? 0,
    xp: v.xp ?? 0,
    at: v.at ?? new Date(),
  });
  return entryId;
}

async function kill(killerId: string, victimId: string, v: { ranked?: boolean; at?: Date; cycleId?: number } = {}) {
  await db.insert(pvpKills).values({
    killerId,
    victimId,
    matchId: randomUUID(),
    entryId: randomUUID(),
    cycleId: v.cycleId ?? C,
    ranked: v.ranked ?? true,
    at: v.at ?? new Date(),
  });
}

// ============================================================================ worldJoin

describe("worldJoin", () => {
  test("anon → 401 unauthenticated with serverTime", async () => {
    const r = await worldJoin(db, { kind: "anon" }, undefined, OPEN_NOW);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.status, 401);
    assert.equal(r.body.error, "unauthenticated");
    assert.equal(r.body.serverTime, OPEN_NOW);
  });

  test("no running world row for this cycle → 503 world_starting with retryInMs", async () => {
    const u = await user();
    // A row of another cycle does not count.
    await openShard(db, shardReq({ cycleId: C + 1 }));
    const r = await worldJoin(db, u, undefined, OPEN_NOW);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.deepEqual([r.status, r.body.error, r.body.retryInMs], [503, "world_starting", 3000]);
  });

  test("entry_closed: resetting → this cycle's openAt; closing → the next cycle's openAt", async () => {
    const u = await user();
    await openShard(db, shardReq());
    const resetting = await worldJoin(db, u, undefined, WC.startAt + 5_000);
    assert.equal(resetting.ok, false);
    if (resetting.ok) return;
    assert.deepEqual([resetting.status, resetting.body.error, resetting.body.openAt], [409, "entry_closed", WC.openAt]);
    const closing = await worldJoin(db, u, undefined, WC.entryClosesAt);
    assert.equal(closing.ok, false);
    if (closing.ok) return;
    assert.deepEqual([closing.body.error, closing.body.openAt], ["entry_closed", worldCycleOf(C + 1).openAt]);
  });

  test("success: a fresh entry id, the shard's matchId and roomId in a signed ticket; empty loadout = free kit", async () => {
    const u = await user();
    const s = shardReq();
    await openShard(db, s);
    const r = await worldJoin(db, u, undefined, OPEN_NOW);
    assert.ok(r.ok, JSON.stringify(r));
    if (!r.ok) return;
    const b = r.body;
    assert.equal(b.rejoin, false);
    assert.equal(b.matchId, s.matchId);
    assert.equal(b.roomId, s.roomId);
    assert.deepEqual([b.cycle, b.wipeAt, b.entryClosesAt, b.serverTime], [C, WC.wipeAt, WC.entryClosesAt, OPEN_NOW]);
    assert.equal(b.ticket.matchId, s.matchId);
    assert.match(b.ticket.entryId ?? "", /^[0-9a-f-]{36}$/);
    assert.equal(b.ticket.userId, u.userId);
    assert.equal(b.loadoutId, "");
    assert.equal(b.ticket.loadoutId, "");
    assert.ok(sigOk(b.ticket), "the signature covers matchId and entryId");
    assert.ok(!sigOk({ ...b.ticket, entryId: randomUUID() }), "a re-pointed entry id fails the signature");
    // Nothing is an entry until the game server admits it.
    assert.equal((await db.select().from(raidEntries)).length, 0);
    // A second PLAY before admission mints another entry id.
    const again = await worldJoin(db, u, undefined, OPEN_NOW);
    assert.ok(again.ok);
    if (again.ok) assert.notEqual(again.body.ticket.entryId, b.ticket.entryId);
  });

  test("guest: free kit ticket with matchId / entryId", async () => {
    const s = shardReq();
    await openShard(db, s);
    const g: Caller = { kind: "guest", userId: randomUUID(), nickname: "Guesty" };
    const r = await worldJoin(db, g, undefined, OPEN_NOW);
    assert.ok(r.ok, JSON.stringify(r));
    if (!r.ok) return;
    assert.equal(r.body.loadoutId, "");
    assert.equal(r.body.ticket.matchId, s.matchId);
    assert.ok(sigOk(r.body.ticket));
  });

  test("geared user: the loadout is locked into the ticket; after admission a PLAY is a rejoin of that entry", async () => {
    const u = await user();
    const rifle = await makeItem(db, { def: "rifle", rarity: 1, ownerId: u.userId });
    const s = shardReq();
    await openShard(db, s);
    const entries = [{ key: "w1" as const, itemId: rifle, def: "rifle", qty: 1 }];
    const r = await worldJoin(db, u, entries, OPEN_NOW);
    assert.ok(r.ok, JSON.stringify(r));
    if (!r.ok) return;
    assert.match(r.body.loadoutId, /^[0-9a-f-]{36}$/);
    assert.equal(r.body.ticket.loadoutId, r.body.loadoutId);
    assert.equal(r.body.entries.length, 1);

    const entryId = r.body.ticket.entryId!;
    const res = await enterRaid(db, {
      matchId: s.matchId,
      entryId,
      userId: u.userId,
      loadoutId: r.body.loadoutId,
      atMs: 60_000,
      targets: 30,
      bossAlive: false,
    });
    assert.equal(res.status, "accepted", JSON.stringify(res));

    const re = await worldJoin(db, u, undefined, OPEN_NOW + 5_000);
    assert.ok(re.ok, JSON.stringify(re));
    if (!re.ok) return;
    assert.equal(re.body.rejoin, true);
    assert.equal(re.body.ticket.entryId, entryId);
    assert.equal(re.body.ticket.matchId, s.matchId);
    assert.equal(re.body.loadoutId, r.body.loadoutId);
    assert.deepEqual(re.body.entries.map((e) => e.itemId), [rifle]);
    assert.ok(sigOk(re.body.ticket));
    // A rejoin works after entry closes too (the runtime is still on the map).
    const late = await worldJoin(db, u, undefined, WC.entryClosesAt + 60_000);
    assert.ok(late.ok && late.body.rejoin);
  });

  test("an active entry on a shard of another cycle → 409 in_raid with settlesAt = ends_at + 5 min", async () => {
    const u = await user();
    const prev = shardReq({ cycleId: C - 1 });
    await openShard(db, prev);
    await openShard(db, shardReq());
    await addEntry({ matchId: prev.matchId, cycleId: C - 1, userId: u.userId });
    const r = await worldJoin(db, u, undefined, OPEN_NOW);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.deepEqual([r.status, r.body.error, r.body.settlesAt], [409, "in_raid", prev.endsAt + RAID_USER_VOID_GRACE_MS]);
  });

  test("entry_limit: 4 entries this cycle → 409 (exited and voided ones count)", async () => {
    const u = await user();
    const s = shardReq();
    await openShard(db, s);
    for (const status of ["exited", "exited", "voided"] as const) await addEntry({ matchId: s.matchId, cycleId: C, userId: u.userId, status });
    const third = await worldJoin(db, u, undefined, OPEN_NOW);
    assert.ok(third.ok, "3 earlier entries still allow a 4th");
    await addEntry({ matchId: s.matchId, cycleId: C, userId: u.userId, status: "exited" });
    const r = await worldJoin(db, u, undefined, OPEN_NOW);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.deepEqual([r.status, r.body.error, r.body.openAt], [409, "entry_limit", worldCycleOf(C + 1).openAt]);
  });
});

// ============================================================================ status

describe("worldStatus", () => {
  test("offline: no running row → online false, no humans, no boss, no next boss, no last", async () => {
    const st = await worldStatus(db, OPEN_NOW);
    assert.equal(st.v, 1);
    assert.deepEqual(
      [st.online, st.humans, st.boss, st.last, st.cycle, st.mapNumber, st.phase, st.capacity],
      [false, 0, null, null, C, mapNumber(C), "open", WORLD.CAPACITY * WORLD.MAX_SHARDS],
    );
    assert.deepEqual([st.openAt, st.entryClosesAt, st.wipeAt, st.serverTime], [WC.openAt, WC.entryClosesAt, WC.wipeAt, OPEN_NOW]);
    assert.deepEqual(st.next, { cycle: C + 1, mapNumber: mapNumber(C + 1), openAt: worldCycleOf(C + 1).openAt });
    assert.ok(!("boss" in st.next));
  });

  test("online with an alive boss; next boss only after the reveal; killed with the killer's nickname", async () => {
    const s = shardReq({ boss: { kind: "foreman", zone: "elevator" }, nextBoss: { kind: "commander", zone: "radar" } });
    await openShard(db, s);
    const [a, b, c] = [await user(), await user(), await user()];
    await addEntry({ matchId: s.matchId, cycleId: C, userId: a.userId });
    await addEntry({ matchId: s.matchId, cycleId: C, userId: b.userId });
    await addEntry({ matchId: s.matchId, cycleId: C, userId: c.userId, status: "exited" });

    const st = await worldStatus(db, OPEN_NOW);
    assert.equal(st.online, true);
    assert.equal(st.humans, 2);
    assert.deepEqual(st.boss, {
      kind: "foreman",
      name: "Foreman",
      zone: "elevator",
      zoneName: "Grain Elevator",
      tier: 3,
      guards: 2,
      status: "alive",
      killedBy: null,
    });
    assert.ok(!("boss" in st.next), "no next boss before the reveal");

    const revealed = await worldStatus(db, WC.wipeAt - WORLD.NEXT_BOSS_REVEAL_MS);
    assert.deepEqual(revealed.next.boss, { kind: "commander", name: "Commander", zoneName: "Radar Base" });
    assert.equal(revealed.phase, "closing");

    await recordWorldEvent(db, { matchId: s.matchId, cycleId: C, kind: "boss_killed", boss: "foreman", by: "Nick", atMs: 600_000 });
    const killed = await worldStatus(db, OPEN_NOW);
    assert.deepEqual([killed.boss?.status, killed.boss?.killedBy], ["killed", "Nick"]);
  });

  test("a revealed map without a boss shows next.boss = null", async () => {
    await openShard(db, shardReq());
    const st = await worldStatus(db, WC.wipeAt - 1000);
    assert.ok("boss" in st.next);
    assert.equal(st.next.boss, null);
  });

  test("last: the previous cycle's settled row — exits by type, top ranked killer, boss killer", async () => {
    const prev = shardReq({ cycleId: C - 1, boss: { kind: "warden", zone: "depot" } });
    await openShard(db, prev);
    await recordWorldEvent(db, { matchId: prev.matchId, cycleId: C - 1, kind: "boss_killed", boss: "warden", by: "Ace", atMs: 1 });
    await db.update(raids).set({ status: "settled" }).where(eq(raids.matchId, prev.matchId));
    const [a, b, v] = [await user("Ace"), await user("Bee"), await user("Vic")];
    for (const [uid, exit] of [[a.userId, "extract"], [b.userId, "extract"], [v.userId, "dead"], [v.userId, "mia"]] as const) {
      await addExit({ matchId: prev.matchId, cycleId: C - 1, userId: uid, exit });
    }
    await kill(a.userId, v.userId, { cycleId: C - 1 });
    await kill(a.userId, b.userId, { cycleId: C - 1 });
    await kill(b.userId, v.userId, { cycleId: C - 1 });
    await kill(b.userId, a.userId, { cycleId: C - 1, ranked: false });
    await kill(b.userId, a.userId, { cycleId: C - 1, ranked: false });
    await kill(b.userId, a.userId, { cycleId: C, ranked: true });

    const st = await worldStatus(db, OPEN_NOW);
    assert.deepEqual(st.last, {
      cycle: C - 1,
      mapNumber: mapNumber(C - 1),
      extracted: 2,
      died: 1,
      mia: 1,
      topKiller: { nickname: "Ace", kills: 2 },
      bossKilledBy: "Ace",
    });
    assert.equal(st.online, false, "the previous cycle's row does not make this cycle online");
  });

  test("last is null while the previous cycle's row is still running (end report pending)", async () => {
    await openShard(db, shardReq({ cycleId: C - 1 }));
    assert.equal((await worldStatus(db, OPEN_NOW)).last, null);
  });
});

// ============================================================================ me/world

describe("meWorld", () => {
  test("active entry (rejoinable only on a running row of this cycle) and the last world raid", async () => {
    const u = await user();
    const s = shardReq();
    await openShard(db, s);
    const none = await meWorld(db, u.userId, OPEN_NOW);
    assert.deepEqual([none.activeEntry, none.lastRaid, none.serverTime], [null, null, OPEN_NOW]);

    // A finished entry with an exit row → lastRaid.
    const done = await addEntry({ matchId: s.matchId, cycleId: C, userId: u.userId, status: "exited" });
    await addExit({ matchId: s.matchId, cycleId: C, userId: u.userId, exit: "extract", entryId: done, xp: 300, npcKills: 5, bossKills: 1, kills: 2 });
    await db.execute(sql`update raid_exits set on_map_ms = 700000, credits = 120, xp_lines = ${JSON.stringify([{ key: "extract", qty: 11, xp: 210 }])}::jsonb where entry_id = ${done}`);
    await db.update(users).set({ xp: 500 }).where(eq(users.id, u.userId));
    // A legacy exit (no entry row) is not a world raid.
    await addExit({ matchId: randomUUID(), cycleId: C, userId: u.userId, exit: "dead", at: new Date(Date.now() + 60_000) });

    const active = await addEntry({ matchId: s.matchId, cycleId: C, userId: u.userId });
    const me = await meWorld(db, u.userId, OPEN_NOW);
    assert.deepEqual(me.activeEntry, { matchId: s.matchId, entryId: active, cycle: C, wipeAt: s.endsAt, rejoinable: true });
    assert.ok(me.lastRaid);
    assert.deepEqual(
      { ...me.lastRaid!, at: 0 },
      {
        entryId: done,
        cycle: C,
        mapNumber: mapNumber(C),
        exit: "extract",
        at: 0,
        onMapMs: 700_000,
        xp: 300,
        xpLines: [{ key: "extract", qty: 11, xp: 210 }],
        credits: 120,
        levelBefore: levelForXp(200),
        level: levelForXp(500),
        kills: { players: 2, npcs: 6, bosses: 1 },
      },
    );
    // Next cycle: the same active entry is no longer rejoinable.
    const later = await meWorld(db, u.userId, worldCycleOf(C + 1).openAt);
    assert.equal(later.activeEntry?.rejoinable, false);
  });
});

// ============================================================================ leaderboards

describe("leaderboards", () => {
  test("level: xp > 0 only, ties share a rank, period is all-time", async () => {
    const [a, b, c, d] = [await user("lvA"), await user("lvB"), await user("lvC"), await user("lvD")];
    await db.update(users).set({ xp: 500, level: levelForXp(500) }).where(eq(users.id, a.userId));
    await db.update(users).set({ xp: 500, level: levelForXp(500) }).where(eq(users.id, b.userId));
    await db.update(users).set({ xp: 300, level: levelForXp(300) }).where(eq(users.id, c.userId));
    const lb = await leaderboard(db, "level", "map", OPEN_NOW);
    assert.equal(lb.period, "all");
    assert.equal(lb.cycle, null);
    assert.deepEqual(
      lb.rows.map((r) => [r.rank, r.nickname, r.value, r.level]),
      [
        [1, "lvA", 500, levelForXp(500)],
        [1, "lvB", 500, levelForXp(500)],
        [3, "lvC", 300, levelForXp(300)],
      ],
    );
    assert.deepEqual(await leaderboardMe(db, b.userId, "level", "week", OPEN_NOW), { rank: 1, value: 500 });
    assert.deepEqual(await leaderboardMe(db, c.userId, "level", "week", OPEN_NOW), { rank: 3, value: 300 });
    assert.equal(await leaderboardMe(db, d.userId, "level", "week", OPEN_NOW), null);
  });

  test("kills: ranked only, guests excluded, week / map / all filters", async () => {
    const now = OPEN_NOW;
    const monday = weekStartUtc(now);
    const [a, b, v] = [await user("kA"), await user("kB"), await user("kV")];
    const guest = randomUUID();
    await kill(a.userId, v.userId, { at: new Date(monday + 1000) });
    await kill(a.userId, b.userId, { at: new Date(monday + 2000), cycleId: C - 3 });
    await kill(b.userId, v.userId, { at: new Date(monday + 3000) });
    await kill(b.userId, v.userId, { at: new Date(monday - 3600_000), cycleId: C - 200 }); // last week
    await kill(b.userId, a.userId, { at: new Date(monday + 4000), ranked: false });
    await kill(guest, v.userId, { at: new Date(monday + 5000) }); // no users row

    const week = await leaderboard(db, "kills", "week", now);
    assert.deepEqual(week.rows.map((r) => [r.rank, r.nickname, r.value]), [[1, "kA", 2], [2, "kB", 1]]);
    const all = await leaderboard(db, "kills", "all", now);
    // A tie shares the rank; the earlier first kill is listed first.
    assert.deepEqual(all.rows.map((r) => [r.rank, r.nickname, r.value]), [[1, "kB", 2], [1, "kA", 2]]);
    const map = await leaderboard(db, "kills", "map", now);
    assert.equal(map.cycle, C);
    assert.deepEqual(map.rows.map((r) => [r.nickname, r.value]), [["kA", 1], ["kB", 1]]);
    assert.deepEqual(await leaderboardMe(db, b.userId, "kills", "week", now), { rank: 2, value: 1 });
    assert.equal(await leaderboardMe(db, v.userId, "kills", "all", now), null);
  });

  test("npc: marauders + guards + bosses of registered exits; guest exits excluded", async () => {
    const [a, b] = [await user("nA"), await user("nB")];
    const m = randomUUID();
    await addExit({ matchId: m, cycleId: C, userId: a.userId, exit: "extract", npcKills: 3, bossKills: 1 });
    await addExit({ matchId: m, cycleId: C, userId: a.userId, exit: "dead", npcKills: 2 });
    await addExit({ matchId: m, cycleId: C, userId: b.userId, exit: "extract", npcKills: 9, guest: true });
    await addExit({ matchId: m, cycleId: C - 1, userId: b.userId, exit: "extract", npcKills: 4 });
    const all = await leaderboard(db, "npc", "all", OPEN_NOW);
    assert.deepEqual(all.rows.map((r) => [r.rank, r.nickname, r.value]), [[1, "nA", 6], [2, "nB", 4]]);
    const map = await leaderboard(db, "npc", "map", OPEN_NOW);
    assert.deepEqual(map.rows.map((r) => [r.nickname, r.value]), [["nA", 6]]);
    assert.deepEqual(await leaderboardMe(db, b.userId, "npc", "all", OPEN_NOW), { rank: 2, value: 4 });
    assert.equal(await leaderboardMe(db, b.userId, "npc", "map", OPEN_NOW), null);
  });

  test("weekStartUtc is Monday 00:00 UTC", () => {
    assert.equal(new Date(weekStartUtc(Date.UTC(2026, 9, 4, 13))).toISOString(), "2026-09-28T00:00:00.000Z"); // Sunday
    assert.equal(new Date(weekStartUtc(Date.UTC(2026, 9, 5, 0, 0, 1))).toISOString(), "2026-10-05T00:00:00.000Z"); // Monday
  });
});

// ============================================================================ events

describe("worldEvents", () => {
  test("boss spawned / killed and wipes, newest first, ids <cycle>:<kind>, limit, nothing from the future", async () => {
    const p2 = shardReq({ cycleId: C - 2, boss: { kind: "commander", zone: "radar" } });
    const p1 = shardReq({ cycleId: C - 1 });
    const cur = shardReq({ boss: { kind: "foreman", zone: "elevator" } });
    const next = shardReq({ cycleId: C + 1, boss: { kind: "warden", zone: "depot" } }); // prewarmed
    for (const s of [p2, p1, cur, next]) await openShard(db, s);
    await recordWorldEvent(db, { matchId: p2.matchId, cycleId: C - 2, kind: "boss_killed", boss: "commander", by: "Ace", atMs: 1 }, new Date(worldCycleOf(C - 2).startAt + 600_000));
    await db.update(raids).set({ status: "settled" }).where(sql`${raids.matchId} in (${p2.matchId}, ${p1.matchId})`);
    const u = await user();
    await addEntry({ matchId: p1.matchId, cycleId: C - 1, userId: u.userId, status: "exited" });
    await addExit({ matchId: p1.matchId, cycleId: C - 1, userId: u.userId, exit: "extract" });

    const ev = await worldEvents(db, 20, OPEN_NOW);
    assert.deepEqual(ev.events.map((e) => e.id), [
      `${C}:boss_spawned`,
      `${C - 1}:wiped`,
      `${C - 2}:wiped`,
      `${C - 2}:boss_killed`,
      `${C - 2}:boss_spawned`,
    ]);
    const wiped = ev.events.find((e) => e.id === `${C - 1}:wiped`)!;
    assert.deepEqual(wiped.stats, { entries: 1, extracted: 1, died: 0, mia: 0 });
    assert.equal(wiped.at, worldCycleOf(C - 1).wipeAt);
    assert.equal(wiped.mapNumber, mapNumber(C - 1));
    const killed = ev.events.find((e) => e.kind === "boss_killed")!;
    assert.deepEqual([killed.by, killed.boss?.name, killed.boss?.zoneName], ["Ace", "Commander", "Radar Base"]);
    assert.equal(ev.events[0]!.at, WC.startAt);

    const two = await worldEvents(db, 2, OPEN_NOW);
    assert.equal(two.events.length, 2);
  });
});

// ============================================================================ economy stats

describe("economy stats", () => {
  test("raids in 24 h = world entries + legacy roster raids (world shard rows are not counted)", async () => {
    const s = shardReq();
    await openShard(db, s);
    const [a, b] = [await user(), await user()];
    await addEntry({ matchId: s.matchId, cycleId: C, userId: a.userId, status: "exited" });
    await addEntry({ matchId: s.matchId, cycleId: C, userId: b.userId });
    await db.insert(raids).values({ matchId: randomUUID(), mode: "live", mapId: "steppe", matchSeed: 1, endsAt: new Date(Date.now() + 1_800_000) });
    const st = await getEconomyStats(db);
    assert.equal(st.players.raids24h, 3);
  });
});
