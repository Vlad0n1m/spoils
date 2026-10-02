/**
 * Pure post-processing of baked takes (the OfflineAudioContext part needs a browser; /dev/sfx
 * exercises it and flags NaN or clipping).
 *
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/audio/*.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NORMALIZE_PEAK, bakeOrder, crossfadeLoop, fadeEnd, finishTake, normalize, takeStats, trimEnd } from "./bake";
import { SFX, SFX_IDS } from "./recipes";

const SR = 1000;

function sine(n: number, amp: number, dc = 0, period = 50): Float32Array {
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = amp * Math.sin((2 * Math.PI * i) / period) + dc;
  return d;
}
const peakOf = (d: Float32Array) => d.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

describe("normalize", () => {
  it("removes DC and scales the peak to -1 dBFS", () => {
    const d = sine(1000, 0.2, 0.3);
    const r = normalize(d);
    assert.ok(Math.abs(r.dc - 0.3) < 1e-3);
    assert.ok(Math.abs(peakOf(d) - NORMALIZE_PEAK) < 1e-5);
    const mean = d.reduce((a, b) => a + b, 0) / d.length;
    assert.ok(Math.abs(mean) < 1e-5);
  });
  it("leaves silence silent (no divide by zero)", () => {
    const d = new Float32Array(10);
    normalize(d);
    assert.ok(d.every((v) => v === 0));
    assert.deepEqual(normalize(new Float32Array(0)), { rawPeak: 0, dc: 0 });
  });
});

describe("crossfadeLoop", () => {
  it("returns the loop length and makes the seam continuous", () => {
    // A ramp has a big jump at the cut point without the crossfade.
    const n = 600;
    const extra = 100;
    const d = new Float32Array(n + extra);
    for (let i = 0; i < d.length; i++) d[i] = Math.sin(i * 0.37) * 0.5 + (i / d.length) * 0.5;
    const out = crossfadeLoop(d, n);
    assert.equal(out.length, n);
    // out[0] is now d[n] (continuation of the tail): the wrap n-1 → 0 is a single-sample step.
    assert.ok(Math.abs(out[0]! - d[n]!) < 1e-6);
    assert.ok(Math.abs(out[n - 1]! - out[0]!) < 0.4);
  });
});

describe("trim and fade", () => {
  it("trimEnd finds the last audible sample", () => {
    const d = new Float32Array(100);
    d[40] = 0.5;
    d[60] = 0.0001; // below -60 dB
    assert.equal(trimEnd(d), 41);
    assert.equal(trimEnd(new Float32Array(5)), 1);
  });
  it("fadeEnd ends at exactly zero", () => {
    const d = new Float32Array(100).fill(1);
    fadeEnd(d, SR, 10);
    assert.equal(d[99], 0);
    assert.equal(d[50], 1);
    assert.ok(d[95]! > 0 && d[95]! < 1);
  });
  it("finishTake trims one-shots but keeps loop length", () => {
    const tail = new Float32Array(2000);
    tail.set(sine(500, 0.3));
    const shot = finishTake(tail, { dur: 2, loop: false }, SR);
    assert.ok(shot.length < 600 && shot.length >= 500);
    assert.equal(shot[shot.length - 1], 0);
    const loop = finishTake(sine(1500, 0.3), { dur: 1, loop: true }, SR);
    assert.equal(loop.length, 1000);
    assert.ok(Math.abs(peakOf(loop) - NORMALIZE_PEAK) < 1e-3);
  });
});

describe("takeStats", () => {
  it("reports peak, NaN and active length", () => {
    const d = new Float32Array(1000);
    d.set(sine(300, 1));
    d[500] = NaN;
    const s = takeStats(d, SR);
    assert.equal(s.peakDb, 0);
    assert.equal(s.nan, 1);
    assert.ok(s.activeMs >= 280 && s.activeMs <= 300);
    assert.equal(s.durMs, 1000);
    assert.equal(s.tailDb, -Infinity);
  });
});

describe("bakeOrder", () => {
  it("bakes UI first, then guns and steps, loops last, and keeps every id", () => {
    const order = bakeOrder();
    assert.equal(order.length, SFX_IDS.length);
    assert.deepEqual([...order].sort(), [...SFX_IDS].sort());
    const firstGun = order.findIndex((id) => SFX[id].group === "guns");
    const lastUi = order.findLastIndex((id) => SFX[id].group === "ui");
    const firstLoop = order.findIndex((id) => SFX[id].group === "loops");
    const lastStep = order.findLastIndex((id) => SFX[id].group === "steps");
    assert.ok(lastUi < firstGun);
    assert.ok(lastStep < firstLoop);
    assert.ok(order.slice(firstLoop).every((id) => SFX[id].group === "loops"));
  });
});
