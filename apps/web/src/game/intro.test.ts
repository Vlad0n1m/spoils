/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/intro.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MATCH, WORLD, type MapData, type Zone } from "@extract/shared";
import {
  INTRO,
  createIntroSystem,
  extractsLine,
  firstExtractOpenAt,
  formatCountdown,
  isFreshEntry,
  wipeLine,
  formatTod,
  spawnPlace,
  titleCardPose,
  titleCardText,
} from "./intro";

const zone = (id: string, name: string, x: number, y: number, w: number, h: number): Zone => ({
  id,
  name,
  kind: "village",
  tier: 2,
  rect: { x, y, w, h },
});
const MAP = { zones: [zone("a", "Dawnfield", 1000, 1000, 2000, 2000), zone("b", "Rail Yard", 8000, 8000, 1000, 1000)] } as Pick<MapData, "zones">;

describe("formatting", () => {
  it("formats the in-game time with wrap-around", () => {
    assert.equal(formatTod(0), "00:00");
    assert.equal(formatTod(21 * 60 + 40), "21:40");
    assert.equal(formatTod(1440 + 65), "01:05");
    assert.equal(formatTod(-10), "23:50");
    assert.equal(formatTod(600.9), "10:00");
  });
  it("formats the countdown, ceiling to whole seconds", () => {
    assert.equal(formatCountdown(180_000), "3:00");
    assert.equal(formatCountdown(179_001), "3:00");
    assert.equal(formatCountdown(61_000), "1:01");
    assert.equal(formatCountdown(-5), "0:00");
  });
  it("switches the extract line once they are open", () => {
    assert.equal(extractsLine(MATCH.EXTRACT_OPEN_AT_MS), "Extracts open in 3:00");
    assert.equal(extractsLine(0), "Extracts open");
  });
});

describe("spawnPlace", () => {
  it("names the zone the player stands in", () => {
    assert.deepEqual(spawnPlace(MAP, 1500, 1500, 0).name, "Dawnfield");
  });
  it("says 'Outskirts of' near a zone", () => {
    const p = spawnPlace(MAP, 3500, 2000, 0);
    assert.equal(p.name, "Outskirts of Dawnfield");
    assert.equal(p.zone?.id, "a");
  });
  it("falls back to the map edge of the spawn side", () => {
    assert.equal(spawnPlace(MAP, 20000, 100, 0).name, "North wilds");
    assert.equal(spawnPlace(MAP, 20000, 100, 3).name, "West wilds");
    assert.equal(spawnPlace(MAP, 20000, 100, null).name, "The wilds");
    assert.equal(spawnPlace(MAP, 20000, 100, 9).zone, null);
  });
});

describe("firstExtractOpenAt", () => {
  const ext = new Map([
    ["N1", { openAt: 200_000 }],
    ["E1", { openAt: 150_000 }],
    ["S1", { openAt: 300_000 }],
  ]);
  const map = { extracts: [{ id: "N1" }, { id: "E1" }, { id: "S1" }] } as unknown as Pick<MapData, "extracts">;
  it("only counts the extracts this player may use", () => {
    assert.equal(firstExtractOpenAt(map, ext, 0b101), 200_000);
    assert.equal(firstExtractOpenAt(map, ext, 0b010), 150_000);
  });
  it("uses every extract without a mask, the rule time without extracts", () => {
    assert.equal(firstExtractOpenAt(map, ext, 0), 150_000);
    assert.equal(firstExtractOpenAt(null, new Map(), 0), MATCH.EXTRACT_OPEN_AT_MS);
  });
  it("WORLD v6: never before the player's own arm (extractOpenAtFor)", () => {
    const world = new Map([["N1", { openAt: 0 }], ["E1", { openAt: 0 }], ["S1", { openAt: 0 }]]);
    // Entered at 20:00 → armed at 23:00, although the map's extracts are open since 0.
    assert.equal(firstExtractOpenAt(map, world, 0b011, 20 * 60_000 + WORLD.EXTRACT_ARM_MS), 23 * 60_000);
    assert.equal(firstExtractOpenAt(map, world, 0b011, 0), 0);
    // A later map-level openAt still wins over an earlier arm.
    assert.equal(firstExtractOpenAt(map, ext, 0b101, 60_000), 200_000);
  });
});

describe("WORLD v6 lines", () => {
  it("counts down to the wipe", () => {
    assert.equal(wipeLine(31 * 60_000 + 12_000), "Wipe in 31:12");
    assert.equal(wipeLine(0), "Wiping");
  });
  it("fresh drop-in vs reconnect by the entry's own start", () => {
    const enteredAt = 20 * 60_000;
    assert.equal(isFreshEntry(enteredAt + 1_000, enteredAt), true);
    assert.equal(isFreshEntry(enteredAt + INTRO.FRESH_ENTRY_MS, enteredAt), false);
    // A drop-in at minute 20 is fresh even though the map clock is far past REJOIN_AFTER_MS.
    assert.equal(titleCardText({ mapId: "steppe", place: "x", todMin: 600, weather: "fog", clockMs: enteredAt + 800, enteredAtMs: enteredAt }).kicker, "DEPLOYING");
    // A reload two minutes into the entry is a rejoin, even early in the map.
    assert.equal(titleCardText({ mapId: "steppe", place: "x", todMin: 600, weather: "fog", clockMs: 150_000, enteredAtMs: 30_000 }).kicker, "BACK IN THE RAID");
    // Legacy (no enteredAt): the raid clock decides.
    assert.equal(isFreshEntry(5_000), true);
    assert.equal(isFreshEntry(INTRO.REJOIN_AFTER_MS + 1), false);
  });
});

describe("titleCardText", () => {
  it("builds the card lines", () => {
    const c = titleCardText({ mapId: "steppe", place: "Dawnfield", todMin: 21 * 60 + 40, weather: "rain" });
    assert.equal(c.kicker, "DEPLOYING");
    assert.equal(c.title, "Dawnfield");
    assert.equal(c.sub, "THE OUTSKIRTS · 21:40 · RAIN");
  });
  it("says it is a rejoin when the raid has been running for a while", () => {
    assert.equal(titleCardText({ mapId: "steppe", place: "x", todMin: 600, weather: "fog", clockMs: 5000 }).kicker, "DEPLOYING");
    assert.equal(titleCardText({ mapId: "steppe", place: "x", todMin: 600, weather: "fog", clockMs: INTRO.REJOIN_AFTER_MS + 1 }).kicker, "BACK IN THE RAID");
  });
  it("omits what it does not know", () => {
    assert.equal(titleCardText({ mapId: "nope", place: "x", todMin: null, weather: null }).sub, "UNKNOWN SECTOR");
    assert.equal(titleCardText({ mapId: "legacy", place: "x", todMin: 600, weather: "cloudy" }).sub, "PROVING GROUNDS · 10:00 · OVERCAST");
  });
});

describe("titleCardPose", () => {
  const out = { alpha: 0, slide: 0 };
  it("fades in, holds, fades out", () => {
    assert.equal(titleCardPose(-1, null, out).alpha, 0);
    assert.equal(titleCardPose(0, null, out).alpha, 0);
    assert.equal(titleCardPose(0, null, out).slide, INTRO.SLIDE_PX);
    assert.equal(titleCardPose(INTRO.IN_MS, null, out).alpha, 1);
    assert.equal(titleCardPose(INTRO.IN_MS, null, out).slide, 0);
    assert.equal(titleCardPose(INTRO.IN_MS + INTRO.HOLD_MS, null, out).alpha, 1);
    const mid = titleCardPose(INTRO.IN_MS + INTRO.HOLD_MS + INTRO.OUT_MS / 2, null, out).alpha;
    assert.ok(mid > 0.4 && mid < 0.6);
    assert.equal(titleCardPose(INTRO.IN_MS + INTRO.HOLD_MS + INTRO.OUT_MS, null, out).alpha, 0);
  });
  it("a skip fades it out quickly", () => {
    assert.equal(titleCardPose(1000, 1000, out).alpha, 1);
    const half = titleCardPose(1000 + INTRO.SKIP_OUT_MS / 2, 1000, out).alpha;
    assert.ok(Math.abs(half - 0.5) < 1e-9);
    assert.equal(titleCardPose(1000 + INTRO.SKIP_OUT_MS, 1000, out).alpha, 0);
  });
  it("writes into the given object (no allocation per frame)", () => {
    assert.equal(titleCardPose(100, null, out), out);
  });
});

describe("intro system", () => {
  it("constructs without a DOM and disposes twice", () => {
    const s = createIntroSystem();
    assert.equal(s.id, "intro");
    s.dispose();
    s.dispose();
  });
});
