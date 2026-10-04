/**
 * B6 invariant check against the isolated `extract_test` database (see inventory/test-db.ts).
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/admin/invariants.test.ts
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { STARTER_KIT, WORLD, mulberry32, type ShardOpenRequest } from "@extract/shared";
import { invariantRuns, items, listings, moneyLedger, users } from "../../db/schema";
import { closeTestDb, lockTestDb, makeUser, openTestDb, resetDb } from "../inventory/test-db";
import { seedEconomy } from "../economy/seed";
import { buyStarterKit } from "../inventory/starter";
import { lockLoadout } from "../inventory/loadout";
import { enterRaid, openShard } from "../inventory/world";
import { buyListing } from "../market/market";
import { alertInvariantFailures, checkInvariants, CHECKS, runInvariants, type InvariantRun } from "./invariants";

const { db, pool } = openTestDb();
before(() => lockTestDb(pool));
after(() => closeTestDb(pool));
beforeEach(async () => {
  await resetDb(db);
  await db.execute(sql`truncate table invariant_runs`);
});

/** A top-up the way /api/wallet/dev-topup does it: balance and its money_ledger row together. */
async function topUp(userId: string, minor: bigint) {
  await db.transaction(async (tx) => {
    await tx.update(users).set({ balanceCents: sql`${users.balanceCents} + ${minor}` }).where(eq(users.id, userId));
    await tx.insert(moneyLedger).values({ account: userId, deltaMinor: minor, reason: "dev_topup", refId: randomUUID() });
  });
}

/**
 * A small live-like world built only through the real services: seeded pool and treasury lots, a
 * player who bought a starter kit and a treasury lot and locked a pistol, and a free-kit player
 * admitted to a world shard with pool items released to him.
 */
async function liveWorld() {
  await seedEconomy(db, { poolItems: 40, listings: 4, rng: mulberry32(3) });
  const a = await makeUser(db, "inv_a");
  await topUp(a, BigInt(STARTER_KIT.PRICE_MINOR) * 4n);
  const kit = await buyStarterKit(db, a, { lockRaids: 1, rng: mulberry32(5) });
  assert.equal(kit.status, "bought");
  const [lot] = await db.select().from(listings).where(eq(listings.status, "active")).orderBy(listings.priceMinor).limit(1);
  await topUp(a, lot!.priceMinor);
  const bought = await buyListing(db, a, lot!.id, { feeBps: 500 });
  assert.ok(bought.ok, JSON.stringify(bought));
  const [pistol] = await db.select().from(items).where(sql`${items.ownerId} = ${a} and ${items.defId} = 'pistol'`).limit(1);
  const lock = await lockLoadout(db, a, [{ key: "w1", itemId: pistol!.id, def: "pistol", qty: 1 }]);
  assert.ok(lock.ok, JSON.stringify(lock));

  const startsAt = Date.now();
  const shard: ShardOpenRequest = {
    matchId: randomUUID(),
    cycleId: 640_200,
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
  // A enters with the locked pistol (risk: pool items are released to him); B on basic gear.
  const entry = await enterRaid(db, { matchId: shard.matchId, entryId: randomUUID(), userId: a, loadoutId: lock.ok ? lock.loadoutId : "", atMs: 60_000, targets: 30, bossAlive: true });
  assert.equal(entry.status, "accepted", entry.reason);
  const b = await makeUser(db, "inv_b");
  const free = await enterRaid(db, { matchId: shard.matchId, entryId: randomUUID(), userId: b, loadoutId: "", atMs: 90_000, targets: 30, bossAlive: true });
  assert.equal(free.status, "accepted", free.reason);
  return { a, b, pistol: pistol!.id, matchId: shard.matchId, entryPool: entry.pool ?? [] };
}

const byKey = (run: InvariantRun, key: string) => {
  const c = run.checks.find((x) => x.key === key);
  assert.ok(c, key);
  return c;
};

describe("invariant check (B6)", () => {
  test("an empty and a live-like database pass every check; the run is stored and no alert fires", async () => {
    const empty = await checkInvariants(db);
    assert.ok(empty.ok, JSON.stringify(empty.checks.filter((c) => c.status !== "ok")));

    const w = await liveWorld();
    assert.ok(w.entryPool.length > 0, "the risk entry got pool items, so the pool check has rows");
    let alerts = 0;
    const run = await runInvariants(db, "test", { alert: async () => void alerts++ });
    assert.ok(run.ok, JSON.stringify(run.checks.filter((c) => c.status !== "ok"), null, 1));
    assert.equal(run.checks.length, CHECKS.length);
    assert.equal(alerts, 0);
    const [row] = await db.select().from(invariantRuns).where(eq(invariantRuns.id, run.id));
    assert.ok(row && row.ok && row.trigger === "test" && row.failed === 0 && row.checks.length === CHECKS.length);
    assert.match(byKey(run, "state_counts").detail ?? "", /in_raid \d+\/\d+/);
  });

  test("injected dupes and mismatches are each found with the offending ids", async () => {
    const w = await liveWorld();
    const [stashItem] = await db.select().from(items).where(sql`${items.ownerId} = ${w.a} and ${items.state} = 'in_stash'`).limit(1);
    const [poolItem] = await db.select().from(items).where(eq(items.state, "lost_pool")).limit(1);

    // A duplicated item: a copy of a stash item with no journal entry.
    const [dupe] = await db
      .insert(items)
      .values({ defId: stashItem!.defId, rarity: stashItem!.rarity, state: "in_stash", ownerId: w.a, origin: stashItem!.origin })
      .returning({ id: items.id });
    // A pool item moved to a stash without its journal entry.
    await db.update(items).set({ state: "in_stash", ownerId: w.b }).where(eq(items.id, poolItem!.id));
    // A stash item that also points at the running raid.
    await db.update(items).set({ matchId: w.matchId }).where(eq(items.id, stashItem!.id));
    // The locked pistol back in the stash while its loadout still lists it (stash and raid at once).
    await db.update(items).set({ state: "in_stash", loadoutId: null }).where(eq(items.id, w.pistol));
    // CR and money without a ledger row; a negative balance.
    await db.update(users).set({ credits: sql`${users.credits} + 500` }).where(eq(users.id, w.a));
    await db.update(users).set({ balanceCents: -7n }).where(eq(users.id, w.b));
    // The house pays someone, and a sale whose sides do not net to zero.
    await db.insert(moneyLedger).values({ account: "house", deltaMinor: -100n, reason: "payout", refId: "inj-payout" });
    await db.insert(moneyLedger).values({ account: w.a, deltaMinor: 50n, reason: "sale", refId: "inj-sale" });
    await db.insert(moneyLedger).values({ account: "ghost", deltaMinor: 1n, reason: "dev_topup", refId: "inj-ghost" });
    // A listing over an item that is not listed; a raid that claims one more release than its entries.
    const [stray] = await db
      .insert(listings)
      .values({ itemId: dupe!.id, sellerId: w.a, template: "x", priceMinor: 10n, status: "active", expiresAt: new Date(Date.now() + 3_600_000) })
      .returning({ id: listings.id });
    await db.execute(sql`update raids set pool_released = pool_released + 1 where match_id = ${w.matchId}`);

    let alerted: InvariantRun | null = null;
    const run = await runInvariants(db, "test", { alert: async (r) => void (alerted = r) });
    assert.equal(run.ok, false);
    assert.ok(alerted, "the alert hook fires on a failed run");
    const has = (key: string, id: string) => {
      const c = byKey(run, key);
      assert.equal(c.status, "fail", `${key}: ${JSON.stringify(c)}`);
      assert.ok(c.sample.includes(id), `${key} sample ${JSON.stringify(c.sample)} lacks ${id}`);
    };
    has("item_journal", dupe!.id);
    has("item_journal", poolItem!.id);
    has("state_counts", "in_stash");
    has("state_counts", "lost_pool");
    has("item_placement", stashItem!.id);
    has("stash_vs_raid", w.pistol);
    has("credits_ledger", w.a);
    has("money_ledger", w.b);
    has("non_negative", `user:${w.b}`);
    has("money_paired", "inj-sale");
    has("money_accounts", "ghost");
    has("listings", dupe!.id);
    has("pool", `raid:${w.matchId}`);
    const house = byKey(run, "house_only_receives");
    assert.equal(house.status, "fail");
    assert.ok(house.sample.some((s) => s.startsWith("ledger:")));
    assert.ok(stray);

    const [row] = await db.select().from(invariantRuns).where(eq(invariantRuns.id, run.id));
    assert.equal(row!.ok, false);
    assert.equal(row!.failed, run.checks.filter((c) => c.status !== "ok").length);
  });

  test("samples are bounded at 10 while the count is exact", async () => {
    const u = await makeUser(db);
    await db.insert(items).values(Array.from({ length: 25 }, () => ({ defId: "rifle", state: "in_stash" as const, ownerId: u, origin: "seed" as const })));
    const c = byKey(await checkInvariants(db), "item_journal");
    assert.equal(c.count, 25);
    assert.equal(c.sample.length, 10);
  });

  test("a check that errors is reported as error; the others still run in the same snapshot", async () => {
    const boom = { key: "boom", title: "boom", run: async (tx: Parameters<(typeof CHECKS)[number]["run"]>[0]) => {
      await tx.execute(sql`select 1 / 0`);
      return { count: 0, sample: [] };
    } };
    const run = await checkInvariants(db, [boom, ...CHECKS.slice(0, 2)]);
    assert.equal(run.checks[0]!.status, "error");
    assert.match(run.checks[0]!.detail ?? "", /division by zero/);
    assert.deepEqual(run.checks.slice(1).map((c) => c.status), ["ok", "ok"]);
    assert.equal(run.failed, 1);
  });

  test("the checks only read: a run changes nothing but invariant_runs", async () => {
    await liveWorld();
    const snap = async () =>
      (await db.execute<{ s: string }>(sql`select
        (select md5(string_agg(i::text, '' order by id)) from items i) ||
        (select count(*) from item_events) || (select md5(string_agg(u.credits || ':' || u.balance_cents, '' order by id)) from users u) ||
        (select count(*) from money_ledger) || (select count(*) from credit_ledger) as s`)).rows[0]!.s;
    const before = await snap();
    await runInvariants(db, "test", { alert: async () => undefined });
    assert.equal(await snap(), before);
  });

  test("alert hook: logs a line and posts the text to ALERT_WEBHOOK_URL; without it only logs", async () => {
    const got: string[] = [];
    const srv = createServer((req, res) => {
      let b = "";
      req.on("data", (d) => (b += d));
      req.on("end", () => {
        got.push(b);
        res.end("ok");
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    const run: InvariantRun = {
      startedAt: new Date(),
      finishedAt: new Date(),
      durationMs: 1,
      ok: false,
      failed: 1,
      checks: [{ key: "credits_ledger", title: "t", status: "fail", count: 2, sample: ["u1", "u2"], ms: 1 }],
    };
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.join(" "));
    try {
      await alertInvariantFailures(run, { ALERT_WEBHOOK_URL: `http://127.0.0.1:${port}/hook` });
      await alertInvariantFailures(run, {});
    } finally {
      console.error = orig;
      srv.close();
    }
    assert.equal(got.length, 1);
    const body = JSON.parse(got[0]!) as { text: string; content: string };
    assert.match(body.text, /credits_ledger: 2 \(e\.g\. u1, u2\)/);
    assert.equal(body.content, body.text);
    assert.equal(errors.filter((e) => e.startsWith("[invariants] FAILED credits_ledger=2")).length, 2);
    assert.ok(errors.every((e) => !e.includes(String(port))), "the webhook URL is never logged");
  });
});
