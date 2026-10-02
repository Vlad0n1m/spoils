import { test } from "node:test";
import assert from "node:assert/strict";
import { TickStats, fmtTickSummary } from "./tick-stats.js";

test("tick stats: averages, p95 and max per window, then reset", () => {
  const s = new TickStats();
  assert.equal(s.flush(), null);
  for (let i = 1; i <= 100; i++) s.add(i / 10, i / 5);
  const out = s.flush()!;
  assert.equal(out.ticks, 100);
  assert.ok(Math.abs(out.stepAvg - 5.05) < 1e-9);
  assert.equal(out.stepP95, 9.6);
  assert.equal(out.tickMax, 20);
  assert.equal(s.size, 0);
  assert.match(fmtTickSummary(out), /^100 ticks: step avg 5\.05/);
});
