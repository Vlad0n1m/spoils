import { test } from "node:test";
import assert from "node:assert/strict";
import { MATCH, SERVER_TICK_MS, mulberry32, type ItemRef } from "@extract/shared";
import { BOT_PEACE_MS } from "./bot.js";
import { dropRef } from "./inventory.js";
import { Match } from "./match.js";
import { counterUid } from "./test-utils.js";
import type { MatchEvent, RosterEntry } from "./types.js";

function bots(n: number): RosterEntry[] {
  return Array.from({ length: n }, (_, i) => ({ userId: null, nickname: `Bot${i}`, isBot: true }));
}

function idleHumanRoster(): RosterEntry[] {
  return [{ userId: "human-1", nickname: "Idle", isBot: false }, ...bots(MATCH.MAX_PLAYERS - 1)];
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

/** A ref matches the ledger entry it came from; armor may only have lost durability since. */
function assertRefMatchesLedger(m: Match, r: ItemRef, where: string) {
  const l = m.ledger.get(r.uid);
  assert.ok(l, `${where}: unknown item ${r.uid}`);
  const { dur, ...rest } = r;
  const { dur: ldur, ...lrest } = l;
  assert.deepEqual(rest, lrest, `${where}: ${r.uid} differs from the ledger`);
  if (r.kind === "armor") {
    assert.equal(typeof dur, "number", `${where}: armor ${r.uid} without dur`);
    assert.ok(dur! >= 0 && dur! <= ldur!, `${where}: armor ${r.uid} dur ${dur} outside 0..${ldur}`);
  } else {
    assert.equal(dur, undefined, `${where}: weapon ${r.uid} with dur`);
  }
}

/**
 * Item conservation: every valuable uid created in the match ends in exactly one place of the
 * settlement — extracted or lost by a participant, or leftOnMap — and leftOnMap is exactly what
 * lies on the ground plus what sits in unopened chests. Dropped items of the dead end up in
 * exactly one of someone's extracted / lost, or leftOnMap.
 */
function assertConservation(m: Match) {
  const s = m.settlement!;
  const where = new Map<string, string[]>();
  const put = (uid: string, place: string) => where.set(uid, [...(where.get(uid) ?? []), place]);
  for (const p of s.participants) {
    p.extracted.forEach((r) => put(r.uid, `extracted:${p.nickname}`));
    p.lost.forEach((r) => put(r.uid, `lost:${p.nickname}`));
  }
  s.leftOnMap.forEach((r) => put(r.uid, "leftOnMap"));

  for (const uid of m.ledger.keys()) {
    const places = where.get(uid) ?? [];
    assert.equal(places.length, 1, `item ${uid} is in ${places.length} places: ${places.join(", ")}`);
  }
  for (const uid of where.keys()) assert.ok(m.ledger.has(uid), `unknown item ${uid}`);

  for (const p of s.participants) {
    for (const r of p.extracted) assertRefMatchesLedger(m, r, `extracted:${p.nickname}`);
    for (const r of p.lost) assertRefMatchesLedger(m, r, `lost:${p.nickname}`);
  }
  for (const r of s.leftOnMap) assertRefMatchesLedger(m, r, "leftOnMap");

  // leftOnMap is exactly the valuable ground items plus unopened chest contents.
  const onMap = new Map<string, ItemRef>();
  for (const it of m.state.items.values()) {
    if (it.kind === "weapon" || it.kind === "armor") {
      assert.ok(it.uid, `ground ${it.kind} ${it.id} without uid`);
      onMap.set(it.uid, it.kind === "armor"
        ? { uid: it.uid, kind: "armor", type: "armor", rarity: Math.max(0, it.armor - 1), level: it.armor, dur: it.armorDur }
        : { uid: it.uid, kind: "weapon", type: it.weapon, rarity: it.rarity });
    }
  }
  for (const contents of m.chestContents.values()) {
    for (const d of contents) {
      const ref = dropRef(d);
      if (ref) onMap.set(ref.uid, ref);
    }
  }
  assert.deepEqual(
    [...s.leftOnMap].sort((a, b) => a.uid.localeCompare(b.uid)),
    [...onMap.values()].sort((a, b) => a.uid.localeCompare(b.uid)),
    "leftOnMap = ground + unopened chests",
  );

  // Dropped on death: picked up and then extracted / lost by someone, or still on the map.
  for (const rt of m.allRuntimes()) {
    for (const r of rt.dropped) {
      const places = (where.get(r.uid) ?? []).filter((w) => /^(extracted|lost):|^leftOnMap$/.test(w));
      assert.equal(places.length, 1, `dropped ${r.uid} of ${rt.nickname} ends in ${places.length} places`);
    }
  }
}

/** No bot fires during the peace window unless it was hit first (and then only shortly after). */
function assertPeace(events: Timed[]) {
  const lastHit = new Map<string, number>();
  for (const e of events) {
    if (e.at >= BOT_PEACE_MS) break;
    if (e.type === "hit") lastHit.set(e.msg.t, e.at);
    if (e.type === "shot" && e.msg.s.startsWith("bot")) {
      const hit = lastHit.get(e.msg.s);
      assert.ok(hit !== undefined, `${e.msg.s} fired at ${e.at} ms without being hit first`);
    }
  }
}

for (const seed of [1, 7, 2024]) {
  test(`bots-only match (seed ${seed}) plays to the end and conserves every item`, () => {
    const m = new Match({
      roster: bots(MATCH.MAX_PLAYERS),
      rng: mulberry32(seed),
      newUid: counterUid,
      now: () => 1_700_000_000_000,
    });
    assert.ok(m.state.chests.size > 0 && m.state.extracts.size > 0 && m.state.items.size > 0);
    const closing = [...m.state.extracts.values()].filter((e) => e.closeAt > 0).length;
    assert.equal(closing, Math.floor(m.state.extracts.size * MATCH.EXTRACT_CLOSE_EARLY_FRACTION));
    const spawns = new Set([...m.state.players.values()].map((p) => `${p.x},${p.y}`));
    assert.equal(spawns.size, MATCH.MAX_PLAYERS, "distinct spawns");
    const colors = new Set([...m.state.players.values()].map((p) => p.color));
    assert.equal(colors.size, MATCH.MAX_PLAYERS, "distinct colors");

    const events = playOut(m);
    const counts = countByType(events);
    assert.ok(m.ended, "match ended");
    assert.equal(m.state.phase, "ended");
    const s = m.settlement!;
    assert.equal(s.participants.length, MATCH.MAX_PLAYERS);
    for (const p of s.participants) {
      assert.ok(["extract", "dead", "timeout"].includes(p.exitType));
      assert.equal(p.isBot, true);
      assert.equal(p.userId, null);
      if (p.exitType !== "extract") assert.equal(p.extracted.length, 0);
    }
    assert.ok([...m.state.players.values()].every((p) => !p.alive), "nobody left on the map");
    assert.equal(counts.outcome ?? 0, 0, "bots get no OUTCOME messages");
    assert.ok((counts.shot ?? 0) > 0, "bots fight");
    assert.ok((counts.chest ?? 0) > 0, "bots loot chests");
    const exits = s.participants.map((p) => p.exitType);
    console.log(
      `seed ${seed}: clock=${m.clock} shots=${counts.shot ?? 0} hits=${counts.hit ?? 0} kills=${counts.kill ?? 0} ` +
      `chests=${counts.chest ?? 0} extract=${exits.filter((e) => e === "extract").length} ` +
      `dead=${exits.filter((e) => e === "dead").length} timeout=${exits.filter((e) => e === "timeout").length} ` +
      `leftOnMap=${s.leftOnMap.length}`,
    );
    assert.ok(exits.some((e) => e !== "timeout"), "bots kill or extract");
    assert.equal(events.filter((e) => e.type === "shot" && e.at < BOT_PEACE_MS).length, 0, "nobody shoots in peace");
    assertConservation(m);
  });
}

test("a match with an idle (never connected) human runs until the human dies or time runs out", () => {
  const m = new Match({ roster: idleHumanRoster(), rng: mulberry32(99), newUid: counterUid });
  assertPeace(playOut(m));
  assert.ok(m.ended);
  const human = m.settlement!.participants[0]!;
  assert.equal(human.userId, "human-1");
  assert.ok(human.exitType === "dead" || human.exitType === "timeout");
  assertConservation(m);
});

test("an idle human + 15 bots: the human is alive at 30 s in 10/10 seeded matches", () => {
  let alive = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const m = new Match({ roster: idleHumanRoster(), rng: mulberry32(seed * 7919), newUid: counterUid });
    const humanId = m.allRuntimes()[0]!.id;
    const early = playOut(m, 30_000);
    assert.ok(m.clock >= 30_000);
    if (m.player(humanId)?.alive) alive++;
    const events = [...early, ...playOut(m)];
    assertPeace(events);
    assert.ok(m.ended);
    assertConservation(m);
  }
  console.log(`idle human alive at 30 s: ${alive}/10`);
  assert.equal(alive, 10);
});

test("spawn fairness: humans get the spots farthest from every other player", () => {
  for (const humansN of [1, 2, 4]) {
    for (let seed = 1; seed <= 6; seed++) {
      const roster: RosterEntry[] = [
        ...Array.from({ length: humansN }, (_, i) => ({ userId: `u${i}`, nickname: `H${i}`, isBot: false })),
        ...bots(MATCH.MAX_PLAYERS - humansN),
      ];
      const m = new Match({ roster, rng: mulberry32(seed), newUid: counterUid });
      const ps = m.allRuntimes().map((rt) => m.player(rt.id)!);
      assert.equal(new Set(ps.map((p) => `${p.x},${p.y}`)).size, ps.length, "distinct spawns");
      const nearest = ps.map((p) => Math.min(...ps.filter((o) => o !== p).map((o) => Math.hypot(o.x - p.x, o.y - p.y))));
      const humanWorst = Math.min(...nearest.slice(0, humansN));
      const botBest = Math.max(...nearest.slice(humansN));
      assert.ok(humanWorst >= botBest, `${humansN} humans, seed ${seed}: human ${humanWorst} < bot ${botBest}`);
      if (humansN === 1) {
        // At least as good as the most isolated spot with every spot occupied.
        const spots = m.map.spawnSpots;
        const isolated = Math.max(...spots.map((s) =>
          Math.min(...spots.filter((o) => o !== s).map((o) => Math.hypot(o.x - s.x, o.y - s.y)))));
        assert.ok(humanWorst >= isolated - 1e-6);
      }
    }
  }
});

test("bots-only matches over 10 seeds last long enough and show extraction", () => {
  const lengths: number[] = [];
  let extracts = 0;
  const lines: string[] = [];
  for (let seed = 1; seed <= 10; seed++) {
    const m = new Match({ roster: bots(MATCH.MAX_PLAYERS), rng: mulberry32(seed), newUid: counterUid });
    const events = playOut(m);
    assert.ok(m.ended);
    assertPeace(events);
    assertConservation(m);
    const n = m.settlement!.participants.filter((p) => p.exitType === "extract").length;
    extracts += n;
    lengths.push(m.clock);
    lines.push(`${seed}:${(m.clock / 60_000).toFixed(2)}m/${n}ex`);
  }
  lengths.sort((a, b) => a - b);
  const median = (lengths[4]! + lengths[5]!) / 2;
  const avgExtracts = extracts / 10;
  console.log(`bots-only x10: median ${(median / 60_000).toFixed(2)} min, avg extracts ${avgExtracts.toFixed(1)} [${lines.join(" ")}]`);
  // Tuning target: median >= 4 min and >= 4 extracts on average; asserted with some slack.
  assert.ok(median >= 3.5 * 60_000, `median match length ${median} ms`);
  assert.ok(avgExtracts >= 3, `avg extracts ${avgExtracts}`);
});
