import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACT, INPUT_DT_MS, MAX_QUEUED_INPUTS, PLAYER, ROLL, SERVER_TICK_MS, SoundKind, WEAPONS, readRoll, ROLL_IDLE, stepMovement,
} from "@extract/shared";
import { MAX_ALLOWANCE_MS } from "./match.js";
import { giveWeapon, ids, pl, place, rtOf, run, selfOf, send, shotsBy, testMatch } from "./test-utils.js";

test("1000 inputs in one tick cannot move a player faster than PLAYER.SPEED", () => {
  const m = testMatch(1);
  const [a] = ids(m);
  place(m, a!, 1000, 1500);
  const p = pl(m, a!);

  for (let i = 0; i < 1000; i++) send(m, a!, { mx: 1 });
  assert.equal(m.runtime(a!)!.queue.length, MAX_QUEUED_INPUTS);
  m.step(SERVER_TICK_MS);
  assert.ok(p.x - 1000 <= (PLAYER.SPEED * SERVER_TICK_MS) / 1000 + 1e-6, `moved ${p.x - 1000}`);

  // Keep flooding every tick for 2 s: distance stays within SPEED × elapsed.
  for (let t = 0; t < 40; t++) {
    for (let i = 0; i < 1000; i++) send(m, a!, { mx: 1 });
    m.step(SERVER_TICK_MS);
  }
  const elapsed = m.clock / 1000;
  assert.ok(p.x - 1000 <= PLAYER.SPEED * elapsed + 1e-6, `moved ${p.x - 1000} in ${elapsed}s`);
  // ... and an honest 30 Hz client still moves at full speed.
  assert.ok(p.x - 1000 >= PLAYER.SPEED * (elapsed - 0.1));
});

test("idle time banks at most MAX_ALLOWANCE_MS of movement", () => {
  const m = testMatch(1);
  const [a] = ids(m);
  place(m, a!, 1000, 1500);
  const p = pl(m, a!);
  run(m, 3000); // no inputs
  for (let i = 0; i < 1000; i++) send(m, a!, { mx: 1 });
  m.step(SERVER_TICK_MS);
  const maxInputs = Math.floor((MAX_ALLOWANCE_MS + 1e-6) / INPUT_DT_MS);
  assert.ok(p.x - 1000 <= maxInputs * (PLAYER.SPEED * INPUT_DT_MS) / 1000 + 1e-6);
});

test("replayed or out-of-order input seqs are dropped; lastSeq (in SelfState) echoes the last applied one", () => {
  const m = testMatch(1);
  const [a] = ids(m);
  assert.ok(m.enqueueInput(a!, { seq: 5, mx: 0, my: 0, aim: 0, fire: false }));
  assert.ok(!m.enqueueInput(a!, { seq: 5, mx: 1, my: 0, aim: 0, fire: false }));
  assert.ok(!m.enqueueInput(a!, { seq: 3, mx: 1, my: 0, aim: 0, fire: false }));
  assert.ok(!m.enqueueInput(a!, { seq: "x" }));
  assert.ok(!m.enqueueInput(a!, null));
  assert.ok(m.enqueueInput(a!, { seq: 6, mx: 0, my: 0, aim: 1.5, fire: false }));
  run(m, 100);
  assert.equal(selfOf(m, a!).lastSeq, 6);
  assert.equal(pl(m, a!).aim, 1.5);
});

test("re-attaching a human re-keys the player (same instances, stable self key) and restarts the seq", () => {
  const m = testMatch(2);
  const [a] = ids(m);
  const rt0 = rtOf(m, a!);
  const pub = rt0.pub, self = rt0.self;
  const rt = m.attachHuman("user0", "sess-A")!;
  assert.equal(rt.id, "sess-A");
  assert.equal(rt.selfKey, "p0");
  assert.ok(!m.player(a!));
  assert.equal(m.player("sess-A"), pub);
  assert.equal(m.state.self.get("p0"), self);
  assert.equal(self.userId, "user0");
  assert.ok(m.enqueueInput("sess-A", { seq: 100, mx: 0, my: 0, aim: 0, fire: false }));
  m.detach("sess-A");
  assert.equal(m.attachHuman("user0", "sess-B")!.id, "sess-B");
  assert.ok(!m.player("sess-A"));
  assert.equal(pub.sessionId, "sess-B");
  assert.ok(m.enqueueInput("sess-B", { seq: 0, mx: 0, my: 0, aim: 0, fire: false }));
  assert.equal(m.attachHuman("nobody", "sess-C"), null);
});

test("roll: exactly ROLL.DISTANCE in ROLL.TICKS inputs, then the cooldown; state lives in SelfState", () => {
  const m = testMatch(1);
  const [a] = ids(m);
  place(m, a!, 1000, 1500);
  const p = pl(m, a!);
  const s = selfOf(m, a!);
  send(m, a!, { mx: 1, roll: true });
  for (let i = 1; i < ROLL.TICKS; i++) send(m, a!, { mx: 1 });
  const ev = run(m, 400);
  assert.ok(Math.abs(p.x - 1000 - ROLL.DISTANCE) < 1e-6, `rolled ${p.x - 1000}`);
  assert.equal(s.rollLeft, 0);
  // The cooldown counts inputs from the roll START (the start input itself sets it).
  assert.equal(s.rollCd, ROLL.COOLDOWN_TICKS - (ROLL.TICKS - 1));
  assert.ok(ev.some((e) => e.type === "sound" && e.kind === SoundKind.roll));
  // A second request during the cooldown is ignored: plain walking speed.
  const x0 = p.x;
  send(m, a!, { mx: 1, roll: true });
  run(m, 50);
  assert.ok(p.x - x0 <= (PLAYER.SPEED * INPUT_DT_MS) / 1000 + 1e-6);
});

test("roll while standing still goes toward the aim; ACT.ROLL is public while rolling", () => {
  const m = testMatch(1);
  const [a] = ids(m);
  place(m, a!, 1000, 1500);
  send(m, a!, { aim: Math.PI / 2, roll: true });
  m.step(SERVER_TICK_MS);
  assert.equal(pl(m, a!).act & ACT.ROLL, ACT.ROLL);
  assert.ok(pl(m, a!).y > 1500);
  assert.ok(Math.abs(pl(m, a!).x - 1000) < 1e-6);
  run(m, 500, { [a!]: {} });
  assert.equal(pl(m, a!).act & ACT.ROLL, 0);
});

test("roll cancels a heal (item kept); no shots while rolling; a held auto trigger fires right after", () => {
  const m = testMatch(1);
  const [a] = ids(m);
  place(m, a!, 1000, 1500);
  const rt = rtOf(m, a!);
  rt.pub.hp = 50;
  giveWeapon(m, a!, "w2", "rifle");
  m.switchSlot(a!, "w2");
  assert.ok(m.heal(a!, "bandage"));
  send(m, a!, { mx: 1, roll: true, fire: true });
  const ev: ReturnType<typeof run> = [];
  for (let i = 0; i < ROLL.TICKS - 1; i++) {
    send(m, a!, { mx: 1, fire: true });
    if (i % 2 === 1) ev.push(...run(m, SERVER_TICK_MS));
  }
  assert.equal(rt.self.healUntil, 0);
  assert.equal(rt.pub.hp, 50);
  ev.push(...run(m, 200));
  // Queue drained, still rolling inputs only: no shot yet.
  assert.equal(shotsBy(ev, m, a!).length, 0);
  const after = run(m, 200, { [a!]: { fire: true } });
  assert.ok(shotsBy(after, m, a!).length >= 1);
});

test("reload keeps running through a roll", () => {
  const m = testMatch(1);
  const [a] = ids(m);
  place(m, a!, 1000, 1500);
  const rt = rtOf(m, a!);
  rt.self.slots.get("w1")!.mag = 0;
  assert.ok(m.reload(a!));
  send(m, a!, { mx: 1, roll: true });
  run(m, WEAPONS.pistol.reloadMs + 100, { [a!]: { mx: 1 } });
  assert.equal(rt.self.slots.get("w1")!.mag, WEAPONS.pistol.magSize);
});

test("walk (Shift) halves speed and is mirrored in SelfState.walking / ACT.WALK; malicious samples are sanitized", () => {
  const m = testMatch(1);
  const [a] = ids(m);
  place(m, a!, 1000, 1500);
  const p = pl(m, a!);
  run(m, 1000, { [a!]: { mx: 1, walk: true } });
  assert.ok(Math.abs(p.x - 1000 - PLAYER.SPEED * PLAYER.WALK_SPEED_MULT) < 6, `walked ${p.x - 1000}`);
  assert.equal(selfOf(m, a!).walking, true);
  assert.equal(p.act & ACT.WALK, ACT.WALK);
  const x0 = p.x;
  // roll:"yes" is not a roll, mx 99 is clamped to 1.
  assert.ok(m.enqueueInput(a!, { seq: 10_000, mx: 99, my: 0, aim: 0, fire: false, roll: "yes" as unknown as boolean }));
  run(m, 50);
  assert.equal(selfOf(m, a!).rollLeft, 0);
  assert.ok(p.x - x0 <= (PLAYER.SPEED * INPUT_DT_MS) / 1000 + 1e-6);
});

test("server roll replay equals the shared stepMovement run on the same inputs (prediction parity)", () => {
  const m = testMatch(1);
  const [a] = ids(m);
  place(m, a!, 2800, 3200);
  const inputs = Array.from({ length: 200 }, (_, i) => ({
    mx: Math.cos(i / 9), my: Math.sin(i / 7), aim: i / 5, roll: i % 37 === 3, walk: i % 50 > 40,
  }));
  let x = 2800, y = 3200, roll = { ...ROLL_IDLE };
  const idx = m.idx;
  for (const inp of inputs) {
    const r = stepMovement(idx, x, y, roll, inp);
    x = r.x; y = r.y; roll = r.roll;
  }
  // Fed at 30 Hz like a client (the queue holds at most MAX_QUEUED_INPUTS).
  let acc = 0, i = 0;
  while (i < inputs.length) {
    acc += SERVER_TICK_MS;
    while (acc >= INPUT_DT_MS - 1e-6 && i < inputs.length) {
      acc -= INPUT_DT_MS;
      send(m, a!, { ...inputs[i++]!, fire: false });
    }
    m.step(SERVER_TICK_MS);
  }
  run(m, 200);
  assert.equal(pl(m, a!).x, x);
  assert.equal(pl(m, a!).y, y);
  assert.deepEqual(readRoll(selfOf(m, a!)), roll);
});
