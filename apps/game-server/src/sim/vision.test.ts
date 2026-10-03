import { test } from "node:test";
import assert from "node:assert/strict";
import { NPC, SERVER_TICK_MS, VISION, generateMap, mulberry32, visionRangeMult } from "@extract/shared";
import { damagePlayer } from "./combat.js";
import { envNow } from "./environment.js";
import { Match } from "./match.js";
import { counterUid, humans, ids, npcOpts, npcsOf, place, pl, rtOf, testMap, testMatch, testPost } from "./test-utils.js";
import type { PlayerRuntime } from "./types.js";

/** A wall from (1300, 600) to (1324, 1400): splits the arena left / right around y = 1000. */
const WALL = { x: 1300, y: 600, w: 24, h: 800 };

/** Advance in real ticks (Match.step clamps one step to 250 ms). */
function adv(m: Match, ms: number): void {
  for (let t = 0; t < ms; t += SERVER_TICK_MS) m.step(SERVER_TICK_MS);
}

function setup(n = 2, opts: Parameters<typeof testMatch>[1] = {}) {
  // envSeed 2 = midday clear (seed 1 is a night raid: range × 0.52).
  const m = testMatch(n, { envSeed: 2, map: testMap({ walls: [WALL], bushes: [{ x: 2000, y: 2400, r: 60 }] }), ...opts });
  const id = ids(m);
  const r = (k: number) => rtOf(m, id[k]!).rosterIndex;
  return { m, id, r };
}

test("vision: open line of sight inside the cone is seen; a wall or the back cone hides", () => {
  const { m, id, r } = setup(3);
  place(m, id[0]!, 1000, 2000);
  place(m, id[1]!, 1600, 2000);
  place(m, id[2]!, 1600, 1000); // out of A's range for now; behind the wall once A moves to y 1000
  pl(m, id[0]!).aim = 0;
  pl(m, id[1]!).aim = 0; // facing away from A
  pl(m, id[2]!).aim = Math.PI;
  m.step(SERVER_TICK_MS);
  assert.equal(m.vision.sees(r(0), r(1)), true, "A sees B in front at 600 px");
  assert.equal(m.vision.sees(r(1), r(0)), false, "B looks away: A is 600 px behind it");
  assert.equal(m.vision.sees(r(0), r(0)), true, "self");
  // C and A on opposite sides of the wall at y 1000.
  place(m, id[0]!, 1000, 1000);
  place(m, id[1]!, 1400, 1800);
  m.step(SERVER_TICK_MS);
  adv(m, VISION.HYSTERESIS_MS + SERVER_TICK_MS);
  assert.equal(m.vision.sees(r(0), r(2)), false, "wall between A and C");
  assert.equal(m.vision.sees(r(2), r(0)), false, "and the other way round");
  assert.deepEqual(m.vision.row(r(0)), [r(1)], "B is still in view below the wall's end");
});

test("vision: awareness radius sees behind you up close", () => {
  const { m, id, r } = setup(2);
  place(m, id[0]!, 1000, 2000);
  place(m, id[1]!, 1000 - 100, 2000);
  pl(m, id[0]!).aim = 0;
  m.step(SERVER_TICK_MS);
  assert.equal(m.vision.sees(r(0), r(1)), true, "100 px behind: inside SERVER_AWARE_R");
  place(m, id[1]!, 1000 - 300, 2000);
  adv(m, VISION.HYSTERESIS_MS + 2 * SERVER_TICK_MS);
  assert.equal(m.vision.sees(r(0), r(1)), false, "300 px behind: not seen");
});

test("vision: 300 ms hysteresis after LOS is lost, and the flips are reported", () => {
  const { m, id, r } = setup(2);
  place(m, id[0]!, 1000, 1000);
  place(m, id[1]!, 1250, 1000);
  pl(m, id[0]!).aim = 0;
  m.step(SERVER_TICK_MS);
  assert.ok(m.vision.drainChanges().some((c) => c.viewer === r(0) && c.target === r(1) && c.on));
  const t0 = m.clock;
  place(m, id[1]!, 1500, 1000); // behind the wall now
  let lost = -1;
  for (let k = 0; k < 10; k++) {
    m.step(SERVER_TICK_MS);
    const ch = m.vision.drainChanges();
    if (!m.vision.sees(r(0), r(1)) && lost < 0) {
      lost = m.clock - t0;
      assert.ok(ch.some((c) => c.viewer === r(0) && c.target === r(1) && !c.on), "off flip reported");
    }
  }
  assert.equal(lost, VISION.HYSTERESIS_MS + SERVER_TICK_MS, "still published at +300, gone at +350");
});

test("vision: a killed target is published ≤ 300 ms more (the alive=false patch), a dead viewer sees nobody", () => {
  const { m, id, r } = setup(2);
  place(m, id[0]!, 1000, 2000);
  place(m, id[1]!, 1400, 2000);
  pl(m, id[0]!).aim = 0;
  pl(m, id[1]!).aim = Math.PI;
  m.step(SERVER_TICK_MS);
  assert.ok(m.vision.sees(r(0), r(1)) && m.vision.sees(r(1), r(0)));
  damagePlayer(m, rtOf(m, id[1]!), 1000, rtOf(m, id[0]!), "rifle", 1400, 2000);
  assert.equal(pl(m, id[1]!).alive, false);
  assert.equal(m.vision.sees(r(1), r(0)), false, "the dead viewer's row is cleared at once");
  m.step(SERVER_TICK_MS);
  assert.equal(m.vision.sees(r(0), r(1)), true, "the body is still sent right after death");
  adv(m, VISION.HYSTERESIS_MS);
  assert.equal(m.vision.sees(r(0), r(1)), false, "then dropped");
  adv(m, 1000);
  assert.deepEqual(m.vision.row(r(1)), [], "a dead viewer never sees again");
});

test("vision: env vis shrinks the range; a muzzle flash ignores it", () => {
  const { m, id, r } = setup(2, { weatherOverride: "fog" });
  m.step(SERVER_TICK_MS);
  const R = VISION.RANGE * visionRangeMult(envNow(m).vis);
  assert.ok(R < VISION.RANGE - 150, `fog must shrink the range (R=${R})`);
  place(m, id[0]!, 1000, 2000);
  place(m, id[1]!, 1000 + R + 100, 2000);
  pl(m, id[0]!).aim = 0;
  m.step(SERVER_TICK_MS);
  assert.equal(m.vision.sees(r(0), r(1)), false, "beyond the fog range");
  rtOf(m, id[1]!).lastShotAt = m.clock + SERVER_TICK_MS;
  m.step(SERVER_TICK_MS);
  assert.equal(m.vision.sees(r(0), r(1)), true, "a shot lights the shooter up");
});

test("vision: a still player in a bush is hidden beyond BUSH_REVEAL_R until it shoots", () => {
  const { m, id, r } = setup(2);
  place(m, id[0]!, 1700, 2400);
  place(m, id[1]!, 2000, 2400); // bush centre
  pl(m, id[0]!).aim = 0;
  rtOf(m, id[1]!).movedAt = -10_000;
  m.step(SERVER_TICK_MS);
  assert.equal(m.vision.sees(r(0), r(1)), false, "300 px from a still bush camper");
  place(m, id[0]!, 1860, 2400);
  m.step(SERVER_TICK_MS);
  assert.equal(m.vision.sees(r(0), r(1)), true, "140 px: inside BUSH_REVEAL_R");
  place(m, id[0]!, 1600, 2400);
  adv(m, VISION.HYSTERESIS_MS + 2 * SERVER_TICK_MS);
  assert.equal(m.vision.sees(r(0), r(1)), false);
  rtOf(m, id[1]!).lastShotAt = m.clock;
  m.step(SERVER_TICK_MS);
  assert.equal(m.vision.sees(r(0), r(1)), true, "shooting cancels the bush");
});

test("vision: rows are by roster index and survive a reconnect re-key; NPCs use NPC.VIEW_RANGE_CAP, never look at NPCs, and sleep when dormant", () => {
  const m = testMatch(2, {
    ...npcOpts([testPost(0, 1000, 2050), testPost(1, 1100, 2250)]),
    npcBrains: false,
    envSeed: 2,
  });
  const [a, b] = ids(m);
  const [npc, npc2] = npcsOf(m) as [PlayerRuntime, PlayerRuntime];
  place(m, a!, 1000, 2000);
  place(m, b!, 1900, 2000);
  pl(m, a!).aim = 0;
  npc.pub.aim = 0;
  npc2.pub.aim = -Math.PI / 2;
  m.step(SERVER_TICK_MS);
  const ra = rtOf(m, a!).rosterIndex, rb = rtOf(m, b!).rosterIndex;
  assert.equal(NPC.VIEW_RANGE_CAP, 800);
  assert.equal(m.vision.sees(ra, rb), true, "a human sees 900 px");
  assert.equal(m.vision.sees(npc.rosterIndex, rb), false, "an NPC is capped at 800 px");
  assert.equal(m.vision.sees(npc.rosterIndex, ra), true, "an NPC sees a human up close");
  assert.equal(m.vision.sees(ra, npc.rosterIndex), true, "humans see NPCs");
  assert.equal(m.vision.sees(npc2.rosterIndex, npc.rosterIndex), false, "NPC → NPC is never computed");
  m.attachHuman("user1", "fresh-session");
  m.step(SERVER_TICK_MS);
  assert.equal(m.vision.sees(ra, rb), true, "same row after the target's re-key");
  // Dormant (no row computed) while flagged; awake again it sees.
  npc.dormant = true;
  m.vision.clearRow(npc.rosterIndex);
  m.vision.update(m);
  assert.deepEqual(m.vision.row(npc.rosterIndex), [], "a dormant NPC sees nothing");
  assert.equal(m.vision.sees(ra, npc.rosterIndex), true, "…but stays a target");
  npc.dormant = false;
  m.vision.update(m);
  assert.equal(m.vision.sees(npc.rosterIndex, ra), true);
});

test("vision pass: 32 clustered players on the Steppe stay inside the per-tick budget", () => {
  const map = generateMap("steppe");
  const m = new Match({
    roster: humans(32), rng: mulberry32(5), map, newUid: counterUid, now: () => 0,
    emptyWorld: true, npcBrains: false, envSeed: 3, weatherOverride: "clear",
  });
  const rng = mulberry32(9);
  // Everyone within ~1600 px of the first spawn: the worst case for the pair loop.
  const cx = map.spawns[0]!.x, cy = map.spawns[0]!.y;
  for (const rt of m.allRuntimes()) {
    rt.pub.x = Math.min(map.width - 100, Math.max(100, cx + (rng() - 0.5) * 1600));
    rt.pub.y = Math.min(map.height - 100, Math.max(100, cy + (rng() - 0.5) * 1600));
    rt.pub.aim = rng() * Math.PI * 2;
  }
  m.step(SERVER_TICK_MS);
  const N = 200;
  const t0 = performance.now();
  for (let k = 0; k < N; k++) {
    for (const rt of m.allRuntimes()) rt.pub.aim += 0.05;
    m.vision.update(m);
  }
  const per = (performance.now() - t0) / N;
  console.log(`vision.update, 32 clustered players: ${per.toFixed(3)} ms`);
  // Budget 0.2 ms on a dev machine; the assert leaves room for slow CI hosts.
  assert.ok(per < 1.5, `vision pass ${per.toFixed(3)} ms`);
});

test("vision: flipping aim between θ and θ+π every input does not give 360° vision (turn-rate-limited cone)", async () => {
  const { VIEW_TURN_PER_INPUT, turnToward } = await import("./vision.js");
  const run = (pattern: (k: number) => number, targetDx: number) => {
    const m = testMatch(2, { envSeed: 2 });
    const [v, t] = ids(m);
    place(m, v!, 1500, 2000);
    place(m, t!, 1500 + targetDx, 2000);
    const rv = rtOf(m, v!).rosterIndex, rt = rtOf(m, t!).rosterIndex;
    let seq = 0;
    let seen = 0;
    for (let tick = 0; tick < 80; tick++) {
      // 30 Hz inputs over 50 ms ticks: 1 or 2 inputs per tick.
      const n = tick % 2 === 0 ? 2 : 1;
      for (let i = 0; i < n; i++, seq++) m.enqueueInput(v!, { seq: seq + 1, mx: 0, my: 0, aim: pattern(seq), fire: false });
      m.step(SERVER_TICK_MS);
      m.drainEvents();
      if (tick >= 10 && m.vision.sees(rv, rt)) seen++;
    }
    return seen;
  };
  assert.equal(run(() => 0, -500), 0, "honest: nothing 500 px behind");
  assert.equal(run((k) => (k % 2 ? Math.PI : 0), -500), 0, "alternating 0 / π every input");
  assert.equal(run((k) => (Math.floor(k / 3) % 2 ? Math.PI : 0), -500), 0, "switching every 3 inputs");
  assert.ok(run(() => Math.PI, -500) >= 60, "an honest turn still sees behind once the cone got there");
  assert.ok(run((k) => (k % 2 ? Math.PI : 0), 500) >= 60, "the front stays seen");
  assert.ok(Math.abs(turnToward(0, Math.PI - 0.01, VIEW_TURN_PER_INPUT) - VIEW_TURN_PER_INPUT) < 1e-9);
  assert.equal(turnToward(3, -3, 1), Math.atan2(Math.sin(-3), Math.cos(-3)), "short way across ±π");
});
