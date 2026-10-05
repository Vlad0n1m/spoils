/**
 * SPOILS shop order state machine and delivery (lib/idos/shop.ts) against the isolated `extract_test`
 * database (lib/inventory/test-db.ts), with the iDos payment faked: pending → paid → delivered,
 * failed / refund_owed / unknown payments, idempotent replays, crate draws from the lost pool with the
 * floors and the trade lock, the shared starter-kit cap, the CR pack and the donation titles, and the
 * nightly invariants staying green.
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/idos/shop.test.ts
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { CR, STARTER_KIT, mulberry32 } from "@extract/shared";
import { itemEvents, items, users } from "../../db/schema";
import { closeTestDb, lockTestDb, makeItem, makeUser, openTestDb, resetDb } from "../inventory/test-db";
import { kitsBoughtToday } from "../inventory/starter";
import { checkInvariants } from "../admin/invariants";
import { PARAM, setParam } from "../economy/params";
import { IDOS_SHOP, type PaymentLeg } from "./shop-rules";
import { buyProduct, quoteShop, type BuyDeps } from "./shop";
import type { IdosPlayer, LegProgress, PayOutcome } from "./store-pay";

const { db, pool } = openTestDb();
before(() => lockTestDb(pool));
after(() => closeTestDb(pool));
beforeEach(() => resetDb(db));

const PRICE = { usd: 0.0000036, at: Date.now() };
const PLAYER: IdosPlayer = { titleId: "8YECHSD4", userId: "idos_user_1", ticket: "T".repeat(40) };

/** A fake iDos payment: `outcome` decides; every call is recorded. */
function fakePay(outcome: (legs: readonly PaymentLeg[], done: LegProgress) => PayOutcome = paidAll) {
  const calls: Array<{ orderId: string; legs: readonly PaymentLeg[]; done: LegProgress }> = [];
  const pay = (async (_p: IdosPlayer, orderId: string, legs: readonly PaymentLeg[], done: LegProgress = {}) => {
    calls.push({ orderId, legs, done });
    return outcome(legs, done);
  }) as NonNullable<BuyDeps["pay"]>;
  return { pay, calls };
}

function paidAll(legs: readonly PaymentLeg[]): PayOutcome {
  const progress: LegProgress = {};
  for (const l of legs) progress[l.key] = { debited: l.spoils, ok: true };
  return { status: "paid", paid: legs.reduce((s, l) => s + l.spoils, 0), legs: progress };
}

function deps(pay: NonNullable<BuyDeps["pay"]>, extra: Partial<BuyDeps> = {}): BuyDeps {
  return { price: async () => PRICE, pay, rng: mulberry32(7), ...extra };
}

/** `n` lost-pool items of `rarity`, journaled like real pool entries so the invariants hold. */
async function poolItems(n: number, rarity: number, def = rarity === 0 ? "pistol" : "rifle"): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = await makeItem(db, { def, rarity, state: "lost_pool", ownerId: null });
    await db.insert(itemEvents).values({ itemId: id, toState: "lost_pool", toOwner: null, reason: "seed", refId: "test" });
    ids.push(id);
  }
  return ids;
}

async function orderOf(userId: string) {
  const r = await db.execute<{ status: string; spoils_paid: string; spoils_quoted: string; product: string; detail: Record<string, unknown> }>(
    sql`select * from idos_orders where user_id = ${userId}`,
  );
  return r.rows;
}

async function creditsOf(id: string): Promise<number> {
  const [r] = await db.select({ c: users.credits }).from(users).where(eq(users.id, id));
  return r!.c;
}

describe("crates", () => {
  it("draw one item of the rarity from the lost pool into the stash, trade-locked for 3 raids; a replay delivers nothing new", async () => {
    const u = await makeUser(db);
    const ids = await poolItems(8, 1);
    await poolItems(8, 0);
    const f = fakePay();
    const req = randomUUID();
    const r = await buyProduct(db, u, PLAYER, "crate_rare", req, deps(f.pay));
    assert.equal(r.ok, true, JSON.stringify(r));
    if (!r.ok) return;
    assert.equal(r.status, "delivered");
    assert.ok(r.item && ids.includes(r.item.id));
    assert.equal(r.item!.rarity, 1);
    const [it] = await db.select().from(items).where(eq(items.id, r.item!.id));
    assert.equal(it!.state, "in_stash");
    assert.equal(it!.ownerId, u);
    assert.equal(it!.lockRaids, IDOS_SHOP.CRATE_LOCK_RAIDS);
    const ev = await db.select().from(itemEvents).where(eq(itemEvents.itemId, it!.id));
    assert.ok(ev.some((e) => e.reason === "idos_shop" && e.refId === r.order.id && e.fromState === "lost_pool" && e.toState === "in_stash"));
    const [o] = await orderOf(u);
    assert.equal(o!.status, "delivered");
    assert.equal(Number(o!.spoils_paid), Number(o!.spoils_quoted));
    assert.equal(Number(o!.spoils_quoted) % 1000, 0);

    const again = await buyProduct(db, u, PLAYER, "crate_rare", req, deps(f.pay));
    assert.equal(again.ok && again.replay, true);
    assert.equal(again.ok && again.item?.id, r.item!.id);
    assert.equal(f.calls.length, 1, "a replayed request never pays again");
    const stash = await db.execute<{ n: number }>(sql`select count(*)::int as n from items where owner_id = ${u}`);
    assert.equal(stash.rows[0]!.n, 1);

    const inv = await checkInvariants(db);
    assert.ok(inv.ok, JSON.stringify(inv.checks.filter((c) => c.status !== "ok")));
  });

  it("never take the last 5 of a rarity nor go under the pool floor: sold out, nothing paid", async () => {
    const u = await makeUser(db);
    await poolItems(5, 2, "rifle");
    const f = fakePay();
    const r = await buyProduct(db, u, PLAYER, "crate_epic", randomUUID(), deps(f.pay));
    assert.equal(!r.ok && r.code, "sold_out");
    assert.equal(f.calls.length, 0);
    assert.equal((await orderOf(u)).length, 0);

    await poolItems(10, 0);
    await setParam(db, PARAM.POOL_MIN_RESERVE, 15);
    const floor = await buyProduct(db, u, PLAYER, "crate_common", randomUUID(), deps(f.pay));
    assert.equal(!floor.ok && floor.code, "sold_out", "15 items in the pool, floor 15");
  });

  it("price moves with the pool stock and the day's sales", async () => {
    const u = await makeUser(db);
    await poolItems(10, 0);
    const q1 = (await quoteShop(db, u, PRICE)).products.find((p) => p.id === "crate_common")!;
    assert.equal(q1.usdCents, 8); // 5 × 1.5 (sqrt(40/10) = 2, clamped)
    assert.equal(q1.stock, 10);
    const f = fakePay();
    for (let i = 0; i < 3; i++) assert.equal((await buyProduct(db, u, PLAYER, "crate_common", randomUUID(), deps(f.pay))).ok, true);
    const q2 = (await quoteShop(db, u, PRICE)).products.find((p) => p.id === "crate_common")!;
    assert.equal(q2.stock, 7);
    assert.equal(q2.usdCents, Math.round(5 * 1.5 * 1.06));
  });

  it("the last item gone between payment and delivery: refund_owed, nothing delivered", async () => {
    const u = await makeUser(db);
    const ids = await poolItems(6, 1);
    const f = fakePay((legs) => paidAll(legs));
    const racing: BuyDeps["pay"] = async (p, orderId, legs, done) => {
      // A raid takes one item while iDos is paid: 5 rares left, the crate may not take another.
      await db.update(items).set({ state: "destroyed" }).where(eq(items.id, ids[0]!));
      return f.pay(p, orderId, legs, done);
    };
    const r = await buyProduct(db, u, PLAYER, "crate_rare", randomUUID(), deps(racing));
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, "refund_owed");
    assert.equal(!r.ok && r.code, "sold_out");
    const [o] = await orderOf(u);
    assert.equal(o!.status, "refund_owed");
    assert.ok(Number(o!.spoils_paid) > 0);
    const mine = await db.execute<{ n: number }>(sql`select count(*)::int as n from items where owner_id = ${u}`);
    assert.equal(mine.rows[0]!.n, 0);
  });
});

describe("payments", () => {
  it("a refused payment fails the order and delivers nothing; the same request id answers the same", async () => {
    const u = await makeUser(db);
    const f = fakePay(() => ({ status: "failed", code: "insufficient_spoils", message: "Not enough SPOILS.", paid: 0, legs: {} }));
    const req = randomUUID();
    const r = await buyProduct(db, u, PLAYER, "cr_pack", req, deps(f.pay));
    assert.equal(!r.ok && r.status, "failed");
    assert.equal(!r.ok && r.code, "insufficient_spoils");
    assert.equal(await creditsOf(u), CR.START_BALANCE);
    const again = await buyProduct(db, u, PLAYER, "cr_pack", req, deps(f.pay));
    assert.equal(!again.ok && again.status, "failed");
    assert.equal(f.calls.length, 1);
  });

  it("a mismatched debit is never delivered", async () => {
    const u = await makeUser(db);
    const f = fakePay(() => ({ status: "failed", code: "debit_mismatch", message: "iDos did not take the expected amount.", paid: 0, legs: { "1k": { debited: 0, ok: false } } }));
    const r = await buyProduct(db, u, PLAYER, "supporter", randomUUID(), deps(f.pay));
    assert.equal(!r.ok && r.code, "debit_mismatch");
    const t = await db.execute(sql`select 1 from pass_unlocks where user_id = ${u}`);
    assert.equal(t.rows.length, 0);
  });

  it("part paid then refused: refund_owed with the paid amount on record", async () => {
    const u = await makeUser(db);
    const f = fakePay(() => ({ status: "refund_owed", code: "insufficient_spoils", message: "Not enough SPOILS.", paid: 100_000, legs: { "100k": { debited: 100_000, ok: true } } }));
    const r = await buyProduct(db, u, PLAYER, "patron", randomUUID(), deps(f.pay));
    assert.equal(!r.ok && r.status, "refund_owed");
    assert.match(!r.ok ? r.message : "", /100,000 SPOILS were taken and will be refunded/);
    const [o] = await orderOf(u);
    assert.equal(o!.status, "refund_owed");
    assert.equal(Number(o!.spoils_paid), 100_000);
  });

  it("no answer from iDos: the order stays pending, and a retry continues it from the paid legs", async () => {
    const u = await makeUser(db);
    let first = true;
    const f = fakePay((legs, done) => {
      if (first) {
        first = false;
        return { status: "unknown", paid: 0, legs: done, message: "iDos did not answer." };
      }
      return paidAll(legs);
    });
    const req = randomUUID();
    const r1 = await buyProduct(db, u, PLAYER, "cr_pack", req, deps(f.pay));
    assert.equal(!r1.ok && r1.status, "pending");
    assert.equal(!r1.ok && r1.code, "idos_unavailable");
    assert.equal((await orderOf(u))[0]!.status, "pending");
    const r2 = await buyProduct(db, u, PLAYER, "cr_pack", req, deps(f.pay, { price: async () => null }));
    assert.equal(r2.ok && r2.status, "delivered", "a retry pays the stored quote, it needs no fresh price");
    assert.equal(f.calls[0]!.orderId, f.calls[1]!.orderId);
    assert.equal(await creditsOf(u), CR.START_BALANCE + IDOS_SHOP.CR_PACK_CR);
  });

  it("no token price: nothing is sold", async () => {
    const u = await makeUser(db);
    const f = fakePay();
    const r = await buyProduct(db, u, PLAYER, "cr_pack", randomUUID(), deps(f.pay, { price: async () => null }));
    assert.equal(!r.ok && r.code, "no_price");
    assert.equal(f.calls.length, 0);
  });

  it("refuses unknown products, bad request ids and a request id reused for another product", async () => {
    const u = await makeUser(db);
    const f = fakePay();
    assert.equal((await buyProduct(db, u, PLAYER, "crate_legendary", randomUUID(), deps(f.pay))).ok, false);
    const bad = await buyProduct(db, u, PLAYER, "cr_pack", "not-a-uuid", deps(f.pay));
    assert.equal(!bad.ok && bad.code, "bad_request");
    const req = randomUUID();
    assert.equal((await buyProduct(db, u, PLAYER, "cr_pack", req, deps(f.pay))).ok, true);
    const reused = await buyProduct(db, u, PLAYER, "supporter", req, deps(f.pay));
    assert.equal(!reused.ok && reused.code, "bad_request");
  });
});

describe("fixed products", () => {
  it("starter kit: the main build's kit, sharing its daily cap", async () => {
    const u = await makeUser(db);
    const f = fakePay();
    for (let i = 0; i < STARTER_KIT.DAILY_MAX; i++) {
      const r = await buyProduct(db, u, PLAYER, "starter_kit", randomUUID(), deps(f.pay));
      assert.equal(r.ok, true, JSON.stringify(r));
    }
    assert.equal(await kitsBoughtToday(db, u), STARTER_KIT.DAILY_MAX);
    const capped = await buyProduct(db, u, PLAYER, "starter_kit", randomUUID(), deps(f.pay));
    assert.equal(!capped.ok && capped.code, "daily_limit");
    assert.equal(f.calls.length, STARTER_KIT.DAILY_MAX, "the capped buy is refused before paying");
    const kitItems = await db.execute<{ n: number }>(sql`select count(*)::int as n from items where owner_id = ${u} and origin = 'giveaway'`);
    assert.ok(kitItems.rows[0]!.n >= STARTER_KIT.DAILY_MAX * 2);
    const inv = await checkInvariants(db);
    assert.ok(inv.ok, JSON.stringify(inv.checks.filter((c) => c.status !== "ok")));
  });

  it("CR pack: +2 000 CR through the credit ledger, 5 a day", async () => {
    const u = await makeUser(db);
    const f = fakePay();
    for (let i = 0; i < IDOS_SHOP.CR_PACK_DAILY_MAX; i++) assert.equal((await buyProduct(db, u, PLAYER, "cr_pack", randomUUID(), deps(f.pay))).ok, true);
    assert.equal(await creditsOf(u), CR.START_BALANCE + IDOS_SHOP.CR_PACK_DAILY_MAX * IDOS_SHOP.CR_PACK_CR);
    const rows = await db.execute<{ n: number }>(sql`select count(*)::int as n from credit_ledger where user_id = ${u} and reason = 'idos_shop'`);
    assert.equal(rows.rows[0]!.n, IDOS_SHOP.CR_PACK_DAILY_MAX);
    const capped = await buyProduct(db, u, PLAYER, "cr_pack", randomUUID(), deps(f.pay));
    assert.equal(!capped.ok && capped.code, "daily_limit");
    const inv = await checkInvariants(db);
    assert.ok(inv.ok, JSON.stringify(inv.checks.filter((c) => c.status !== "ok")));
  });

  it("donations grant their title once; buying again just records the donation", async () => {
    const u = await makeUser(db);
    const f = fakePay();
    const a = await buyProduct(db, u, PLAYER, "supporter", randomUUID(), deps(f.pay));
    const b = await buyProduct(db, u, PLAYER, "supporter", randomUUID(), deps(f.pay));
    const c = await buyProduct(db, u, PLAYER, "patron", randomUUID(), deps(f.pay));
    assert.equal(a.ok && b.ok && c.ok, true);
    assert.match(a.ok ? a.message : "", /Supporter title is yours/);
    assert.match(b.ok ? b.message : "", /Thank you for supporting/);
    const t = await db.execute<{ reward_id: string; source: string }>(sql`select reward_id, source from pass_unlocks where user_id = ${u} order by reward_id`);
    assert.deepEqual(t.rows, [
      { reward_id: "patron", source: "donation" },
      { reward_id: "supporter", source: "donation" },
    ]);
    assert.equal((await orderOf(u)).filter((o) => o.status === "delivered").length, 3);
  });
});
