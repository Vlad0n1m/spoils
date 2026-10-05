import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTAINER_STATE, ITEM_FLAG, MATCH, NPC, NPC_SIGHT_CALM, SERVER_TICK_MS, SOLID, bushIndexAt, circleIsFree, hasLineOfSight, inSightEllipse, mulberry32, type LoadoutSnapshot, type NpcSightEllipse } from "@extract/shared";
import { groundUniques } from "./inventory.js";
import { Match, matchMap } from "./match.js";
import { counterUid, humans, legacyNpcPosts } from "./test-utils.js";
import type { MatchEvent, PlayerRuntime, RosterEntry } from "./types.js";

/** Legacy-map NPC world: `n` marauder posts of 2 (every 2nd one T3), always spawned. */
function npcWorld(mapSeed: number, n = 6) {
  const posts = legacyNpcPosts(mapSeed, n);
  // Midday, clear (a night raid shrinks sight below the 450 px these tests stand at).
  return { mapId: "legacy" as const, mapSeed, npcPosts: posts, npcSpawns: posts.map((p) => ({ postId: p.id, members: 2 })), envSeed: 2, weatherOverride: "clear" };
}

/** Put a human next to the first post: free open ground (no bush) with a clear line of sight to it. */
function nearPost(m: Match, rt: PlayerRuntime, dist = 450, sight?: NpcSightEllipse): boolean {
  const post = m.npcs.squads[0]!.post!;
  // With a sight ellipse (fair perception): only spots inside it, on a finer ring of angles.
  const steps = sight ? 128 : 32;
  for (let k = 0; k < steps; k++) {
    const a = (k * 2 * Math.PI) / steps;
    const x = post.x + Math.cos(a) * dist, y = post.y + Math.sin(a) * dist;
    if (sight && !inSightEllipse(sight, x - post.x, y - post.y)) continue;
    if (!circleIsFree(m.idx, x, y, 20) || !hasLineOfSight(m.idx, post.x, post.y, x, y, SOLID.ALL) || bushIndexAt(m.bushIndex, x, y) >= 0) continue;
    rt.pub.x = rt.prevX = x;
    rt.pub.y = rt.prevY = y;
    rt.pub.aim = a + Math.PI;
    return true;
  }
  if (sight) return false;
  assert.fail("no clear spot next to the post");
}

type Timed = MatchEvent & { at: number };

/** Steps the match until `untilMs` (default: its end); returns every event with its clock. */
function playOut(m: Match, untilMs = Infinity): Timed[] {
  const events: Timed[] = [];
  const maxTicks = MATCH.DURATION_MS / SERVER_TICK_MS + 10;
  for (let i = 0; i < maxTicks && !m.ended && m.clock < untilMs; i++) {
    m.step(SERVER_TICK_MS);
    for (const e of m.drainEvents()) events.push({ ...e, at: m.clock });
  }
  return events;
}

function countByType(events: Timed[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1;
  return counts;
}

/**
 * Uid conservation over the v2 ledger: every unique that entered the match (loadout, pool, demo
 * mint) leaves through exactly one report entry — someone's extracted / lost / destroyed, or the
 * end report's leftOnMap — and the ledger's resolution agrees with where it was reported.
 * leftOnMap is exactly the ground uniques plus what still sits in unopened containers.
 */
function assertConservation(m: Match) {
  assert.ok(m.ended);
  const r = m.report!;
  assert.deepEqual(m.ledgerGaps(), [], "every known uid is resolved");
  const where = new Map<string, string[]>();
  const put = (uid: string, at: string) => where.set(uid, [...(where.get(uid) ?? []), at]);
  for (const rep of m.exitReports) {
    for (const it of rep.extracted) if (it.uid) put(it.uid, "extract");
    for (const it of rep.lost) if (it.uid) put(it.uid, "lost");
    for (const it of rep.destroyed) if (it.uid) put(it.uid, "destroyed");
  }
  for (const it of r.leftOnMap) put(it.uid, "left");
  for (const [uid, info] of m.ledger.known) {
    const at = where.get(uid) ?? [];
    assert.equal(at.length, 1, `uid ${uid} (${info.def}) reported ${at.length}×: ${at.join(", ")}`);
    assert.equal(m.ledger.resolved.get(uid), at[0], `uid ${uid}: ledger vs report`);
  }
  for (const uid of where.keys()) assert.ok(m.ledger.known.has(uid), `unknown uid ${uid} in a report`);
  // Reports never carry FREE items or uid-less uniques.
  for (const rep of m.exitReports) {
    for (const it of [...rep.extracted, ...rep.lost]) assert.ok(!(it.def === "pistol" && !it.uid), "FREE pistol reported");
  }
  const onMap = [...groundUniques(m), ...m.containers.leftInside()].map((i) => i.uid).sort();
  assert.deepEqual(r.leftOnMap.map((i) => i.uid).sort(), onMap, "leftOnMap = ground + unopened containers");
  assert.equal(m.exitReports.length, m.allRuntimes().length, "one exit report per participant");
  // Demo mode: every minted uid is known (and only demo mints are listed).
  for (const it of r.minted) assert.equal(m.ledger.known.get(it.uid)?.origin, "minted");
}

/**
 * No NPC fires during the peace window unless it was hit first or a human walked into its post
 * (within its leash of the anchor, or NPC.PEACE_CLOSE_PX of the NPC). The humans of these tests
 * stand still, so their final position is where they stood.
 */
function assertPeace(m: Match, events: Timed[]) {
  const lastHit = new Map<number, number>();
  const humans = m.allRuntimes().filter((r) => !r.isNpc);
  for (const e of events) {
    if (e.at >= NPC.PEACE_MS) break;
    if (e.type === "hit") lastHit.set(e.target, e.at);
    if (e.type === "shot" && m.rosterRuntime(e.src)!.isNpc) {
      const info = m.npcs.info(m.rosterRuntime(e.src)!)!;
      const intruder = humans.some((h) =>
        Math.hypot(h.pub.x - e.msg.cx, h.pub.y - e.msg.cy) <= NPC.PEACE_CLOSE_PX + 80 ||
        Math.hypot(h.pub.x - info.anchor.x, h.pub.y - info.anchor.y) <= info.leash + 80);
      assert.ok(lastHit.has(e.src) || intruder, `${e.msg.s} fired at ${e.at} ms without being hit first or an intruder in its post`);
    }
  }
}

/** NPCs never loot, pick up, extract or get posted; FREE gear never reaches a report. */
function assertNpcRules(m: Match, events: Timed[]) {
  for (const rt of m.npcs.runtimes()) {
    assert.equal(rt.stats.containersSearched + rt.stats.corpsesSearched, 0, `${rt.id} never loots`);
    assert.notEqual(rt.exitReport?.exit, "extract", `${rt.id} never extracts`);
    assert.equal(rt.self.extractMask, 0);
  }
  const npcIdx = new Set(m.npcs.runtimes().map((r) => r.rosterIndex));
  for (const e of events) {
    if (e.type === "chest") assert.ok(!npcIdx.has(e.src), "an NPC opened a container");
    if (e.type === "exit") assert.ok(e.report.userId, "an NPC exit was posted");
    if (e.type === "outcome") assert.ok(!npcIdx.has(e.to), "an NPC got an OUTCOME");
  }
  for (const rep of m.exitReports) for (const it of [...rep.extracted, ...rep.lost, ...rep.destroyed]) assert.ok(it.uid || !itemIsFreeGear(it.def), `FREE ${it.def} reported`);
  for (const it of m.report!.leftOnMap) assert.ok(it.uid, "leftOnMap holds tracked uniques only");
}

/** NPC weapons / armor / backpacks are FREE (no uid): such a def without a uid in a report = FREE gear leaked. */
function itemIsFreeGear(def: string): boolean {
  return /^(pistol|shotgun|rifle|sniper|armor_\d|backpack_\d)$/.test(def);
}

for (const seed of [1, 7, 2024]) {
  test(`an NPC world (seed ${seed}): a human next to a squad, marauders fight and hold; every uid conserved, humans-only reports`, () => {
    const m = new Match({ ...npcWorld(500 + seed), roster: humans(1), rng: mulberry32(seed), newUid: counterUid, now: () => 1_700_000_000_000, strictLedger: true });
    assert.ok(m.map.containers.length > 0 && m.state.extracts.size > 0 && m.state.items.size > 0);
    assert.equal(m.state.containerState.length, m.map.containers.length);
    assert.equal(m.state.totalPlayers, 1, "the HUD counts humans only");
    assert.equal(m.npcs.runtimes().length, 12);
    assert.equal(m.state.players.size, 13, "NPCs are Players (role ≠ 0) for rendering");
    const human = m.allRuntimes()[0]!;
    nearPost(m, human);
    const events = playOut(m);
    const counts = countByType(events);
    assert.equal(m.state.phase, "ended");
    assert.equal(m.state.aliveCount, 0);
    const r = m.report!;
    assert.deepEqual(r.participants.map((p) => [p.userId, p.isBot]), [["user0", false]], "participants are humans only");
    assert.deepEqual(r.npcSummary!.spawned, { boss: 0, guard: 0, marauder: 12 });
    assert.equal(counts.outcome ?? 0, 1, "one OUTCOME: the human's");
    assert.equal(counts.exit ?? 0, 1, "one exit posted: the human's");
    assert.ok((counts.shot ?? 0) > 0, "the squad fought the human");
    assert.equal(human.exitReport!.exit, "dead", "an idle human next to a squad does not survive");
    assert.ok(m.clock < MATCH.DURATION_MS, "the match ended with its last human, NPCs still standing");
    console.log(`seed ${seed}: clock=${m.clock} shots=${counts.shot ?? 0} hits=${counts.hit ?? 0} kills=${counts.kill ?? 0} known=${m.ledger.known.size}`);
    assertPeace(m, events);
    assertNpcRules(m, events);
    assertConservation(m);
  });
}

test("an idle human in sight of a squad but outside its post is never shot in the peace window (10 seeds)", () => {
  let tested = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const m = new Match({ ...npcWorld(600 + seed, 3), roster: humans(1), rng: mulberry32(seed * 7919), newUid: counterUid, strictLedger: true });
    const human = m.allRuntimes()[0]!;
    // Post 0 is a low post (leash 500): 630 px is outside it and beyond NPC.PEACE_CLOSE_PX (600), inside
    // the calm sight ellipse (NPC_SIGHT_CALM ≈ 635 × 294 since fair perception: east / west of the
    // post) — and the spot must be outside every other post too (an intruder is fought).
    if (!nearPost(m, human, 630, NPC_SIGHT_CALM)) continue;
    const intruding = m.npcs.squads.some((sq) => {
      const p = sq.post!;
      return Math.hypot(p.x - human.pub.x, p.y - human.pub.y) < Math.max(m.npcs.info(sq.members[0]!)!.leash, NPC.PEACE_CLOSE_PX) + 25;
    });
    if (intruding) continue;
    tested++;
    const early = playOut(m, NPC.PEACE_MS - 200);
    assert.ok(human.pub.alive && human.pub.hp === 100, `seed ${seed}: untouched in the peace window`);
    assert.equal(early.filter((e) => e.type === "shot").length, 0, `seed ${seed}: nobody fired`);
    const sees = m.npcs.runtimes().some((rt) => m.vision.sees(rt.rosterIndex, human.rosterIndex));
    assert.ok(sees, `seed ${seed}: the squad saw the human`);
    assertPeace(m, [...early, ...playOut(m)]);
    assertConservation(m);
  }
  assert.ok(tested >= 5, `${tested} seeds had a spot outside every post`);
});

test("the roster is humans only: a pre-v5 bot entry is skipped, never turned into a player", () => {
  const roster: RosterEntry[] = [...humans(2), { userId: null, nickname: "Bot", isBot: true }];
  const m = new Match({ mapId: "legacy", roster, rng: mulberry32(3), mapSeed: 3, newUid: counterUid, emptyWorld: true });
  assert.equal(m.allRuntimes().length, 2);
  assert.ok(m.allRuntimes().every((r) => !r.isNpc && r.userId));
  assert.equal(m.state.totalPlayers, 2);
});

test("container contents are deterministic per (matchSeed, idx), whatever the open order", () => {
  const a = new Match({ mapId: "legacy", roster: humans(2), rng: mulberry32(3), mapSeed: 99, newUid: counterUid, npcBrains: false, strictLedger: true });
  const b = new Match({ mapId: "legacy", roster: humans(2), rng: mulberry32(4), mapSeed: 99, newUid: counterUid, npcBrains: false, strictLedger: true });
  const n = a.map.containers.length;
  const strip = (items: ReturnType<Match["containers"]["roll"]>) => items.map((i) => `${i.def}x${i.qty}r${i.rarity}`);
  const fwd = Array.from({ length: n }, (_, i) => strip(a.containers.roll(i)));
  const rev = Array.from({ length: n }, (_, k) => n - 1 - k).map((i) => [i, strip(b.containers.roll(i))] as const);
  for (const [i, items] of rev) assert.deepEqual(items, fwd[i], `container ${i}`);
  assert.ok(fwd.some((x) => x.length > 0));
});

test("live mode: loadouts and pool items are tracked, nothing is minted, FREE kit fills the gaps", () => {
  const map = matchMap(5, "legacy");
  const snap: LoadoutSnapshot = {
    loadoutId: "L1", userId: "u1", level: 4,
    entries: [
      { key: "w1", uid: "item-rifle", def: "rifle", qty: 1, rarity: 2, dur: 90 },
      { key: "bp", uid: "item-bp", def: "backpack_1", qty: 1, rarity: 0, dur: 100 },
      { key: "b0", uid: "", def: "ammo_light", qty: 60, rarity: 0, dur: 0 },
    ],
  };
  const m = new Match({
    roster: [{ userId: "u1", nickname: "Live", loadoutId: "L1" }],
    rng: mulberry32(11), mapSeed: 5, map, newUid: counterUid, mode: "live", strictLedger: true,
    loadouts: [snap],
    containerLoot: { "0": [{ uid: "pool-1", def: "sniper", qty: 1, rarity: 1, dur: 72 }], boss: [] },
  });
  const rt = m.allRuntimes()[0]!;
  const s = rt.self.slots;
  assert.equal(s.get("w1")!.uid, "item-rifle");
  assert.equal(s.get("w1")!.dur, 90);
  assert.equal(s.get("w2")!.def, "pistol", "FREE pistol fills the empty weapon slot");
  assert.equal(s.get("w2")!.flags & ITEM_FLAG.FREE, ITEM_FLAG.FREE);
  assert.equal(s.get("b0")!.qty, 60);
  assert.equal(rt.pub.bp, 1);
  assert.equal(rt.level, 4);
  assert.equal(m.ledger.known.get("item-rifle")?.origin, "loadout");
  assert.equal(m.ledger.known.get("pool-1")?.origin, "pool");
  const events = playOut(m);
  assert.ok(m.ended);
  assert.deepEqual(m.report!.minted, []);
  assert.ok([...m.ledger.known.values()].every((k) => k.origin !== "minted"), "live mode never mints");
  assert.ok(events.some((e) => e.type === "exit" && e.report.userId === "u1"));
  assertConservation(m);
  // Container 0 was either opened (pool item spilled / taken) or reported as left inside.
  if (m.state.containerState[0] === CONTAINER_STATE.UNTOUCHED) {
    assert.ok(m.report!.leftOnMap.some((i) => i.uid === "pool-1"));
  }
});

test("a match with an idle (never connected) human runs until the human dies or time runs out", () => {
  const m = new Match({ ...npcWorld(77, 4), roster: humans(1), rng: mulberry32(99), newUid: counterUid, strictLedger: true });
  const events = playOut(m);
  assertPeace(m, events);
  const human = m.report!.participants[0]!;
  assert.equal(human.userId, "user0");
  assert.ok(human.exitType === "dead" || human.exitType === "timeout");
  assertNpcRules(m, events);
  assertConservation(m);
});

// Spawn fairness (humans-only farthest-point sampling) is tested in map-boot.test.ts.
