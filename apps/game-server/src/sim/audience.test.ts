import { test } from "node:test";
import assert from "node:assert/strict";
import { SERVER_TICK_MS, SoundKind, VISION, envConfigOf, quantizeFa, sampleEnv, type ShotMsg } from "@extract/shared";
import { buildBatches } from "./audience.js";
import { envNow } from "./environment.js";
import type { Match } from "./match.js";
import { CLIP_MIN_PX, clipRayToCircle } from "./spatial.js";
import { ids, pl, rtOf, run, testMap, testMatch } from "./test-utils.js";
import type { MatchEvent } from "./types.js";

/**
 * Seven humans around a rifle shot from A along +x at y 2500 (path x 1000 → 1900):
 *   A shooter, B target on the path, C sees both, D hidden with A inside its circle,
 *   F hidden with A outside its circle, H sees B but not A, G far away behind everything.
 */
const SPOTS: Record<string, [number, number, number]> = {
  A: [1000, 2500, 0],
  B: [1600, 2500, Math.PI],
  C: [1200, 2300, 1.4],
  D: [1500, 3300, Math.PI / 2],
  F: [2500, 2900, Math.PI / 2],
  H: [2100, 2500, Math.PI],
  G: [2400, 1000, 0],
};

function scene() {
  const m = testMatch(7, {
    envSeed: 2,
    map: testMap({
      walls: [{ x: 1300, y: 600, w: 24, h: 800 }],
      containers: [{ x: 1200, y: 2600, kind: "crate", tier: 0, zone: null }],
    }),
  });
  const id = ids(m);
  const names = Object.keys(SPOTS);
  const R: Record<string, number> = {};
  const S: Record<string, string> = {};
  names.forEach((n, k) => {
    const [x, y, aim] = SPOTS[n]!;
    const p = pl(m, id[k]!);
    p.x = x;
    p.y = y;
    p.aim = aim;
    R[n] = rtOf(m, id[k]!).rosterIndex;
    S[n] = id[k]!;
  });
  m.step(SERVER_TICK_MS);
  m.drainEvents();
  const all = Object.values(R);
  return { m, R, S, all };
}

function shot(m: Match, src: number, sid: string, x: number, y: number, a: number[]): MatchEvent {
  const msg: ShotMsg = { s: sid, w: "rifle", x: x + 58, y, cx: x, cy: y, a };
  void m;
  return { type: "shot", src, msg };
}

test("audience: the vision rows behind the scene are what the comments say", () => {
  const { m, R } = scene();
  const v = m.vision;
  assert.ok(v.sees(R.C!, R.A!) && v.sees(R.C!, R.B!), "C sees A and B");
  assert.ok(v.sees(R.H!, R.B!) && !v.sees(R.H!, R.A!), "H sees B, not A");
  for (const n of ["D", "F", "G"]) assert.ok(!v.sees(R[n]!, R.A!) && !v.sees(R[n]!, R.B!), `${n} sees neither`);
});

test("audience: SHOT is full for the shooter and its viewers, clipped (s = '') for listeners the path crosses, absent otherwise", () => {
  const { m, R, S, all } = scene();
  const b = buildBatches(m, [shot(m, R.A!, S.A!, 1000, 2500, [0])], all);
  for (const n of ["A", "C"]) assert.equal(b.get(R[n]!)!.shots![0]!.s, S.A, `${n}: full shot`);
  assert.equal(b.get(R.G!), undefined, "G: nothing (the path never enters its circle)");
  const h = b.get(R.H!)!.shots![0]!;
  assert.deepEqual([h.s, h.x, h.y], ["", 1100, 2500], "H (sees the target, not the shooter): entry at 1000 px");

  // F: origin outside its circle → the entry point, exactly VISION.RANGE from F.
  const f = b.get(R.F!)!.shots![0]!;
  assert.equal(f.s, "");
  assert.deepEqual([f.cx, f.cy], [f.x, f.y], "no shooter centre");
  assert.ok(Math.abs(Math.hypot(f.x - 2500, f.y - 2900) - VISION.RANGE) < 1e-6, "starts on the circle");
  assert.ok(Math.abs(f.x - (2500 - Math.sqrt(1000 ** 2 - 400 ** 2))) < 1e-6 && Math.abs(f.y - 2500) < 1e-9);

  // D: origin inside its circle (hidden by the cone) → closest approach, never the shooter's spot.
  const d = b.get(R.D!)!.shots![0]!;
  assert.equal(d.s, "");
  assert.ok(Math.abs(d.x - 1500) < 1e-6 && Math.abs(d.y - 2500) < 1e-9, `closest approach (${d.x}, ${d.y})`);
  assert.ok(Math.hypot(d.x - 1000, d.y - 2500) >= CLIP_MIN_PX);

  // Shooting away from D (−x): the closest approach is behind the muzzle → nothing for D.
  const away = buildBatches(m, [shot(m, R.A!, S.A!, 1000, 2500, [Math.PI])], all);
  assert.equal(away.get(R.D!), undefined);
});

test("audience: a clipped tracer never starts at the hidden shooter; walls cut the path", () => {
  // Pure: entry / closest-approach geometry.
  assert.equal(clipRayToCircle(0, 0, 1, 0, 900, 1500, 0, 1000), 500, "outside: entry");
  assert.equal(clipRayToCircle(0, 0, 1, 0, 400, 1500, 0, 1000), null, "ends before the circle");
  assert.equal(clipRayToCircle(0, 0, 1, 0, 900, 300, 500, 1000), 300, "inside: closest approach");
  assert.equal(clipRayToCircle(0, 0, 1, 0, 900, 100, 500, 1000), null, "closest approach too near the shooter");
  assert.equal(clipRayToCircle(0, 0, 0, 1, 900, 0, 3000, 1000), null, "path too short");

  // A at (1000, 1000) fires into the wall at x 1300: G at (2400, 1000) would see x ≥ 1400 only.
  const { m, R, S, all } = scene();
  const b = buildBatches(m, [shot(m, R.A!, S.A!, 1000, 1000, [0])], all);
  assert.equal(b.get(R.G!), undefined, "the bullet stops at the wall before G's circle");
});

test("audience: HIT goes to target (with fa), shooter and the target's viewers; s is blanked where the shooter is hidden", () => {
  const { m, R, S, all } = scene();
  const hit: MatchEvent = {
    type: "hit", src: R.A!, target: R.B!,
    msg: { t: S.B!, s: S.A!, x: 1580, y: 2500, d: 30, ar: false }, fa: Math.PI,
  };
  const b = buildBatches(m, [hit], all);
  assert.equal(b.get(R.B!)!.hits![0]!.fa, quantizeFa(Math.PI), "victim: damage direction");
  assert.equal(b.get(R.A!)!.hits![0]!.fa, undefined);
  assert.equal(b.get(R.A!)!.hits![0]!.s, S.A);
  assert.equal(b.get(R.C!)!.hits![0]!.s, S.A, "C sees the shooter");
  assert.equal(b.get(R.H!)!.hits![0]!.s, "", "H sees the target, not the shooter");
  for (const n of ["D", "F", "G"]) assert.equal(b.get(R[n]!), undefined, `${n}: nothing`);
});

test("audience: KILL is broadcast (names only); CHEST goes to the container's AOI with `by` only for viewers", () => {
  const { m, R, S, all } = scene();
  const kill: MatchEvent = { type: "kill", msg: { victim: "P1", victimId: S.B!, killer: "P0", killerId: S.A!, weapon: "rifle" } };
  const chest: MatchEvent = { type: "chest", src: R.A!, idx: 0 };
  const b = buildBatches(m, [kill, chest], all);
  for (const r of all) assert.equal(b.get(r)!.kills!.length, 1);
  assert.deepEqual(b.get(R.C!)!.chest, [{ idx: 0, by: S.A }]);
  assert.deepEqual(b.get(R.A!)!.chest, [{ idx: 0, by: S.A }]);
  assert.deepEqual(b.get(R.D!)!.chest, [{ idx: 0 }], "D does not see the opener");
  assert.equal(b.get(R.G!)!.chest, undefined, "G's ring does not hold the container");
});

test("audience: snd payloads reach their listener only; raw sound events are never forwarded", () => {
  const { m, R, all } = scene();
  const evs: MatchEvent[] = [
    { type: "sound", src: R.A!, kind: SoundKind.reload, x: 1000, y: 2500, radius: 500, variant: 0 },
    { type: "snd", to: R.D!, msg: { h: [SoundKind.step, 3, 1, 0] } },
    { type: "snd", to: R.D!, msg: { v: [SoundKind.reload, "x", 0] } },
    { type: "snd", to: R.G!, msg: {} },
  ];
  const b = buildBatches(m, evs, all);
  assert.deepEqual([...b.keys()], [R.D!]);
  assert.deepEqual(b.get(R.D!)!.snd, { h: [SoundKind.step, 3, 1, 0], v: [SoundKind.reload, "x", 0] });
  assert.equal(buildBatches(m, evs, []).size, 0);
});

test("audience: a real exchange of fire through the sim routes like the table above", () => {
  const m = testMatch(3, { envSeed: 2 });
  const [a, b, c] = ids(m);
  pl(m, a!).x = 1000; pl(m, a!).y = 1500;
  pl(m, b!).x = 1300; pl(m, b!).y = 1500;
  pl(m, c!).x = 4000; pl(m, c!).y = 4000;
  const ev = run(m, 300, { [a!]: { aim: 0, fire: true }, [b!]: { aim: Math.PI } });
  const ra = rtOf(m, a!).rosterIndex, rb = rtOf(m, b!).rosterIndex, rc = rtOf(m, c!).rosterIndex;
  const batches = buildBatches(m, ev, [ra, rb, rc]);
  assert.ok(batches.get(ra)!.shots!.length >= 1 && batches.get(rb)!.shots!.length >= 1);
  assert.equal(batches.get(rb)!.hits![0]!.fa, quantizeFa(Math.PI), "victim gets the direction to the shooter");
  assert.equal(batches.get(rc)?.shots, undefined, "a far, blind listener gets no tracer");
  assert.equal(batches.get(rc)?.hits, undefined);
});

test("environment: state carries the env seed; envNow equals sampleEnv on the synced fields and caches per clock", () => {
  const m = testMatch(1, { envSeed: 777, weatherOverride: "" });
  assert.equal(m.state.envSeed, 777);
  assert.ok(m.state.todStartMin >= 0 && m.state.todStartMin < 1440);
  run(m, 5000);
  const expect = sampleEnv(envConfigOf(m.state, m.map), m.clock);
  assert.deepEqual(envNow(m), expect);
  assert.equal(envNow(m), envNow(m), "cached within one clock value");
  const forced = testMatch(1, { envSeed: 777, weatherOverride: "fog" });
  assert.equal(forced.state.weatherOverride, "fog");
  assert.equal(envNow(forced).kind, "fog");
  assert.equal(testMatch(1, { weatherOverride: "lava" }).state.weatherOverride, "");
});
