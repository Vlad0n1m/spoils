/**
 * Pure parts of the fog of war (no GPU): cone / awareness textures against the shared coneAlpha,
 * darkness look per environment, the shadow-quad buffer packing, per-entity visibility and fades.
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/fog.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ENV, PLAYER, VISION, buildCollisionIndex, buildOccluderGrid, coneAlpha, pointShadowed } from "@extract/shared";
import {
  FOG,
  awarePixels,
  awareTexAlpha,
  coneTexAlpha,
  conePixels,
  entityVisibility,
  fadeToward,
  fogLook,
  fogRange,
  lerpColor,
  losVisible,
  nightFactor,
  quadIndices,
  writeShadowQuads,
} from "./fog";

const deg = (d: number) => (d * Math.PI) / 180;

describe("cone texture", () => {
  it("matches the shared coneAlpha (awareness excluded) inside the range", () => {
    const R = VISION.RANGE;
    for (const [angDeg, dist] of [[0, 100], [30, 500], [69, 700], [75, 300], [85, 500], [89, 900], [0, 850], [10, 950], [95, 300]] as const) {
      const a = deg(angDeg);
      const dx = Math.cos(a) * dist, dy = Math.sin(a) * dist;
      const want = dist > VISION.AWARE_R + VISION.AWARE_FADE ? coneAlpha(0, dx, dy, R) : null;
      const got = coneTexAlpha(dx / R, dy / R);
      if (want === null) continue;
      // smoothstep vs linear ramps: same endpoints, close in between.
      assert.ok(Math.abs(got - want) < 0.16, `ang ${angDeg} dist ${dist}: tex ${got} vs coneAlpha ${want}`);
      if (want === 1) assert.equal(got, 1);
      if (want === 0) assert.equal(got, 0);
    }
  });

  it("is symmetric around the aim and zero behind / beyond the range", () => {
    assert.equal(coneTexAlpha(0.5, 0.2), coneTexAlpha(0.5, -0.2));
    assert.equal(coneTexAlpha(-0.5, 0), 0);
    assert.equal(coneTexAlpha(1.01, 0), 0);
    assert.equal(coneTexAlpha(0, 0), 1);
  });

  it("packs a forward half texture with the eye at the left edge centre", () => {
    const R = 32;
    const px = conePixels(R);
    assert.equal(px.length, R * 2 * R * 4);
    const alphaAt = (x: number, y: number) => px[(y * R + x) * 4 + 3]!;
    assert.equal(alphaAt(2, R), 255, "straight ahead near the eye is fully visible");
    assert.equal(alphaAt(R - 1, 0), 0, "corner is outside the cone");
    assert.ok(alphaAt(R - 2, R) < 128, "near the range edge it fades");
  });
});

describe("awareness disc", () => {
  it("ramps from AWARE_R to AWARE_R + AWARE_FADE like coneAlpha behind the player", () => {
    for (const d of [0, 50, 72, 80, 90, 96, 120]) {
      assert.equal(awareTexAlpha(d), coneAlpha(0, -d, 0, VISION.RANGE), `d=${d}`);
    }
    const A = 16;
    const px = awarePixels(A);
    assert.equal(px.length, 4 * A * A * 4);
    assert.equal(px[(A * 2 * A + A) * 4 + 3], 255, "centre opaque");
    assert.equal(px[3], 0, "corner transparent");
  });
});

describe("fogLook / fogRange", () => {
  it("day is the base darkness without tint", () => {
    const l = fogLook({ light: 1, fog: 0 });
    assert.equal(l.color, FOG.DAY_COLOR);
    assert.equal(l.alpha, FOG.DAY_ALPHA);
    assert.equal(l.tint, 0xffffff);
  });

  it("night is darker and tints the world", () => {
    const l = fogLook({ light: ENV.NIGHT_LIGHT, fog: 0 });
    assert.ok(Math.abs(l.alpha - FOG.NIGHT_ALPHA) < 1e-9);
    assert.notEqual(l.tint, 0xffffff);
    assert.equal(nightFactor(ENV.NIGHT_LIGHT), 1);
    assert.equal(nightFactor(1), 0);
    const dusk = fogLook({ light: 0.5, fog: 0 });
    assert.ok(dusk.alpha > FOG.DAY_ALPHA && dusk.alpha < FOG.NIGHT_ALPHA);
  });

  it("fog weather turns the darkness into a lighter mist by day, not at night", () => {
    const mist = fogLook({ light: 1, fog: 1 });
    assert.equal(mist.color, FOG.MIST_COLOR);
    assert.ok(mist.alpha >= FOG.MIST_ALPHA - 1e-9);
    const nightFog = fogLook({ light: ENV.NIGHT_LIGHT, fog: 1 });
    assert.equal(nightFog.color, FOG.DAY_COLOR);
  });

  it("no environment yet = day", () => {
    assert.deepEqual(fogLook(null), fogLook({ light: 1, fog: 0 }));
  });

  it("range follows env.vis with the server's clamp", () => {
    assert.equal(fogRange({ vis: 1 }), VISION.RANGE);
    assert.equal(fogRange({ vis: 0.1 }), VISION.RANGE * VISION.MIN_RANGE_MULT);
    assert.equal(fogRange({ vis: 0.7 }), VISION.RANGE * 0.7);
    assert.equal(fogRange(null), VISION.RANGE);
  });

  it("lerpColor interpolates channels", () => {
    assert.equal(lerpColor(0x000000, 0xffffff, 0), 0x000000);
    assert.equal(lerpColor(0x000000, 0xffffff, 1), 0xffffff);
    assert.equal(lerpColor(0x000000, 0x204060, 0.5), 0x102030);
  });
});

describe("shadow quad buffer", () => {
  it("indexes two triangles per quad", () => {
    assert.deepEqual([...quadIndices(2)], [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  });

  it("zeroes the quads of the previous frame that are no longer used", () => {
    const grid = buildOccluderGrid({ width: 2000, height: 2000, rects: [{ x: 1100, y: 900, w: 50, h: 200 }], circles: [] });
    const pos = new Float32Array(64 * 8).fill(7);
    const a = writeShadowQuads(grid, 1000, 1000, 1000, pos, 64, 10);
    assert.ok(a.n >= 1 && a.n <= 3, `quads ${a.n}`);
    assert.equal(a.dirtyQuads, 10);
    for (let i = a.n * 8; i < 10 * 8; i++) assert.equal(pos[i], 0);
    assert.equal(pos[10 * 8], 7, "beyond the dirty range is untouched");
    const b = writeShadowQuads(grid, 1000, 1000, 1000, pos, 64, a.n);
    assert.equal(b.dirtyQuads, a.n);
  });

  it("every point inside a quad is behind the wall (oracle agrees)", () => {
    const map = { width: 2000, height: 2000, rects: [{ x: 1100, y: 900, w: 50, h: 200 }], circles: [] };
    const grid = buildOccluderGrid(map);
    const pos = new Float32Array(64 * 8);
    writeShadowQuads(grid, 1000, 1000, 1000, pos, 64, 0);
    // The quad's far edge is behind the wall: sample its midpoint area.
    assert.ok(pointShadowed(grid, 1000, 1000, 1300, 1000, 1000));
    assert.ok(!pointShadowed(grid, 1000, 1000, 1050, 1000, 1000));
  });
});

describe("entityVisibility", () => {
  const idx = buildCollisionIndex({ rects: [{ x: 1100, y: 900, w: 40, h: 200 }], circles: [] }, 3000, 3000);
  const eye = { x: 1000, y: 1000, aim: 0, range: VISION.RANGE };

  it("is coneAlpha in the open", () => {
    assert.equal(entityVisibility(idx, eye, 1000, 1400, 0), coneAlpha(0, 0, 400, VISION.RANGE), "90° to the side: 0");
    assert.equal(entityVisibility(idx, eye, 1000, 500, 0), 0);
    assert.equal(entityVisibility(idx, eye, 1300, 1400, 0), 1, "inside the cone, no wall in between");
  });

  it("is 0 behind a wall, but a body half behind the edge still shows", () => {
    assert.equal(entityVisibility(idx, eye, 1300, 1000, 0), 0);
    assert.equal(losVisible(idx, 1000, 1000, 1300, 1000, PLAYER.RADIUS), false);
    // Centre just hidden below the wall's end, a side point clears it.
    assert.equal(entityVisibility(idx, eye, 1300, 1285, 0), 0);
    assert.equal(entityVisibility(idx, eye, 1300, 1285, PLAYER.RADIUS), 1);
  });

  it("sees anything in the awareness disc, even behind the player", () => {
    assert.equal(entityVisibility(idx, eye, 950, 1000, 0), 1);
    assert.equal(entityVisibility(idx, eye, 850, 1000, 0), 0);
  });

  it("skips the LOS check without a collision index", () => {
    assert.equal(entityVisibility(null, eye, 1300, 1000, 0), 1);
  });
});

describe("fadeToward", () => {
  it("is frame-rate independent and snaps at the end", () => {
    let a = 0;
    for (let i = 0; i < 6; i++) a = fadeToward(a, 1, 25);
    let b = 0;
    for (let i = 0; i < 3; i++) b = fadeToward(b, 1, 50);
    assert.ok(Math.abs(a - b) < 1e-9);
    let c = 0;
    for (let i = 0; i < 100; i++) c = fadeToward(c, 1, 16);
    assert.equal(c, 1);
    assert.equal(fadeToward(0.4, 0.4, 16), 0.4);
    assert.equal(fadeToward(0.5, 0, 0), 0.5);
  });
});
