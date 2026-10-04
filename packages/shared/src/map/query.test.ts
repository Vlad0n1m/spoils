import assert from "node:assert/strict";
import { test } from "node:test";
import { WORLD } from "../constants.js";
import { circleIsFree, SOLID } from "../geometry.js";
import { mulberry32 } from "../rng.js";
import { generateMap } from "./generate.js";
import {
  chunkRange,
  getCollisionIndex,
  getWalkGrid,
  isIndoor,
  mapHash,
  nearestWalkCell,
  terrainAt,
  terrainByteAt,
  terrainSpeedMult,
  WALK_CLEARANCE,
  walkCellOf,
  zoneAt,
} from "./query.js";
import { surfaceOf } from "./surface.js";
import { TERRAIN, TERRAIN_INDOOR, type MapData } from "./types.js";

const m = generateMap("steppe");

test("buildWalkGrid (rasterised) equals circleIsFree(MOVE) cell by cell", () => {
  const idx = getCollisionIndex(m);
  const g = getWalkGrid(m);
  assert.equal(getWalkGrid(m), g, "cached per MapData");
  assert.equal(g.cols * g.rows, g.blocked.length);
  const rng = mulberry32(5);
  let mismatches = 0;
  const check = (i: number) => {
    const x = (i % g.cols + 0.5) * g.cell, y = (Math.floor(i / g.cols) + 0.5) * g.cell;
    const free = circleIsFree(idx, x, y, WALK_CLEARANCE, SOLID.MOVE);
    if (free === (g.blocked[i] === 1)) mismatches++;
  };
  for (let n = 0; n < 40_000; n++) check(Math.floor(rng() * g.blocked.length));
  // Plus every cell around a few buildings, where walls, doors and windows meet.
  for (const b of m.buildings.slice(0, 12)) {
    for (let y = b.floor.y - 64; y < b.floor.y + b.floor.h + 64; y += g.cell) {
      for (let x = b.floor.x - 64; x < b.floor.x + b.floor.w + 64; x += g.cell) check(walkCellOf(g, x, y));
    }
  }
  assert.equal(mismatches, 0);
});

test("terrain queries: kind, INDOOR bit, ford speed, surface material", () => {
  const b = m.buildings.find((q) => q.arch === "houseM")!;
  const r = b.rooms[0]!;
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  assert.ok(isIndoor(m, cx, cy));
  assert.equal(terrainAt(m, cx, cy), TERRAIN.WOOD);
  assert.equal(terrainByteAt(m, cx, cy), TERRAIN.WOOD | TERRAIN_INDOOR);
  assert.equal(surfaceOf(terrainByteAt(m, cx, cy)).material, "wood");
  // Out-of-range points clamp instead of reading garbage.
  assert.equal(terrainAt(m, -500, -500), terrainAt(m, 0, 0));
  assert.equal(terrainAt(m, m.width + 9, m.height + 9), terrainAt(m, m.width - 1, m.height - 1));

  const fordCell = m.terrain.findIndex((v) => v === TERRAIN.SHALLOW);
  const fx = (fordCell % m.terrainCols + 0.5) * m.terrainCell, fy = (Math.floor(fordCell / m.terrainCols) + 0.5) * m.terrainCell;
  assert.equal(terrainAt(m, fx, fy), TERRAIN.SHALLOW);
  assert.equal(terrainSpeedMult(terrainAt(m, fx, fy)), 0.6);
  assert.equal(surfaceOf(TERRAIN.SHALLOW).material, "water");
  assert.equal(terrainSpeedMult(TERRAIN.BRIDGE), 1);
  assert.equal(terrainSpeedMult(TERRAIN.GRASS), 1);
  // The ford is walkable (no water solid) while deep water is MOVE-blocked.
  const g = getWalkGrid(m);
  assert.equal(g.blocked[walkCellOf(g, fx, fy)], 0);
  const water = m.rects.find((q) => q.k === "water")!;
  assert.equal(g.blocked[walkCellOf(g, water.x + water.w / 2, water.y + water.h / 2)], 1);
});

test("zoneAt / chunkRange / nearestWalkCell", () => {
  const z = m.zones.find((q) => q.id === "elevator")!;
  assert.equal(zoneAt(m, z.rect.x + 10, z.rect.y + 10)?.id, "elevator");
  assert.equal(zoneAt(m, z.rect.x + z.rect.w, z.rect.y + 10)?.id === "elevator", false); // right edge is exclusive
  assert.equal(zoneAt(m, 100, 100), undefined);
  assert.deepEqual(chunkRange(-50, -50, 1500, 2100), { cx0: 0, cy0: 0, cx1: 1, cy1: 2 });
  // Clamped to the last chunk of the 28-block map (map v2).
  assert.deepEqual(chunkRange(24_000, 0, 99_999, 10), { cx0: 23, cy0: 0, cx1: WORLD.BLOCKS - 1, cy1: 0 });
  const g = getWalkGrid(m);
  const wall = m.rects.find((q) => q.k === "wall" && q.w > 200)!;
  const i = nearestWalkCell(g, wall.x + wall.w / 2, wall.y + wall.h / 2, 96);
  assert.ok(i >= 0 && g.blocked[i] === 0);
  assert.equal(nearestWalkCell(g, -9999, -9999, 64), -1);
});

test("mapHash reacts to any layout change and ignores object identity", () => {
  const h = mapHash(m);
  const clone = (): MapData => ({
    ...m,
    rects: m.rects.map((r) => ({ ...r })),
    circles: m.circles.map((c) => ({ ...c })),
    containers: m.containers.map((c) => ({ ...c })),
    terrain: m.terrain.slice(),
  });
  assert.equal(mapHash(clone()), h);
  const a = clone();
  a.rects[500]!.x += 1;
  assert.notEqual(mapHash(a), h);
  const b = clone();
  b.circles[10]!.f = SOLID.MOVE;
  assert.notEqual(mapHash(b), h);
  const c = clone();
  c.terrain[c.terrain.length - 1] ^= TERRAIN_INDOOR; // last byte: covered by the tail of the hash
  assert.notEqual(mapHash(c), h);
  const d = clone();
  d.containers.pop();
  assert.notEqual(mapHash(d), h);
  // Container kind drives the loot table and open delay: a kind drift must be caught on join.
  const e = clone();
  e.containers[0]!.kind = e.containers[0]!.kind === "safe" ? "crate" : "safe";
  assert.notEqual(mapHash(e), h);
  assert.match(h, /^[0-9a-f]{8}$/);
});
