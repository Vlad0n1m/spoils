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
import {
  canStartHeal,
  healSpeedMult,
  inputCancelsHeal,
  lerpAngle,
  Predictor,
  SnapshotBuffer,
  type PendingInput,
} from "./prediction";

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

describe("healing slow-down", () => {
  it("mirrors the server rule: slowed while healUntil > 0 and the clock is before it", () => {
    assert.equal(healSpeedMult(0, 1000), 1);
    assert.equal(healSpeedMult(5000, 4999), PLAYER.HEAL_SPEED_MULT);
    assert.equal(healSpeedMult(5000, 5000), 1);
  });

  it("re-derives pending inputs' multiplier from the newest heal timer", () => {
    const pred = new Predictor(move);
    pred.reset(100, 100);
    pred.setTiming({ clockMs: 1000, healUntil: 0 });
    const inputs: PendingInput[] = [];
    for (let i = 0; i < 4; i++) {
      const input = { seq: pred.nextSeq(), mx: 0, my: 1, speedMult: pred.nextSpeedMult() };
      assert.equal(input.speedMult, 1);
      pred.apply(input);
      inputs.push(input);
    }
    // The heal started on the server before any of these inputs ran: all four are slowed there.
    pred.reconcile(100, 100, 0, { clockMs: 1050, healUntil: 4000 });
    const slow = (PLAYER.SPEED * PLAYER.HEAL_SPEED_MULT * INPUT_DT_MS) / 1000;
    assert.ok(Math.abs(pred.y - (100 + 4 * slow)) < 1e-6, `y=${pred.y}`);
    assert.equal(pred.nextSpeedMult(), PLAYER.HEAL_SPEED_MULT);
  });

  it("predicts the end of a heal at the clock each input will run at", () => {
    const pred = new Predictor(move);
    pred.reset(100, 100);
    // Heal ends 2.5 input steps after the last seen state: inputs 0 and 1 slowed, 2+ full speed.
    pred.setTiming({ clockMs: 1000, healUntil: 1000 + 2.5 * INPUT_DT_MS });
    const mults: number[] = [];
    for (let i = 0; i < 4; i++) {
      const speedMult = pred.nextSpeedMult();
      mults.push(speedMult);
      pred.apply({ seq: pred.nextSeq(), mx: 1, my: 0, speedMult });
    }
    assert.deepEqual(mults, [PLAYER.HEAL_SPEED_MULT, PLAYER.HEAL_SPEED_MULT, 1, 1]);
  });

  it("matches a server that slows inputs applied before healUntil", () => {
    const pred = new Predictor(move);
    pred.reset(100, 100);
    const healUntil = 1000 + 3 * INPUT_DT_MS;
    pred.setTiming({ clockMs: 1000, healUntil });
    // Server: one input per INPUT_DT_MS starting at clock 1000 + INPUT_DT_MS.
    let sx = 100;
    for (let i = 0; i < 6; i++) {
      const input = { seq: pred.nextSeq(), mx: 1, my: 0, speedMult: pred.nextSpeedMult() };
      pred.apply(input);
      const clock = 1000 + (i + 1) * INPUT_DT_MS;
      const live = clock < healUntil ? healUntil : 0; // finishHealIfDue runs first
      sx = move(sx, 100, input, live > 0 ? PLAYER.HEAL_SPEED_MULT : 1).x;
    }
    assert.ok(Math.abs(pred.x - sx) < 1e-6, `pred=${pred.x} server=${sx}`);
  });
});

describe("reconnect", () => {
  it("resyncs when the server restarts lastSeq and keeps moving afterwards", () => {
    const pred = new Predictor(move);
    pred.reset(100, 100);
    for (const i of makeInputs(pred, 10, 1, 0)) pred.apply(i);
    pred.reconcile(150, 100, 6);
    // Reconnect: the server cleared its queue (inputs 7..10 lost) and set lastSeq = 0.
    const r = pred.reconcile(160, 100, 0);
    assert.equal(r.resynced, true);
    assert.equal(pred.pendingCount, 0);
    assert.deepEqual([pred.x, pred.y], [160, 100]);

    // New inputs keep counting up (the server accepts anything > -1 after a reconnect)…
    const next = makeInputs(pred, 3, 0, 1);
    assert.ok(next[0]!.seq > 10);
    for (const i of next) pred.apply(i);
    const step = (PLAYER.SPEED * INPUT_DT_MS) / 1000;
    assert.ok(Math.abs(pred.y - (100 + 3 * step)) < 1e-6, "local player must not freeze");
    // …and are acked normally once the server applies them.
    const ack = pred.reconcile(160, 100 + step, next[0]!.seq);
    assert.equal(ack.resynced, false);
    assert.equal(pred.pendingCount, 2);
    assert.ok(Math.abs(pred.y - (100 + 3 * step)) < 1e-6);
  });

  it("does not resync while lastSeq stays at 0 before the first ack", () => {
    const pred = new Predictor(move);
    pred.reconcile(100, 100, 0);
    for (const i of makeInputs(pred, 3, 1, 0)) pred.apply(i);
    const r = pred.reconcile(100, 100, 0);
    assert.equal(r.resynced, false);
    assert.equal(pred.pendingCount, 3);
  });

  it("jumps its seq past inputs the server applied from another client", () => {
    const pred = new Predictor(move);
    pred.reconcile(100, 100, 0);
    pred.reconcile(100, 100, 500);
    assert.ok(pred.nextSeq() > 500);
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

describe("local heal prediction", () => {
  const MS = 3000;
  const slow = (PLAYER.SPEED * PLAYER.HEAL_SPEED_MULT * INPUT_DT_MS) / 1000;
  const fast = (PLAYER.SPEED * INPUT_DT_MS) / 1000;

  /**
   * Server with the sim's heal rules: intents apply on arrival, inputs in order one per
   * INPUT_DT_MS, slowed while healUntil > 0, and a shot cancels the heal after the move.
   */
  class HealServer {
    x = 100;
    y = 100;
    clock = 1000;
    healUntil = 0;
    lastSeq = 0;
    heal() {
      if (this.healUntil === 0) this.healUntil = this.clock + MS;
    }
    input(i: PendingInput & { fire?: boolean }) {
      this.clock += INPUT_DT_MS;
      if (this.healUntil > 0 && this.clock >= this.healUntil) this.healUntil = 0;
      this.x = move(this.x, this.y, i, this.healUntil > 0 ? PLAYER.HEAL_SPEED_MULT : 1).x;
      if (i.fire) this.healUntil = 0;
      this.lastSeq = i.seq;
    }
    timing() {
      return { clockMs: this.clock, healUntil: this.healUntil };
    }
  }

  function send(pred: Predictor, n: number, fire = false) {
    return Array.from({ length: n }, () => {
      const seq = pred.nextSeq();
      const input = { seq, mx: 1, my: 0, speedMult: pred.nextSpeedMult(seq), fire };
      pred.apply(input);
      if (fire) pred.predictHealCancel();
      return input;
    });
  }

  it("slows inputs from the heal intent on, so the server's state needs no correction", () => {
    const server = new HealServer();
    const pred = new Predictor(move);
    pred.reset(server.x, server.y);
    pred.setTiming(server.timing());
    const before = send(pred, 3);
    assert.equal(pred.healingAhead(), false);
    pred.predictHealStart(MS);
    assert.equal(pred.healingAhead(), true);
    const after = send(pred, 5);
    assert.deepEqual(before.map((i) => i.speedMult), [1, 1, 1]);
    assert.ok(after.every((i) => i.speedMult === PLAYER.HEAL_SPEED_MULT));
    assert.ok(Math.abs(pred.x - (100 + 3 * fast + 5 * slow)) < 1e-6);

    // State before the heal reached the server: the local prediction still covers inputs 4+.
    for (const i of before.slice(0, 2)) server.input(i);
    let c = pred.reconcile(server.x, server.y, server.lastSeq, server.timing());
    assert.ok(Math.abs(c.dx) < 1e-9, `dx=${c.dx}`);

    server.input(before[2]!);
    server.heal();
    for (const i of after.slice(0, 2)) server.input(i);
    c = pred.reconcile(server.x, server.y, server.lastSeq, server.timing());
    assert.ok(Math.abs(c.dx) < 1e-9, `dx=${c.dx}`);
    assert.equal(pred.nextSpeedMult(), PLAYER.HEAL_SPEED_MULT);
  });

  it("returns to full speed right after the shot that cancels the heal", () => {
    const server = new HealServer();
    const pred = new Predictor(move);
    pred.reset(server.x, server.y);
    server.heal();
    pred.setTiming(server.timing());
    const slowed = send(pred, 2);
    const shot = send(pred, 1, true);
    assert.equal(pred.healingAhead(), false);
    const later = send(pred, 3);
    assert.deepEqual(
      [...slowed, ...shot, ...later].map((i) => i.speedMult),
      [PLAYER.HEAL_SPEED_MULT, PLAYER.HEAL_SPEED_MULT, PLAYER.HEAL_SPEED_MULT, 1, 1, 1],
    );
    for (const i of [...slowed, ...shot, later[0]!]) server.input(i);
    const c = pred.reconcile(server.x, server.y, server.lastSeq, server.timing());
    assert.ok(Math.abs(c.dx) < 1e-9, `dx=${c.dx}`);
  });

  it("drops a prediction the server did not confirm once it is acked", () => {
    const server = new HealServer();
    const pred = new Predictor(move);
    pred.reset(server.x, server.y);
    pred.setTiming(server.timing());
    pred.predictHealStart(MS);
    const inputs = send(pred, 4);
    // The server refused the heal (e.g. full HP after all).
    for (const i of inputs.slice(0, 2)) server.input(i);
    const c = pred.reconcile(server.x, server.y, server.lastSeq, server.timing());
    assert.ok(Math.abs(c.dx - 4 * (fast - slow)) < 1e-6, `dx=${c.dx}`);
    assert.equal(pred.healingAhead(), false);
  });

  it("forgets predictions on reset", () => {
    const pred = new Predictor(move);
    pred.reset(100, 100);
    pred.setTiming({ clockMs: 1000, healUntil: 0 });
    pred.predictHealStart(MS);
    pred.reset(100, 100);
    assert.equal(pred.healingAhead(), false);
  });
});

describe("heal intent checks", () => {
  const me = {
    alive: true, hp: 60, bandages: 1, medkits: 0, reloadUntil: 0, active: 0,
    ammoLight: 0, ammoShell: 0, ammoHeavy: 0,
    slots: [{ weapon: "pistol", mag: 3 }, { weapon: "shotgun", mag: 0 }],
  };

  it("canStartHeal mirrors the server's startHeal", () => {
    assert.equal(canStartHeal(me, "bandage"), true);
    assert.equal(canStartHeal(me, "medkit"), false);
    assert.equal(canStartHeal({ ...me, hp: PLAYER.MAX_HP }, "bandage"), false);
    assert.equal(canStartHeal({ ...me, reloadUntil: 5000 }, "bandage"), false);
    assert.equal(canStartHeal({ ...me, alive: false }, "bandage"), false);
  });

  it("inputCancelsHeal: real shots and empty-mag reloads only", () => {
    assert.equal(inputCancelsHeal(me, true, false), true);
    assert.equal(inputCancelsHeal(me, false, false), false);
    assert.equal(inputCancelsHeal(me, true, true), false, "semi-auto held: no new shot");
    assert.equal(inputCancelsHeal({ ...me, reloadUntil: 5000 }, true, false), false);
    assert.equal(inputCancelsHeal({ ...me, active: 1 }, true, false), false, "empty and no shells");
    assert.equal(inputCancelsHeal({ ...me, active: 1, ammoShell: 4 }, true, false), true, "reload");
    const rifle = { ...me, slots: [{ weapon: "rifle", mag: 10 }] };
    assert.equal(inputCancelsHeal(rifle, true, true), true, "auto fires while held");
  });
});
