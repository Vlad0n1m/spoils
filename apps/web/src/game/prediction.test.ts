/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/prediction.test.ts
 *
 * The "server" in these tests is the shared contract used directly (sanitizeInput + stepMovement
 * with terrain sampled at the input's start position), written independently of the Predictor,
 * so an exact match proves the client replays what the authority runs.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  INPUT_DT_MS,
  PLAYER,
  ROLL,
  ROLL_IDLE,
  ROLL_PROFILE,
  SOLID,
  TERRAIN,
  circleIsFree,
  getCollisionIndex,
  healSpeedMult,
  mulberry32,
  readRoll,
  sanitizeInput,
  stepMovement,
  terrainAt,
  terrainSpeedMult,
  type InputSample,
  type ItemLike,
  type MapData,
  type RollState,
} from "@extract/shared";
import {
  canStartHeal,
  inputCancelsHeal,
  lerpAngle,
  moveFnFor,
  Predictor,
  readServerMove,
  SnapshotBuffer,
  type ServerMoveState,
} from "./prediction";

// --- test map: 2000×2000, border walls, a wall, a rock, and a band of shallow water --------------

const W = 2000;
const CELL = 64;
function testMap(): MapData {
  const cols = Math.ceil(W / CELL);
  const terrain = new Uint8Array(cols * cols);
  // Shallow water band x ∈ [1280, 1536).
  for (let r = 0; r < cols; r++) for (let c = 20; c < 24; c++) terrain[r * cols + c] = TERRAIN.SHALLOW;
  const wall = (x: number, y: number, w: number, h: number) => ({ x, y, w, h, f: SOLID.ALL, k: "wall" });
  return {
    id: "steppe",
    width: W,
    height: W,
    terrain,
    terrainCols: cols,
    terrainRows: cols,
    terrainCell: CELL,
    rects: [
      wall(0, 0, W, 20),
      wall(0, W - 20, W, 20),
      wall(0, 0, 20, W),
      wall(W - 20, 0, 20, W),
      wall(700, 300, 40, 900),
      wall(300, 1400, 900, 40),
    ],
    circles: [{ x: 1000, y: 800, r: 60, f: SOLID.ALL, k: "rock" }],
  } as unknown as MapData;
}
const MAP = testMap();
const IDX = getCollisionIndex(MAP);
const move = moveFnFor(MAP, IDX);

const WALK_STEP = (PLAYER.SPEED * INPUT_DT_MS) / 1000;

/** Authoritative server per the contract: sanitize, step with roll + terrain, heal cancel on roll start. */
class Server {
  x: number;
  y: number;
  roll: RollState = { ...ROLL_IDLE };
  lastSeq = 0;
  walking = false;
  clockMs = 1000;
  healUntil = 0;
  private queue: unknown[] = [];
  constructor(x: number, y: number, readonly map: MapData = MAP, readonly idx = IDX) {
    this.x = x;
    this.y = y;
  }
  /** The wire: msgpack round-trips float64 exactly; structuredClone stands in for it. */
  receive(raw: InputSample) {
    this.queue.push(structuredClone(raw));
  }
  /** Queue overflow: the oldest queued input is lost. */
  dropOldest(): number | undefined {
    return (this.queue.shift() as InputSample | undefined)?.seq;
  }
  get queued() {
    return this.queue.length;
  }
  tick(n = Infinity) {
    while (n-- > 0 && this.queue.length) {
      const s = sanitizeInput(this.queue.shift());
      if (!s || s.seq <= this.lastSeq) continue;
      this.clockMs += INPUT_DT_MS;
      if (this.healUntil > 0 && this.clockMs >= this.healUntil) this.healUntil = 0;
      const r = stepMovement(this.idx, this.x, this.y, this.roll, s, healSpeedMult(this.healUntil, this.clockMs), terrainSpeedMult(terrainAt(this.map, this.x, this.y)));
      if (r.started) this.healUntil = 0;
      this.x = r.x;
      this.y = r.y;
      this.roll = r.roll;
      this.walking = !r.rolling && s.walk === true;
      this.lastSeq = s.seq;
    }
  }
  state(): ServerMoveState {
    return {
      x: this.x,
      y: this.y,
      lastSeq: this.lastSeq,
      roll: { ...this.roll },
      walking: this.walking,
      clockMs: this.clockMs,
      healUntil: this.healUntil,
    };
  }
}

/** Mirrors InputController's roll buffer: a press is repeated on ROLL.BUFFER_SAMPLES samples. */
class Client {
  private rollLeft = 0;
  constructor(readonly pred: Predictor) {}
  press() {
    this.rollLeft = ROLL.BUFFER_SAMPLES;
  }
  sample(mx: number, my: number, aim: number, walk = false, fire = false): InputSample {
    const roll = this.rollLeft > 0;
    if (roll) this.rollLeft--;
    return { seq: this.pred.nextSeq(), mx, my, aim, fire, roll, walk };
  }
}

function setup(x = 400, y = 400) {
  const server = new Server(x, y);
  const pred = new Predictor(move);
  pred.reconcile(server.state());
  return { server, pred, client: new Client(pred) };
}

describe("Predictor: exact replay against the shared stepMovement", () => {
  it("random input streams with rolls, walk, water and walls: every correction is exactly zero", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rng = mulberry32(seed);
      const { server, pred, client } = setup(200 + rng() * 1600, 200 + rng() * 1100);
      // States arrive with latency: deliver a server snapshot a few loop iterations later.
      const inFlight: Array<{ at: number; s: ServerMoveState }> = [];
      let mx = 0, my = 0, walk = false;
      let rolls = 0;
      for (let t = 0; t < 900; t++) {
        if (rng() < 0.08) {
          mx = Math.floor(rng() * 3) - 1;
          my = Math.floor(rng() * 3) - 1;
        }
        if (rng() < 0.03) walk = !walk;
        if (rng() < 0.02) client.press();
        // Aim: any float, including out-of-range angles the server normalizes.
        const sample = client.sample(mx, my, (rng() * 2 - 1) * 10, walk, rng() < 0.2);
        const r = pred.apply(sample);
        if (r.started) rolls++;
        server.receive(sample);
        // Server drains at a jittery rate (0..3 per tick, catching up overall).
        if (rng() < 0.6) server.tick(Math.floor(rng() * 3) + (server.queued > 6 ? 2 : 0));
        if (rng() < 0.5) inFlight.push({ at: t + 1 + Math.floor(rng() * 4), s: server.state() });
        while (inFlight.length && inFlight[0]!.at <= t) {
          const c = pred.reconcile(inFlight.shift()!.s);
          assert.equal(c.dx, 0, `seed ${seed} t ${t}: dx=${c.dx}`);
          assert.equal(c.dy, 0, `seed ${seed} t ${t}: dy=${c.dy}`);
          assert.equal(c.resynced, false);
        }
      }
      assert.ok(rolls > 0, `seed ${seed}: the stream should contain rolls`);
      server.tick();
      const predicted = { x: pred.x, y: pred.y, roll: { ...pred.roll } };
      const c = pred.reconcile(server.state());
      assert.equal(c.dx, 0);
      assert.equal(c.dy, 0);
      assert.equal(pred.pendingCount, 0);
      assert.deepEqual(predicted, { x: server.x, y: server.y, roll: server.roll }, `seed ${seed}`);
    }
  });

  it("after a dropped input the replay converges: the next reconciles are exact again", () => {
    for (let seed = 100; seed < 120; seed++) {
      const rng = mulberry32(seed);
      const { server, pred, client } = setup(300 + rng() * 1000, 300 + rng() * 900);
      let mx = 1, my = 0;
      let dropAt = 50 + Math.floor(rng() * 200);
      let dropped: number | undefined;
      let corrections = 0;
      for (let t = 0; t < 600; t++) {
        if (rng() < 0.1) [mx, my] = [Math.floor(rng() * 3) - 1, Math.floor(rng() * 3) - 1];
        if (rng() < 0.03) client.press();
        const s = client.sample(mx, my, rng() * 6, rng() < 0.3);
        pred.apply(s);
        server.receive(s);
        if (t === dropAt && dropped === undefined) {
          dropped = server.dropOldest();
          dropAt += 50 + Math.floor(rng() * 200);
        }
        if (t % 2 === 0) {
          server.tick(2);
          const c = pred.reconcile(server.state());
          if (dropped !== undefined && server.lastSeq >= dropped) {
            // The one reconcile that reveals the drop may correct; from then on the replay runs
            // from the server's own state and roll timeline, so it is exact again.
            dropped = undefined;
            if (c.dx !== 0 || c.dy !== 0) corrections++;
          } else {
            assert.ok(c.dx === 0 && c.dy === 0, `seed ${seed} t ${t}: ${c.dx},${c.dy}`);
          }
        }
      }
      assert.ok(corrections > 0, `seed ${seed}: drops should have caused corrections`);
    }
  });

  it("a predicted roll covers ROLL.DISTANCE in ROLL.TICKS inputs and matches the server after the ack", () => {
    const { server, pred, client } = setup(200, 1000);
    client.press();
    const travelled: number[] = [];
    let startX = pred.x;
    for (let i = 0; i < ROLL.TICKS; i++) {
      const s = client.sample(1, 0, 0);
      const r = pred.apply(s);
      assert.equal(r.rolling, true);
      assert.equal(r.started, i === 0);
      assert.equal(pred.rolling, true);
      travelled.push(pred.x - startX);
      startX = pred.x;
      server.receive(s);
    }
    assert.ok(Math.abs(travelled.reduce((a, b) => a + b, 0) - ROLL.DISTANCE) < 1e-9);
    assert.ok(Math.abs(travelled[0]! - ROLL_PROFILE[0]!) < 1e-9);
    assert.equal(pred.roll.left, 0);
    // The next input walks again; Space was buffered for 6 samples only, all spent mid-roll.
    const after = pred.apply(client.sample(1, 0, 0));
    assert.equal(after.rolling, false);
    server.tick();
    const c = pred.reconcile(server.state());
    assert.equal(c.dx, 0);
    assert.ok(Math.abs(pred.x - (200 + ROLL.DISTANCE + WALK_STEP)) < 1e-9);
  });

  it("standing still rolls toward the aim", () => {
    const { pred, client } = setup(1000, 1000);
    client.press();
    for (let i = 0; i < ROLL.TICKS; i++) pred.apply(client.sample(0, 0, Math.PI / 2));
    assert.ok(Math.abs(pred.x - 1000) < 1e-9);
    assert.ok(Math.abs(pred.y - (1000 + ROLL.DISTANCE)) < 1e-9);
  });

  it("walk (Shift) halves the speed and is ignored while rolling", () => {
    const { pred, client } = setup(300, 1000);
    pred.apply(client.sample(1, 0, 0, true));
    assert.ok(Math.abs(pred.x - (300 + WALK_STEP * PLAYER.WALK_SPEED_MULT)) < 1e-9);
    assert.equal(pred.walking, true);
    const x0 = pred.x;
    client.press();
    pred.apply(client.sample(1, 0, 0, true));
    assert.ok(Math.abs(pred.x - x0 - ROLL_PROFILE[0]!) < 1e-9, "roll tick at full roll speed");
    assert.equal(pred.walking, false);
  });

  it("shallow water slows walking and rolling alike (terrain sampled at the input start)", () => {
    const { pred, client } = setup(1400, 1000);
    pred.apply(client.sample(0, 1, 0));
    assert.ok(Math.abs(pred.y - (1000 + WALK_STEP * 0.6)) < 1e-9);
    client.press();
    const y0 = pred.y;
    pred.apply(client.sample(0, 1, 0));
    assert.ok(Math.abs(pred.y - y0 - ROLL_PROFILE[0]! * 0.6) < 1e-9);
  });
});

// --- windows: the roll vaults them on both sides of the wire ---------------------------------------

/**
 * A building front at x 1000..1024: wall, then windows at y 600..712, 1000..1112 and 1400..1512
 * (SOLID.WINDOW, k "window"), walls between, borders around. Players walk into it and roll at it.
 */
function windowMap(): MapData {
  const base = testMap();
  const r = (x: number, y: number, w: number, h: number, f: number, k: string) => ({ x, y, w, h, f, k });
  const front = [
    r(1000, 20, 24, 580, SOLID.ALL, "wall"), r(1000, 600, 24, 112, SOLID.WINDOW, "window"),
    r(1000, 712, 24, 288, SOLID.ALL, "wall"), r(1000, 1000, 24, 112, SOLID.WINDOW, "window"),
    r(1000, 1112, 24, 288, SOLID.ALL, "wall"), r(1000, 1400, 24, 112, SOLID.WINDOW, "window"),
    r(1000, 1512, 24, 468, SOLID.ALL, "wall"),
  ];
  return { ...base, rects: [...base.rects.slice(0, 4), ...front], circles: [] } as MapData;
}

describe("Predictor: windows (the roll vaults, walking never passes)", () => {
  const WMAP = windowMap();
  const WIDX = getCollisionIndex(WMAP);
  const wmove = moveFnFor(WMAP, WIDX);
  const inWindow = (x: number, y: number) => !circleIsFree(WIDX, x, y, PLAYER.RADIUS - 1e-6, SOLID.VAULT);

  it("random streams at a wall with windows: rolls vault, every correction is exactly zero", () => {
    let vaults = 0;
    let walkedFlush = 0;
    for (let seed = 1; seed <= 24; seed++) {
      const rng = mulberry32(seed * 31);
      const server = new Server(700 + rng() * 250, 500 + rng() * 1100, WMAP, WIDX);
      const pred = new Predictor(wmove);
      pred.reconcile(server.state());
      const client = new Client(pred);
      const inFlight: Array<{ at: number; s: ServerMoveState }> = [];
      let mx = 1, my = 0;
      for (let t = 0; t < 900; t++) {
        // Mostly toward the wall (crossing it both ways), with some sliding along it.
        if (rng() < 0.05) mx = pred.x < 1012 ? (rng() < 0.85 ? 1 : -1) : (rng() < 0.85 ? -1 : 1);
        if (rng() < 0.05) my = Math.floor(rng() * 3) - 1;
        if (rng() < 0.04) client.press();
        const side = pred.x < 1012;
        const sample = client.sample(mx, my * 0.5, (rng() * 2 - 1) * 4, rng() < 0.05);
        const r = pred.apply(sample);
        if (side !== pred.x < 1012) {
          assert.ok(r.rolling, `seed ${seed} t ${t}: only a roll crosses the wall`);
          vaults++;
        }
        if (!r.rolling && Math.abs(pred.x - (1000 - PLAYER.RADIUS)) < 1e-6) walkedFlush++;
        if (pred.roll.left === 0) assert.ok(!inWindow(pred.x, pred.y), `seed ${seed} t ${t}: a finished input stands in a window`);
        server.receive(sample);
        if (rng() < 0.6) server.tick(Math.floor(rng() * 3) + (server.queued > 6 ? 2 : 0));
        if (rng() < 0.5) inFlight.push({ at: t + 1 + Math.floor(rng() * 4), s: server.state() });
        while (inFlight.length && inFlight[0]!.at <= t) {
          const c = pred.reconcile(inFlight.shift()!.s);
          assert.equal(c.dx, 0, `seed ${seed} t ${t}: dx=${c.dx}`);
          assert.equal(c.dy, 0, `seed ${seed} t ${t}: dy=${c.dy}`);
        }
      }
      server.tick();
      const predicted = { x: pred.x, y: pred.y, roll: { ...pred.roll } };
      assert.equal(pred.reconcile(server.state()).dx, 0);
      assert.deepEqual(predicted, { x: server.x, y: server.y, roll: server.roll }, `seed ${seed}`);
    }
    assert.ok(vaults >= 10, `the streams vaulted windows (${vaults})`);
    assert.ok(walkedFlush > 0, "and walked into the wall without passing");
  });

  it("a roll that ends inside a window is predicted out on the nearer side, like the server", () => {
    // The band of body centres overlapping the window is x ∈ (976, 1048); 1030 is nearer the far face.
    const server = new Server(1030 - ROLL.DISTANCE, 1056, WMAP, WIDX);
    const pred = new Predictor(wmove);
    pred.reconcile(server.state());
    const client = new Client(pred);
    client.press();
    for (let i = 0; i < ROLL.TICKS; i++) {
      const s = client.sample(1, 0, 0);
      pred.apply(s);
      server.receive(s);
    }
    assert.ok(pred.x >= 1048 - 1e-6 && pred.x <= 1050 && pred.y === 1056, `x=${pred.x}`);
    server.tick();
    assert.equal(pred.reconcile(server.state()).dx, 0);
    assert.deepEqual({ x: pred.x, y: pred.y }, { x: server.x, y: server.y });
  });
});

describe("Predictor: roll cooldown", () => {
  it("a press during the cooldown is not predicted; a buffered press just before it ends rolls", () => {
    const { server, pred, client } = setup(300, 1000);
    const send = (n: number) => {
      let started = -1;
      for (let i = 0; i < n; i++) {
        const s = client.sample(i % 2 ? 1 : -1, 0, 0);
        if (pred.apply(s).started) started = i;
        server.receive(s);
      }
      return started;
    };
    client.press();
    assert.equal(send(1), 0);
    assert.equal(pred.roll.cd, ROLL.COOLDOWN_TICKS);
    assert.equal(pred.rollReady, false);
    assert.equal(pred.rollCooldownMs, ROLL.COOLDOWN_TICKS * INPUT_DT_MS);
    send(99);
    // 99 inputs after the start: 51 left, so this press (6 samples) is dropped.
    client.press();
    assert.equal(send(20), -1);
    // 147 inputs after the start input (which sets cd and does not count it down): 3 left.
    // Press 3 inputs before the end → rolls on the input that counts cd down to 0.
    send(28);
    assert.equal(pred.roll.cd, 3);
    client.press();
    assert.equal(send(6), 2, "started on the 3rd buffered sample");
    assert.equal(pred.roll.cd, ROLL.COOLDOWN_TICKS - 3);
    server.tick();
    const c = pred.reconcile(server.state());
    assert.equal(c.dx, 0);
    assert.deepEqual(pred.roll, server.roll);
  });

  it("spamming roll on every sample gives one roll per cooldown", () => {
    const { pred } = setup(1000, 1000);
    let starts = 0;
    for (let i = 0; i < ROLL.COOLDOWN_TICKS * 3; i++) {
      const s: InputSample = { seq: pred.nextSeq(), mx: i % 40 < 20 ? 1 : -1, my: 0, aim: 0, fire: false, roll: true };
      if (pred.apply(s).started) starts++;
    }
    assert.equal(starts, 3);
  });
});

describe("Predictor: dropped inputs", () => {
  it("server drops the roll-start input, the buffered next sample rolls: correction ≤ one walk step", () => {
    const { server, pred, client } = setup(300, 1000);
    const walkIn = (n: number) => {
      for (let i = 0; i < n; i++) {
        const s = client.sample(1, 0, 0);
        pred.apply(s);
        server.receive(s);
      }
    };
    walkIn(3);
    server.tick();
    pred.reconcile(server.state());
    client.press();
    walkIn(14);
    server.dropOldest(); // the roll-start sample never reaches the simulation
    server.tick();
    assert.equal(server.roll.cd, ROLL.COOLDOWN_TICKS - (14 - 2), "server rolled one input later");
    const c = pred.reconcile(server.state());
    assert.ok(Math.hypot(c.dx, c.dy) <= WALK_STEP + 1e-9, `correction ${Math.hypot(c.dx, c.dy)}`);
    assert.deepEqual(pred.roll, server.roll, "replay adopts the server's roll timeline");
  });

  it("re-derives the roll start in the replay when the server state disagrees", () => {
    const { pred, client } = setup(300, 1000);
    client.press();
    for (let i = 0; i < 4; i++) pred.apply(client.sample(1, 0, 0));
    // The server never applied any of them but reports a roll mid-way from another state
    // (e.g. reconnect replay): pending inputs replay from its roll state, not from ours.
    const roll: RollState = { left: 0, cd: 40, dx: 0, dy: 0 };
    pred.reconcile({ x: 300, y: 1000, lastSeq: 0, roll, clockMs: 1000, healUntil: 0 });
    assert.equal(pred.roll.left, 0, "cooldown on the server: no roll in the replay");
    assert.equal(pred.roll.cd, 36);
    assert.ok(Math.abs(pred.x - (300 + 4 * WALK_STEP)) < 1e-9);
  });
});

describe("Predictor: heal interplay", () => {
  const slow = WALK_STEP * PLAYER.HEAL_SPEED_MULT;

  it("a predicted roll start cancels the heal slow-down for later inputs (zero correction)", () => {
    const { server, pred, client } = setup(300, 1000);
    server.healUntil = server.clockMs + 3000;
    pred.reconcile(server.state());
    const sent: InputSample[] = [];
    const send = (n: number) => {
      for (let i = 0; i < n; i++) {
        const s = client.sample(1, 0, 0);
        pred.apply(s);
        server.receive(s);
        sent.push(s);
      }
    };
    send(2);
    assert.ok(Math.abs(pred.x - (300 + 2 * slow)) < 1e-9, "slowed while healing");
    assert.equal(pred.healingAhead(), true);
    client.press();
    send(1);
    assert.equal(pred.healingAhead(), false, "the roll cancelled the heal");
    send(ROLL.TICKS - 1 + 3);
    // Walk after the roll is full speed.
    assert.ok(Math.abs(pred.x - (300 + 2 * slow + ROLL.DISTANCE + 3 * WALK_STEP)) < 1e-9);
    server.tick(4);
    let c = pred.reconcile(server.state());
    assert.equal(c.dx, 0);
    assert.equal(server.healUntil, 0);
    server.tick();
    c = pred.reconcile(server.state());
    assert.equal(c.dx, 0);
  });

  it("a heal started mid-roll still slows the walk after the roll", () => {
    const { server, pred, client } = setup(300, 1000);
    pred.reconcile(server.state());
    client.press();
    const s0 = client.sample(1, 0, 0);
    pred.apply(s0);
    server.receive(s0);
    // Heal intent sent after the roll-start input: lands after it on the server.
    pred.predictHealStart(3000);
    assert.equal(pred.healingAhead(), true);
    server.tick();
    server.healUntil = server.clockMs + 3000;
    for (let i = 0; i < ROLL.TICKS - 1 + 2; i++) {
      const s = client.sample(1, 0, 0);
      pred.apply(s);
      server.receive(s);
    }
    server.tick();
    const c = pred.reconcile(server.state());
    assert.ok(Math.abs(c.dx) < 1e-9, `dx=${c.dx}`);
    assert.ok(Math.abs(pred.x - (300 + ROLL.DISTANCE + 2 * slow)) < 1e-9);
  });

  it("slows inputs from the heal intent on, so the server's state needs no correction", () => {
    const { server, pred, client } = setup(300, 1000);
    const send = (n: number) =>
      Array.from({ length: n }, () => {
        const s = client.sample(1, 0, 0);
        pred.apply(s);
        return s;
      });
    const before = send(3);
    pred.predictHealStart(3000);
    const after = send(5);
    assert.ok(Math.abs(pred.x - (300 + 3 * WALK_STEP + 5 * slow)) < 1e-9);
    for (const s of before) server.receive(s);
    server.tick();
    server.healUntil = server.clockMs + 3000;
    for (const s of after.slice(0, 2)) server.receive(s);
    server.tick();
    const c = pred.reconcile(server.state());
    assert.ok(Math.abs(c.dx) < 1e-9, `dx=${c.dx}`);
    assert.equal(pred.nextHealMult(), PLAYER.HEAL_SPEED_MULT);
  });

  it("returns to full speed right after the shot that cancels the heal", () => {
    const { server, pred, client } = setup(300, 1000);
    server.healUntil = server.clockMs + 3000;
    pred.reconcile(server.state());
    const mults: number[] = [];
    for (let i = 0; i < 6; i++) {
      mults.push(pred.nextHealMult());
      pred.apply(client.sample(1, 0, 0, false, i === 2));
      if (i === 2) pred.predictHealCancel();
    }
    const H = PLAYER.HEAL_SPEED_MULT;
    assert.deepEqual(mults, [H, H, H, 1, 1, 1]);
  });

  it("drops a heal prediction the server did not confirm once it is acked", () => {
    const { server, pred, client } = setup(300, 1000);
    pred.predictHealStart(3000);
    const sent = Array.from({ length: 4 }, () => {
      const s = client.sample(1, 0, 0);
      pred.apply(s);
      return s;
    });
    for (const s of sent.slice(0, 2)) server.receive(s);
    server.tick(); // the server refused the heal
    const c = pred.reconcile(server.state());
    assert.ok(Math.abs(c.dx - 4 * (WALK_STEP - slow)) < 1e-9, `dx=${c.dx}`);
    assert.equal(pred.healingAhead(), false);
  });

  it("predicts the end of a heal at the clock each input will run at", () => {
    const { pred, client } = setup(300, 1000);
    pred.setTiming({ clockMs: 1000, healUntil: 1000 + 2.5 * INPUT_DT_MS });
    const mults: number[] = [];
    for (let i = 0; i < 4; i++) {
      mults.push(pred.nextHealMult());
      pred.apply(client.sample(1, 0, 0));
    }
    assert.deepEqual(mults, [PLAYER.HEAL_SPEED_MULT, PLAYER.HEAL_SPEED_MULT, 1, 1]);
  });

  it("forgets predictions on reset", () => {
    const { pred } = setup(300, 1000);
    pred.predictHealStart(3000);
    pred.reset(300, 1000);
    assert.equal(pred.healingAhead(), false);
  });
});

describe("Predictor: reconnect and init", () => {
  it("initializes position and roll state from the first server state", () => {
    const pred = new Predictor(move);
    assert.equal(pred.isInitialized, false);
    const roll = { left: 4, cd: 120, dx: 0.6, dy: 0.8 };
    pred.reconcile({ x: 321, y: 654, lastSeq: 0, roll, clockMs: 0, healUntil: 0 });
    assert.equal(pred.isInitialized, true);
    assert.deepEqual([pred.x, pred.y], [321, 654]);
    assert.deepEqual(pred.roll, roll);
  });

  it("resyncs on a restarted lastSeq, adopts the server roll state and keeps predicting from it", () => {
    const { server, pred, client } = setup(300, 1000);
    for (let i = 0; i < 10; i++) {
      const s = client.sample(1, 0, 0);
      pred.apply(s);
      server.receive(s);
    }
    server.tick(6);
    pred.reconcile(server.state());
    // Reconnect: the server re-keys the player (lastSeq = 0, queue cleared). It is mid-roll.
    const roll: RollState = { left: 3, cd: 100, dx: 0, dy: 1 };
    const r = pred.reconcile({ x: 500, y: 1000, lastSeq: 0, roll, clockMs: 5000, healUntil: 0 });
    assert.equal(r.resynced, true);
    assert.equal(pred.pendingCount, 0);
    assert.deepEqual([pred.x, pred.y], [500, 1000]);
    assert.deepEqual(pred.roll, roll);
    assert.equal(pred.rollCooldownMs, 100 * INPUT_DT_MS);

    // The next inputs continue the server's roll (down), then walk; seq keeps counting up.
    const s = client.sample(1, 0, 0);
    assert.ok(s.seq > 10);
    const res = pred.apply(s);
    assert.equal(res.rolling, true);
    assert.ok(Math.abs(pred.y - (1000 + ROLL_PROFILE[ROLL.TICKS - 3]!)) < 1e-9);
    assert.equal(pred.x, 500);
    const ack = pred.reconcile({ x: pred.x, y: pred.y, lastSeq: s.seq, roll: { ...pred.roll }, clockMs: 5033, healUntil: 0 });
    assert.equal(ack.resynced, false);
    assert.equal(ack.dx, 0);
  });

  it("does not resync while lastSeq stays at 0 before the first ack", () => {
    const { pred, client } = setup(300, 1000);
    for (let i = 0; i < 3; i++) pred.apply(client.sample(1, 0, 0));
    const r = pred.reconcile({ x: 300, y: 1000, lastSeq: 0, roll: { ...ROLL_IDLE }, clockMs: 1000, healUntil: 0 });
    assert.equal(r.resynced, false);
    assert.equal(pred.pendingCount, 3);
  });

  it("jumps its seq past inputs the server applied from another client", () => {
    const { pred } = setup();
    pred.reconcile({ x: 400, y: 400, lastSeq: 500, roll: { ...ROLL_IDLE }, clockMs: 0, healUntil: 0 });
    assert.ok(pred.nextSeq() > 500);
  });

  it("does not predict a sample the server would reject", () => {
    const { pred } = setup(300, 1000);
    const r = pred.apply({ seq: pred.nextSeq(), mx: 1, my: 0, aim: Number.NaN, fire: false });
    assert.equal(r.started, false);
    assert.equal(pred.pendingCount, 0);
    assert.equal(pred.x, 300);
  });
});

describe("readServerMove", () => {
  it("reads x/y from the public player and the rest from self", () => {
    const players = new Map([["sess", { x: 10.5, y: 20.25 }]]);
    const self = new Map([
      ["p3", { lastSeq: 42, healUntil: 9000, walking: true, rollLeft: 2, rollCd: 50, rollDx: 0.6, rollDy: -0.8 }],
    ]);
    const s = readServerMove({ clockMs: 7000, players, self }, "p3", "sess");
    assert.deepEqual(s, {
      x: 10.5, y: 20.25, lastSeq: 42, roll: { left: 2, cd: 50, dx: 0.6, dy: -0.8 },
      clockMs: 7000, healUntil: 9000, walking: true,
    });
    assert.deepEqual(readRoll(self.get("p3")!), s!.roll);
    assert.equal(readServerMove({ clockMs: 0, players, self }, null, "sess"), null);
    assert.equal(readServerMove({ clockMs: 0, players, self }, "p1", "sess"), null);
    assert.equal(readServerMove({ clockMs: 0, players: new Map(), self }, "p3", "sess"), null);
  });
});

describe("intent checks (v2 slots)", () => {
  const item = (def: string, qty = 1, mag = 0, flags = 0): ItemLike => ({
    uid: "", def, qty, rarity: 0, dur: 100, mag, flags, label: "",
  });
  const slots = (entries: Record<string, ItemLike>) => new Map(Object.entries(entries));
  const me = { alive: true, hp: 60 };
  const self = {
    active: "w1",
    reloadUntil: 0,
    slots: slots({ w1: item("pistol", 1, 3), w2: item("shotgun", 1, 0), p0: item("bandage", 2) }),
  };

  it("canStartHeal mirrors the server's startHeal", () => {
    assert.equal(canStartHeal(me, self, "bandage"), true);
    assert.equal(canStartHeal(me, self, "medkit"), false);
    assert.equal(canStartHeal({ ...me, hp: PLAYER.MAX_HP }, self, "bandage"), false);
    assert.equal(canStartHeal(me, { ...self, reloadUntil: 5000 }, "bandage"), false);
    assert.equal(canStartHeal({ ...me, alive: false }, self, "bandage"), false);
    const broken = { ...self, slots: slots({ p0: item("bandage", 2, 0, 2) }) };
    assert.equal(canStartHeal(me, broken, "bandage"), false, "broken stacks do not count");
  });

  it("inputCancelsHeal: real shots and empty-mag reloads only, never on a roll tick", () => {
    assert.equal(inputCancelsHeal(self, true, false), true);
    assert.equal(inputCancelsHeal(self, true, false, true), false, "no firing while rolling");
    assert.equal(inputCancelsHeal(self, false, false), false);
    assert.equal(inputCancelsHeal(self, true, true), false, "semi-auto held: no new shot");
    assert.equal(inputCancelsHeal({ ...self, reloadUntil: 5000 }, true, false), false);
    assert.equal(inputCancelsHeal({ ...self, active: "w2" }, true, false), false, "empty and no shells");
    const withShells = { ...self, active: "w2", slots: slots({ w2: item("shotgun", 1, 0), p1: item("ammo_shell", 4) }) };
    assert.equal(inputCancelsHeal(withShells, true, false), true, "reload from the pockets");
    const rifle = { ...self, slots: slots({ w1: item("rifle", 1, 10) }) };
    assert.equal(inputCancelsHeal(rifle, true, true), true, "auto fires while held");
    assert.equal(inputCancelsHeal({ ...self, active: "w2", slots: slots({}) }, true, false), false, "no weapon");
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
