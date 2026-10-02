/**
 * WP-I world FX pools in effects.ts (blood, casings, dust, ambient, delay queue).
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/world-fx.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ACT, STEP_MATERIALS, SoundKind, generateMap, surfaceAt } from "@extract/shared";
import {
  AMBIENT,
  AmbientField,
  BLOOD,
  CASING,
  CasingField,
  DecalField,
  FX_EV,
  FxQueue,
  PUFF,
  PuffField,
  ambientTargets,
  bloodSplats,
  createAmbientSystem,
  createWorldFxSystem,
  dustTint,
  remoteDustVariant,
  wrapIn,
  type FxParticle,
} from "./effects";

const mk = (n: number, scale = 1): FxParticle[] =>
  Array.from({ length: n }, () => ({ x: 0, y: 0, scaleX: scale, scaleY: scale, rotation: 0, alpha: 1, tint: 0xffffff }));

/** Deterministic rnd for the fields. */
function seq(...xs: number[]) {
  let i = 0;
  return () => xs[i++ % xs.length]!;
}

describe("helpers", () => {
  it("bloodSplats grows with damage, none for armor-only hits", () => {
    assert.equal(bloodSplats(0), 0);
    assert.equal(bloodSplats(-3), 0);
    assert.equal(bloodSplats(9), 1);
    assert.equal(bloodSplats(20), 2);
    assert.equal(bloodSplats(75), 3);
  });
  it("dustTint: dirt / asphalt / gravel / concrete raise dust, not grass, water or wet ground", () => {
    for (const m of ["dirt", "asphalt", "gravel", "concrete"]) assert.ok(dustTint(m) >= 0, m);
    for (const m of ["grass", "forest", "wood", "water"]) assert.equal(dustTint(m), -1, m);
    assert.equal(dustTint("dirt", 0.8), -1, "mud");
  });
  it("wrapIn is a positive modulo", () => {
    assert.equal(wrapIn(5, 10), 5);
    assert.equal(wrapIn(-1, 10), 9);
    assert.equal(wrapIn(25, 10), 5);
  });
});

describe("DecalField", () => {
  it("fades over the last FADE_MS and frees the slot at the end", () => {
    const items = mk(4);
    const f = new DecalField(items, 1000, 200);
    assert.ok(items.every((p) => p.alpha === 0), "parked at start");
    f.spawn(10, 20, 0.5, 0.4, 1, 0x7d0a10, 0.8, 0);
    assert.equal(f.live, 1);
    assert.deepEqual([items[0]!.x, items[0]!.y, items[0]!.scaleX, items[0]!.scaleY, items[0]!.rotation], [10, 20, 0.5, 0.4, 1]);
    f.step(700);
    assert.equal(items[0]!.alpha, 0.8);
    f.step(900);
    assert.ok(Math.abs(items[0]!.alpha - 0.4) < 1e-6);
    f.step(1000);
    assert.equal(f.live, 0);
    assert.equal(items[0]!.alpha, 0);
  });
  it("grows pools in and reuses the oldest decal when full", () => {
    const items = mk(2);
    const f = new DecalField(items, 10_000, 100);
    f.spawn(0, 0, 1.5, 1.2, 0, 1, 1, 0, 2000);
    assert.ok(items[0]!.scaleX < 0.1, "a pool starts small");
    f.step(1000);
    assert.ok(items[0]!.scaleX > 0.5 && items[0]!.scaleX < 1.5);
    f.step(2000);
    assert.ok(Math.abs(items[0]!.scaleX - 1.5) < 1e-6);
    assert.ok(Math.abs(items[0]!.scaleY - 1.2) < 1e-6);
    f.spawn(1, 1, 1, 1, 0, 2, 1, 2000);
    f.spawn(2, 2, 1, 1, 0, 3, 1, 2000);
    assert.equal(f.live, 2, "ring buffer: never more than the pool");
    assert.equal(items[0]!.x, 2, "the oldest slot was reused");
    assert.equal(BLOOD.MAX, 200);
  });
});

describe("CasingField", () => {
  it("flies out, spins, settles and fades", () => {
    const items = mk(3);
    const f = new CasingField(items);
    f.spawn(0, 0, 0, 200, 20, 0.5, CASING.BRASS, 0);
    for (let t = 16; t <= CASING.FLY_MS + 32; t += 16) f.step(16, t);
    const p = items[0]!;
    assert.ok(p.x > 10 && p.x < 60, `flew a bit: ${p.x}`);
    assert.ok(Math.abs(p.y) < 1e-9);
    assert.notEqual(p.rotation, 0, "spun");
    assert.equal(p.scaleX, 0.5, "back to size after the bounces");
    const x = p.x;
    f.step(16, 5000);
    assert.equal(p.x, x, "settled casings do not move");
    assert.equal(p.alpha, 1);
    f.step(16, CASING.LIFE_MS - CASING.FADE_MS / 2);
    assert.ok(Math.abs(p.alpha - 0.5) < 1e-6);
    f.step(16, CASING.LIFE_MS);
    assert.equal(f.live, 0);
    assert.equal(p.alpha, 0);
  });
  it("bounces (scale bump) during flight", () => {
    const items = mk(1);
    const f = new CasingField(items);
    f.spawn(0, 0, 0, 0, 0, 1, 0, 0);
    let max = 0;
    for (let t = 16; t < CASING.FLY_MS; t += 16) {
      f.step(16, t);
      max = Math.max(max, items[0]!.scaleX);
    }
    assert.ok(max > 1.1);
  });
});

describe("PuffField", () => {
  it("expands, slows and fades out", () => {
    const items = mk(PUFF.STEP_N);
    const f = new PuffField(items);
    f.spawn(0, 0, 100, 0, 8, 24, 500, 0xc2a378, 0.5, 0);
    const s0 = items[0]!.scaleX;
    f.step(100, 100);
    assert.ok(items[0]!.x > 0);
    assert.ok(items[0]!.scaleX > s0);
    assert.ok(items[0]!.alpha < 0.5 && items[0]!.alpha > 0);
    f.step(100, 500);
    assert.equal(f.live, 0);
    assert.equal(items[0]!.alpha, 0);
  });
  it("burst spawns n particles from the pool, wrapping when full", () => {
    const items = mk(4);
    const f = new PuffField(items);
    f.burst(0, 0, 6, 0, 0.5, 50, [5, 10], 400, 1, 1, 0, seq(0.5));
    assert.equal(f.live, 4);
  });
});

describe("FxQueue", () => {
  it("fires due entries only, in any order, and keeps the rest", () => {
    const q = new FxQueue(8);
    q.push(100, FX_EV.BLOOD, 1, 2, 3, 4);
    q.push(50, FX_EV.CASING, 5, 6);
    q.push(300, FX_EV.STEP, 7, 8);
    const fired: number[][] = [];
    q.drain(120, (k, x, y, a, b) => fired.push([k, x, y, a, b]));
    assert.deepEqual(
      fired.sort((a, b) => a[0]! - b[0]!),
      [
        [FX_EV.CASING, 5, 6, 0, 0],
        [FX_EV.BLOOD, 1, 2, 3, 4],
      ],
    );
    assert.equal(q.n, 1);
    q.drain(400, (k) => fired.push([k]));
    assert.equal(q.n, 0);
    assert.equal(fired.at(-1)![0], FX_EV.STEP);
  });
  it("drops events when full instead of growing", () => {
    const q = new FxQueue(2);
    assert.equal(q.push(0, 1, 0, 0), true);
    assert.equal(q.push(0, 1, 0, 0), true);
    assert.equal(q.push(0, 1, 0, 0), false);
    assert.equal(q.n, 2);
  });
});

describe("ambient", () => {
  const out = { motes: 0, fireflies: 0, leaves: 0 };
  it("motes by day, fireflies by night, nothing indoors, rain kills both", () => {
    const day = ambientTargets({ light: 1, rain: 0, fog: 0, wind: 0.3 }, false, 0, out);
    assert.equal(day.motes, AMBIENT.MOTES);
    assert.equal(day.fireflies, 0);
    const night = ambientTargets({ light: 0.12, rain: 0, fog: 0, wind: 0.3 }, false, 0, out);
    assert.equal(night.motes, 0);
    assert.equal(night.fireflies, AMBIENT.FIREFLIES);
    const rain = ambientTargets({ light: 0.12, rain: 1, fog: 0, wind: 0.3 }, false, 0, out);
    assert.equal(rain.fireflies, 0);
    const inside = ambientTargets({ light: 1, rain: 0, fog: 0, wind: 1 }, true, 1, out);
    assert.deepEqual({ ...inside }, { motes: 0, fireflies: 0, leaves: 0 });
  });
  it("more leaves in the forest and in wind", () => {
    const a = ambientTargets({ light: 1, rain: 0, fog: 0, wind: 0 }, false, 0, out).leaves;
    const b = ambientTargets({ light: 1, rain: 0, fog: 0, wind: 0 }, false, 1, out).leaves;
    const c = ambientTargets({ light: 1, rain: 0, fog: 0, wind: 1 }, false, 1, out).leaves;
    assert.ok(b > a && c > b);
    assert.equal(c, AMBIENT.LEAVES);
  });

  it("AmbientField fades particles in / out with the count and keeps them inside the view", () => {
    const items = mk(10, 0.3);
    const f = new AmbientField(items, "mote", seq(0.1, 0.5, 0.9, 0.3, 0.7));
    const view = { left: 1000, top: 2000, w: 400, h: 300 };
    for (let i = 0; i < 120; i++) f.step(16, i * 0.016, view, 5, 0.5);
    assert.equal(f.shown, 5);
    for (const p of items.slice(0, 5)) {
      assert.ok(p.x >= 1000 && p.x < 1400 && p.y >= 2000 && p.y < 2300, `inside: ${p.x},${p.y}`);
      assert.ok(p.alpha > 0);
    }
    assert.ok(items.slice(5).every((p) => p.alpha === 0), "the rest stay parked");
    // The camera moves far away: particles wrap into the new view (world-locked drift).
    const far = { left: 9000, top: 9000, w: 400, h: 300 };
    f.step(16, 2, far, 5, 0.5);
    assert.ok(items[0]!.x >= 9000 && items[0]!.x < 9400);
    // Count drops to 0: they fade, then park.
    for (let i = 0; i < 400; i++) f.step(16, 2 + i * 0.016, far, 0, 0.5);
    assert.equal(f.shown, 0);
    assert.ok(items.every((p) => p.alpha === 0));
  });

  it("fireflies blink and leaves flutter", () => {
    const ff = mk(1, 0.3);
    const f = new AmbientField(ff, "firefly", seq(0.5));
    const view = { left: 0, top: 0, w: 500, h: 500 };
    let lo = 1;
    let hi = 0;
    for (let i = 0; i < 600; i++) {
      f.step(16, i * 0.016, view, 1, 0);
      if (i > 100) {
        lo = Math.min(lo, ff[0]!.alpha);
        hi = Math.max(hi, ff[0]!.alpha);
      }
    }
    assert.equal(lo, 0, "dark between blinks");
    assert.ok(hi > 0.5, "bright at the peak");

    const leaf = mk(1, 0.6);
    const l = new AmbientField(leaf, "leaf", seq(0.5));
    const widths = new Set<number>();
    for (let i = 0; i < 60; i++) {
      l.step(16, i * 0.016, view, 1, 0.5);
      widths.add(Math.round(leaf[0]!.scaleX * 100));
    }
    assert.ok(widths.size > 5, "scaleX changes as the leaf turns over");
    assert.ok(leaf[0]!.scaleX <= 0.6 + 1e-9);
  });
});

describe("systems", () => {
  it("construct without a DOM and dispose twice", () => {
    for (const s of [createWorldFxSystem(), createAmbientSystem()]) {
      s.dispose();
      s.dispose();
    }
  });
});

describe("remote dust", () => {
  const map = generateMap("steppe");
  /** First point on a dusty surface (a road / yard), scanning the map. */
  function dusty(): { x: number; y: number } {
    for (let y = 64; y < map.height; y += 256) {
      for (let x = 64; x < map.width; x += 256) if (dustTint(surfaceAt(map, x, y).material) >= 0) return { x, y };
    }
    throw new Error("no dusty ground on the map");
  }

  it("a remote roll on a dusty road raises dust although the sound carries variant 0 (grass)", () => {
    const p = dusty();
    assert.equal(STEP_MATERIALS[0], "grass", "the wire variant of roll sounds");
    const v = remoteDustVariant(SoundKind.roll, 0, ACT.ROLL, map, p.x, p.y);
    assert.equal(v, surfaceAt(map, p.x, p.y).variant);
    assert.ok(dustTint(STEP_MATERIALS[v]!) >= 0);
    assert.equal(remoteDustVariant(SoundKind.roll, 0, ACT.ROLL, null, p.x, p.y), -1, "no map yet: no dust");
  });

  it("a remote quiet walk (Shift) raises no dust, like our own sneaking; normal steps keep the wire material", () => {
    const p = dusty();
    const mat = surfaceAt(map, p.x, p.y).variant;
    assert.equal(remoteDustVariant(SoundKind.step, mat, ACT.WALK, map, p.x, p.y), -1);
    assert.equal(remoteDustVariant(SoundKind.step, mat, ACT.WALK | ACT.RELOAD, map, p.x, p.y), -1);
    assert.equal(remoteDustVariant(SoundKind.step, mat, ACT.IDLE, map, p.x, p.y), mat);
    assert.equal(remoteDustVariant(SoundKind.step, "x", ACT.IDLE, map, p.x, p.y), 0, "malformed variant falls back to grass");
  });
});
