/**
 * WORLD v6 sim (spec §3.4 / §3.5, tests T6–T12) and addendum A6 (ground / corpse expiry): the
 * world-mode Match driven by an injected wall clock, entries, the personal extract arm, ledger
 * lives, the wipe, server-side pool placement, the late-join spawn and expiry to the treasury.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { NPC_ROLE, POOL, SERVER_TICK_MS, WORLD, type ContainerSpot, type MapData, type MapSide, type SlotKey } from "@extract/shared";
import { killPlayer } from "./death.js";
import { extractPlayer } from "./extraction.js";
import { spawnGroundItem } from "./inventory.js";
import { makeItem } from "./items.js";
import type { Match } from "./match.js";
import { chooseSpawn } from "./spawn.js";
import {
  WORLD_T0,
  addExtract,
  advance,
  enter,
  giveStack,
  jump,
  npcOpts,
  poolItem,
  snapshotOf,
  testMap,
  testMatch,
  testPost,
  worldMatch,
  type TestMapOpts,
} from "./test-utils.js";
import type { PlayerRuntime } from "./types.js";

/** The open arena with spawn spots at the four corners and the centre. */
function arenaMap(o: TestMapOpts & Partial<Pick<MapData, "extracts" | "bosses">> = {}): MapData {
  const map = testMap(o);
  map.spawns = [
    { x: 500, y: 500, side: 0 as MapSide },
    { x: 4300, y: 500, side: 0 as MapSide },
    { x: 500, y: 4300, side: 0 as MapSide },
    { x: 4300, y: 4300, side: 0 as MapSide },
    { x: 2400, y: 2400, side: 0 as MapSide },
  ];
  if (o.extracts) map.extracts = o.extracts;
  if (o.bosses) map.bosses = o.bosses;
  return map;
}

/** A T3 crate (pool-eligible) in the north-east. */
const C0: ContainerSpot = { x: 4000, y: 1000, kind: "crate", tier: 3, zone: null };

function put(rt: PlayerRuntime, x: number, y: number): void {
  rt.pub.x = rt.prevX = x;
  rt.pub.y = rt.prevY = y;
}

function kill(m: Match, rt: PlayerRuntime, by: PlayerRuntime | null = null): void {
  killPlayer(m, rt, by, "rifle");
  assert.equal(rt.pub.alive, false);
}

/**
 * Conservation over lives (spec §3.4): every life of every uid appears in exactly one report entry
 * (an exit report's extracted / lost / destroyed / unplaced, or the end report's leftOnMap /
 * expired / expiredToPool), and nothing is unresolved after the wipe.
 */
function assertLives(m: Match): void {
  assert.ok(m.ended, "the map was wiped");
  assert.deepEqual(m.ledgerGaps(), [], "every known uid is resolved");
  const r = m.report!;
  const seen = new Map<string, number>();
  const add = (uid: string) => uid && seen.set(uid, (seen.get(uid) ?? 0) + 1);
  for (const x of m.exitReports) for (const it of [...x.extracted, ...x.lost, ...x.destroyed, ...(x.unplaced ?? [])]) add(it.uid);
  for (const it of [...r.leftOnMap, ...(r.expired ?? []), ...(r.expiredToPool ?? [])]) add(it.uid);
  for (const uid of m.ledger.known.keys()) {
    assert.equal(seen.get(uid) ?? 0, m.ledger.livesOf(uid), `uid ${uid}: reported ${seen.get(uid) ?? 0}× for ${m.ledger.livesOf(uid)} lives`);
  }
  for (const uid of seen.keys()) assert.ok(m.ledger.known.has(uid), `unknown uid ${uid} reported`);
}

// ---------------------------------------------------------------- T6 world clock

test("T6 world clock: no step before the map opens; the clock follows the wall after a stall; never ends for lack of humans; the backstop is a wipe (MIA)", () => {
  const { m, wall } = worldMatch({ map: arenaMap(), startOffsetMs: -WORLD.PREWARM_MS });
  assert.equal(m.state.phase, "open");
  assert.equal(m.state.durationMs, WORLD.MAP_MS, "a map lives 55 min: opening → wipe");
  assert.equal(m.state.startedAt, WORLD_T0);
  assert.equal(m.state.cycleId, 1000);
  assert.equal(m.state.entryCloseMs, WORLD.MAP_MS - WORLD.ENTRY_CLOSE_MS);
  assert.equal(m.state.bossKind, "");
  assert.equal(m.state.bossState, 0);
  advance(m, wall, WORLD.PREWARM_MS - 1000);
  assert.equal(m.clock, 0, "prewarmed: nothing happens before the cycle starts");
  advance(m, wall, 2000);
  assert.equal(m.clock, wall.t - WORLD_T0);
  // A 2 s stall (event loop frozen): the next step catches the clock up to the wall.
  const before = m.clock;
  wall.t += 2000;
  m.step(SERVER_TICK_MS);
  assert.equal(m.clock, before + 2000);
  // Monotonic: a wall clock stepping back does not rewind the match.
  wall.t -= 500;
  m.step(SERVER_TICK_MS);
  assert.equal(m.clock, before + 2000);
  wall.t += 500;

  // Nobody on the map for 20 minutes: the world stays up.
  jump(m, wall, 20 * 60_000);
  assert.equal(m.ended, false);
  const a = enter(m, "ua");
  const b = enter(m, "ub");
  kill(m, b);
  jump(m, wall, 5 * 60_000);
  assert.equal(m.ended, false, "a world match never ends for lack of humans");

  // 45 minutes in: still running (the first raiders of a map get up to 55 minutes).
  wall.t = WORLD_T0 + WORLD.CYCLE_MS + 3000;
  m.step(SERVER_TICK_MS);
  assert.equal(m.ended, false, "no wipe at 45:00 of the map clock");
  wall.t = WORLD_T0 + WORLD.MAP_MS + 3000;
  const ev = (() => {
    m.step(SERVER_TICK_MS);
    return m.drainEvents();
  })();
  assert.ok(m.ended, "the backstop wiped the map");
  assert.equal(m.clock, WORLD.MAP_MS, "clamped at the map's end");
  assert.equal(m.state.phase, "ended");
  assert.equal(a.exitReport!.exit, "mia");
  assert.ok(!m.exitReports.some((x) => x.exit === "timeout"), "never a timeout in world mode");
  assert.deepEqual(m.report!.participants.map((p) => p.exitType), ["mia", "dead"]);
  assert.ok(ev.some((e) => e.type === "exit" && e.report.exit === "mia" && e.report.entryId === a.entryId));
  assert.ok(ev.some((e) => e.type === "ended"));
});

// ---------------------------------------------------------------- T7 addHuman

test("T7 addHuman: indexes after the NPCs, selfKey p<i>, currentOf = newest entry, entryById, attachHuman re-keys only the current runtime", () => {
  const { m, wall } = worldMatch({ map: arenaMap(), ...npcOpts([testPost(0, 2400, 1200)]), npcBrains: false });
  const npcs = m.npcs.runtimes();
  assert.equal(npcs.length, 1);
  assert.equal(m.allRuntimes().length, 1, "no roster: only the NPC");
  jump(m, wall, 1000);
  const a1 = enter(m, "ua");
  const b = enter(m, "ub");
  assert.equal(a1.rosterIndex, 1);
  assert.equal(b.rosterIndex, 2);
  assert.equal(a1.selfKey, "p1");
  assert.equal(a1.id, "e1");
  const s = m.state.self.get("p1")!;
  assert.equal(s.userId, "ua");
  assert.equal(s.enteredAt, m.clock);
  assert.equal(s.extractArmAt, m.clock + WORLD.EXTRACT_ARM_MS);
  assert.equal(a1.enteredAtMs, m.clock);
  assert.ok(a1.self.slots.get("w1"), "free kit");
  assert.equal(m.humansOnMap(), 2);
  assert.equal(m.state.aliveCount, 2);
  assert.notEqual(a1.pub.color, b.pub.color, "least-used palette slot");

  kill(m, a1);
  jump(m, wall, 6000);
  const a2 = enter(m, "ua");
  assert.equal(a2.rosterIndex, 3);
  assert.equal(m.currentOf("ua"), a2);
  assert.equal(m.entryById(a1.entryId), a1);
  assert.equal(m.entryById(a2.entryId), a2);
  assert.equal(m.state.totalPlayers, 3, "entries this cycle");
  assert.equal(m.state.aliveCount, 2);

  assert.equal(m.attachHuman("ua", "sess-a"), a2);
  assert.equal(a2.id, "sess-a");
  assert.equal(a2.connected, true);
  assert.equal(a1.id, "e1", "the old runtime keeps its key");
  assert.equal(m.state.players.get("sess-a"), a2.pub);
  assert.equal(m.runtime("e1"), a1);
  kill(m, a2);
  assert.equal(m.attachHuman("ua", "sess-b"), null, "a dead current runtime cannot be attached");
});

// ---------------------------------------------------------------- T8 extract arm

test("T8 extract arm: a fresh entrant cannot extract before enteredAt + 3 min while an earlier one can in the same tick; N2 / S2 close at 50:00 (5 min before the wipe)", () => {
  const extracts = [
    { id: "N1", name: "N1", x: 1200, y: 3800, r: 110, side: 2 as MapSide, kind: "always" as const },
    { id: "N2", name: "N2", x: 3600, y: 3800, r: 110, side: 2 as MapSide, kind: "always" as const, closesAtMs: 25 * 60_000 },
  ];
  const { m, wall } = worldMatch({ map: arenaMap({ extracts }), emptyWorld: false });
  const n1 = m.state.extracts.get("N1")!;
  const n2 = m.state.extracts.get("N2")!;
  assert.equal(n1.openAt, 0);
  assert.equal(n1.closeAt, 0);
  assert.equal(n2.openAt, 0);
  assert.equal(n2.closeAt, WORLD.MAP_MS - WORLD.EXTRACT_EARLY_CLOSE_MS);
  assert.equal(n2.closeAt, 50 * 60_000);

  jump(m, wall, 1000);
  const a = enter(m, "ua");
  jump(m, wall, WORLD.EXTRACT_ARM_MS);
  const b = enter(m, "ub");
  put(a, n1.x, n1.y);
  put(b, n1.x + 20, n1.y);
  advance(m, wall, 10_500);
  assert.equal(a.exitReport?.exit, "extract", "armed: extracted");
  assert.equal(b.pub.alive, true, "not armed yet: still on the map");
  assert.equal(b.self.extractStartedAt, 0, "no channel before the arm");
  jump(m, wall, WORLD.EXTRACT_ARM_MS);
  advance(m, wall, 10_500);
  assert.equal(b.exitReport?.exit, "extract");

  // N2 at 50:00: closed for everyone.
  const c = enter(m, "uc");
  wall.t = WORLD_T0 + 50 * 60_000;
  m.step(SERVER_TICK_MS);
  put(c, n2.x, n2.y);
  advance(m, wall, 12_000);
  assert.equal(c.pub.alive, true, "N2 closed at 50:00");
});

// ---------------------------------------------------------------- T9 ledger lives

test("T9 ledger lives: extract X and re-enter with it, die → two lives; a lost pool item released again is a new life; conservation after the wipe", () => {
  const { m, wall } = worldMatch({ map: arenaMap({ containers: [C0] }) });
  jump(m, wall, 1000);
  const X = "uid-life-x";
  const Y = "uid-life-y";
  const a1 = enter(m, "ua", { snapshot: snapshotOf("ua", [{ def: "rifle", key: "w1", uid: X, rarity: 2 }]) });
  jump(m, wall, WORLD.EXTRACT_ARM_MS);
  extractPlayer(m, a1);
  assert.ok(a1.exitReport!.extracted.some((i) => i.uid === X));
  assert.equal(m.ledger.resolved.get(X), "extract");

  const a2 = enter(m, "ua", { snapshot: snapshotOf("ua", [{ def: "rifle", key: "w1", uid: X, rarity: 2 }]) });
  assert.equal(m.ledger.livesOf(X), 2);
  assert.equal(m.ledger.resolved.has(X), false, "the new life is open");
  const rng = m.rng;
  m.rng = () => 0; // every unique breaks
  kill(m, a2);
  assert.ok(a2.exitReport!.lost.some((i) => i.uid === X));

  const b = enter(m, "ub", { snapshot: snapshotOf("ub", [{ def: "shotgun", key: "w1", uid: Y, rarity: 1 }]) });
  kill(m, b);
  m.rng = rng;
  assert.equal(m.ledger.resolved.get(Y), "lost");
  // The web put Y into the pool and releases it to the next entrant: a new life, placed after their death.
  const c = enter(m, "uc", { pool: [poolItem(Y, "shotgun", 1)] });
  assert.equal(m.ledger.livesOf(Y), 2);
  kill(m, c);
  jump(m, wall, 1000);
  assert.ok(m.containers.poolPlaced.has(0), "placed at once after the death");
  m.wipe();
  assertLives(m);
  assert.ok(m.report!.leftOnMap.some((i) => i.uid === Y), "the placed life is left on the map");
  assert.deepEqual(m.ledger.pastLives.map((l) => [l.uid, l.how]), [[X, "extract"], [Y, "lost"]]);
});

// ---------------------------------------------------------------- T10 wipe

test("T10 wipe: alive humans (connected or not) leave MIA with everything in lost; pending pool and boss fill are leftOnMap; the end report lists every entry", () => {
  const { m, wall } = worldMatch({ map: arenaMap() });
  jump(m, wall, 1000);
  const d = enter(m, "ud");
  kill(m, d);
  const a = enter(m, "ua", { snapshot: snapshotOf("ua", [{ def: "rifle", key: "w1", uid: "uid-wipe-a", rarity: 2 }]) });
  giveStack(m, a.id, "junk_gpu", 1);
  m.attachHuman("ua", "sess-a");
  const b = enter(m, "ub", {
    snapshot: snapshotOf("ub", [{ def: "armor_2", key: "armor", uid: "uid-wipe-b", dur: 60 }]),
    pool: [poolItem("uid-pool-p1")],
    bossFill: [poolItem("uid-boss-f1", "shotgun", 1)],
  });
  m.drainEvents();
  wall.t = WORLD_T0 + WORLD.MAP_MS;
  m.step(SERVER_TICK_MS);
  const ev = m.drainEvents();
  assert.ok(m.ended);
  for (const rt of [a, b]) {
    assert.equal(rt.exitReport!.exit, "mia");
    assert.equal(rt.outcome!.exit, "mia");
  }
  assert.ok(a.exitReport!.lost.some((i) => i.uid === "uid-wipe-a"));
  assert.ok(a.exitReport!.lost.some((i) => i.def === "junk_gpu"), "everything carried, fungibles too");
  assert.ok(b.exitReport!.lost.some((i) => i.uid === "uid-wipe-b" && i.dur === 60), "no wear");
  assert.deepEqual(b.exitReport!.unplaced, [], "MIA: nothing handed back, the pool items stay on the map");
  const r = m.report!;
  assert.ok(r.leftOnMap.some((i) => i.uid === "uid-pool-p1"), "pending pool → leftOnMap");
  assert.ok(r.leftOnMap.some((i) => i.uid === "uid-boss-f1"), "boss fill without a boss → leftOnMap");
  assert.deepEqual(r.entries, [d.entryId, a.entryId, b.entryId]);
  assert.equal(r.cycleId, 1000);
  assert.equal(r.shard, 0);
  assert.deepEqual(r.expired, []);
  assert.deepEqual(r.expiredToPool, []);
  assert.equal(r.participants.length, 3, "one row per entry");
  assert.equal(ev.filter((e) => e.type === "exit").length, 2);
  assertLives(m);
  m.wipe(); // idempotent
  assert.equal(m.report, r);
});

// ---------------------------------------------------------------- T11 pool placement

test("T11 pool placement: items wait 8 min; extract before → unplaced; death before → placed at once", () => {
  const { m, wall } = worldMatch({ map: arenaMap({ containers: [C0] }) });
  jump(m, wall, 1000);
  assert.equal(m.poolTargetCount(), 1);
  const a = enter(m, "ua", { pool: [poolItem("uid-p-wait")] });
  put(a, 500, 4300);
  jump(m, wall, POOL.APPLY_AFTER_MS - 2000);
  assert.equal(a.pendingPool.length, 1, "still waiting");
  assert.equal(m.containers.poolPlaced.size, 0);
  jump(m, wall, 3000);
  assert.equal(a.pendingPool.length, 0);
  assert.ok(m.containers.poolPlaced.has(0), "placed into the T3 crate");
  assert.equal(m.poolTargetCount(), 0, "one pool item per container per cycle");
  assert.ok(m.containers.leftInside().some((i) => i.uid === "uid-p-wait"));

  // Extract before APPLY_AFTER_MS: back in the exit report (→ pool untaxed), ledger "returned".
  const b = enter(m, "ub", { pool: [poolItem("uid-p-back")] });
  jump(m, wall, WORLD.EXTRACT_ARM_MS);
  extractPlayer(m, b);
  assert.deepEqual(b.exitReport!.unplaced, [poolItem("uid-p-back")]);
  assert.equal(m.ledger.resolved.get("uid-p-back"), "returned");
  assert.equal(b.exitReport!.entryId, b.entryId);
  assert.equal(b.exitReport!.enteredAtMs, b.enteredAtMs);
});

test("T11 pool placement: never within 1500 px of a human (retry every 10 s); one per container; carriers get one", () => {
  const post = testPost(0, 1500, 4000, { tier: 3, kind: "poi" });
  const { m, wall } = worldMatch({ map: arenaMap({ containers: [C0] }), ...npcOpts([post]), npcBrains: false });
  const npc = m.npcs.runtimes()[0]!;
  jump(m, wall, 1000);
  assert.equal(m.poolTargetCount(), 2, "the crate and the T3 marauder");
  const guard = enter(m, "uguard");
  put(guard, C0.x, C0.y + 200);
  const watcher = enter(m, "uwatch");
  put(watcher, npc.pub.x + 300, npc.pub.y);
  const a = enter(m, "ua", { pool: [poolItem("uid-p-1"), poolItem("uid-p-2"), poolItem("uid-p-3")] });
  put(a, 500, 500);
  kill(m, a);
  jump(m, wall, 1000);
  assert.equal(m.unplacedPool.length, 3, "every target is within 1500 px of a human");
  put(guard, 500, 2400);
  put(watcher, 2400, 500);
  jump(m, wall, 5000);
  assert.equal(m.unplacedPool.length, 3, "retry waits PLACE_RETRY_MS");
  jump(m, wall, POOL.PLACE_RETRY_MS);
  assert.equal(m.unplacedPool.length, 1, "one into the crate, one onto the carrier, the third waits");
  assert.ok(m.containers.poolPlaced.has(0));
  const carried = [...npc.self.slots.values()].filter((i) => i.uid.startsWith("uid-p-"));
  assert.equal(carried.length, 1, "a carrier gets exactly one");
  jump(m, wall, 60_000);
  assert.equal(m.unplacedPool.length, 1, "no valid target left");
  m.wipe();
  const left = m.report!.leftOnMap.map((i) => i.uid).sort();
  assert.deepEqual(left, ["uid-p-1", "uid-p-2", "uid-p-3"], "crate, living carrier and the unplaced one: all left on the map");
  assertLives(m);
});

test("T11 boss bag: stowed on the event boss 60 s after its last hit; the event boss dies → boss_killed event; later fills stay leftOnMap", () => {
  const spot = { kind: "foreman" as const, zone: "z-elevator", x: 3500, y: 3800, guards: [], chance: 1 };
  const { m, wall } = worldMatch({ map: arenaMap({ bosses: [spot] }), bossEvent: "foreman", bosses: true, npcBrains: false });
  assert.equal(m.state.bossKind, "foreman");
  assert.equal(m.state.bossZone, "z-elevator");
  assert.equal(m.state.bossState, 1);
  const boss = m.eventBoss()!;
  assert.equal(boss.pub.role, NPC_ROLE.BOSS);
  assert.equal(m.bossAlive(), true);
  jump(m, wall, 1000);
  boss.lastHitAt = m.clock;
  const a = enter(m, "ua", { bossFill: [poolItem("uid-bf-1", "shotgun", 2)] });
  jump(m, wall, 1000);
  assert.equal(m.pendingBossFill.length, 1, "engaged: waits");
  jump(m, wall, POOL.BOSS_ENGAGED_MS);
  assert.equal(m.pendingBossFill.length, 0);
  assert.ok([...boss.self.slots.values()].some((i) => i.uid === "uid-bf-1"), "stowed on the boss");

  m.drainEvents();
  kill(m, boss, a);
  const ev = m.drainEvents();
  assert.equal(m.state.bossState, 2);
  assert.equal(m.bossAlive(), false);
  assert.ok(ev.some((e) => e.type === "world" && e.kind === "boss_killed" && e.boss === "foreman" && e.by === "UA" && e.byUserId === "ua"));
  assert.equal(a.stats.bossKills, 1);

  enter(m, "ub", { bossFill: [poolItem("uid-bf-2", "rifle", 2)] });
  jump(m, wall, POOL.BOSS_ENGAGED_MS + 1000);
  assert.equal(m.pendingBossFill.length, 1, "never diverted elsewhere");
  m.wipe();
  const left = m.report!.leftOnMap.map((i) => i.uid);
  assert.ok(left.includes("uid-bf-2"), "boss dead first → leftOnMap");
  assert.ok(left.includes("uid-bf-1"), "the boss corpse still holds the first fill");
  assertLives(m);
});

// ---------------------------------------------------------------- T12 late spawn

test("T12 late spawn: tier-1 spot when humans are spread; fallback order; never within 3000 px of the user's own corpse when tier 1 exists", () => {
  const spots = arenaMap().spawns;
  const far = { x: 4300, y: 4300 };
  for (const r of [0, 0.5, 0.999]) {
    const s = chooseSpawn(() => r, spots, [{ x: 500, y: 500 }])!;
    assert.deepEqual({ x: s.x, y: s.y }, far, "top 25 % of tier 1 = the farthest corner");
  }
  // Every corner taken: no tier-1 spot, the centre (2687 px) is tier 2.
  const corners = spots.filter((s) => s.x !== 2400);
  const s2 = chooseSpawn(() => 0.7, spots, corners)!;
  assert.deepEqual({ x: s2.x, y: s2.y }, { x: 2400, y: 2400 });
  // Every spot taken: any of them.
  assert.ok(chooseSpawn(() => 0.3, spots, spots));
  assert.equal(chooseSpawn(() => 0.3, [], spots), null);
  // No threats at all: every spot is a candidate.
  const picks = new Set([0, 0.25, 0.5, 0.75, 0.99].map((r) => chooseSpawn(() => r, spots, [])!.x * 10000 + chooseSpawn(() => r, spots, [])!.y));
  assert.ok(picks.size >= 3, "an empty map spreads entrants over every spot");

  for (let k = 0; k < 8; k++) {
    const { m, wall } = worldMatch({ map: arenaMap() });
    jump(m, wall, 1000);
    const a = enter(m, "ua");
    const b = enter(m, "ub");
    put(b, 500, 500);
    put(a, 4300, 4300);
    kill(m, a);
    jump(m, wall, 6000);
    m.rng = () => (k + 0.5) / 8;
    // Without the corpse rule the far corner (4300, 4300; 5374 px from B) would win.
    const again = enter(m, "ua");
    const d = Math.hypot(again.pub.x - 4300, again.pub.y - 4300);
    assert.ok(d >= WORLD.LATE_SPAWN_MIN_HUMAN_PX, `own corpse at ${d.toFixed(0)} px`);
    assert.ok(Math.hypot(again.pub.x - 500, again.pub.y - 500) >= WORLD.LATE_SPAWN_MIN_HUMAN_PX);
  }
});

// ---------------------------------------------------------------- A6 expiry

test("A6 ground expiry: a player-dropped item vanishes 10 min after it hit the ground; valuables → expired (treasury), fungibles destroyed; floor loot stays", () => {
  const { m, wall } = worldMatch({ map: arenaMap() });
  jump(m, wall, 1000);
  const a = enter(m, "ua", { snapshot: snapshotOf("ua", [{ def: "rifle", key: "w1", uid: "uid-g-rifle", rarity: 2 }]) });
  giveStack(m, a.id, "junk_gpu", 1);
  const floor = spawnGroundItem(m, makeItem("bandage", { qty: 2 }), 2000, 2000);
  assert.equal(floor.expiresAt, 0, "map floor loot never expires");
  const gpuKey = [...a.self.slots.entries()].find(([, it]) => it.def === "junk_gpu")![0] as SlotKey;
  assert.equal(m.invDrop(a.id, { key: "w1", uid: "uid-g-rifle", def: "rifle" }), null);
  assert.equal(m.invDrop(a.id, { key: gpuKey, uid: "", def: "junk_gpu" }), null);
  const dropped = [...m.ground.all()].filter((g) => g.schema.expiresAt > 0);
  assert.equal(dropped.length, 2);
  for (const g of dropped) assert.equal(g.schema.expiresAt, m.clock + WORLD.GROUND_EXPIRE_MS);
  jump(m, wall, WORLD.GROUND_EXPIRE_MS - 2000);
  assert.equal(m.state.items.size, 3, "not yet");
  jump(m, wall, 3000);
  assert.equal(m.state.items.size, 1, "both drops vanished, the floor loot stays");
  assert.deepEqual(m.expired.map((i) => i.uid), ["uid-g-rifle"], "only the valuable is reported");
  assert.equal(m.ledger.resolved.get("uid-g-rifle"), "expired");
  m.wipe();
  assert.deepEqual(m.report!.expired!.map((i) => i.uid), ["uid-g-rifle"]);
  assert.ok(!m.report!.leftOnMap.some((i) => i.uid === "uid-g-rifle"));
  assertLives(m);
});

test("A6 corpse expiry: a player corpse vanishes 15 min after the death (open search closed first, uniques → expired); an NPC corpse's pool item → expiredToPool", () => {
  const post = testPost(0, 1500, 4000, { tier: 3, kind: "poi" });
  const { m, wall } = worldMatch({ map: arenaMap(), ...npcOpts([post]), npcBrains: false });
  const npc = m.npcs.runtimes()[0]!;
  jump(m, wall, 1000);
  const v = enter(m, "uv", { snapshot: snapshotOf("uv", [{ def: "rifle", key: "w1", uid: "uid-c-rifle", rarity: 2 }]) });
  put(v, 2400, 2400);
  const rng = m.rng;
  m.rng = () => 0.999; // nothing breaks
  kill(m, v);
  m.rng = rng;
  const corpse = m.state.corpses.get(String(v.rosterIndex))!;
  assert.equal(corpse.expiresAt, m.clock + WORLD.CORPSE_EXPIRE_MS);
  // A pool item placed on the T3 marauder, which is then killed: its corpse holds the item.
  const p = enter(m, "up", { pool: [poolItem("uid-c-pool")] });
  put(p, 500, 500);
  kill(m, p);
  jump(m, wall, 1000);
  assert.ok([...npc.self.slots.values()].some((i) => i.uid === "uid-c-pool"));
  kill(m, npc);
  const npcCorpse = m.state.corpses.get(String(npc.rosterIndex))!;

  // A searcher on the player corpse when it expires.
  jump(m, wall, WORLD.CORPSE_EXPIRE_MS - 8000);
  const s = enter(m, "us");
  put(s, corpse.x + 40, corpse.y);
  assert.ok(m.openSearch(s.id, `k${corpse.id}`));
  advance(m, wall, 3000);
  m.drainEvents();
  assert.ok(s.search);
  const ev = advance(m, wall, 6000);
  assert.equal(s.search, null, "the search closed first");
  assert.ok(ev.some((e) => e.type === "view" && e.op === "remove" && e.key === `k${corpse.id}`));
  assert.equal(m.state.corpses.has(corpse.id), false, "the body vanished");
  assert.equal(m.state.loot.has(`k${corpse.id}`), false);
  assert.equal(m.containers.corpseOf(v.rosterIndex), undefined);
  assert.ok(m.expired.some((i) => i.uid === "uid-c-rifle"));
  assert.equal(m.ledger.resolved.get("uid-c-rifle"), "expired");
  // The NPC died ~1 s later: its corpse goes next.
  jump(m, wall, 3000);
  assert.equal(m.state.corpses.has(npcCorpse.id), false);
  assert.deepEqual(m.expiredToPool.map((i) => i.uid), ["uid-c-pool"]);
  assert.equal(m.ledger.resolved.get("uid-c-pool"), "expired_pool");
  m.wipe();
  assert.deepEqual(m.report!.expiredToPool!.map((i) => i.uid), ["uid-c-pool"]);
  assertLives(m);
});

test("A6: legacy roster matches never expire anything", () => {
  const m = testMatch(2);
  const [a] = m.allRuntimes();
  const g = spawnGroundItem(m, makeItem("bandage"), 1500, 1500, a);
  assert.equal(g.expiresAt, 0);
  killPlayer(m, a!, null, "rifle");
  assert.equal(m.state.corpses.get(String(a!.rosterIndex))!.expiresAt, 0);
  assert.equal(m.world, null);
});
