import assert from "node:assert/strict";
import { test } from "node:test";
import { SOLID, buildCollisionIndex, raycastSolids } from "../geometry.js";
import { mulberry32 } from "../rng.js";
import { getLegacyCollisionIndex, legacyMap, legacyMapData } from "./legacy.js";
import { TERRAIN_INDOOR } from "./types.js";

// legacyMapData keeps v1 running on the v2 MapData shape until WP-M2 switches to generateMap.
test("legacyMapData keeps v1 geometry and gives every spawn/extract a side", () => {
  const map = legacyMapData(4242);
  assert.equal(map.width, 4800);
  assert.ok(map.containers.length > 0 && map.extracts.length > 0 && map.spawns.length > 0);
  assert.ok(map.extracts.length <= 8, "extractMask is a uint8");
  for (const s of [...map.spawns, ...map.extracts]) assert.ok(s.side >= 0 && s.side <= 3);
  for (const c of map.containers) assert.ok(c.tier >= 1 && c.tier <= 4);
  assert.ok(map.rects.every((r) => r.f === SOLID.ALL) && map.circles.every((c) => c.f === SOLID.ALL), "v1: everything blocks everything");
  assert.ok(map.terrain.some((t) => (t & TERRAIN_INDOOR) !== 0), "building floors are indoor");
  assert.equal(legacyMapData(4242), map, "cached");
});

test("the MapData collision index matches the v1 index", () => {
  const v1 = legacyMap(4242);
  const map = legacyMapData(4242);
  const a = getLegacyCollisionIndex(v1);
  const b = buildCollisionIndex(map, map.width, map.height);
  const rng = mulberry32(1);
  for (let i = 0; i < 3000; i++) {
    const x0 = rng() * 4800, y0 = rng() * 4800, x1 = rng() * 4800, y1 = rng() * 4800;
    assert.equal(raycastSolids(a, x0, y0, x1, y1, SOLID.ALL), raycastSolids(b, x0, y0, x1, y1, SOLID.SIGHT));
  }
});
