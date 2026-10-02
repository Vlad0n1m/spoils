/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/hud-store.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHudStore, deepEqual, HUD_PUBLISH_INTERVAL_MS, shallowEqual } from "./hud";
import type { HudSnapshot } from "./types";

function snap(clockMs: number, extra: Partial<HudSnapshot> = {}): HudSnapshot {
  return {
    phase: "open", clockMs, durationMs: 600_000, extractOpenAtMs: 0, self: null, aliveCount: 1, totalPlayers: 1,
    nearestExtract: null, extracts: [], interactHint: null, killFeed: [], pingMs: null, ...extra,
  };
}

/** A fake clock + timer queue so throttling is tested deterministically. */
function fakeTime() {
  let t = 0;
  let timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let seq = 0;
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => {
      const id = ++seq;
      timers.push({ at: t + ms, fn, id });
      return id;
    },
    clearTimer: (h: unknown) => {
      timers = timers.filter((x) => x.id !== h);
    },
    advance(ms: number) {
      const end = t + ms;
      for (;;) {
        const next = timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        timers = timers.filter((x) => x !== next);
        t = next.at;
        next.fn();
      }
      t = end;
    },
    pending: () => timers.length,
  };
}

describe("createHudStore", () => {
  it("publishes the first push immediately", () => {
    const time = fakeTime();
    const store = createHudStore(snap(0), time);
    let calls = 0;
    store.subscribe(() => calls++);
    const s = snap(33);
    store.push(s);
    assert.equal(calls, 1);
    assert.equal(store.getSnapshot(), s);
  });

  it("throttles a 30 Hz renderer to at most 10 publishes per second and delivers the newest", () => {
    const time = fakeTime();
    const store = createHudStore(snap(0), time);
    let calls = 0;
    store.subscribe(() => calls++);
    let last: HudSnapshot = snap(0);
    for (let i = 1; i <= 90; i++) {
      // 3 s of pushes every 33.3 ms.
      time.advance(1000 / 30);
      last = snap(i * 33);
      store.push(last);
    }
    time.advance(HUD_PUBLISH_INTERVAL_MS);
    assert.ok(calls <= 31, `published ${calls} times in 3 s`);
    assert.ok(calls >= 25, `published only ${calls} times in 3 s`);
    // Trailing flush: the newest snapshot is what React sees once pushes stop.
    assert.equal(store.getSnapshot(), last);
  });

  it("keeps getSnapshot stable between publishes", () => {
    const time = fakeTime();
    const store = createHudStore(snap(0), time);
    store.push(snap(1));
    const a = store.getSnapshot();
    time.advance(10);
    store.push(snap(2));
    assert.equal(store.getSnapshot(), a, "a push inside the interval must not change the published snapshot");
    time.advance(HUD_PUBLISH_INTERVAL_MS);
    assert.equal(store.getSnapshot().clockMs, 2);
  });

  it("stops notifying unsubscribed listeners and dispose cancels the trailing flush", () => {
    const time = fakeTime();
    const store = createHudStore(snap(0), time);
    let calls = 0;
    const off = store.subscribe(() => calls++);
    store.push(snap(1));
    off();
    time.advance(5);
    store.push(snap(2));
    assert.equal(time.pending(), 1);
    store.dispose();
    assert.equal(time.pending(), 0);
    time.advance(500);
    assert.equal(calls, 1);
  });

  it("extrapolates the match clock from the newest push, capped", () => {
    const time = fakeTime();
    const store = createHudStore(snap(0), time);
    store.push(snap(5_000));
    time.advance(40);
    assert.equal(store.clockNow(), 5_040);
    // Inside the throttle window the published snapshot is older, but the clock follows the newest push.
    store.push(snap(5_050));
    time.advance(10);
    assert.equal(store.clockNow(), 5_060);
    time.advance(10_000);
    assert.equal(store.clockNow(), 5_050 + 250, "a stalled renderer must not run timers away");
  });
});

describe("HUD slice equality", () => {
  it("shallowEqual compares one level", () => {
    assert.ok(shallowEqual({ a: 1, b: "x" }, { a: 1, b: "x" }));
    assert.ok(!shallowEqual({ a: 1 }, { a: 2 }));
    assert.ok(!shallowEqual({ a: 1 }, { a: 1, b: 2 }));
    assert.ok(!shallowEqual({ a: { x: 1 } }, { a: { x: 1 } }));
    assert.ok(shallowEqual(null, null));
    assert.ok(!shallowEqual<unknown>(null, {}));
  });

  it("deepEqual sees rebuilt-but-identical HudSelf-like objects as equal", () => {
    const mk = (mag: number) => ({
      hp: 80, slots: [{ weapon: "rifle", mag }, { weapon: "", mag: 0 }], ammo: { light: 30 }, reloading: null,
    });
    assert.ok(deepEqual(mk(10), mk(10)));
    assert.ok(!deepEqual(mk(10), mk(9)));
    assert.ok(!deepEqual([1, 2], { 0: 1, 1: 2 }));
    assert.ok(!deepEqual({ a: null }, { a: {} }));
  });
});
