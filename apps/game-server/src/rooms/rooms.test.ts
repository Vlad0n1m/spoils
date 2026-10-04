/**
 * T16 (WORLD v6, spec §9): a real Colyseus Server with the world directory, driven by the real
 * colyseus.js client (the web app's copy) over HTTP + WebSocket, against a stubbed web API (a local
 * HTTP server answering the HMAC routes). The world clock is shifted (WORLD_DEV_CLOCK_OFFSET_MS,
 * addendum A1) to 5 minutes into the current cycle, so entry is open whatever the real time is.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { Encoder } from "@colyseus/schema";
import { CLOSE_CODES, NET, S2C, WORLD, worldCycleAt, type JoinTicket, type JoinedMsg, type OutcomeMsg } from "@extract/shared";

// As in index.ts: before anything can create a room or a serializer.
Encoder.BUFFER_SIZE = NET.ENCODER_BUFFER_BYTES;

const { Server, matchMaker } = await import("@colyseus/core");
const { WebSocketTransport } = await import("@colyseus/ws-transport");
const { defineRooms, EXPOSED_METHODS } = await import("./define.js");
const { sanitizeWorld } = await import("./battle-room.js");
const { parseInvDrop, parseInvMove } = await import("./inventory-handlers.js");
const { LAUNCH_KEY, isLaunchKey } = await import("./room-auth.js");
const { signJoinTicket } = await import("../auth/ticket.js");
const { expectedMapHash } = await import("../sim/match.js");
const { killPlayer } = await import("../sim/death.js");
const { worldDirectory } = await import("../world/directory.js");
type Shard = NonNullable<ReturnType<typeof worldDirectory.current>>;
type MatchT = import("../sim/match.js").Match;
type PartyWireMsg = import("../sim/party.js").PartyWireMsg;

/** colyseus.js as the web app ships it (the game server has no client dependency of its own). */
interface SdkRoom {
  sessionId: string;
  onMessage(type: string, cb: (msg: unknown) => void): void;
  onLeave(cb: (code: number) => void): void;
  leave(consented?: boolean): Promise<number>;
}
interface SdkClient {
  joinById(roomId: string, options?: unknown): Promise<SdkRoom>;
  create(name: string, options?: unknown): Promise<SdkRoom>;
  joinOrCreate(name: string, options?: unknown): Promise<SdkRoom>;
}
const webRequire = createRequire(new URL("../../../web/package.json", import.meta.url));
const sdk = (await import(pathToFileURL(webRequire.resolve("colyseus.js")).href)) as { Client: new (url: string) => SdkClient };

const SECRET = "rooms-test-secret-0123456789abcdef";
const saved: Record<string, string | undefined> = {};
function setEnv(k: string, v: string | undefined) {
  if (!(k in saved)) saved[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

// ---------------------------------------------------------------- stub web API

type Reply = { status: number; body: unknown };
const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
let enterReply: (body: Record<string, unknown>) => Reply = () => ({
  status: 200,
  body: { status: "accepted", snapshot: null, level: 3, guest: false, pool: [], bossFill: [], autosellMult: 1 },
});
let exitReply: (body: Record<string, unknown>) => Reply = () => ({ status: 200, body: { credits: 0, sold: [], guest: false } });
const countOf = (path: string) => calls.filter((c) => c.path === path).length;

let web: HttpServer;
let http: HttpServer;
let gameServer: InstanceType<typeof Server>;
let client: SdkClient;
let shard: Shard;
let match: MatchT;
const joined: SdkRoom[] = [];

function startWeb(): Promise<number> {
  web = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const path = req.url ?? "";
      const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
      calls.push({ path, body });
      let r: Reply = { status: 200, body: { ok: true } };
      if (path === "/api/raids/open") r = { status: 200, body: { status: "opened", autosellMult: 1 } };
      else if (path === "/api/raids/enter") r = enterReply(body);
      else if (path === "/api/raids/exit") r = exitReply(body);
      res.statusCode = r.status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(r.body));
    });
  });
  return new Promise((resolve) => web.listen(0, "127.0.0.1", () => resolve((web.address() as AddressInfo).port)));
}

const ticket = (userId: string, o: Partial<{ matchId: string; entryId: string; loadoutId: string; nickname: string }> = {}): JoinTicket =>
  signJoinTicket(
    { userId, nickname: o.nickname ?? `u${userId.slice(0, 6)}`, issuedAt: Date.now(), matchId: shard.matchId, entryId: randomUUID(), ...o },
    SECRET,
  );

async function join(t: unknown, mapHash: unknown = expectedMapHash()): Promise<SdkRoom> {
  const r = await client.joinById(shard.roomId, { ticket: t, mapHash });
  r.onMessage(S2C.EV, () => {});
  joined.push(r);
  return r;
}

/** Join and wait for the JOINED message. */
async function joinAndHello(t: JoinTicket): Promise<{ room: SdkRoom; hello: JoinedMsg }> {
  const room = await join(t);
  const hello = await new Promise<JoinedMsg>((resolve, reject) => {
    const to = setTimeout(() => reject(new Error("no JOINED")), 5_000);
    room.onMessage(S2C.JOINED, (m) => {
      clearTimeout(to);
      resolve(m as JoinedMsg);
    });
  });
  return { room, hello };
}

async function listing() {
  const [r] = await matchMaker.query({ roomId: shard.roomId });
  return r!;
}

function filler(userId = randomUUID()) {
  return match.addHuman({ entryId: randomUUID(), userId, nickname: "Filler", loadoutId: "", guest: false, level: 0, snapshot: null, pool: [], bossFill: [] });
}

const waitFor = async (cond: () => boolean, ms = 5_000) => {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

before(async () => {
  const webPort = await startWeb();
  setEnv("GAME_SERVER_HMAC_SECRET", SECRET);
  setEnv("WEB_API_BASE_URL", `http://127.0.0.1:${webPort}`);
  setEnv("NODE_ENV", "test");
  // 5 minutes into the current cycle: entry open, far from the wipe.
  const now = Date.now();
  setEnv("WORLD_DEV_CLOCK_OFFSET_MS", String(worldCycleAt(now).startAt + 5 * 60_000 - now));

  http = createServer();
  gameServer = new Server({ transport: new WebSocketTransport({ server: http }), gracefullyShutdown: false, greet: false });
  defineRooms(gameServer);
  await gameServer.listen(0);
  client = new sdk.Client(`ws://127.0.0.1:${(http.address() as AddressInfo).port}`);

  await worldDirectory.start();
  shard = worldDirectory.current()!;
  assert.ok(shard, "the current cycle's shard is open after start()");
  match = shard.room.match as MatchT;
  await waitFor(() => shard.registered);
});

after(async () => {
  worldDirectory.stop();
  // leave() of a connection the server already closed never settles: do not wait for it.
  for (const r of joined) await Promise.race([r.leave().catch(() => {}), new Promise((res) => setTimeout(res, 200))]);
  const room = matchMaker.getLocalRoomById(shard.roomId) as unknown as
    | { reservedSeatTimeouts: Record<string, NodeJS.Timeout>; disconnect(): Promise<void> }
    | undefined;
  if (room) {
    for (const t of Object.values(room.reservedSeatTimeouts)) clearTimeout(t);
    await room.disconnect();
  }
  gameServer.transport.shutdown();
  http.close(() => {});
  web.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  // matchMaker.setup() loads @pm2/io (a Colyseus dependency), whose metric intervals keep the
  // process alive; stop them so the test file can exit.
  const pm2 = createRequire(import.meta.resolve("@colyseus/core"))("@pm2/io") as { destroy(): void };
  pm2.destroy();
  // Server.listen → matchMaker.accept() starts the stats auto-persist interval (not exported by index).
  const stats = (await import(new URL("./Stats.mjs", import.meta.resolve("@colyseus/core")).href)) as { clearAutoPersistInterval(): void };
  stats.clearAutoPersistInterval();
});

test("boot: the directory opens the current cycle's shard and registers it with raids/open", async () => {
  const open = calls.find((c) => c.path === "/api/raids/open")!;
  const wc = worldCycleAt(Date.now() + Number(process.env.WORLD_DEV_CLOCK_OFFSET_MS));
  assert.equal(open.body.matchId, shard.matchId);
  assert.equal(open.body.roomId, shard.roomId);
  assert.equal(open.body.cycleId, wc.cycle);
  assert.equal(open.body.startsAt, wc.startAt);
  assert.equal(open.body.entryClosesAt, wc.entryClosesAt);
  assert.equal(open.body.endsAt, wc.wipeAt);
  assert.equal(match.state.cycleId, wc.cycle);
  assert.equal(match.state.phase, "open");
  const l = await listing();
  assert.deepEqual(l.metadata, { matchId: shard.matchId, cycleId: wc.cycle });
  assert.ok(!Number.isFinite(l.maxClients), "maxClients stays Infinity: capacity is the directory's");
});

test("joinById with a valid ticket runs the admission in onAuth (raids/enter) and joins", async () => {
  const userId = randomUUID();
  const t = ticket(userId, { nickname: "Alice" });
  const { hello } = await joinAndHello(t);
  assert.equal(hello.matchId, shard.matchId);
  assert.equal(hello.entryId, t.entryId);
  assert.equal(hello.cycleId, match.state.cycleId);
  const enter = calls.filter((c) => c.path === "/api/raids/enter").at(-1)!;
  assert.equal(enter.body.matchId, shard.matchId);
  assert.equal(enter.body.entryId, t.entryId);
  assert.equal(enter.body.userId, userId);
  assert.equal(enter.body.loadoutId, "");
  assert.ok(Math.abs((enter.body.atMs as number) - 5 * 60_000) < 30_000, "atMs = the cycle clock at admission");
  assert.equal(typeof enter.body.targets, "number");
  assert.equal(typeof enter.body.bossAlive, "boolean");
  const rt = match.currentOf(userId)!;
  assert.ok(rt.pub.alive && rt.connected);
  assert.equal(rt.level, 3, "level from the web's EntryResponse");
  assert.equal(rt.selfKey, hello.selfKey);
});

test("refusals before any seat: no ticket, a map hash mismatch, a ticket for another map", async () => {
  const before = (await listing()).clients;
  await assert.rejects(join(undefined), /invalid_ticket/);
  await assert.rejects(join(ticket(randomUUID()), null), /map_mismatch/, "missing map hash");
  await assert.rejects(join(ticket(randomUUID()), "deadbeef"), /map_mismatch/);
  // A valid ticket of a stranger for a matchId this server does not run.
  await assert.rejects(join(ticket(randomUUID(), { matchId: randomUUID() })), /map_gone/);
  // A legacy ticket (no matchId / entryId).
  await assert.rejects(join(signJoinTicket({ userId: randomUUID(), nickname: "Old", issuedAt: Date.now() }, SECRET)), /map_gone/);
  assert.equal((await listing()).clients, before, "no seat was reserved");
});

test("rejoin of an alive runtime skips the web and replaces the first connection", async () => {
  const userId = randomUUID();
  const t = ticket(userId);
  const first = await joinAndHello(t);
  const enters = countOf("/api/raids/enter");
  const closed = new Promise<number>((resolve) => first.room.onLeave(resolve));
  const second = await joinAndHello(ticket(userId, { entryId: t.entryId }));
  assert.equal(countOf("/api/raids/enter"), enters, "no raids/enter for a rejoin");
  assert.equal(second.hello.selfKey, first.hello.selfKey, "the same runtime");
  assert.equal(await closed, CLOSE_CODES.JOINED_ELSEWHERE);
  assert.equal(match.currentOf(userId)!.id, second.room.sessionId);
});

test("exit_settling for a known entry that left; a new entry re-enters; the receipt is routed by entryId", async () => {
  const userId = randomUUID();
  const t = ticket(userId);
  const { room } = await joinAndHello(t);
  const outcomes: OutcomeMsg[] = [];
  room.onMessage(S2C.OUTCOME, (m) => outcomes.push(m as OutcomeMsg));
  exitReply = (b) => ({
    status: 200,
    body: b.entryId === t.entryId
      ? { credits: 7, sold: [], guest: false, xp: 120, xpLines: [{ key: "npc", qty: 1, xp: 20 }, { key: "bogus", qty: 1, xp: 5 }], level: 4, levelUp: true }
      : { credits: 0, sold: [], guest: false },
  });
  killPlayer(match, match.currentOf(userId)!, null, "");
  await waitFor(() => outcomes.some((o) => o.xp === 120));
  const settled = outcomes.find((o) => o.xp === 120)!;
  assert.equal(settled.exit, "dead");
  assert.equal(settled.credits, 7);
  assert.deepEqual(settled.xpLines, [{ key: "npc", qty: 1, xp: 20 }], "unknown XP keys are dropped");
  assert.equal(settled.level, 4);
  assert.equal(settled.levelUp, true);
  assert.equal(match.entryById(t.entryId!)!.exitSettled, true);
  const exit = calls.find((c) => c.path === "/api/raids/exit" && c.body.entryId === t.entryId)!;
  assert.equal(exit.body.userId, userId);

  const enters = countOf("/api/raids/enter");
  await assert.rejects(join(ticket(userId, { entryId: t.entryId })), /exit_settling/);
  assert.equal(countOf("/api/raids/enter"), enters);
  // Re-entry (D5): a new entryId puts a new runtime on the map.
  const again = await joinAndHello(ticket(userId));
  assert.notEqual(again.hello.selfKey, match.entryById(t.entryId!)!.selfKey);
  assert.equal(match.currentOf(userId)!.pub.alive, true);
});

test("web answers map to WORLD_JOIN_ERR codes; a rejected entry leaves nothing on the map", async () => {
  const cases: Array<[Reply, RegExp]> = [
    [{ status: 200, body: { status: "rejected", reason: "entry_limit", snapshot: null, level: 0, guest: false, pool: [], bossFill: [], autosellMult: 1 } }, /entry_limit/],
    [{ status: 200, body: { status: "rejected", reason: "already_active", snapshot: null, level: 0, guest: false, pool: [], bossFill: [], autosellMult: 1 } }, /in_raid/],
    [{ status: 200, body: { status: "rejected", reason: "expired", snapshot: null, level: 0, guest: false, pool: [], bossFill: [], autosellMult: 1 } }, /loadout_rejected:expired/],
    [{ status: 200, body: { status: "rejected", reason: "shard_closed", snapshot: null, level: 0, guest: false, pool: [], bossFill: [], autosellMult: 1 } }, /map_gone/],
    [{ status: 400, body: { error: "bad_body" } }, /web_unavailable/],
  ];
  const prev = enterReply;
  const prevErr = console.error;
  console.error = () => {};
  try {
    for (const [reply, re] of cases) {
      enterReply = () => reply;
      const userId = randomUUID();
      await assert.rejects(join(ticket(userId)), re);
      assert.equal(match.currentOf(userId), undefined);
    }
  } finally {
    enterReply = prev;
    console.error = prevErr;
  }
});

test("entry_closed outside the open phase (A1 clock offset)", async () => {
  const offset = process.env.WORLD_DEV_CLOCK_OFFSET_MS!;
  const now = Date.now();
  setEnv("WORLD_DEV_CLOCK_OFFSET_MS", String(shard.wc.entryClosesAt + 1_000 - now));
  try {
    await assert.rejects(join(ticket(randomUUID())), /entry_closed/);
  } finally {
    setEnv("WORLD_DEV_CLOCK_OFFSET_MS", offset);
  }
});

test("party tickets: a drop's members land together and get S2C.PARTY with each other only; a solo raider gets none", async () => {
  const partyId = randomUUID();
  const dropId = randomUUID();
  const member = (nickname: string) =>
    signJoinTicket({ userId: randomUUID(), nickname, issuedAt: Date.now(), matchId: shard.matchId, entryId: randomUUID(), dropId, partyId }, SECRET);
  const got = new Map<string, PartyWireMsg[]>();
  const listen = (who: string, room: SdkRoom) =>
    room.onMessage(S2C.PARTY, (m) => {
      const list = got.get(who) ?? [];
      list.push(m as PartyWireMsg);
      got.set(who, list);
    });
  const lead = member("Lead");
  const mate = member("Mate");
  const L = await joinAndHello(lead);
  listen("lead", L.room);
  const M = await joinAndHello(mate);
  listen("mate", M.room);
  const S = await joinAndHello(ticket(randomUUID(), { nickname: "Solo" }));
  listen("solo", S.room);
  const a = match.currentOf(lead.userId)!;
  const b = match.currentOf(mate.userId)!;
  assert.equal(a.partyId, partyId);
  assert.equal(b.dropId, dropId);
  const d = Math.hypot(a.pub.x - b.pub.x, a.pub.y - b.pub.y);
  assert.ok(d >= 150 && d <= 300, `the mate landed ${d.toFixed(0)} px from the leader`);
  await waitFor(() => (got.get("lead")?.length ?? 0) > 0 && (got.get("mate")?.length ?? 0) > 0);
  const toLead = got.get("lead")!.at(-1)!;
  assert.deepEqual(toLead.mates.map((x) => [x.key, x.name, x.alive]), [[M.hello.selfKey, "Mate", true]]);
  assert.deepEqual(got.get("mate")!.at(-1)!.mates.map((x) => x.key), [L.hello.selfKey]);
  // About PARTY.POS_HZ, and never to anyone outside the party.
  await new Promise((r) => setTimeout(r, 1_100));
  assert.equal(got.get("solo"), undefined);
  const n = got.get("lead")!.length;
  assert.ok(n >= 2 && n <= 5, `${n} party messages in ~1.5 s`);
});

test("world_full at WORLD.CAPACITY humans on the map, without a web call", async () => {
  while (match.humansOnMap() < WORLD.CAPACITY) filler();
  const enters = countOf("/api/raids/enter");
  await assert.rejects(join(ticket(randomUUID())), /world_full/);
  assert.equal(countOf("/api/raids/enter"), enters);
});

test("57 seats of users on the map do not lock the room (maxClients Infinity)", async () => {
  const users: string[] = [];
  for (let i = 0; i < 57; i++) {
    const userId = randomUUID();
    filler(userId);
    users.push(userId);
  }
  const before = (await listing()).clients;
  for (const userId of users) {
    const res = await matchMaker.joinById(shard.roomId, { ticket: ticket(userId), mapHash: expectedMapHash() }, {} as never);
    assert.equal(res.room.roomId, shard.roomId);
  }
  const l = await listing();
  assert.equal(l.clients, before + 57);
  assert.equal(l.locked, false);
  // A user without a runtime on this map never gets a seat, whatever the ticket says.
  const room = matchMaker.getLocalRoomById(shard.roomId) as unknown as { _reserveSeat(s: string, o: unknown, a: unknown): Promise<boolean> };
  assert.equal(await room._reserveSeat("x1", {}, { userId: randomUUID() }), false);
});

test("create / joinOrCreate are not exposed; battle creation needs the launch key", async () => {
  assert.deepEqual([...EXPOSED_METHODS], ["joinById"]);
  await assert.rejects(client.create("battle", { ticket: ticket(randomUUID()), mapHash: expectedMapHash() }), /invalid method/);
  await assert.rejects(client.joinOrCreate("battle", { ticket: ticket(randomUUID()), mapHash: expectedMapHash() }), /invalid method/);
  // Even through the server-side matchmaker, a battle cannot be created without the launch key.
  await assert.rejects(matchMaker.createRoom("battle", { world: { matchId: randomUUID() } }), /not launched by the world directory/);
  assert.equal(isLaunchKey(LAUNCH_KEY), true);
  assert.equal(isLaunchKey(LAUNCH_KEY.slice(1)), false);
  assert.equal(isLaunchKey({ toString: () => LAUNCH_KEY }), false);
});

test("world create options are sanitized", () => {
  const ok = {
    matchId: randomUUID(), cycleId: 5, shard: 0, cycleStartsAt: 5 * WORLD.CYCLE_MS, entryCloseMs: WORLD.CYCLE_MS - WORLD.ENTRY_CLOSE_MS,
    matchSeed: 1, lootSeed: 2, envSeed: 3, bossEvent: "warden", mode: "live",
  };
  assert.deepEqual(sanitizeWorld(ok), ok);
  assert.equal(sanitizeWorld({ ...ok, matchId: "m-1" }), null);
  assert.equal(sanitizeWorld({ ...ok, bossEvent: "dragon" }), null);
  assert.equal(sanitizeWorld({ ...ok, lootSeed: -1 }), null);
  assert.equal(sanitizeWorld({ ...ok, entryCloseMs: WORLD.CYCLE_MS + 1 }), null);
  assert.equal(sanitizeWorld({ ...ok, mode: "free" }), null);
  assert.equal(sanitizeWorld(null), null);
  assert.deepEqual(sanitizeWorld({ ...ok, bossEvent: null }), { ...ok, bossEvent: null });
});

test("inventory message shapes are validated before they reach the sim", () => {
  assert.deepEqual(parseInvMove({ from: "self", key: "p0", uid: "", def: "ammo_light", to: "p2", qty: 5 }),
    { from: "self", key: "p0", uid: "", def: "ammo_light", to: "p2", qty: 5 });
  assert.equal(parseInvMove({ from: "ground", key: "p0", uid: "", def: "x" }), null);
  assert.equal(parseInvMove({ from: "self", key: "p0", uid: "", def: "x", to: "b16" }), null);
  assert.equal(parseInvMove({ from: "self", key: "p0", uid: "", def: "x", qty: 0 }), null);
  assert.equal(parseInvMove({ from: "self", key: "p0", uid: "u".repeat(65), def: "x" }), null);
  assert.equal(parseInvMove(null), null);
  assert.deepEqual(parseInvDrop({ key: "w1", uid: "a", def: "rifle" }), { key: "w1", uid: "a", def: "rifle" });
  assert.equal(parseInvDrop({ key: "constructor", uid: "", def: "x" }), null);
  assert.equal(parseInvDrop({ key: "p1", uid: "", def: "x", qty: 1.5 }), null);
});
