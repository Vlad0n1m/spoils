import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { matchMaker, type Room } from "@colyseus/core";
import { MATCH, ROOMS, type JoinTicket } from "@extract/shared";
import { signJoinTicket } from "../auth/ticket.js";
import { BattleRoom, sanitizeRoster } from "./battle-room.js";
import { MatchmakingRoom } from "./matchmaking-room.js";
import { parseInvDrop, parseInvMove } from "./inventory-handlers.js";
import { LAUNCH_KEY, isLaunchKey } from "./room-auth.js";
import { expectedMapHash } from "../sim/match.js";

/**
 * The matchmaker as POST /matchmake/* drives it (no WebSocket needed): every check here must hold
 * before a room is created or a seat is reserved, since a reserved seat already counts toward maxClients.
 */

const SECRET = "rooms-test-secret-0123456789abcdef";
const prevSecret = process.env.GAME_SERVER_HMAC_SECRET;
const opened: string[] = [];

const ticket = (userId: string): JoinTicket =>
  signJoinTicket({ userId, nickname: userId.slice(0, 12), issuedAt: Date.now() }, SECRET);

const roster = [
  { userId: "alice", nickname: "Alice" },
  { userId: "bob", nickname: "Bob" },
];

async function listing(roomId: string) {
  const [r] = await matchMaker.query({ roomId });
  return r;
}

async function launchBattle(): Promise<string> {
  const room = await matchMaker.createRoom(ROOMS.BATTLE, { roster, launchKey: LAUNCH_KEY });
  opened.push(room.roomId);
  return room.roomId;
}

before(async () => {
  process.env.GAME_SERVER_HMAC_SECRET = SECRET;
  await matchMaker.setup();
  matchMaker.defineRoomType(ROOMS.MATCHMAKING, MatchmakingRoom);
  matchMaker.defineRoomType(ROOMS.BATTLE, BattleRoom);
});

after(async () => {
  for (const roomId of opened) {
    const room = matchMaker.getLocalRoomById(roomId) as unknown as
      | (Room & { reservedSeatTimeouts: Record<string, NodeJS.Timeout> })
      | undefined;
    if (!room) continue;
    for (const t of Object.values(room.reservedSeatTimeouts)) clearTimeout(t);
    await room.disconnect();
  }
  if (prevSecret === undefined) delete process.env.GAME_SERVER_HMAC_SECRET;
  else process.env.GAME_SERVER_HMAC_SECRET = prevSecret;
  // matchMaker.setup() loads @pm2/io (a Colyseus dependency), whose metric intervals keep the
  // process alive; stop them so the test file can exit.
  const pm2 = createRequire(import.meta.resolve("@colyseus/core"))("@pm2/io") as { destroy(): void };
  pm2.destroy();
});

test("launch key: only the exact process secret passes", () => {
  assert.equal(isLaunchKey(LAUNCH_KEY), true);
  assert.equal(isLaunchKey(undefined), false);
  assert.equal(isLaunchKey(""), false);
  assert.equal(isLaunchKey(LAUNCH_KEY.slice(1)), false);
  assert.equal(isLaunchKey(`${LAUNCH_KEY.slice(0, -1)}${LAUNCH_KEY.endsWith("0") ? "1" : "0"}`), false);
  assert.equal(isLaunchKey({ toString: () => LAUNCH_KEY }), false);
});

test("battle patches are tick-driven (patchRate null) and a refused create throws before any state", () => {
  const room = new BattleRoom() as unknown as BattleRoom & { __init(): void; patchRate: number | null };
  room.__init();
  assert.equal(room.patchRate, null, "no automatic patch interval: tick() sends patches after syncViews");
  assert.throws(() => room.onCreate({ roster, launchKey: "nope" } as never), /not launched by matchmaking/);
  assert.equal(room.patchRate, null);
  assert.equal((room as unknown as { state?: unknown }).state, undefined);
});

test("roster sanitizing: humans only (a bot entry refuses the roster), loadoutIds kept, ≤ MATCH.MAX_HUMANS distinct users", () => {
  const r = sanitizeRoster([
    { userId: "alice", nickname: "Alice", loadoutId: "L-1" },
    { userId: "bob", nickname: "Bob", isBot: false },
  ])!;
  assert.deepEqual(r.map((e) => e.loadoutId), ["L-1", ""]);
  assert.ok(r.every((e) => !("isBot" in e)));
  assert.equal(sanitizeRoster([{ userId: "alice", nickname: "Alice" }, { userId: null, nickname: "Bot", isBot: true, loadoutId: "L-evil" }]), null, "no bot entries");
  assert.equal(sanitizeRoster([{ userId: "a", nickname: "A", isBot: false }, { userId: "a", nickname: "B", isBot: false }]), null);
  assert.equal(sanitizeRoster([{ userId: null, nickname: "Nobody" }]), null, "every seat is a user");
  assert.equal(sanitizeRoster([]), null);
  const full = Array.from({ length: MATCH.MAX_HUMANS }, (_, i) => ({ userId: `u${i}`, nickname: `U${i}` }));
  assert.equal(sanitizeRoster(full)!.length, MATCH.MAX_HUMANS);
  assert.equal(sanitizeRoster([...full, { userId: "x", nickname: "X" }]), null, "never a bigger match");
});

test("a client cannot create a battle or choose its roster", async () => {
  const before = (await matchMaker.query({ name: ROOMS.BATTLE })).length;
  // No ticket: rejected by the static onAuth before anything is created.
  await assert.rejects(matchMaker.create(ROOMS.BATTLE, { roster }, {} as never), /onAuth|invalid_ticket/);
  await assert.rejects(matchMaker.joinOrCreate(ROOMS.BATTLE, { roster }, {} as never), /onAuth|invalid_ticket/);
  // A valid ticket still cannot create one: onCreate demands the launch key.
  await assert.rejects(
    matchMaker.create(ROOMS.BATTLE, { roster, ticket: ticket("alice"), mapHash: expectedMapHash() }, {} as never),
    /not launched by matchmaking/,
  );
  await assert.rejects(
    matchMaker.create(ROOMS.BATTLE, { roster, ticket: ticket("alice"), launchKey: "guess", mapHash: expectedMapHash() }, {} as never),
    /not launched by matchmaking/,
  );
  assert.equal((await matchMaker.query({ name: ROOMS.BATTLE })).length, before);
});

test("battle seats: only roster players with a ticket, one pending seat each", async () => {
  const roomId = await launchBattle();
  // Two humans in the roster, ×2 for a reconnect racing its stale socket.
  assert.equal((await listing(roomId))?.maxClients, 4);

  await assert.rejects(matchMaker.joinById(roomId, {}, {} as never), /onAuth|invalid_ticket/);
  await assert.rejects(matchMaker.joinOrCreate(ROOMS.BATTLE, {}, {} as never), /onAuth|invalid_ticket/);
  // Valid ticket, wrong roster: no seat in this room.
  await assert.rejects(matchMaker.joinById(roomId, { ticket: ticket("mallory"), mapHash: expectedMapHash() }, {} as never), /already full/);
  assert.equal((await listing(roomId))?.clients, 0);

  // The roster player may retry as often as needed: each new reservation replaces the pending one.
  for (let i = 0; i < 5; i++) {
    const res = await matchMaker.joinById(roomId, { ticket: ticket("alice"), mapHash: expectedMapHash() }, {} as never);
    assert.equal(res.room.roomId, roomId);
  }
  const l = await listing(roomId);
  assert.equal(l?.clients, 1);
  assert.equal(l?.locked, false);
});

test("battle join: a missing or different mapHash is refused before any seat (WP-M2)", async () => {
  const roomId = await launchBattle();
  const hash = expectedMapHash();
  assert.match(hash ?? "", /^[0-9a-f]{8}$/, "the default (Steppe) map has a single golden hash");
  await assert.rejects(matchMaker.joinById(roomId, { ticket: ticket("alice") }, {} as never), /map_mismatch/);
  await assert.rejects(matchMaker.joinById(roomId, { ticket: ticket("alice"), mapHash: "deadbeef" }, {} as never), /map_mismatch/);
  assert.equal((await listing(roomId))?.clients, 0, "no seat was reserved");
  const res = await matchMaker.joinById(roomId, { ticket: ticket("alice"), mapHash: hash }, {} as never);
  assert.equal(res.room.roomId, roomId);
});

test("queue seats: a ticket is required and one user cannot fill the queue", async () => {
  await assert.rejects(matchMaker.joinOrCreate(ROOMS.MATCHMAKING, {}, {} as never), /onAuth|invalid_ticket/);

  const first = await matchMaker.joinOrCreate(ROOMS.MATCHMAKING, { ticket: ticket("bob") }, {} as never);
  opened.push(first.room.roomId);
  for (let i = 0; i < 40; i++) {
    const res = await matchMaker.joinOrCreate(ROOMS.MATCHMAKING, { ticket: ticket("bob") }, {} as never);
    assert.equal(res.room.roomId, first.room.roomId, "the same queue keeps being found");
  }
  const l = await listing(first.room.roomId);
  assert.equal(l?.clients, 1);
  assert.equal(l?.locked, false);

  const carol = await matchMaker.joinOrCreate(ROOMS.MATCHMAKING, { ticket: ticket("carol") }, {} as never);
  assert.equal(carol.room.roomId, first.room.roomId);
  assert.equal((await listing(first.room.roomId))?.clients, 2);
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
