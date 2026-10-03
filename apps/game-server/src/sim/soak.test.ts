/**
 * NPC MODEL v5 soak: a whole 30-minute Steppe raid, 1 human + every NPC the map holds (posts filled
 * to their largest squads, NPC.MAX_PER_RAID with the boss groups). The human tours the map (hops to
 * a squad every 45 s and stands in its view, kept alive as an observer) so squads all over the map
 * wake, fight, search and return. Asserts the perf budget, no exceptions, the peace window, leash
 * discipline, that no NPC ever loots or extracts, uid conservation through the ledger, and that
 * far-away squads sleep (dormancy).
 *
 * A second, shorter run is the §2.6 perf gate shape: 24 scripted humans (econ HumanAgents, mixed
 * strategies) + 60 NPCs. The design gate (avg ≤ 1.5 ms, p99 ≤ 6 ms) is printed; the assert uses
 * PERF_BUDGET so a busy test host does not flake.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { MATCH, NPC, PERF_BUDGET, WORLD } from "@extract/shared";
import { groundUniques } from "./inventory.js";
import type { Match } from "./match.js";
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
  const onMap = [...groundUniques(m), ...m.containers.leftInside()].map((i) => i.uid);
  for (const uid of onMap) assert.ok(r.leftOnMap.some((i) => i.uid === uid), `${uid} on the map but not in leftOnMap`);
  assert.equal(m.exitReports.length, m.allRuntimes().length, "one exit report per participant");
  assert.deepEqual(r.participants.map((p) => p.isBot), [false], "participants: the one human");
}

test("soak: 30-minute Steppe raid, 1 touring human + every NPC — perf budget, ledger, NPC rules", () => {
  const r = runSoak({ humans: 1, seed: 2026, drive: "tour", hopMs: 45_000, npcFill: "max" });
  console.log(describeSoak(r));
  assert.deepEqual(r.errors, [], "no exceptions");
  assert.equal(r.ticks, MATCH.DURATION_MS / 50, "the raid ran its full 30 minutes");
  assert.ok(r.npcs >= 50 && r.npcs <= NPC.MAX_PER_RAID, `NPCs ${r.npcs}`);
  assert.ok(r.stepAvg < PERF_BUDGET.SERVER_STEP_AVG_MS, `step avg ${r.stepAvg}`);
  assert.ok(r.stepP99 < PERF_BUDGET.SERVER_STEP_P99_MS, `step p99 ${r.stepP99}`);
  const st = r.m.planner.stats;
  assert.ok(st.served > 100, "NPCs route through the region planner");
  assert.ok(st.maxTickWork <= r.m.planner.budgetWork * 1.5, `planner tick work ${st.maxTickWork}`);
  assertConservation(r.m);

  // NPC rules.
  assert.equal(r.peaceViolations, 0, "no NPC starts a fight in the peace window");
  assert.equal(r.npcLooted, 0, "NPCs never loot");
  assert.equal(r.npcExtracted, 0, "NPCs never extract");
  assert.equal(r.counts.chest ?? 0, 0, "nobody opened a container (the human only tours)");
  assert.ok((r.counts.shot ?? 0) > 100, "squads fought the visitor");
  assert.ok(r.leashMaxOut <= 150, `NPCs stay inside leash + chase (out by ${r.leashMaxOut.toFixed(0)} px)`);
  // Dormancy: one human never wakes the whole map.
  assert.ok(r.awakeAvg < r.npcs * 0.5, `awake avg ${r.awakeAvg.toFixed(1)} of ${r.npcs}`);
  assert.ok(r.awakeMax < r.npcs, `awake max ${r.awakeMax}`);
});

test("perf gate shape: 24 scripted humans + 60 NPCs for 6 minutes stay inside PERF_BUDGET", () => {
  const r = runSoak({ humans: WORLD.CAPACITY, minutes: 6, seed: 7, drive: "scripted", npcFill: "max" });
  console.log(describeSoak(r));
  console.log(`design gate (§2.6): avg ${r.stepAvg.toFixed(3)} ms (≤ 1.5), p99 ${r.stepP99.toFixed(3)} ms (≤ 6)`);
  assert.deepEqual(r.errors, [], "no exceptions");
  assert.ok(r.npcs >= 50, `NPCs ${r.npcs}`);
  assert.ok(r.stepAvg < PERF_BUDGET.SERVER_STEP_AVG_MS, `step avg ${r.stepAvg}`);
  assert.ok(r.stepP99 < PERF_BUDGET.SERVER_STEP_P99_MS, `step p99 ${r.stepP99}`);
  assert.equal(r.peaceViolations, 0);
  assert.equal(r.npcLooted, 0);
  assert.equal(r.npcExtracted, 0);
  assert.ok(r.leashMaxOut <= 150, `leash out ${r.leashMaxOut.toFixed(0)} px`);
});
