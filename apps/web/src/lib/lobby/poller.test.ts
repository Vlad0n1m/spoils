/**
 * poller: the lobby fetches /api/me/world and /api/world/status once on mount even in a hidden tab
 * (regression: PLAY stuck on "PLAY…"), polls only while visible, and refreshes on becoming visible.
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/lobby/poller.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Poller, type PollerTimers } from "./poller";

function fakeClock() {
  let t = 1_000_000;
  let nextId = 1;
  const intervals = new Map<number, { fn: () => void; ms: number; due: number }>();
  const timers: PollerTimers = {
    now: () => t,
    setInterval: (fn, ms) => {
      const id = nextId++;
      intervals.set(id, { fn, ms, due: t + ms });
      return id;
    },
    clearInterval: (id) => void intervals.delete(id as number),
  };
  const advance = (ms: number) => {
    const end = t + ms;
    for (;;) {
      let next: [number, { fn: () => void; ms: number; due: number }] | null = null;
      for (const e of intervals) if (e[1].due <= end && (!next || e[1].due < next[1].due)) next = e;
      if (!next) break;
      t = next[1].due;
      next[1].due += next[1].ms;
      next[1].fn();
    }
    t = end;
  };
  return { timers, advance, running: () => intervals.size };
}

test("a hidden tab still gets one fetch on mount and no interval", () => {
  const c = fakeClock();
  let calls = 0;
  const p = new Poller(() => calls++, 60_000, c.timers);
  p.start();
  p.setActive(false);
  assert.equal(calls, 1);
  c.advance(10 * 60_000);
  assert.equal(calls, 1, "no polling while hidden");
  assert.equal(c.running(), 0);
});

test("a visible tab fetches once on mount (no double fetch) and then every interval", () => {
  const c = fakeClock();
  let calls = 0;
  const p = new Poller(() => calls++, 60_000, c.timers);
  p.start();
  p.setActive(true);
  assert.equal(calls, 1);
  c.advance(60_000);
  assert.equal(calls, 2);
  c.advance(120_000);
  assert.equal(calls, 4);
});

test("hidden → visible fetches right away and resumes polling; visible → hidden pauses", () => {
  const c = fakeClock();
  let calls = 0;
  const p = new Poller(() => calls++, 60_000, c.timers);
  p.start();
  p.setActive(false);
  c.advance(20_000);
  p.setActive(true);
  assert.equal(calls, 2, "refresh on becoming visible");
  c.advance(60_000);
  assert.equal(calls, 3);
  p.setActive(false);
  c.advance(300_000);
  assert.equal(calls, 3);
  p.setActive(true);
  assert.equal(calls, 4);
});

test("a quick visible flicker right after a fetch does not refetch; dispose stops everything", () => {
  const c = fakeClock();
  let calls = 0;
  const p = new Poller(() => calls++, 15_000, c.timers);
  p.start();
  c.advance(500);
  p.setActive(true);
  assert.equal(calls, 1);
  p.dispose();
  c.advance(100_000);
  assert.equal(calls, 1);
  assert.equal(c.running(), 0);
});
