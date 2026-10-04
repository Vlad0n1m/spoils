/**
 * DB service tests against the isolated `extract_test` database (see test-db.ts).
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/inventory/raids.test.ts
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  ARMOR,
  DOG_TAG,
  FREE_KIT,
  STARTER_KIT,
  BOSSES,
  NPC,
  POOL,
  dogTagCr,
  itemDef,
  mulberry32,
  ITEM_IDS,
  uniqueTierScore,
  WORLD,
  XP,
  xpForExit,
  levelForXp,
  xpToNext,
  type EntryRequest,
  type ShardOpenRequest,
  type MatchEndReport,
  type PlayerExitReport,
  type SettledItem,
} from "@extract/shared";
import {
  creditLedger,
  itemEvents,
  items,
  loadouts,
  matchResults,
  pvpKills,
  raidEntries,
  raidExits,
  raids,
  stashStacks,
  users,
} from "../../db/schema";
import { PARAM, getNumberParam, setParam } from "../economy/params";
import { TIER_SCORE_SQL } from "../economy/pool";
import { runEconomyDaily } from "../economy/daily";
import { addStack } from "./transition";
import { lockLoadout, unlockLoadout, saveDraft } from "./loadout";
import {
  applyEnd,
  applyExit,
  voidOrphans,
  voidStale,
  voidStaleForUser,
  RAID_USER_VOID_GRACE_MS,
  RAID_VOID_GRACE_MS,
} from "./raids";
import { enterRaid, openShard } from "./world";
import { buyStarterKit, kitsBoughtToday } from "./starter";
import { getStash } from "./stash";
import { seedEconomy } from "../economy/seed";
import { listings, moneyLedger } from "../../db/schema";
import { closeTestDb, lockTestDb, makeItem, makeUser, openTestDb, resetDb } from "./test-db";
import { LOADOUT_LOCK_TTL_MS } from "./db";

const { db, pool } = openTestDb();
before(() => lockTestDb(pool));
after(() => closeTestDb(pool));

function exitReport(matchId: string, userId: string, over: Partial<PlayerExitReport>): PlayerExitReport {
  return {
    matchId,
    userId,
    exit: "extract",
    atMs: 600_000,
    kills: 0,
    level: 1,
    extracted: [],
    lost: [],
    destroyed: [],
    stats: { shotsFired: 0, dmgDealt: 0, containersSearched: 0, corpsesSearched: 0, bossKills: 0 },
    ...over,
  };
}

function endReport(matchId: string, over: Partial<MatchEndReport> = {}): MatchEndReport {
  return {
    matchId,
    mapId: "steppe",
    matchSeed: 1234,
    startedAt: Date.now() - 1_800_000,
    endedAt: Date.now(),
    participants: [],
    leftOnMap: [],
    minted: [],
    ...over,
  };
}

async function item(id: string) {
  const r = await db.select().from(items).where(eq(items.id, id));
  return r[0]!;
}
async function credits(userId: string) {
  const r = await db.select({ c: users.credits }).from(users).where(eq(users.id, userId));
  return r[0]!.c;
}
async function stack(userId: string, def: string) {
  const r = await db.select().from(stashStacks).where(and(eq(stashStacks.userId, userId), eq(stashStacks.defId, def)));
  return r[0]?.qty ?? 0;
}
async function itemCount() {
  const r = await db.execute<{ n: number }>(sql`select count(*)::int as n from items`);
  return Number(r.rows[0]!.n);
}
async function poolCount() {
  const r = await db.execute<{ n: number }>(sql`select count(*)::int as n from items where state = 'lost_pool'`);
  return Number(r.rows[0]!.n);
}
/** Ledger invariant: credits = START + Σ ledger for every user. */
async function assertCreditsConserved() {
  const r = await db.execute<{ id: string; credits: string; s: string | null }>(sql`
    select u.id, u.credits, (select sum(delta) from credit_ledger l where l.user_id = u.id) as s from users u`);
  for (const row of r.rows) assert.equal(Number(row.credits), 1000 + Number(row.s ?? 0), `credits of ${row.id}`);
}

/** A registered user with a rifle (w1), armor_2, backpack_1 and 60 light ammo, locked. */
async function lockedPlayer() {
  const userId = await makeUser(db);
  const rifle = await makeItem(db, { def: "rifle", rarity: 1, ownerId: userId, lockRaids: 2 });
  const armor = await makeItem(db, { def: "armor_2", rarity: 1, dur: 50, ownerId: userId });
  const bp = await makeItem(db, { def: "backpack_1", rarity: 0, ownerId: userId });
  await db.transaction((tx) => addStack(tx, userId, "ammo_light", 100));
  const lock = await lockLoadout(db, userId, [
    { key: "w1", itemId: rifle, def: "rifle", qty: 1 },
    { key: "armor", itemId: armor, def: "armor_2", qty: 1 },
    { key: "bp", itemId: bp, def: "backpack_1", qty: 1 },
    { key: "p0", def: "ammo_light", qty: 60 },
  ]);
  assert.ok(lock.ok, JSON.stringify(lock));
  return { userId, rifle, armor, bp, loadoutId: lock.ok ? lock.loadoutId : "" };
}

beforeEach(() => resetDb(db));

/** Market balance in balance_cents (the tradable kit is paid from it). */
async function setBalance(userId: string, minor: bigint): Promise<void> {
  await db.update(users).set({ balanceCents: minor }).where(eq(users.id, userId));
}
async function balance(userId: string): Promise<bigint> {
  const [u] = await db.select({ b: users.balanceCents }).from(users).where(eq(users.id, userId));
  return u!.b;
}

describe("starter kit (always paid, design §19)", () => {
  const PRICE = BigInt(STARTER_KIT.PRICE_MINOR);
  const KIT_UNIQUES = STARTER_KIT.weapons.length + 1;

  test("a purchase charges the price to the house once and grants tradable locked gear, no CR", async () => {
    const u = await makeUser(db);
    await setBalance(u, PRICE * 3n);
    const r = await buyStarterKit(db, u, { lockRaids: 1, rng: mulberry32(7) });
    assert.ok(r.status === "bought" && r.paidMinor === PRICE.toString() && r.boughtToday === 1);
    const owned = await db.select().from(items).where(eq(items.ownerId, u));
    assert.equal(owned.length, KIT_UNIQUES);
    assert.equal(owned.filter((i) => i.defId === "pistol").length, STARTER_KIT.weapons.length);
    assert.ok(owned.every((i) => i.origin === "giveaway" && i.lockRaids === 1 && !i.bound && i.state === "in_stash"));
    assert.equal(await credits(u), 1000, "no CR for SOL");
    for (const st of STARTER_KIT.stacks) assert.equal(await stack(u, st.def), st.qty, st.def);
    assert.equal(await balance(u), PRICE * 2n);
    const money = await db.select().from(moneyLedger);
    assert.deepEqual(
      money.map((m) => [m.account === u ? "user" : m.account, m.reason, m.deltaMinor, m.refId === r.purchaseId]).sort(),
      [["house", "kit_sale", PRICE, true], ["user", "kit_buy", -PRICE, true]].sort(),
    );
    assert.equal((await buyStarterKit(db, randomUUID())).status, "no_user");
    await assertCreditsConserved();
  });

  test("repeatable up to DAILY_MAX a UTC day, even concurrently; the cap resets the next day", async () => {
    const u = await makeUser(db);
    await setBalance(u, PRICE * 10n);
    const now = new Date("2026-10-05T10:00:00Z");
    const results = await Promise.all(
      Array.from({ length: STARTER_KIT.DAILY_MAX + 2 }, () => buyStarterKit(db, u, { lockRaids: 1, now })),
    );
    assert.equal(results.filter((r) => r.status === "bought").length, STARTER_KIT.DAILY_MAX);
    assert.equal(results.filter((r) => r.status === "daily_limit").length, 2);
    assert.equal(await kitsBoughtToday(db, u, now), STARTER_KIT.DAILY_MAX);
    assert.equal(await balance(u), PRICE * BigInt(10 - STARTER_KIT.DAILY_MAX), "charged once per kit");
    assert.equal((await db.select().from(items).where(eq(items.ownerId, u))).length, KIT_UNIQUES * STARTER_KIT.DAILY_MAX);
    const tomorrow = new Date("2026-10-06T00:00:01Z");
    assert.equal(await kitsBoughtToday(db, u, tomorrow), 0);
    assert.equal((await buyStarterKit(db, u, { lockRaids: 1, now: tomorrow })).status, "bought");
  });

  test("stop-crane kit_sale_paused (admin) and short money: nothing charged, nothing granted", async () => {
    const u = await makeUser(db);
    await setBalance(u, PRICE * 2n);
    await setParam(db, PARAM.KIT_SALE_PAUSED, 1);
    assert.equal((await buyStarterKit(db, u, { lockRaids: 1 })).status, "sale_paused");
    assert.equal(await balance(u), PRICE * 2n);
    assert.equal((await db.select().from(items).where(eq(items.ownerId, u))).length, 0);
    await setParam(db, PARAM.KIT_SALE_PAUSED, 0);
    assert.equal((await buyStarterKit(db, u, { lockRaids: 1 })).status, "bought");

    const poor = await makeUser(db);
    await setBalance(poor, PRICE - 1n);
    const r = await buyStarterKit(db, poor, { lockRaids: 1 });
    assert.ok(r.status === "insufficient_funds" && r.priceMinor === PRICE.toString());
    assert.equal((await db.select().from(items).where(eq(items.ownerId, poor))).length, 0);
    assert.equal(await balance(poor), PRICE - 1n);
    assert.equal((await db.select().from(moneyLedger).where(eq(moneyLedger.account, poor))).length, 0);
  });

  test("an old free bound kit stays as it is and does not block buying", async () => {
    const u = await makeUser(db);
    await setBalance(u, PRICE);
    // Pre-04.10 state: the free kit claimed (stamp set, bound giveaway items, no money moved).
    await db.update(users).set({ starterClaimedAt: new Date("2026-10-03T00:00:00Z") }).where(eq(users.id, u));
    const old = await makeItem(db, { ownerId: u, def: "rifle", bound: true });
    assert.equal((await buyStarterKit(db, u, { lockRaids: 1 })).status, "bought");
    const kept = await item(old);
    assert.ok(kept.bound && kept.state === "in_stash" && kept.ownerId === u);
    const [row] = await db.select({ at: users.starterClaimedAt }).from(users).where(eq(users.id, u));
    assert.equal(row!.at!.toISOString(), "2026-10-03T00:00:00.000Z", "first-kit stamp kept");
  });

  test("stash shows the kit and the first-kit stamp", async () => {
    const u = await makeUser(db);
    await setBalance(u, PRICE);
    await buyStarterKit(db, u, { rng: mulberry32(7) });
    const s = await getStash(db, u);
    assert.ok(s);
    assert.equal(s.uniques.length, KIT_UNIQUES);
    assert.equal(s.starterClaimed, true);
    assert.equal(s.credits, 1000);
    assert.equal(s.active, null);
  });
});

describe("loadout lock", () => {
  test("lock moves gear out of the stash; relock reuses; unlock refunds", async () => {
    const p = await lockedPlayer();
    assert.equal((await item(p.rifle)).state, "in_raid");
    assert.equal((await item(p.rifle)).loadoutId, p.loadoutId);
    assert.equal(await stack(p.userId, "ammo_light"), 40);
    const again = await lockLoadout(db, p.userId, []);
    assert.deepEqual(again.ok && [again.loadoutId, again.reused], [p.loadoutId, true]);
    assert.deepEqual(await unlockLoadout(db, p.userId), { ok: true, unlocked: true });
    assert.equal((await item(p.rifle)).state, "in_stash");
    assert.equal((await item(p.rifle)).loadoutId, null);
    assert.equal(await stack(p.userId, "ammo_light"), 100);
  });

  test("validation: someone else's item, too much ammo, junk", async () => {
    const a = await makeUser(db);
    const b = await makeUser(db);
    const rifleB = await makeItem(db, { def: "rifle", ownerId: b });
    const r1 = await lockLoadout(db, a, [{ key: "w1", itemId: rifleB, def: "rifle", qty: 1 }]);
    assert.deepEqual(r1, { ok: false, code: "item_unavailable", key: "w1" });
    const r2 = await lockLoadout(db, a, [{ key: "p0", def: "ammo_light", qty: 30 }]);
    assert.deepEqual(r2, { ok: false, code: "not_enough", key: "ammo_light" });
    const r3 = await lockLoadout(db, a, [{ key: "p0", def: "junk_gpu", qty: 1 }]);
    assert.equal(r3.ok, false);
    const empty = await lockLoadout(db, a, []);
    assert.deepEqual(empty, { ok: true, loadoutId: "", entries: [], reused: false });
  });

  test("concurrent locks from two tabs: one loadout", async () => {
    const u = await makeUser(db);
    const r = await makeItem(db, { def: "rifle", ownerId: u });
    const s = await makeItem(db, { def: "shotgun", ownerId: u });
    const res = await Promise.all([
      lockLoadout(db, u, [{ key: "w1", itemId: r, def: "rifle", qty: 1 }]),
      lockLoadout(db, u, [{ key: "w1", itemId: s, def: "shotgun", qty: 1 }]),
    ]);
    const active = await db.select().from(loadouts).where(eq(loadouts.userId, u));
    assert.equal(active.length, 1);
    assert.ok(res.every((x) => x.ok && x.loadoutId === active[0]!.id));
  });

  test("stale lock expires lazily", async () => {
    const p = await lockedPlayer();
    const later = new Date(Date.now() + LOADOUT_LOCK_TTL_MS + 1000);
    const s = await getStash(db, p.userId, later);
    assert.equal(s!.active, null);
    assert.equal((await item(p.rifle)).state, "in_stash");
    assert.equal(await stack(p.userId, "ammo_light"), 100);
  });

  test("drafts round-trip through the stash", async () => {
    const u = await makeUser(db);
    await saveDraft(db, u, [{ key: "p0", def: "bandage", qty: 1 }]);
    assert.deepEqual((await getStash(db, u))!.draft, [{ key: "p0", def: "bandage", qty: 1 }]);
  });
});

// ============================================================================ world helpers

const W_CYCLE = 640_100;

function wShard(over: Partial<ShardOpenRequest> = {}): ShardOpenRequest {
  const startsAt = W_CYCLE * WORLD.CYCLE_MS;
  return {
    matchId: randomUUID(),
    cycleId: W_CYCLE,
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
    ...over,
  };
}

/** A shard whose cycle runs on the wall clock from `t0` (the void tests compare ends_at with now). */
function wShardAt(t0: Date, over: Partial<ShardOpenRequest> = {}): ShardOpenRequest {
  const startsAt = t0.getTime();
  return wShard({ startsAt, entryClosesAt: startsAt + WORLD.CYCLE_MS - WORLD.ENTRY_CLOSE_MS, endsAt: startsAt + WORLD.CYCLE_MS, ...over });
}

function wEntry(matchId: string, userId: string, loadoutId = "", over: Partial<EntryRequest> = {}): EntryRequest {
  return { matchId, entryId: randomUUID(), userId, loadoutId, atMs: 60_000, targets: 30, bossAlive: true, ...over };
}

/** Exit report of a world entry `onMapMin` minutes after its admission. */
function wExit(e: EntryRequest, onMapMin: number, over: Partial<PlayerExitReport> = {}): PlayerExitReport {
  return exitReport(e.matchId, e.userId, { entryId: e.entryId, enteredAtMs: e.atMs, atMs: e.atMs + onMapMin * 60_000, ...over });
}

async function enterOk(e: EntryRequest) {
  const r = await enterRaid(db, e);
  assert.equal(r.status, "accepted", r.reason);
  return r;
}

/** Opens a live shard (default wShard()) and admits `userId` with `loadoutId` ("" = free kit). */
async function enterNew(userId: string, loadoutId = "", over: Partial<EntryRequest> = {}, shard = wShard()) {
  await openShard(db, shard);
  const e = wEntry(shard.matchId, userId, loadoutId, over);
  return { shard, e, res: await enterOk(e) };
}

/** The rifle / armor / backpack of a lockedPlayer as an exit report lists them. */
function ownGear(p: { rifle: string; armor: string; bp: string }, armorDur = ARMOR[2].durability * 0.5): SettledItem[] {
  return [
    { uid: p.rifle, def: "rifle", qty: 1, rarity: 1, dur: 100 },
    { uid: p.armor, def: "armor_2", qty: 1, rarity: 1, dur: armorDur },
    { uid: p.bp, def: "backpack_1", qty: 1, rarity: 0, dur: 100 },
  ];
}

/** xpForExit of an exit with only the given fields set (no grind earlier today, first extract). */
function xpOf(over: Partial<Parameters<typeof xpForExit>[0]>) {
  return xpForExit({
    exit: "extract",
    onMapMs: 0,
    haulCr: 0,
    containers: 0,
    marauders: 0,
    guards: 0,
    bosses: 0,
    rankedPvp: 0,
    grindToday: 0,
    firstExtractToday: true,
    ...over,
  });
}

/** XP needed for level 5 (the ranked-victim minimum, XP.PVP_VICTIM_MIN_LEVEL). */
const XP_L5 = Array.from({ length: XP.PVP_VICTIM_MIN_LEVEL - 1 }, (_, i) => xpToNext(i + 1)).reduce((a, b) => a + b, 0);

/** A registered user that counts as a ranked PvP victim: account older than 72 h, `xp` (default level 5). */
async function rankableUser(xp = XP_L5): Promise<string> {
  const id = await makeUser(db);
  await db
    .update(users)
    .set({ xp, createdAt: new Date(Date.now() - XP.PVP_VICTIM_MIN_AGE_MS - 3_600_000) })
    .where(eq(users.id, id));
  return id;
}

/** `n` lost-pool items in one insert: rifles of rarity 1 / 3 (rare / top) and armor_1 (score 0). */
async function bulkPool(n: number) {
  await db.insert(items).values(
    Array.from({ length: n }, (_, i) => ({ defId: i % 2 ? "rifle" : "armor_1", rarity: i % 4, durability: 80, state: "lost_pool" as const, origin: "seed" as const })),
  );
}

async function events(itemId: string) {
  return db.select().from(itemEvents).where(eq(itemEvents.itemId, itemId));
}

async function taxAcc() {
  return getNumberParam(db, PARAM.TAX_ACC);
}

describe("raid entry snapshot", () => {
  test("DB durability % becomes armor points; bound gear and gear under RISK_MIN_DUR_PCT ride along but add no risk", async () => {
    const p = await lockedPlayer();
    const { e, res } = await enterNew(p.userId, p.loadoutId);
    // DB 50 % → absorb points of armor level 2.
    assert.equal(res.snapshot!.entries.find((x) => x.key === "armor")!.dur, ARMOR[2].durability * 0.5);
    assert.equal(res.snapshot!.entries.find((x) => x.key === "p0")!.qty, 60);
    assert.equal((await item(p.rifle)).matchId, e.matchId);

    const userId = await makeUser(db);
    const rifle = await makeItem(db, { def: "rifle", ownerId: userId, bound: true });
    const armor = await makeItem(db, { def: "armor_1", dur: POOL.RISK_MIN_DUR_PCT - 1, ownerId: userId });
    const bp = await makeItem(db, { def: "backpack_1", dur: POOL.RISK_MIN_DUR_PCT, ownerId: userId });
    const lock = await lockLoadout(db, userId, [
      { key: "w1", itemId: rifle, def: "rifle", qty: 1 },
      { key: "armor", itemId: armor, def: "armor_1", qty: 1 },
      { key: "bp", itemId: bp, def: "backpack_1", qty: 1 },
    ]);
    assert.ok(lock.ok, JSON.stringify(lock));
    const e2 = wEntry(e.matchId, userId, lock.ok ? lock.loadoutId : "");
    const r2 = await enterOk(e2);
    assert.equal(r2.snapshot!.entries.filter((x) => x.uid).length, 3, "all three ride along");
    const row = (await db.select().from(raidEntries).where(eq(raidEntries.entryId, e2.entryId)))[0]!;
    assert.equal(row.riskUnits, 1, "only the backpack at the durability floor counts");
    assert.equal(row.freeKit, false);
  });

  test("an expired loadout lock is rejected and its gear goes back to the stash", async () => {
    const p = await lockedPlayer();
    const s = wShard();
    await openShard(db, s);
    const r = await enterRaid(db, wEntry(s.matchId, p.userId, p.loadoutId), new Date(Date.now() + LOADOUT_LOCK_TTL_MS + 1000));
    assert.deepEqual([r.status, r.reason], ["rejected", "expired"]);
    assert.equal((await item(p.rifle)).state, "in_stash");
    assert.equal(await stack(p.userId, "ammo_light"), 100);
  });
});

describe("raid exit", () => {
  test("extract: gear to stash, junk sold once, ammo back, XP; replay is a no-op", async () => {
    const p = await lockedPlayer();
    const { e } = await enterNew(p.userId, p.loadoutId);
    await setParam(db, PARAM.AUTOSELL_MULT, 1.1);
    const rep = wExit(e, 10, {
      kills: 2,
      extracted: [
        { uid: p.rifle, def: "rifle", qty: 1, rarity: 1, dur: 100 },
        { uid: p.armor, def: "armor_2", qty: 1, rarity: 1, dur: ARMOR[2].durability * 0.25 },
        { uid: p.bp, def: "backpack_1", qty: 1, rarity: 0, dur: 100 },
        { uid: "", def: "ammo_light", qty: 25, rarity: 0, dur: 0 },
        { uid: "", def: "junk_gpu", qty: 1, rarity: 3, dur: 0 },
        { uid: "", def: "junk_apple", qty: 3, rarity: 0, dur: 0 },
      ],
    });
    const r = await applyExit(db, rep);
    assert.equal(r.status, "applied");
    const expected = Math.floor(1500 * 1.1) + Math.floor(20 * 3 * 1.1);
    assert.equal(r.credits, expected);
    const want = xpOf({ onMapMs: 10 * 60_000, haulCr: expected });
    assert.equal(r.xp, want.total);
    assert.deepEqual(r.xpLines, want.lines);
    assert.equal(await credits(p.userId), 1000 + expected);
    assert.equal(await stack(p.userId, "ammo_light"), 40 + 25);
    const rifle = await item(p.rifle);
    assert.deepEqual([rifle.state, rifle.ownerId, rifle.matchId, rifle.lockRaids], ["in_stash", p.userId, null, 1]);
    assert.equal((await item(p.armor)).durability, 25);

    const dup = await applyExit(db, rep);
    assert.equal(dup.status, "duplicate");
    assert.equal(dup.credits, expected);
    assert.equal(dup.xp, want.total);
    assert.equal(await credits(p.userId), 1000 + expected);
    assert.equal(await stack(p.userId, "ammo_light"), 65);
    const u = (await db.select().from(users).where(eq(users.id, p.userId)))[0]!;
    assert.equal(u.matchesPlayed, 1);
    const lo = (await db.select().from(loadouts).where(eq(loadouts.id, p.loadoutId)))[0]!;
    assert.equal(lo.status, "settled");
    await assertCreditsConserved();
  });

  test("death: broken gear enters the pool at −8 with no owner; corpse gear stays in_raid", async () => {
    const p = await lockedPlayer();
    const { e } = await enterNew(p.userId, p.loadoutId);
    const r = await applyExit(db, wExit(e, 5, { exit: "dead", lost: [{ uid: p.rifle, def: "rifle", qty: 1, rarity: 1, dur: 100 }] }));
    assert.equal(r.status, "applied");
    const rifle = await item(p.rifle);
    assert.deepEqual([rifle.state, rifle.ownerId, rifle.durability], ["lost_pool", null, 100 - POOL.BREAK_DUR_LOSS]);
    assert.equal((await events(p.rifle)).find((x) => x.toState === "lost_pool")!.reason, "break");
    assert.equal((await item(p.armor)).state, "in_raid");
  });

  test("another player extracts the dead player's armor: owner changes; guest pickup goes to the pool", async () => {
    const victim = await lockedPlayer();
    const killer = await makeUser(db);
    const guest = randomUUID();
    const { shard, e: ev } = await enterNew(victim.userId, victim.loadoutId);
    const ek = wEntry(shard.matchId, killer);
    await enterOk(ek);
    const eg = wEntry(shard.matchId, guest);
    assert.equal((await enterOk(eg)).guest, true);
    await applyExit(db, wExit(ev, 4, { exit: "dead" }));
    const tag: SettledItem = { uid: "", def: "junk_dogtag", qty: 1, rarity: 1, dur: 0, label: "victim", lvl: 4, victim: victim.userId, by: killer };
    const k = await applyExit(db, wExit(ek, 9, { extracted: [{ uid: victim.armor, def: "armor_2", qty: 1, rarity: 1, dur: 10 }, tag] }));
    assert.equal(k.credits, dogTagCr(4), "the killer's own tag: full price, even from a free kit");
    const armor = await item(victim.armor);
    assert.deepEqual([armor.state, armor.ownerId], ["in_stash", killer]);
    const g = await applyExit(
      db,
      wExit(eg, 9, {
        extracted: [
          { uid: victim.rifle, def: "rifle", qty: 1, rarity: 1, dur: 100 },
          { uid: "", def: "junk_gpu", qty: 1, rarity: 3, dur: 0 },
        ],
      }),
    );
    assert.equal(g.guest, true);
    assert.equal(g.credits, 0);
    assert.equal(g.xp, 0);
    assert.equal(g.sold[0]?.cr, 1500 * FREE_KIT.AUTOSELL_MULT, "guest receipt shows what it would have sold for (a free-kit entry)");
    const rifle = await item(victim.rifle);
    assert.deepEqual([rifle.state, rifle.ownerId, rifle.durability], ["lost_pool", null, 100]);
  });

  test("free kit (v5 review): a live entry with no unique sells its junk at FREE_KIT.AUTOSELL_MULT; dog tags keep their price", async () => {
    const u = await makeUser(db);
    const { shard, e } = await enterNew(u);
    const victim = randomUUID();
    const r = await applyExit(
      db,
      wExit(e, 9, {
        extracted: [
          { uid: "", def: "junk_gpu", qty: 1, rarity: 3, dur: 0 },
          { uid: "", def: "junk_dogtag", qty: 1, rarity: 1, dur: 0, label: "v", lvl: 2, victim, by: u },
        ],
      }),
    );
    assert.equal(r.credits, Math.floor(1500 * FREE_KIT.AUTOSELL_MULT) + dogTagCr(2));
    // A geared player on the same map sells at × 1.
    const p = await lockedPlayer();
    const e2 = wEntry(shard.matchId, p.userId, p.loadoutId);
    await enterOk(e2);
    const r2 = await applyExit(db, wExit(e2, 9, { extracted: [{ uid: "", def: "junk_gpu", qty: 1, rarity: 3, dur: 0 }] }));
    assert.equal(r2.credits, 1500);
  });

  test("dog tags: same pair pays REPEAT_FREE times per 24 h", async () => {
    const killer = await makeUser(db);
    const victim = randomUUID();
    const tag = (): SettledItem => ({ uid: "", def: "junk_dogtag", qty: 1, rarity: 1, dur: 0, label: "v", lvl: 0, victim, by: killer });
    let total = 0;
    for (let i = 0; i < DOG_TAG.REPEAT_FREE + 2; i++) {
      // One map per tag (the entry cap is per cycle).
      const { e } = await enterNew(killer, "", {}, wShard({ cycleId: W_CYCLE + i }));
      const r = await applyExit(db, wExit(e, 9, { extracted: [tag()] }));
      total += r.credits;
    }
    assert.equal(total, DOG_TAG.REPEAT_FREE * dogTagCr(0));
  });

  test("unknown uids are skipped, never created", async () => {
    const u = await makeUser(db);
    const { e } = await enterNew(u);
    const ghost = randomUUID();
    const r = await applyExit(db, wExit(e, 9, { extracted: [{ uid: ghost, def: "sniper", qty: 1, rarity: 3, dur: 100 }] }));
    assert.deepEqual(r.skipped, [ghost]);
    assert.equal(await itemCount(), 0);
  });
});

describe("raid end and conservation", () => {
  test("full map: every item ends in exactly one place, totals conserved, end is idempotent", async () => {
    await bulkPool(30);
    const a = await lockedPlayer();
    const b = await lockedPlayer();
    const before = await itemCount();
    const s = wShard();
    await openShard(db, s);
    const ea = wEntry(s.matchId, a.userId, a.loadoutId);
    const eb = wEntry(s.matchId, b.userId, b.loadoutId, { atMs: 120_000 });
    const released = [...(await enterOk(ea)).pool, ...(await enterOk(eb)).pool];
    assert.ok(released.length > 0);
    // a extracts with rifle + one pool item; b dies (rifle breaks), armor + bp left in the corpse.
    await applyExit(
      db,
      wExit(ea, 12, {
        extracted: [
          { uid: a.rifle, def: "rifle", qty: 1, rarity: 1, dur: 100 },
          { uid: released[0]!.uid, def: released[0]!.def, qty: 1, rarity: released[0]!.rarity, dur: released[0]!.dur },
        ],
      }),
    );
    await applyExit(db, wExit(eb, 6, { exit: "dead", lost: [{ uid: b.rifle, def: "rifle", qty: 1, rarity: 1, dur: 100 }] }));
    const end = endReport(s.matchId, {
      cycleId: W_CYCLE,
      shard: 0,
      entries: [ea.entryId, eb.entryId],
      participants: [
        { userId: a.userId, nickname: "a", isBot: false, exitType: "extract", kills: 0 },
        { userId: b.userId, nickname: "b", isBot: false, exitType: "dead", kills: 0 },
        { userId: null, nickname: "bot", isBot: true, exitType: "timeout", kills: 1 },
      ],
      // b's corpse + the remaining released items; a's armor/backpack deliberately missing → sweep.
      leftOnMap: [
        { uid: b.armor, def: "armor_2", qty: 1, rarity: 1, dur: 10 },
        { uid: b.bp, def: "backpack_1", qty: 1, rarity: 0, dur: 100 },
        ...released.slice(1),
      ],
    });
    const e = await applyEnd(db, end);
    assert.equal(e.status, "applied");
    assert.equal(e.swept, 2, "a's armor and backpack were never reported");
    assert.deepEqual(e.voidedEntries, []);
    assert.equal((await applyEnd(db, end)).status, "duplicate");

    assert.equal(await itemCount(), before, "no item created or deleted");
    const inRaid = await db.execute<{ n: number }>(sql`select count(*)::int as n from items where state = 'in_raid'`);
    assert.equal(Number(inRaid.rows[0]!.n), 0);
    assert.equal((await item(a.rifle)).state, "in_stash");
    assert.equal((await item(released[0]!.uid)).ownerId, a.userId);
    assert.equal((await item(b.armor)).ownerId, null);
    // Each item's journal replays to its current state.
    const evs = await db.select().from(itemEvents);
    for (const id of [a.rifle, b.rifle, b.armor, released[0]!.uid]) {
      const last = evs.filter((x) => x.itemId === id).sort((x, y) => x.id - y.id).at(-1)!;
      const now = await item(id);
      assert.equal(last.toState, now.state, `journal of ${id}`);
    }
    const mr = await db.select().from(matchResults).where(eq(matchResults.matchId, s.matchId));
    assert.equal(mr[0]!.payload.participants[0]!.extracted?.length, 2);
    assert.deepEqual(
      mr[0]!.payload.participants.map((p) => p.nickname),
      ["a", "b"],
      "v5: a bot entry of a pre-v5 report never reaches match_results",
    );
    const raid = (await db.select().from(raids).where(eq(raids.matchId, s.matchId)))[0]!;
    assert.equal(raid.status, "settled");
    await assertCreditsConserved();
  });

  test("treasury tax takes whole items once the accumulator covers them", async () => {
    await setParam(db, PARAM.TAX_ACC, 10_000);
    const p = await lockedPlayer();
    const { e } = await enterNew(p.userId, p.loadoutId);
    await applyExit(db, wExit(e, 44, { exit: "mia", lost: ownGear(p) }));
    const states = await Promise.all([p.rifle, p.armor, p.bp].map(async (id) => (await item(id)).state));
    assert.ok(states.includes("treasury"));
    const ev = await db.select().from(itemEvents).where(eq(itemEvents.reason, "tax"));
    assert.ok(ev.length >= 1);
  });

  test("boss bag items: unlooted return to the pool with no wear; the human who kills the boss keeps what he extracts", async () => {
    await bulkPool(POOL.BOSS_MIN_POOL + 60);
    const p = await lockedPlayer();
    const { shard, e, res } = await enterNew(p.userId, p.loadoutId, {}, wShard({ boss: { kind: "commander", zone: "radar" } }));
    assert.equal(res.bossFill.length, BOSSES.commander.poolSlots.length, "3 risk units reach the 3 slots");
    const [loot, ...rest] = res.bossFill;
    const ex = await applyExit(
      db,
      wExit(e, 10, {
        extracted: [...ownGear(p), loot!],
        stats: { shotsFired: 40, dmgDealt: 600, containersSearched: 0, corpsesSearched: 1, bossKills: 1 },
      }),
    );
    assert.equal(ex.xp, xpOf({ onMapMs: 10 * 60_000, bosses: 1 }).total);
    const end = await applyEnd(db, endReport(shard.matchId, { cycleId: W_CYCLE, entries: [e.entryId], leftOnMap: [...rest, ...res.pool] }));
    assert.equal(end.swept, 0);
    assert.equal((await item(loot!.uid)).ownerId, p.userId);
    for (const it of rest) {
      const row = await item(it.uid);
      assert.deepEqual([row.state, row.durability], ["lost_pool", 80], `${it.def} back unworn`);
    }
    assert.equal(await taxAcc(), 0, "allocations re-enter untaxed");
  });
});

describe("void", () => {
  test("a map that never ended returns loadouts to their owners and refuses late reports", async () => {
    const x = await makeItem(db, { def: "rifle", rarity: 1, state: "lost_pool", dur: 90 });
    const p = await lockedPlayer();
    const t0 = new Date();
    const s = wShardAt(t0);
    await openShard(db, s, t0);
    const e = wEntry(s.matchId, p.userId, p.loadoutId);
    assert.deepEqual((await enterOk(e)).pool.map((i) => i.uid), [x]);

    const wipe = s.endsAt;
    assert.deepEqual(await voidStale(db, new Date(wipe + 60_000)), [], "too early");
    const later = new Date(wipe + RAID_VOID_GRACE_MS + 1000);
    assert.deepEqual(await voidStale(db, later), [s.matchId]);
    assert.deepEqual(await voidStale(db, later), [], "void is idempotent");

    const rifle = await item(p.rifle);
    assert.deepEqual([rifle.state, rifle.ownerId, rifle.matchId, rifle.loadoutId], ["in_stash", p.userId, null, null]);
    assert.equal((await item(x)).state, "lost_pool");
    assert.equal(await stack(p.userId, "ammo_light"), 100, "loadout ammo refunded");
    assert.equal((await db.select().from(loadouts).where(eq(loadouts.id, p.loadoutId)))[0]!.status, "voided");
    assert.equal((await db.select().from(raidEntries).where(eq(raidEntries.entryId, e.entryId)))[0]!.status, "voided");

    const late = await applyExit(db, wExit(e, 10, { extracted: [{ uid: p.rifle, def: "rifle", qty: 1, rarity: 1, dur: 100 }] }));
    assert.equal(late.status, "voided");
    assert.equal((await applyEnd(db, endReport(s.matchId, { cycleId: W_CYCLE, entries: [e.entryId] }))).status, "voided");
    // The user can lock again afterwards.
    const relock = await lockLoadout(db, p.userId, [{ key: "w1", itemId: p.rifle, def: "rifle", qty: 1 }]);
    assert.equal(relock.ok, true);
    const ledger = await db.select().from(creditLedger);
    assert.equal(ledger.length, 0);
  });
});

describe("pool tier score", () => {
  test("TIER_SCORE_SQL agrees with uniqueTierScore for every unique def and rarity", async () => {
    const defs = ITEM_IDS.filter((id) => itemDef(id)?.unique);
    for (const def of defs) for (let r = 0; r < 4; r++) await makeItem(db, { def, rarity: r, state: "lost_pool" });
    const rows = await db.execute<{ def_id: string; rarity: number; s: number }>(
      sql`select def_id, rarity, ${TIER_SCORE_SQL} as s from items`,
    );
    assert.equal(rows.rows.length, defs.length * 4);
    for (const row of rows.rows) assert.equal(Number(row.s), uniqueTierScore(row.def_id, Number(row.rarity)), `${row.def_id} r${row.rarity}`);
  });
});

describe("economy daily", () => {
  /** `n` veterans (account 30 days old, one raid exit yesterday) with `credits` CR each. */
  async function veterans(n: number, cr: number, now: Date, geared = true) {
    const matchId = randomUUID();
    const at = new Date(now.getTime() - 86_400_000);
    for (let i = 0; i < n; i++) {
      const u = await makeUser(db);
      await db.execute(sql`update users set credits = ${cr}, created_at = ${new Date(now.getTime() - 30 * 86_400_000)} where id = ${u}`);
      await db.execute(sql`insert into raid_exits (match_id, user_id, exit, report, at)
        values (${matchId}, ${u}, 'extract', '{}'::jsonb, ${at})`);
      const entries = geared ? [{ key: "w1" as const, uid: randomUUID(), def: "rifle", qty: 1, rarity: 0, dur: 90 }] : [{ key: "p0" as const, uid: "", def: "ammo_light", qty: 30, rarity: 0, dur: 0 }];
      await db.insert(loadouts).values({ userId: u, status: "settled", entries, matchId, startedAt: at });
    }
  }

  test("free-kit-only accounts (alt farms) never count as veterans: their hoards do not steer autosell", async () => {
    const now = new Date("2026-10-03T03:00:00Z");
    await veterans(60, 500, now);
    await veterans(300, 50_000, now, false);
    const r = await runEconomyDaily(db, now);
    assert.equal(r.veterans.sample, 60);
    assert.equal(r.autosell.to, 1.03, "the geared veterans are poor: junk pays more");
  });

  test("steers autosell once per UTC day from the veterans' median CR; small samples change nothing", async () => {
    const now = new Date("2026-10-03T03:00:00Z");
    await veterans(10, 500, now);
    await bulkPool(12);
    const small = await runEconomyDaily(db, now);
    assert.equal(small.status, "applied");
    assert.deepEqual(small.autosell, { from: 1, to: 1 }, "10 veterans < MIN_SAMPLE");
    assert.deepEqual(small.pool, { size: 12, top: 3, rare: 3 });

    await veterans(50, 500, now);
    const again = await runEconomyDaily(db, new Date("2026-10-03T23:00:00Z"));
    assert.equal(again.status, "already", "same UTC day");
    const next = await runEconomyDaily(db, new Date("2026-10-04T03:00:00Z"));
    assert.equal(next.status, "applied");
    assert.equal(next.veterans.sample, 60);
    assert.equal(next.autosell.to, 1.03, "poor veterans: junk pays 3 % more");
    assert.equal(await getNumberParam(db, PARAM.AUTOSELL_MULT), 1.03);
    const snap = await db.execute<{ n: number }>(sql`select count(*)::int as n from economy_daily`);
    assert.equal(Number(snap.rows[0]!.n), 2);
  });

  test("raids of the last 24 h = world entries + legacy matches; humans-only map size, solo share and NPC totals", async () => {
    const humans = async (n: number) => Promise.all(Array.from({ length: n }, () => makeUser(db)));
    const part = (ids: string[]) => ids.map((userId, i) => ({ userId, nickname: `h${i}`, isBot: false, exitType: "dead" as const, kills: 0 }));
    const sum = (m: number, k: number) => ({ spawned: { boss: 1, guard: 2, marauder: m }, killedByHumans: { boss: 0, guard: 1, marauder: k } });
    // Two legacy matches (no raids/open: rows created by the end report) with 1 and 3 humans + a pre-v5 bot.
    await applyEnd(db, endReport(randomUUID(), { participants: part(await humans(1)), npcSummary: sum(30, 3) }));
    await applyEnd(
      db,
      endReport(randomUUID(), {
        participants: [...part(await humans(3)), { userId: null, nickname: "bot", isBot: true, exitType: "timeout", kills: 2 }],
      }),
    );
    // Older than 24 h: not counted.
    await applyEnd(db, endReport(randomUUID(), { participants: part(await humans(1)), endedAt: Date.now() - 2 * 86_400_000 }));
    // A world map: one user enters twice, another once → 3 raids, 2 humans on the map.
    const [u1, u2] = await humans(2);
    const s = wShard();
    await openShard(db, s);
    const e1 = wEntry(s.matchId, u1!);
    await enterOk(e1);
    await applyExit(db, wExit(e1, 9));
    const e2 = wEntry(s.matchId, u1!, "", { atMs: 900_000 });
    await enterOk(e2);
    await applyExit(db, wExit(e2, 9, { exit: "dead" }));
    const e3 = wEntry(s.matchId, u2!);
    await enterOk(e3);
    await applyExit(db, wExit(e3, 9));
    await applyEnd(
      db,
      endReport(s.matchId, {
        cycleId: W_CYCLE,
        entries: [e1.entryId, e2.entryId, e3.entryId],
        participants: [...part([u1!, u1!, u2!])],
        npcSummary: sum(35, 5),
      }),
    );
    // A world map whose raids/open never reached the web: a world row, no raid of its own.
    await applyEnd(db, endReport(randomUUID(), { cycleId: W_CYCLE + 1, entries: [], participants: [] }));
    const lazy = await db.execute<{ kind: string; cycle_id: number }>(sql`select kind, cycle_id from raids where started = false and cycle_id is not null`);
    assert.deepEqual(lazy.rows.map((r) => [r.kind, Number(r.cycle_id)]), [["world", W_CYCLE + 1]]);

    const d = await runEconomyDaily(db, new Date(Date.now() + 1000));
    assert.equal(d.raids.count, 2 + 3, "two legacy matches + three world entries");
    assert.equal(d.raids.medianHumans, 1.5, "maps of 1, 3, 2 and 0 distinct humans");
    assert.equal(d.raids.soloShare, 0.25);
    assert.deepEqual(d.raids.npc, { spawned: { boss: 2, guard: 4, marauder: 65 }, killedByHumans: { boss: 0, guard: 2, marauder: 8 } });
  });
});

describe("NPC MODEL v5: humans + NPCs", () => {
  test("end report: humans-only scoreboard with npcSummary, no bot fields stored, settles without botLost", async () => {
    const p = await lockedPlayer();
    const { shard, e } = await enterNew(p.userId, p.loadoutId);
    await applyExit(db, wExit(e, 5, { exit: "dead", lost: [{ uid: p.rifle, def: "rifle", qty: 1, rarity: 1, dur: 100 }] }));
    const npcSummary = { spawned: { boss: 2, guard: 5, marauder: 30 }, killedByHumans: { boss: 0, guard: 1, marauder: 4 } };
    const end = await applyEnd(
      db,
      endReport(shard.matchId, {
        cycleId: W_CYCLE,
        entries: [e.entryId],
        participants: [
          { userId: p.userId, nickname: "p", isBot: false, exitType: "dead", kills: 0 },
          { userId: null, nickname: "Marauder", isBot: true, exitType: "timeout", kills: 1 },
        ],
        leftOnMap: [
          { uid: p.armor, def: "armor_2", qty: 1, rarity: 1, dur: 10 },
          { uid: p.bp, def: "backpack_1", qty: 1, rarity: 0, dur: 100 },
        ],
        npcSummary,
      }),
    );
    assert.deepEqual([end.status, end.swept], ["applied", 0]);
    const mr = (await db.select().from(matchResults).where(eq(matchResults.matchId, shard.matchId)))[0]!;
    assert.deepEqual(mr.payload.participants.map((x) => x.nickname), ["p"]);
    assert.deepEqual(mr.payload.npcSummary, npcSummary);
    assert.ok(!("botLost" in mr.payload) && !("botDestroyed" in mr.payload));
    const botEvents = await db.execute<{ n: number }>(sql`select count(*)::int as n from item_events where reason = 'bot_break'`);
    assert.equal(Number(botEvents.rows[0]!.n), 0);
  });

  test("npcKills XP is capped at NPC.MAX_PER_RAID; a report without npcKills pays no NPC XP", async () => {
    const a = await makeUser(db);
    const b = await makeUser(db);
    const { shard, e: ea } = await enterNew(a);
    const eb = wEntry(shard.matchId, b);
    await enterOk(eb);
    const big = await applyExit(
      db,
      wExit(ea, 10, { exit: "dead", stats: { shotsFired: 0, dmgDealt: 0, containersSearched: 0, corpsesSearched: 0, bossKills: 0, npcKills: 500 } }),
    );
    const want = xpOf({ exit: "dead", onMapMs: 10 * 60_000, marauders: NPC.MAX_PER_RAID });
    assert.equal(big.xp, want.total);
    assert.deepEqual(big.xpLines, want.lines);
    const old = await applyExit(db, wExit(eb, 10, { exit: "dead" }));
    assert.equal(old.xp, 0);
  });
});

describe("orphaned raids", () => {
  test("void-orphans voids maps of a previous instance of an explicit serverId, not the new one's", async () => {
    const a = await lockedPlayer();
    const b = await lockedPlayer();
    const c = await lockedPlayer();
    const t0 = new Date();
    const old = wShardAt(t0, { instanceId: "inst-1", serverId: "eu-1" });
    const shared = wShardAt(t0, { instanceId: "inst-1", serverId: "default", cycleId: W_CYCLE + 1 });
    const other = wShardAt(t0, { instanceId: "x-1", serverId: "eu-2", cycleId: W_CYCLE + 2 });
    const players = [a, b, c];
    const shards = [old, shared, other];
    for (let i = 0; i < 3; i++) {
      await openShard(db, shards[i]!, t0);
      await enterOk(wEntry(shards[i]!.matchId, players[i]!.userId, players[i]!.loadoutId));
    }
    const ea = (await db.select().from(raidEntries).where(eq(raidEntries.matchId, old.matchId)))[0]!;

    const boot = { serverId: "eu-1", instanceId: "inst-2", bootedAt: Date.now() };
    const res = await voidOrphans(db, boot, new Date(t0.getTime() + 5_000));
    assert.equal(res.status, "applied");
    assert.deepEqual(res.voided, [old.matchId]);
    assert.equal((await item(a.rifle)).state, "in_stash");
    assert.equal((await item(a.rifle)).ownerId, a.userId);
    assert.equal(await stack(a.userId, "ammo_light"), 100, "loadout ammo refunded");
    assert.equal((await item(b.rifle)).state, "in_raid", "a map of the shared 'default' serverId is left to the timeout");
    assert.equal((await item(c.rifle)).state, "in_raid", "another serverId is untouched");
    const late = exitReport(old.matchId, a.userId, { entryId: ea.entryId, enteredAtMs: ea.atMs });
    assert.equal((await applyExit(db, late)).status, "voided");

    // A map the new instance opens afterwards survives a retry of the same announcement.
    const d = await lockedPlayer();
    const fresh = wShardAt(t0, { instanceId: "inst-2", serverId: "eu-1", cycleId: W_CYCLE + 3 });
    await openShard(db, fresh, new Date(t0.getTime() + 10_000));
    await enterOk(wEntry(fresh.matchId, d.userId, d.loadoutId));
    assert.deepEqual((await voidOrphans(db, boot, new Date(t0.getTime() + 20_000))).voided, []);
    // A delayed retry of the OLDER boot changes nothing.
    const stale = await voidOrphans(db, { serverId: "eu-1", instanceId: "inst-1", bootedAt: boot.bootedAt - 60_000 });
    assert.deepEqual(stale, { status: "stale", voided: [] });
    assert.equal((await item(d.rifle)).state, "in_raid");
  });

  test("void-orphans never voids across instances of the shared 'default' serverId (live maps of another process)", async () => {
    // Server A (no GAME_SERVER_ID) is running a map; server B, also "default", boots.
    const a = await lockedPlayer();
    const t0 = new Date();
    const live = wShardAt(t0, { instanceId: "inst-A", serverId: "default" });
    await openShard(db, live, t0);
    const e = wEntry(live.matchId, a.userId, a.loadoutId);
    await enterOk(e);
    const res = await voidOrphans(db, { serverId: "default", instanceId: "inst-B", bootedAt: Date.now() }, new Date(t0.getTime() + 5_000));
    assert.deepEqual(res, { status: "applied", voided: [] });
    assert.equal((await item(a.rifle)).state, "in_raid");
    // ... and the lazy per-user void does not treat B's boot as A's death either.
    assert.deepEqual(await voidStaleForUser(db, a.userId, new Date(t0.getTime() + 6_000)), []);
    // A's player still extracts normally.
    assert.equal((await applyExit(db, wExit(e, 9))).status, "applied");
  });

  test("lobby load voids the user's map lazily, RAID_USER_VOID_GRACE_MS after the wipe", async () => {
    const p = await lockedPlayer();
    const t0 = new Date();
    const s = wShardAt(t0, { instanceId: "inst-1" });
    await openShard(db, s, t0);
    await enterOk(wEntry(s.matchId, p.userId, p.loadoutId));
    assert.deepEqual(await voidStaleForUser(db, p.userId, new Date(s.endsAt)), [], "still settling at the wipe");
    // getStash (lobby, /api/world/join) runs lazyMaintenance → voidStaleForUser.
    const st = await getStash(db, p.userId, new Date(s.endsAt + RAID_USER_VOID_GRACE_MS + 1000));
    assert.equal(RAID_USER_VOID_GRACE_MS < RAID_VOID_GRACE_MS, true, "sooner than the global timeout");
    assert.equal(st!.active, null, "gear is back");
    assert.equal(st!.uniques.find((u) => u.id === p.rifle)?.state, "in_stash");
    const relock = await lockLoadout(db, p.userId, [{ key: "w1", itemId: p.rifle, def: "rifle", qty: 1 }]);
    assert.equal(relock.ok, true);
  });
});

describe("seed", () => {
  test("seeds the pool and NPC listings once", async () => {
    const r = await seedEconomy(db, { poolItems: 700, listings: 20, rng: mulberry32(1) });
    assert.deepEqual(r, { status: "seeded", poolItems: 700, listings: 20 });
    assert.equal(await poolCount(), 700);
    const ls = await db.select().from(listings);
    assert.equal(ls.length, 20);
    assert.ok(ls.every((l) => l.sellerId === null && l.status === "active" && l.priceMinor > 0n));
    assert.equal((await seedEconomy(db, { rng: mulberry32(2) })).status, "already");
    assert.equal(await itemCount(), 720);
  });
});

// ============================================================================ WORLD v6 (T20, T21)

describe("WORLD v6 exit settlement (T20)", () => {
  test("a report without entryId (pre-v6 server) is unknown_entry and settles nothing", async () => {
    const s = wShard();
    await openShard(db, s);
    const u = await makeUser(db);
    const r = await applyExit(db, exitReport(s.matchId, u, { extracted: [{ uid: "", def: "junk_gpu", qty: 1, rarity: 3, dur: 0 }] }));
    assert.equal(r.status, "unknown_entry");
    assert.equal(await credits(u), 1000);
    assert.equal((await db.select().from(raidExits).where(eq(raidExits.userId, u))).length, 0);
  });

  test("two exits of one user in one match both settle and both credit CR; a replay is a duplicate", async () => {
    const s = wShard();
    await openShard(db, s);
    const u = await makeUser(db);
    const gpu = [{ uid: "", def: "junk_gpu", qty: 1, rarity: 3, dur: 0 }];
    const e1 = wEntry(s.matchId, u);
    await enterOk(e1);
    const r1 = await applyExit(db, wExit(e1, 10, { extracted: gpu }));
    const e2 = wEntry(s.matchId, u, "", { atMs: 900_000 });
    await enterOk(e2);
    const r2 = await applyExit(db, wExit(e2, 10, { extracted: gpu }));
    assert.deepEqual([r1.status, r2.status], ["applied", "applied"]);
    assert.ok(r1.credits > 0);
    assert.equal(r2.credits, r1.credits);
    assert.equal(await credits(u), 1000 + r1.credits + r2.credits);
    const refs = (await db.select().from(creditLedger).where(eq(creditLedger.userId, u))).map((l) => l.refId).sort();
    assert.deepEqual(refs, [`exit:${e1.entryId}`, `exit:${e2.entryId}`].sort());
    const rows = await db.select().from(raidExits).where(eq(raidExits.matchId, s.matchId));
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.cycleId === W_CYCLE));
    const ents = await db.select().from(raidEntries).where(eq(raidEntries.matchId, s.matchId));
    assert.ok(ents.every((e) => e.status === "exited" && e.settledAt));
    const dup = await applyExit(db, wExit(e1, 10, { extracted: gpu }));
    assert.equal(dup.status, "duplicate");
    assert.equal(await credits(u), 1000 + r1.credits + r2.credits);
    assert.equal((await db.select().from(users).where(eq(users.id, u)))[0]!.matchesPlayed, 2);
    // An entry of another user, or an unknown one, is refused (the server stops retrying).
    assert.equal((await applyExit(db, wExit(e1, 10, { userId: await makeUser(db) }))).status, "unknown_entry");
    assert.equal((await applyExit(db, wExit({ ...e1, entryId: randomUUID() }, 10))).status, "unknown_entry");
    await assertCreditsConserved();
  });

  test("mia: everything carried enters the pool with no wear (reason mia, ref entry); XP = kill lines only", async () => {
    const s = wShard();
    await openShard(db, s);
    const p = await lockedPlayer();
    const e = wEntry(s.matchId, p.userId, p.loadoutId);
    await enterOk(e);
    const r = await applyExit(
      db,
      wExit(e, 44, {
        exit: "mia",
        lost: [
          { uid: p.rifle, def: "rifle", qty: 1, rarity: 1, dur: 100 },
          { uid: p.armor, def: "armor_2", qty: 1, rarity: 1, dur: ARMOR[2].durability * 0.5 },
          { uid: p.bp, def: "backpack_1", qty: 1, rarity: 0, dur: 100 },
        ],
        stats: { shotsFired: 0, dmgDealt: 0, containersSearched: 6, corpsesSearched: 0, bossKills: 0, npcKills: 2 },
      }),
    );
    assert.equal(r.status, "applied");
    const rifle = await item(p.rifle), armor = await item(p.armor);
    assert.deepEqual([rifle.state, rifle.ownerId, rifle.durability], ["lost_pool", null, 100]);
    assert.deepEqual([armor.state, armor.durability], ["lost_pool", 50]);
    const ev = (await events(p.rifle)).find((x) => x.toState === "lost_pool")!;
    assert.deepEqual([ev.reason, ev.refId], ["mia", e.entryId]);
    assert.equal(r.xp, 2 * XP.NPC);
    assert.deepEqual(r.xpLines, [{ key: "npc", qty: 2, xp: 2 * XP.NPC }]);
    const lo = (await db.select().from(loadouts).where(eq(loadouts.id, p.loadoutId)))[0]!;
    assert.equal(lo.status, "settled");
  });

  test("unplaced pool items return untaxed; the giveaway lock burns only after MIN_EXPOSURE_MS on the map", async () => {
    await bulkPool(30);
    const s = wShard();
    await openShard(db, s);
    const p = await lockedPlayer();
    const e1 = wEntry(s.matchId, p.userId, p.loadoutId);
    const res = await enterOk(e1);
    assert.equal(res.pool.length, 3);
    const own = [
      { uid: p.rifle, def: "rifle", qty: 1, rarity: 1, dur: 100 },
      { uid: p.armor, def: "armor_2", qty: 1, rarity: 1, dur: ARMOR[2].durability * 0.5 },
      { uid: p.bp, def: "backpack_1", qty: 1, rarity: 0, dur: 100 },
    ];
    await applyExit(db, wExit(e1, 5, { extracted: own, unplaced: res.pool }));
    for (const it of res.pool) {
      const row = await item(it.uid);
      assert.deepEqual([row.state, row.matchId], ["lost_pool", null]);
      const ev = (await events(it.uid)).find((x) => x.reason === "return")!;
      assert.equal(ev.refId, e1.entryId);
    }
    assert.equal(await taxAcc(), 0, "untaxed");
    assert.equal((await item(p.rifle)).lockRaids, 2, "5 min on the map: the lock is not burned");

    const lock2 = await lockLoadout(db, p.userId, [{ key: "w1", itemId: p.rifle, def: "rifle", qty: 1 }]);
    assert.ok(lock2.ok);
    const e2 = wEntry(s.matchId, p.userId, lock2.ok ? lock2.loadoutId : "", { atMs: 600_000 });
    await enterOk(e2);
    await applyExit(db, wExit(e2, WORLD.MIN_EXPOSURE_MS / 60_000, { extracted: [own[0]!] }));
    assert.equal((await item(p.rifle)).lockRaids, 1, "≥ 8 min: one raid of the lock is done");
  });

  test("bind rule by match_id: a pool unique re-released in the same match and extracted by a risk-free entry arrives bound", async () => {
    const x = await makeItem(db, { def: "rifle", rarity: 1, dur: 90, state: "lost_pool" });
    const s = wShard();
    await openShard(db, s);
    const a = await lockedPlayer();
    const ea = wEntry(s.matchId, a.userId, a.loadoutId);
    assert.deepEqual((await enterOk(ea)).pool.map((i) => i.uid), [x]);
    await applyExit(db, wExit(ea, 2, { unplaced: [{ uid: x, def: "rifle", qty: 1, rarity: 1, dur: 90 }] }));
    assert.equal((await item(x)).state, "lost_pool");
    const c = await lockedPlayer();
    const ec = wEntry(s.matchId, c.userId, c.loadoutId, { atMs: 300_000 });
    assert.deepEqual((await enterOk(ec)).pool.map((i) => i.uid), [x], "re-released by another entry");
    const b = await makeUser(db);
    const eb = wEntry(s.matchId, b, "", { atMs: 400_000 });
    await enterOk(eb);
    await applyExit(db, wExit(eb, 20, { extracted: [{ uid: x, def: "rifle", qty: 1, rarity: 1, dur: 90 }] }));
    const row = await item(x);
    assert.deepEqual([row.state, row.ownerId, row.bound], ["in_stash", b, true]);
    const allocs = (await events(x)).filter((ev) => ev.reason === "alloc");
    assert.deepEqual(allocs.map((ev) => ev.refId).sort(), [ea.entryId, ec.entryId].sort());
    assert.ok(allocs.every((ev) => ev.matchId === s.matchId));
  });

  test("dog tags (D22): full price only for the killer, anyone else × NON_KILLER_MULT", async () => {
    const s = wShard();
    await openShard(db, s);
    const u = await makeUser(db);
    const e = wEntry(s.matchId, u);
    await enterOk(e);
    const v1 = randomUUID(), v2 = randomUUID();
    const r = await applyExit(
      db,
      wExit(e, 10, {
        extracted: [
          { uid: "", def: "junk_dogtag", qty: 1, rarity: 0, dur: 0, lvl: 4, label: "V1", victim: v1, by: u },
          { uid: "", def: "junk_dogtag", qty: 1, rarity: 0, dur: 0, lvl: 4, label: "V2", victim: v2, by: randomUUID() },
        ],
      }),
    );
    const full = dogTagCr(4);
    assert.equal(r.credits, full + Math.floor(full * DOG_TAG.NON_KILLER_MULT));
    assert.deepEqual(r.sold.map((l) => l.cr), [full, Math.floor(full * DOG_TAG.NON_KILLER_MULT)]);
  });

  test("XP lines, ranked PvP pair rule, first extract of the day and the daily soft cap; pvp_kills rows", async () => {
    const s = wShard();
    await openShard(db, s);
    const k = await makeUser(db);
    const v1 = await rankableUser();
    const guestVictim = randomUUID();
    const e1 = wEntry(s.matchId, k);
    await enterOk(e1);
    const stats = { shotsFired: 0, dmgDealt: 0, containersSearched: 4, corpsesSearched: 0, bossKills: 0, npcKills: 3, guardKills: 1 };
    const r1 = await applyExit(
      db,
      wExit(e1, 15, {
        extracted: [{ uid: "", def: "junk_gpu", qty: 1, rarity: 3, dur: 0 }],
        victims: [v1, v1, v1, guestVictim, k],
        stats,
      }),
    );
    const haul = r1.sold.filter((l) => l.def !== "junk_dogtag").reduce((a, l) => a + l.cr, 0);
    const want1 = xpForExit({
      exit: "extract",
      onMapMs: 15 * 60_000,
      haulCr: haul,
      containers: 4,
      marauders: 2,
      guards: 1,
      bosses: 0,
      rankedPvp: 2,
      grindToday: 0,
      firstExtractToday: true,
    });
    assert.equal(r1.xp, want1.total);
    assert.deepEqual(r1.xpLines, want1.lines);
    assert.ok(r1.xpLines.some((l) => l.key === "first_extract"));
    assert.deepEqual([r1.levelBefore, r1.level, r1.levelUp], [1, levelForXp(want1.total), levelForXp(want1.total) > 1]);
    const kills = await db.select().from(pvpKills).where(eq(pvpKills.killerId, k));
    assert.equal(kills.length, 3, "guests and self get no row");
    assert.equal(kills.filter((x) => x.ranked).length, XP.PVP_PAIR_PER_DAY);
    assert.ok(kills.every((x) => x.victimId === v1 && x.entryId === e1.entryId && x.cycleId === W_CYCLE));
    const row1 = (await db.select().from(raidExits).where(eq(raidExits.entryId, e1.entryId)))[0]!;
    assert.deepEqual(
      [row1.xp, row1.xpGrind, row1.onMapMs, row1.npcKills, row1.bossKills, row1.pvpRanked],
      [want1.total, want1.grind, 15 * 60_000, 3, 0, 2],
    );

    // Earlier grind today (another map) pushes the next exit over the soft cap; no first-extract bonus.
    await db.insert(raidExits).values({ entryId: randomUUID(), matchId: randomUUID(), userId: k, exit: "extract", report: wExit(e1, 1), xpGrind: 2_400 });
    const e2 = wEntry(s.matchId, k, "", { atMs: 1_000_000 });
    await enterOk(e2);
    const r2 = await applyExit(db, wExit(e2, 12, { victims: [v1], stats: { ...stats, containersSearched: 10, npcKills: 0, guardKills: 0 } }));
    const want2 = xpForExit({
      exit: "extract",
      onMapMs: 12 * 60_000,
      haulCr: 0,
      containers: 10,
      marauders: 0,
      guards: 0,
      bosses: 0,
      rankedPvp: 0,
      grindToday: want1.grind + 2_400,
      firstExtractToday: false,
    });
    assert.equal(r2.xp, want2.total);
    assert.deepEqual(r2.xpLines, want2.lines);
    assert.ok(r2.xpLines.some((l) => l.key === "daily_cap" && l.xp < 0));
    assert.equal((await db.select().from(pvpKills).where(and(eq(pvpKills.entryId, e2.entryId), eq(pvpKills.ranked, false)))).length, 1);
    const u = (await db.select().from(users).where(eq(users.id, k)))[0]!;
    assert.equal(u.xp, want1.total + want2.total);
    assert.equal(u.level, levelForXp(want1.total + want2.total));
  });

  test("ranked PvP victims (review fix): accounts younger than 72 h or below level 5 are not ranked; the pvp line pays 10 ranked kills a UTC day", async () => {
    const s = wShard();
    await openShard(db, s);
    const k = await makeUser(db);
    const fresh = await makeUser(db);
    await db.update(users).set({ xp: 9_000 }).where(eq(users.id, fresh)); // high level, but a new account
    const low = await rankableUser(XP_L5 - 1); // old account, level 4
    const vets = [await rankableUser(), await rankableUser()];
    // Earlier today this killer already had XP.PVP_DAILY_MAX − 1 ranked kills (another map).
    for (let i = 0; i < XP.PVP_DAILY_MAX - 1; i++) {
      await db.insert(pvpKills).values({ killerId: k, victimId: await makeUser(db), matchId: randomUUID(), entryId: randomUUID(), cycleId: W_CYCLE, ranked: true, at: new Date() });
    }
    const e = wEntry(s.matchId, k);
    await enterOk(e);
    const r = await applyExit(db, wExit(e, 3, { exit: "dead", victims: [fresh, low, ...vets] }));
    const rows = await db.select().from(pvpKills).where(eq(pvpKills.entryId, e.entryId));
    assert.equal(rows.length, 4, "every registered victim is recorded");
    assert.deepEqual(rows.filter((x) => x.ranked).map((x) => x.victimId).sort(), [...vets].sort());
    const row = (await db.select().from(raidExits).where(eq(raidExits.entryId, e.entryId)))[0]!;
    assert.equal(row.pvpRanked, 2, "the Kills board counts both ranked kills");
    assert.deepEqual(r.xpLines.find((l) => l.key === "pvp"), { key: "pvp", qty: 1, xp: XP.PVP }, "only one fits under the daily max");
  });
});

describe("WORLD v6 end settlement and voids (T21)", () => {
  test("raids/end voids unlisted active entries first: gear back to the owner, allocations to the pool untaxed", async () => {
    await bulkPool(30);
    const s = wShard();
    await openShard(db, s);
    const a = await lockedPlayer();
    const ea = wEntry(s.matchId, a.userId, a.loadoutId);
    const ra = await enterOk(ea);
    assert.equal(ra.pool.length, 3);
    const b = await makeUser(db);
    const eb = wEntry(s.matchId, b);
    await enterOk(eb);
    await applyExit(db, wExit(eb, 9));
    const r = await applyEnd(db, endReport(s.matchId, { cycleId: W_CYCLE, shard: 0, entries: [eb.entryId] }));
    assert.equal(r.status, "applied");
    assert.deepEqual(r.voidedEntries, [ea.entryId]);
    assert.equal(r.swept, 0, "nothing left for the sweep");
    const rifle = await item(a.rifle);
    assert.deepEqual([rifle.state, rifle.ownerId, rifle.matchId, rifle.loadoutId], ["in_stash", a.userId, null, null]);
    assert.equal((await events(a.rifle)).find((x) => x.reason === "void")!.refId, ea.entryId);
    for (const it of ra.pool) {
      assert.equal((await item(it.uid)).state, "lost_pool");
      assert.equal((await events(it.uid)).find((x) => x.reason === "return")!.refId, ea.entryId);
    }
    assert.equal(await taxAcc(), 0);
    assert.equal(await stack(a.userId, "ammo_light"), 100, "fungibles refunded");
    assert.equal((await db.select().from(loadouts).where(eq(loadouts.id, a.loadoutId)))[0]!.status, "voided");
    const ents = await db.select().from(raidEntries).where(eq(raidEntries.matchId, s.matchId));
    assert.deepEqual(ents.map((e) => [e.entryId === ea.entryId ? "a" : "b", e.status]).sort(), [["a", "voided"], ["b", "exited"]]);
    assert.equal((await db.select().from(raids).where(eq(raids.matchId, s.matchId)))[0]!.status, "settled");
    assert.ok((await lockLoadout(db, a.userId, [{ key: "w1", itemId: a.rifle, def: "rifle", qty: 1 }])).ok);
  });

  test("allocations left on the map / swept re-enter untaxed; A6 expiry: player uniques → treasury, NPC-corpse pool items → pool", async () => {
    await bulkPool(30);
    const s = wShard();
    await openShard(db, s);
    const a = await lockedPlayer();
    const ea = wEntry(s.matchId, a.userId, a.loadoutId);
    const ra = await enterOk(ea);
    const [x1, x2, x3] = ra.pool as [SettledItem, SettledItem, SettledItem];
    await applyExit(db, wExit(ea, 10, { extracted: [
      { uid: a.rifle, def: "rifle", qty: 1, rarity: 1, dur: 100 },
      { uid: a.armor, def: "armor_2", qty: 1, rarity: 1, dur: ARMOR[2].durability * 0.5 },
      { uid: a.bp, def: "backpack_1", qty: 1, rarity: 0, dur: 100 },
    ] }));
    // B dies with a rifle that does not break; his corpse expires on the map.
    const b = await makeUser(db);
    const bRifle = await makeItem(db, { def: "rifle", rarity: 2, dur: 70, ownerId: b });
    const lb = await lockLoadout(db, b, [{ key: "w1", itemId: bRifle, def: "rifle", qty: 1 }]);
    // targets 0: B's own entry releases nothing, so A's three allocations are the only pool items here.
    const eb = wEntry(s.matchId, b, lb.ok ? lb.loadoutId : "", { atMs: 120_000, targets: 0 });
    await enterOk(eb);
    await applyExit(db, wExit(eb, 3, { exit: "dead" }));
    const r = await applyEnd(
      db,
      endReport(s.matchId, {
        cycleId: W_CYCLE,
        entries: [ea.entryId, eb.entryId],
        leftOnMap: [x1],
        expiredToPool: [x2],
        expired: [
          { uid: bRifle, def: "rifle", qty: 1, rarity: 2, dur: 70 },
          { uid: "", def: "ammo_light", qty: 30, rarity: 0, dur: 0 },
        ],
      }),
    );
    assert.equal(r.status, "applied");
    assert.equal(r.treasury, 1);
    assert.equal(r.swept, 1, "x3 was never reported");
    assert.deepEqual([(await item(x1.uid)).state, (await events(x1.uid)).at(-1)!.reason], ["lost_pool", "left"]);
    assert.deepEqual([(await item(x2.uid)).state, (await events(x2.uid)).at(-1)!.reason], ["lost_pool", "expire"]);
    assert.deepEqual([(await item(x3.uid)).state, (await events(x3.uid)).at(-1)!.reason], ["lost_pool", "sweep"]);
    const br = await item(bRifle);
    assert.deepEqual([br.state, br.ownerId, br.durability, br.matchId], ["treasury", null, 70, null]);
    const bev = (await events(bRifle)).at(-1)!;
    assert.deepEqual([bev.reason, bev.refId, bev.toState], ["expire", s.matchId, "treasury"]);
    assert.equal(await taxAcc(), 0, "no tax on allocations, none on expiry");
    assert.equal(await poolCount(), 30 - 3 + 3);
  });

  test("voids run from ends_at: nothing at minute 36 of a live map; the user's raid at ends_at + 5 min (free-kit entries too); the cron at + 10 min", async () => {
    const t0 = new Date();
    const s = wShard({ startsAt: t0.getTime(), entryClosesAt: t0.getTime() + 35 * 60_000, endsAt: t0.getTime() + WORLD.CYCLE_MS });
    await openShard(db, s, t0);
    const a = await lockedPlayer();
    const ea = wEntry(s.matchId, a.userId, a.loadoutId);
    await enterOk(ea);
    const f = await makeUser(db);
    await enterOk(wEntry(s.matchId, f));
    const at = (min: number) => new Date(t0.getTime() + min * 60_000);
    assert.deepEqual(await voidStaleForUser(db, a.userId, at(36)), [], "a live 45-minute map is never voided at minute 36");
    assert.deepEqual(await voidStale(db, at(36)), []);
    assert.deepEqual(await voidStale(db, at(51)), [], "the cron waits 10 min past the wipe");
    assert.deepEqual(await voidStaleForUser(db, f, at(51)), [s.matchId], "free-kit entry: found through raid_entries");
    assert.equal((await item(a.rifle)).state, "in_stash");
    const ents = await db.select().from(raidEntries).where(eq(raidEntries.matchId, s.matchId));
    assert.ok(ents.every((e) => e.status === "voided"));
    assert.equal((await applyExit(db, wExit(ea, 10))).status, "voided");
  });

  test("orphaned by a newer boot of the same GAME_SERVER_ID (server_id / instance_id columns)", async () => {
    const s1 = wShard({ serverId: "eu-8", instanceId: "inst-1" });
    const s2 = wShard({ serverId: "eu-8", instanceId: "inst-2", cycleId: W_CYCLE + 1 });
    await openShard(db, s1);
    await openShard(db, s2);
    const a = await lockedPlayer();
    await enterOk(wEntry(s1.matchId, a.userId, a.loadoutId));
    const res = await voidOrphans(db, { serverId: "eu-8", instanceId: "inst-2", bootedAt: Date.now() }, new Date(Date.now() + 1000));
    assert.deepEqual(res.voided, [s1.matchId]);
    assert.equal((await item(a.rifle)).state, "in_stash");

    // Lazy path: the boot was recorded but its void never ran.
    const s3 = wShard({ serverId: "eu-9", instanceId: "inst-1", cycleId: W_CYCLE + 2 });
    await openShard(db, s3);
    const b = await makeUser(db);
    await enterOk(wEntry(s3.matchId, b));
    await setParam(db, "gs_boot:eu-9", { serverId: "eu-9", instanceId: "inst-9", bootedAt: Date.now() + 1000, sentAt: 1 });
    assert.deepEqual(await voidStaleForUser(db, b, new Date(Date.now() + 2000)), [s3.matchId]);
  });
});
