/**
 * Daily tasks and cosmetics against the isolated `extract_test` database (see test-db.ts): issue at
 * the first look of a UTC day, progress from settled exit reports (applyExit), the daily XP cap,
 * carry-over, the free swap, equip checks, the leaderboard badge lookup.
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/quests/quests.test.ts
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  QUEST,
  WORLD,
  levelForXp,
  questDay,
  questDef,
  questStep,
  rollDailyQuests,
  rollQuest,
  xpToNext,
  type EntryRequest,
  type PlayerExitReport,
  type QuestId,
  type ShardOpenRequest,
} from "@extract/shared";
import { raidExits, users } from "../../db/schema";
import { applyExit } from "../inventory/raids";
import { enterRaid, openShard } from "../inventory/world";
import { closeTestDb, lockTestDb, makeUser, openTestDb, resetDb } from "../inventory/test-db";
import { advanceQuestsForExit, cosmeticBadges, equipCosmetic, getQuests, questMarks, rerollQuest } from "./quests";

const { db, pool } = openTestDb();
before(() => lockTestDb(pool));
after(() => closeTestDb(pool));
beforeEach(() => resetDb(db));

const MIN = 60_000;
const DAY1 = new Date(Date.UTC(2026, 9, 4, 10, 0, 0));
const DAY2 = new Date(Date.UTC(2026, 9, 5, 9, 0, 0));
let cycle = 700_000;

/** A fresh live shard (its own cycle, so the per-cycle entry limit never bites) and one entry. */
async function enter(userId: string): Promise<EntryRequest> {
  const c = cycle++;
  const startsAt = c * WORLD.CYCLE_MS;
  const shard: ShardOpenRequest = {
    matchId: randomUUID(),
    cycleId: c,
    shard: 0,
    roomId: "room1",
    mode: "live",
    mapId: "steppe",
    matchSeed: 7,
    startsAt,
    entryClosesAt: startsAt + WORLD.CYCLE_MS - WORLD.ENTRY_CLOSE_MS,
    endsAt: startsAt + WORLD.CYCLE_MS,
    boss: null,
    nextBoss: null,
    serverId: "eu-1",
    instanceId: "inst-1",
  };
  await openShard(db, shard);
  const e: EntryRequest = { matchId: shard.matchId, entryId: randomUUID(), userId, loadoutId: "", atMs: 60_000, targets: 30, bossAlive: true };
  const r = await enterRaid(db, e);
  assert.equal(r.status, "accepted", r.reason);
  return e;
}

function exitOf(e: EntryRequest, onMapMin: number, over: Partial<PlayerExitReport> = {}): PlayerExitReport {
  return {
    matchId: e.matchId,
    userId: e.userId,
    entryId: e.entryId,
    enteredAtMs: e.atMs,
    exit: "extract",
    atMs: e.atMs + onMapMin * MIN,
    kills: 0,
    level: 1,
    extracted: [],
    lost: [],
    destroyed: [],
    stats: { shotsFired: 0, dmgDealt: 0, containersSearched: 0, corpsesSearched: 0, bossKills: 0 },
    ...over,
  };
}

/** Puts these tasks in slots 0..2 (test setup; the real ones are rolled). */
async function setTasks(userId: string, ids: QuestId[], day: string) {
  for (let s = 0; s < ids.length; s++) {
    const d = questDef(ids[s])!;
    await db.execute(sql`
      insert into quest_slots (user_id, slot, quest_id, need, xp, progress, issued_day)
      values (${userId}, ${s}, ${d.id}, ${d.need}, ${d.xp}, 0, ${day}::date)
      on conflict (user_id, slot) do update set quest_id = excluded.quest_id, need = excluded.need, xp = excluded.xp,
        progress = 0, issued_day = excluded.issued_day, done_day = null, rerolled_day = null`);
  }
}

async function userXp(userId: string) {
  const r = await db.select({ xp: users.xp, level: users.level }).from(users).where(eq(users.id, userId));
  return r[0]!;
}

test("the first look of a UTC day issues three deterministic tasks; a second look changes nothing", async () => {
  const u = await makeUser(db);
  const q = (await getQuests(db, u, DAY1))!;
  assert.equal(q.day, "2026-10-04");
  assert.equal(q.resetAt, Date.UTC(2026, 9, 5));
  assert.deepEqual(q.slots.map((s) => s.id), rollDailyQuests(u, "2026-10-04"));
  assert.ok(q.slots.every((s) => s.progress === 0 && !s.done && !s.carried && s.xp === QUEST.XP));
  assert.equal(q.rerollAvailable, true);
  assert.equal(q.xpToday, 0);
  assert.equal(q.xpMax, QUEST.DAILY_XP_MAX);
  assert.equal(q.marks, 0);
  assert.deepEqual(q.equipped, { title: null, color: null, frame: null, skin: null });
  const again = (await getQuests(db, u, new Date(DAY1.getTime() + 3_600_000)))!;
  assert.deepEqual(again.slots, q.slots);
  assert.equal(await getQuests(db, randomUUID(), DAY1), null, "unknown user");
});

test("progress comes from settled exit reports; a finished task adds a 'quest' XP line outside xp_grind", async () => {
  const u = await makeUser(db);
  await getQuests(db, u, DAY1);
  await setTasks(u, ["containers_10", "marauders_3", "long_stay"], "2026-10-04");

  // Exit 1: 15 min extract, 6 containers, 2 marauders → long_stay done, others in progress.
  const e1 = await enter(u);
  const r1 = await applyExit(db, exitOf(e1, 15, { stats: { shotsFired: 0, dmgDealt: 0, containersSearched: 6, corpsesSearched: 0, bossKills: 0, npcKills: 2, guardKills: 0 } }), DAY1);
  assert.equal(r1.status, "applied");
  const qline = r1.xpLines.find((l) => l.key === "quest");
  assert.deepEqual(qline, { key: "quest", qty: 1, xp: 100 });
  const raidPart = r1.xpLines.filter((l) => l.key !== "quest").reduce((a, l) => a + l.xp, 0);
  assert.equal(r1.xp, raidPart + 100, "the exit's XP includes the task");
  const row1 = (await db.select().from(raidExits).where(eq(raidExits.entryId, e1.entryId)))[0]!;
  assert.equal(row1.xp, r1.xp, "raid_exits.xp = the whole XP change (lastRaid.levelBefore stays right)");
  const grindPart = r1.xpLines.filter((l) => !["quest", "first_extract", "boss", "pvp"].includes(l.key)).reduce((a, l) => a + l.xp, 0);
  assert.equal(row1.xpGrind, grindPart, "task XP stays out of the daily soft cap");
  assert.equal((await userXp(u)).xp, r1.xp);

  let q = (await getQuests(db, u, DAY1))!;
  assert.deepEqual(q.slots.map((s) => [s.id, s.progress, s.done]), [
    ["containers_10", 6, false],
    ["marauders_3", 2, false],
    ["long_stay", 1, true],
  ]);
  assert.equal(q.xpToday, 100);
  assert.equal(q.marks, 1);

  // Exit 2 (death, MIA-free): 5 containers and 1 marauder finish both → +200, the day's 300.
  const e2 = await enter(u);
  const r2 = await applyExit(db, exitOf(e2, 5, { exit: "dead", stats: { shotsFired: 0, dmgDealt: 0, containersSearched: 5, corpsesSearched: 0, bossKills: 0, npcKills: 1, guardKills: 0 } }), DAY1);
  assert.deepEqual(r2.xpLines.find((l) => l.key === "quest"), { key: "quest", qty: 2, xp: 200 });
  q = (await getQuests(db, u, DAY1))!;
  assert.ok(q.slots.every((s) => s.done));
  assert.equal(q.xpToday, QUEST.DAILY_XP_MAX);
  assert.equal(q.marks, 3);

  // A replayed report pays nothing again.
  const dup = await applyExit(db, exitOf(e2, 5, { exit: "dead" }), DAY1);
  assert.equal(dup.status, "duplicate");
  assert.equal(await questMarks(db, u), 3);

  // Everything done today: a third exit adds no task XP.
  const e3 = await enter(u);
  const r3 = await applyExit(db, exitOf(e3, 20, { stats: { shotsFired: 0, dmgDealt: 0, containersSearched: 30, corpsesSearched: 9, bossKills: 0, npcKills: 9, guardKills: 0 } }), DAY1);
  assert.equal(r3.xpLines.some((l) => l.key === "quest"), false);
});

test("the first-extract bonus is not doubled by tasks and the level reflects task XP", async () => {
  const u = await makeUser(db);
  await getQuests(db, u, DAY1);
  await setTasks(u, ["junk_300", "bodies_2", "extract_twice"], "2026-10-04");
  const e = await enter(u);
  // 8.5 min extract, two bodies: first-extract bonus doubles the raid lines only.
  const r = await applyExit(db, exitOf(e, 8.5, { stats: { shotsFired: 0, dmgDealt: 0, containersSearched: 0, corpsesSearched: 2, bossKills: 0 } }), DAY1);
  const first = r.xpLines.find((l) => l.key === "first_extract")!;
  const raid = r.xpLines.filter((l) => l.key !== "quest" && l.key !== "first_extract").reduce((a, l) => a + l.xp, 0);
  assert.equal(first.xp, raid, "bonus = the raid subtotal, not the task XP");
  assert.deepEqual(r.xpLines.at(-1), { key: "quest", qty: 1, xp: 100 });
  assert.equal(r.level, levelForXp(r.xp));
});

test("the daily task XP cap holds even when the log already has XP today", async () => {
  const u = await makeUser(db);
  await getQuests(db, u, DAY1);
  await setTasks(u, ["long_stay", "extract_twice", "marauders_3"], "2026-10-04");
  // 250 task XP already logged today on slot 2 (e.g. numbers changed mid-day).
  await db.execute(sql`insert into quest_log (user_id, day, slot, quest_id, xp) values (${u}, '2026-10-04', 2, 'marauders_3', 250)`);
  const e = await enter(u);
  const r = await applyExit(db, exitOf(e, 13), DAY1);
  assert.deepEqual(r.xpLines.find((l) => l.key === "quest"), { key: "quest", qty: 1, xp: 50 });
  const q = (await getQuests(db, u, DAY1))!;
  assert.equal(q.xpToday, QUEST.DAILY_XP_MAX);
  // Direct hook call with the day full: the task completes, no XP.
  await db.transaction(async (tx) => {
    const res = await advanceQuestsForExit(tx, u, { exit: "extract", onMapMs: 9 * MIN, haulCr: 0, containers: 0, marauders: 0, bodies: 0 }, randomUUID(), DAY1);
    assert.equal(res.xp, 0);
    assert.deepEqual(res.completed.map((c) => c.id), ["extract_twice"]);
  });
});

test("no tasks issued yet → exits pay no task XP and create no tasks", async () => {
  const u = await makeUser(db);
  const e = await enter(u);
  const r = await applyExit(db, exitOf(e, 20, { stats: { shotsFired: 0, dmgDealt: 0, containersSearched: 30, corpsesSearched: 5, bossKills: 0, npcKills: 5, guardKills: 0 } }), DAY1);
  assert.equal(r.xpLines.some((l) => l.key === "quest"), false);
  const n = await db.execute<{ n: number }>(sql`select count(*)::int as n from quest_slots where user_id = ${u}`);
  assert.equal(Number(n.rows[0]!.n), 0);
});

test("MIA counts kills only; a short extract does not count as an extract", async () => {
  const u = await makeUser(db);
  await getQuests(db, u, DAY1);
  await setTasks(u, ["containers_10", "marauders_3", "extract_twice"], "2026-10-04");
  const e1 = await enter(u);
  await applyExit(db, exitOf(e1, 30, { exit: "mia", stats: { shotsFired: 0, dmgDealt: 0, containersSearched: 7, corpsesSearched: 0, bossKills: 0, npcKills: 2, guardKills: 0 } }), DAY1);
  const e2 = await enter(u);
  await applyExit(db, exitOf(e2, 7), DAY1);
  const q = (await getQuests(db, u, DAY1))!;
  assert.deepEqual(q.slots.map((s) => s.progress), [0, 2, 0]);
});

test("a new UTC day refills finished slots and carries open tasks with their progress", async () => {
  const u = await makeUser(db);
  await getQuests(db, u, DAY1);
  await setTasks(u, ["long_stay", "containers_10", "marauders_3"], "2026-10-04");
  const e = await enter(u);
  await applyExit(db, exitOf(e, 12, { stats: { shotsFired: 0, dmgDealt: 0, containersSearched: 4, corpsesSearched: 0, bossKills: 0 } }), DAY1);
  const q2 = (await getQuests(db, u, DAY2))!;
  assert.equal(q2.day, "2026-10-05");
  assert.equal(q2.slots[0]!.id, rollQuest(u, "2026-10-05", 0, ["containers_10", "marauders_3"]));
  assert.equal(q2.slots[0]!.progress, 0);
  assert.equal(q2.slots[0]!.done, false);
  assert.equal(q2.slots[0]!.carried, false);
  assert.deepEqual([q2.slots[1]!.id, q2.slots[1]!.progress, q2.slots[1]!.carried], ["containers_10", 4, true]);
  assert.deepEqual([q2.slots[2]!.id, q2.slots[2]!.carried], ["marauders_3", true]);
  assert.equal(q2.xpToday, 0, "the day's task XP starts over");
  assert.equal(q2.marks, 1, "marks never reset");
  assert.equal(new Set(q2.slots.map((s) => s.id)).size, 3);
});

test("an exit after midnight refreshes the slots before counting", async () => {
  const u = await makeUser(db);
  await getQuests(db, u, DAY1);
  await setTasks(u, ["long_stay", "containers_10", "marauders_3"], "2026-10-04");
  await db.execute(sql`update quest_slots set progress = 1, done_day = '2026-10-04' where user_id = ${u} and slot = 0`);
  const next = rollQuest(u, "2026-10-05", 0, ["containers_10", "marauders_3"]);
  const e = await enter(u);
  const report = exitOf(e, 13, { stats: { shotsFired: 0, dmgDealt: 0, containersSearched: 0, corpsesSearched: 1, bossKills: 0 } });
  const r = await applyExit(db, report, DAY2);
  const want = Math.min(questDef(next)!.need, questStep(next, { exit: "extract", onMapMs: 13 * MIN, haulCr: 0, containers: 0, marauders: 0, bodies: 1 }));
  const q = (await getQuests(db, u, DAY2))!;
  assert.equal(q.slots[0]!.id, next);
  assert.equal(q.slots[0]!.progress, want, "the new day's task counted this exit");
  const done = want >= questDef(next)!.need;
  assert.equal(q.slots[0]!.done, done);
  assert.deepEqual(r.xpLines.find((l) => l.key === "quest"), done ? { key: "quest", qty: 1, xp: 100 } : undefined);
});

test("one free swap a day, open tasks only; the swap is deterministic and never repeats a task", async () => {
  const u = await makeUser(db);
  await getQuests(db, u, DAY1);
  await setTasks(u, ["long_stay", "containers_10", "marauders_3"], "2026-10-04");
  await db.execute(sql`update quest_slots set progress = 1, done_day = '2026-10-04' where user_id = ${u} and slot = 0`);
  await db.execute(sql`update quest_slots set progress = 4 where user_id = ${u} and slot = 1`);
  assert.deepEqual(await rerollQuest(db, u, 0, DAY1), { ok: false, code: "task_done" });
  assert.deepEqual(await rerollQuest(db, u, 7, DAY1), { ok: false, code: "bad_slot" });
  const r = await rerollQuest(db, u, 1, DAY1);
  assert.ok(r.ok);
  assert.equal(r.ok && r.id, rollQuest(u, "2026-10-04", 1, ["long_stay", "containers_10", "marauders_3"], 1));
  assert.ok(r.ok && !["long_stay", "containers_10", "marauders_3"].includes(r.id));
  const q = (await getQuests(db, u, DAY1))!;
  assert.equal(q.slots[1]!.progress, 0, "progress starts over");
  assert.equal(q.rerollAvailable, false);
  assert.deepEqual(await rerollQuest(db, u, 2, DAY1), { ok: false, code: "reroll_used" });
  // Next day: a new swap.
  const q2 = (await getQuests(db, u, DAY2))!;
  assert.equal(q2.rerollAvailable, true);
  assert.ok((await rerollQuest(db, u, 2, DAY2)).ok);
});

test("equip: only unlocked rewards of the right kind; marks unlock task rewards", async () => {
  const u = await makeUser(db);
  assert.deepEqual(await equipCosmetic(db, u, "title", "t-raider"), { ok: false, code: "locked" });
  assert.deepEqual(await equipCosmetic(db, u, "color", "t-raider"), { ok: false, code: "bad_cosmetic" });
  assert.deepEqual(await equipCosmetic(db, u, "title", "nope"), { ok: false, code: "bad_cosmetic" });
  // Level 5 (xp for levels 1..4).
  const xp5 = [1, 2, 3, 4].reduce((a, l) => a + xpToNext(l), 0);
  await db.update(users).set({ xp: xp5, level: 5 }).where(eq(users.id, u));
  const r = await equipCosmetic(db, u, "title", "t-raider");
  assert.deepEqual(r, { ok: true, equipped: { title: "t-raider", color: null, frame: null, skin: null } });
  assert.ok((await equipCosmetic(db, u, "color", "c-lime")).ok);
  assert.ok((await equipCosmetic(db, u, "frame", "f-rope")).ok);
  assert.deepEqual(await equipCosmetic(db, u, "frame", "f-steel"), { ok: false, code: "locked" });
  // 10 marks → Contract Blue.
  assert.deepEqual(await equipCosmetic(db, u, "color", "c-contract"), { ok: false, code: "locked" });
  for (let i = 0; i < 10; i++) {
    await db.execute(sql`insert into quest_log (user_id, day, slot, quest_id, xp) values (${u}, ${`2026-09-${String(i + 1).padStart(2, "0")}`}::date, 0, 'bodies_2', 100)`);
  }
  assert.ok((await equipCosmetic(db, u, "color", "c-contract")).ok);
  const q = (await getQuests(db, u, DAY1))!;
  assert.deepEqual(q.equipped, { title: "t-raider", color: "c-contract", frame: "f-rope", skin: null });
  assert.equal(q.level, 5);
  assert.equal(q.marks, 10);
  // Take the title off.
  assert.deepEqual(await equipCosmetic(db, u, "title", null), { ok: true, equipped: { title: null, color: "c-contract", frame: "f-rope", skin: null } });
  assert.deepEqual(await equipCosmetic(db, randomUUID(), "title", null), { ok: false, code: "no_user" });

  // Leaderboard lookup: only players with something on.
  const plain = await makeUser(db, "plainone");
  const nick = (await db.select({ n: users.nickname }).from(users).where(eq(users.id, u)))[0]!.n;
  const b = await cosmeticBadges(db, [nick, "plainone", "nobody_here"]);
  assert.deepEqual(b, { [nick]: { color: "c-contract", frame: "f-rope" } });
  assert.ok(plain);
  assert.deepEqual(await cosmeticBadges(db, []), {});
});

test("questDay matches the XP day boundary used by settlement", () => {
  assert.equal(questDay(DAY1.getTime()), "2026-10-04");
  assert.equal(questDay(Date.UTC(2026, 9, 4, 23, 59, 59)), "2026-10-04");
});
