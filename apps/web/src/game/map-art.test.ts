/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/map-art.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TERRAIN, TERRAIN_INDOOR, generateMap } from "@extract/shared";
import { GROUND_CLASS, MAP_PALETTE, blurMask, classMasks, groundClass, rasterTerrain } from "./map-art";
import { groundKinds } from "./terrain-tiles";

const rgbOf = (c: number) => [(c >> 16) & 255, (c >> 8) & 255, c & 255];
const near = (a: ArrayLike<number>, i: number, c: number, tol = 12) => {
  const [r, g, b] = rgbOf(c);
  return Math.abs(a[i]! - r!) <= tol && Math.abs(a[i + 1]! - g!) <= tol && Math.abs(a[i + 2]! - b!) <= tol;
};

describe("map art terrain", () => {
  it("groups terrain kinds into ground classes (INDOOR bit ignored)", () => {
    assert.equal(groundClass(TERRAIN.GRASS), GROUND_CLASS.FIELD);
    assert.equal(groundClass(TERRAIN.FOREST), GROUND_CLASS.FOREST);
    assert.equal(groundClass(TERRAIN.GRAVEL), GROUND_CLASS.SAND);
    assert.equal(groundClass(TERRAIN.CONCRETE | TERRAIN_INDOOR), GROUND_CLASS.PAVED);
    assert.equal(groundClass(TERRAIN.SHALLOW), GROUND_CLASS.WATER);
    assert.equal(groundClass(TERRAIN.BRIDGE), GROUND_CLASS.PAVED);
  });

  it("blurs a step into a smooth ramp through 0.5, leaving the source untouched", () => {
    const cols = 8, rows = 1;
    const src = new Float32Array([1, 1, 1, 1, 0, 0, 0, 0]);
    const out = blurMask(src, cols, rows, 2);
    assert.deepEqual(Array.from(src), [1, 1, 1, 1, 0, 0, 0, 0]);
    for (let i = 1; i < cols; i++) assert.ok(out[i]! <= out[i - 1]! + 1e-6, "monotonic");
    assert.ok(out[3]! > 0.5 && out[4]! < 0.5);
    assert.ok(Math.abs(out[3]! + out[4]! - 1) < 1e-5, "symmetric around the edge");
    assert.equal(out[0], 1);
  });

  it("class masks sum to 1 per cell", () => {
    const kinds = new Uint8Array([TERRAIN.GRASS, TERRAIN.FOREST, TERRAIN.WATER, TERRAIN.DIRT, TERRAIN.ASPHALT, TERRAIN.FOREST]);
    const masks = classMasks(kinds, 3, 2);
    for (let i = 0; i < kinds.length; i++) {
      const s = masks.reduce((a, m) => a + m[i]!, 0);
      assert.ok(Math.abs(s - 1) < 1e-5);
    }
  });

  it("rasterises half forest / half field with a soft but narrow edge", () => {
    const cols = 16, rows = 16, cell = 64;
    const kinds = new Uint8Array(cols * rows);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols / 2; c++) kinds[r * cols + c] = TERRAIN.FOREST;
    const size = 64;
    const px = rasterTerrain({ width: cols * cell, height: rows * cell, terrainCols: cols, terrainRows: rows, terrainCell: cell }, kinds, size);
    const at = (x: number, y: number) => (y * size + x) * 4;
    assert.ok(near(px, at(4, 32), MAP_PALETTE.forest), "forest side");
    assert.ok(near(px, at(60, 32), MAP_PALETTE.field), "field side");
    assert.equal(px[at(10, 10) + 3], 255);
    // The transition (neither colour) spans only a few pixels (≈ one cell = 4 px here).
    let mixed = 0;
    for (let x = 0; x < size; x++) if (!near(px, at(x, 32), MAP_PALETTE.forest, 14) && !near(px, at(x, 32), MAP_PALETTE.field, 14)) mixed++;
    assert.ok(mixed >= 1 && mixed <= 10, `mixed ${mixed}`);
  });

  it("paints the Outskirts terrain quickly enough to run once per map", () => {
    const map = generateMap("steppe");
    const kinds = groundKinds(map);
    const t0 = performance.now();
    const px = rasterTerrain(map, kinds, 1024);
    const ms = performance.now() - t0;
    assert.equal(px.length, 1024 * 1024 * 4);
    assert.ok(ms < 1500, `${ms.toFixed(0)} ms`);
  });
});
