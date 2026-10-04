/**
 * WORLD v6 web admission (spec §4.2, test T19) against the isolated `extract_test` database.
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/inventory/world.test.ts
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  BOSSES,
  POOL,
  WORLD,
  uniqueTierScore,
  type EntryRequest,
  type ShardOpenRequest,
} from "@extract/shared";
import { itemEvents, items, loadouts, raidEntries, raids } from "../../db/schema";
import { addStack } from "./transition";
import { lockLoadout } from "./loadout";
import { applyExit } from "./raids";
import { enterRaid, openShard, recordWorldEvent } from "./world";
import { closeTestDb, lockTestDb, makeItem, makeUser, openTestDb, resetDb } from "./test-db";

const { db, pool } = openTestDb();
before(() => lockTestDb(pool));
after(() => closeTestDb(pool));
beforeEach(() => resetDb(db));

const CYCLE = 640_000;

function shardReq(over: Partial<ShardOpenRequest> = {}): ShardOpenRequest {
  const startsAt = CYCLE * WORLD.CYCLE_MS;
  return {
    matchId: randomUUID(),
    cycleId: CYCLE,
    shard: 0,
    roomId: "room1",
    mode: "live",
    mapId: "steppe",
    matchSeed: 42,
    startsAt,
    entryClosesAt: startsAt + WORLD.CYCLE_MS - WORLD.ENTRY_CLOSE_MS,
    endsAt: startsAt + WORLD.CYCLE_MS,
    boss: null,
    nextBoss: null,
    serverId: "eu-1",
    instanceId: "inst-1",
    ...over,
  };
}

function entryReq(matchId: string, userId: string, loadoutId = "", over: Partial<EntryRequest> = {}): EntryRequest {
  return { matchId, entryId: randomUUID(), userId, loadoutId, atMs: 60_000, targets: 30, bossAlive: true, ...over };
}

/** `n` lost-pool items in one insert: rifles of rarity 0..3 and armor_1 (score 0). */
async function bulkPool(n: number) {
  await db.insert(items).values(
    Array.from({ length: n }, (_, i) => ({
      defId: i % 2 ? "rifle" : "armor_1",
      rarity: i % 4,
      durability: 80,
      state: "lost_pool" as const,
      origin: "seed" as const,
    })),
  );
}

/** A registered user with a rifle r1 (rare), armor_2 r1 at 50 % (rare), backpack_1 and 60 ammo, locked: 3 risk units, max tier 1. */
async function geared(userId?: string) {
  const u = userId ?? (await makeUser(db));
  const rifle = await makeItem(db, { def: "rifle", rarity: 1, ownerId: u });
  const armor = await makeItem(db, { def: "armor_2", rarity: 1, dur: 50, ownerId: u });
  const bp = await makeItem(db, { def: "backpack_1", rarity: 0, ownerId: u });
  await db.transaction((tx) => addStack(tx, u, "ammo_light", 100));
  const lock = await lockLoadout(db, u, [
    { key: "w1", itemId: rifle, def: "rifle", qty: 1 },
    { key: "armor", itemId: armor, def: "armor_2", qty: 1 },
    { key: "bp", itemId: bp, def: "backpack_1", qty: 1 },
    { key: "p0", def: "ammo_light", qty: 60 },
  ]);
  assert.ok(lock.ok, JSON.stringify(lock));
  return { userId: u, rifle, armor, bp, loadoutId: lock.ok ? lock.loadoutId : "" };
}

async function relock(p: { userId: string; rifle: string; armor: string; bp: string }) {
  const lock = await lockLoadout(db, p.userId, [
    { key: "w1", itemId: p.rifle, def: "rifle", qty: 1 },
    { key: "armor", itemId: p.armor, def: "armor_2", qty: 1 },
    { key: "bp", itemId: p.bp, def: "backpack_1", qty: 1 },
  ]);
  assert.ok(lock.ok, JSON.stringify(lock));
  return lock.ok ? lock.loadoutId : "";
}

/** Extract with the entry's own gear (snapshot uniques), nothing else. */
async function extractAll(e: EntryRequest, uids: Array<{ uid: string; def: string; rarity: number; dur: number }>) {
  const r = await applyExit(db, {
    matchId: e.matchId,
    userId: e.userId,
    exit: "extract",
    atMs: e.atMs + 600_000,
    kills: 0,
    level: 1,
    extracted: uids.map((u) => ({ ...u, qty: 1 })),
    lost: [],
    destroyed: [],
    stats: { shotsFired: 0, dmgDealt: 0, containersSearched: 0, corpsesSearched: 0, bossKills: 0 },
    entryId: e.entryId,
    enteredAtMs: e.atMs,
  });
  assert.equal(r.status, "applied");
}

async function raidRow(matchId: string) {
  return (await db.select().from(raids).where(eq(raids.matchId, matchId)))[0]!;
}

describe("raids/open", () => {
  test("opens a world row once; a replay answers exists", async () => {
    const req = shardReq({ boss: { kind: "foreman", zone: "elevator" }, nextBoss: { kind: "warden", zone: "radar" } });
    assert.equal((await openShard(db, req)).status, "opened");
    const again = await openShard(db, { ...req, roomId: "other" });
    assert.equal(again.status, "exists");
    assert.equal(again.autosellMult, 1);
    const r = await raidRow(req.matchId);
    assert.deepEqual(
      [r.kind, r.status, r.cycleId, r.shard, r.roomId, r.serverId, r.instanceId, r.bossKind, r.bossZone, r.nextBossKind, r.bossBagFilled],
      ["world", "running", CYCLE, 0, "room1", "eu-1", "inst-1", "foreman", "elevator", "warden", false],
    );
    assert.equal(r.endsAt.getTime(), req.endsAt);
    assert.equal(r.entryClosesAt!.getTime(), req.entryClosesAt);
    assert.equal(r.poolReleased, 0, "nothing is released at open");
  });
});

describe("raids/enter", () => {
  test("accepts a locked loadout; a replay returns the stored response and moves nothing twice", async () => {
    const s = shardReq();
    await openShard(db, s);
    const p = await geared();
    const e = entryReq(s.matchId, p.userId, p.loadoutId);
    const r = await enterRaid(db, e);
    assert.equal(r.status, "accepted");
    assert.equal(r.guest, false);
    assert.equal(r.level, 1);
    assert.equal(r.snapshot!.loadoutId, p.loadoutId);
    assert.deepEqual(r.snapshot!.entries.map((x) => x.key).sort(), ["armor", "bp", "p0", "w1"]);
    const lo = (await db.select().from(loadouts).where(eq(loadouts.id, p.loadoutId)))[0]!;
    assert.deepEqual([lo.status, lo.matchId], ["in_raid", s.matchId]);
    const rifle = (await db.select().from(items).where(eq(items.id, p.rifle)))[0]!;
    assert.deepEqual([rifle.state, rifle.matchId], ["in_raid", s.matchId]);
    const starts = await db.select().from(itemEvents).where(and(eq(itemEvents.reason, "start"), eq(itemEvents.refId, e.entryId)));
    assert.equal(starts.length, 3, "journaled per entry");

    const replay = await enterRaid(db, e);
    assert.deepEqual(replay, r);
    const row = (await db.select().from(raidEntries).where(eq(raidEntries.entryId, e.entryId)))[0]!;
    assert.deepEqual([row.status, row.riskUnits, row.maxTier, row.freeKit, row.guest, row.cycleId], ["active", 3, 1, false, false, CYCLE]);
    // Someone else replaying that entry id gets nothing of it.
    const thief = await enterRaid(db, { ...e, userId: await makeUser(db) });
    assert.deepEqual([thief.status, thief.reason], ["rejected", "wrong_user"]);
  });

  test("rejections: unknown / settled shard, someone else's loadout, a loadout that is not locked (nothing stored)", async () => {
    const u = await makeUser(db);
    assert.equal((await enterRaid(db, entryReq(randomUUID(), u))).reason, "shard_closed");
    const s = shardReq();
    await openShard(db, s);
    const p = await geared();
    const other = await makeUser(db);
    const e = entryReq(s.matchId, other, p.loadoutId);
    assert.deepEqual([(await enterRaid(db, e)).reason], ["wrong_user"]);
    assert.equal((await db.select().from(raidEntries)).length, 0, "a rejected entry leaves no row");
    assert.equal((await enterRaid(db, entryReq(s.matchId, other, randomUUID()))).reason, "not_locked");
    await db.update(raids).set({ status: "settled" }).where(eq(raids.matchId, s.matchId));
    assert.equal((await enterRaid(db, entryReq(s.matchId, p.userId, p.loadoutId))).reason, "shard_closed");
  });

  test("one active entry per user; entry cap WORLD.MAX_ENTRIES_PER_CYCLE per cycle", async () => {
    const s = shardReq();
    await openShard(db, s);
    const u = await makeUser(db);
    const first = entryReq(s.matchId, u);
    assert.equal((await enterRaid(db, first)).status, "accepted");
    const second = await enterRaid(db, entryReq(s.matchId, u));
    assert.deepEqual([second.status, second.reason], ["rejected", "already_active"]);
    await extractAll(first, []);
    for (let i = 1; i < WORLD.MAX_ENTRIES_PER_CYCLE; i++) {
      const e = entryReq(s.matchId, u);
      assert.equal((await enterRaid(db, e)).status, "accepted", `entry ${i + 1}`);
      await extractAll(e, []);
    }
    const over = await enterRaid(db, entryReq(s.matchId, u));
    assert.deepEqual([over.status, over.reason], ["rejected", "entry_limit"]);
    // The next cycle's shard is a new budget.
    const next = shardReq({ cycleId: CYCLE + 1 });
    await openShard(db, next);
    assert.equal((await enterRaid(db, entryReq(next.matchId, u))).status, "accepted");
  });

  test("delta release (D17): re-entering with the same gear releases nothing more this cycle; tier match", async () => {
    await bulkPool(60);
    const s = shardReq();
    await openShard(db, s);
    const p = await geared();
    const e1 = entryReq(s.matchId, p.userId, p.loadoutId);
    const r1 = await enterRaid(db, e1);
    assert.equal(r1.pool.length, 3, "round(K × 3 risk units)");
    for (const it of r1.pool) assert.ok(uniqueTierScore(it.def, it.rarity) <= 1, `tier match: ${it.def} r${it.rarity}`);
    const allocs = await db.select().from(itemEvents).where(and(eq(itemEvents.reason, "alloc"), eq(itemEvents.refId, e1.entryId)));
    assert.equal(allocs.length, 3);
    assert.ok(allocs.every((a) => a.matchId === s.matchId));
    assert.equal((await raidRow(s.matchId)).poolReleased, 3);

    const own = r1.snapshot!.entries.filter((x) => x.uid).map((x) => ({ uid: x.uid, def: x.def, rarity: x.rarity, dur: x.dur }));
    await extractAll(e1, own);
    const lo2 = await relock(p);
    const e2 = entryReq(s.matchId, p.userId, lo2);
    const r2 = await enterRaid(db, e2);
    assert.equal(r2.status, "accepted");
    assert.equal(r2.pool.length, 0, "the cycle budget is spent");
    assert.equal((await raidRow(s.matchId)).poolReleased, 3);
  });

  test("free kits and guests release nothing; few targets or a late entry release nothing", async () => {
    await bulkPool(60);
    const s = shardReq();
    await openShard(db, s);
    const free = await enterRaid(db, entryReq(s.matchId, await makeUser(db)));
    assert.deepEqual([free.status, free.pool.length, free.snapshot], ["accepted", 0, null]);
    const guest = await enterRaid(db, entryReq(s.matchId, randomUUID()));
    assert.deepEqual([guest.status, guest.guest, guest.level, guest.pool.length], ["accepted", true, 0, 0]);
    const a = await geared();
    assert.equal((await enterRaid(db, entryReq(s.matchId, a.userId, a.loadoutId, { targets: POOL.MIN_TARGETS - 1 }))).pool.length, 0);
    const b = await geared();
    const late = WORLD.CYCLE_MS - WORLD.ENTRY_CLOSE_MS - 1000;
    assert.equal((await enterRaid(db, entryReq(s.matchId, b.userId, b.loadoutId, { atMs: late }))).pool.length, 0, "taper → 0");
  });

  test("daily cap: at most POOL.USER_DAILY_MAX items per user per UTC day", async () => {
    await bulkPool(60);
    const s = shardReq();
    await openShard(db, s);
    const p = await geared();
    // Earlier maps today released 7 for this user.
    await db.insert(raidEntries).values({
      entryId: randomUUID(),
      matchId: randomUUID(),
      cycleId: CYCLE - 2,
      userId: p.userId,
      status: "exited",
      released: POOL.USER_DAILY_MAX - 1,
    });
    const r = await enterRaid(db, entryReq(s.matchId, p.userId, p.loadoutId));
    assert.equal(r.pool.length, 1);
  });

  test("tier match: an entry risking only common gear gets only tier-0 pool items", async () => {
    await bulkPool(60);
    const s = shardReq();
    await openShard(db, s);
    const u = await makeUser(db);
    const a1 = await makeItem(db, { def: "armor_1", ownerId: u });
    const b1 = await makeItem(db, { def: "backpack_1", ownerId: u });
    const lock = await lockLoadout(db, u, [
      { key: "armor", itemId: a1, def: "armor_1", qty: 1 },
      { key: "bp", itemId: b1, def: "backpack_1", qty: 1 },
    ]);
    assert.ok(lock.ok);
    const r = await enterRaid(db, entryReq(s.matchId, u, lock.ok ? lock.loadoutId : ""));
    assert.equal(r.pool.length, 2);
    for (const it of r.pool) assert.equal(uniqueTierScore(it.def, it.rarity), 0);
  });

  test("boss bag (D19): filled once, only when the shard's risk reaches the slots", async () => {
    await bulkPool(POOL.BOSS_MIN_POOL + 60);
    const s = shardReq({ boss: { kind: "commander", zone: "radar" } });
    await openShard(db, s);
    const slots = BOSSES.commander.poolSlots.length;
    // One user with 2 risk units (< 3 slots): no bag yet.
    const u1 = await makeUser(db);
    const r1a = await makeItem(db, { def: "rifle", rarity: 1, ownerId: u1 });
    const r1b = await makeItem(db, { def: "armor_2", rarity: 0, ownerId: u1 });
    const l1 = await lockLoadout(db, u1, [
      { key: "w1", itemId: r1a, def: "rifle", qty: 1 },
      { key: "armor", itemId: r1b, def: "armor_2", qty: 1 },
    ]);
    const e1 = await enterRaid(db, entryReq(s.matchId, u1, l1.ok ? l1.loadoutId : ""));
    assert.equal(e1.bossFill.length, 0);
    // A boss already dead: nothing.
    const g = await geared();
    const dead = await enterRaid(db, entryReq(s.matchId, g.userId, g.loadoutId, { bossAlive: false }));
    assert.equal(dead.bossFill.length, 0);
    assert.equal((await raidRow(s.matchId)).bossBagFilled, false);
    // A free-kit entry after the shard reached 2 + 3 ≥ 3: this entry carries the bag.
    const e3 = await enterRaid(db, entryReq(s.matchId, await makeUser(db)));
    assert.equal(e3.bossFill.length, slots);
    for (const it of e3.bossFill) assert.ok(uniqueTierScore(it.def, it.rarity) <= 1, "no top risked → ≤ rare");
    assert.equal(e3.pool.length, 0);
    const row = await raidRow(s.matchId);
    assert.equal(row.bossBagFilled, true);
    assert.equal(row.riskUnits, 5);
    const bossEv = await db.select().from(itemEvents).where(eq(itemEvents.reason, "alloc_boss"));
    assert.equal(bossEv.length, slots);
    const e4 = await enterRaid(db, entryReq(s.matchId, await makeUser(db)));
    assert.equal(e4.bossFill.length, 0, "once per shard-cycle");
  });

  test("boss bag never takes the pool's top tier below POOL.TOP_RESERVE (review fix)", async () => {
    // TOP_RESERVE + 1 top rifles, rare rifles and plenty of commons (pool > BOSS_MIN_POOL).
    const lost = (defId: string, rarity: number, n: number) =>
      Array.from({ length: n }, () => ({ defId, rarity, durability: 80, state: "lost_pool" as const, origin: "seed" as const }));
    await db.insert(items).values([...lost("rifle", 2, POOL.TOP_RESERVE + 1), ...lost("rifle", 1, 10), ...lost("armor_1", 0, POOL.BOSS_MIN_POOL + 10)]);
    const s = shardReq({ boss: { kind: "commander", zone: "radar" } });
    await openShard(db, s);
    // One entrant risking a top rifle and enough units for every slot; no per-entry release (targets 0).
    const u = await makeUser(db);
    const top = await makeItem(db, { def: "rifle", rarity: 2, ownerId: u });
    const armor = await makeItem(db, { def: "armor_2", rarity: 1, ownerId: u });
    const bp = await makeItem(db, { def: "backpack_2", rarity: 1, ownerId: u });
    const lock = await lockLoadout(db, u, [
      { key: "w1", itemId: top, def: "rifle", qty: 1 },
      { key: "armor", itemId: armor, def: "armor_2", qty: 1 },
      { key: "bp", itemId: bp, def: "backpack_2", qty: 1 },
    ]);
    assert.ok(lock.ok, JSON.stringify(lock));
    const r = await enterRaid(db, entryReq(s.matchId, u, lock.ok ? lock.loadoutId : "", { targets: 0 }));
    assert.equal(r.status, "accepted", r.reason);
    assert.equal(r.pool.length, 0);
    assert.equal(r.bossFill.length, BOSSES.commander.poolSlots.length);
    const tops = r.bossFill.filter((it) => uniqueTierScore(it.def, it.rarity) === 2).length;
    assert.equal(tops, 1, "only the one top item above the reserve");
    const left = await db.execute<{ n: number }>(sql`select count(*)::int as n from items where state = 'lost_pool' and def_id = 'rifle' and rarity >= 2`);
    assert.equal(Number(left.rows[0]!.n), POOL.TOP_RESERVE);
  });

  test("demo shards lock nothing and release nothing (the entry still exists)", async () => {
    await bulkPool(60);
    const s = shardReq({ mode: "demo", boss: { kind: "foreman", zone: "elevator" } });
    await openShard(db, s);
    const p = await geared();
    const e = entryReq(s.matchId, p.userId, p.loadoutId);
    const r = await enterRaid(db, e);
    assert.deepEqual([r.status, r.snapshot, r.pool.length, r.bossFill.length], ["accepted", null, 0, 0]);
    const lo = (await db.select().from(loadouts).where(eq(loadouts.id, p.loadoutId)))[0]!;
    assert.equal(lo.status, "locked", "the loadout never enters a demo shard");
    const rifle = (await db.select().from(items).where(eq(items.id, p.rifle)))[0]!;
    assert.equal(rifle.matchId, null);
    const row = (await db.select().from(raidEntries).where(eq(raidEntries.entryId, e.entryId)))[0]!;
    assert.deepEqual([row.status, row.freeKit, row.loadoutId], ["active", true, null]);
    const n = await db.execute<{ n: number }>(sql`select count(*)::int as n from items where state = 'lost_pool'`);
    assert.equal(Number(n.rows[0]!.n), 60);
  });
});

describe("raids/enter concurrency", () => {
  test("entries racing on one shard never deadlock; the same entry twice at once is admitted once", async () => {
    await bulkPool(80);
    const s = shardReq({ boss: { kind: "commander", zone: "radar" } });
    await openShard(db, s);
    const ps = await Promise.all([geared(), geared(), geared()]);
    const reqs = ps.map((p) => entryReq(s.matchId, p.userId, p.loadoutId));
    const res = await Promise.all([...reqs.map((r) => enterRaid(db, r)), enterRaid(db, reqs[0]!)]);
    assert.ok(res.every((r) => r.status === "accepted"), JSON.stringify(res.map((r) => r.reason)));
    assert.deepEqual(res[3], res[0], "the duplicate got the stored response");
    const rows = await db.select().from(raidEntries).where(eq(raidEntries.matchId, s.matchId));
    assert.equal(rows.length, 3);
    const released = rows.reduce((a, r) => a + r.released, 0);
    assert.equal((await raidRow(s.matchId)).poolReleased, released);
    // Shard cap = CYCLE_BASE + ceil(0.5 × riskUsers): never exceeded by the race.
    assert.ok(released <= POOL.CYCLE_BASE + Math.ceil(POOL.CYCLE_PER_RISK_USER * 3), `released ${released}`);
    const uids = res.slice(0, 3).flatMap((r) => [...r.pool, ...r.bossFill].map((i) => i.uid));
    assert.equal(new Set(uids).size, uids.length, "no item released twice");
  });
});

describe("world/event", () => {
  test("boss_killed is stored once", async () => {
    const s = shardReq({ boss: { kind: "foreman", zone: "elevator" } });
    await openShard(db, s);
    const ev = { matchId: s.matchId, cycleId: CYCLE, kind: "boss_killed" as const, boss: "foreman" as const, by: "Nick", atMs: 900_000 };
    assert.equal((await recordWorldEvent(db, ev)).status, "applied");
    assert.equal((await recordWorldEvent(db, { ...ev, by: "Other" })).status, "duplicate");
    assert.equal((await recordWorldEvent(db, { ...ev, matchId: randomUUID() })).status, "unknown");
    const r = await raidRow(s.matchId);
    assert.equal(r.bossKilledBy, "Nick");
    assert.ok(r.bossKilledAt);
  });
});
