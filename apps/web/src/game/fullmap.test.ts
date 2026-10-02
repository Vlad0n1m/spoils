/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/fullmap.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { allowedExtracts, extractMask, generateMap, type MapSide, type Zone } from "@extract/shared";
import { TIER_COLORS, ZONE_KIND_LABEL, ZoneTracker, allowedFromMask, formatClock, toastAlpha, zoneSubtitle } from "./fullmap";

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
