/**
 * The chain_events outbox against the isolated `extract_test` database: the enqueue hooks inside
 * the real settlement flows (raids/exit, raids/end, world/event), the savepoint that keeps a failed
 * enqueue out of the game transaction, the claim, the backoff and the worker with a stubbed sender.
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/chain/queue.test.ts
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { asc, eq, sql } from "drizzle-orm";
import { Keypair } from "@solana/web3.js";
import { WORLD, type EntryRequest, type MatchEndReport, type PlayerExitReport, type ShardOpenRequest } from "@extract/shared";
import { chainEvents, items, users } from "../../db/schema";
import { lockLoadout } from "../inventory/loadout";
import { applyEnd, applyExit } from "../inventory/raids";
import { closeTestDb, lockTestDb, makeItem, makeUser, openTestDb, resetDb } from "../inventory/test-db";
import { enterRaid, openShard, recordWorldEvent } from "../inventory/world";
import { NO_KILLER, matchEvent, matchHashHex, toRecordArgs, type ChainEvent } from "./events";
import type { RecordArgs } from "./program";
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  BLOCKED_RETRY_MS,
  MAX_REJECTED_ATTEMPTS,
  backoffMs,
  claimDue,
  enqueueChainEvents,
  enqueueRareExtracts,
  getChainSummary,
  parkQueued,
  requeueFailed,
} from "./queue";
import { runChainEventsCron } from "./run";
import { runChainWorker, type ChainSender, type SendOutcome, type SigStatus } from "./worker";

const { db, pool } = openTestDb();
before(() => lockTestDb(pool));
after(() => closeTestDb(pool));
beforeEach(async () => {
  await resetDb(db);
  await db.execute(sql`truncate table chain_events restart identity`);
});

const CYCLE = 641_000;
const SALT = "test-salt";
const T0 = new Date("2026-10-04T08:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

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

function entryReq(matchId: string, userId: string, loadoutId = ""): EntryRequest {
  return { matchId, entryId: randomUUID(), userId, loadoutId, atMs: 60_000, targets: 30, bossAlive: true };
}

function exitReport(e: EntryRequest, extracted: PlayerExitReport["extracted"]): PlayerExitReport {
  return {
    matchId: e.matchId,
    userId: e.userId,
    exit: "extract",
    atMs: e.atMs + 600_000,
    kills: 0,
    level: 1,
    extracted,
    lost: [],
    destroyed: [],
    stats: { shotsFired: 0, dmgDealt: 0, containersSearched: 0, corpsesSearched: 0, bossKills: 0 },
    entryId: e.entryId,
    enteredAtMs: e.atMs,
  };
}

function endReport(matchId: string, over: Partial<MatchEndReport> = {}): MatchEndReport {
  return {
    matchId,
    mapId: "steppe",
    matchSeed: 42,
    startedAt: CYCLE * WORLD.CYCLE_MS,
    endedAt: (CYCLE + 1) * WORLD.CYCLE_MS,
    participants: [],
    leftOnMap: [],
    minted: [],
    cycleId: CYCLE,
    shard: 0,
    entries: [],
    ...over,
  };
}

/** A unique the entry found on the map (in_raid in this match, not in its loadout). */
async function foundItem(matchId: string, def: string, rarity: number): Promise<string> {
  const id = await makeItem(db, { def, rarity, state: "in_raid" });
  await db.update(items).set({ matchId }).where(eq(items.id, id));
  return id;
}

async function rows() {
  return db.select().from(chainEvents).orderBy(asc(chainEvents.id));
}

describe("enqueue hooks in the settlement flows", () => {
  test("raids/exit queues epic+ finds and rare junk, never the entry's own gear or commons", async () => {
    const shard = shardReq();
    await openShard(db, shard);
    const u = await makeUser(db);
    const own = await makeItem(db, { def: "rifle", rarity: 3, ownerId: u });
    const lock = await lockLoadout(db, u, [{ key: "w1", itemId: own, def: "rifle", qty: 1 }]);
    assert.ok(lock.ok);
    const e = entryReq(shard.matchId, u, lock.ok ? lock.loadoutId : "");
    assert.equal((await enterRaid(db, e)).status, "accepted");
    const epic = await foundItem(shard.matchId, "armor_3", 2);
    const common = await foundItem(shard.matchId, "shotgun", 0);
    const r = await applyExit(
      db,
      exitReport(e, [
        { uid: own, def: "rifle", qty: 1, rarity: 3, dur: 100 },
        { uid: epic, def: "armor_3", qty: 1, rarity: 2, dur: 50 },
        { uid: common, def: "shotgun", qty: 1, rarity: 0, dur: 100 },
        { uid: "", def: "junk_gpu", qty: 1, rarity: 3, dur: 100 },
        { uid: "", def: "junk_apple", qty: 3, rarity: 0, dur: 100 },
      ]),
    );
    assert.equal(r.status, "applied");
    const got = await rows();
    assert.deepEqual(
      got.map((x) => [x.kind, x.dedupeKey, x.status]).sort(),
      [
        ["rare_extract", `rare:${e.entryId}:${epic}`, "queued"],
        ["rare_extract", `rare:${e.entryId}:junk_gpu`, "queued"],
      ].sort(),
    );
    const armor = got.find((x) => x.dedupeKey.endsWith(epic))!;
    assert.deepEqual(armor.payload, { entryId: e.entryId, matchId: shard.matchId, cycleId: CYCLE, ownerId: u, def: "armor_3", rarity: 2, itemId: epic, qty: 1 });
    // a replayed exit report settles nothing new and queues nothing new
    assert.equal((await applyExit(db, exitReport(e, []))).status, "duplicate");
    assert.equal((await rows()).length, 2);
  });

  test("guests and demo shards queue no rare extracts", async () => {
    const demo = shardReq({ mode: "demo" });
    await openShard(db, demo);
    const u = await makeUser(db);
    const e = entryReq(demo.matchId, u);
    await enterRaid(db, e);
    const it = await foundItem(demo.matchId, "rifle", 3);
    await applyExit(db, exitReport(e, [{ uid: it, def: "rifle", qty: 1, rarity: 3, dur: 100 }, { uid: "", def: "junk_gpu", qty: 1, rarity: 3, dur: 100 }]));
    const live = shardReq();
    await openShard(db, live);
    const g = entryReq(live.matchId, randomUUID());
    await enterRaid(db, g);
    await applyExit(db, exitReport(g, [{ uid: "", def: "junk_coldwallet", qty: 1, rarity: 3, dur: 100 }]));
    assert.equal((await rows()).length, 0);
  });

  test("raids/end queues one match record with the canonical report hash; demo shards none", async () => {
    const shard = shardReq({ shard: 2 });
    await openShard(db, shard);
    const u = await makeUser(db);
    const e = entryReq(shard.matchId, u);
    await enterRaid(db, e);
    const end = endReport(shard.matchId, {
      shard: 2,
      entries: [e.entryId],
      participants: [
        { userId: u, nickname: "ann", isBot: false, exitType: "mia", kills: 0 },
        { userId: randomUUID(), nickname: "guest1", isBot: false, exitType: "extract", kills: 1 },
      ],
    });
    assert.equal((await applyEnd(db, end)).status, "applied");
    const [m] = await rows();
    assert.equal(m!.kind, "match");
    assert.equal(m!.dedupeKey, `match:${shard.matchId}`);
    assert.deepEqual(m!.payload, { matchId: shard.matchId, cycleId: CYCLE, shard: 2, matchHash: matchHashHex(end), humans: 2, mia: 1 });
    assert.equal((await applyEnd(db, end)).status, "duplicate");
    const demo = shardReq({ mode: "demo" });
    await openShard(db, demo);
    await applyEnd(db, endReport(demo.matchId));
    assert.equal((await rows()).length, 1);
  });

  test("world/event queues the boss kill once; the killer is a registered entry of that shard, a guest or nobody", async () => {
    const u = await makeUser(db, "bosshunter");
    const u2 = await makeUser(db, "hunter2");
    const a = shardReq({ boss: { kind: "warden", zone: "z1" } });
    const b = shardReq({ boss: { kind: "foreman", zone: "z2" } });
    const c = shardReq({ boss: { kind: "warden", zone: "z1" } });
    const d = shardReq({ boss: { kind: "foreman", zone: "z2" } });
    const e = shardReq({ boss: { kind: "warden", zone: "z1" } });
    const demo = shardReq({ mode: "demo", boss: { kind: "warden", zone: "z1" } });
    for (const s of [a, b, c, d, e, demo]) await openShard(db, s);
    assert.equal((await enterRaid(db, entryReq(a.matchId, u))).status, "accepted");
    assert.equal((await enterRaid(db, entryReq(b.matchId, randomUUID()))).status, "accepted", "a guest");
    assert.equal((await enterRaid(db, entryReq(c.matchId, u2))).status, "accepted");
    const ev = (matchId: string, boss: "warden" | "foreman", by: string, byUserId?: string) =>
      recordWorldEvent(db, { matchId, cycleId: CYCLE, kind: "boss_killed", boss, by, ...(byUserId ? { byUserId } : {}), atMs: 900_000 });
    assert.equal((await ev(a.matchId, "warden", "bosshunter", u)).status, "applied");
    assert.equal((await ev(a.matchId, "warden", "bosshunter", u)).status, "duplicate");
    // a guest who picked a registered player's nickname stays a guest
    await ev(b.matchId, "foreman", "bosshunter");
    // an older game server without byUserId: the shard's own registered entry with that nickname
    await ev(c.matchId, "warden", "hunter2");
    // killed by no raider
    await ev(d.matchId, "foreman", "");
    // a byUserId with no registered entry in this shard is not trusted
    await ev(e.matchId, "warden", "bosshunter", u);
    await ev(demo.matchId, "warden", "bosshunter", u);
    const got = await rows();
    assert.deepEqual(
      got.map((x) => x.payload),
      [
        { matchId: a.matchId, cycleId: CYCLE, boss: "warden", killer: `user:${u}` },
        { matchId: b.matchId, cycleId: CYCLE, boss: "foreman", killer: "guest:bosshunter" },
        { matchId: c.matchId, cycleId: CYCLE, boss: "warden", killer: `user:${u2}` },
        { matchId: d.matchId, cycleId: CYCLE, boss: "foreman", killer: NO_KILLER },
        { matchId: e.matchId, cycleId: CYCLE, boss: "warden", killer: "guest:bosshunter" },
      ],
    );
    const none = toRecordArgs("boss_kill", got[3]!.payload, SALT);
    assert.ok(none.kind === "boss_kill" && Buffer.from(none.killerHash).equals(Buffer.alloc(32)), "no killer: zero hash");
  });

  test("a failing enqueue rolls back to its savepoint: the game transaction still commits", async () => {
    const logs: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => void logs.push(a.join(" "));
    let n = -1;
    try {
      await db.transaction(async (tx) => {
        await tx.update(users).set({ level: 1 }).where(sql`false`);
        // entry ids are uuids: this one makes the rare-extract query itself fail inside the transaction
        n = await enqueueRareExtracts(tx, {
          entryId: "not-a-uuid",
          matchId: randomUUID(),
          cycleId: CYCLE,
          userId: randomUUID(),
          live: true,
          extracted: [{ uid: randomUUID(), def: "rifle", qty: 1, rarity: 3, dur: 100 }],
        });
        await tx.insert(users).values({ email: "after@test.local", passwordHash: "x", nickname: "after", depositAddress: "dep-after" });
      });
    } finally {
      console.warn = warn;
    }
    assert.equal(n, 0);
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /\[chain\] rare_extract not queued \(game flow unaffected\)/);
    assert.equal((await db.select().from(users).where(eq(users.nickname, "after"))).length, 1);
    assert.equal((await rows()).length, 0);
  });
});

// ---------------------------------------------------------------------------- worker

/** Scripted sender: outcomes are taken in order; defaults are "confirmed" and "expired". */
class StubSender implements ChainSender {
  prepared: RecordArgs[] = [];
  statusCalls: Array<[string, number | null]> = [];
  sends: SendOutcome[] = [];
  statuses: SigStatus[] = [];
  prepareError: Error | null = null;
  private n = 0;
  async prepare(args: RecordArgs) {
    if (this.prepareError) throw this.prepareError;
    this.prepared.push(args);
    const sig = `sig${++this.n}`;
    return { sig, validUntil: 1000 + this.n, send: async () => this.sends.shift() ?? ({ status: "confirmed" } as const) };
  }
  async status(sig: string, validUntil: number | null) {
    this.statusCalls.push([sig, validUntil]);
    return this.statuses.shift() ?? ({ status: "expired" } as const);
  }
}

const matchEv = (i = 1): ChainEvent =>
  matchEvent(
    {
      matchId: `00000000-0000-4000-8000-00000000000${i}`,
      mapId: "steppe",
      matchSeed: i,
      startedAt: 0,
      endedAt: 1,
      participants: [],
      leftOnMap: [],
      minted: [],
      cycleId: CYCLE,
      shard: 0,
    },
    "live",
  )!;

const run = (s: ChainSender, now: Date, over: { limit?: number; budgetMs?: number } = {}) =>
  runChainWorker(db, s, { salt: SALT, clock: () => now, ...over });

async function one() {
  const r = await rows();
  assert.equal(r.length, 1);
  return r[0]!;
}

describe("backoff", () => {
  test("doubles from 30 s and caps at 30 min", () => {
    assert.deepEqual([1, 2, 3, 4].map(backoffMs), [30_000, 60_000, 120_000, 240_000]);
    assert.equal(backoffMs(0), BACKOFF_BASE_MS);
    assert.equal(backoffMs(7), BACKOFF_MAX_MS);
    assert.equal(backoffMs(500), BACKOFF_MAX_MS);
  });
});

describe("chain worker", () => {
  test("sends a due event once and marks it sent with its signature", async () => {
    assert.equal(await enqueueChainEvents(db, [matchEv(), matchEv()], T0), 1, "dedupe key");
    const s = new StubSender();
    const r = await run(s, T0);
    assert.deepEqual(r, { claimed: 1, sent: 1, retried: 0, failed: 0, released: 0, signatures: ["sig1"], stopped: null });
    const row = await one();
    assert.deepEqual([row.status, row.txSig, row.attempts, row.error], ["sent", "sig1", 1, null]);
    assert.equal(row.sentAt?.getTime(), T0.getTime());
    assert.deepEqual(s.prepared, [toRecordArgs("match", matchEv().payload, SALT)]);
    assert.equal((await run(s, at(3_600_000))).claimed, 0, "sent rows are never claimed again");
  });

  test("a program rejection backs off and fails the row on the fifth attempt", async () => {
    await enqueueChainEvents(db, [matchEv()], T0);
    const s = new StubSender();
    let now = T0;
    for (let attempt = 1; attempt <= MAX_REJECTED_ATTEMPTS; attempt++) {
      s.sends.push({ status: "rejected", error: "custom program error: 0x1770" });
      assert.equal((await run(s, new Date(now.getTime() - 1))).claimed, 0, "not due before next_at");
      const r = await run(s, now);
      const row = await one();
      assert.equal(row.attempts, attempt);
      assert.equal(row.rejections, attempt);
      assert.equal(row.txSig, null, "a rejected transaction never landed: no signature kept");
      assert.equal(row.error, "custom program error: 0x1770");
      if (attempt < MAX_REJECTED_ATTEMPTS) {
        assert.equal(r.retried, 1);
        assert.equal(row.status, "queued");
        assert.equal(row.nextAt.getTime(), now.getTime() + backoffMs(attempt));
        now = row.nextAt;
      } else {
        assert.equal(r.failed, 1);
        assert.equal(row.status, "failed");
      }
    }
    assert.equal((await run(s, at(86_400_000))).claimed, 0);
  });

  test("only rejections count toward failing a row: transport errors and pending re-checks never do", async () => {
    await enqueueChainEvents(db, [matchEv()], T0);
    const s = new StubSender();
    let now = T0;
    // four passes that cost an attempt each without a rejection: unknown, pending, expired + unknown, dead RPC
    s.sends.push({ status: "unknown", error: "Node is behind by 150 slots" });
    await run(s, now);
    now = (await one()).nextAt;
    s.statuses.push({ status: "pending" });
    await run(s, now);
    now = (await one()).nextAt;
    s.statuses.push({ status: "expired" });
    s.sends.push({ status: "unknown", error: "timeout" });
    await run(s, now);
    now = (await one()).nextAt;
    s.statuses.push({ status: "expired" });
    s.prepareError = new Error("fetch failed");
    await run(s, now);
    s.prepareError = null;
    let row = await one();
    assert.deepEqual([row.status, row.attempts, row.rejections], ["queued", 4, 0]);
    for (let i = 1; i < MAX_REJECTED_ATTEMPTS; i++) {
      s.sends.push({ status: "rejected", error: "custom program error: 0x1770" });
      const r = await run(s, row.nextAt);
      row = await one();
      assert.deepEqual([r.retried, row.status, row.rejections], [1, "queued", i], `rejection ${i}`);
    }
    s.sends.push({ status: "rejected", error: "custom program error: 0x1770" });
    assert.equal((await run(s, row.nextAt)).failed, 1);
    row = await one();
    assert.deepEqual([row.status, row.rejections], ["failed", MAX_REJECTED_ATTEMPTS]);
    // the operator command puts it back with fresh counters
    assert.equal(await requeueFailed(db, { now: at(86_400_000) }), 1);
    row = await one();
    assert.deepEqual([row.status, row.attempts, row.rejections, row.nextAt.getTime()], ["queued", 0, 0, at(86_400_000).getTime()]);
    assert.match(row.error ?? "", /^requeued: custom program error/);
    assert.equal(await requeueFailed(db, { ids: [] }), 0);
    assert.equal((await run(s, at(86_400_000))).sent, 1);
  });

  test("send-test-events parks leftover queued rows, so only its own samples reach the public program", async () => {
    await enqueueChainEvents(db, [matchEv(1), matchEv(2)], T0);
    assert.equal(await parkQueued(db, "parked by send-test-events (not sent)"), 2);
    await enqueueChainEvents(db, [matchEv(3)], T0);
    const r = await run(new StubSender(), T0);
    assert.deepEqual([r.claimed, r.sent], [1, 1]);
    assert.deepEqual((await rows()).map((x) => x.status), ["failed", "failed", "sent"]);
  });

  test("a blocked send (fee payer refused) hands every claimed row back uncounted and stops the pass", async () => {
    await enqueueChainEvents(db, [matchEv(1), matchEv(2), matchEv(3)], T0);
    const s = new StubSender();
    const msg = "Simulation failed. Message: Transaction simulation failed: Transaction results in an account (0) with insufficient funds for rent.";
    s.sends.push({ status: "blocked", error: msg });
    const r = await run(s, T0);
    assert.deepEqual([r.claimed, r.sent, r.failed, r.retried, r.released, r.stopped], [3, 0, 0, 0, 3, msg]);
    assert.equal(s.prepared.length, 1, "stops after the first blocked send");
    const all = await rows();
    for (const row of all) assert.deepEqual([row.status, row.attempts, row.rejections, row.txSig], ["queued", 0, 0, null]);
    assert.equal(all[0]!.error, msg);
    assert.equal(all[0]!.nextAt.getTime(), T0.getTime() + BLOCKED_RETRY_MS);
    assert.equal(all[1]!.nextAt.getTime(), T0.getTime(), "the untouched rows are due again at once");
  });

  test("an unconfirmed send keeps its signature; the next pass finds it landed and never re-records", async () => {
    await enqueueChainEvents(db, [matchEv()], T0);
    const s = new StubSender();
    s.sends.push({ status: "unknown", error: "confirm timeout" });
    await run(s, T0);
    let row = await one();
    assert.deepEqual([row.status, row.txSig, row.txValidUntil], ["queued", "sig1", 1001]);
    s.statuses.push({ status: "confirmed" });
    const r = await run(s, row.nextAt);
    row = await one();
    assert.deepEqual([row.status, row.txSig, r.signatures], ["sent", "sig1", ["sig1"]]);
    assert.equal(s.prepared.length, 1, "no second transaction");
    assert.deepEqual(s.statusCalls, [["sig1", 1001]]);
  });

  test("a pending signature is re-checked soon; an expired one is signed again", async () => {
    await enqueueChainEvents(db, [matchEv()], T0);
    const s = new StubSender();
    s.sends.push({ status: "unknown", error: "timeout" });
    await run(s, T0);
    s.statuses.push({ status: "pending" });
    let row = await one();
    const t1 = row.nextAt;
    await run(s, t1);
    row = await one();
    assert.deepEqual([row.status, row.txSig], ["queued", "sig1"]);
    assert.equal(row.nextAt.getTime(), t1.getTime() + 15_000);
    s.statuses.push({ status: "expired" });
    await run(s, row.nextAt);
    row = await one();
    assert.deepEqual([row.status, row.txSig], ["sent", "sig2"]);
    assert.equal(s.prepared.length, 2);
  });

  test("a landed-but-failed signature counts as a rejection", async () => {
    await enqueueChainEvents(db, [matchEv()], T0);
    const s = new StubSender();
    s.sends.push({ status: "unknown", error: "timeout" });
    await run(s, T0);
    s.statuses.push({ status: "failed", error: "on-chain error" });
    await run(s, (await one()).nextAt);
    const row = await one();
    assert.deepEqual([row.status, row.txSig, row.error], ["queued", null, "on-chain error"]);
  });

  test("a dead RPC only delays: rows stay queued with the backoff capped, attempts counted", async () => {
    await enqueueChainEvents(db, [matchEv()], T0);
    const s = new StubSender();
    s.prepareError = new Error("fetch failed https://rpc.example.com/v2/KEY");
    let now = T0;
    for (let i = 1; i <= 9; i++) {
      await run(s, now);
      const row = await one();
      assert.equal(row.status, "queued");
      assert.equal(row.error, "Error: fetch failed https://rpc.example.com");
      assert.equal(row.nextAt.getTime() - now.getTime(), backoffMs(i));
      now = row.nextAt;
    }
    assert.equal(backoffMs(9), BACKOFF_MAX_MS);
  });

  test("a payload that cannot be encoded fails at once", async () => {
    await db.insert(chainEvents).values({ kind: "match", dedupeKey: "bad", payload: { cycleId: -1 }, nextAt: T0 });
    const r = await run(new StubSender(), T0);
    assert.equal(r.failed, 1);
    const row = await one();
    assert.equal(row.status, "failed");
    assert.match(row.error ?? "", /^bad payload/);
  });

  test("rows past the time budget are handed back without counting the attempt", async () => {
    await enqueueChainEvents(db, [matchEv(1), matchEv(2), matchEv(3)], T0);
    const s = new StubSender();
    const r = await run(s, T0, { budgetMs: -1 });
    assert.deepEqual([r.claimed, r.released, r.sent], [3, 3, 0]);
    for (const row of await rows()) assert.deepEqual([row.status, row.attempts, row.nextAt.getTime()], ["queued", 0, T0.getTime()]);
    assert.equal((await run(s, T0, { limit: 2 })).sent, 2, "limit per call");
    assert.equal((await run(s, T0)).sent, 1);
  });

  test("concurrent claims never take the same row", async () => {
    await enqueueChainEvents(db, [matchEv(1), matchEv(2), matchEv(3)], T0);
    const [x, y] = await Promise.all([claimDue(db, 2, T0), claimDue(db, 2, T0)]);
    const ids = [...x, ...y].map((r) => r.id);
    assert.equal(ids.length, 3);
    assert.equal(new Set(ids).size, 3);
    assert.equal((await claimDue(db, 5, T0)).length, 0, "leased");
  });

  test("without a signer key (production) the cron pass claims nothing", async () => {
    await enqueueChainEvents(db, [matchEv()], T0);
    const r = await runChainEventsCron(db, { env: { NODE_ENV: "production" } });
    assert.deepEqual(r, { configured: false, reason: "CHAIN_AUTHORITY_SECRET is not set" });
    const row = await one();
    assert.deepEqual([row.status, row.attempts], ["queued", 0]);
  });

  test("an unreachable RPC (readiness check) claims nothing either", async () => {
    await enqueueChainEvents(db, [matchEv()], T0);
    const secret = JSON.stringify([...Keypair.generate().secretKey]);
    const r = await runChainEventsCron(db, { env: { NODE_ENV: "development", CHAIN_AUTHORITY_SECRET: secret, CHAIN_RPC_URL: "http://127.0.0.1:9" } });
    assert.equal(r.configured, true);
    assert.ok(r.configured && !r.ready && /^RPC unavailable/.test(r.reason), JSON.stringify(r));
    assert.deepEqual([(await one()).status, (await one()).attempts], ["queued", 0]);
  });

  test("the /economy summary counts by kind and status and lists the latest signatures", async () => {
    await enqueueChainEvents(db, [matchEv(1), matchEv(2)], T0);
    const s = new StubSender();
    await run(s, T0, { limit: 1 });
    const sum = await getChainSummary(db);
    assert.deepEqual(sum.counts.match, { sent: 1, queued: 1, failed: 0 });
    assert.deepEqual(sum.counts.boss_kill, { sent: 0, queued: 0, failed: 0 });
    assert.deepEqual(sum.recent.map((x) => [x.kind, x.txSig]), [["match", "sig1"]]);
  });
});
