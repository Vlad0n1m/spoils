import assert from "node:assert/strict";
import { test } from "node:test";
import { INPUT_DT_MS, PLAYER, ROLL } from "./constants.js";
import { SOLID, buildCollisionIndex } from "./geometry.js";
import {
  ROLL_IDLE,
  ROLL_PROFILE,
  applyMovement,
  healSpeedMult,
  moveSpeedMult,
  readRoll,
  rollCooldownMs,
  sanitizeInput,
  stepMovement,
  writeRoll,
  type InputSample,
  type RollState,
} from "./movement.js";

const open = buildCollisionIndex({ rects: [], circles: [] }, 4000, 4000);
const I = (o: Partial<InputSample> = {}) => ({ mx: 0, my: 0, aim: 0, roll: false, walk: false, ...o });
const WALK_STEP = (PLAYER.SPEED * INPUT_DT_MS) / 1000;
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

test("roll profile: ease-out, sums to DISTANCE, every step below 1.5 × radius (no tunnelling)", () => {
  assert.equal(ROLL_PROFILE.length, ROLL.TICKS);
  assert.ok(near(ROLL_PROFILE.reduce((a, b) => a + b, 0), ROLL.DISTANCE));
  for (let i = 1; i < ROLL_PROFILE.length; i++) assert.ok(ROLL_PROFILE[i]! < ROLL_PROFILE[i - 1]!);
  assert.ok(ROLL_PROFILE[0]! < PLAYER.RADIUS * 1.5);
  assert.ok(Object.isFrozen(ROLL_PROFILE));
});

test("roll covers exactly DISTANCE in TICKS inputs, direction locked at start", () => {
  let x = 1000, y = 1000;
  let roll: RollState = { ...ROLL_IDLE };
  const r0 = stepMovement(open, x, y, roll, I({ mx: 1, roll: true }));
  assert.ok(r0.started && r0.rolling);
  ({ x, y, roll } = r0);
  for (let i = 1; i < ROLL.TICKS; i++) {
    const r = stepMovement(open, x, y, roll, I({ my: 1, roll: true, walk: true }), 0.45);
    assert.ok(r.rolling && !r.started);
    ({ x, y, roll } = r);
  }
  assert.ok(near(x, 1000 + ROLL.DISTANCE) && y === 1000, "walk/heal mults and new direction ignored mid-roll");
  assert.deepEqual({ left: roll.left, dx: roll.dx, dy: roll.dy }, { left: 0, dx: 0, dy: 0 });
  // cd is set on the start input and ticks down on every later input.
  assert.equal(roll.cd, ROLL.COOLDOWN_TICKS - (ROLL.TICKS - 1));
  const after = stepMovement(open, x, y, roll, I({ mx: 1, roll: true }));
  assert.ok(!after.started && !after.rolling, "next input walks");
  assert.ok(near(after.x - x, WALK_STEP));
});

test("roll direction: diagonal movement is normalized; standing still rolls toward the aim", () => {
  const d = stepMovement(open, 500, 500, ROLL_IDLE, I({ mx: 1, my: 1, roll: true }));
  assert.ok(near(d.roll.dx, Math.SQRT1_2) && near(d.roll.dy, Math.SQRT1_2));
  assert.ok(near(Math.hypot(d.x - 500, d.y - 500), ROLL_PROFILE[0]!));
  const a = stepMovement(open, 500, 500, ROLL_IDLE, I({ aim: Math.PI / 2, roll: true }));
  assert.ok(a.started && near(a.x, 500) && a.y > 500);
});

test("cooldown: requests during roll or cooldown are ignored; spam for 400 inputs starts at 0, 150, 300", () => {
  const mid = stepMovement(open, 500, 500, { left: 0, cd: 2, dx: 0, dy: 0 }, I({ mx: 1, roll: true }));
  assert.equal(mid.started, false);
  assert.equal(mid.roll.cd, 1);
  // Stored cd 1 is consumed by this input, so this one may start (period = COOLDOWN_TICKS exactly).
  assert.equal(stepMovement(open, 500, 500, { left: 0, cd: 1, dx: 0, dy: 0 }, I({ mx: 1, roll: true })).started, true);
  let s: RollState = { ...ROLL_IDLE };
  let x = 2000, y = 2000;
  const starts: number[] = [];
  for (let i = 0; i < 400; i++) {
    const r = stepMovement(open, x, y, s, I({ mx: i % 2 ? 1 : -1, roll: true }));
    if (r.started) starts.push(i);
    ({ x, y, roll: s } = r);
  }
  assert.deepEqual(starts, [0, ROLL.COOLDOWN_TICKS, 2 * ROLL.COOLDOWN_TICKS]);
});

test("roll into a 24 px wall stops at the face (no tunnel)", () => {
  const idx = buildCollisionIndex({ rects: [{ x: 600, y: 0, w: 24, h: 2000, f: SOLID.ALL }], circles: [] }, 2000, 2000);
  let s: RollState = { ...ROLL_IDLE };
  let x = 600 - 25, y = 1000;
  for (let i = 0; i < ROLL.TICKS; i++) ({ x, y, roll: s } = stepMovement(idx, x, y, s, I({ mx: 1, roll: true })));
  assert.ok(x <= 600 - PLAYER.RADIUS + 1e-6, String(x));
});

test("walk, heal and terrain multipliers", () => {
  const walk = stepMovement(open, 500, 500, ROLL_IDLE, I({ mx: 1, walk: true }));
  assert.ok(near(walk.x - 500, WALK_STEP * PLAYER.WALK_SPEED_MULT));
  const heal = stepMovement(open, 500, 500, ROLL_IDLE, I({ mx: 1 }), PLAYER.HEAL_SPEED_MULT);
  assert.ok(near(heal.x - 500, WALK_STEP * PLAYER.HEAL_SPEED_MULT));
  // Heal and walk do not stack: the slower one wins.
  assert.equal(moveSpeedMult(PLAYER.HEAL_SPEED_MULT, true), Math.min(PLAYER.HEAL_SPEED_MULT, PLAYER.WALK_SPEED_MULT));
  assert.equal(moveSpeedMult(1, false), 1);
  const water = stepMovement(open, 500, 500, ROLL_IDLE, I({ mx: 1, walk: true }), 1, 0.6);
  assert.ok(near(water.x - 500, WALK_STEP * PLAYER.WALK_SPEED_MULT * 0.6));
  // Terrain also scales the roll, so rolling is not a way to cross water at full speed.
  const rollW = stepMovement(open, 500, 500, ROLL_IDLE, I({ mx: 1, roll: true }), 1, 0.6);
  assert.ok(near(rollW.x - 500, ROLL_PROFILE[0]! * 0.6));
  // Standing still does not move; a still roll start does.
  assert.deepEqual(stepMovement(open, 500, 500, ROLL_IDLE, I()).x, 500);
});

test("healSpeedMult: slowed only while the channel runs", () => {
  assert.equal(healSpeedMult(0, 1000), 1);
  assert.equal(healSpeedMult(2000, 1999), PLAYER.HEAL_SPEED_MULT);
  assert.equal(healSpeedMult(2000, 2000), 1);
});

test("applyMovement normalizes input longer than 1", () => {
  const p = applyMovement(open, 500, 500, { mx: 1, my: 1 });
  assert.ok(near(Math.hypot(p.x - 500, p.y - 500), WALK_STEP));
  const q = applyMovement(open, 500, 500, { mx: 0.5, my: 0 });
  assert.ok(near(q.x - 500, WALK_STEP / 2), "analog input below 1 is kept");
});

test("replay determinism: restarting from any mid state reproduces the suffix bit for bit", () => {
  const idx = buildCollisionIndex(
    {
      rects: [{ x: 1900, y: 1700, w: 400, h: 24, f: SOLID.ALL }, { x: 2200, y: 1800, w: 24, h: 500, f: SOLID.MOVE }],
      circles: [{ x: 1800, y: 2200, r: 40, f: SOLID.ALL }],
    },
    4000, 4000,
  );
  const inputs = Array.from({ length: 400 }, (_, i) =>
    I({ mx: Math.sin(i * 0.1), my: Math.cos(i * 0.07), aim: i * 0.03, roll: i % 37 < 3, walk: i % 50 < 10 }),
  );
  const run = (from: number, s0: RollState, x0: number, y0: number) => {
    let s = s0, x = x0, y = y0;
    const out: Array<[number, number, RollState, boolean]> = [];
    for (let i = from; i < inputs.length; i++) {
      const r = stepMovement(idx, x, y, s, inputs[i]!, i % 90 < 20 ? PLAYER.HEAL_SPEED_MULT : 1, i % 70 < 15 ? 0.6 : 1);
      ({ x, y, roll: s } = r);
      out.push([x, y, s, r.rolling]);
    }
    return out;
  };
  const full = run(0, { ...ROLL_IDLE }, 2000, 2000);
  assert.ok(full.some((e) => e[3]), "some inputs rolled");
  for (const k of [1, 57, 123, 299]) {
    const [xk, yk, sk] = full[k - 1]!;
    assert.deepEqual(run(k, sk, xk, yk), full.slice(k), `suffix from ${k}`);
  }
});

test("readRoll / writeRoll round-trip and write only changed fields", () => {
  const writes: string[] = [];
  const target = { rollLeft: 0, rollCd: 0, rollDx: 0, rollDy: 0 };
  const p = new Proxy(target, {
    set(t, k, v) {
      writes.push(String(k));
      (t as Record<string, number>)[k as string] = v;
      return true;
    },
  });
  writeRoll(p, ROLL_IDLE);
  assert.deepEqual(writes, [], "idle player produces no patches");
  writeRoll(p, { left: 3, cd: 140, dx: 1, dy: 0 });
  assert.deepEqual(writes.sort(), ["rollCd", "rollDx", "rollLeft"]);
  assert.deepEqual(readRoll(target), { left: 3, cd: 140, dx: 1, dy: 0 });
  assert.equal(rollCooldownMs({ left: 0, cd: 30, dx: 0, dy: 0 }), 30 * INPUT_DT_MS);
});

test("sanitizeInput: roll/walk only when strictly true, clamps, rejects garbage", () => {
  assert.deepEqual(sanitizeInput({ seq: 1, mx: 2, my: 0, aim: 0, roll: 1, walk: true }), {
    seq: 1, mx: 1, my: 0, aim: 0, fire: false, roll: false, walk: true,
  });
  const evil = sanitizeInput({ seq: 5, mx: 99, my: -99, aim: 10, fire: "yes", roll: "yes", walk: {} })!;
  assert.deepEqual({ mx: evil.mx, my: evil.my, fire: evil.fire, roll: evil.roll, walk: evil.walk }, {
    mx: 1, my: -1, fire: false, roll: false, walk: false,
  });
  assert.ok(evil.aim >= -Math.PI && evil.aim <= Math.PI);
  assert.equal(sanitizeInput({ seq: 1.5, mx: 0, my: 0, aim: 0 }), null);
  assert.equal(sanitizeInput({ seq: -1, mx: 0, my: 0, aim: 0 }), null);
  assert.equal(sanitizeInput({ seq: 1, mx: NaN, my: 0, aim: 0 }), null);
  assert.equal(sanitizeInput({ seq: 1, mx: 0, my: 0, aim: Infinity }), null);
  assert.equal(sanitizeInput("input"), null);
  assert.equal(sanitizeInput(null), null);
});
