/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/renderer.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateMap, legacyMapData } from "@extract/shared";
import { createMapOverlaySystem } from "./fullmap";
import { LEGACY_MAP_ID, inputBlockedBy, mapForState } from "./renderer";
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

describe("inputBlockedBy", () => {
  it("the open full map (M) owns the mouse like the inventory: no fire, no aim", () => {
    type L = (e: unknown) => void;
    const listeners = new Map<string, L[]>();
    const g = globalThis as { window?: unknown };
    const hadWindow = "window" in g;
    const prev = g.window;
    g.window = {
      addEventListener: (t: string, f: L) => listeners.set(t, [...(listeners.get(t) ?? []), f]),
      removeEventListener: (t: string, f: L) => listeners.set(t, (listeners.get(t) ?? []).filter((x) => x !== f)),
    };
    const key = (code: string) => {
      for (const f of listeners.get("keydown") ?? []) f({ code, repeat: false, metaKey: false, ctrlKey: false, altKey: false, target: null });
    };
    try {
      const map = createMapOverlaySystem();
      map.init?.({} as never);
      const inventoryOpen = () => false;
      assert.equal(inputBlockedBy(inventoryOpen, [map]), false, "closed map");
      key("KeyM");
      assert.equal(map.isInputBlocked?.(), true);
      assert.equal(inputBlockedBy(inventoryOpen, [map]), true, "open map blocks fire and aim");
      key("Escape");
      assert.equal(inputBlockedBy(inventoryOpen, [map]), false, "Esc closes it");
      assert.equal(inputBlockedBy(() => true, []), true, "DOM overlays still block");
      assert.equal(inputBlockedBy(undefined, []), false);
      key("KeyM");
      map.dispose();
      assert.equal(map.isInputBlocked?.(), false, "a disposed map blocks nothing");
    } finally {
      if (hadWindow) g.window = prev;
      else delete g.window;
    }
  });
});
