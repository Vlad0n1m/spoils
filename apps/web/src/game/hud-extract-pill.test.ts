/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/hud-extract-pill.test.ts
 * HUD v3 extract pill (components/hud.tsx reads this slice): which state it shows and what it says.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HudSelf, HudSnapshot } from "./types";
import { extractPillSlice } from "./hud";

function snap(extra: Partial<HudSnapshot> = {}): HudSnapshot {
  return {
    phase: "open", clockMs: 100_000, durationMs: 600_000, extractOpenAtMs: 0, wipeWarn: 0, boss: null, enteredAtMs: 0, self: null,
    aliveCount: 1, totalPlayers: 1, nearestExtract: null, extracts: [], interactHint: null, killFeed: [], pingMs: null, ...extra,
  };
}

const target = { dx: 0, dy: 40 * 336, dist: 40 * 336, open: true };
const highway = { id: "e1", name: "Highway West", dx: 0, dy: 40 * 336, dist: 40 * 336, open: true };

describe("extract pill", () => {
  it("closed: counts down to this player's arm", () => {
    const p = extractPillSlice(snap({ phase: "drop", extractOpenAtMs: 100_000 + 133_000 }));
    assert.equal(p.kind, "closed");
    assert.equal(p.countdown, "2:13");
  });

  it("open: the route to the nearest allowed extract (name, metres, arrow)", () => {
    const p = extractPillSlice(snap({ nearestExtract: target, extracts: [highway] }));
    assert.equal(p.kind, "open");
    assert.equal(p.name, "Highway West");
    assert.equal(p.meters, 336);
    assert.equal(p.deg, 90, "straight down the screen");
    assert.equal(p.targetOpen, true);
  });

  it("extracting wins over the phase and carries the channel for the fill", () => {
    const self = { extracting: { startedAtMs: 95_800, channelMs: 10_000 } } as unknown as HudSelf;
    const p = extractPillSlice(snap({ phase: "drop", self, extractOpenAtMs: 200_000 }));
    assert.equal(p.kind, "extracting");
    assert.equal(p.countdown, "");
    assert.equal(p.startedAtMs, 95_800);
    assert.equal(p.channelMs, 10_000);
  });

  it("hidden once the map is wiped", () => {
    assert.equal(extractPillSlice(snap({ phase: "ended" })).kind, "none");
  });
});
