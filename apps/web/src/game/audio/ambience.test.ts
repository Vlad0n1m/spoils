/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/audio/*.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ENV, envSchedule, sampleEnv, type EnvConfig, type EnvSample, type Strike } from "@extract/shared";
import { AMBIENCE, StrikeScheduler, ambienceTargets, emptyEnvSource, firstStrikeAtOrAfter, nextBirdDelayMs, rememberEnvSource, sameEnvSource, thunderFor } from "./ambience";

function env(p: Partial<EnvSample>): EnvSample {
  return {
    kind: "clear",
    prev: "clear",
    blend: 1,
    rain: 0,
    fog: 0,
    wind: 0.2,
    cloud: 0.1,
    wetness: 0,
    todMin: 720,
    light: 1,
    flash: 0,
    vis: 1,
    hear: 1,
    ...p,
  };
}

const strikes = (ts: number[]): Strike[] => ts.map((t) => ({ t, x: 0, y: 0 }));

describe("ambienceTargets", () => {
  it("wind follows 0.15 + 0.5·wind and rain follows rain", () => {
    const t = ambienceTargets(env({ wind: 1, rain: 0.6 }), false);
    assert.ok(Math.abs(t.wind - 0.65) < 1e-9);
    assert.equal(t.rain, 0.6);
    assert.equal(ambienceTargets(env({ wind: 0 }), false).wind, 0.15);
  });

  it("crickets only in the dark and dry, with soft edges", () => {
    assert.equal(ambienceTargets(env({ light: 1 }), false).crickets, 0);
    assert.equal(ambienceTargets(env({ light: 0.12 }), false).crickets, 1);
    assert.equal(ambienceTargets(env({ light: 0.12, rain: 1 }), false).crickets, 0);
    const mid = ambienceTargets(env({ light: 0.4 }), false).crickets;
    assert.ok(mid > 0 && mid < 1, `ramp at light 0.4: ${mid}`);
  });

  it("birds on bright dry days only, never during a flash", () => {
    assert.equal(ambienceTargets(env({ light: 0.9 }), false).birds, true);
    assert.equal(ambienceTargets(env({ light: 0.9, rain: 0.5 }), false).birds, false);
    assert.equal(ambienceTargets(env({ light: 0.3 }), false).birds, false);
    assert.equal(ambienceTargets(env({ light: 1, flash: 1 }), false).birds, false);
  });

  it("indoors muffles the ambience bus", () => {
    const i = ambienceTargets(env({}), true);
    assert.equal(i.busCutoff, AMBIENCE.INDOOR_CUTOFF);
    assert.equal(i.busGain, AMBIENCE.INDOOR_GAIN);
    const o = ambienceTargets(env({}), false);
    assert.equal(o.busCutoff, AMBIENCE.OUTDOOR_CUTOFF);
    assert.equal(o.busGain, 1);
  });

  it("every target stays in range over a whole stormy raid", () => {
    const cfg: EnvConfig = { seed: 7, todStartMin: 1110, durationMs: 30 * 60_000, mapW: 24576, mapH: 24576 };
    for (let t = 0; t <= cfg.durationMs; t += 5000) {
      const a = ambienceTargets(sampleEnv(cfg, t), t % 2 === 0);
      for (const v of [a.wind, a.rain, a.crickets]) assert.ok(v >= 0 && v <= 1 && Number.isFinite(v));
    }
  });
});

describe("birds", () => {
  it("next trill in 3–9 s", () => {
    assert.equal(nextBirdDelayMs(0), AMBIENCE.BIRD_MIN_MS);
    assert.equal(nextBirdDelayMs(1), AMBIENCE.BIRD_MAX_MS);
    assert.equal(nextBirdDelayMs(5), AMBIENCE.BIRD_MAX_MS);
  });
});

describe("StrikeScheduler", () => {
  it("binary search finds the first strike at or after t", () => {
    const s = strikes([100, 200, 300]);
    assert.equal(firstStrikeAtOrAfter(s, 0), 0);
    assert.equal(firstStrikeAtOrAfter(s, 200), 1);
    assert.equal(firstStrikeAtOrAfter(s, 201), 2);
    assert.equal(firstStrikeAtOrAfter(s, 999), 3);
  });

  it("hands out each strike once, lookahead ahead of time", () => {
    const sch = new StrikeScheduler(2000, 300);
    const s = strikes([5000, 6000, 9000]);
    const seen: number[] = [];
    for (let clock = 0; clock <= 12000; clock += 250) for (const x of sch.poll(s, clock)) seen.push(x.t);
    assert.deepEqual(seen, [5000, 6000, 9000]);
  });

  it("is due exactly lookahead before the strike", () => {
    const sch = new StrikeScheduler(2000, 300);
    const s = strikes([5000]);
    assert.equal(sch.poll(s, 2900).length, 0);
    assert.equal(sch.poll(s, 3100).length, 1);
  });

  it("a forward clock jump does not replay old thunder", () => {
    const sch = new StrikeScheduler(2000, 300);
    const s = strikes([1000, 2000, 3000, 20000]);
    sch.poll(s, 0);
    // Reconnect lands at 15 s: 1–3 s strikes are long gone.
    const got = sch.poll(s, 15000).map((x) => x.t);
    assert.deepEqual(got, []);
    assert.deepEqual(
      sch.poll(s, 18100).map((x) => x.t),
      [20000],
    );
  });

  it("a backward jump re-seeks without duplicating far-past strikes", () => {
    const sch = new StrikeScheduler(2000, 300);
    const s = strikes([5000, 10000]);
    for (let c = 0; c <= 11000; c += 250) sch.poll(s, c);
    const got = sch.poll(s, 4000).map((x) => x.t); // reconnect earlier clock
    assert.deepEqual(got, [5000]);
  });

  it("matches the real schedule of a forced storm", () => {
    const cfg: EnvConfig = { seed: 3, todStartMin: 720, durationMs: 5 * 60_000, mapW: 24576, mapH: 24576, override: "storm" };
    const list = envSchedule(cfg).strikes;
    assert.ok(list.length > 5, "storm has strikes");
    const sch = new StrikeScheduler();
    let n = 0;
    for (let c = 0; c <= cfg.durationMs; c += 250) n += sch.poll(list, c).length;
    assert.equal(n, list.length);
  });
});

describe("thunderFor", () => {
  it("near strikes crack, far strikes roll, and the delay grows with distance", () => {
    const near = thunderFor({ t: 1000, x: 1000, y: 0 }, 0, 0, 1000);
    const far = thunderFor({ t: 1000, x: 12000, y: 0 }, 0, 0, 1000);
    assert.equal(near.id, "thunder_near");
    assert.equal(far.id, "thunder_far");
    assert.ok(Math.abs(near.delayS - 1000 / ENV.THUNDER_SPEED) < 1e-9);
    assert.ok(far.delayS > near.delayS);
    assert.ok(far.gain < near.gain && far.gain > 0);
    assert.ok(far.cutoff < near.cutoff);
  });

  it("adds the time until the flash when scheduled ahead", () => {
    const p = thunderFor({ t: 3000, x: 0, y: 0 }, 0, 0, 1000);
    assert.ok(Math.abs(p.delayS - 2) < 1e-9);
  });

  it("pans toward the strike but never hard", () => {
    assert.ok(thunderFor({ t: 0, x: -30000, y: 0 }, 0, 0, 0).pan >= -0.6);
    assert.ok(thunderFor({ t: 0, x: 4000, y: 0 }, 0, 0, 0).pan > 0);
  });
});

describe("env source change detection", () => {
  it("is stable for the same match, even with an invalid override, and flips on any field", () => {
    const map = {};
    const st = { envSeed: 4, todStartMin: 600, durationMs: 1000, weatherOverride: "bogus" };
    const src = emptyEnvSource();
    assert.equal(sameEnvSource(src, st, map), false);
    rememberEnvSource(src, st, map);
    assert.equal(sameEnvSource(src, st, map), true);
    assert.equal(sameEnvSource(src, { ...st, envSeed: 5 }, map), false);
    assert.equal(sameEnvSource(src, { ...st, weatherOverride: "" }, map), false);
    assert.equal(sameEnvSource(src, st, {}), false);
  });
});
