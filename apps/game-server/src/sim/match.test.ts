import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTAINER_STATE, ITEM_FLAG, MATCH, SERVER_TICK_MS, mulberry32, type LoadoutSnapshot } from "@extract/shared";
import { BOT_PEACE_MS } from "./bot.js";
import { groundUniques } from "./inventory.js";
import { LEGACY_MATCH_PLAYERS as MATCH_PLAYERS, Match, matchMap } from "./match.js";
import { counterUid } from "./test-utils.js";
import type { MatchEvent, RosterEntry } from "./types.js";

function bots(n: number): RosterEntry[] {
  return Array.from({ length: n }, (_, i) => ({ userId: null, nickname: `Bot${i}`, isBot: true }));
}

function idleHumanRoster(): RosterEntry[] {
  return [{ userId: "human-1", nickname: "Idle", isBot: false }, ...bots(MATCH_PLAYERS - 1)];
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

/** No bot fires during the peace window unless it was hit first. */
function assertPeace(m: Match, events: Timed[]) {
  const lastHit = new Map<number, number>();
  for (const e of events) {
    if (e.at >= BOT_PEACE_MS) break;
    if (e.type === "hit") lastHit.set(e.target, e.at);
    if (e.type === "shot" && m.rosterRuntime(e.src)!.isBot) {
      assert.ok(lastHit.has(e.src), `${e.msg.s} fired at ${e.at} ms without being hit first`);
    }
  }
}

// These whole-match bot tests are tuned for the small legacy map (MatchOptions.mapId "legacy");
// the Steppe soak lives in map-boot.test.ts until the bots WP retunes bots for 24,576 px.
for (const seed of [1, 7, 2024]) {
  test(`bots-only match (seed ${seed}) plays to the end and conserves every uid`, () => {
    const m = new Match({ mapId: "legacy", roster: bots(MATCH_PLAYERS), rng: mulberry32(seed), newUid: counterUid, now: () => 1_700_000_000_000, strictLedger: true });
    assert.ok(m.map.containers.length > 0 && m.state.extracts.size > 0 && m.state.items.size > 0);
    assert.equal(m.state.containerState.length, m.map.containers.length);
    assert.equal(m.state.totalPlayers, MATCH_PLAYERS);
    const closing = [...m.state.extracts.values()].filter((e) => e.closeAt > 0).length;
    assert.equal(closing, Math.floor(m.state.extracts.size * MATCH.EXTRACT_CLOSE_EARLY_FRACTION));
    const spawns = new Set([...m.state.players.values()].map((p) => `${p.x},${p.y}`));
    assert.equal(spawns.size, MATCH_PLAYERS, "distinct spawns");
    const colors = new Set([...m.state.players.values()].map((p) => p.color));
    assert.equal(colors.size, MATCH_PLAYERS, "distinct colors");
    assert.equal(m.state.self.size, MATCH_PLAYERS);

    const events = playOut(m);
    const counts = countByType(events);
    assert.equal(m.state.phase, "ended");
    assert.equal(m.state.aliveCount, 0);
    const r = m.report!;
    assert.equal(r.participants.length, MATCH_PLAYERS);
    for (const p of r.participants) {
      assert.ok(["extract", "dead", "timeout"].includes(p.exitType));
      assert.equal(p.isBot, true);
      assert.equal(p.userId, null);
    }
    assert.equal(counts.outcome ?? 0, 0, "bots get no OUTCOME messages");
    assert.equal(counts.exit ?? 0, 0, "bot exits are not posted");
    assert.ok((counts.shot ?? 0) > 0, "bots fight");
    assert.ok((counts.chest ?? 0) > 0, "bots loot containers");
    assert.ok((counts.sound ?? 0) > 0, "the sim emits sounds");
    const opened = [...m.state.containerState].filter((v) => v !== CONTAINER_STATE.UNTOUCHED).length;
    assert.equal(opened, counts.chest);
    const exits = r.participants.map((p) => p.exitType);
    console.log(
      `seed ${seed}: clock=${m.clock} shots=${counts.shot ?? 0} hits=${counts.hit ?? 0} kills=${counts.kill ?? 0} ` +
      `chests=${counts.chest ?? 0} extract=${exits.filter((e) => e === "extract").length} ` +
      `dead=${exits.filter((e) => e === "dead").length} timeout=${exits.filter((e) => e === "timeout").length} ` +
      `known=${m.ledger.known.size} leftOnMap=${r.leftOnMap.length}`,
    );
    assert.ok(exits.some((e) => e !== "timeout"), "bots kill or extract");
    assert.equal(events.filter((e) => e.type === "shot" && e.at < BOT_PEACE_MS).length, 0, "nobody shoots in peace");
    assertConservation(m);
  });
}

test("container contents are deterministic per (matchSeed, idx), whatever the open order", () => {
  const a = new Match({ mapId: "legacy", roster: bots(2), rng: mulberry32(3), mapSeed: 99, newUid: counterUid, botBrains: false, strictLedger: true });
  const b = new Match({ mapId: "legacy", roster: bots(2), rng: mulberry32(4), mapSeed: 99, newUid: counterUid, botBrains: false, strictLedger: true });
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
    roster: [{ userId: "u1", nickname: "Live", isBot: false, loadoutId: "L1" }, ...bots(5)],
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
  const m = new Match({ mapId: "legacy", roster: idleHumanRoster(), rng: mulberry32(99), newUid: counterUid, strictLedger: true });
  assertPeace(m, playOut(m));
  const human = m.report!.participants[0]!;
  assert.equal(human.userId, "human-1");
  assert.ok(human.exitType === "dead" || human.exitType === "timeout");
  assertConservation(m);
});

test("an idle human + bots: the human is alive at 30 s in 10/10 seeded matches", () => {
  let alive = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const m = new Match({ mapId: "legacy", roster: idleHumanRoster(), rng: mulberry32(seed * 7919), newUid: counterUid, strictLedger: true });
    const human = m.allRuntimes()[0]!;
    const early = playOut(m, 30_000);
    assert.ok(m.clock >= 30_000);
    if (human.pub.alive) alive++;
    const events = [...early, ...playOut(m)];
    assertPeace(m, events);
    assertConservation(m);
  }
  console.log(`idle human alive at 30 s: ${alive}/10`);
  assert.equal(alive, 10);
});

// Spawn fairness (side-aware since WP-M2) is tested in map-boot.test.ts.

test("bots-only matches over 10 seeds last long enough and show extraction", () => {
  const lengths: number[] = [];
  let extracts = 0;
  const lines: string[] = [];
  for (let seed = 1; seed <= 10; seed++) {
    const m = new Match({ mapId: "legacy", roster: bots(MATCH_PLAYERS), rng: mulberry32(seed), newUid: counterUid, strictLedger: true });
    const events = playOut(m);
    assertPeace(m, events);
    assertConservation(m);
    const n = m.report!.participants.filter((p) => p.exitType === "extract").length;
    extracts += n;
    lengths.push(m.clock);
    lines.push(`${seed}:${(m.clock / 60_000).toFixed(2)}m/${n}ex`);
  }
  lengths.sort((a, b) => a - b);
  const median = (lengths[4]! + lengths[5]!) / 2;
  const avgExtracts = extracts / 10;
  console.log(`bots-only x10: median ${(median / 60_000).toFixed(2)} min, avg extracts ${avgExtracts.toFixed(1)} [${lines.join(" ")}]`);
  // Extracts open at 3:00, so a match lasts at least that long whenever anyone extracts.
  assert.ok(median >= 3.5 * 60_000, `median match length ${median} ms`);
  assert.ok(avgExtracts >= 3, `avg extracts ${avgExtracts}`);
});
