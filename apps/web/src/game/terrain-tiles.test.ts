/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/terrain-tiles.test.ts
 *
 * Ground layer order, edge styles, the indoor fill, and the soft kind masks — in particular that
 * two neighbouring chunks compute identical mask values along their shared edge (no seams).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TERRAIN, TERRAIN_INDOOR, TERRAIN_KIND_MASK, generateMap, type Terrain } from "@extract/shared";
import {
  FLOOR_SPRITE,
  GROUND_BASE,
  GROUND_LAYERS,
  GROUND_OVERLAYS,
  floorPlan,
  overlayMask,
  MASK_RES,
  MASK_RING,
  MaskScratch,
  TERRAIN_COLOR,
  TILE_SCALE,
  TILE_SPRITE,
  chunkMaskRegion,
  edgeNoise,
  groundKinds,
  kindMask,
  regionKinds,
  underBits,
  type CellRegion,
} from "./terrain-tiles";
import { SPRITE_NAMES } from "./assets";

const map = generateMap("steppe");
const ALL_KINDS = Object.values(TERRAIN) as Terrain[];
const layerIndex = (k: Terrain) => GROUND_LAYERS.findIndex((l) => l.kind === k);

describe("ground layers", () => {
  it("cover every terrain kind exactly once (base + layers)", () => {
    const kinds = [GROUND_BASE, ...GROUND_LAYERS.map((l) => l.kind)].sort();
    assert.deepEqual(kinds, [...ALL_KINDS].sort());
  });

  it("paint water after asphalt (roads never cover the river) and crossings after water", () => {
    assert.ok(layerIndex(TERRAIN.WATER) > layerIndex(TERRAIN.ASPHALT));
    assert.ok(layerIndex(TERRAIN.BRIDGE) > layerIndex(TERRAIN.WATER));
    assert.ok(layerIndex(TERRAIN.SHALLOW) > layerIndex(TERRAIN.WATER));
    assert.ok(layerIndex(TERRAIN.FOREST) < layerIndex(TERRAIN.DIRT), "dirt roads cut through forest");
  });

  it("edge styles keep far-from-edge cells exactly 0 / 1 (noise ≤ the smoothstep margin)", () => {
    for (const { kind, edge } of GROUND_LAYERS) {
      assert.ok(edge.lo <= edge.hi, `kind ${kind}`);
      assert.ok(edge.noise / 2 <= edge.lo + 1e-9 && edge.noise / 2 <= 1 - edge.hi + 1e-9, `kind ${kind}`);
      // Blur reach (two box passes) + dilation must stay inside the mask ring, or chunks would seam.
      assert.ok(edge.blur * 2 < MASK_RING * MASK_RES - MASK_RES / 2, `kind ${kind} blur too wide for the ring`);
    }
    // Water must hug its (cell-aligned) collision: tight edge.
    const water = GROUND_LAYERS[layerIndex(TERRAIN.WATER)]!.edge;
    assert.ok(water.blur <= 1 && water.noise <= 0.1);
  });

  it("every kind has a tile source, a scale and a map colour; sprite tiles exist", () => {
    for (const k of ALL_KINDS) {
      assert.ok(TILE_SCALE[k] > 0);
      assert.ok(TERRAIN_COLOR[k] >= 0);
      const s = TILE_SPRITE[k];
      if (s) assert.ok((SPRITE_NAMES as readonly string[]).includes(s), `${s} is loaded by assets.ts`);
    }
  });

  it("underBits lists exactly the kinds painted later", () => {
    assert.equal(underBits(GROUND_LAYERS[GROUND_LAYERS.length - 1]!.kind), 0);
    const forest = underBits(TERRAIN.FOREST);
    for (const l of GROUND_LAYERS.slice(1)) assert.ok(forest & (1 << l.kind));
    assert.equal(forest & (1 << TERRAIN.FOREST), 0);
    assert.equal(underBits(TERRAIN.WATER) & (1 << TERRAIN.DIRT), 0);
  });
});

describe("groundKinds", () => {
  const g = groundKinds(map);

  it("is memoized per map", () => {
    assert.equal(groundKinds(map), g);
  });

  it("keeps outdoor cells and replaces every indoor cell by an outdoor kind", () => {
    let indoor = 0;
    const outdoorKinds = new Set<number>();
    for (let i = 0; i < map.terrain.length; i++) {
      const b = map.terrain[i]!;
      if (b & TERRAIN_INDOOR) indoor++;
      else {
        assert.equal(g[i], b & TERRAIN_KIND_MASK);
        outdoorKinds.add(b & TERRAIN_KIND_MASK);
      }
    }
    assert.ok(indoor > 1000, "Steppe has indoor floors");
    for (let i = 0; i < g.length; i++) assert.ok(outdoorKinds.has(g[i]!));
    // Wood only exists as indoor floor: after the fill no ground cell shows it.
    assert.equal(g.filter((k) => k === TERRAIN.WOOD).length, 0);
  });
});

/** Tiny synthetic terrain: left half forest, right half grass, a 2-cell water column at x = 9..10. */
function synthetic(cols = 40, rows = 24) {
  const kinds = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      kinds[r * cols + c] = c === 9 || c === 10 ? TERRAIN.WATER : c < 20 + (r % 3) ? TERRAIN.FOREST : TERRAIN.GRASS;
    }
  }
  return { kinds, cols, rows };
}

describe("regionKinds", () => {
  it("reports present and fully-covering kinds, clamping outside the map", () => {
    const { kinds, cols, rows } = synthetic();
    const all = regionKinds(kinds, cols, rows, { c0: 0, r0: 0, cols, rows });
    assert.ok(all.present & (1 << TERRAIN.FOREST) && all.present & (1 << TERRAIN.GRASS) && all.present & (1 << TERRAIN.WATER));
    assert.equal(all.full, 0);
    // A block left of the water, extending past the map edge (clamped reads), is all forest.
    const left = regionKinds(kinds, cols, rows, { c0: -5, r0: -5, cols: 10, rows: 10 });
    assert.equal(left.present, 1 << TERRAIN.FOREST);
    assert.equal(left.full, 1 << TERRAIN.FOREST);
  });
});

describe("kindMask", () => {
  const forest = GROUND_LAYERS[layerIndex(TERRAIN.FOREST)]!;

  function mask(reg: CellRegion, kinds: Uint8Array, cols: number, rows: number, kind: Terrain, under = 0) {
    const out = new Uint8Array(reg.cols * MASK_RES * reg.rows * MASK_RES * 4);
    const edge = GROUND_LAYERS[layerIndex(kind)]!.edge;
    kindMask(kinds, cols, rows, reg, kind, edge, out, new MaskScratch(), under);
    return out;
  }

  it("is opaque grey (red channel = coverage), exact far from edges, soft at edges", () => {
    const { kinds, cols, rows } = synthetic();
    const reg = { c0: 0, r0: 0, cols, rows };
    const out = mask(reg, kinds, cols, rows, TERRAIN.FOREST);
    const w = cols * MASK_RES;
    const px = (x: number, y: number) => out[(y * w + x) * 4]!;
    for (let i = 3; i < out.length; i += 4) assert.equal(out[i], 255);
    assert.equal(px(2 * MASK_RES, 10 * MASK_RES), 255); // deep in forest
    assert.equal(px(30 * MASK_RES, 10 * MASK_RES), 0); // deep in grass
    // Somewhere along the forest/grass boundary there are intermediate values.
    let soft = 0;
    for (let x = 18 * MASK_RES; x < 24 * MASK_RES; x++) {
      const v = px(x, 12 * MASK_RES);
      if (v > 0 && v < 255) soft++;
    }
    assert.ok(soft > 0 && forest.edge.blur > 0);
  });

  it("is deterministic", () => {
    const { kinds, cols, rows } = synthetic();
    const reg = { c0: 3, r0: 2, cols: 20, rows: 20 };
    assert.deepEqual(mask(reg, kinds, cols, rows, TERRAIN.FOREST), mask(reg, kinds, cols, rows, TERRAIN.FOREST));
    assert.equal(edgeNoise(123, 456, 1), edgeNoise(123, 456, 1));
    for (let i = 0; i < 500; i++) {
      const v = edgeNoise(i * 13, i * 7, 2);
      assert.ok(v >= 0 && v < 1);
    }
  });

  it("dilates one cell under later kinds so two soft layers never show the base between them", () => {
    const { kinds, cols, rows } = synthetic();
    const reg = { c0: 0, r0: 0, cols, rows };
    const plain = mask(reg, kinds, cols, rows, TERRAIN.FOREST);
    const dil = mask(reg, kinds, cols, rows, TERRAIN.FOREST, 1 << TERRAIN.WATER);
    const w = cols * MASK_RES;
    // Centre of the first water column (cell 9): forest-only mask is clear, dilated mask covers it.
    const at = (o: Uint8Array) => o[((12 * MASK_RES + 4) * w + 9 * MASK_RES + 4) * 4]!;
    assert.ok(at(plain) < 64);
    assert.equal(at(dil), 255);
  });

  it("neighbouring Steppe chunks agree on their shared edge (no seams)", () => {
    const g = groundKinds(map);
    const per = map.width / 1024;
    let compared = 0;
    // Chunks whose region mixes forest and other kinds (real soft edges).
    for (const [cx, cy] of [[3, 3], [7, 12], [15, 5], [10, 20], [20, 9]] as const) {
      const a = chunkMaskRegion(cx, cy, 1024, map.terrainCell);
      const b = chunkMaskRegion(cx + 1, cy, 1024, map.terrainCell);
      for (const L of GROUND_LAYERS) {
        const ma = mask(a, g, map.terrainCols, map.terrainRows, L.kind, underBits(L.kind));
        const mb = mask(b, g, map.terrainCols, map.terrainRows, L.kind, underBits(L.kind));
        const wa = a.cols * MASK_RES;
        const wb = b.cols * MASK_RES;
        // Global mask x of the shared chunk edge.
        const edgeX = (cx + 1) * (1024 / map.terrainCell) * MASK_RES;
        // Columns right around the edge are inside BOTH regions' trustworthy interior.
        for (let gx = edgeX - 4; gx < edgeX + 4; gx++) {
          for (let ly = MASK_RING * MASK_RES; ly < a.rows * MASK_RES - MASK_RING * MASK_RES; ly++) {
            const va = ma[(ly * wa + (gx - a.c0 * MASK_RES)) * 4];
            const vb = mb[(ly * wb + (gx - b.c0 * MASK_RES)) * 4];
            assert.equal(va, vb, `layer ${L.kind} chunk ${cx},${cy} gx ${gx} ly ${ly}`);
            compared++;
          }
        }
      }
      assert.ok(per > cx + 1);
    }
    assert.ok(compared > 1000);
  });

  it("chunk regions include the ring on every side", () => {
    const r = chunkMaskRegion(2, 5, 1024, 64);
    assert.deepEqual(r, { c0: 32 - MASK_RING, r0: 80 - MASK_RING, cols: 16 + 2 * MASK_RING, rows: 16 + 2 * MASK_RING });
  });
});

describe("map v2 ground variety and floors", () => {
  const g = groundKinds(map);
  const cols = map.terrainCols, rows = map.terrainRows;

  it("overlay and floor art is loaded by assets.ts", () => {
    for (const ov of GROUND_OVERLAYS) assert.ok((SPRITE_NAMES as readonly string[]).includes(ov.sprite), ov.sprite);
    for (const s of Object.values(FLOOR_SPRITE)) assert.ok((SPRITE_NAMES as readonly string[]).includes(s), s);
  });

  it("overlay masks are seamless across chunks, stay inside their base kind and cover part of it", () => {
    for (const ov of GROUND_OVERLAYS) {
      // The same global cell from two overlapping regions gets the same texel.
      const a = { c0: 100, r0: 120, cols: 20, rows: 20 };
      const b = { c0: 110, r0: 125, cols: 20, rows: 20 };
      const oa = new Uint8Array(20 * 20 * 4), ob = new Uint8Array(20 * 20 * 4);
      overlayMask(g, cols, rows, a, ov, oa);
      overlayMask(g, cols, rows, b, ov, ob);
      for (let r = 5; r < 20; r++) for (let c = 10; c < 20; c++) {
        assert.equal(oa[(r * 20 + c) * 4], ob[((r - 5) * 20 + (c - 10)) * 4], `${ov.sprite} seam at ${c},${r}`);
      }
      // Whole map: an eroded overlay never touches a cell next to another kind.
      const all = { c0: 0, r0: 0, cols, rows };
      const out = new Uint8Array(cols * rows * 4);
      assert.ok(overlayMask(g, cols, rows, all, ov, out), `${ov.sprite} appears on the Steppe`);
      let on = 0, base = 0;
      for (let i = 0; i < cols * rows; i++) {
        if (g[i] === ov.base) {
          base++;
          if (out[i * 4]! >= 128) on++;
        }
        if (out[i * 4]! === 0 || !ov.erode) continue;
        const c = i % cols, r = Math.floor(i / cols);
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
          const rr = Math.min(rows - 1, Math.max(0, r + dr)), cc = Math.min(cols - 1, Math.max(0, c + dc));
          assert.equal(g[rr * cols + cc], ov.base, `${ov.sprite} leaks past its base at ${c},${r}`);
        }
      }
      // Patches, not a repaint: a visible share of the base, never most of it.
      const share = on / Math.max(1, base);
      console.log(`[overlay] ${ov.sprite}: ${(share * 100).toFixed(1)} % of its base`);
      assert.ok(share > 0.05 && share < 0.45, `${ov.sprite} covers ${(share * 100).toFixed(1)} % of its base`);
    }
  });

  it("floorPlan: houses get a ceramic kitchen in their smallest room, warehouses concrete", () => {
    const house = map.buildings.find((b) => b.arch === "houseM" && b.rooms.length >= 3)!;
    const p = floorPlan(house);
    assert.equal(p.main, "wood");
    assert.equal(p.rooms.length, 1);
    const [ri, st] = p.rooms[0]!;
    assert.equal(st, "ceramic");
    for (const r of house.rooms) assert.ok(r.w * r.h >= house.rooms[ri]!.w * house.rooms[ri]!.h);
    assert.equal(floorPlan(map.buildings.find((b) => b.arch === "warehouse")!).main, "concrete");
    for (const b of map.buildings) assert.ok(floorPlan(b).main in FLOOR_SPRITE, b.arch);
  });
});
