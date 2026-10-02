import { test } from "node:test";
import assert from "node:assert/strict";
import { INPUT_DT_MS, MAX_QUEUED_INPUTS, PLAYER, SERVER_TICK_MS } from "@extract/shared";
import { MAX_ALLOWANCE_MS } from "./match.js";
import { ids, pl, place, run, send, testMatch } from "./test-utils.js";

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

test("replayed or out-of-order input seqs are dropped; lastSeq echoes the last applied one", () => {
  const m = testMatch(1);
  const [a] = ids(m);
  assert.ok(m.enqueueInput(a!, { seq: 5, mx: 0, my: 0, aim: 0, fire: false }));
  assert.ok(!m.enqueueInput(a!, { seq: 5, mx: 1, my: 0, aim: 0, fire: false }));
  assert.ok(!m.enqueueInput(a!, { seq: 3, mx: 1, my: 0, aim: 0, fire: false }));
  assert.ok(!m.enqueueInput(a!, { seq: "x" }));
  assert.ok(!m.enqueueInput(a!, null));
  assert.ok(m.enqueueInput(a!, { seq: 6, mx: 0, my: 0, aim: 1.5, fire: false }));
  run(m, 100);
  assert.equal(pl(m, a!).lastSeq, 6);
  assert.equal(pl(m, a!).aim, 1.5);
});

test("re-attaching a human re-keys the player and restarts the seq", () => {
  const m = testMatch(2);
  const [a] = ids(m);
  const rt = m.attachHuman("user0", "sess-A")!;
  assert.equal(rt.id, "sess-A");
  assert.ok(!m.player(a!));
  assert.equal(m.player("sess-A")!.userId, "user0");
  assert.ok(m.enqueueInput("sess-A", { seq: 100, mx: 0, my: 0, aim: 0, fire: false }));
  m.detach("sess-A");
  assert.equal(m.attachHuman("user0", "sess-B")!.id, "sess-B");
  assert.ok(!m.player("sess-A"));
  assert.ok(m.enqueueInput("sess-B", { seq: 0, mx: 0, my: 0, aim: 0, fire: false }));
  assert.equal(m.attachHuman("nobody", "sess-C"), null);
});
