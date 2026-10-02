import assert from "node:assert/strict";
import { test } from "node:test";
import { STEP_MATERIALS, TERRAIN, TERRAIN_INDOOR } from "./types.js";
import { isIndoorByte, surfaceOf, terrainKind } from "./surface.js";

test("surfaceOf: material, variant index and step range for every terrain kind", () => {
  for (const t of Object.values(TERRAIN)) {
    const s = surfaceOf(t);
    assert.equal(STEP_MATERIALS[s.variant], s.material, `terrain ${t}`);
    assert.ok(s.stepRangeMult > 0.5 && s.stepRangeMult < 2);
  }
  assert.equal(surfaceOf(TERRAIN.WOOD).material, "wood");
  assert.equal(surfaceOf(TERRAIN.SHALLOW).material, "water");
  assert.ok(surfaceOf(TERRAIN.GRASS).stepRangeMult < surfaceOf(TERRAIN.WOOD).stepRangeMult, "grass is soft, wood is loud");
});

test("the INDOOR bit is ignored by surfaceOf and read by isIndoorByte", () => {
  const floor = TERRAIN.CONCRETE | TERRAIN_INDOOR;
  assert.deepEqual(surfaceOf(floor), surfaceOf(TERRAIN.CONCRETE));
  assert.equal(terrainKind(floor), TERRAIN.CONCRETE);
  assert.equal(isIndoorByte(floor), true);
  assert.equal(isIndoorByte(TERRAIN.CONCRETE), false);
  assert.equal(surfaceOf(0x7e).material, "grass", "unknown kinds fall back to grass");
});
