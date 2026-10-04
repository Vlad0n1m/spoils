/**
 * T17 (WORLD v6, spec §9): the WorldDirectory on a fake world clock and fake timers, with small real
 * world-mode Matches (test map, no NPCs) behind fake rooms and stubbed web calls.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  PARTY,
  WORLD,
  cycleEnvSeed,
  mulberry32,
  worldCycleOf,
  type EntryRequest,
  type EntryResponse,
  type JoinTicket,
  type ShardOpenRequest,
} from "@extract/shared";
import { Match } from "../sim/match.js";
import { counterUid, testMap } from "../sim/test-utils.js";
import type { ShardOpenOutcome } from "../net/web-api.js";
import { HARD_STOP_AFTER_MS, OPEN_RETRY_MS, PARTY_FULL_DETAIL, WorldDirectory, type DirectoryDeps, type ShardRoom, type WorldCreateOptions } from "./directory.js";
import { PARTY_SPAWN_MAX_PX, PARTY_SPAWN_MIN_PX } from "../sim/spawn.js";

const K = 663_000;
const WC = worldCycleOf(K);

/** Fake world clock + timers: advance() fires due timers in time order and lets their promises settle. */
class FakeTime {
  t: number;
  private seq = 0;
  private timers: Array<{ id: number; at: number; fn: () => void }> = [];
  constructor(t: number) {
    this.t = t;
  }
  now = (): number => this.t;
  setTimer = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.timers.push({ id, at: this.t + Math.max(0, ms), fn });
    return id;
  };
  clearTimer = (h: unknown): void => {
    this.timers = this.timers.filter((x) => x.id !== h);
  };
  get pending(): number {
    return this.timers.length;
  }
  async settle(): Promise<void> {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  }
  async advanceTo(target: number): Promise<void> {
    await this.settle();
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.timers[0];
      if (!next || next.at > target) break;
      this.timers.shift();
      this.t = Math.max(this.t, next.at);
      next.fn();
      await this.settle();
    }
    this.t = Math.max(this.t, target);
    await this.settle();
  }
  advance(ms: number): Promise<void> {
    return this.advanceTo(this.t + ms);
  }
}

class FakeRoom implements ShardRoom {
  readonly match: Match;
  disposed = false;
  forced = 0;
  constructor(readonly opts: WorldCreateOptions, now: () => number) {
    this.match = new Match({
      roster: [],
      rng: mulberry32(7),
      map: testMap(),
      newUid: counterUid,
      now,
      emptyWorld: true,
      envSeed: opts.envSeed,
      weatherOverride: "clear",
      matchId: opts.matchId,
      mode: opts.mode,
      world: { cycleId: opts.cycleId, shard: opts.shard, cycleStartsAt: opts.cycleStartsAt, entryCloseMs: opts.entryCloseMs, bossEvent: opts.bossEvent },
    });
  }
  wipe(): void {
    this.match.wipe();
  }
  async forceDispose(): Promise<void> {
    this.forced++;
    this.disposed = true;
  }
}

const accepted = (o: Partial<EntryResponse> = {}): EntryResponse => ({
  status: "accepted", snapshot: null, level: 2, guest: false, pool: [], bossFill: [], autosellMult: 1, ...o,
});

interface Harness {
  dir: WorldDirectory;
  time: FakeTime;
  rooms: FakeRoom[];
  opens: ShardOpenRequest[];
  enters: EntryRequest[];
}

function harness(startAt: number, deps: Partial<DirectoryDeps> = {}): Harness {
  const time = new FakeTime(startAt);
  const rooms: FakeRoom[] = [];
  const opens: ShardOpenRequest[] = [];
  const enters: EntryRequest[] = [];
  let n = 0;
  const dir = new WorldDirectory({
    now: time.now,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
    createRoom: async (opts) => {
      const room = new FakeRoom(opts, time.now);
      rooms.push(room);
      return { roomId: `room-${++n}`, room };
    },
    openShard: async (req) => {
      opens.push(req);
      return { status: "opened", autosellMult: 1 };
    },
    enterRaid: async (req) => {
      enters.push(req);
      return accepted();
    },
    webConfigured: () => true,
    bossOf: (c) => (c % 3 === 0 ? "warden" : null),
    mode: () => "live",
    serverId: "srv",
    instanceId: "inst-1",
    production: false,
    ...deps,
  });
  return { dir, time, rooms, opens, enters };
}

const ticket = (matchId: string, userId: string = randomUUID(), entryId: string = randomUUID()): JoinTicket => ({
  userId, nickname: "Tester", issuedAt: 1, loadoutId: "", matchId, entryId, sig: "0".repeat(64),
});

const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const [log, err] = [console.log, console.error];
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.error = err;
  }
};

test("boot mid-cycle opens the current cycle; prewarm at T − 30 s, wipe at T, next schedule, hard stop", () =>
  quiet(async () => {
    const h = harness(WC.startAt + 10 * 60_000);
    await h.dir.start();
    const cur = h.dir.shardOfCycle(K)!;
    assert.ok(cur, "current cycle open at once");
    assert.equal(h.rooms.length, 1);
    const o = h.rooms[0]!.opts;
    assert.equal(o.cycleId, K);
    assert.equal(o.cycleStartsAt, WC.startAt);
    assert.equal(o.entryCloseMs, WORLD.CYCLE_MS - WORLD.ENTRY_CLOSE_MS);
    assert.equal(o.envSeed, cycleEnvSeed(K));
    assert.equal(o.bossEvent, K % 3 === 0 ? "warden" : null);
    assert.match(o.matchId, /^[0-9a-f-]{36}$/);
    await h.time.settle();
    assert.equal(cur.registered, true);
    assert.equal(h.opens[0]!.matchId, cur.matchId);
    assert.equal(h.opens[0]!.endsAt, WC.wipeAt);
    assert.equal(h.opens[0]!.instanceId, "inst-1");

    await h.time.advanceTo(WC.wipeAt - WORLD.PREWARM_MS - 1);
    assert.equal(h.dir.shardOfCycle(K + 1), undefined, "not prewarmed yet");
    await h.time.advanceTo(WC.wipeAt - WORLD.PREWARM_MS);
    const next = h.dir.shardOfCycle(K + 1)!;
    assert.ok(next, "prewarmed 30 s before the wipe");
    assert.equal(next.room.match.clock, 0, "the prewarmed match idles until its cycle starts");
    assert.equal(h.rooms[1]!.opts.cycleStartsAt, WC.wipeAt);

    await h.time.advanceTo(WC.wipeAt - 1);
    assert.equal(cur.room.match.ended, false);
    await h.time.advanceTo(WC.wipeAt);
    assert.equal(cur.room.match.ended, true, "wiped at T");
    assert.equal((cur.room.match as Match).report?.cycleId, K);
    assert.equal(h.dir.current(), next);

    // The next cycle is scheduled: its prewarm opens K + 2.
    const wc1 = worldCycleOf(K + 1);
    await h.time.advanceTo(wc1.wipeAt - WORLD.PREWARM_MS);
    assert.ok(h.dir.shardOfCycle(K + 2));

    // Hard stop: the room of K outlived its wipe by 60 s (the fake never disposes itself).
    assert.ok(h.time.now() > WC.wipeAt + HARD_STOP_AFTER_MS);
    assert.equal(h.rooms[0]!.forced, 1);
    assert.equal(h.dir.shardOfCycle(K), undefined);
    assert.equal(h.dir.shardByMatch(cur.matchId), undefined);
    h.dir.stop();
    assert.equal(h.time.pending, 0, "stop clears every timer");
  }));

test("boot seconds before the wipe opens the current cycle and prewarms the next at once", () =>
  quiet(async () => {
    const h = harness(WC.wipeAt - 5_000);
    await h.dir.start();
    await h.time.settle();
    await h.time.advance(0);
    assert.ok(h.dir.shardOfCycle(K));
    assert.ok(h.dir.shardOfCycle(K + 1));
    await h.time.advanceTo(WC.wipeAt);
    assert.equal(h.dir.shardOfCycle(K)!.room.match.ended, true);
    h.dir.stop();
  }));

test("raids/open: retried every 10 s until it lands; a 4xx stops; nothing after the wipe", () =>
  quiet(async () => {
    const answers: ShardOpenOutcome[] = [null, null, { status: "exists", autosellMult: 1 }];
    const h = harness(WC.startAt + 60_000, { openShard: async (req) => (h.opens.push(req), answers.shift() ?? null) });
    await h.dir.start();
    const s = h.dir.shardOfCycle(K)!;
    await h.time.settle();
    assert.equal(h.opens.length, 1);
    assert.equal(s.registered, false);
    await h.time.advance(OPEN_RETRY_MS);
    assert.equal(h.opens.length, 2);
    await h.time.advance(OPEN_RETRY_MS);
    assert.equal(h.opens.length, 3);
    assert.equal(s.registered, true);
    await h.time.advance(5 * OPEN_RETRY_MS);
    assert.equal(h.opens.filter((r) => r.matchId === s.matchId).length, 3, "no more posts once registered");
    h.dir.stop();

    const r = harness(WC.startAt + 60_000, { openShard: async (req) => (r.opens.push(req), "rejected") });
    await r.dir.start();
    await r.time.advance(5 * OPEN_RETRY_MS);
    assert.equal(r.opens.length, 1, "a refused body is not retried");
    r.dir.stop();

    const late = harness(WC.wipeAt - 15_000, { openShard: async (req) => (late.opens.push(req), null) });
    await late.dir.start();
    await late.time.advanceTo(WC.wipeAt + 5 * OPEN_RETRY_MS);
    assert.equal(late.opens.filter((q) => q.cycleId === K).length, 2, "retries stop at the wipe");
    late.dir.stop();
  }));

test("admission: dedupe per user, in-flight entries count toward capacity, the admission time is authoritative", () =>
  quiet(async () => {
    let release!: (r: EntryResponse | null) => void;
    const h = harness(WC.entryClosesAt - 1_000, {
      enterRaid: (req) => {
        h.enters.push(req);
        return new Promise((r) => (release = r));
      },
    });
    await h.dir.start();
    const s = h.dir.shardOfCycle(K)!;
    const t = ticket(s.matchId);
    const a = h.dir.admit(t);
    const b = h.dir.admit({ ...t });
    await h.time.settle();
    assert.equal(h.enters.length, 1, "one raids/enter for two PLAYs of the same user");
    assert.equal(s.inflight.size, 1);
    assert.equal(h.enters[0]!.atMs, WORLD.CYCLE_MS - WORLD.ENTRY_CLOSE_MS - 1_000, "atMs = cycle clock");
    // 23 on the map + 1 in flight = full.
    const m = s.room.match as Match;
    while (m.humansOnMap() < WORLD.CAPACITY - 1) {
      m.addHuman({ entryId: randomUUID(), userId: randomUUID(), nickname: "F", loadoutId: "", guest: false, level: 0, snapshot: null, pool: [], bossFill: [] });
    }
    await assert.rejects(h.dir.admit(ticket(s.matchId)), /world_full/);
    assert.equal(h.enters.length, 1);
    // Entry closes while the web answers: the admission still completes (D: admission time is authoritative).
    await h.time.advanceTo(WC.entryClosesAt + 5_000);
    release(accepted({ level: 9 }));
    await Promise.all([a, b]);
    const rt = s.room.match.currentOf(t.userId)!;
    assert.ok(rt.pub.alive);
    assert.equal(rt.entryId, t.entryId);
    assert.equal(rt.level, 9);
    assert.equal(s.inflight.size, 0);
    // A later PLAY of the same user is a rejoin (no web), even after entry closed.
    await h.dir.admit(ticket(s.matchId, t.userId));
    assert.equal(h.enters.length, 1);
    // A new user now: entry closed.
    await assert.rejects(h.dir.admit(ticket(s.matchId)), /entry_closed/);
    h.dir.stop();
  }));

test("admission: entry_closed after T − 10 min and during the reset; map_gone, exit_settling, world_full, web errors", () =>
  quiet(async () => {
    const h = harness(WC.startAt + 5_000);
    await h.dir.start();
    const s = h.dir.shardOfCycle(K)!;
    await assert.rejects(h.dir.admit(ticket(s.matchId)), /entry_closed/, "resetting (first RESET_MS)");
    await h.time.advanceTo(WC.openAt);
    await h.dir.admit(ticket(s.matchId));
    await h.time.advanceTo(WC.entryClosesAt - 1);
    await h.dir.admit(ticket(s.matchId));
    await h.time.advanceTo(WC.entryClosesAt);
    await assert.rejects(h.dir.admit(ticket(s.matchId)), /entry_closed/);
    await assert.rejects(h.dir.admit(ticket(randomUUID())), /map_gone/);
    await assert.rejects(h.dir.admit({ ...ticket(s.matchId), matchId: undefined }), /map_gone/);
    await assert.rejects(h.dir.admit({ ...ticket(s.matchId), entryId: undefined }), /invalid_ticket/);
    h.dir.stop();

    const g = harness(WC.startAt + 60_000);
    await g.dir.start();
    const gs = g.dir.shardOfCycle(K)!;
    const m = gs.room.match as Match;
    const t = ticket(gs.matchId);
    await g.dir.admit(t);
    m.allRuntimes().find((r) => r.entryId === t.entryId)!.pub.alive = false;
    await assert.rejects(g.dir.admit(ticket(gs.matchId, t.userId, t.entryId)), /exit_settling/);
    while (m.humansOnMap() < WORLD.CAPACITY) await g.dir.admit(ticket(gs.matchId));
    const before = g.enters.length;
    await assert.rejects(g.dir.admit(ticket(gs.matchId)), /world_full/);
    assert.equal(g.enters.length, before, "no web call when full");
    gs.room.wipe();
    await assert.rejects(g.dir.admit(ticket(gs.matchId)), /map_gone/);
    g.dir.stop();
  }));

test("admission: web rejections, web down, wiped meanwhile, standalone dev", () =>
  quiet(async () => {
    let reply: EntryResponse | null = null;
    let onEnter: () => void = () => {};
    const h = harness(WC.startAt + 60_000, { enterRaid: async () => (onEnter(), reply) });
    await h.dir.start();
    const s = h.dir.shardOfCycle(K)!;
    const rej = (reason: EntryResponse["reason"]) => ({ ...accepted(), status: "rejected" as const, reason });
    const cases: Array<[EntryResponse | null, RegExp]> = [
      [null, /web_unavailable/],
      [rej("entry_limit"), /entry_limit/],
      [rej("already_active"), /in_raid/],
      [rej("shard_closed"), /map_gone/],
      [rej("wrong_user"), /loadout_rejected:wrong_user/],
    ];
    for (const [r, re] of cases) {
      reply = r;
      const t = ticket(s.matchId);
      await assert.rejects(h.dir.admit(t), re);
      assert.equal(s.room.match.currentOf(t.userId), undefined);
    }
    // Wiped while raids/enter was in flight: nobody is put on the dead map.
    reply = accepted();
    onEnter = () => s.room.wipe();
    const t = ticket(s.matchId);
    await assert.rejects(h.dir.admit(t), /map_gone/);
    assert.equal(s.room.match.currentOf(t.userId), undefined);
    h.dir.stop();

    // Web not configured: dev admits standalone with a free kit; production refuses.
    const dev = harness(WC.startAt + 60_000, { webConfigured: () => false, enterRaid: async () => assert.fail("no web") });
    await dev.dir.start();
    const ds = dev.dir.shardOfCycle(K)!;
    const dt = ticket(ds.matchId);
    await dev.dir.admit(dt);
    assert.ok(ds.room.match.currentOf(dt.userId)?.pub.alive);
    assert.equal(ds.registered, false, "nothing to register without the web");
    dev.dir.stop();
    const prod = harness(WC.startAt + 60_000, { webConfigured: () => false, production: true });
    await prod.dir.start();
    await assert.rejects(prod.dir.admit(ticket(prod.dir.shardOfCycle(K)!.matchId)), /web_unavailable/);
    prod.dir.stop();
  }));

test("a failed room creation is retried while the cycle lasts", () =>
  quiet(async () => {
    let fail = 1;
    const time = new FakeTime(WC.startAt + 60_000);
    const rooms: FakeRoom[] = [];
    const dir = new WorldDirectory({
      now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer,
      createRoom: async (opts) => {
        if (fail-- > 0) throw new Error("boom");
        const room = new FakeRoom(opts, time.now);
        rooms.push(room);
        return { roomId: "r", room };
      },
      openShard: async () => ({ status: "opened", autosellMult: 1 }),
      enterRaid: async () => accepted(),
      webConfigured: () => true, bossOf: () => null, mode: () => "demo", serverId: "s", instanceId: "i", production: false,
    });
    await dir.start();
    assert.equal(dir.shardOfCycle(K), undefined);
    await time.advance(10_000);
    assert.ok(dir.shardOfCycle(K));
    assert.equal(rooms[0]!.opts.mode, "demo");
    dir.stop();
  }));

test("party drop admission: the first member needs room for a whole party; held seats, refusals give them back, expiry", () =>
  quiet(async () => {
    let refuse: string | null = null;
    const h = harness(WC.startAt + 60_000);
    await h.dir.start();
    const s = h.dir.shardOfCycle(K)!;
    const m = s.room.match as Match;
    const fill = (n: number) => {
      while (m.humansOnMap() < n) {
        m.addHuman({ entryId: randomUUID(), userId: randomUUID(), nickname: "F", loadoutId: "", guest: false, level: 0, snapshot: null, pool: [], bossFill: [] });
      }
    };
    const partyId = randomUUID();
    const dropId = randomUUID();
    const member = (userId = randomUUID()): JoinTicket => ({ ...ticket(s.matchId, userId), partyId, dropId });

    // 21 on the map: a party of up to 4 does not fit → the first member is refused with a clear code.
    fill(WORLD.CAPACITY - PARTY.MAX_SIZE + 1);
    const before = h.enters.length;
    await assert.rejects(h.dir.admit(member()), { message: `world_full:${PARTY_FULL_DETAIL}` });
    assert.equal(h.enters.length, before, "no web call");
    assert.equal(s.drops.size, 0, "a refused first member holds nothing");
    // A solo raider still fits in the last seats.
    await h.dir.admit(ticket(s.matchId));

    // A fresh shard with exactly a party's room left: the first member gets in and holds 3 seats.
    const g = harness(WC.startAt + 60_000);
    await g.dir.start();
    const gs = g.dir.shardOfCycle(K)!;
    const gm = gs.room.match as Match;
    while (gm.humansOnMap() < WORLD.CAPACITY - PARTY.MAX_SIZE) {
      gm.addHuman({ entryId: randomUUID(), userId: randomUUID(), nickname: "F", loadoutId: "", guest: false, level: 0, snapshot: null, pool: [], bossFill: [] });
    }
    const gm2 = (userId = randomUUID()): JoinTicket => ({ ...ticket(gs.matchId, userId), partyId, dropId });
    const lead = gm2();
    await g.dir.admit(lead);
    assert.equal(gs.drops.get(dropId)?.users.size, 1);
    const anchor = gm.currentOf(lead.userId)!.pub;
    // Everyone else sees the held seats as taken.
    await assert.rejects(g.dir.admit(ticket(gs.matchId)), { message: "world_full" });
    // The members take their held seats (no capacity refusal) and land next to the leader.
    for (let i = 0; i < PARTY.MAX_SIZE - 1; i++) {
      const t = gm2();
      await g.dir.admit(t);
      const rt = gm.currentOf(t.userId)!;
      const d = Math.hypot(rt.pub.x - anchor.x, rt.pub.y - anchor.y);
      assert.ok(d >= PARTY_SPAWN_MIN_PX && d <= PARTY_SPAWN_MAX_PX, `member ${i + 1} ${d.toFixed(0)} px from the leader`);
      assert.equal(rt.partyId, partyId);
      assert.equal(rt.dropId, dropId);
    }
    assert.equal(gm.humansOnMap(), WORLD.CAPACITY);
    // A fifth ticket of the drop has no held seat left: the normal check.
    await assert.rejects(g.dir.admit(gm2()), /world_full/);
    g.dir.stop();

    // A refused first member gives the drop back; a refused later member gives their seat back.
    const r = harness(WC.startAt + 60_000, {
      enterRaid: async (req) => (req.userId === refuse ? { ...accepted(), status: "rejected", reason: "entry_limit" } : accepted()),
    });
    await r.dir.start();
    const rs = r.dir.shardOfCycle(K)!;
    const rDrop = randomUUID();
    const rt = (userId = randomUUID()): JoinTicket => ({ ...ticket(rs.matchId, userId), partyId, dropId: rDrop });
    const first = rt();
    refuse = first.userId;
    await assert.rejects(r.dir.admit(first), /entry_limit/);
    assert.equal(rs.drops.size, 0);
    refuse = null;
    await r.dir.admit(first);
    const late = rt();
    refuse = late.userId;
    await assert.rejects(r.dir.admit(late), /entry_limit/);
    assert.deepEqual([...rs.drops.get(rDrop)!.users], [first.userId]);

    // Held seats expire with the drop window.
    const e = harness(WC.startAt + 60_000);
    await e.dir.start();
    const es = e.dir.shardOfCycle(K)!;
    const em = es.room.match as Match;
    while (em.humansOnMap() < WORLD.CAPACITY - PARTY.MAX_SIZE) {
      em.addHuman({ entryId: randomUUID(), userId: randomUUID(), nickname: "F", loadoutId: "", guest: false, level: 0, snapshot: null, pool: [], bossFill: [] });
    }
    await e.dir.admit({ ...ticket(es.matchId), partyId, dropId });
    await assert.rejects(e.dir.admit(ticket(es.matchId)), /world_full/);
    await e.time.advance(PARTY.DROP_TTL_MS + 1);
    await e.dir.admit(ticket(es.matchId));
    assert.equal(es.drops.size, 0);
    e.dir.stop();
    r.dir.stop();
    h.dir.stop();
  }));
