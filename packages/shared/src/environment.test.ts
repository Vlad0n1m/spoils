import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ENV,
  RAID_TIMES,
  WEATHER_KINDS,
  envConfigOf,
  envSchedule,
  raidTimeOf,
  rollRaidTime,
  sampleEnv,
  strikesBetween,
  sunLight,
  type EnvConfig,
  type RaidTime,
} from "./environment.js";

// Immersion memo test list (server plan, packages/shared).
const DURATION = 30 * 60_000;
const cfg = (seed: number, todStartMin = 720, override: EnvConfig["override"] = ""): EnvConfig => ({
  seed, todStartMin, durationMs: DURATION, mapW: 24_576, mapH: 24_576, override,
});

test("same seed → identical schedule, recomputed after the memo cache is flushed", () => {
  const a = JSON.stringify(envSchedule(cfg(42)));
  for (let s = 1000; s < 1040; s++) envSchedule(cfg(s)); // overflow the 32-entry cache
  assert.equal(JSON.stringify(envSchedule(cfg(42))), a);
  assert.notEqual(JSON.stringify(envSchedule(cfg(43))), a);
});

test("segments cover [0, duration] without gaps, 4–8 min each (last may be shorter)", () => {
  for (let seed = 0; seed < 300; seed++) {
    const { segments } = envSchedule(cfg(seed, [720, 1120, 1380, 250][seed % 4]!));
    assert.equal(segments[0]!.startMs, 0);
    assert.equal(segments.at(-1)!.endMs, DURATION);
    segments.forEach((s, i) => {
      if (i > 0) assert.equal(s.startMs, segments[i - 1]!.endMs);
      assert.ok(WEATHER_KINDS.includes(s.kind));
      const len = s.endMs - s.startMs;
      assert.ok(len > 0 && len <= ENV.SEGMENT_MAX_MS);
      if (i < segments.length - 1) assert.ok(len >= ENV.SEGMENT_MIN_MS, `seed ${seed} segment ${i}: ${len}`);
    });
  }
});

test("lightning: sorted, only inside storm segments after the blend, inside the map", () => {
  let total = 0;
  for (let seed = 0; seed < 400; seed++) {
    const c = cfg(seed, 1120);
    const { segments, strikes } = envSchedule(c);
    total += strikes.length;
    for (let i = 0; i < strikes.length; i++) {
      const s = strikes[i]!;
      if (i > 0) assert.ok(s.t >= strikes[i - 1]!.t);
      const seg = segments.find((g) => s.t >= g.startMs && s.t < g.endMs)!;
      assert.equal(seg.kind, "storm");
      assert.ok(s.t >= seg.startMs + ENV.BLEND_MS / 2);
      assert.ok(s.x >= 0 && s.x <= c.mapW && s.y >= 0 && s.y <= c.mapH);
    }
    // strikesBetween is a half-open window over the same list.
    if (strikes.length > 1) {
      const t0 = strikes[0]!.t, t1 = strikes[1]!.t;
      assert.deepEqual(strikesBetween(c, t0, t1), [strikes[0]]);
    }
  }
  assert.ok(total > 0, "some storms happen");
});

test("sunLight stays in [NIGHT_LIGHT, 1] and is continuous", () => {
  let prev = sunLight(0);
  for (let m = 0; m <= 2 * 1440; m += 0.25) {
    const l = sunLight(m);
    assert.ok(l >= ENV.NIGHT_LIGHT - 1e-12 && l <= 1 + 1e-12);
    assert.ok(Math.abs(l - prev) < 0.02 * 0.25 + 1e-12, `jump at ${m}`);
    prev = l;
  }
  assert.equal(sunLight(720), 1);
  assert.equal(sunLight(0), ENV.NIGHT_LIGHT);
  assert.equal(sunLight(-60), sunLight(1380), "negative minutes wrap");
});

test("sampleEnv is continuous second to second (except the lightning flash)", () => {
  const keys = ["rain", "fog", "wind", "cloud", "wetness", "light", "vis", "hear"] as const;
  for (const [seed, tod] of [[1, 720], [7, 1110], [9, 1380], [12, 250], [33, 1250]] as const) {
    const c = cfg(seed, tod);
    let prev = sampleEnv(c, 0);
    for (let t = 1000; t <= DURATION; t += 1000) {
      const s = sampleEnv(c, t);
      const flashy = s.flash > 0 || prev.flash > 0 ||
        strikesBetween(c, t - 1000 - ENV.LIGHTNING_FLASH_MS, t + 1).length > 0;
      for (const k of keys) {
        if (flashy && (k === "light" || k === "vis")) continue;
        assert.ok(Math.abs(s[k] - prev[k]) <= 0.05, `seed ${seed} t ${t} ${k}: ${prev[k]} → ${s[k]}`);
      }
      assert.ok(s.vis > 0 && s.vis <= 1 && s.hear > 0 && s.hear <= 1.15);
      assert.ok(s.light >= ENV.NIGHT_LIGHT * 0.65 - 1e-9 && s.light <= 1);
      prev = s;
    }
  }
});

test("sampleEnv: time of day advances at TOD_RATE and night lowers vis", () => {
  const day = sampleEnv(cfg(5, 720, "clear"), 0);
  assert.equal(day.todMin, 720);
  assert.equal(sampleEnv(cfg(5, 720, "clear"), 15 * 60_000).todMin, 720 + 15 * ENV.TOD_RATE);
  assert.equal(day.vis, 1);
  const night = sampleEnv(cfg(5, 1380, "clear"), 0);
  assert.ok(night.vis < 0.6 && night.hear > day.hear, "night: shorter sight, sharper hearing");
  assert.equal(sampleEnv(cfg(5, 1430, "clear"), 10 * 60_000).todMin, (1430 + 40) % 1440, "wraps past midnight");
  assert.equal(sampleEnv(cfg(5, 720), -500).todMin, 720, "negative clock clamps to 0");
});

test("override gives a single segment for the whole raid", () => {
  for (const k of WEATHER_KINDS) {
    const { segments } = envSchedule(cfg(3, 720, k));
    assert.deepEqual(segments, [{ kind: k, startMs: 0, endMs: DURATION }]);
    assert.equal(sampleEnv(cfg(3, 720, k), 600_000).kind, k);
  }
  const s = sampleEnv(cfg(3, 720, "fog"), 600_000);
  assert.ok(s.fog === 1 && s.vis < 0.6);
});

test("raid-time distribution over 1000 seeds is within ±5% of the weights", () => {
  const counts: Record<RaidTime, number> = { day: 0, dusk: 0, night: 0, dawn: 0 };
  const total = RAID_TIMES.reduce((a, r) => a + r.weight, 0);
  for (let seed = 0; seed < 1000; seed++) {
    const r = rollRaidTime(seed);
    counts[r.raidTime]++;
    const def = RAID_TIMES.find((x) => x.id === r.raidTime)!;
    assert.ok(r.todStartMin >= def.startMin[0] && r.todStartMin <= def.startMin[1]);
    assert.equal(raidTimeOf(r.todStartMin), r.raidTime, "start minute maps back to its raid time");
    assert.deepEqual(rollRaidTime(seed), r, "deterministic");
  }
  for (const r of RAID_TIMES) {
    assert.ok(Math.abs(counts[r.id] / 1000 - r.weight / total) <= 0.05, `${r.id}: ${counts[r.id]}`);
  }
});

test("envConfigOf reads the state fields and ignores unknown overrides", () => {
  const st = { envSeed: 9, todStartMin: 800, durationMs: DURATION, weatherOverride: "storm" };
  assert.deepEqual(envConfigOf(st, { width: 100, height: 200 }), {
    seed: 9, todStartMin: 800, durationMs: DURATION, mapW: 100, mapH: 200, override: "storm",
  });
  assert.equal(envConfigOf({ ...st, weatherOverride: "hail" }, { width: 1, height: 1 }).override, "");
  assert.equal(envConfigOf({ ...st, weatherOverride: "" }, { width: 1, height: 1 }).override, "");
});
