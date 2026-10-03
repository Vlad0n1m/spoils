/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/fullmap.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { allowedExtracts, extractMask, generateMap, type MapSide, type Zone } from "@extract/shared";
import { TIER_COLORS, ZONE_KIND_LABEL, ZoneTracker, allowedFromMask, formatClock, fullMapExtractView, toastAlpha, zoneSubtitle } from "./fullmap";
import { WORLD } from "@extract/shared";
import { bossSpotShown, bossSpotsShown, liveBossTurf } from "./boss";

const map = generateMap("steppe");

describe("ZoneTracker", () => {
  const zones: Zone[] = [
    { id: "a", name: "Alpha", kind: "village", tier: 2, rect: { x: 0, y: 0, w: 1000, h: 1000 } },
    { id: "b", name: "Bravo", kind: "military", tier: 4, rect: { x: 2000, y: 0, w: 1000, h: 1000 } },
  ];
  const t0 = 10_000;

  it("toasts a zone after the dwell time, once", () => {
    const zt = new ZoneTracker({ zones }, { dwellMs: 400, repeatMs: 45_000 });
    assert.equal(zt.update(500, 500, t0), null);
    assert.equal(zt.update(500, 500, t0 + 399), null);
    assert.equal(zt.update(500, 500, t0 + 400)?.id, "a");
    assert.equal(zt.zoneId, "a");
    assert.equal(zt.update(510, 500, t0 + 2000), null);
  });

  it("ignores edge-walking flicker shorter than the dwell", () => {
    const zt = new ZoneTracker({ zones }, { dwellMs: 400 });
    let toasts = 0;
    for (let i = 0; i < 100; i++) {
      // Alternate inside/outside the zone every 100 ms.
      const x = i % 2 ? 990 : 1010;
      if (zt.update(x, 500, t0 + i * 100)) toasts++;
    }
    assert.equal(toasts, 0);
  });

  it("does not repeat the same zone within repeatMs, but does after", () => {
    const zt = new ZoneTracker({ zones }, { dwellMs: 0, repeatMs: 45_000 });
    assert.equal(zt.update(500, 500, t0)?.id, "a");
    assert.equal(zt.update(1500, 500, t0 + 1000), null); // wilderness: no toast
    assert.equal(zt.update(500, 500, t0 + 2000), null); // back too soon
    assert.equal(zt.update(2500, 500, t0 + 3000)?.id, "b"); // another zone toasts
    assert.equal(zt.update(1500, 500, t0 + 50_000), null);
    assert.equal(zt.update(500, 500, t0 + 50_001)?.id, "a");
  });

  it("finds every Steppe POI at its centre", () => {
    const zt = new ZoneTracker(map, { dwellMs: 0, repeatMs: 0 });
    for (const z of map.zones) {
      zt.reset();
      assert.equal(zt.update(z.rect.x + z.rect.w / 2, z.rect.y + z.rect.h / 2, t0)?.id, z.id);
    }
  });
});

describe("toast + labels", () => {
  it("fades in, holds, fades out, then is gone", () => {
    assert.equal(toastAlpha(-1), 0);
    assert.equal(toastAlpha(0), 0);
    assert.ok(toastAlpha(100) > 0 && toastAlpha(100) < 1);
    assert.equal(toastAlpha(1000), 1);
    assert.ok(toastAlpha(2700) < 1);
    assert.equal(toastAlpha(10_000), 0);
  });

  it("has a label for every zone kind and a colour for every tier", () => {
    for (const z of map.zones) {
      assert.ok(ZONE_KIND_LABEL[z.kind]);
      assert.ok(TIER_COLORS[z.tier] !== undefined);
      assert.equal(zoneSubtitle(z), `${ZONE_KIND_LABEL[z.kind]} · T${z.tier}`);
    }
  });

  it("formats extract closing times", () => {
    assert.equal(formatClock(25 * 60_000), "25:00");
    assert.equal(formatClock(61_500), "1:01");
    assert.equal(formatClock(-5), "0:00");
  });
});

describe("allowed extracts on the full map", () => {
  it("decodes SelfState.extractMask into exactly allowedExtracts(side)", () => {
    for (const side of [0, 1, 2, 3] as MapSide[]) {
      const flags = allowedFromMask(map, extractMask(map, side));
      const ids = map.extracts.filter((_, i) => flags[i]).map((e) => e.id).sort();
      assert.deepEqual(ids, allowedExtracts(map, side).map((e) => e.id).sort());
      // Never your own side.
      map.extracts.forEach((e, i) => {
        if (e.side === side) assert.equal(flags[i], false);
      });
    }
  });
});

describe("WORLD v6 full map: closeAt from the state, personal arm, live boss only", () => {
  const close = WORLD.CYCLE_MS - WORLD.EXTRACT_EARLY_CLOSE_MS;
  const enteredAt = 20 * 60_000;
  const arm = enteredAt + WORLD.EXTRACT_ARM_MS;

  it("waits for the personal arm although the map opened every extract at 0", () => {
    const v = fullMapExtractView({}, { openAt: 0, closeAt: 0 }, arm, enteredAt + 60_000);
    assert.equal(v.status, "waiting");
    assert.equal(v.suffix, " · opens in 2:00");
    assert.equal(fullMapExtractView({}, { openAt: 0, closeAt: 0 }, arm, arm).status, "open");
    assert.equal(fullMapExtractView({}, { openAt: 0, closeAt: 0 }, arm, arm).suffix, "");
  });

  it("closes from the state's closeAt, not the map spot's closesAtMs", () => {
    const spot = { closesAtMs: 25 * 60_000 };
    const st = { openAt: 0, closeAt: close };
    // The legacy map time (25:00) has passed, the world close (40:00) has not.
    const v = fullMapExtractView(spot, st, 0, 30 * 60_000);
    assert.equal(v.status, "open");
    assert.equal(v.suffix, " · closes in 10:00");
    assert.equal(fullMapExtractView(spot, st, 0, close).status, "closed");
    // Unknown state: fall back to the spot.
    assert.equal(fullMapExtractView(spot, undefined, 0, 26 * 60_000).status, "closed");
  });

  it("marks only the live event boss spot (first spot of its kind)", () => {
    const bosses = [{ kind: "foreman" as const }, { kind: "commander" as const }, { kind: "foreman" as const }];
    const world = (bossKind: string, bossState: number) => ({ bossKind, bossState, entryCloseMs: WORLD.CYCLE_MS - WORLD.ENTRY_CLOSE_MS });
    assert.deepEqual(bossSpotsShown(bosses, world("foreman", 1)), [true, false, false]);
    assert.deepEqual(bossSpotsShown(bosses, world("foreman", 2)), [false, false, false], "killed: no skull");
    assert.deepEqual(bossSpotsShown(bosses, world("", 0)), [false, false, false], "no boss this map");
    assert.deepEqual(bossSpotsShown(bosses, { bossKind: "", bossState: 0, entryCloseMs: 0 }), [true, true, true], "legacy");
    assert.equal(bossSpotShown(bosses, 1, world("commander", 1)), true);
    assert.equal(liveBossTurf("commander", world("foreman", 1)), null);
    assert.equal(liveBossTurf("foreman", world("foreman", 1)), "foreman");
    assert.equal(liveBossTurf("foreman", null), "foreman");
  });

  it("every Steppe extract gets a view", () => {
    for (const e of map.extracts) assert.ok(fullMapExtractView(e, { openAt: 0, closeAt: 0 }, 0, 0).status === "open");
  });
});
