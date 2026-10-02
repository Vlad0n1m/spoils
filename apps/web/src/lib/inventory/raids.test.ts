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
  GIVEAWAY_KIT,
  MATCH,
  POOL,
  PROGRESSION,
  dogTagCr,
  itemDef,
  mulberry32,
  poolReleaseCount,
  type MatchEndReport,
  type PlayerExitReport,
  type RaidStartRequest,
  type SettledItem,
} from "@extract/shared";
import { creditLedger, itemEvents, items, loadouts, matchResults, raids, stashStacks, users } from "../../db/schema";
import { PARAM, setParam } from "../economy/params";
import { addStack } from "./transition";
import { lockLoadout, unlockLoadout, saveDraft } from "./loadout";
import { applyEnd, applyExit, startRaid, voidStale, RAID_VOID_AFTER_MS } from "./raids";
import { claimStarter } from "./starter";
import { getStash } from "./stash";
import { seedEconomy } from "../economy/seed";
import { listings } from "../../db/schema";
import { closeTestDb, lockTestDb, makeItem, makeUser, openTestDb, resetDb } from "./test-db";
import { LOADOUT_LOCK_TTL_MS } from "./db";

const { db, pool } = openTestDb();
before(() => lockTestDb(pool));
after(() => closeTestDb(pool));

const CONTAINERS: RaidStartRequest["containers"] = [
  { idx: 1, kind: "crate", tier: 1 },
  { idx: 2, kind: "weapon_box", tier: 3 },
  { idx: 3, kind: "safe", tier: 4 },
  { idx: 4, kind: "fridge", tier: 0 },
  { idx: 5, kind: "stash", tier: 2 },
];

function startReq(players: RaidStartRequest["players"], over: Partial<RaidStartRequest> = {}): RaidStartRequest {
  return { matchId: randomUUID(), mode: "live", mapId: "steppe", matchSeed: 1234, players, containers: CONTAINERS, bossSlots: 0, ...over };
}

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

describe("starter kit", () => {
  test("claims once, even concurrently", async () => {
    const u = await makeUser(db);
    const results = await Promise.all([claimStarter(db, u, { lockRaids: 1 }), claimStarter(db, u, { lockRaids: 1 })]);
    assert.deepEqual(results.map((r) => r.status).sort(), ["already", "claimed"]);
    assert.equal((await claimStarter(db, u)).status, "already");
    const owned = await db.select().from(items).where(eq(items.ownerId, u));
    assert.equal(owned.length, 3);
    assert.ok(owned.every((i) => i.origin === "giveaway" && i.lockRaids === 1 && i.state === "in_stash"));
    assert.equal(await credits(u), 1000 + GIVEAWAY_KIT.cr);
    assert.ok((await stack(u, "bandage")) > 0);
    assert.equal((await claimStarter(db, randomUUID())).status, "no_user");
    await assertCreditsConserved();
  });

  test("stash shows the kit", async () => {
    const u = await makeUser(db);
    await claimStarter(db, u, { rng: mulberry32(7) });
    const s = await getStash(db, u);
    assert.ok(s);
    assert.equal(s.uniques.length, 3);
    assert.equal(s.starterClaimed, true);
    assert.equal(s.credits, 2000);
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

describe("raid start", () => {
  test("accepts a locked loadout, replays idempotently, rejects a second start", async () => {
    const p = await lockedPlayer();
    const req = startReq([{ userId: p.userId, loadoutId: p.loadoutId }]);
    const res = await startRaid(db, req);
    assert.equal(res.accepted.length, 1);
    assert.equal(res.rejected.length, 0);
    const snap = res.accepted[0]!;
    const armorEntry = snap.entries.find((e) => e.key === "armor")!;
    // DB 50 % → absorb points of armor level 2.
    assert.equal(armorEntry.dur, ARMOR[2].durability * 0.5);
    assert.equal(snap.entries.find((e) => e.key === "p0")!.qty, 60);
    assert.equal((await item(p.rifle)).matchId, req.matchId);

    const replay = await startRaid(db, req);
    assert.deepEqual(replay, res);

    const second = await startRaid(db, startReq([{ userId: p.userId, loadoutId: p.loadoutId }]));
    assert.deepEqual(second.rejected, [{ userId: p.userId, reason: "not_locked" }]);
    assert.equal(second.accepted.length, 0);
  });

  test("wrong user and expired loadouts are rejected", async () => {
    const p = await lockedPlayer();
    const other = await makeUser(db);
    const r1 = await startRaid(db, startReq([{ userId: other, loadoutId: p.loadoutId }]));
    assert.deepEqual(r1.rejected, [{ userId: other, reason: "wrong_user" }]);
    const r2 = await startRaid(
      db,
      startReq([{ userId: p.userId, loadoutId: p.loadoutId }]),
      new Date(Date.now() + LOADOUT_LOCK_TTL_MS + 1000),
    );
    assert.deepEqual(r2.rejected, [{ userId: p.userId, reason: "expired" }]);
    assert.equal((await item(p.rifle)).state, "in_stash");
  });

  test("pool release: risk units decide the count, free kits get nothing, boss takes the best", async () => {
    for (let i = 0; i < 20; i++) await makeItem(db, { def: i % 2 ? "rifle" : "armor_1", rarity: i % 4, state: "lost_pool", dur: 80 });
    const free = await startRaid(db, startReq([{ userId: await makeUser(db), loadoutId: "" }]));
    assert.deepEqual(free.containerLoot, {});

    const p = await lockedPlayer(); // 3 uniques → round(1.5 × 3) = 5 (≤ 10)
    const res = await startRaid(db, startReq([{ userId: p.userId, loadoutId: p.loadoutId }], { bossSlots: 1 }));
    const all = Object.values(res.containerLoot).flat();
    assert.equal(all.length, poolReleaseCount(20, 3));
    assert.equal(res.containerLoot.boss?.length, POOL.BOSS_SHARE);
    assert.equal(res.containerLoot["4"], undefined, "no pool loot in a fridge");
    for (const it of all) {
      const row = await item(it.uid);
      assert.equal(row.state, "in_raid");
      assert.equal(row.ownerId, null);
    }
    assert.equal(await poolCount(), 20 - all.length);
  });
});

describe("raid exit", () => {
  test("extract: gear to stash, junk sold once, ammo back, XP; replay is a no-op", async () => {
    const p = await lockedPlayer();
    const req = startReq([{ userId: p.userId, loadoutId: p.loadoutId }]);
    await startRaid(db, req);
    await setParam(db, PARAM.AUTOSELL_MULT, 1.1);
    const rep = exitReport(req.matchId, p.userId, {
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
    assert.equal(r.xp, PROGRESSION.XP_RAID + PROGRESSION.XP_EXTRACT + 2 * PROGRESSION.XP_KILL);
    assert.equal(await credits(p.userId), 1000 + expected);
    assert.equal(await stack(p.userId, "ammo_light"), 40 + 25);
    const rifle = await item(p.rifle);
    assert.deepEqual([rifle.state, rifle.ownerId, rifle.matchId, rifle.lockRaids], ["in_stash", p.userId, null, 1]);
    assert.equal((await item(p.armor)).durability, 25);

    const dup = await applyExit(db, rep);
    assert.equal(dup.status, "duplicate");
    assert.equal(dup.credits, expected);
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
    const req = startReq([{ userId: p.userId, loadoutId: p.loadoutId }]);
    await startRaid(db, req);
    const r = await applyExit(
      db,
      exitReport(req.matchId, p.userId, {
        exit: "dead",
        lost: [{ uid: p.rifle, def: "rifle", qty: 1, rarity: 1, dur: 100 }],
      }),
    );
    assert.equal(r.status, "applied");
    const rifle = await item(p.rifle);
    assert.deepEqual([rifle.state, rifle.ownerId, rifle.durability], ["lost_pool", null, 100 - POOL.BREAK_DUR_LOSS]);
    assert.equal((await item(p.armor)).state, "in_raid");
  });

  test("another player extracts the dead player's armor: owner changes; guest pickup goes to the pool", async () => {
    const victim = await lockedPlayer();
    const killer = await makeUser(db);
    const guest = randomUUID();
    const req = startReq([
      { userId: victim.userId, loadoutId: victim.loadoutId },
      { userId: killer, loadoutId: "" },
      { userId: guest, loadoutId: "" },
    ]);
    await startRaid(db, req);
    await applyExit(db, exitReport(req.matchId, victim.userId, { exit: "dead" }));
    const tag: SettledItem = { uid: "", def: "junk_dogtag", qty: 1, rarity: 1, dur: 0, label: "victim", lvl: 4, victim: victim.userId };
    const k = await applyExit(
      db,
      exitReport(req.matchId, killer, {
        extracted: [{ uid: victim.armor, def: "armor_2", qty: 1, rarity: 1, dur: 10 }, tag],
      }),
    );
    assert.equal(k.credits, dogTagCr(4));
    const armor = await item(victim.armor);
    assert.deepEqual([armor.state, armor.ownerId], ["in_stash", killer]);
    const g = await applyExit(
      db,
      exitReport(req.matchId, guest, {
        extracted: [
          { uid: victim.rifle, def: "rifle", qty: 1, rarity: 1, dur: 100 },
          { uid: "", def: "junk_gpu", qty: 1, rarity: 3, dur: 0 },
        ],
      }),
    );
    assert.equal(g.guest, true);
    assert.equal(g.credits, 0);
    assert.equal(g.sold[0]?.cr, 1500, "guest receipt shows what it would have sold for");
    const rifle = await item(victim.rifle);
    assert.deepEqual([rifle.state, rifle.ownerId, rifle.durability], ["lost_pool", null, 100]);
  });

  test("dog tags: same pair pays REPEAT_FREE times per 24 h", async () => {
    const killer = await makeUser(db);
    const victim = randomUUID();
    const tag = (): SettledItem => ({ uid: "", def: "junk_dogtag", qty: 1, rarity: 1, dur: 0, label: "v", lvl: 0, victim });
    let total = 0;
    for (let i = 0; i < DOG_TAG.REPEAT_FREE + 2; i++) {
      const m = randomUUID();
      await startRaid(db, startReq([{ userId: killer, loadoutId: "" }], { matchId: m }));
      const r = await applyExit(db, exitReport(m, killer, { extracted: [tag()] }));
      total += r.credits;
    }
    assert.equal(total, DOG_TAG.REPEAT_FREE * dogTagCr(0));
  });

  test("unknown uids are skipped, never created", async () => {
    const u = await makeUser(db);
    const m = randomUUID();
    await startRaid(db, startReq([{ userId: u, loadoutId: "" }], { matchId: m }));
    const ghost = randomUUID();
    const r = await applyExit(db, exitReport(m, u, { extracted: [{ uid: ghost, def: "sniper", qty: 1, rarity: 3, dur: 100 }] }));
    assert.deepEqual(r.skipped, [ghost]);
    assert.equal(await itemCount(), 0);
  });

  test("exit for a match the web never started (demo fallback) still pays junk", async () => {
    const u = await makeUser(db);
    const m = randomUUID();
    const r = await applyExit(db, exitReport(m, u, { extracted: [{ uid: "", def: "junk_bolts", qty: 2, rarity: 0, dur: 0 }] }));
    assert.equal(r.status, "applied");
    assert.equal(r.credits, itemDef("junk_bolts")!.value! * 2);
    const raid = (await db.select().from(raids).where(eq(raids.matchId, m)))[0]!;
    assert.equal(raid.started, false);
  });
});

describe("raid end and conservation", () => {
  test("full raid: every item ends in exactly one place, totals conserved, end is idempotent", async () => {
    for (let i = 0; i < 10; i++) await makeItem(db, { def: "shotgun", rarity: 2, state: "lost_pool", dur: 70 });
    const a = await lockedPlayer();
    const b = await lockedPlayer();
    const before = await itemCount();
    const req = startReq([
      { userId: a.userId, loadoutId: a.loadoutId },
      { userId: b.userId, loadoutId: b.loadoutId },
    ]);
    const start = await startRaid(db, req);
    const released = Object.values(start.containerLoot).flat();
    assert.ok(released.length > 0);
    // a extracts with rifle + one pool item; b dies (rifle breaks), armor + bp left in corpse.
    await applyExit(
      db,
      exitReport(req.matchId, a.userId, {
        extracted: [
          { uid: a.rifle, def: "rifle", qty: 1, rarity: 1, dur: 100 },
          { uid: released[0]!.uid, def: released[0]!.def, qty: 1, rarity: released[0]!.rarity, dur: released[0]!.dur },
        ],
        lost: [],
      }),
    );
    await applyExit(db, exitReport(req.matchId, b.userId, { exit: "dead", lost: [{ uid: b.rifle, def: "rifle", qty: 1, rarity: 1, dur: 100 }] }));
    const end = endReport(req.matchId, {
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
    const mr = await db.select().from(matchResults).where(eq(matchResults.matchId, req.matchId));
    assert.equal(mr[0]!.payload.participants[0]!.extracted?.length, 2);
    const raid = (await db.select().from(raids).where(eq(raids.matchId, req.matchId)))[0]!;
    assert.equal(raid.status, "settled");
    await assertCreditsConserved();
  });

  test("treasury tax takes whole items once the accumulator covers them", async () => {
    await setParam(db, PARAM.TAX_ACC, 10_000);
    const p = await lockedPlayer();
    const req = startReq([{ userId: p.userId, loadoutId: p.loadoutId }]);
    await startRaid(db, req);
    await applyEnd(db, endReport(req.matchId, { leftOnMap: [] }));
    const states = await Promise.all([p.rifle, p.armor, p.bp].map(async (id) => (await item(id)).state));
    assert.ok(states.includes("treasury"));
    const ev = await db.select().from(itemEvents).where(eq(itemEvents.reason, "tax"));
    assert.ok(ev.length >= 1);
  });
});

describe("void", () => {
  test("a raid that never ended returns loadouts to their owners and refuses late reports", async () => {
    await makeItem(db, { def: "sniper", rarity: 3, state: "lost_pool", dur: 90 });
    const p = await lockedPlayer();
    const t0 = new Date();
    const req = startReq([{ userId: p.userId, loadoutId: p.loadoutId }]);
    const res = await startRaid(db, req, t0);
    const released = Object.values(res.containerLoot).flat();
    assert.equal(released.length, 1);

    assert.deepEqual(await voidStale(db, new Date(t0.getTime() + 60_000)), [], "too early");
    const later = new Date(t0.getTime() + RAID_VOID_AFTER_MS + 1000);
    assert.deepEqual(await voidStale(db, later), [req.matchId]);
    assert.deepEqual(await voidStale(db, later), [], "void is idempotent");

    const rifle = await item(p.rifle);
    assert.deepEqual([rifle.state, rifle.ownerId, rifle.matchId, rifle.loadoutId], ["in_stash", p.userId, null, null]);
    assert.equal((await item(released[0]!.uid)).state, "lost_pool");
    assert.equal(await stack(p.userId, "ammo_light"), 100, "loadout ammo refunded");
    assert.equal((await db.select().from(loadouts).where(eq(loadouts.id, p.loadoutId)))[0]!.status, "voided");

    const late = await applyExit(db, exitReport(req.matchId, p.userId, { extracted: [{ uid: p.rifle, def: "rifle", qty: 1, rarity: 1, dur: 100 }] }));
    assert.equal(late.status, "voided");
    assert.equal((await applyEnd(db, endReport(req.matchId))).status, "voided");
    assert.equal(MATCH.DURATION_MS < RAID_VOID_AFTER_MS, true);
    // The user can lock again afterwards.
    const relock = await lockLoadout(db, p.userId, [{ key: "w1", itemId: p.rifle, def: "rifle", qty: 1 }]);
    assert.equal(relock.ok, true);
    const ledger = await db.select().from(creditLedger);
    assert.equal(ledger.length, 0);
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
