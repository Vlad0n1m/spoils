/**
 * Alpha Pass against the isolated `extract_test` database (see test-db.ts): AP from settled exits
 * (daily tasks, weekly tasks, tester tasks), idempotent awards, claims and their permanence across
 * an item wipe, the bug report review, the survey, the invite reward and the alpha trophy.
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/pass/pass.test.ts
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  ALPHA_TROPHY,
  FOUNDER_BADGE,
  INVITE_REWARD,
  PASS,
  PASS_TIERS,
  WORLD,
  passWeek,
  questDef,
  rollWeeklyTasks,
  weeklyDef,
  type EntryRequest,
  type PlayerExitReport,
  type QuestId,
  type ShardOpenRequest,
  type WeeklyId,
} from "@extract/shared";
import { applyExit } from "../inventory/raids";
import { enterRaid, openShard } from "../inventory/world";
import { closeTestDb, lockTestDb, makeItem, makeUser, openTestDb, resetDb } from "../inventory/test-db";
import { cosmeticBadges, equipCosmetic, getQuests } from "../quests/quests";
import { claimPassTier, getPass, grantAlphaTrophies, listBugReports, passAp, reviewBugReport, submitBugReport, submitSurvey } from "./pass";

const { db, pool } = openTestDb();
before(() => lockTestDb(pool));
after(() => closeTestDb(pool));
beforeEach(() => resetDb(db));

const MIN = 60_000;
const DAY1 = new Date(Date.UTC(2026, 9, 6, 10, 0, 0)); // Tuesday
const WEEK = passWeek(DAY1.getTime());
let cycle = 900_000;

async function enter(userId: string, matchId?: string): Promise<EntryRequest> {
  const c = cycle++;
  const startsAt = c * WORLD.CYCLE_MS;
  const shard: ShardOpenRequest = {
    matchId: matchId ?? randomUUID(),
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
  if (!matchId) await openShard(db, shard);
  const e: EntryRequest = { matchId: shard.matchId, entryId: randomUUID(), userId, loadoutId: "", atMs: 60_000, targets: 30, bossAlive: true };
  const r = await enterRaid(db, e);
  assert.equal(r.status, "accepted", r.reason);
  return e;
}

const stats = (o: Partial<PlayerExitReport["stats"]> = {}): PlayerExitReport["stats"] => ({
  shotsFired: 0,
  dmgDealt: 0,
  containersSearched: 0,
  corpsesSearched: 0,
  bossKills: 0,
  npcKills: 0,
  guardKills: 0,
  ...o,
});

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
    stats: stats(),
    ...over,
  };
}

async function raid(userId: string, onMapMin: number, over: Partial<PlayerExitReport> = {}, now = DAY1) {
  const e = await enter(userId);
  const r = await applyExit(db, exitOf(e, onMapMin, over), now);
  assert.equal(r.status, "applied");
  return e;
}

async function setWeekly(userId: string, ids: WeeklyId[]) {
  for (let s = 0; s < ids.length; s++) {
    const d = weeklyDef(ids[s])!;
    await db.execute(sql`
      insert into pass_weekly (user_id, slot, week, quest_id, need, progress)
      values (${userId}, ${s}, ${WEEK}::date, ${d.id}, ${d.need}, 0)
      on conflict (user_id, slot) do update set week = excluded.week, quest_id = excluded.quest_id, need = excluded.need, progress = 0, done_at = null`);
  }
}

async function setDaily(userId: string, ids: QuestId[]) {
  await getQuests(db, userId, DAY1);
  for (let s = 0; s < ids.length; s++) {
    const d = questDef(ids[s])!;
    await db.execute(sql`
      update quest_slots set quest_id = ${d.id}, need = ${d.need}, xp = ${d.xp}, progress = 0, done_day = null
      where user_id = ${userId} and slot = ${s}`);
  }
}

test("a new player sees an empty pass with the week's three tasks; the first look issues them", async () => {
  const u = await makeUser(db);
  const p = (await getPass(db, u, DAY1))!;
  assert.equal(p.ap, 0);
  assert.equal(p.tier, 0);
  assert.equal(p.tiers.length, 10);
  assert.ok(p.tiers.every((t) => !t.reached && !t.claimed));
  assert.deepEqual(p.next, { tier: 1, ap: 30, reward: "t-alpha-raider", name: "Alpha Raider" });
  assert.equal(p.weekly.week, WEEK);
  assert.deepEqual(p.weekly.slots.map((s) => s.id), rollWeeklyTasks(u, WEEK));
  assert.ok(p.tester.every((t) => !t.done));
  assert.equal(p.permanent, true);
  const again = (await getPass(db, u, new Date(DAY1.getTime() + 3_600_000)))!;
  assert.deepEqual(again.weekly, p.weekly);
  assert.equal(await getPass(db, randomUUID(), DAY1), null);
});

test("the tutorial task: an extract with a container and a marauder kill — once, 30 AP, tier 1", async () => {
  const u = await makeUser(db);
  await raid(u, 2, { stats: stats({ containersSearched: 1 }) });
  assert.equal(await passAp(db, u), 0, "no kill yet");
  await raid(u, 2, { exit: "dead", stats: stats({ containersSearched: 1, npcKills: 1 }) });
  assert.equal(await passAp(db, u), 0, "the tutorial ends with an extract");
  await raid(u, 2, { stats: stats({ containersSearched: 1, npcKills: 1 }) });
  assert.equal(await passAp(db, u), 30);
  await raid(u, 2, { stats: stats({ containersSearched: 3, npcKills: 2 }) });
  assert.equal(await passAp(db, u), 30, "a tester task pays once");
  const p = (await getPass(db, u, DAY1))!;
  assert.equal(p.tier, 1);
  assert.equal(p.tester.find((t) => t.id === "tutorial")!.done, true);
});

test("daily tasks pay AP next to their XP; weekly tasks progress from exits and pay once", async () => {
  const u = await makeUser(db);
  await setDaily(u, ["long_stay", "marauders_3", "containers_10"]);
  await setWeekly(u, ["w_streak3", "w_marauders15", "w_epic"]);
  await raid(u, 13);
  assert.equal(await passAp(db, u), PASS.AP_DAILY, "long_stay → 10 AP");
  await raid(u, 9, { stats: stats({ npcKills: 3 }) });
  assert.equal(await passAp(db, u), 2 * PASS.AP_DAILY);
  let p = (await getPass(db, u, DAY1))!;
  assert.equal(p.daily.doneToday, 2);
  assert.deepEqual(p.weekly.slots.map((s) => [s.id, s.progress, s.done]), [
    ["w_streak3", 2, false],
    ["w_marauders15", 3, false],
    ["w_epic", 0, false],
  ]);
  // Epic extract: a unique of rarity ≥ 2 in the extracted list; the third extract in a row closes the streak.
  const uid = await makeItem(db, { def: "armor_2", rarity: 2, state: "in_raid" });
  const e = await enter(u);
  await db.execute(sql`update items set match_id = ${e.matchId} where id = ${uid}`);
  await applyExit(db, exitOf(e, 9, { extracted: [{ uid, def: "armor_2", qty: 1, rarity: 2, dur: 100 }] }), DAY1);
  p = (await getPass(db, u, DAY1))!;
  assert.deepEqual(p.weekly.slots.map((s) => [s.id, s.done]), [
    ["w_streak3", true],
    ["w_marauders15", false],
    ["w_epic", true],
  ]);
  assert.equal(p.ap, 2 * PASS.AP_DAILY + 2 * PASS.AP_WEEKLY);
  // A death no longer touches a finished streak.
  await raid(u, 9, { exit: "dead" });
  p = (await getPass(db, u, DAY1))!;
  assert.equal(p.weekly.slots[0]!.progress, 3);
  assert.equal(p.ap, 2 * PASS.AP_DAILY + 2 * PASS.AP_WEEKLY);
});

test("a new week re-rolls the weekly tasks; the old week's AP stays", async () => {
  const u = await makeUser(db);
  await setWeekly(u, ["w_guards3", "w_boss", "w_bodies8"]);
  await raid(u, 9, { stats: stats({ npcKills: 4, guardKills: 3 }) });
  assert.equal(await passAp(db, u), PASS.AP_WEEKLY);
  const next = new Date(DAY1.getTime() + 7 * 86_400_000);
  const p = (await getPass(db, u, next))!;
  assert.equal(p.weekly.week, passWeek(next.getTime()));
  assert.deepEqual(p.weekly.slots.map((s) => s.id), rollWeeklyTasks(u, passWeek(next.getTime())));
  assert.ok(p.weekly.slots.every((s) => s.progress === 0 && !s.done));
  assert.equal(p.ap, PASS.AP_WEEKLY);
});

test("party and phone tester tasks need 3+ minutes on the map; party = a party drop of 2+ on this match", async () => {
  const a = await makeUser(db);
  const b = await makeUser(db);
  const e = await enter(a);
  const party = await db.execute<{ id: string }>(sql`insert into parties (leader_id) values (${a}) returning id`);
  await db.execute(sql`
    insert into party_drops (drop_id, party_id, cycle, match_id, leader_id, members, expires_at)
    values (${randomUUID()}, ${party.rows[0]!.id}, 1, ${e.matchId}, ${a}, ${JSON.stringify([a, b])}::jsonb, now())`);
  await applyExit(db, exitOf(e, 2, { touch: true }), DAY1);
  assert.equal(await passAp(db, a), 0, "2 minutes is too short");
  const e2 = await enter(b, e.matchId);
  await applyExit(db, exitOf(e2, 4, { exit: "dead", touch: true }), DAY1);
  assert.equal(await passAp(db, b), 80, "party 40 + phone 40, even on a death");
  const p = (await getPass(db, b, DAY1))!;
  assert.deepEqual(p.tester.filter((t) => t.done).map((t) => t.id).sort(), ["party", "touch"]);
});

test("claims: only reached tiers; the reward is owned, wearable, and survives an item wipe", async () => {
  const u = await makeUser(db);
  assert.deepEqual(await claimPassTier(db, u, 1, DAY1), { ok: false, code: "not_reached" });
  assert.deepEqual(await claimPassTier(db, u, 11, DAY1), { ok: false, code: "bad_tier" });
  await db.execute(sql`insert into pass_ap_log (user_id, source, task, period, ap) values (${u}, 'tester', 'tutorial', 'once', 600)`);
  for (const t of PASS_TIERS.filter((x) => x.ap <= 600)) assert.equal((await claimPassTier(db, u, t.tier, DAY1)).ok, true);
  assert.deepEqual(await claimPassTier(db, u, 9, DAY1), { ok: false, code: "not_reached" });
  assert.equal((await claimPassTier(db, u, 1, DAY1)).ok, true, "claiming twice is harmless");
  let p = (await getPass(db, u, DAY1))!;
  assert.equal(p.tier, 8);
  assert.deepEqual(p.tiers.filter((t) => t.claimed).map((t) => t.tier), [1, 2, 3, 4, 5, 6, 7, 8]);

  assert.equal((await equipCosmetic(db, u, "title", "t-alpha-raider")).ok, true);
  assert.equal((await equipCosmetic(db, u, "frame", "f-founder")).ok, true);
  assert.equal((await equipCosmetic(db, u, "skin", "s-alpha-veteran")).ok, true);
  assert.deepEqual(await equipCosmetic(db, u, "color", "c-alpha-dawn"), { ok: false, code: "locked" }, "tier 9 not claimed");
  const other = await makeUser(db);
  assert.deepEqual(await equipCosmetic(db, other, "title", "t-alpha-raider"), { ok: false, code: "locked" });

  // The alpha wipe: items, stash, loadouts, CR and the market go; pass tables and cosmetics stay.
  await db.execute(sql`truncate table items, item_events, stash_stacks, loadouts, loadout_drafts, credit_ledger, listings, trades cascade`);
  await db.execute(sql`update users set credits = 1000`);
  p = (await getPass(db, u, DAY1))!;
  assert.equal(p.ap, 600);
  assert.equal(p.tier, 8);
  assert.equal(p.skin, "s-alpha-veteran");
  const q = (await getQuests(db, u, DAY1))!;
  assert.deepEqual(q.equipped, { title: "t-alpha-raider", color: null, frame: "f-founder", skin: "s-alpha-veteran" });
  assert.ok(q.granted.includes("f-founder"));
});

test("bug reports: limits, admin review, an accepted report completes the task once", async () => {
  const u = await makeUser(db);
  const admin = { id: await makeUser(db, "admin1"), nickname: "admin1" };
  assert.deepEqual(await submitBugReport(db, u, "short", null, DAY1), { ok: false, code: "bug_short" });
  const r1 = await submitBugReport(db, u, "The extract arrow points at a closed gate.", "menu", DAY1);
  assert.equal(r1.ok, true);
  for (let i = 0; i < PASS.BUG_OPEN_MAX - 1; i++) await submitBugReport(db, u, `Another bug number ${i} here.`, null, DAY1);
  assert.deepEqual(await submitBugReport(db, u, "One more than allowed today.", null, DAY1), { ok: false, code: "bug_limit" });
  let p = (await getPass(db, u, DAY1))!;
  assert.equal(p.tester.find((t) => t.id === "bug")!.pending, true);
  const open = await listBugReports(db);
  assert.equal(open.length, PASS.BUG_OPEN_MAX);
  const id = r1.ok ? r1.id : 0;
  assert.deepEqual(await reviewBugReport(db, admin, id, true, DAY1), { ok: true, apGranted: true });
  assert.deepEqual(await reviewBugReport(db, admin, id, false, DAY1), { ok: false, code: "reviewed" });
  const second = open.find((b) => b.id !== id)!;
  assert.deepEqual(await reviewBugReport(db, admin, second.id, true, DAY1), { ok: true, apGranted: false }, "the task pays once");
  assert.deepEqual(await reviewBugReport(db, admin, 999_999, true, DAY1), { ok: false, code: "not_found" });
  p = (await getPass(db, u, DAY1))!;
  assert.equal(p.ap, 50);
  assert.equal(p.tester.find((t) => t.id === "bug")!.done, true);
  const audit = await db.execute<{ n: number }>(sql`select count(*)::int as n from admin_audit where action = 'bug_review'`);
  assert.equal(Number(audit.rows[0]!.n), 2);
});

test("the survey: every question answered, once", async () => {
  const u = await makeUser(db);
  assert.deepEqual(await submitSurvey(db, u, { device: "Phone" }, DAY1), { ok: false, code: "survey_bad" });
  assert.deepEqual(await submitSurvey(db, u, { device: "Phone", fun: "5", fix: "Loot", note: "more bosses" }, DAY1), { ok: true });
  assert.deepEqual(await submitSurvey(db, u, { device: "Phone", fun: "5", fix: "Loot" }, DAY1), { ok: false, code: "survey_done" });
  assert.equal(await passAp(db, u), 30);
});

test("invite reward: a friend you invited who dropped with you in a party settles 3 raids → Recruiter", async () => {
  const inviter = await makeUser(db);
  const friend = await makeUser(db);
  const stranger = await makeUser(db);
  const [lo, hi] = [inviter, friend].sort();
  await db.execute(sql`insert into friendships (user_lo, user_hi, requested_by, status, accepted_at) values (${lo}, ${hi}, ${inviter}, 'accepted', now())`);
  const [lo2, hi2] = [stranger, friend].sort();
  // The friend invited the stranger: no reward for the stranger from the friend's raids.
  await db.execute(sql`insert into friendships (user_lo, user_hi, requested_by, status, accepted_at) values (${lo2}, ${hi2}, ${friend}, 'accepted', now())`);
  const owned = async (id: string) => (await db.execute(sql`select 1 from pass_unlocks where user_id = ${id} and reward_id = ${INVITE_REWARD}`)).rows.length > 0;

  await raid(friend, 9);
  await raid(friend, 9);
  await raid(friend, 9);
  assert.equal(await owned(inviter), false, "never dropped together yet");
  const party = await db.execute<{ id: string }>(sql`insert into parties (leader_id) values (${inviter}) returning id`);
  await db.execute(sql`
    insert into party_drops (drop_id, party_id, cycle, match_id, leader_id, members, expires_at)
    values (${randomUUID()}, ${party.rows[0]!.id}, 1, ${randomUUID()}, ${inviter}, ${JSON.stringify([inviter, friend, stranger])}::jsonb, now())`);
  await raid(friend, 9);
  assert.equal(await owned(inviter), true);
  assert.equal(await owned(stranger), false);
  assert.equal(await owned(friend), false);
  assert.equal((await equipCosmetic(db, inviter, "title", INVITE_REWARD)).ok, true);
});

test("alpha trophy: an admin grants the title to the top ranks of each all-time board (idempotent); Founder badge on boards", async () => {
  const admin = { id: await makeUser(db, "boss_admin"), nickname: "boss_admin" };
  const ids: string[] = [];
  for (let i = 0; i < 12; i++) {
    const id = await makeUser(db, `lvl${String(i).padStart(2, "0")}`);
    await db.execute(sql`update users set xp = ${(i + 1) * 100} where id = ${id}`);
    ids.push(id);
  }
  const r = await grantAlphaTrophies(db, admin, DAY1);
  assert.equal(r.granted.length, ALPHA_TROPHY.top);
  assert.ok(!r.granted.includes("lvl00") && !r.granted.includes("lvl01"));
  const again = await grantAlphaTrophies(db, admin, DAY1);
  assert.deepEqual(again.granted, [], "already granted");
  assert.equal((await equipCosmetic(db, ids[11]!, "title", ALPHA_TROPHY.reward)).ok, true);
  assert.deepEqual(await equipCosmetic(db, ids[0]!, "title", ALPHA_TROPHY.reward), { ok: false, code: "locked" });

  await db.execute(sql`insert into pass_unlocks (user_id, reward_id, source) values (${ids[3]}, ${FOUNDER_BADGE}, 'pass')`);
  const b = await cosmeticBadges(db, ["lvl03", "lvl04"]);
  assert.deepEqual(b, { lvl03: { badge: FOUNDER_BADGE } });
});
