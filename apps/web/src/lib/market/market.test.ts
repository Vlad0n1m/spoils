/**
 * Market / junker / economy-stats DB tests against the isolated `extract_test` database
 * (see lib/inventory/test-db.ts — it refuses to touch a database without "test" in its name).
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/market/market.test.ts
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { CONSUMABLES_CR, MARKET, boundOffer, mulberry32 } from "@extract/shared";
import { creditLedger, itemEvents, items, listings, moneyLedger, trades, users } from "../../db/schema";
import { closeTestDb, lockTestDb, makeItem, makeUser, openTestDb, resetDb } from "../inventory/test-db";
import { PARAM, setParam } from "../economy/params";
import { seedEconomy } from "../economy/seed";
import { getEconomyStats } from "../lobby/economy-stats";
import { HOUSE_ACCOUNT, browseListings, buyListing, cancelListing, createListing, expireListings, marketHistory, myListings } from "./market";
import { buyBound, buyConsumables } from "./trader";

const { db, pool } = openTestDb();
before(() => lockTestDb(pool));
after(() => closeTestDb(pool));
beforeEach(() => resetDb(db));

const OPTS = { sellUnlockLevel: 1, feeBps: 500 };

async function setBalance(userId: string, cents: bigint, level = 1): Promise<void> {
  await db.update(users).set({ balanceCents: cents, level }).where(eq(users.id, userId));
}

async function user(cents = 0n, level = 1): Promise<string> {
  const id = await makeUser(db);
  await setBalance(id, cents, level);
  return id;
}

async function balanceOf(id: string): Promise<bigint> {
  const [r] = await db.select({ b: users.balanceCents }).from(users).where(eq(users.id, id));
  return r!.b;
}

async function creditsOf(id: string): Promise<number> {
  const [r] = await db.select({ c: users.credits }).from(users).where(eq(users.id, id));
  return r!.c;
}

async function itemRow(id: string) {
  const [r] = await db.select().from(items).where(eq(items.id, id));
  return r!;
}

async function houseTotal(): Promise<bigint> {
  const r = await db.execute<{ s: string | null }>(sql`select sum(delta_minor) as s from money_ledger where account = ${HOUSE_ACCOUNT}`);
  return BigInt(r.rows[0]?.s ?? 0);
}

async function listed(seller: string, def = "rifle", price = 1000n, rarity = 1): Promise<{ itemId: string; listingId: string }> {
  const itemId = await makeItem(db, { def, rarity, ownerId: seller });
  const r = await createListing(db, seller, itemId, price, OPTS);
  assert.ok(r.ok, JSON.stringify(r));
  return { itemId, listingId: r.listingId };
}

test("list: item → listed, CR fee charged once, lot visible to others", async () => {
  const seller = await user();
  const viewer = await user();
  const { itemId, listingId } = await listed(seller, "rifle", 1500n, 2);
  assert.equal((await itemRow(itemId)).state, "listed");
  assert.equal(await creditsOf(seller), 1000 - MARKET.LISTING_FEE_CR[2]);
  const fee = await db.select().from(creditLedger).where(eq(creditLedger.refId, listingId));
  assert.equal(fee.length, 1);
  assert.equal(fee[0]!.reason, "listing_fee");
  const ev = await db.select().from(itemEvents).where(eq(itemEvents.itemId, itemId));
  assert.deepEqual(ev.map((e) => [e.reason, e.toState]), [["list", "listed"]]);
  const seen = await browseListings(db, { viewerId: viewer });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.price, "1500");
  assert.equal(seen[0]!.mine, false);
  assert.equal(seen[0]!.template, "weapon:rifle:2");
  // Listing the same item twice is refused (it is no longer in the stash).
  const again = await createListing(db, seller, itemId, 900n, OPTS);
  assert.deepEqual(again, { ok: false, code: "not_in_stash" });
});

test("list rules: level, giveaway lock, bound, ownership, price, CR, cap", async () => {
  const seller = await user();
  const other = await user();
  const lvl = await makeItem(db, { def: "rifle", ownerId: seller });
  assert.deepEqual(await createListing(db, seller, lvl, 100n, { ...OPTS, sellUnlockLevel: 5 }), { ok: false, code: "level_locked" });
  const locked = await makeItem(db, { def: "rifle", ownerId: seller, lockRaids: 1 });
  assert.deepEqual(await createListing(db, seller, locked, 100n, OPTS), { ok: false, code: "trade_locked" });
  const bound = await makeItem(db, { def: "rifle", ownerId: seller, bound: true });
  assert.deepEqual(await createListing(db, seller, bound, 100n, OPTS), { ok: false, code: "bound" });
  const worn = await makeItem(db, { def: "rifle", ownerId: seller, dur: 0 });
  assert.deepEqual(await createListing(db, seller, worn, 100n, OPTS), { ok: false, code: "broken" });
  const notMine = await makeItem(db, { def: "rifle", ownerId: other });
  assert.deepEqual(await createListing(db, seller, notMine, 100n, OPTS), { ok: false, code: "not_found" });
  const inRaid = await makeItem(db, { def: "rifle", ownerId: seller, state: "in_raid" });
  assert.deepEqual(await createListing(db, seller, inRaid, 100n, OPTS), { ok: false, code: "not_in_stash" });
  assert.deepEqual(await createListing(db, seller, lvl, 0n, OPTS), { ok: false, code: "bad_price" });
  assert.deepEqual(await createListing(db, seller, lvl, -5n, OPTS), { ok: false, code: "bad_price" });
  // Not enough CR for the listing fee: nothing is written.
  await db.update(users).set({ credits: 10 }).where(eq(users.id, seller));
  assert.deepEqual(await createListing(db, seller, lvl, 100n, OPTS), { ok: false, code: "insufficient_credits" });
  assert.equal((await itemRow(lvl)).state, "in_stash");
  assert.equal((await db.select().from(listings)).length, 0);
  // Active-lot cap.
  await db.update(users).set({ credits: 1_000_000 }).where(eq(users.id, seller));
  for (let i = 0; i < MARKET.MAX_ACTIVE_LISTINGS; i++) {
    const id = await makeItem(db, { def: "shotgun", ownerId: seller });
    assert.ok((await createListing(db, seller, id, 100n, OPTS)).ok);
  }
  assert.deepEqual(await createListing(db, seller, lvl, 100n, OPTS), { ok: false, code: "too_many_listings" });
});

test("buy: money moves with a 5% fee, item changes owner, trade recorded", async () => {
  const seller = await user(0n);
  const buyer = await user(5000n);
  const { itemId, listingId } = await listed(seller, "rifle", 1000n);
  const r = await buyListing(db, buyer, listingId, { feeBps: 500 });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.fee, "50");
  assert.equal(r.balance, "4000");
  assert.equal(await balanceOf(buyer), 4000n);
  assert.equal(await balanceOf(seller), 950n);
  assert.equal(await houseTotal(), 50n);
  const it = await itemRow(itemId);
  assert.equal(it.state, "in_stash");
  assert.equal(it.ownerId, buyer);
  const [l] = await db.select().from(listings).where(eq(listings.id, listingId));
  assert.equal(l!.status, "sold");
  const t = await db.select().from(trades);
  assert.equal(t.length, 1);
  assert.equal(t[0]!.priceMinor, 1000n);
  assert.equal(t[0]!.feeMinor, 50n);
  // Money is conserved: buyer −1000 = seller +950 + house +50.
  const sum = await db.execute<{ s: string }>(sql`select sum(delta_minor) as s from money_ledger`);
  assert.equal(BigInt(sum.rows[0]!.s), 0n);
  // The buyer now owns it and can list it again.
  assert.ok((await createListing(db, buyer, itemId, 2000n, OPTS)).ok);
});

test("stop-crane market_paused (admin): no new lots, no sales, nothing charged; cancelling still works; 0 reopens", async () => {
  const seller = await user(0n);
  const buyer = await user(5000n);
  const { listingId } = await listed(seller, "rifle", 1000n);
  const other = await makeItem(db, { def: "rifle", rarity: 1, ownerId: seller });
  const cr = await creditsOf(seller);
  await setParam(db, PARAM.MARKET_PAUSED, 1);
  assert.deepEqual(await createListing(db, seller, other, 1000n, OPTS), { ok: false, code: "market_paused" });
  assert.deepEqual(await buyListing(db, buyer, listingId, { feeBps: 500 }), { ok: false, code: "market_paused" });
  assert.equal(await balanceOf(buyer), 5000n, "nothing charged");
  assert.equal(await creditsOf(seller), cr, "no listing fee");
  assert.equal((await itemRow(other)).state, "in_stash");
  await setParam(db, PARAM.MARKET_PAUSED, 0);
  assert.ok((await buyListing(db, buyer, listingId, { feeBps: 500 })).ok);
  // Cancelling is never paused.
  const second = await listed(seller, "rifle", 1000n);
  await setParam(db, PARAM.MARKET_PAUSED, 1);
  assert.ok((await cancelListing(db, seller, second.listingId)).ok);
});

test("buy race: N buyers click the same lot at once → exactly one wins, nobody else pays", async () => {
  const seller = await user(0n);
  const { itemId, listingId } = await listed(seller, "shotgun", 700n);
  const buyers = await Promise.all(Array.from({ length: 6 }, () => user(10_000n)));
  const results = await Promise.all(buyers.map((b) => buyListing(db, b, listingId)));
  const wins = results.filter((r) => r.ok);
  assert.equal(wins.length, 1, JSON.stringify(results));
  assert.ok(results.filter((r) => !r.ok).every((r) => !r.ok && r.code === "gone"));
  const winner = buyers[results.findIndex((r) => r.ok)]!;
  assert.equal((await itemRow(itemId)).ownerId, winner);
  for (const b of buyers) assert.equal(await balanceOf(b), b === winner ? 9_300n : 10_000n);
  assert.equal(await balanceOf(seller), 665n);
  assert.equal((await db.select().from(trades)).length, 1);
  assert.equal((await db.select().from(moneyLedger)).length, 3);
});

test("buy race: the same buyer double-clicking pays once", async () => {
  const seller = await user();
  const buyer = await user(1000n);
  const { listingId } = await listed(seller, "rifle", 400n);
  const rs = await Promise.all([buyListing(db, buyer, listingId), buyListing(db, buyer, listingId), buyListing(db, buyer, listingId)]);
  assert.equal(rs.filter((r) => r.ok).length, 1);
  assert.equal(await balanceOf(buyer), 600n);
});

test("buy refusals: own lot, no funds, hidden, cancelled, unknown", async () => {
  const seller = await user(10_000n);
  const poor = await user(10n);
  const { listingId } = await listed(seller, "rifle", 1000n);
  assert.deepEqual(await buyListing(db, seller, listingId), { ok: false, code: "own_listing" });
  assert.deepEqual(await buyListing(db, poor, listingId), { ok: false, code: "insufficient_funds" });
  assert.deepEqual(await buyListing(db, poor, randomUUID()), { ok: false, code: "not_found" });
  assert.deepEqual(await buyListing(db, poor, "nope"), { ok: false, code: "not_found" });
  const hiddenItem = await makeItem(db, { def: "shotgun", ownerId: seller });
  const hidden = await createListing(db, seller, hiddenItem, 100n, { ...OPTS, visibleDelayMs: 60_000 });
  assert.ok(hidden.ok);
  const rich = await user(10_000n);
  assert.deepEqual(await buyListing(db, rich, hidden.listingId), { ok: false, code: "not_visible" });
  assert.equal((await browseListings(db, { viewerId: rich })).length, 1, "the pending lot is hidden from others");
  assert.equal((await browseListings(db, { viewerId: seller })).length, 2, "the seller sees their pending lot");
  assert.ok(await buyListing(db, rich, hidden.listingId, { now: new Date(Date.now() + 61_000) }).then((r) => r.ok));
  assert.equal(await balanceOf(poor), 10n);
});

test("cancel: item back to the stash, CR fee kept, lot can no longer be bought", async () => {
  const seller = await user();
  const other = await user(10_000n);
  const { itemId, listingId } = await listed(seller, "rifle", 1000n, 0);
  const credits = await creditsOf(seller);
  assert.deepEqual(await cancelListing(db, other, listingId), { ok: false, code: "not_yours" });
  assert.deepEqual(await cancelListing(db, seller, listingId), { ok: true });
  assert.deepEqual(await cancelListing(db, seller, listingId), { ok: false, code: "gone" });
  assert.equal((await itemRow(itemId)).state, "in_stash");
  assert.equal(await creditsOf(seller), credits);
  assert.deepEqual(await buyListing(db, other, listingId), { ok: false, code: "gone" });
  const mine = await myListings(db, seller);
  assert.equal(mine[0]!.status, "cancelled");
});

test("cancel vs buy race: one of them wins, never both", async () => {
  for (let i = 0; i < 5; i++) {
    const seller = await user();
    const buyer = await user(10_000n);
    const { itemId, listingId } = await listed(seller, "rifle", 500n);
    const [c, b] = await Promise.all([cancelListing(db, seller, listingId), buyListing(db, buyer, listingId)]);
    assert.ok(c.ok !== b.ok, `cancel ${JSON.stringify(c)} buy ${JSON.stringify(b)}`);
    const it = await itemRow(itemId);
    assert.equal(it.state, "in_stash");
    assert.equal(it.ownerId, b.ok ? buyer : seller);
    assert.equal(await balanceOf(buyer), b.ok ? 9_500n : 10_000n);
  }
});

test("expiry: player lots return to the stash, treasury lots to the treasury", async () => {
  const seller = await user();
  const { itemId } = await listed(seller, "rifle", 1000n);
  await seedEconomy(db, { poolItems: 3, listings: 2, rng: mulberry32(7) });
  const later = new Date(Date.now() + MARKET.LISTING_TTL_MS + 1000);
  assert.equal((await browseListings(db, { viewerId: seller, now: later })).length, 0);
  assert.equal(await expireListings(db, later), 3);
  assert.equal((await itemRow(itemId)).state, "in_stash");
  const treasury = await db.execute<{ n: number }>(sql`select count(*)::int as n from items where state = 'treasury'`);
  assert.equal(treasury.rows[0]!.n, 2);
  assert.equal(await expireListings(db, later), 0);
});

test("treasury (seeded NPC) lot: the house gets the whole price", async () => {
  await seedEconomy(db, { poolItems: 0, listings: 1, rng: mulberry32(3) });
  const buyer = await user(1_000_000n);
  const [lot] = await browseListings(db, { viewerId: buyer });
  assert.ok(lot && lot.isTreasury && lot.seller === "Treasury");
  const r = await buyListing(db, buyer, lot.id);
  assert.ok(r.ok);
  assert.equal(r.fee, "0");
  assert.equal(await houseTotal(), BigInt(lot.price));
  assert.equal((await itemRow(lot.item.id)).ownerId, buyer);
});

test("price band: once the index is valid, far-off prices are refused", async () => {
  const buyer = await user(100_000_000n);
  // 10 counted trades from 5 sellers at ~1000 → index valid.
  for (let s = 0; s < 5; s++) {
    const seller = await user();
    for (let k = 0; k < 2; k++) {
      const { listingId } = await listed(seller, "rifle", BigInt(950 + s * 20 + k * 10), 1);
      const b = await user(10_000n);
      assert.ok((await buyListing(db, b, listingId)).ok);
    }
  }
  const hist = await marketHistory(db, "weapon:rifle:1");
  assert.ok(hist.index !== null && hist.index >= 950n && hist.index <= 1050n, String(hist.index));
  assert.equal(hist.trades.length, 10);
  assert.equal(hist.daily.reduce((s, d) => s + d.volume, 0), 10);
  const seller = await user();
  const cheap = await makeItem(db, { def: "rifle", rarity: 1, ownerId: seller });
  const low = await createListing(db, seller, cheap, 100n, OPTS);
  assert.equal(!low.ok && low.code, "price_out_of_band");
  const high = await createListing(db, seller, cheap, 100_000n, OPTS);
  assert.equal(!high.ok && high.code, "price_out_of_band");
  assert.ok((await createListing(db, seller, cheap, 1200n, OPTS)).ok);
  // Another template has no index yet: anything positive goes.
  const sg = await makeItem(db, { def: "shotgun", rarity: 0, ownerId: seller });
  assert.ok((await createListing(db, seller, sg, 1n, OPTS)).ok);
  assert.ok(buyer);
});

test("junker: CR → stacks, idempotent per request id, refuses overdraft", async () => {
  const u = await user();
  const req = randomUUID();
  const r = await buyConsumables(db, u, "ammo_light", 2, req);
  assert.ok(r.ok && r.applied);
  assert.equal(r.qty, CONSUMABLES_CR.ammo_light.qty * 2);
  assert.equal(r.credits, 1000 - CONSUMABLES_CR.ammo_light.cr * 2);
  const again = await buyConsumables(db, u, "ammo_light", 2, req);
  assert.ok(again.ok && !again.applied);
  assert.equal(again.qty, r.qty);
  assert.equal(await creditsOf(u), r.credits);
  assert.deepEqual(await buyConsumables(db, u, "medkit", 20, randomUUID()), { ok: false, code: "insufficient_credits" });
  assert.deepEqual(await buyConsumables(db, u, "rifle", 1, randomUUID()), { ok: false, code: "bad_item" });
  assert.deepEqual(await buyConsumables(db, u, "bandage", 0, randomUUID()), { ok: false, code: "bad_qty" });
  assert.deepEqual(await buyConsumables(db, u, "bandage", 1, "x"), { ok: false, code: "bad_request" });
});

test("bound trader (v5 review CR sink): CR → one BOUND unique, idempotent, level-gated, never listable", async () => {
  const u = await user();
  const req = randomUUID();
  const r = await buyBound(db, u, "backpack_1", req);
  assert.ok(r.ok && r.applied && r.itemId, JSON.stringify(r));
  assert.equal(r.credits, 1000 - boundOffer("backpack_1")!.cr);
  const again = await buyBound(db, u, "backpack_1", req);
  assert.ok(again.ok && !again.applied && again.itemId === null, "a replay charges and delivers once");
  const mine = await db.select().from(items).where(eq(items.ownerId, u));
  assert.equal(mine.length, 1);
  assert.ok(mine[0]!.bound && mine[0]!.origin === "trader" && mine[0]!.state === "in_stash");
  assert.deepEqual(await buyBound(db, u, "armor_1", randomUUID()), { ok: false, code: "insufficient_credits" });
  assert.deepEqual(await buyBound(db, u, "rifle", randomUUID()), { ok: false, code: "trader_level" }, "rifle needs trader level 2 (player level 5)");
  assert.deepEqual(await buyBound(db, u, "ammo_light", randomUUID()), { ok: false, code: "bad_item" });
  assert.deepEqual(await buyBound(db, u, "backpack_1", "x"), { ok: false, code: "bad_request" });
  // Bound: the market refuses it.
  const lr = await createListing(db, u, mine[0]!.id, 1000n, OPTS);
  assert.deepEqual(lr.ok ? "listed" : lr.code, "bound");
});

test("economy stats: faucets, sinks, pool, treasury and trades add up", async () => {
  await seedEconomy(db, { poolItems: 5, listings: 2, rng: mulberry32(11) });
  const seller = await user();
  const buyer = await user(10_000n);
  const { listingId } = await listed(seller, "rifle", 2000n, 0);
  assert.ok((await buyListing(db, buyer, listingId)).ok);
  assert.ok((await buyConsumables(db, buyer, "bandage", 1, randomUUID())).ok);
  const s = await getEconomyStats(db);
  assert.equal(s.items.poolSize, 5);
  assert.equal(s.market.activeListings, 2);
  assert.equal(s.market.tradesAll, 1);
  assert.equal(s.market.volumeAll, "2000");
  assert.equal(s.market.feesAll, "100");
  assert.equal(s.credits.outAll, MARKET.LISTING_FEE_CR[0] + CONSUMABLES_CR.bandage.cr);
  assert.equal(s.credits.circulating, 2000 - MARKET.LISTING_FEE_CR[0] - CONSUMABLES_CR.bandage.cr);
  assert.equal(s.players.registered, 2);
  assert.equal(s.items.circulating, 3, "bought rifle + 2 treasury lots");
});
