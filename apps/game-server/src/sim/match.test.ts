import { test } from "node:test";
import assert from "node:assert/strict";
import { MATCH, SERVER_TICK_MS, mulberry32, type ItemRef } from "@extract/shared";
import { Match } from "./match.js";
import { counterUid } from "./test-utils.js";
import type { LootDrop, RosterEntry } from "./types.js";

function bots(n: number): RosterEntry[] {
  return Array.from({ length: n }, (_, i) => ({ userId: null, nickname: `Bot${i}`, isBot: true }));
}

/** Runs the match to its end; returns event counts. */
function playOut(m: Match) {
  const counts: Record<string, number> = {};
  const maxTicks = MATCH.DURATION_MS / SERVER_TICK_MS + 10;
  for (let i = 0; i < maxTicks && !m.ended; i++) {
    m.step(SERVER_TICK_MS);
    for (const e of m.drainEvents()) counts[e.type] = (counts[e.type] ?? 0) + 1;
  }
  return counts;
}

/**
 * Item conservation: every valuable uid created in the match ends in exactly one place —
 * extracted by someone, lost (broken / timeout), on the ground, or in an unopened chest.
 */
function assertConservation(m: Match) {
  const s = m.settlement!;
  const where = new Map<string, string[]>();
  const put = (uid: string, place: string) => where.set(uid, [...(where.get(uid) ?? []), place]);
  for (const p of s.participants) {
    p.extracted.forEach((r: ItemRef) => put(r.uid, `extracted:${p.nickname}`));
    p.lost.forEach((r: ItemRef) => put(r.uid, `lost:${p.nickname}`));
  }
  for (const it of m.state.items.values()) if (it.uid) put(it.uid, `ground:${it.id}`);
  for (const [cid, contents] of m.chestContents) {
    for (const d of contents as LootDrop[]) if ("uid" in d) put(d.uid, `chest:${cid}`);
  }
  for (const uid of m.ledger.keys()) {
    const places = where.get(uid) ?? [];
    assert.equal(places.length, 1, `item ${uid} is in ${places.length} places: ${places.join(", ")}`);
  }
  for (const uid of where.keys()) assert.ok(m.ledger.has(uid), `unknown item ${uid}`);
  // Ledger refs match what was reported.
  for (const p of s.participants) {
    for (const r of [...p.extracted, ...p.lost]) assert.deepEqual(r, m.ledger.get(r.uid));
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

    const counts = playOut(m);
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
      `dead=${exits.filter((e) => e === "dead").length} timeout=${exits.filter((e) => e === "timeout").length}`,
    );
    assert.ok(exits.some((e) => e !== "timeout"), "bots kill or extract");
    assertConservation(m);
  });
}

test("a match with an idle (never connected) human runs until the human dies or time runs out", () => {
  const roster: RosterEntry[] = [{ userId: "human-1", nickname: "Idle", isBot: false }, ...bots(MATCH.MAX_PLAYERS - 1)];
  const m = new Match({ roster, rng: mulberry32(99), newUid: counterUid });
  playOut(m);
  assert.ok(m.ended);
  const human = m.settlement!.participants[0]!;
  assert.equal(human.userId, "human-1");
  assert.ok(human.exitType === "dead" || human.exitType === "timeout");
  assertConservation(m);
});
