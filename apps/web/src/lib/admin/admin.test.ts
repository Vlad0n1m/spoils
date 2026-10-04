/**
 * Admin panel against the isolated `extract_test` database (see lib/inventory/test-db.ts): the guard
 * (anyone but a signed-in users.role = 'admin' gets 404, revocation is immediate), the stop-cranes
 * (range, stale value, audit row) and the 7-day metric aggregations on seeded rows, plus the pure
 * KPI rules and a structural check that every /admin page and /api/admin route calls the guard.
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/admin/admin.test.ts
 */
process.env.DATABASE_URL ??= "postgresql://localhost:5432/extract_test";

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { worldCycleAt, type PlayerExitReport } from "@extract/shared";
import {
  adminAudit,
  creditLedger,
  economyParams,
  listings,
  moneyLedger,
  pvpKills,
  raidEntries,
  raidExits,
  raids,
  trades,
  users,
} from "../../db/schema";
import { PARAM, getNumberParam } from "../economy/params";
import { closeTestDb, lockTestDb, makeItem, makeUser, openTestDb, resetDb } from "../inventory/test-db";
import { adminNotFound, findAdmin, withAdmin } from "./guard";
import { adminMetrics, buildKpis, type KpiInputs } from "./metrics";
import { EDITABLE_PARAMS, listAudit, parseParamSetBody, readAdminParams, setAdminParam } from "./params";
import type { AdminUser } from "./types";

const { db, pool } = openTestDb();
const here = dirname(fileURLToPath(import.meta.url));
const webSrc = join(here, "..", "..");

before(async () => {
  await lockTestDb(pool);
});
after(async () => {
  await closeTestDb(pool);
});
beforeEach(async () => {
  await resetDb(db);
  await db.execute(sql`truncate table admin_audit restart identity`);
});

async function makeAdmin(nick = `adm${randomUUID().slice(0, 6)}`): Promise<AdminUser> {
  const id = await makeUser(db, nick);
  await db.execute(sql`update users set role = 'admin' where id = ${id}`);
  return { id, nickname: nick };
}

// ------------------------------------------------------------------------------------ guard

describe("admin guard", () => {
  test("only a signed-in registered user with role 'admin' passes; revoking works at once", async () => {
    const admin = await makeAdmin("boss");
    const plain = await makeUser(db, "plain");
    assert.equal(await findAdmin(db, null), null);
    assert.equal(await findAdmin(db, {}), null);
    assert.equal(await findAdmin(db, { userId: "not-a-uuid", nickname: "x" }), null);
    assert.equal(await findAdmin(db, { userId: randomUUID(), nickname: "ghost" }), null, "unknown user");
    assert.equal(await findAdmin(db, { userId: plain, nickname: "plain" }), null, "no role");
    assert.equal(await findAdmin(db, { userId: admin.id, nickname: "boss", guest: true }), null, "guest flag never passes");
    assert.deepEqual(await findAdmin(db, { userId: admin.id, nickname: "whatever" }), admin, "nickname comes from the DB");
    // the session nickname is not trusted, the role is re-read every request
    await db.execute(sql`update users set role = null where id = ${admin.id}`);
    assert.equal(await findAdmin(db, { userId: admin.id, nickname: "boss" }), null);
  });

  test("users.role accepts only NULL or 'admin'", async () => {
    const id = await makeUser(db, "typo");
    await assert.rejects(db.execute(sql`update users set role = 'Admin' where id = ${id}`), /users_role_known/);
    await assert.rejects(db.execute(sql`update users set role = 'moderator' where id = ${id}`), /users_role_known/);
  });

  test("withAdmin: 404 without calling the handler for non-admins; the handler runs for admins", async () => {
    const admin = await makeAdmin("chief");
    const plain = await makeUser(db, "visitor");
    let calls = 0;
    const handler = async (a: AdminUser) => {
      calls++;
      return new Response(JSON.stringify({ hi: a.nickname }), { status: 200 });
    };
    for (const s of [null, {}, { userId: plain, nickname: "visitor" }, { userId: admin.id, guest: true }]) {
      const res = await withAdmin(async () => s, db, handler);
      assert.equal(res.status, 404);
      assert.deepEqual(await res.json(), { error: "not_found" });
      assert.equal(res.headers.get("cache-control"), "no-store");
    }
    assert.equal(calls, 0);

    const ok = await withAdmin(async () => ({ userId: admin.id, nickname: "chief" }), db, handler);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { hi: "chief" });
    assert.equal(calls, 1);

    const broken = await withAdmin(async () => {
      throw new Error("cookie");
    }, db, handler);
    assert.equal(broken.status, 404, "a session error is a 404 too");
    const failing = await withAdmin(async () => ({ userId: admin.id }), db, async () => {
      throw new Error("boom");
    });
    assert.equal(failing.status, 500);
    assert.equal(adminNotFound().status, 404);
  });

  test("every /admin page and /api/admin route calls the guard", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/^(page|layout)\.tsx$|^route\.ts$/.test(f)) files.push(p);
      }
    };
    walk(join(webSrc, "app", "admin"));
    walk(join(webSrc, "app", "api", "admin"));
    assert.ok(files.length >= 6, `found ${files.length} admin files`);
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (f.endsWith("route.ts")) {
        const handlers = [...src.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b[\s\S]*?\n}/g)];
        assert.ok(handlers.length > 0, `${f}: no handlers`);
        // The game server's replay ingest is the one server-to-server route here: HMAC-signed, no session.
        const guard = /[\\/]replays[\\/]ingest[\\/]route\.ts$/.test(f) ? /handleReplayIngest\(/ : /adminRoute\(|withAdmin\(/;
        for (const h of handlers) assert.match(h[0], guard, `${f} ${h[1]} must be wrapped in adminRoute`);
      } else {
        assert.match(src, /await requireAdminPage\(\)/, `${f} must call requireAdminPage()`);
      }
    }
  });
});

// ------------------------------------------------------------------------------ stop-cranes

describe("admin params", () => {
  test("defaults match lib/economy/params.ts; read-only rows carry notes", async () => {
    for (const s of EDITABLE_PARAMS) assert.equal(s.def, await getNumberParam(db, s.key), s.key);
    await db.insert(economyParams).values([
      { key: PARAM.TAX_ACC, value: 0.5 },
      { key: PARAM.POOL_MAX_PER_MATCH, value: 8 },
      { key: "gs_boot:alpha", value: { serverId: "alpha" } },
    ]);
    const dto = await readAdminParams(db);
    assert.deepEqual(
      dto.params.map((p) => [p.key, p.value, p.stored]),
      EDITABLE_PARAMS.map((s) => [s.key, s.def, false]),
    );
    assert.deepEqual(dto.readOnly.map((r) => r.key).sort(), ["gs_boot:alpha", "pool_max_per_match", "pool_min_reserve", "tax_acc"]);
    assert.ok(dto.readOnly.every((r) => r.note.length > 0));
    assert.match(dto.readOnly.find((r) => r.key === "pool_max_per_match")!.note, /World v6 не читается/);
    for (const s of EDITABLE_PARAMS) for (const q of s.quick) assert.ok(q.value >= s.min && q.value <= s.max, `${s.key} quick ${q.value}`);
  });

  test("body parsing", () => {
    assert.equal(parseParamSetBody(null), null);
    assert.equal(parseParamSetBody({ key: "autosell_mult", value: "1.1", expected: 1 }), null);
    assert.equal(parseParamSetBody({ key: "autosell_mult", value: 1.1 }), null);
    assert.equal(parseParamSetBody({ key: "autosell_mult", value: Number.NaN, expected: 1 }), null);
    assert.equal(parseParamSetBody({ key: 5, value: 1, expected: 1 }), null);
    assert.deepEqual(parseParamSetBody({ key: "pool_risk_k", value: 1.25, expected: 1, note: "  pool swells  " }), {
      key: "pool_risk_k",
      value: 1.25,
      expected: 1,
      note: "pool swells",
    });
  });

  test("a change needs the right range and the value the admin saw, and leaves an audit row", async () => {
    const admin = await makeAdmin("vlad");
    assert.deepEqual(await setAdminParam(db, admin, { key: PARAM.TAX_ACC, value: 0, expected: 0 }), {
      ok: false,
      error: "unknown_param",
      message: "Этот параметр нельзя менять из админки.",
    });
    const high = await setAdminParam(db, admin, { key: PARAM.AUTOSELL_MULT, value: 1.5, expected: 1 });
    assert.equal(high.ok, false);
    assert.equal(!high.ok && high.error, "out_of_range");
    const neg = await setAdminParam(db, admin, { key: PARAM.POOL_RISK_K, value: -0.1, expected: 1 });
    assert.equal(!neg.ok && neg.error, "out_of_range");
    const stale = await setAdminParam(db, admin, { key: PARAM.AUTOSELL_MULT, value: 0.9, expected: 0.8 });
    assert.equal(!stale.ok && stale.error, "stale");
    assert.equal(!stale.ok && stale.current, 1);
    assert.equal((await listAudit(db)).length, 0, "refusals write nothing");

    const at = new Date("2026-10-04T10:00:00Z");
    const r = await setAdminParam(db, admin, { key: PARAM.AUTOSELL_MULT, value: 0.912345, expected: 1, note: "too many CR" }, at);
    assert.ok(r.ok);
    assert.equal(r.param.value, 0.9123, "rounded to 4 decimals like the regulator");
    assert.equal(r.param.stored, true);
    assert.equal(await getNumberParam(db, PARAM.AUTOSELL_MULT), 0.9123, "settlement reads the new value");
    assert.deepEqual(
      { admin: r.audit.admin, action: r.audit.action, target: r.audit.target, old: r.audit.oldValue, new: r.audit.newValue, note: r.audit.note, at: r.audit.at },
      { admin: "vlad", action: "param_set", target: "autosell_mult", old: 1, new: 0.9123, note: "too many CR", at: at.getTime() },
    );

    // stop the pool's entry release, then a second change against the new value
    const stop = await setAdminParam(db, admin, { key: PARAM.POOL_RISK_K, value: 0, expected: 1 }, new Date("2026-10-04T11:00:00Z"));
    assert.ok(stop.ok);
    assert.equal(await getNumberParam(db, PARAM.POOL_RISK_K), 0);
    const again = await setAdminParam(db, admin, { key: PARAM.AUTOSELL_MULT, value: 1, expected: 0.9123 }, new Date("2026-10-04T12:00:00Z"));
    assert.ok(again.ok);
    const audit = await listAudit(db);
    assert.deepEqual(
      audit.map((a) => [a.target, a.oldValue, a.newValue]),
      [
        ["autosell_mult", 0.9123, 1],
        ["pool_risk_k", 1, 0],
        ["autosell_mult", 1, 0.9123],
      ],
      "newest first",
    );
    const rows = await db.select().from(adminAudit);
    assert.ok(rows.every((x) => x.adminId === admin.id && x.adminNickname === "vlad"));
    const dto = await readAdminParams(db);
    assert.equal(dto.params.find((p) => p.key === PARAM.POOL_RISK_K)!.value, 0);
    assert.equal(dto.audit.length, 3);
  });
});

// ---------------------------------------------------------------------------------- metrics

const NOW = new Date("2026-10-04T15:00:00Z");
const T = (iso: string) => new Date(iso);
const cycleOf = (d: Date) => worldCycleAt(d.getTime()).cycle;

async function mkUser(nick: string, createdAt: string, credits = 1000): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ email: `${nick}@test.local`, passwordHash: "x", nickname: nick, depositAddress: `dep-${nick}`, createdAt: T(createdAt), credits })
    .returning({ id: users.id });
  return u!.id;
}

async function mkRaid(cycle: number, shard: number, status: "running" | "settled" = "running"): Promise<string> {
  const matchId = randomUUID();
  await db.insert(raids).values({
    matchId,
    mode: "live",
    mapId: "steppe",
    matchSeed: 1,
    status,
    kind: "world",
    cycleId: cycle,
    shard,
    endsAt: NOW,
  });
  return matchId;
}

async function mkEntry(v: { userId: string; matchId: string; at: string; status?: "active" | "exited"; guest?: boolean; gear?: boolean; cycle?: number }) {
  const at = T(v.at);
  await db.insert(raidEntries).values({
    entryId: randomUUID(),
    matchId: v.matchId,
    cycleId: v.cycle ?? cycleOf(at),
    userId: v.userId,
    guest: v.guest ?? false,
    freeKit: !v.gear,
    status: v.status ?? "exited",
    createdAt: at,
  });
}

async function mkExit(userId: string, exit: "extract" | "dead" | "mia", at: string, credits = 0, guest = false) {
  await db.insert(raidExits).values({
    entryId: randomUUID(),
    matchId: randomUUID(),
    userId,
    exit,
    report: {} as PlayerExitReport,
    credits,
    guest,
    at: T(at),
  });
}

async function mkTrade(template: string, price: number, at: string, counted = true) {
  const itemId = await makeItem(db, { def: "pistol", state: "in_stash" });
  const [l] = await db
    .insert(listings)
    .values({ itemId, template, priceMinor: BigInt(price), status: "sold", expiresAt: NOW })
    .returning({ id: listings.id });
  await db.insert(trades).values({
    listingId: l!.id,
    itemId,
    template,
    rarity: 0,
    durability: 100,
    buyerId: randomUUID(),
    priceMinor: BigInt(price),
    feeMinor: 0n,
    countedForIndex: counted,
    at: T(at),
  });
}

describe("admin metrics", () => {
  test("7-day aggregations: online, days, CR, treasury, items and the §4 KPIs", async () => {
    const A = await mkUser("veteran", "2026-09-20T10:00:00Z", 3000);
    const B = await mkUser("newbie_b", "2026-10-01T10:00:00Z");
    const C = await mkUser("newbie_c", "2026-10-02T09:00:00Z");
    const D = await mkUser("newbie_d", "2026-10-03T12:00:00Z");
    const G = randomUUID(); // guest: no users row

    const wc = cycleOf(NOW);
    const M0 = await mkRaid(wc, 0);
    const M1 = await mkRaid(wc, 1);
    await mkRaid(wc - 1, 0, "settled");
    const Mold = await mkRaid(wc - 11, 0, "settled");

    // on the map now: A (gear) + guest on shard 0, B on shard 1; C stuck on an old map
    await mkEntry({ userId: A, matchId: M0, at: "2026-10-04T14:50:00Z", status: "active", gear: true, cycle: wc });
    await mkEntry({ userId: G, matchId: M0, at: "2026-10-04T14:52:00Z", status: "active", guest: true, cycle: wc });
    await mkEntry({ userId: B, matchId: M1, at: "2026-10-04T14:55:00Z", status: "active", cycle: wc });
    await mkEntry({ userId: C, matchId: Mold, at: "2026-10-04T07:00:00Z", status: "active" });
    // earlier entries: B comes back the day after registering (D1), A with gear; D yesterday; one before the window
    await mkEntry({ userId: B, matchId: randomUUID(), at: "2026-10-02T05:00:00Z" });
    await mkEntry({ userId: A, matchId: randomUUID(), at: "2026-10-02T06:00:00Z", gear: true });
    await mkEntry({ userId: D, matchId: randomUUID(), at: "2026-10-03T13:00:00Z" });
    await mkEntry({ userId: A, matchId: randomUUID(), at: "2026-09-25T06:00:00Z" });

    await mkExit(B, "dead", "2026-10-02T05:30:00Z");
    await mkExit(B, "extract", "2026-10-02T06:30:00Z", 400);
    await mkExit(A, "extract", "2026-10-02T07:00:00Z", 500);
    await mkExit(D, "dead", "2026-10-03T14:00:00Z");
    await mkExit(D, "dead", "2026-10-03T14:20:00Z");
    await mkExit(D, "dead", "2026-10-03T14:40:00Z");
    await mkExit(C, "mia", "2026-10-04T08:00:00Z");
    await mkExit(G, "extract", "2026-10-04T09:00:00Z", 300, true);
    await mkExit(A, "extract", "2026-09-25T07:00:00Z", 999); // before the window

    await db.insert(pvpKills).values([
      { killerId: A, victimId: D, matchId: randomUUID(), entryId: randomUUID(), ranked: true, at: T("2026-10-03T14:00:00Z") },
      { killerId: A, victimId: D, matchId: randomUUID(), entryId: randomUUID(), ranked: false, at: T("2026-10-03T14:20:00Z") },
      { killerId: B, victimId: A, matchId: randomUUID(), entryId: randomUUID(), ranked: true, at: T("2026-10-04T10:00:00Z") },
      { killerId: B, victimId: A, matchId: randomUUID(), entryId: randomUUID(), ranked: true, at: T("2026-09-20T10:00:00Z") },
    ]);

    await db.insert(creditLedger).values([
      { userId: A, delta: 500, reason: "autosell", refId: "x3", balanceAfter: 1500, at: T("2026-10-02T07:00:00Z") },
      { userId: B, delta: 400, reason: "autosell", refId: "x2", balanceAfter: 1400, at: T("2026-10-02T06:30:00Z") },
      { userId: B, delta: 100, reason: "giveaway", refId: "g", balanceAfter: 1500, at: T("2026-10-03T08:00:00Z") },
      { userId: A, delta: -200, reason: "consumables", refId: "c", balanceAfter: 1300, at: T("2026-10-04T09:00:00Z") },
      { userId: B, delta: -50, reason: "listing_fee", refId: "l", balanceAfter: 1450, at: T("2026-10-04T10:00:00Z") },
      { userId: A, delta: 1000, reason: "admin", refId: "old", balanceAfter: 2000, at: T("2026-09-20T10:00:00Z") },
    ]);

    await db.insert(moneyLedger).values([
      { account: "house", deltaMinor: 25n, reason: "fee", refId: "l1", at: T("2026-10-04T11:00:00Z") },
      { account: "house", deltaMinor: 300n, reason: "treasury_sale", refId: "l2", at: T("2026-10-03T11:00:00Z") },
      { account: "house", deltaMinor: 500n, reason: "kit_sale", refId: B, at: T("2026-10-04T12:00:00Z") },
      { account: "house", deltaMinor: 10n, reason: "fee", refId: "l0", at: T("2026-09-01T11:00:00Z") },
      { account: B, deltaMinor: 275n, reason: "sale", refId: "l1", at: T("2026-10-04T11:00:00Z") },
    ]);

    await makeItem(db, { def: "pistol", state: "in_stash", ownerId: A });
    await makeItem(db, { def: "pistol", state: "in_stash", ownerId: A });
    await makeItem(db, { def: "pistol", state: "in_stash", ownerId: A, bound: true });
    await makeItem(db, { def: "pistol", state: "listed", ownerId: B });
    await makeItem(db, { def: "pistol", state: "lost_pool" });
    await makeItem(db, { def: "pistol", state: "treasury" });
    await makeItem(db, { def: "pistol", state: "destroyed" });

    // prices: rifle trades at 1000 through the week, at 600 today → −40%; thin / excluded templates ignored
    for (const d of ["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]) await mkTrade("rifle:1", 1000, `${d}T12:00:00Z`);
    await mkTrade("rifle:1", 600, "2026-10-04T10:00:00Z");
    await mkTrade("rifle:1", 600, "2026-10-04T11:00:00Z");
    await mkTrade("rifle:1", 50, "2026-10-04T12:00:00Z", false); // not counted for the index
    await mkTrade("smg:0", 400, "2026-10-04T12:00:00Z");
    // the trades above added 8 ownerless in_stash pistols (their listings): item states below include them
    const m = await adminMetrics(db, { now: NOW, worldNowMs: NOW.getTime() });

    assert.equal(m.since, Date.parse("2026-09-28T00:00:00Z"));
    assert.deepEqual(m.online.shards, [
      { shard: 0, matchId: M0, registered: 1, guests: 1 },
      { shard: 1, matchId: M1, registered: 1, guests: 0 },
    ]);
    assert.deepEqual([m.online.total, m.online.registered, m.online.guests, m.online.staleActive], [3, 2, 1, 1]);
    assert.equal(m.online.cycle, wc);

    assert.deepEqual(m.days.map((d) => d.day), ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
    const day = (k: string) => m.days.find((d) => d.day === k)!;
    assert.deepEqual(
      m.days.map((d) => [d.entries, d.entriesGuest, d.entriesGear]),
      [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [2, 0, 1], [1, 0, 0], [4, 1, 1]],
    );
    assert.deepEqual(day("2026-10-02").exits, { extract: 2, dead: 1, mia: 0, timeout: 0 });
    assert.deepEqual(day("2026-10-03").exits, { extract: 0, dead: 3, mia: 0, timeout: 0 });
    assert.deepEqual(day("2026-10-04").exits, { extract: 1, dead: 0, mia: 1, timeout: 0 });
    assert.equal(day("2026-10-03").deaths, 3);
    assert.deepEqual([day("2026-10-03").pvpKills, day("2026-10-03").pvpRanked, day("2026-10-04").pvpKills], [2, 1, 1]);
    assert.deepEqual(
      m.days.map((d) => [d.crIn, d.crOut]),
      [[0, 0], [0, 0], [0, 0], [0, 0], [900, 0], [100, 0], [0, 250]],
    );
    assert.deepEqual(m.days.map((d) => d.houseMinor), ["0", "0", "0", "0", "0", "300", "525"]);

    assert.deepEqual([m.credits.in7d, m.credits.out7d], [1000, 250]);
    assert.deepEqual(
      m.credits.byReason.map((r) => [r.reason, r.in7d, r.out7d, r.inToday, r.outToday]),
      [
        ["autosell", 900, 0, 0, 0],
        ["consumables", 0, 200, 0, 200],
        ["giveaway", 100, 0, 0, 0],
        ["listing_fee", 0, 50, 0, 50],
      ],
      "the pre-window admin credit is out",
    );

    assert.deepEqual(
      Object.fromEntries(m.house.byReason.map((r) => [r.reason, [r.today, r.d7, r.all]])),
      { kit_sale: ["500", "500", "500"], treasury_sale: ["0", "300", "300"], fee: ["25", "25", "35"] },
    );
    assert.deepEqual([m.house.d7, m.house.all], ["825", "835"]);

    assert.deepEqual(Object.fromEntries(m.items.byState.map((s) => [s.state, s.n])), {
      in_stash: 3 + 8,
      listed: 1,
      lost_pool: 1,
      treasury: 1,
      destroyed: 1,
    });

    const k = Object.fromEntries(m.kpis.map((x) => [x.id, x]));
    assert.deepEqual([k.cr_ratio!.value, k.cr_ratio!.status], ["4.00", "warn"], "1000 / 250; no three-day alarm without sinks");
    assert.deepEqual([k.cr_per_entry!.value, k.cr_per_entry!.status], ["129", "alarm"], "900 CR over 7 registered exits");
    assert.deepEqual([k.tradable_per_player!.value, k.tradable_per_player!.status], ["0.75", "warn"], "A 2 unbound + B 1 listed over 4 players");
    assert.deepEqual([k.price_vs_median!.value, k.price_vs_median!.status], ["−40%", "alarm"]);
    assert.deepEqual([k.extract_share!.value, k.extract_share!.status], ["38%", "ok"], "3 of 8, guest exits included");
    assert.deepEqual([k.newbie_3!.value, k.newbie_3!.status], ["50%", "warn"], "B extracted, D died 3 times, C undecided");
    assert.deepEqual([k.retention_d1!.value, k.retention_d1!.status], ["50%", "ok"], "B back the next day, C not; D registered yesterday");
    assert.deepEqual([k.mia_share!.value, k.mia_share!.status], ["13%", "alarm"]);
    assert.deepEqual([k.gear_share!.value, k.gear_share!.status], ["33%", "warn"], "2 of 6 registered entries");
    assert.deepEqual([k.median_cr!.value, k.median_cr!.status], ["1 000", "warn"].map((s) => s.replace(" ", " ")));
    for (const id of ["invariants", "retention_d7", "retention_d30", "bug_response"]) {
      assert.deepEqual([k[id]!.value, k[id]!.status], [null, "none"], id);
    }
  });

  test("an empty database gives zeros and «нет данных», not errors", async () => {
    const m = await adminMetrics(db, { now: NOW, worldNowMs: NOW.getTime() });
    assert.equal(m.days.length, 7);
    assert.equal(m.online.total, 0);
    assert.deepEqual(m.items.byState, []);
    assert.deepEqual([m.house.d7, m.house.all], ["0", "0"]);
    assert.ok(m.kpis.every((k) => k.status === "none" && k.value === null), JSON.stringify(m.kpis.filter((k) => k.value !== null)));
  });
});

// ----------------------------------------------------------------------------- KPI rules

describe("buildKpis", () => {
  const base: KpiInputs = {
    crIn7: 1100,
    crOut7: 1000,
    crLast3: [
      { cin: 110, cout: 100 },
      { cin: 110, cout: 100 },
      { cin: 110, cout: 100 },
    ],
    regExits: 10,
    regExitCr: 4000,
    players: 10,
    tradable: 5,
    medianCr: 700,
    autosell: 1,
    prices: [{ n24: 3, m24: 1000, n7: 10, m7: 1000 }],
    exitsAll: 10,
    extracts: 4,
    mia: 0,
    regEntries: 10,
    gearEntries: 5,
    newbies: { extracted: 8, decided: 10, total: 12 },
    d1: { cohort: 10, back: 4 },
  };
  const status = (i: KpiInputs) => Object.fromEntries(buildKpis(i).map((k) => [k.id, k.status]));

  test("healthy numbers are all ok; rows without a source are «нет данных»", () => {
    const s = status(base);
    for (const id of ["cr_ratio", "cr_per_entry", "tradable_per_player", "price_vs_median", "extract_share", "newbie_3", "retention_d1", "mia_share", "gear_share", "median_cr"]) {
      assert.equal(s[id], "ok", id);
    }
    for (const id of ["invariants", "retention_d7", "retention_d30", "bug_response"]) assert.equal(s[id], "none", id);
    const rows = buildKpis(base);
    assert.deepEqual(
      rows.filter((r) => r.source === "§4").map((r) => r.id),
      ["cr_ratio", "cr_per_entry", "tradable_per_player", "price_vs_median", "invariants", "extract_share", "newbie_3", "retention_d1", "retention_d7", "retention_d30", "bug_response"],
      "ALPHA_PLAN §4 order",
    );
  });

  test("CR ratio: alarm only when each of the last three days is above 1.4", () => {
    const hot = { cin: 150, cout: 100 };
    assert.equal(status({ ...base, crIn7: 1500, crLast3: [hot, hot, hot] }).cr_ratio, "alarm");
    assert.equal(status({ ...base, crIn7: 1500, crLast3: [hot, { cin: 100, cout: 100 }, hot] }).cr_ratio, "warn");
    assert.equal(status({ ...base, crOut7: 0 }).cr_ratio, "none");
  });

  test("bands and alarms", () => {
    assert.equal(status({ ...base, regExitCr: 2400 }).cr_per_entry, "alarm"); // 240 < 250
    assert.equal(status({ ...base, regExitCr: 3000 }).cr_per_entry, "warn"); // 300
    assert.equal(status({ ...base, regExitCr: 6100 }).cr_per_entry, "alarm"); // 610 > 600
    assert.equal(status({ ...base, tradable: 2 }).tradable_per_player, "alarm"); // 0.2
    assert.equal(status({ ...base, tradable: 16 }).tradable_per_player, "alarm"); // 1.6
    assert.equal(status({ ...base, extracts: 2 }).extract_share, "alarm"); // 20%
    assert.equal(status({ ...base, extracts: 3 }).extract_share, "warn"); // 30%
    assert.equal(status({ ...base, newbies: { extracted: 4, decided: 10, total: 10 } }).newbie_3, "alarm");
    assert.equal(status({ ...base, d1: { cohort: 10, back: 3 } }).retention_d1, "warn");
    assert.equal(status({ ...base, mia: 1 }).mia_share, "warn"); // 10%
    assert.equal(status({ ...base, gearEntries: 2 }).gear_share, "alarm");
    assert.equal(status({ ...base, autosell: 0.4 }).median_cr, "alarm", "regulator at its floor");
    assert.equal(status({ ...base, autosell: 1 }).median_cr, "ok", "×1 is the normal ceiling, not an edge");
    assert.equal(status({ ...base, medianCr: 9000 }).median_cr, "warn");
  });

  test("price KPI: median over templates with enough trades", () => {
    const k = (prices: KpiInputs["prices"]) => buildKpis({ ...base, prices }).find((x) => x.id === "price_vs_median")!;
    assert.equal(k([{ n24: 1, m24: 500, n7: 10, m7: 1000 }]).status, "none", "one trade in 24 h is too thin");
    assert.equal(k([{ n24: 2, m24: 500, n7: 3, m7: 1000 }]).status, "none", "three in the window is too thin");
    const mixed = k([
      { n24: 2, m24: 1300, n7: 5, m7: 1000 },
      { n24: 2, m24: 700, n7: 5, m7: 1000 },
      { n24: 2, m24: 1100, n7: 5, m7: 1000 },
    ]);
    assert.deepEqual([mixed.value, mixed.status], ["+10%", "ok"]);
    assert.equal(k([{ n24: 2, m24: 1300, n7: 5, m7: 1000 }]).status, "warn");
  });
});
