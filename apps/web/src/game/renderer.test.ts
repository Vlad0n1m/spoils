/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/renderer.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateMap, legacyMapData } from "@extract/shared";
import { LEGACY_MAP_ID, mapForState } from "./renderer";
import { SYSTEM_FACTORIES } from "./systems-registry";

describe("mapForState", () => {
  it("builds the v1 map from the match seed while the server runs the legacy map", () => {
    assert.equal(mapForState({ mapId: LEGACY_MAP_ID, mapSeed: 4242 }), legacyMapData(4242));
  });
  it("builds the fixed v2 layout otherwise (seed does not change geometry)", () => {
    const a = mapForState({ mapId: "steppe", mapSeed: 1 });
    assert.equal(a, generateMap("steppe"));
    assert.equal(mapForState({ mapId: "", mapSeed: 99 }), a);
  });
});

describe("SYSTEM_FACTORIES", () => {
  it("creates systems with unique ids and a dispose", () => {
    const systems = SYSTEM_FACTORIES.map((f) => f());
    assert.ok(systems.length >= 1);
    assert.equal(new Set(systems.map((s) => s.id)).size, systems.length);
    for (const s of systems) assert.equal(typeof s.dispose, "function");
    for (const s of systems) s.dispose();
  });
});
