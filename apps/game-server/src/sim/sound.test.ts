import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SERVER_TICK_MS,
  SOUND,
  SOUND_PRIORITY,
  SoundKind,
  baseSoundRadius,
  decodeSoundMsg,
  surfaceAt,
  weaponVariant,
  type SoundMsg,
} from "@extract/shared";
import { damagePlayer } from "./combat.js";
import { envNow } from "./environment.js";
import type { Match } from "./match.js";
import { emitSound, heardBy, pendingSounds } from "./sound.js";
import { giveWeapon, humans, ids, npcOpts, pl, rtOf, run, testMap, testMatch, testPost } from "./test-utils.js";
import type { MatchEvent } from "./types.js";

/** Wall x 1300..1324, y 600..1400 (occlusion); envSeed 2 = midday clear (hear 1.0). */
function setup(n = 2, opts: Parameters<typeof testMatch>[1] = {}) {
  const m = testMatch(n, { envSeed: 2, map: testMap({ walls: [{ x: 1300, y: 600, w: 24, h: 800 }] }), ...opts });
  const id = ids(m);
  return { m, id };
}

/** Connect roster k as a human client (deliverSounds only serves connected listeners). */
function listen(m: Match, k: number): { sid: string; r: number } {
  const rt = m.attachHuman(`user${k}`, `s${k}`)!;
  return { sid: rt.id, r: rt.rosterIndex };
}

function at(m: Match, sid: string, x: number, y: number, aim = 0): void {
  const p = pl(m, sid);
  p.x = x;
  p.y = y;
  p.aim = aim;
}

/** One tick; the `snd` payload delivered to roster r (merged), or undefined. */
function tickFor(m: Match, r: number): SoundMsg | undefined {
  m.step(SERVER_TICK_MS);
  return sndOf(m.drainEvents(), r);
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

test("sound: a hidden source arrives as integers only — no coordinates, no ids, no floats", () => {
  const { m, id } = setup(2);
  const A = listen(m, 0), B = listen(m, 1);
  at(m, A.sid, 1000, 2000, Math.PI); // facing away from B: B is hidden from A
  at(m, B.sid, 1500, 2000, 0); // facing away from A
  m.step(SERVER_TICK_MS);
  m.drainEvents();
  const evs = run(m, 1500, { [B.sid]: { mx: 0, my: 1, aim: 0 } });
  const steps = evs.filter((e) => e.type === "sound" && e.src === B.r && e.kind === SoundKind.step);
  assert.ok(steps.length >= 2, `B made footsteps (${steps.length})`);
  const msg = sndOf(evs, A.r);
  assert.ok(msg?.h?.length, "A heard them");
  assert.equal(msg!.v, undefined, "never a visible entry for a hidden source");
  for (const x of msg!.h!) assert.ok(Number.isInteger(x) && x >= 0 && x < 16, `small integers only (${x})`);
  const json = JSON.stringify(msg);
  assert.ok(!json.includes(B.sid) && !json.includes(id[1]!), "no session id");
  for (const s of decodeSoundMsg(msg)) {
    assert.equal(s.hidden, true);
    if (s.hidden) {
      assert.equal(s.kind, SoundKind.step);
      assert.ok(s.a >= 0 && s.a <= 2, `sector east to south-east: ${s.a}`);
      assert.equal(s.variant, surfaceAt(m.map, 1500, 2000).variant, "variant = surface material");
    }
  }
  assert.equal(sndOf(evs, B.r), undefined, "the source never hears itself");
});

test("sound: a visible source is [kind, sessionId, variant]; moving within a bucket changes nothing", () => {
  const { m } = setup(2);
  const A = listen(m, 0), B = listen(m, 1);
  at(m, A.sid, 1000, 2000, 0); // facing B
  at(m, B.sid, 1500, 2000, Math.PI);
  m.step(SERVER_TICK_MS);
  m.drainEvents();
  emitSound(m, rtOf(m, B.sid), SoundKind.reload, 1500, 2000);
  assert.deepEqual(tickFor(m, A.r), { v: [SoundKind.reload, B.sid, 0] });

  // World sounds (no source) are always hidden; any spot inside one (sector, band) bucket is identical.
  emitSound(m, null, SoundKind.death, 1600, 2000);
  const one = tickFor(m, A.r);
  emitSound(m, null, SoundKind.death, 1630, 2040);
  const two = tickFor(m, A.r);
  assert.ok(one?.h?.length === 4);
  assert.deepEqual(two, one);
});

test("sound: radii = table × surface × env.hear; walking is quiet; standing still is silent", () => {
  const { m } = setup(2);
  const A = listen(m, 0), B = listen(m, 1);
  at(m, A.sid, 1000, 2000, Math.PI);
  const hear = envNow(m).hear;
  const surf = surfaceAt(m.map, 1000, 2000).stepRangeMult;
  const runR = baseSoundRadius(SoundKind.step, 0, false) * surf * hear;
  const walkR = baseSoundRadius(SoundKind.step, 0, true) * surf * hear;
  assert.equal(baseSoundRadius(SoundKind.step, 0, false), 800);
  assert.equal(baseSoundRadius(SoundKind.step, 0, true), 180);
  assert.equal(baseSoundRadius(SoundKind.shot, weaponVariant("sniper")), 3600);
  const heardAt = (d: number, walk: boolean) => {
    at(m, B.sid, 1000 + d, 2000, 0);
    m.step(SERVER_TICK_MS);
    m.drainEvents();
    emitSound(m, rtOf(m, B.sid), SoundKind.step, 1000 + d, 2000, 0, { walk, rangeMult: surf });
    return tickFor(m, A.r) !== undefined;
  };
  assert.equal(heardAt(runR - 10, false), true);
  assert.equal(heardAt(runR + 10, false), false);
  assert.equal(heardAt(150, true), walkR > 150, "shift-walk at 150 px is audible");
  assert.equal(heardAt(300, true), false, "shift-walk at 300 px is not");

  // Cadence: one step per STEP_EVERY_PX — 3 s of running ≈ 6.5 steps, walking half that, idle none.
  const count = (inp: object) =>
    run(m, 3000, { [B.sid]: inp }).filter((e) => e.type === "sound" && e.src === B.r && (e.kind === SoundKind.step || e.kind === SoundKind.stepBush)).length;
  at(m, B.sid, 1000, 2000);
  const ran = count({ mx: 0, my: 1 });
  assert.ok(Math.abs(ran - 6.5) <= 1, `run: ${ran} steps in 3 s`);
  at(m, B.sid, 2000, 1500);
  const walked = count({ mx: 0, my: 1, walk: true });
  assert.ok(Math.abs(walked - 3.25) <= 1, `walk: ${walked} steps in 3 s`);
  assert.equal(count({ mx: 0, my: 0 }), 0, "standing still");
});

test("sound: env.hear scales every radius (rain 0.8)", () => {
  const clear = setup(2);
  const rain = setup(2, { weatherOverride: "rain" });
  for (const { m } of [clear, rain]) {
    const A = listen(m, 0), B = listen(m, 1);
    at(m, A.sid, 1000, 2000, Math.PI);
    at(m, B.sid, 1450, 2000);
    m.step(SERVER_TICK_MS);
    m.drainEvents();
    emitSound(m, rtOf(m, B.sid), SoundKind.reload, 1450, 2000); // 500 px base, 450 px away
  }
  assert.ok(envNow(rain.m).hear < 0.9);
  assert.ok(tickFor(clear.m, 0) !== undefined, "clear: heard at 450 px");
  assert.equal(tickFor(rain.m, 0), undefined, "rain: 500 × hear < 450");
});

test("sound: one wall between source and listener counts 1.6× the distance and sets the occluded bit", () => {
  const { m } = setup(2);
  const A = listen(m, 0), B = listen(m, 1);
  at(m, A.sid, 1000, 1000, Math.PI);
  const step = (x: number) => {
    at(m, B.sid, x, 1000);
    m.step(SERVER_TICK_MS);
    m.drainEvents();
    emitSound(m, rtOf(m, B.sid), SoundKind.step, x, 1000);
    return decodeSoundMsg(tickFor(m, A.r));
  };
  const near = step(1400); // 400 px through the wall → 640 effective < 800
  assert.equal(near.length, 1);
  assert.ok(near[0]!.hidden && near[0]!.occluded && near[0]!.b === 2, "occluded, far band");
  assert.deepEqual(step(1600), [], "600 px through the wall → 960 > 800: inaudible");
  // Same 600 px in the open (below the wall): heard, not occluded.
  at(m, A.sid, 1000, 2000, Math.PI);
  at(m, B.sid, 1600, 2000);
  m.step(SERVER_TICK_MS);
  m.drainEvents();
  emitSound(m, rtOf(m, B.sid), SoundKind.step, 1600, 2000);
  const open = decodeSoundMsg(tickFor(m, A.r));
  assert.ok(open.length === 1 && open[0]!.hidden && !open[0]!.occluded);
});

test("sound: dedupe identical buckets; cap MAX_PER_TICK keeps the highest priorities", () => {
  const { m } = setup(1);
  const A = listen(m, 0);
  at(m, A.sid, 2400, 2400, 0);
  m.step(SERVER_TICK_MS);
  m.drainEvents();
  emitSound(m, null, SoundKind.step, 2700, 2400);
  emitSound(m, null, SoundKind.step, 2701, 2401);
  assert.equal(decodeSoundMsg(tickFor(m, A.r)).length, 1, "same (kind, sector, band, variant) merge");

  // 24 low-priority steps in distinct sectors / bands, 3 shots, 1 death.
  for (let k = 0; k < 24; k++) {
    const a = (k / 16) * Math.PI * 2, d = k < 16 ? 100 : 400;
    emitSound(m, null, SoundKind.step, 2400 + Math.cos(a) * d, 2400 + Math.sin(a) * d);
  }
  for (let k = 0; k < 3; k++) emitSound(m, null, SoundKind.shot, 2400 + 300 * k, 1800, weaponVariant("rifle"));
  emitSound(m, null, SoundKind.death, 2400, 3000);
  const got = decodeSoundMsg(tickFor(m, A.r));
  assert.equal(got.length, SOUND.MAX_PER_TICK);
  assert.equal(got.filter((s) => s.kind === SoundKind.shot).length, 3, "shots kept");
  assert.equal(got.filter((s) => s.kind === SoundKind.death).length, 1, "death kept");
  assert.ok(SOUND_PRIORITY[SoundKind.death] > SOUND_PRIORITY[SoundKind.step]);
});

test("sound: dead or disconnected listeners hear nothing; NPCs get heardBy; queued sounds go out next tick", () => {
  const m = testMatch(1, { envSeed: 2, roster: humans(3), ...npcOpts([testPost(0, 1000, 1700)]), npcBrains: false });
  const A = listen(m, 0), B = listen(m, 1);
  const cId = ids(m)[2]!; // never connects
  const botId = ids(m)[3]!;
  at(m, A.sid, 1000, 2000, Math.PI);
  at(m, B.sid, 1300, 2000, Math.PI);
  at(m, cId, 1000, 2300);
  at(m, botId, 1000, 1700, Math.PI / 2);
  m.step(SERVER_TICK_MS);
  m.drainEvents();
  emitSound(m, null, SoundKind.extract, 1500, 2000);
  assert.equal(pendingSounds(m).length, 1, "queued until the next delivery");
  m.step(SERVER_TICK_MS);
  const evs = m.drainEvents();
  assert.ok(sndOf(evs, A.r) && sndOf(evs, B.r));
  assert.equal(sndOf(evs, rtOf(m, cId).rosterIndex), undefined, "nobody to send to");
  assert.equal(heardBy(m, rtOf(m, botId).rosterIndex)[0]?.kind, SoundKind.extract, "the NPC heard it");
  assert.equal(pendingSounds(m).length, 0);

  damagePlayer(m, rtOf(m, B.sid), 1000, null, "", 1300, 2000);
  emitSound(m, null, SoundKind.extract, 1500, 2000);
  m.step(SERVER_TICK_MS);
  assert.equal(sndOf(m.drainEvents(), B.r), undefined, "dead listener");
});

test("sound: emitters — switch, body fall, search repeats", () => {
  const { m } = setup(2);
  const A = listen(m, 0), B = listen(m, 1);
  at(m, A.sid, 1000, 2000);
  at(m, B.sid, 1200, 2000);
  giveWeapon(m, A.sid, "w2", "rifle");
  m.drainEvents();
  m.switchSlot(A.sid, "w2");
  const kinds = (evs: readonly MatchEvent[], src: number) =>
    evs.flatMap((e) => (e.type === "sound" && e.src === src ? [e.kind] : []));
  assert.deepEqual(kinds(m.drainEvents(), A.r), [SoundKind.switch]);

  // Search: one at the start, then every SEARCH_REPEAT_MS while the session is open.
  rtOf(m, A.sid).search = { key: "c0", readyAt: 0 };
  const evs = run(m, 3200);
  rtOf(m, A.sid).search = null;
  const searches = evs.filter((e) => e.type === "sound" && e.kind === SoundKind.search).map((e) => e.at);
  assert.equal(searches.length, 3, `search sounds at ${searches}`);
  assert.equal(searches[1]! - searches[0]!, SOUND.SEARCH_REPEAT_MS);

  damagePlayer(m, rtOf(m, B.sid), 1000, rtOf(m, A.sid), "rifle", 1200, 2000);
  const death = kinds(m.drainEvents(), B.r);
  assert.ok(death.includes(SoundKind.death) && death.includes(SoundKind.bodyFall), `${death}`);
});

test("sound: walk=true only on the input that completes a step does not make a running player quiet", () => {
  const radii = (mode: "run" | "walk" | "exploit") => {
    const { m, id } = setup(1);
    at(m, id[0]!, 1500, 2000);
    const rt = rtOf(m, id[0]!);
    const runStep = 13; // ≥ the px one run input moves (PLAYER.SPEED / INPUT_HZ)
    const out: number[] = [];
    for (let k = 0; k < 60; k++) {
      const walk = mode === "walk" || (mode === "exploit" && rt.stepAcc + runStep >= SOUND.STEP_EVERY_PX);
      m.enqueueInput(id[0]!, { seq: k + 1, mx: 1, my: 0, aim: 0, fire: false, walk });
      if (k % 3 !== 2) continue;
      m.step(SERVER_TICK_MS * 2);
      for (const e of m.drainEvents()) if (e.type === "sound" && e.kind === SoundKind.step) out.push(e.radius);
    }
    return out;
  };
  const loud = radii("run"), quiet = radii("walk"), exploit = radii("exploit");
  assert.ok(loud.length >= 3 && quiet.length >= 1 && exploit.length >= 3);
  assert.ok(Math.min(...loud) > Math.max(...quiet), "walking is quieter than running");
  assert.ok(exploit.every((r) => r === loud[0]), `a mostly-run step stays loud: ${exploit.join(",")} vs ${loud[0]}`);
});

test("sound: a flood of one source's sounds in a tick is deduped before any per-listener work", () => {
  const { m } = setup(3);
  const A = listen(m, 0), B = listen(m, 1);
  at(m, A.sid, 1000, 2000);
  at(m, B.sid, 1200, 2000, Math.PI);
  m.step(SERVER_TICK_MS);
  m.drainEvents();
  const src = rtOf(m, A.sid);
  for (let k = 0; k < 500; k++) emitSound(m, src, SoundKind.switch, 1000, 2000);
  emitSound(m, src, SoundKind.reload, 1000, 2000);
  const msg = tickFor(m, B.r);
  const got = decodeSoundMsg(msg).map((s) => s.kind).sort();
  assert.deepEqual(got, [SoundKind.reload, SoundKind.switch].sort(), "one entry per kind");
});
