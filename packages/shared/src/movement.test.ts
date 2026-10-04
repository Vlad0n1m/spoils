import assert from "node:assert/strict";
import { test } from "node:test";
import { INPUT_DT_MS, PLAYER, ROLL } from "./constants.js";
import { SOLID, buildCollisionIndex, circleIsFree } from "./geometry.js";
import { mulberry32 } from "./rng.js";
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

// --- windows: walking never passes, the roll vaults, a roll ending inside leaves on the nearer side

/**
 * A building wall at x 600..624 with a 112 px window at y 944..1056 (walls above and below). A body
 * at y 1000 clears both wall ends by 32 px, so only the window decides. The window band of body
 * centres is x ∈ (576, 648): face − radius .. face + thickness + radius.
 */
const WIN = { x: 600, y: 944, w: 24, h: 112 };
const winIdx = buildCollisionIndex(
  {
    rects: [
      { x: 600, y: 0, w: 24, h: 944, f: SOLID.ALL },
      { ...WIN, f: SOLID.WINDOW },
      { x: 600, y: 1056, w: 24, h: 944, f: SOLID.ALL },
    ],
    circles: [],
  },
  2000, 2000,
);
const BAND_LO = WIN.x - PLAYER.RADIUS;
const BAND_HI = WIN.x + WIN.w + PLAYER.RADIUS;
/** Float slack: a body flush against a face is not inside (VAULT_SLACK in geometry.ts). */
const EPS = 1e-6;
const inWindow = (x: number, y: number) => !circleIsFree(winIdx, x, y, PLAYER.RADIUS - EPS, SOLID.VAULT);
const clear = (x: number, y: number) => circleIsFree(winIdx, x, y, PLAYER.RADIUS - EPS, SOLID.MOVE);

/** Run `n` inputs from (x, y); returns the end state and whether any input ended inside the window. */
function drive(x: number, y: number, n: number, input: (i: number) => ReturnType<typeof I>, vault = true) {
  let roll: RollState = { ...ROLL_IDLE };
  let crossed = false;
  for (let i = 0; i < n; i++) {
    const r = stepMovement(winIdx, x, y, roll, input(i), 1, 1, vault);
    ({ x, y, roll } = r);
    if (inWindow(x, y)) crossed = true;
  }
  return { x, y, roll, crossed };
}

test("window: walking into it is blocked from both sides, like a wall", () => {
  const out = drive(500, 1000, 90, () => I({ mx: 1 }));
  assert.ok(near(out.x, BAND_LO, 1e-6), `outside face, x=${out.x}`);
  assert.equal(out.crossed, false);
  const back = drive(760, 1000, 90, () => I({ mx: -1 }));
  assert.ok(near(back.x, BAND_HI, 1e-6), `inside face, x=${back.x}`);
  // Diagonal pressing slides along the face but never enters the opening.
  const diag = drive(560, 900, 120, () => I({ mx: 1, my: 0.4 }));
  assert.ok(diag.x <= BAND_LO + EPS && !diag.crossed, `x=${diag.x}`);
});

test("window: a dodge roll vaults through and lands clear on the far side", () => {
  const out = drive(560, 1000, ROLL.TICKS, (i) => I({ mx: 1, roll: i === 0 }));
  assert.ok(out.crossed, "the swept path crossed the window");
  assert.ok(near(out.x, 560 + ROLL.DISTANCE, 1e-6) && out.y === 1000, `x=${out.x}`);
  assert.ok(clear(out.x, out.y));
  assert.equal(out.roll.left, 0);
  // And back out the other way once the cooldown is over.
  let roll = out.roll, x = out.x, y = out.y;
  for (let i = 0; i < ROLL.COOLDOWN_TICKS; i++) ({ x, y, roll } = stepMovement(winIdx, x, y, roll, I()));
  for (let i = 0; i < ROLL.TICKS; i++) ({ x, y, roll } = stepMovement(winIdx, x, y, roll, I({ mx: -1, roll: i === 0 })));
  assert.ok(near(x, 560, 1e-6), `rolled back to x=${x}`);
});

test("window: a roll that ends inside the opening leaves it on the nearer side along the roll axis", () => {
  // End centre c = start + DISTANCE; the band is (576, 648), its middle 612.
  for (const c of [580, 590, 600, 611, 613, 630, 646]) {
    const out = drive(c - ROLL.DISTANCE, 1000, ROLL.TICKS, (i) => I({ mx: 1, roll: i === 0 }));
    assert.ok(!inWindow(out.x, out.y), `c=${c}: still in the window at x=${out.x}`);
    assert.equal(out.y, 1000, `c=${c}: left along the roll axis`);
    const forward = BAND_HI - c <= c - BAND_LO;
    if (forward) assert.ok(out.x >= BAND_HI - EPS && out.x <= BAND_HI + 2, `c=${c}: finished the vault, x=${out.x}`);
    else assert.ok(out.x <= BAND_LO + EPS && out.x >= BAND_LO - 2, `c=${c}: backed out, x=${out.x}`);
    assert.ok(clear(out.x, out.y), `c=${c}: clear of every solid`);
  }
  // The same from the inside, rolling out (−x): "forward" is now toward the outside.
  const out = drive(630 + ROLL.DISTANCE, 1000, ROLL.TICKS, (i) => I({ mx: -1, roll: i === 0 }));
  assert.ok(out.x >= BAND_HI - EPS && out.x <= BAND_HI + 2, `nearer side is back inside, x=${out.x}`);
  // A diagonal roll that stops in the opening leaves along its own axis too (no sideways pop).
  const d = drive(612 - 140, 1000 - 140, ROLL.TICKS, (i) => I({ mx: 1, my: 1, roll: i === 0 }));
  assert.ok(!inWindow(d.x, d.y) && clear(d.x, d.y), `diag ${d.x},${d.y}`);
});

test("window: vault=false (NPCs) rolls into it like a wall; the wall beside the window stops every roll", () => {
  const npc = drive(560, 1000, ROLL.TICKS, (i) => I({ mx: 1, roll: i === 0 }), false);
  assert.ok(near(npc.x, BAND_LO, 1e-6) && !npc.crossed, `npc x=${npc.x}`);
  const wall = drive(560, 700, ROLL.TICKS, (i) => I({ mx: 1, roll: i === 0 }));
  assert.ok(wall.x <= BAND_LO + EPS && !wall.crossed, `wall x=${wall.x}`);
  // Only the window's own span passes: a roll whose body overlaps the wall end slides off it.
  const edge = drive(560, 944 + 10, ROLL.TICKS, (i) => I({ mx: 1, roll: i === 0 }));
  assert.ok(clear(edge.x, edge.y), `edge ${edge.x},${edge.y}`);
});

test("window: replay determinism around a window, every input ends outside it", () => {
  const rng = mulberry32(77);
  const inputs = Array.from({ length: 1500 }, (_, i) => {
    const toward = i % 300 < 150 ? 1 : -1;
    return I({ mx: toward * (0.6 + rng() * 0.4), my: (rng() - 0.5) * 0.6, aim: rng() * 6, roll: rng() < 0.08, walk: rng() < 0.1 });
  });
  const run = (from: number, s0: RollState, x0: number, y0: number) => {
    let s = s0, x = x0, y = y0;
    const out: Array<[number, number, RollState]> = [];
    for (let i = from; i < inputs.length; i++) {
      const r = stepMovement(winIdx, x, y, s, inputs[i]!);
      ({ x, y, roll: s } = r);
      if (s.left === 0) assert.ok(!inWindow(x, y), `input ${i} ended in the window at ${x},${y}`);
      out.push([x, y, s]);
    }
    return out;
  };
  const full = run(0, { ...ROLL_IDLE }, 450, 1000);
  const sides = new Set(full.map(([x]) => (x < WIN.x ? "out" : "in")));
  assert.deepEqual([...sides].sort(), ["in", "out"], "the stream vaulted the window");
  for (const k of [1, 333, 777, 1201]) {
    const [xk, yk, sk] = full[k - 1]!;
    assert.deepEqual(run(k, sk, xk, yk), full.slice(k), `suffix from ${k}`);
  }
});
