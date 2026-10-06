/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/orientation.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isPortraitViewport, lockLandscape } from "./orientation";

describe("landscape lock", () => {
  it("portrait = taller than wide; square, landscape and empty sizes are not", () => {
    assert.equal(isPortraitViewport(390, 844), true);
    assert.equal(isPortraitViewport(844, 390), false);
    assert.equal(isPortraitViewport(500, 500), false);
    assert.equal(isPortraitViewport(0, 800), false);
  });

  it("a refused or missing orientation lock never throws", async () => {
    const g = globalThis as { screen?: unknown };
    const prev = Object.getOwnPropertyDescriptor(globalThis, "screen");
    const set = (v: unknown) => Object.defineProperty(globalThis, "screen", { value: v, configurable: true, writable: true });
    try {
      set({ orientation: undefined });
      lockLandscape();
      set({ orientation: {} });
      lockLandscape();
      set({ orientation: { lock: () => Promise.reject(new Error("NotSupportedError")) } });
      lockLandscape();
      set({
        orientation: {
          lock: () => {
            throw new Error("sync");
          },
        },
      });
      lockLandscape();
      await new Promise((r) => setTimeout(r, 0));
    } finally {
      if (prev) Object.defineProperty(globalThis, "screen", prev);
      else delete g.screen;
    }
  });
});
