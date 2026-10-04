/**
 * Windows in the authoritative sim: a wall segment that blocks walking (players and NPC nav), that
 * a player's dodge roll vaults (the server runs the same shared stepMovement the client predicts
 * with), that bullets and sight pass as open space (players and NPCs shoot and see through it), and
 * that sound passes as an opening in a wall (SOUND.WINDOW_MULT, no muffle flag).
 *
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/game-server/src/sim/windows.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LEGACY_WORLD,
  NPC,
  PLAYER,
  ROLL,
  ROLL_IDLE,
  SERVER_TICK_MS,
  SOLID,
  SOUND,
  SoundKind,
  VISION,
  circleIsFree,
  decodeSoundMsg,
  getCollisionIndex,
  readRoll,
  sanitizeInput,
  stepMovement,
  terrainAt,
  terrainSpeedMult,
  walkCellOf,
  type InputSample,
  type MapData,
  type SoundMsg,
} from "@extract/shared";
import { damagePlayer } from "./combat.js";
import type { Match } from "./match.js";
import { mapRuntime, navGridFor } from "./nav.js";
import { emitSound } from "./sound.js";
import { ids, npcOpts, npcsOf, pl, place, rtOf, run, selfOf, send, shotsBy, testMap, testMatch, testPost } from "./test-utils.js";
import type { MatchEvent, PlayerRuntime } from "./types.js";

/**
 * A wall across the whole arena at x 2600..2624 with a 112 px window at y 944..1056 and a 96 px
 * door at y 2000..2096 (the only walkable way between the west and east halves).
 */
const WX = 2600;
const WIN = { x: WX, y: 944, w: 24, h: 112 };
const DOOR = { y0: 2000, y1: 2096 };
const H = LEGACY_WORLD.HEIGHT;
const WEST = WX - PLAYER.RADIUS; // body centre flush against the west face
const EAST = WX + WIN.w + PLAYER.RADIUS; // … the east face
const EPS = 1e-6;

/** The wall with its window (`window` false: the same span is solid wall). */
function windowMap(window = true, win: { x: number; y: number; w: number; h: number } = WIN): MapData {
  const walls = [
    { x: WX, y: 0, w: 24, h: win.y },
    { x: WX, y: win.y + win.h, w: 24, h: DOOR.y0 - (win.y + win.h) },
    { x: WX, y: DOOR.y1, w: 24, h: H - DOOR.y1 },
  ];
  return window ? testMap({ walls, windows: [win] }) : testMap({ walls: [...walls, win] });
}

const inWindow = (m: Match, x: number, y: number) => !circleIsFree(m.idx, x, y, PLAYER.RADIUS - EPS, SOLID.VAULT);

/** Feed `samples` to player `id` at the client's 30 Hz (3 samples per 2 ticks), then drain the queue. */
function feed(m: Match, id: string, samples: ReadonlyArray<Partial<Omit<InputSample, "seq">>>, onApplied?: () => void): void {
  samples.forEach((s, i) => {
    send(m, id, s);
    if (i % 3 === 2) {
      m.step(SERVER_TICK_MS);
      onApplied?.();
      m.step(SERVER_TICK_MS);
      onApplied?.();
    }
  });
  for (let k = 0; k < 20 && rtOf(m, id).queue.length > 0; k++) {
    m.step(SERVER_TICK_MS);
    onApplied?.();
  }
  assert.equal(rtOf(m, id).queue.length, 0, "every sample applied");
}

/** The client's prediction of the same samples: shared stepMovement, terrain at the input's start. */
function predict(map: MapData, x: number, y: number, samples: ReadonlyArray<Partial<Omit<InputSample, "seq">>>) {
  const idx = getCollisionIndex(map);
  let roll = { ...ROLL_IDLE };
  samples.forEach((s, i) => {
    const input = sanitizeInput({ seq: i + 1, mx: 0, my: 0, aim: 0, fire: false, ...s })!;
    ({ x, y, roll } = stepMovement(idx, x, y, roll, input, 1, terrainSpeedMult(terrainAt(map, x, y))));
  });
  return { x, y, roll };
}

const repeat = <T,>(n: number, s: T): T[] => Array.from({ length: n }, () => s);

test("windows: walking stops at the face; a player's roll vaults it; the server equals the client's prediction", () => {
  const map = windowMap();
  const m = testMatch(1, { map });
  const [h] = ids(m);
  place(m, h!, WX - 150, 1000);
  const samples: Array<Partial<Omit<InputSample, "seq">>> = [
    ...repeat(40, { mx: 1 }), // walk into the window: stops at the west face
    { mx: 1, roll: true }, ...repeat(ROLL.TICKS - 1, { mx: 1 }), // vault east
    ...repeat(30, { mx: -1 }), // walk back: stops at the east face
    ...repeat(ROLL.COOLDOWN_TICKS, { aim: Math.PI }), // wait out the cooldown facing west
    { roll: true, aim: Math.PI }, ...repeat(ROLL.TICKS + 5, { aim: Math.PI }), // standing roll toward the aim: vault west
    ...repeat(ROLL.COOLDOWN_TICKS, { mx: 1, my: 0.35 }), // walk diagonally into the wall: slide, never enter
  ];
  const xs: number[] = [];
  let walkedIn = false;
  feed(m, h!, samples, () => {
    const p = pl(m, h!);
    xs.push(p.x);
    // Only a roll may leave a body inside the window at the end of a tick.
    if (inWindow(m, p.x, p.y) && selfOf(m, h!).rollLeft === 0) walkedIn = true;
  });
  assert.equal(walkedIn, false, "no tick ended with a non-rolling body inside the window");
  assert.ok(xs.some((x) => Math.abs(x - WEST) < EPS), "walking stopped flush at the west face");
  assert.ok(xs.some((x) => x > EAST + 100), "the roll carried the body through to the east side");
  assert.ok(xs.some((x) => Math.abs(x - EAST) < EPS), "walking back stopped at the east face");
  const p = pl(m, h!);
  assert.ok(p.x <= WEST + EPS && !inWindow(m, p.x, p.y), `ends west of the wall, x=${p.x}`);
  // Server authority and client prediction run the same samples to the same bits.
  const c = predict(map, WX - 150, 1000, samples);
  assert.deepEqual({ x: p.x, y: p.y, roll: readRoll(selfOf(m, h!)) }, c);
});

test("windows: an NPC's dodge roll treats a window as a wall (the server passes vault=false)", () => {
  const m = testMatch(1, { map: windowMap(), ...npcOpts([testPost(0, WX - 300, 1000)]), npcBrains: false });
  const npc = npcsOf(m)[0]!;
  place(m, ids(m)[0]!, 1000, 3000);
  place(m, npc.id, WX - 60, 1000);
  feed(m, npc.id, [{ mx: 1, roll: true }, ...repeat(ROLL.TICKS + 3, { mx: 1 })]);
  assert.ok(Math.abs(npc.pub.x - WEST) < EPS, `stopped at the face, x=${npc.pub.x}`);
  // A human on the same spot with the same inputs goes through.
  const m2 = testMatch(1, { map: windowMap() });
  const [h] = ids(m2);
  place(m2, h!, WX - 60, 1000);
  feed(m2, h!, [{ mx: 1, roll: true }, ...repeat(ROLL.TICKS + 3, { mx: 1 })]);
  assert.ok(pl(m2, h!).x > EAST, `human vaulted, x=${pl(m2, h!).x}`);
});

test("windows: NPC nav and the walk grid treat a window as a wall; the path goes through the door", () => {
  const map = windowMap();
  const { walk } = mapRuntime(map);
  for (let y = WIN.y + 8; y < WIN.y + WIN.h; y += 16) {
    for (const x of [WX + 4, WX + 12, WX + 20]) assert.equal(walk.blocked[walkCellOf(walk, x, y)], 1, `window cell ${x},${y}`);
  }
  const from = { x: WX - 200, y: 1000 }, to = { x: WX + 200, y: 1000 };
  const path = navGridFor(map).findPath(from, to);
  assert.ok(path && path.length > 0, "reachable through the door");
  assert.ok(path.some((q) => q.x > WX && q.y >= DOOR.y0 && q.y <= DOOR.y1 + 32), "crosses at the door");
  // Never within a body of the window rect.
  for (const q of path) {
    const dx = Math.max(WIN.x - q.x, 0, q.x - (WIN.x + WIN.w));
    const dy = Math.max(WIN.y - q.y, 0, q.y - (WIN.y + WIN.h));
    assert.ok(Math.hypot(dx, dy) >= PLAYER.RADIUS, `waypoint ${q.x},${q.y} touches the window`);
  }
});

test("windows: bullets pass a window and hit the target behind it; the wall beside it stops them", () => {
  const m = testMatch(2, { map: windowMap() });
  const [a, b] = ids(m);
  place(m, a!, WX - 150, 1000);
  place(m, b!, WX + 200, 1000);
  pl(m, b!).aim = Math.PI;
  const ev = run(m, 600, { [a!]: { aim: 0, fire: true } });
  assert.equal(shotsBy(ev, m, a!).length, 1);
  const hits = ev.filter((e) => e.type === "hit" && e.target === rtOf(m, b!).rosterIndex);
  assert.equal(hits.length, 1, "the shot through the window hit");
  assert.ok(pl(m, b!).hp < PLAYER.MAX_HP);
  // 300 px lower, the same shot meets the wall.
  const m2 = testMatch(2, { map: windowMap() });
  const [a2, b2] = ids(m2);
  place(m2, a2!, WX - 150, 1300);
  place(m2, b2!, WX + 200, 1300);
  const ev2 = run(m2, 600, { [a2!]: { aim: 0, fire: true } });
  assert.equal(shotsBy(ev2, m2, a2!).length, 1);
  assert.equal(ev2.filter((e) => e.type === "hit").length, 0, "the wall stopped it");
  assert.equal(pl(m2, b2!).hp, PLAYER.MAX_HP);
});

test("windows: an NPC sees a raider through a window and shoots him through it; a wall instead hides him", () => {
  // A long window run (a warehouse front): a strafing NPC keeps its line through the opening.
  const front = { x: WX, y: 600, w: 24, h: 800 };
  const fight = (window: boolean) => {
    const m = testMatch(1, { map: windowMap(window, front), envSeed: 2, ...npcOpts([testPost(0, WX - 150, 1000)]) });
    const human = rtOf(m, ids(m)[0]!);
    const npc = npcsOf(m)[0]!;
    // Inside the post's leash (an intruder is fought even in the peace window), behind the window.
    place(m, human.id, WX + 200, 1000);
    human.pub.hp = 1e6;
    const b = m.npcs.brain(npc)!;
    b.tune({ aim: 0, rollChance: 0 });
    const ev = run(m, 4000);
    assert.ok(m.clock < NPC.PEACE_MS);
    return { m, npc, human, ev };
  };
  const w = fight(true);
  assert.ok(w.m.vision.sees(w.npc.rosterIndex, w.human.rosterIndex), "the NPC sees through the window");
  assert.ok(shotsBy(w.ev, w.m, w.npc.id).length > 0, "and fires");
  assert.ok(w.ev.some((e) => e.type === "hit" && e.target === w.human.rosterIndex), "and hits through it");
  assert.ok(w.npc.pub.x < WX, "from its own side of the wall");
  const s = fight(false);
  assert.equal(s.m.vision.sees(s.npc.rosterIndex, s.human.rosterIndex), false);
  assert.equal(shotsBy(s.ev, s.m, s.npc.id).length, 0, "no fire at an unseen raider behind a wall");
  assert.equal(s.human.pub.hp, 1e6);
});

test("windows: players see each other through a window, not through the wall beside it", () => {
  const m = testMatch(2, { map: windowMap(), envSeed: 2 });
  const [a, b] = ids(m);
  const r = (id: string) => rtOf(m, id).rosterIndex;
  place(m, a!, WX - 250, 1000);
  place(m, b!, WX + 250, 1000);
  pl(m, a!).aim = 0;
  pl(m, b!).aim = Math.PI;
  m.step(SERVER_TICK_MS);
  assert.equal(m.vision.sees(r(a!), r(b!)), true);
  assert.equal(m.vision.sees(r(b!), r(a!)), true);
  place(m, a!, WX - 250, 1400);
  place(m, b!, WX + 250, 1400);
  for (let t = 0; t <= VISION.HYSTERESIS_MS + 2 * SERVER_TICK_MS; t += SERVER_TICK_MS) m.step(SERVER_TICK_MS);
  assert.equal(m.vision.sees(r(a!), r(b!)), false, "wall");
});

/** Connect roster k as a human client (deliverSounds only serves connected listeners). */
function listen(m: Match, k: number): { sid: string; r: number } {
  const rt = m.attachHuman(`user${k}`, `s${k}`)!;
  return { sid: rt.id, r: rt.rosterIndex };
}

function sndOf(evs: readonly MatchEvent[], r: number): SoundMsg | undefined {
  let out: SoundMsg | undefined;
  for (const e of evs) {
    if (e.type !== "snd" || e.to !== r) continue;
    out ??= {};
    if (e.msg.h) (out.h ??= []).push(...e.msg.h);
    if (e.msg.v) (out.v ??= []).push(...e.msg.v);
  }
  return out;
}

test("windows: sound through a window counts WINDOW_MULT× the distance, unflagged; a wall still muffles 1.6×", () => {
  // envSeed 2 = midday clear (hear 1.0). Listener faces west, sources east: always hidden entries.
  const m = testMatch(2, { map: windowMap(), envSeed: 2 });
  const A = listen(m, 0), B = listen(m, 1);
  const hear = (y: number, dx: number) => {
    place(m, A.sid, WX - 150, y);
    pl(m, A.sid).aim = Math.PI;
    place(m, B.sid, WX - 150 + dx, y);
    m.step(SERVER_TICK_MS);
    m.drainEvents();
    emitSound(m, rtOf(m, B.sid), SoundKind.step, WX - 150 + dx, y);
    m.step(SERVER_TICK_MS);
    return decodeSoundMsg(sndOf(m.drainEvents(), A.r));
  };
  const R = SOUND.RADIUS.step;
  // 220 px: open would be the near band (0.275); through the window 275 px → mid band, not muffled.
  const near = hear(1000, 220);
  assert.equal(near.length, 1);
  assert.ok(near[0]!.hidden && !near[0]!.occluded && near[0]!.b === 1, JSON.stringify(near));
  // 600 px: window 750 < 800 → heard (far band, unflagged); wall 960 > 800 → inaudible.
  const far = hear(1000, 600);
  assert.ok(far.length === 1 && far[0]!.hidden && !far[0]!.occluded && far[0]!.b === 2, JSON.stringify(far));
  assert.deepEqual(hear(1400, 600), [], "the wall beside the window muffles it out of range");
  // 400 px through the wall: 640 → heard, flagged occluded.
  const wall = hear(1400, 400);
  assert.ok(wall.length === 1 && wall[0]!.hidden && wall[0]!.occluded, JSON.stringify(wall));
  // Just beyond WINDOW_MULT's reach: inaudible through the window.
  assert.deepEqual(hear(1000, Math.ceil(R / SOUND.WINDOW_MULT) + 4), []);
});

test("windows: a body killed mid-vault lies outside the window and can be searched", () => {
  const m = testMatch(2, { map: windowMap() });
  const [a, c] = ids(m);
  const rt: PlayerRuntime = rtOf(m, a!);
  place(m, a!, WX - 100, 1000);
  place(m, c!, WX - 100, 1000);
  // Four roll ticks (29 + 27 + 25 + 23 px) leave the body centred 4 px into the window rect.
  feed(m, a!, [{ mx: 1, roll: true }, { mx: 1 }, { mx: 1 }, { mx: 1 }]);
  assert.equal(rt.self.rollLeft, ROLL.TICKS - 4);
  assert.ok(inWindow(m, rt.pub.x, rt.pub.y), `mid-vault inside the window, x=${rt.pub.x}`);
  damagePlayer(m, rt, 1000, null, "", 0, 0);
  assert.equal(rt.pub.alive, false);
  const body = m.state.corpses.get(String(rt.rosterIndex))!;
  assert.ok(body, "a corpse");
  assert.ok(!inWindow(m, body.x, body.y), `corpse at ${body.x},${body.y} is clear of the window`);
  assert.ok(body.x <= WEST + EPS && body.y === 1000, "on the nearer (west) side, along the roll axis");
  assert.ok(m.containers.nearestOpenable(rtOf(m, c!)) >= 0, "a raider next to it can search it");
});
