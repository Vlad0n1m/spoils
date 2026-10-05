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
import { items, pvpKills, raidEntries, raidExits, raids, users } from "../../db/schema";
import { lockLoadout } from "../inventory/loadout";
import { RAID_USER_VOID_GRACE_MS, voidOrphans } from "../inventory/raids";
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
/** After the previous cycle's wipe (overlapping maps: C − 1 runs until WC.openAt + ENTRY_CLOSE_MS). */
const LATE_NOW = WC.openAt + WORLD.ENTRY_CLOSE_MS + 60_000;

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

  test("overlapping maps: never entry_closed — at the entry close of C the join goes to C + 1, open at once", async () => {
    const u = await user();
    const cur = shardReq();
    const nxt = shardReq({ cycleId: C + 1, roomId: `room-${C + 1}` });
    await openShard(db, cur);
    await openShard(db, nxt);
    const first = await worldJoin(db, u, undefined, WC.openAt);
    assert.ok(first.ok, JSON.stringify(first));
    if (first.ok) assert.equal(first.body.matchId, cur.matchId, "no reset gap: C takes entries from its opening");
    const before = await worldJoin(db, u, undefined, WC.entryClosesAt - 1);
    assert.ok(before.ok && before.body.matchId === cur.matchId);
    const at = await worldJoin(db, u, undefined, WC.entryClosesAt);
    assert.ok(at.ok, JSON.stringify(at));
    if (!at.ok) return;
    const N = worldCycleOf(C + 1);
    assert.deepEqual([at.body.matchId, at.body.cycle, at.body.wipeAt, at.body.entryClosesAt], [nxt.matchId, C + 1, N.wipeAt, N.entryClosesAt]);
    assert.equal(N.wipeAt - WC.entryClosesAt, WORLD.MAP_MS, "the first raiders of C + 1 get 55 minutes");
  });

  test("several shards: the fullest one with a free seat (players packed together), never a full one", async () => {
    const s0 = shardReq({ shard: 0, roomId: "room-s0" });
    const s1 = shardReq({ shard: 1, roomId: "room-s1" });
    await openShard(db, s0);
    await openShard(db, s1);
    const fill = async (matchId: string, n: number) => {
      for (let i = 0; i < n; i++) await addEntry({ matchId, cycleId: C, userId: (await user()).userId });
    };
    await fill(s0.matchId, 3);
    await fill(s1.matchId, 8);
    const a = await worldJoin(db, await user(), undefined, OPEN_NOW);
    assert.ok(a.ok && a.body.matchId === s1.matchId && a.body.roomId === "room-s1", "the fuller shard");
    await fill(s1.matchId, WORLD.CAPACITY - 8);
    const b = await worldJoin(db, await user(), undefined, OPEN_NOW);
    assert.ok(b.ok && b.body.matchId === s0.matchId, "a full shard is skipped");
    // Every shard full by the web's count: the emptiest one, and the game server decides (world_full + a new shard).
    await fill(s0.matchId, WORLD.CAPACITY - 3);
    const c = await worldJoin(db, await user(), undefined, OPEN_NOW);
    assert.ok(c.ok, JSON.stringify(c));
    // A row of the closing cycle is never picked for a fresh entry.
    await openShard(db, shardReq({ cycleId: C - 1, roomId: "room-prev" }));
    const d = await worldJoin(db, await user(), undefined, OPEN_NOW);
    assert.ok(d.ok && d.body.cycle === C && d.body.roomId !== "room-prev");
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

  test("guest: free kit ticket with matchId / entryId; refused once guest play is off (security audit)", async () => {
    const s = shardReq();
    await openShard(db, s);
    const g: Caller = { kind: "guest", userId: randomUUID(), nickname: "Guesty" };
    const prev = process.env.GUEST_PLAY_ENABLED;
    const prevPublic = process.env.NEXT_PUBLIC_GUEST_PLAY;
    process.env.GUEST_PLAY_ENABLED = "true";
    try {
      const r = await worldJoin(db, g, undefined, OPEN_NOW);
      assert.ok(r.ok, JSON.stringify(r));
      if (!r.ok) return;
      assert.equal(r.body.loadoutId, "");
      assert.equal(r.body.ticket.matchId, s.matchId);
      assert.ok(sigOk(r.body.ticket));
      // The same (still valid) guest cookie after the switch was turned off: no ticket.
      process.env.GUEST_PLAY_ENABLED = "false";
      delete process.env.NEXT_PUBLIC_GUEST_PLAY;
      const off = await worldJoin(db, g, undefined, OPEN_NOW);
      assert.equal(off.ok, false);
      if (!off.ok) assert.equal(off.status, 403);
    } finally {
      if (prev === undefined) delete process.env.GUEST_PLAY_ENABLED;
      else process.env.GUEST_PLAY_ENABLED = prev;
      if (prevPublic !== undefined) process.env.NEXT_PUBLIC_GUEST_PLAY = prevPublic;
    }
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
    // A rejoin works after entry closes too (the runtime is still on the map), with its own map's
    // cycle and wipe, while C + 1 is the open cycle.
    const late = await worldJoin(db, u, undefined, WC.entryClosesAt + 60_000);
    assert.ok(late.ok && late.body.rejoin);
    if (late.ok) assert.deepEqual([late.body.cycle, late.body.wipeAt, late.body.matchId], [C, WC.wipeAt, s.matchId]);
    // The battle screen's reconnect (rejoinOnly) gets the same rejoin ticket…
    const only = await worldJoin(db, u, undefined, OPEN_NOW + 6_000, { rejoinOnly: true });
    assert.ok(only.ok && only.body.rejoin && only.body.ticket.entryId === entryId);
    // …but never a fresh entry: a user with no active entry gets not_on_map and nothing is locked.
    const other = await user();
    await makeItem(db, { def: "rifle", rarity: 0, ownerId: other.userId });
    const none = await worldJoin(db, other, undefined, OPEN_NOW + 6_000, { rejoinOnly: true });
    assert.ok(!none.ok);
    if (none.ok) return;
    assert.equal(none.status, 409);
    assert.equal(none.body.error, "not_on_map");
    const locked = await db.execute<{ n: number }>(sql`select count(*)::int as n from loadouts where user_id = ${other.userId}`);
    assert.equal(Number(locked.rows[0]!.n), 0, "no loadout locked");
  });

  for (const serverId of ["eu-1", "default"]) {
    test(`restart (${serverId}): a newer shard row of the cycle voids the dead shard's entry; PLAY gets a fresh entry on the new shard`, async () => {
      const u = await user();
      const rifle = await makeItem(db, { def: "rifle", rarity: 1, ownerId: u.userId });
      const t0 = WC.openAt + 30_000;
      // Process A boots (its void-orphans landed) and opens the shard; the user enters with the rifle.
      await voidOrphans(db, { serverId, instanceId: "inst-A", bootedAt: t0 }, new Date(t0));
      const a = shardReq({ serverId, instanceId: "inst-A", roomId: "room-A" });
      await openShard(db, a, new Date(t0 + 1_000));
      const j = await worldJoin(db, u, [{ key: "w1", itemId: rifle, def: "rifle", qty: 1 }], t0 + 2_000);
      assert.ok(j.ok, JSON.stringify(j));
      if (!j.ok) return;
      const entryId = j.body.ticket.entryId!;
      const res = await enterRaid(
        db,
        { matchId: a.matchId, entryId, userId: u.userId, loadoutId: j.body.loadoutId, atMs: 60_000, targets: 0, bossAlive: false },
        new Date(t0 + 3_000),
      );
      assert.equal(res.status, "accepted", JSON.stringify(res));
      // The next cycle's prewarmed row is no restart: the entry stays rejoinable.
      await openShard(db, shardReq({ cycleId: C + 1, serverId, instanceId: "inst-A", roomId: "room-A2" }), new Date(t0 + 4_000));
      assert.equal((await meWorld(db, u.userId, t0 + 5_000)).activeEntry?.rejoinable, true);
      // Neither is a newer row of this cycle from a server with another GAME_SERVER_ID.
      await openShard(db, shardReq({ serverId: `${serverId}-other`, instanceId: "inst-X", roomId: "room-X" }), new Date(t0 + 6_000));
      assert.equal((await meWorld(db, u.userId, t0 + 7_000)).activeEntry?.rejoinable, true);

      // A crashes; B boots but its void-orphans never lands, then raids/open of a fresh shard of this cycle does.
      const b = shardReq({ serverId, instanceId: "inst-B", roomId: "room-B" });
      await openShard(db, b, new Date(t0 + 120_000));

      const me = await meWorld(db, u.userId, t0 + 180_000);
      assert.equal(me.activeEntry, null, "the dead shard's entry is voided, not offered as a rejoin");
      const [entry] = await db.select().from(raidEntries).where(eq(raidEntries.entryId, entryId));
      assert.equal(entry!.status, "voided");
      const [raidA] = await db.select().from(raids).where(eq(raids.matchId, a.matchId));
      assert.equal(raidA!.status, "voided");
      const [raidB] = await db.select().from(raids).where(eq(raids.matchId, b.matchId));
      assert.equal(raidB!.status, "running", "the live shard is untouched");
      const [item] = await db.select().from(items).where(eq(items.id, rifle));
      assert.deepEqual([item!.state, item!.ownerId], ["in_stash", u.userId], "the gear came back");

      const again = await worldJoin(db, u, undefined, t0 + 181_000);
      assert.ok(again.ok, JSON.stringify(again));
      if (!again.ok) return;
      assert.deepEqual([again.body.rejoin, again.body.matchId, again.body.roomId], [false, b.matchId, "room-B"]);
      assert.notEqual(again.body.ticket.entryId, entryId);
    });
  }

  test("an active entry on the previous map: a rejoin while it still runs, 409 in_raid with settlesAt = ends_at + 5 min after its wipe", async () => {
    const u = await user();
    const prev = shardReq({ cycleId: C - 1 });
    await openShard(db, prev);
    await openShard(db, shardReq());
    await addEntry({ matchId: prev.matchId, cycleId: C - 1, userId: u.userId });
    // Overlapping maps: C − 1 runs until its wipe (10 min after C opened); its raider rejoins it.
    const back = await worldJoin(db, u, undefined, OPEN_NOW);
    assert.ok(back.ok && back.body.rejoin, JSON.stringify(back));
    if (back.ok) assert.deepEqual([back.body.matchId, back.body.cycle, back.body.wipeAt], [prev.matchId, C - 1, prev.endsAt]);
    const r = await worldJoin(db, u, undefined, LATE_NOW);
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
      [st.online, st.humans, st.shards, st.boss, st.last, st.closing, st.cycle, st.mapNumber, st.phase, st.capacity],
      [false, 0, 0, null, null, null, C, mapNumber(C), "open", WORLD.CAPACITY],
    );
    assert.deepEqual([st.openAt, st.entryClosesAt, st.wipeAt, st.serverTime], [WC.openAt, WC.entryClosesAt, WC.wipeAt, OPEN_NOW]);
    assert.deepEqual(st.next, { cycle: C + 1, mapNumber: mapNumber(C + 1), openAt: worldCycleOf(C + 1).openAt });
    assert.ok(!("boss" in st.next));
  });

  test("online with an alive boss (revealed when its map opens); killed with the killer's nickname", async () => {
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
    assert.ok(!("boss" in st.next), "the next map's boss shows once that map opens, as its own boss");
    assert.deepEqual([st.shards, st.capacity], [1, WORLD.CAPACITY]);

    await recordWorldEvent(db, { matchId: s.matchId, cycleId: C, kind: "boss_killed", boss: "foreman", by: "Nick", atMs: 600_000 });
    const killed = await worldStatus(db, OPEN_NOW);
    assert.deepEqual([killed.boss?.status, killed.boss?.killedBy], ["killed", "Nick"]);
  });

  test("several shards: humans and capacity over all of them; the boss is killed once it died on every shard", async () => {
    const boss = { kind: "foreman" as const, zone: "elevator" };
    const s0 = shardReq({ shard: 0, boss });
    const s1 = shardReq({ shard: 1, boss });
    await openShard(db, s0);
    await openShard(db, s1);
    for (const m of [s0.matchId, s0.matchId, s1.matchId]) await addEntry({ matchId: m, cycleId: C, userId: (await user()).userId });
    const st = await worldStatus(db, OPEN_NOW);
    assert.deepEqual([st.humans, st.shards, st.capacity, st.boss?.status], [3, 2, 2 * WORLD.CAPACITY, "alive"]);
    await recordWorldEvent(db, { matchId: s1.matchId, cycleId: C, kind: "boss_killed", boss: "foreman", by: "Ann", atMs: 600_000 }, new Date(OPEN_NOW + 1_000));
    assert.equal((await worldStatus(db, OPEN_NOW + 2_000)).boss?.status, "alive", "still alive on shard 0");
    await recordWorldEvent(db, { matchId: s0.matchId, cycleId: C, kind: "boss_killed", boss: "foreman", by: "Bob", atMs: 700_000 }, new Date(OPEN_NOW + 3_000));
    const k = await worldStatus(db, OPEN_NOW + 4_000);
    assert.deepEqual([k.boss?.status, k.boss?.killedBy], ["killed", "Ann"], "the first killer");
  });

  test("closing: the previous map while it still runs (raiders on it), gone after its wipe", async () => {
    const prev = shardReq({ cycleId: C - 1 });
    await openShard(db, prev);
    await openShard(db, shardReq());
    await addEntry({ matchId: prev.matchId, cycleId: C - 1, userId: (await user()).userId });
    const st = await worldStatus(db, OPEN_NOW);
    assert.equal(st.cycle, C);
    assert.deepEqual(st.closing, { cycle: C - 1, mapNumber: mapNumber(C - 1), wipeAt: worldCycleOf(C - 1).wipeAt, humans: 1 });
    assert.equal(st.humans, 0, "the closing map's raiders are not on the open map");
    assert.equal((await worldStatus(db, LATE_NOW)).closing, null);
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

    const st = await worldStatus(db, LATE_NOW);
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
    // During the overlap the previous map is not over yet: `last` is the one before it.
    assert.equal((await worldStatus(db, OPEN_NOW)).last, null);
  });

  test("last is null while the previous cycle's row is still running (end report pending)", async () => {
    await openShard(db, shardReq({ cycleId: C - 1 }));
    assert.equal((await worldStatus(db, LATE_NOW)).last, null);
  });
});

// ============================================================================ me/world

describe("meWorld", () => {
  test("active entry (rejoinable on a running row until its map wipes) and the last world raid", async () => {
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
    // The next cycle opened (entry to C closed): C still runs, so the entry is rejoinable until C's wipe.
    const overlap = await meWorld(db, u.userId, worldCycleOf(C + 1).openAt);
    assert.equal(overlap.activeEntry?.rejoinable, true);
    const later = await meWorld(db, u.userId, WC.wipeAt);
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

    const ev = await worldEvents(db, 20, LATE_NOW);
    assert.deepEqual(ev.events.map((e) => e.id), [
      `${C - 1}:wiped`,
      `${C}:boss_spawned`,
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
    assert.equal(ev.events[1]!.at, WC.startAt, "a boss spawns when its map opens");
    // Before C − 1's wipe its `wiped` is in the future.
    assert.ok(!(await worldEvents(db, 20, OPEN_NOW)).events.some((e) => e.id === `${C - 1}:wiped`));

    const two = await worldEvents(db, 2, LATE_NOW);
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
