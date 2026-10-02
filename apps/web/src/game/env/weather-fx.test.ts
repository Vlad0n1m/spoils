/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/env/*.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Particle, Texture } from "pixi.js";
import { envSchedule, sampleEnv, type EnvConfig } from "@extract/shared";
import {
  FLASH_MAX,
  FLASH_REDUCED_MAX,
  GRADE,
  RAIN,
  RainField,
  SplashField,
  duskAmount,
  gradeFor,
  lastStrikeAge,
  lerpColor,
  lightningAlpha,
  rainSlant,
  viewRectOf,
  wrap,
  type ParticleLike,
  type ViewRect,
} from "./weather-fx";
import { noiseToAlpha, tileableNoise } from "./textures";

const p = (): ParticleLike => ({ x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, alpha: 1 });
const VIEW: ViewRect = { left: 1000, top: 2000, w: 1700, h: 1000 };

function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

describe("helpers", () => {
  it("wrap is a positive modulo", () => {
    assert.equal(wrap(5, 4), 1);
    assert.equal(wrap(-1, 4), 3);
    assert.equal(wrap(-8, 4), 0);
  });

  it("lerpColor blends channels", () => {
    assert.equal(lerpColor(0x000000, 0xffffff, 0.5), 0x808080);
    assert.equal(lerpColor(0xffffff, 0xa9b6c4, 0), 0xffffff);
    assert.equal(lerpColor(0xffffff, 0xa9b6c4, 1), 0xa9b6c4);
    assert.equal(lerpColor(0x102030, 0x405060, 7), 0x405060);
  });

  it("rain leans more with wind", () => {
    assert.ok(rainSlant(1) > rainSlant(0));
    assert.equal(rainSlant(0), 0.1);
  });
});

describe("grading", () => {
  it("dry noon is untouched", () => {
    const g = gradeFor({ wetness: 0, todMin: 720, cloud: 0 });
    assert.equal(g.wet, 0xffffff);
    assert.equal(g.dusk, 0xffffff);
  });

  it("soaked ground tints toward the wet colour", () => {
    const g = gradeFor({ wetness: 1, todMin: 720, cloud: 1 });
    assert.notEqual(g.wet, 0xffffff);
    assert.equal(g.wet, lerpColor(0xffffff, GRADE.WET_COLOR, GRADE.WET_MAX));
  });

  it("golden hour is warm at 19:30, gone at night, weaker when overcast", () => {
    assert.equal(duskAmount(1170, 0), 1);
    assert.equal(duskAmount(1350, 0), 0);
    assert.equal(duskAmount(720, 0), 0);
    assert.ok(duskAmount(390, 0) > 0.99); // dawn peak
    assert.ok(duskAmount(1170, 1) < duskAmount(1170, 0));
    assert.equal(duskAmount(1170 + 1440, 0), 1); // wraps
  });
});

describe("lightning", () => {
  it("double flicker, capped at FLASH_MAX", () => {
    assert.equal(lightningAlpha(0), FLASH_MAX);
    assert.equal(lightningAlpha(80), 0);
    assert.ok(lightningAlpha(150) > 0.2);
    assert.equal(lightningAlpha(400), 0);
    assert.equal(lightningAlpha(-1), 0);
    assert.equal(lightningAlpha(Number.POSITIVE_INFINITY), 0);
    for (let t = 0; t < 500; t += 5) assert.ok(lightningAlpha(t) <= FLASH_MAX);
  });

  it("reduce flashes caps it lower", () => {
    for (let t = 0; t < 500; t += 5) assert.ok(lightningAlpha(t, FLASH_REDUCED_MAX) <= FLASH_REDUCED_MAX + 1e-12);
  });

  it("finds the age of the latest strike", () => {
    const s = [
      { t: 100, x: 0, y: 0 },
      { t: 500, x: 0, y: 0 },
    ];
    assert.equal(lastStrikeAge(s, 50), Number.POSITIVE_INFINITY);
    assert.equal(lastStrikeAge(s, 100), 0);
    assert.equal(lastStrikeAge(s, 450), 350);
    assert.equal(lastStrikeAge(s, 520), 20);
  });

  it("agrees with sampleEnv's flash on a real storm", () => {
    const cfg: EnvConfig = { seed: 11, todStartMin: 1350, durationMs: 4 * 60_000, mapW: 24576, mapH: 24576, override: "storm" };
    const strikes = envSchedule(cfg).strikes;
    for (const s of strikes.slice(0, 5)) {
      assert.ok(lightningAlpha(lastStrikeAge(strikes, s.t + 10)) > 0);
      assert.ok(sampleEnv(cfg, s.t + 10).flash > 0);
    }
  });
});

describe("RainField", () => {
  it("keeps active drops inside the view and parks the rest", () => {
    const drops = Array.from({ length: 100 }, p);
    const f = new RainField(drops, seeded(1));
    f.step(16, VIEW, 0.5, 0.2);
    assert.equal(f.active, 50);
    for (let i = 0; i < 50; i++) {
      const d = drops[i]!;
      assert.ok(d.x >= VIEW.left && d.x < VIEW.left + VIEW.w, `x ${d.x}`);
      assert.ok(d.y >= VIEW.top && d.y < VIEW.top + VIEW.h, `y ${d.y}`);
    }
    for (let i = 50; i < 100; i++) assert.ok(drops[i]!.x < -1e5);
  });

  it("drops fall down and lean with the slant", () => {
    const drops = [p()];
    const f = new RainField(drops, () => 0.5);
    f.step(0, VIEW, 1, 0.3);
    const x0 = drops[0]!.x;
    const y0 = drops[0]!.y;
    f.step(10, VIEW, 1, 0.3);
    const dy = wrap(drops[0]!.y - y0, VIEW.h);
    const dx = wrap(drops[0]!.x - x0, VIEW.w);
    assert.ok(dy > 0);
    assert.ok(Math.abs(dx / dy - 0.3) < 1e-6);
  });

  it("reports a rotation change only when the slant moves", () => {
    const drops = Array.from({ length: 4 }, p);
    const f = new RainField(drops, seeded(2));
    assert.equal(f.step(16, VIEW, 1, 0.2), true);
    assert.equal(f.step(16, VIEW, 1, 0.205), false);
    assert.equal(f.step(16, VIEW, 1, 0.4), true);
    assert.ok(drops[0]!.rotation < 0);
  });

  it("revived drops scatter instead of stacking on one spot", () => {
    const drops = Array.from({ length: 50 }, p);
    const f = new RainField(drops, seeded(3));
    f.step(16, VIEW, 0, 0.2);
    f.step(16, VIEW, 1, 0.2);
    const xs = new Set(drops.map((d) => Math.round(d.x)));
    assert.ok(xs.size > 40);
  });
});

describe("SplashField", () => {
  it("rings grow and fade, never appear under a roof", () => {
    const rings = Array.from({ length: 64 }, p);
    const f = new SplashField(rings, seeded(4));
    for (let k = 0; k < 60; k++) f.step(16, VIEW, 1, (x) => x < VIEW.left + VIEW.w / 2);
    let shown = 0;
    for (const r of rings) {
      assert.ok(r.alpha >= 0 && r.alpha <= RAIN.SPLASH_ALPHA);
      if (r.alpha > 0) {
        shown++;
        assert.ok(r.x >= VIEW.left + VIEW.w / 2, "covered half stays dry");
        assert.ok(r.scaleX >= RAIN.SPLASH_SCALE_FROM && r.scaleX <= RAIN.SPLASH_SCALE_TO);
      }
    }
    assert.ok(shown > 5);
  });

  it("zero intensity hides every ring after one life", () => {
    const rings = Array.from({ length: 16 }, p);
    const f = new SplashField(rings, seeded(5));
    for (let k = 0; k < 40; k++) f.step(16, VIEW, 0, () => false);
    assert.ok(rings.every((r) => r.alpha === 0));
  });
});

describe("viewRectOf", () => {
  it("derives the world view from toScreen whatever the camera anchor", () => {
    const ctx = {
      camera: () => ({ x: 5000, y: 3000, zoom: 2, width: 1600, height: 900 }),
      toScreen: (x: number, y: number) => ({ x: (x - 5000) * 2 + 800, y: (y - 3000) * 2 + 450 }),
    };
    const v = viewRectOf(ctx, 0, { left: 0, top: 0, w: 0, h: 0 });
    assert.equal(v.left, 5000 - 400);
    assert.equal(v.top, 3000 - 225);
    assert.equal(v.w, 800);
    assert.equal(v.h, 450);
  });
});

describe("textures", () => {
  it("noise is tileable, normalised and deterministic", () => {
    const n = 64;
    const a = tileableNoise(n, 4, 3, 9);
    const b = tileableNoise(n, 4, 3, 9);
    assert.deepEqual(a, b);
    let lo = 1;
    let hi = 0;
    for (const v of a) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    assert.ok(lo >= 0 && hi <= 1 && hi - lo > 0.2);
    // Seam: the last column flows into the first as smoothly as any neighbouring pair.
    let seam = 0;
    let inner = 0;
    for (let y = 0; y < n; y++) {
      seam += Math.abs(a[y * n + n - 1]! - a[y * n]!);
      inner += Math.abs(a[y * n + 10]! - a[y * n + 11]!);
    }
    assert.ok(seam < inner * 3 + 0.5, `seam ${seam} vs inner ${inner}`);
  });

  it("noiseToAlpha is a soft threshold", () => {
    assert.equal(noiseToAlpha(0.1, 0.3, 0.7), 0);
    assert.equal(noiseToAlpha(0.9, 0.3, 0.7), 1);
    assert.ok(Math.abs(noiseToAlpha(0.5, 0.3, 0.7) - 0.5) < 1e-12);
  });
});

describe("perf budget", () => {
  it("heavy rain (450 streaks + 64 splashes on real Pixi particles) steps well under 1 ms/frame", () => {
    const drops = Array.from({ length: RAIN.MAX_STREAKS }, () => new Particle(Texture.WHITE));
    const rings = Array.from({ length: RAIN.MAX_SPLASHES }, () => new Particle(Texture.WHITE));
    const rain = new RainField(drops);
    const spl = new SplashField(rings);
    const roof = (x: number) => x < 0;
    const view = { ...VIEW };
    // Warm up the JIT first, as a real session would be.
    for (let k = 0; k < 200; k++) {
      view.left += 3;
      rain.step(16.7, view, 1, 0.45);
      spl.step(16.7, view, 1, roof);
    }
    const frames = 600;
    const t0 = performance.now();
    for (let k = 0; k < frames; k++) {
      view.left += 3;
      rain.step(16.7, view, 1, 0.45 + (k % 2) * 0.001);
      spl.step(16.7, view, 1, roof);
    }
    const perFrame = (performance.now() - t0) / frames;
    // Budget is 1 ms on a mid laptop (≈3–4× slower than a dev machine): require 0.25 ms here.
    assert.ok(perFrame < 0.25, `weather sim ${perFrame.toFixed(4)} ms/frame`);
  });
});
