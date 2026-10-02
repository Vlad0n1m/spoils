/**
 * WP-G soak: a whole 30-minute Steppe raid, 31 bots + 1 idle human (kept alive as an observer so
 * the raid runs its full length). Asserts the perf budget, no exceptions, the peace window, uid
 * conservation through the ledger, and that the raid tells the intended story (bots loot, fight,
 * and extract spread over the raid through their own side's extracts rather than timing out).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { MATCH, PERF_BUDGET } from "@extract/shared";
import { groundUniques } from "./inventory.js";
import { MATCH_PLAYERS, type Match } from "./match.js";
import { describeSoak, runSoak } from "./perf.bench.js";

/** Every known uid leaves through exactly one report entry and the ledger agrees (match.test.ts rule). */
function assertConservation(m: Match): void {
  assert.ok(m.ended, "the raid ended");
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
  const onMap = [...groundUniques(m), ...m.containers.leftInside()].map((i) => i.uid).sort();
  assert.deepEqual(r.leftOnMap.map((i) => i.uid).sort(), onMap, "leftOnMap = ground + containers + bodies");
  assert.equal(m.exitReports.length, m.allRuntimes().length, "one exit report per participant");
}

test("soak: 30-minute Steppe raid, 31 bots + 1 idle human — perf budget, ledger, raid story", () => {
  const r = runSoak({ bots: MATCH_PLAYERS - 1, humans: 1, seed: 2026 });
  console.log(describeSoak(r));
  assert.deepEqual(r.errors, [], "no exceptions");
  assert.equal(r.ticks, MATCH.DURATION_MS / 50, "the raid ran its full 30 minutes");
  assert.ok(r.stepAvg < PERF_BUDGET.SERVER_STEP_AVG_MS, `step avg ${r.stepAvg}`);
  assert.ok(r.stepP99 < PERF_BUDGET.SERVER_STEP_P99_MS, `step p99 ${r.stepP99}`);
  // Max is printed, not asserted: under the parallel test runner a single GC pause dominates it.
  const st = r.m.planner.stats;
  assert.ok(st.served > 1000, "bots route through the region planner");
  assert.ok(st.maxTickWork <= r.m.planner.budgetWork * 1.5, `planner tick work ${st.maxTickWork}`);
  assert.ok(r.lodShare > 0.2, `LOD used (${r.lodShare})`);
  assertConservation(r.m);

  // The raid story.
  assert.equal(r.peaceViolations, 0, "no bot starts a fight in the peace window");
  assert.ok(r.scavs >= 8, `scavs ${r.scavs}`);
  assert.ok(r.containersOpened >= 60, `containers opened ${r.containersOpened}`);
  assert.ok((r.counts.shot ?? 0) > 100 && (r.counts.kill ?? 0) > 0, "bots fight");
  if (r.deaths.length > 0) assert.ok(r.corpsesSearched > 0, "bodies get searched");
  assert.ok(r.extracts.length >= 8, `extracts ${r.extracts.length}`);
  assert.ok(r.extracts[0]! >= MATCH.EXTRACT_OPEN_AT_MS, "nobody extracts before the extracts open");
  assert.ok(r.extracts.some((t) => t >= 15 * 60_000), "some bots stay past the middle of the raid");
  assert.ok(r.timeouts <= 2, `timeouts ${r.timeouts}`);
  // Deaths are not all in the opening brawl.
  assert.ok(r.deaths.filter((t) => t < 3 * 60_000).length <= r.deaths.length * 0.75, "deaths spread past the opening");
});
