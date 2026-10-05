/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/killcam.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FX, KILLCAM, KillcamPlayer, KillcamRecorder, Ring, entOf, lerpAngle, replayDurationMs, replayTimeAt, type FxSnap } from "./killcam";

/** Record `ms` of frames every `step` ms from `t0`, one sprite whose x = t. */
function record(rec: KillcamRecorder, t0: number, ms: number, step = 16) {
  for (let t = t0; t <= t0 + ms; t += step) {
    const f = rec.beginFrame(t);
    if (!f) continue;
    f.camX = t;
    const e = rec.ent(f)!;
    e.id = "me";
    e.self = true;
    e.x = t;
  }
}

describe("killcam ring buffer", () => {
  it("keeps the newest `capacity` entries in order and reuses slot objects", () => {
    const r = new Ring<{ t: number }>(4, () => ({ t: 0 }));
    const firstSlots = [r.push(), r.push(), r.push(), r.push()];
    firstSlots.forEach((s, i) => (s.t = i));
    assert.equal(r.size, 4);
    const fifth = r.push();
    assert.equal(fifth, firstSlots[0], "the oldest slot is overwritten, not a new object");
    fifth.t = 4;
    assert.deepEqual([0, 1, 2, 3].map((i) => r.get(i).t), [1, 2, 3, 4]);
    assert.equal(r.allocated, 4);
    assert.equal(r.oldest()!.t, 1);
    assert.equal(r.newest()!.t, 4);
    assert.equal(r.indexAtOrBefore(0.5), -1);
    assert.equal(r.indexAtOrBefore(2.5), 1);
    assert.equal(r.indexAtOrBefore(99), 3);
    r.clear();
    assert.equal(r.size, 0);
    assert.equal(r.newest(), null);
  });

  it("is memory-bounded: a long raid never allocates past the capacities", () => {
    const rec = new KillcamRecorder();
    // 10 minutes at ~60 fps with 60 sprites on screen and 20 effects per frame.
    for (let t = 0; t < 600_000; t += 16.7) {
      const f = rec.beginFrame(t);
      if (!f) continue;
      for (let i = 0; i < 60; i++) {
        const e = rec.ent(f);
        if (e) e.id = `p${i}`;
      }
      for (let i = 0; i < 20; i++) rec.addFx(t, FX.PUFF, "", t, i, 0, 0, 0, 2);
    }
    assert.equal(rec.frames.allocated, KILLCAM.MAX_FRAMES);
    assert.equal(rec.fx.allocated, KILLCAM.MAX_FX);
    const f = rec.frames.newest()!;
    assert.equal(f.n, KILLCAM.MAX_ENTS, "sprites per frame are capped");
    assert.ok(f.ents.length <= KILLCAM.MAX_ENTS);
    // The ring still covers more than the replayed window.
    const span = f.t - rec.frames.oldest()!.t;
    assert.ok(span >= KILLCAM.BUFFER_MS, `${span.toFixed(0)} ms of history`);
  });

  it("samples at most every SAMPLE_MS; the death frame is forced; freeze stops frames, effects get a short tail", () => {
    const rec = new KillcamRecorder();
    assert.ok(rec.beginFrame(0));
    assert.equal(rec.beginFrame(5), null, "too soon");
    assert.ok(rec.beginFrame(5, true), "forced");
    record(rec, 20, 2_000);
    rec.freeze(2_020);
    assert.equal(rec.beginFrame(3_000, true), null, "frozen");
    rec.addFx(2_020 + KILLCAM.FX_TAIL_MS - 1, FX.STOP, "x", 1, 2, 0, 0, 0, 2);
    rec.addFx(2_020 + KILLCAM.FX_TAIL_MS + 1, FX.STOP, "late", 1, 2, 0, 0, 0, 2);
    assert.equal(rec.fx.newest()!.s, "x", "past the tail nothing is kept");
    assert.deepEqual(rec.window(), { start: 2_020 - KILLCAM.REPLAY_MS < 0 ? 0 : 2_020 - KILLCAM.REPLAY_MS, end: 2_020 });
  });

  it("no replay for a recording shorter than MIN_MS", () => {
    const rec = new KillcamRecorder();
    record(rec, 0, KILLCAM.MIN_MS / 2);
    rec.freeze(KILLCAM.MIN_MS / 2);
    assert.equal(rec.window(), null);
    assert.equal(new KillcamRecorder().window(), null);
  });
});

describe("killcam playback timing", () => {
  it("1× then the slow-motion tail then a hold: ≈ 5 s for a full window", () => {
    const start = 10_000;
    const end = start + KILLCAM.REPLAY_MS;
    const total = replayDurationMs(start, end);
    const fast = KILLCAM.REPLAY_MS - KILLCAM.SLOWMO_MS;
    assert.equal(total, fast + KILLCAM.SLOWMO_MS / KILLCAM.SLOWMO + KILLCAM.HOLD_MS);
    assert.ok(total >= 4_500 && total <= 6_000, `${total} ms`);
    assert.deepEqual(replayTimeAt(0, start, end).t, start);
    assert.equal(replayTimeAt(1_000, start, end).t, start + 1_000, "1× at first");
    // Slow motion: 400 wall ms past the fast part = 200 recorded ms.
    assert.equal(replayTimeAt(fast + 400, start, end).t, start + fast + 200);
    // Monotonic, never past the end, done only after the hold.
    let prev = -Infinity;
    for (let e = 0; e <= total + 100; e += 25) {
      const r = replayTimeAt(e, start, end);
      assert.ok(r.t >= prev && r.t <= end);
      prev = r.t;
      assert.equal(r.done, e >= total);
      assert.ok(r.progress >= 0 && r.progress <= 1);
    }
    assert.equal(replayTimeAt(total - KILLCAM.HOLD_MS, start, end).t, end, "the hold shows the death frame");
  });

  it("a short window is all slow motion", () => {
    const r = replayTimeAt(400, 0, 1_000);
    assert.equal(r.t, 200);
    assert.equal(replayDurationMs(0, 1_000), 1_000 / KILLCAM.SLOWMO + KILLCAM.HOLD_MS);
  });

  it("the player blends the recorded frames around the replay time and plays each effect once, in order", () => {
    const rec = new KillcamRecorder();
    record(rec, 0, 5_000, 20);
    for (let t = 100; t <= 5_000; t += 500) rec.addFx(t, FX.PUFF, `fx${t}`, t, 0, 0, 0, 0, 2);
    rec.freeze(5_000);
    rec.addFx(5_100, FX.STOP, "tail", 0, 0, 0, 0, 0, 2);
    const win = rec.window()!;
    assert.equal(win.end, 5_000);
    assert.equal(win.start, 5_000 - KILLCAM.REPLAY_MS);
    const p = new KillcamPlayer(rec, 1_000, win);
    const s = p.at(1_000 + 510);
    assert.equal(s.t, win.start + 510);
    assert.ok(s.a.t <= s.t && s.b.t >= s.t);
    const x = entOf(s.a, "me")!.x + (entOf(s.b, "me")!.x - entOf(s.a, "me")!.x) * s.k;
    assert.ok(Math.abs(x - s.t) < 1e-6, "the sprite is where it was at that moment");

    const p2 = new KillcamPlayer(rec, 0, win);
    const seen: string[] = [];
    const buf: FxSnap[] = [];
    for (let now = 0; now <= p2.durationMs + 50; now += 33) {
      const r = p2.at(now);
      for (const e of p2.dueFx(r.t, r.done, buf)) seen.push(e.s);
    }
    const want = [];
    for (let t = 100; t <= 5_000; t += 500) if (t >= win.start) want.push(`fx${t}`);
    assert.deepEqual(seen, [...want, "tail"], "effects in the window once each, then the death tail");
    assert.equal(p2.at(p2.durationMs).done, true);
  });

  it("lerpAngle takes the short way round", () => {
    assert.ok(Math.abs(lerpAngle(3, -3, 0.5) - (3 + (2 * Math.PI - 6) / 2)) < 1e-9);
    assert.equal(lerpAngle(0, 1, 0.25), 0.25);
  });
});
