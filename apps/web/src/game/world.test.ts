/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/world.test.ts
 *
 * The live canopy layer (bush lookup through the grid, per-chunk lazy objects, see-through fade)
 * and the minimap window. Pixi display objects work in node; textures are empty stand-ins.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Texture } from "pixi.js";
import { TREE_CANOPY_MULT, VISION, generateMap, mulberry32 } from "@extract/shared";
import { SPRITE_NAMES, type Textures } from "./assets";
import { CANOPY_INSIDE_ALPHA, CanopyLayer } from "./canopy";
import { chunkGridOf } from "./ground-chunks";
import { MINIMAP_WINDOW, minimapWindow } from "./minimap";

const map = generateMap("steppe");
const grid = chunkGridOf(map);
const tex = Object.fromEntries(SPRITE_NAMES.map((n) => [n, Texture.EMPTY])) as Textures;

describe("canopy bushAt", () => {
  const layer = new CanopyLayer(map, tex, grid);

  it("matches the brute-force rule (inside 0.9 r, lowest index wins) everywhere", () => {
    const rng = mulberry32(99);
    let hits = 0;
    const brute = (x: number, y: number) => {
      for (let i = 0; i < map.bushes.length; i++) {
        const b = map.bushes[i]!;
        const r = b.r * VISION.BUSH_INSIDE_FRAC;
        if ((x - b.x) ** 2 + (y - b.y) ** 2 < r * r) return i;
      }
      return -1;
    };
    // Random points plus points right next to bush centres (where hits are).
    for (let i = 0; i < 20_000; i++) {
      let x: number, y: number;
      if (i % 2) {
        const b = map.bushes[Math.floor(rng() * map.bushes.length)]!;
        x = b.x + (rng() - 0.5) * b.r * 2.2;
        y = b.y + (rng() - 0.5) * b.r * 2.2;
      } else {
        x = rng() * map.width;
        y = rng() * map.height;
      }
      const want = brute(x, y);
      assert.equal(layer.bushIndexAt(x, y), want);
      assert.equal(layer.bushAt(x, y), want < 0 ? null : map.bushes[want]);
      if (want >= 0) hits++;
    }
    assert.ok(hits > 3000);
  });
});

describe("canopy chunks", () => {
  it("creates display objects lazily, only for chunks around the view", () => {
    const layer = new CanopyLayer(map, tex, grid);
    assert.equal(layer.createdCount, 0);
    // Somewhere wooded (the map centre is the concrete Grain Elevator: no canopy at all).
    const t = map.circles.filter((c) => c.k === "tree")[500]!;
    const x = t.x, y = t.y;
    layer.update({ x0: x - 960, y0: y - 610, x1: x + 960, y1: y + 610 }, null);
    const n = layer.createdCount;
    assert.ok(n > 0);
    const total = map.bushes.length + map.circles.filter((c) => c.k === "tree" || c.k === "silo").length;
    assert.ok(n < total / 10, `${n} of ${total} created for one view`);
    // Same view again: nothing new.
    layer.update({ x0: x - 960, y0: y - 610, x1: x + 960, y1: y + 610 }, null);
    assert.equal(layer.createdCount, n);
    layer.destroy();
  });

  it("hides chunks that leave the view", () => {
    const layer = new CanopyLayer(map, tex, grid);
    layer.update({ x0: 1000, y0: 1000, x1: 2000, y1: 2000 }, null);
    const before = layer.root.children.flatMap((sub) => sub.children).filter((c) => c.visible).length;
    assert.ok(before > 0);
    layer.update({ x0: 20_000, y0: 20_000, x1: 21_000, y1: 21_000 }, null);
    const shown = layer.root.children.flatMap((sub) => sub.children).filter((c) => c.visible);
    // Only the new range's chunk containers are visible.
    assert.ok(shown.length <= 3 * 9, `${shown.length} visible chunk nodes`);
    layer.destroy();
  });

  it("fades a crown while the player stands under it and restores it after", () => {
    const layer = new CanopyLayer(map, tex, grid);
    const tree = map.circles.find((c) => c.k === "tree")!;
    const view = { x0: tree.x - 960, y0: tree.y - 610, x1: tree.x + 960, y1: tree.y + 610 };
    // Stand next to the trunk (inside the crown radius).
    const self = { x: tree.x + tree.r + 30, y: tree.y };
    assert.ok(tree.r + 30 < tree.r * TREE_CANOPY_MULT * 0.85);
    for (let i = 0; i < 60; i++) layer.update(view, self, 16.7);
    const sprites = layer.root.children.flatMap((sub) => sub.children.flatMap((n) => n.children));
    const faded = sprites.filter((s) => Math.abs(s.alpha - CANOPY_INSIDE_ALPHA.tree) < 0.02);
    assert.ok(faded.length >= 1, "the crown above the player is see-through");
    for (let i = 0; i < 120; i++) layer.update(view, { x: tree.x + 900, y: tree.y + 500 }, 16.7);
    const still = sprites.filter((s) => s.alpha < 0.99);
    assert.equal(still.length, 0, "everything is opaque again after leaving");
    layer.destroy();
  });
});

describe("minimap window", () => {
  it("is centred on the player away from the edges", () => {
    assert.deepEqual(minimapWindow(map, 12_000, 12_000), { x: 12_000 - 2048, y: 12_000 - 2048, w: MINIMAP_WINDOW, h: MINIMAP_WINDOW });
  });

  it("clamps inside the map at the edges and on small maps", () => {
    assert.deepEqual(minimapWindow(map, 100, 24_500), { x: 0, y: map.height - MINIMAP_WINDOW, w: MINIMAP_WINDOW, h: MINIMAP_WINDOW });
    assert.deepEqual(minimapWindow({ width: 3000, height: 2000 }, 1500, 1000), { x: 0, y: 0, w: 3000, h: 2000 });
  });
});
