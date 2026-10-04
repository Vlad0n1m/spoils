/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/effects.test.ts
 * Pixi display objects work in node; canvas textures are swapped for Texture.WHITE.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Texture } from "pixi.js";
import { WEAPONS, buildCollisionIndex } from "@extract/shared";
import { Effects, tracerSpan, type FxTextures } from "./effects";

const TEX: FxTextures = { line: Texture.WHITE, flash: Texture.WHITE, dot: Texture.WHITE, vignette: Texture.WHITE };

describe("tracerSpan", () => {
  it("grows the head at bullet speed, then the tail catches up and the tracer ends", () => {
    assert.deepEqual(tracerSpan(0, 500, 1000), { tail: 0, head: 0 });
    assert.deepEqual(tracerSpan(0.05, 500, 1000), { tail: 0, head: 50 });
    const mid = tracerSpan(0.2, 500, 1000)!;
    assert.equal(mid.head, 200);
    assert.equal(mid.tail, 130);
    assert.deepEqual(tracerSpan(0.55, 500, 1000), { tail: 480, head: 500 });
    assert.equal(tracerSpan(0.6, 500, 1000), null);
  });
});

describe("Effects pools", () => {
  it("reuses tracer and flash sprites instead of creating new ones", () => {
    const fx = new Effects({ textures: TEX });
    fx.shot(null, "a", "shotgun", 0, 0, 10, 0, [0, 0.1, -0.1], false, 0);
    const first = fx.stats();
    assert.equal(first.tracers, 3);
    assert.equal(first.pooledSprites, 6, "glow + core per tracer");
    // Let every tracer finish: range / speed plus the tail.
    const life = (WEAPONS.shotgun.range / WEAPONS.shotgun.bulletSpeed) * 1000 + 200;
    fx.update(life, 16, 800, 600);
    assert.equal(fx.stats().tracers, 0);
    fx.shot(null, "a", "shotgun", 0, 0, 10, 0, [0, 0.2], false, life + 10);
    assert.equal(fx.stats().pooledSprites, 6, "finished tracers' sprites were reused");
    fx.destroy();
  });

  it("places the streak between tail and head with round-cap extension", () => {
    const fx = new Effects({ textures: TEX });
    fx.shot(null, "a", "rifle", 0, 0, 0, 0, [0], false, 0);
    const speed = WEAPONS.rifle.bulletSpeed;
    fx.update(100, 16, 800, 600); // head at 0.1 s × speed
    const layer = fx.layer.children[0]!; // tracer layer
    const [glow, core] = layer.children as Array<{ x: number; scale: { x: number; y: number }; visible: boolean }>;
    const head = Math.min(0.1 * speed, 0.1 * speed);
    const tail = Math.max(0, 0.1 * speed - 70);
    assert.ok(glow!.visible && core!.visible);
    // Rifle width 3: glow 5 wide, core 1.5 wide; each extends by half its width at both ends.
    assert.equal(glow!.scale.y, 5);
    assert.ok(Math.abs(glow!.scale.x - (head - tail + 5)) < 1e-9);
    assert.ok(Math.abs(glow!.x - (tail - 2.5)) < 1e-9);
    assert.equal(core!.scale.y, 1.5);
    fx.destroy();
  });

  it("stopTracer shortens the matching tracer to the hit point", () => {
    const fx = new Effects({ textures: TEX });
    fx.shot(null, "a", "rifle", 0, 0, 0, 0, [0], false, 0);
    fx.shot(null, "b", "rifle", 0, 100, 0, 100, [0], false, 0);
    fx.hit("a", 120, 2, false, 10);
    // The tracer from "a" now ends at x = 120: gone once its tail passes 120.
    const speed = WEAPONS.rifle.bulletSpeed;
    fx.update(((120 + 70) / speed) * 1000 + 5, 16, 800, 600);
    assert.equal(fx.stats().tracers, 1, "only b's tracer is still flying");
    fx.destroy();
  });

  it("runs particles through the ParticleContainer, capped, and recycles them", () => {
    const fx = new Effects({ textures: TEX });
    for (let i = 0; i < 80; i++) fx.burst(0, 0, 0xff0000, 9, 260, 0);
    fx.update(16, 16, 800, 600);
    assert.equal(fx.stats().particles, 600, "capped at MAX_PARTICLES");
    const pc = fx.layer.children[2] as unknown as { particleChildren: unknown[] };
    assert.equal(pc.particleChildren.length, 600);
    fx.update(1000, 16, 800, 600); // every particle lives at most 450 ms
    assert.equal(fx.stats().particles, 0);
    assert.equal(pc.particleChildren.length, 0);
    fx.burst(0, 0, 0xff0000, 5, 260, 1000);
    fx.update(1010, 10, 800, 600);
    assert.equal(pc.particleChildren.length, 5);
    fx.destroy();
  });

  it("does not touch the ring Graphics while no ring is alive", () => {
    const fx = new Effects({ textures: TEX });
    const g = fx.layer.children[3] as unknown as { clear: () => unknown };
    let clears = 0;
    const orig = g.clear.bind(g);
    g.clear = () => {
      clears++;
      return orig();
    };
    for (let t = 0; t < 10; t++) fx.update(t * 16, 16, 800, 600);
    assert.equal(clears, 0);
    fx.ring(0, 0, 0xffffff, 80, 100, 200);
    fx.update(250, 16, 800, 600);
    fx.update(320, 16, 800, 600); // ring over: cleared once
    fx.update(340, 16, 800, 600);
    assert.equal(clears, 2);
    fx.destroy();
  });

  it("muzzle flash fades and returns to the pool", () => {
    const fx = new Effects({ textures: TEX });
    fx.shot(null, "a", "pistol", 0, 0, 0, 0, [0], false, 0);
    fx.update(35, 16, 800, 600);
    assert.equal(fx.stats().flashes, 1);
    // Each flash is a pooled pair: the additive muzzle light, then the star over it.
    const glow = fx.layer.children[1]!.children[0]!;
    const flash = fx.layer.children[1]!.children[1]!;
    assert.ok(Math.abs(flash.alpha - 0.45) < 1e-9);
    assert.ok(glow.visible && glow.alpha > 0);
    fx.update(80, 16, 800, 600);
    assert.equal(fx.stats().flashes, 0);
    assert.equal(flash.visible, false);
    assert.equal(glow.visible, false);
    fx.destroy();
  });
});

describe("combat feel", () => {
  it("a tracer that stops at a wall leaves an impact; one stopped in a body does not", () => {
    const wall = buildCollisionIndex({ rects: [{ x: 300, y: -50, w: 20, h: 100 }], circles: [] }, 1000, 1000);
    const fx = new Effects({ textures: TEX });
    fx.shot(wall, "a", "rifle", 0, 0, 20, 0, [0], false, 0);
    for (let t = 16; t < 400; t += 16) fx.update(t, 16, 800, 600);
    assert.ok(fx.stats().particles > 0, "impact particles at the wall");
    const fx2 = new Effects({ textures: TEX });
    fx2.shot(wall, "a", "rifle", 0, 0, 20, 0, [0], false, 0);
    fx2.stopTracer("a", 150, 0);
    for (let t = 16; t < 400; t += 16) fx2.update(t, 16, 800, 600);
    assert.equal(fx2.stats().particles, 0);
    fx.destroy();
    fx2.destroy();
  });

  it("particles stay under the cap during a long shotgun burst into a wall", () => {
    const wall = buildCollisionIndex({ rects: [{ x: 200, y: -500, w: 20, h: 1000 }], circles: [] }, 1000, 1000);
    const fx = new Effects({ textures: TEX });
    const a = [-0.2, -0.1, 0, 0.1, 0.2, -0.15, 0.15, 0.05];
    for (let t = 0; t < 3000; t += 16) {
      if (t % 48 === 0) fx.shot(wall, "a", "shotgun", 0, 0, 20, 0, a, true, t);
      fx.update(t, 16, 800, 600);
      assert.ok(fx.stats().particles <= 600);
    }
    fx.destroy();
  });
});

describe("Weapons v2 shots", () => {
  it("the crossbow flies a bolt sprite and has no muzzle flash; other guns flash", () => {
    const fx = new Effects({ textures: TEX, bolt: Texture.WHITE });
    fx.shot(null, "a", "crossbow", 0, 0, 10, 0, [0], false, 0);
    let st = fx.stats();
    assert.equal(st.tracers, 1);
    assert.equal(st.flashes, 0, "no flash");
    assert.equal(st.bolts, 1, "one bolt sprite");
    assert.equal(st.pooledSprites, 0, "no tracer streak");
    // The bolt is gone once it reached the end of its flight (range / speed), and its sprite is reused.
    fx.update((WEAPONS.crossbow.range / WEAPONS.crossbow.bulletSpeed) * 1000 + 20, 16, 800, 600);
    assert.equal(fx.stats().tracers, 0);
    fx.shot(null, "a", "crossbow", 0, 0, 10, 0, [0], false, 2000);
    assert.equal(fx.stats().bolts, 1, "the bolt sprite was reused");
    for (const w of ["smg", "lmg", "revolver"] as const) fx.shot(null, "b", w, 0, 0, 10, 0, [0], false, 3000);
    st = fx.stats();
    assert.equal(st.flashes, 3);
    fx.destroy();
  });

  it("without the bolt texture a crossbow shot falls back to a streak (still no flash)", () => {
    const fx = new Effects({ textures: TEX });
    fx.shot(null, "a", "crossbow", 0, 0, 10, 0, [0], false, 0);
    const st = fx.stats();
    assert.deepEqual([st.tracers, st.pooledSprites, st.bolts, st.flashes], [1, 2, 0, 0]);
    fx.destroy();
  });
});
