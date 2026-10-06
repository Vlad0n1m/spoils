/**
 * Seeker perk DB flow against the isolated test database (lib/inventory/test-db.ts): cache per wallet,
 * refresh, RPC failures, the SGT moving between wallets, the one-time frame claim (once per mint and
 * per account) and the badge in party / leaderboard queries. The chain is a fake checker.
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/seeker/seeker.test.ts
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { SEEKER_FRAME } from "@extract/shared";
import { users } from "../../db/schema";
import { eq } from "drizzle-orm";
import { closeTestDb, lockTestDb, makeUser, openTestDb, resetDb } from "../inventory/test-db";
import { cosmeticBadges } from "../quests/quests";
import { SEEKER, claimSeekerFrame, getSeekerStatus, type SgtChecker } from "./seeker";

const { db, pool } = openTestDb();
before(() => lockTestDb(pool));
after(() => closeTestDb(pool));
beforeEach(async () => {
  await resetDb(db);
  await db.execute(sql`truncate table seeker_checks, seeker_claims, pass_unlocks`);
});

const T0 = new Date("2026-10-06T12:00:00Z");
const at = (msLater: number) => new Date(T0.getTime() + msLater);
const MINT = "5mXbkqKz883aufhAsx3p5Z1NcvD2ppZbdTTznM6oUKLj";
const W1 = "57AoY689EJ8rhaHWG8Rpfn6UmGrRRrBnbzHeVJAgDVLL";
const W2 = "GkTtEynos5M6f3kPExgq5UBDSvbGkXgYL9mFRwgSoffn";

/** A fake chain: wallet → mint; counts the calls. */
function chain(holdings: Record<string, string | null>) {
  const c = { calls: 0, fail: false };
  const check: SgtChecker = async (w) => {
    c.calls++;
    if (c.fail) throw new Error("429 Too many requests");
    return holdings[w] ?? null;
  };
  return Object.assign(c, { check, holdings });
}

async function userWithWallet(wallet: string | null, nick?: string): Promise<string> {
  const id = await makeUser(db, nick);
  if (wallet) await db.update(users).set({ walletPubkey: wallet, walletLinkedAt: T0 }).where(eq(users.id, id));
  return id;
}

describe("getSeekerStatus", () => {
  it("no linked wallet: nothing to check", async () => {
    const u = await userWithWallet(null);
    const ch = chain({});
    const s = await getSeekerStatus(db, u, { check: ch.check, now: T0 });
    assert.equal(s.wallet, null);
    assert.equal(s.verified, false);
    assert.equal(s.claimable, false);
    assert.equal(s.reward, SEEKER_FRAME);
    assert.equal(ch.calls, 0);
  });

  it("verifies a holder and caches the answer for hours", async () => {
    const u = await userWithWallet(W1);
    const ch = chain({ [W1]: MINT });
    const s = await getSeekerStatus(db, u, { check: ch.check, now: T0 });
    assert.equal(s.verified, true);
    assert.equal(s.mint, MINT);
    assert.equal(s.claimable, true);
    assert.equal(s.checkedAt, T0.toISOString());
    await getSeekerStatus(db, u, { check: ch.check, now: at(SEEKER.CACHE_MS - 1) });
    assert.equal(ch.calls, 1, "cached");
    await getSeekerStatus(db, u, { check: ch.check, now: at(SEEKER.CACHE_MS) });
    assert.equal(ch.calls, 2, "stale → checked again");
  });

  it("refresh re-checks only when the last check is over a minute old", async () => {
    const u = await userWithWallet(W1);
    const ch = chain({});
    assert.equal((await getSeekerStatus(db, u, { check: ch.check, now: T0 })).verified, false);
    ch.holdings[W1] = MINT;
    assert.equal((await getSeekerStatus(db, u, { check: ch.check, now: at(10_000), refresh: true })).verified, false);
    assert.equal(ch.calls, 1);
    assert.equal((await getSeekerStatus(db, u, { check: ch.check, now: at(SEEKER.REFRESH_MIN_MS), refresh: true })).verified, true);
    assert.equal(ch.calls, 2);
  });

  it("an RPC failure is not cached as 'no SGT' and keeps the previous answer", async () => {
    const u = await userWithWallet(W1);
    const ch = chain({ [W1]: MINT });
    ch.fail = true;
    const first = await getSeekerStatus(db, u, { check: ch.check, now: T0 });
    assert.equal(first.unavailable, true);
    assert.equal(first.verified, false);
    assert.equal(first.checkedAt, null);
    ch.fail = false;
    assert.equal((await getSeekerStatus(db, u, { check: ch.check, now: at(1) })).verified, true, "nothing was cached");
    ch.fail = true;
    const later = await getSeekerStatus(db, u, { check: ch.check, now: at(SEEKER.CACHE_MS + 1) });
    assert.equal(later.unavailable, true);
    assert.equal(later.verified, true, "previous answer kept");
  });

  it("an SGT that moved to another wallet leaves the old one at once", async () => {
    const a = await userWithWallet(W1, "seekera");
    const b = await userWithWallet(W2, "seekerb");
    const ch = chain({ [W1]: MINT });
    assert.equal((await getSeekerStatus(db, a, { check: ch.check, now: T0 })).verified, true);
    ch.holdings[W1] = null;
    ch.holdings[W2] = MINT;
    assert.equal((await getSeekerStatus(db, b, { check: ch.check, now: at(1) })).verified, true);
    // a's cache is still fresh, but the mint now sits on W2.
    assert.equal((await getSeekerStatus(db, a, { check: ch.check, now: at(2) })).verified, false);
    const badges = await cosmeticBadges(db, ["seekera", "seekerb"]);
    assert.equal(badges.seekera?.seeker, undefined);
    assert.equal(badges.seekerb?.seeker, true);
  });
});

describe("claimSeekerFrame", () => {
  it("grants the frame once, as a 'seeker' pass unlock", async () => {
    const u = await userWithWallet(W1);
    const ch = chain({ [W1]: MINT });
    const r = await claimSeekerFrame(db, u, { check: ch.check, now: T0 });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.status.claimed, true);
      assert.equal(r.status.claimable, false);
    }
    const rows = await db.execute<{ reward_id: string; source: string }>(sql`select reward_id, source from pass_unlocks where user_id = ${u}`);
    assert.deepEqual(rows.rows, [{ reward_id: SEEKER_FRAME, source: "seeker" }]);
    assert.deepEqual(await claimSeekerFrame(db, u, { check: ch.check, now: at(1) }), { ok: false, error: "already_claimed" });
    const s = await getSeekerStatus(db, u, { check: ch.check, now: at(2) });
    assert.equal(s.claimed, true);
  });

  it("refuses without a wallet, without an SGT, and when the chain is down", async () => {
    const none = await userWithWallet(null);
    assert.deepEqual(await claimSeekerFrame(db, none, { check: chain({}).check, now: T0 }), { ok: false, error: "no_wallet" });
    const plain = await userWithWallet(W2);
    assert.deepEqual(await claimSeekerFrame(db, plain, { check: chain({}).check, now: T0 }), { ok: false, error: "not_verified" });
    const down = await userWithWallet(W1);
    const ch = chain({ [W1]: MINT });
    ch.fail = true;
    assert.deepEqual(await claimSeekerFrame(db, down, { check: ch.check, now: T0 }), { ok: false, error: "unavailable" });
  });

  it("one claim per SGT mint: moving the SGT to another account's wallet cannot claim again", async () => {
    const a = await userWithWallet(W1);
    const ch = chain({ [W1]: MINT });
    assert.equal((await claimSeekerFrame(db, a, { check: ch.check, now: T0 })).ok, true);
    // The player moves the SGT to a wallet linked to a second account.
    ch.holdings[W1] = null;
    ch.holdings[W2] = MINT;
    const b = await userWithWallet(W2);
    const s = await getSeekerStatus(db, b, { check: ch.check, now: at(1) });
    assert.equal(s.verified, true, "the badge follows the SGT");
    assert.equal(s.claimable, false);
    assert.deepEqual(await claimSeekerFrame(db, b, { check: ch.check, now: at(2) }), { ok: false, error: "mint_used" });
    const n = await db.execute<{ n: number }>(sql`select count(*)::int as n from pass_unlocks where user_id = ${b}`);
    assert.equal(n.rows[0]!.n, 0);
  });

  it("a claim survives unlinking; the badge does not", async () => {
    const u = await userWithWallet(W1, "seekerc");
    const ch = chain({ [W1]: MINT });
    await claimSeekerFrame(db, u, { check: ch.check, now: T0 });
    assert.equal((await cosmeticBadges(db, ["seekerc"])).seekerc?.seeker, true);
    await db.update(users).set({ walletPubkey: null, walletLinkedAt: null }).where(eq(users.id, u));
    const s = await getSeekerStatus(db, u, { check: ch.check, now: at(1) });
    assert.equal(s.verified, false);
    assert.equal(s.claimed, true);
    assert.equal((await cosmeticBadges(db, ["seekerc"])).seekerc, undefined);
  });
});
