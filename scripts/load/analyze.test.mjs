/**
 * Pure parts of the load-run analysis: percentiles, ps time parsing, phase windows, client byte
 * deltas and the linear fit.   node --test scripts/load/analyze.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { clientStats, linearFit, phaseWindow, psStats, tickStats } from "./analyze.mjs";
import { parsePsTime, parseSchedule, pct } from "./lib.mjs";

test("pct uses the nearest-rank rule of tick-stats.ts", () => {
  const v = [5, 1, 4, 2, 3];
  assert.equal(pct(v, 0.5), 3);
  assert.equal(pct(v, 0.95), 5);
  assert.ok(Number.isNaN(pct([], 0.5)));
});

test("parsePsTime reads macOS and Linux ps cputime", () => {
  assert.equal(parsePsTime("0:01.50"), 1.5);
  assert.equal(parsePsTime("12:03.25"), 723.25);
  assert.equal(parsePsTime("01:02:03"), 3723);
  assert.equal(parsePsTime("1-00:00:10"), 86410);
});

test("parseSchedule", () => {
  assert.deepEqual(parseSchedule("0:30, 4:75"), [
    { clients: 0, seconds: 30 },
    { clients: 4, seconds: 75 },
  ]);
  assert.throws(() => parseSchedule("x:1"));
});

test("phaseWindow skips the settle time, at most 30 % of a short phase", () => {
  assert.deepEqual(phaseWindow({ startMs: 0, endMs: 60_000 }), { from: 10_000, to: 60_000 });
  assert.deepEqual(phaseWindow({ startMs: 0, endMs: 20_000 }), { from: 6_000, to: 20_000 });
});

test("tickStats counts ticks over the 50 ms budget inside the window only", () => {
  const ticks = [
    { t: 5, step: 1, tick: 99 },
    { t: 10, step: 1, tick: 2 },
    { t: 20, step: 2, tick: 60 },
    { t: 30, step: 1, tick: 3 },
  ];
  const s = tickStats(ticks, { from: 6, to: 30 });
  assert.equal(s.ticks, 3);
  assert.equal(s.overBudget, 1);
  assert.equal(s.tickMax, 60);
  assert.equal(s.tickP50, 3);
});

test("psStats derives CPU % from cumulative CPU time", () => {
  const ps = [
    { t: 0, role: "server", pcpu: 0, rssKB: 1024, cpuSec: 10 },
    { t: 5000, role: "server", pcpu: 0, rssKB: 2048, cpuSec: 12.5 },
    { t: 5000, role: "clients", pcpu: 0, rssKB: 1, cpuSec: 1 },
  ];
  const s = psStats(ps, { from: 0, to: 5000 }, "server");
  assert.equal(s.cpuPct, 50);
  assert.equal(s.rssMaxMB, 2);
});

test("clientStats divides byte deltas by window length and mean connected clients", () => {
  const snap = (t, patch, ev, connected, rtts = []) => ({
    t,
    connected,
    inBytes: { patch, ev, state: 0 },
    inMsgs: { patch: patch / 100, ev: ev / 50, state: 0 },
    outBytes: t,
    rtts,
    joinMs: [],
    outcomes: {},
  });
  const snaps = [snap(0, 0, 0, 2), snap(5000, 20_000, 5_000, 2, [10]), snap(10_000, 40_000, 10_000, 2, [30])];
  const s = clientStats(snaps, { from: 0, to: 10_000 });
  assert.equal(s.inByKind.patch, 2000);
  assert.equal(s.inByKind.ev, 500);
  assert.equal(s.inBytesPerSecPerClient, 2500);
  assert.equal(s.avgPatchBytes, 100);
  assert.equal(s.rttP50, 30);
});

test("linearFit", () => {
  const f = linearFit([1, 4, 8], [2, 5, 9]);
  assert.ok(Math.abs(f.b - 1) < 1e-9 && Math.abs(f.a - 1) < 1e-9);
});
