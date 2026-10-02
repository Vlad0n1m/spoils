/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/prediction.test.ts
 * (or `npx tsx --test ...` when tsx is available on PATH).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyMovement,
  buildCollisionIndex,
  INPUT_DT_MS,
  PLAYER,
  type InputSample,
} from "@extract/shared";
import { lerpAngle, Predictor, SnapshotBuffer, type PendingInput } from "./prediction";

// One wall to the right of the start so some inputs collide and slide.
const idx = buildCollisionIndex({ rects: [{ x: 300, y: 0, w: 40, h: 1000 }], circles: [] }, 1000, 1000);
const move = (x: number, y: number, input: Pick<InputSample, "mx" | "my">, mult: number) =>
  applyMovement(idx, x, y, input, mult);

/** Minimal authoritative server: applies queued inputs in order, acks the last seq. */
class FakeServer {
  x: number;
  y: number;
  lastSeq = 0;
  private queue: PendingInput[] = [];
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
  receive(i: PendingInput) {
    this.queue.push(i);
  }
  /** Process up to n queued inputs (a server tick). */
  tick(n = Infinity) {
    while (n-- > 0 && this.queue.length) {
      const i = this.queue.shift()!;
      const p = move(this.x, this.y, i, i.speedMult);
      this.x = p.x;
      this.y = p.y;
      this.lastSeq = i.seq;
    }
  }
}

function makeInputs(pred: Predictor, n: number, mx: number, my: number, speedMult = 1): PendingInput[] {
  return Array.from({ length: n }, () => ({ seq: pred.nextSeq(), mx, my, speedMult }));
}

describe("Predictor", () => {
  it("matches the server exactly when nothing unexpected happens", () => {
    const pred = new Predictor(move);
    const server = new FakeServer(100, 500);
    pred.reset(server.x, server.y);

    const inputs = [...makeInputs(pred, 20, 1, 0), ...makeInputs(pred, 10, 0.7, -0.7)];
    for (const i of inputs) {
      pred.apply(i);
      server.receive(i);
    }
    // Server is behind: it has processed only 12 of 30 inputs.
    server.tick(12);
    const fullX = pred.x;
    const fullY = pred.y;
    const corr = pred.reconcile(server.x, server.y, server.lastSeq);
    assert.ok(Math.abs(corr.dx) < 1e-9 && Math.abs(corr.dy) < 1e-9, "no correction expected");
    assert.equal(pred.pendingCount, 18);
    assert.ok(Math.abs(pred.x - fullX) < 1e-9 && Math.abs(pred.y - fullY) < 1e-9);

    server.tick();
    pred.reconcile(server.x, server.y, server.lastSeq);
    assert.equal(pred.pendingCount, 0);
    assert.ok(Math.abs(pred.x - server.x) < 1e-9 && Math.abs(pred.y - server.y) < 1e-9);
  });

  it("collides with walls the same way as the server", () => {
    const pred = new Predictor(move);
    const server = new FakeServer(200, 500);
    pred.reset(server.x, server.y);
    for (const i of makeInputs(pred, 40, 1, 0.2)) {
      pred.apply(i);
      server.receive(i);
    }
    // The wall stops the player at x = 300 - radius.
    assert.ok(pred.x <= 300 - PLAYER.RADIUS + 1e-6, `x=${pred.x} went into the wall`);
    server.tick();
    const corr = pred.reconcile(server.x, server.y, server.lastSeq);
    assert.ok(Math.hypot(corr.dx, corr.dy) < 1e-9);
    assert.ok(Math.abs(pred.x - server.x) < 1e-9);
  });

  it("replays unacknowledged inputs on top of a corrected server position", () => {
    const pred = new Predictor(move);
    const server = new FakeServer(100, 100);
    pred.reset(server.x, server.y);
    const inputs = makeInputs(pred, 10, 0, 1);
    for (const i of inputs) {
      pred.apply(i);
      server.receive(i);
    }
    server.tick(4);
    // Something the client could not predict (e.g. a knockback) moved the player on the server.
    server.x += 50;
    const corr = pred.reconcile(server.x, server.y, server.lastSeq);
    assert.ok(Math.abs(corr.dx - 50) < 1e-9, `dx=${corr.dx}`);
    assert.ok(Math.abs(corr.dy) < 1e-9);
    const step = (PLAYER.SPEED * INPUT_DT_MS) / 1000;
    assert.ok(Math.abs(pred.y - (100 + 10 * step)) < 1e-6);
    assert.equal(pred.pendingCount, 6);
  });

  it("drops inputs the server skipped (seq jumps past them)", () => {
    const pred = new Predictor(move);
    pred.reset(100, 100);
    for (const i of makeInputs(pred, 5, 1, 0)) pred.apply(i);
    // The server dropped inputs 1..3 (queue cap) and applied 4..5 from its own position.
    pred.reconcile(130, 100, 5);
    assert.equal(pred.pendingCount, 0);
    assert.equal(pred.x, 130);
  });

  it("uses the speed multiplier each input was predicted with", () => {
    const pred = new Predictor(move);
    pred.reset(100, 100);
    for (const i of makeInputs(pred, 3, 0, 1, 0.5)) pred.apply(i);
    pred.reconcile(100, 100, 0);
    const step = (PLAYER.SPEED * 0.5 * INPUT_DT_MS) / 1000;
    assert.ok(Math.abs(pred.y - (100 + 3 * step)) < 1e-6);
  });

  it("initializes from the first server state", () => {
    const pred = new Predictor(move);
    assert.equal(pred.isInitialized, false);
    pred.reconcile(321, 654, 0);
    assert.equal(pred.isInitialized, true);
    assert.deepEqual([pred.x, pred.y], [321, 654]);
  });
});

describe("SnapshotBuffer", () => {
  it("interpolates between bracketing snapshots and holds the newest", () => {
    const b = new SnapshotBuffer();
    b.push({ t: 0, x: 0, y: 0, aim: 0 });
    b.push({ t: 50, x: 10, y: 20, aim: 1 });
    b.push({ t: 100, x: 20, y: 20, aim: 1 });
    assert.deepEqual(b.sample(25), { x: 5, y: 10, aim: 0.5 });
    assert.deepEqual(b.sample(75), { x: 15, y: 20, aim: 1 });
    assert.deepEqual(b.sample(500), { x: 20, y: 20, aim: 1 });
    assert.deepEqual(b.sample(-10), { x: 0, y: 0, aim: 0 });
  });

  it("snaps across teleports instead of sliding", () => {
    const b = new SnapshotBuffer();
    b.push({ t: 0, x: 0, y: 0, aim: 0 });
    b.push({ t: 50, x: 2000, y: 0, aim: 0 });
    assert.equal(b.sample(10)!.x, 2000);
  });

  it("drops old history", () => {
    const b = new SnapshotBuffer();
    for (let t = 0; t <= 5000; t += 50) b.push({ t, x: t, y: 0, aim: 0 });
    assert.ok(b.size <= 23, `size=${b.size}`);
  });
});

describe("lerpAngle", () => {
  it("takes the short way across ±π", () => {
    const a = lerpAngle(Math.PI - 0.1, -Math.PI + 0.1, 0.5);
    assert.ok(Math.abs(Math.abs(a) - Math.PI) < 1e-9, `a=${a}`);
  });
});
