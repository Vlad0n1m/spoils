/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/components/audio-settings.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS, sanitizeSettings } from "../game/audio/settings";
import { TOGGLE_ROWS, VOLUME_ROWS, speakerLevel, toPercent } from "./audio-settings";

describe("audio settings popover", () => {
  it("has a row for every volume and toggle in the settings store", () => {
    const keys = Object.keys(DEFAULT_SETTINGS).sort();
    const rows = [...VOLUME_ROWS.map((r) => r.key), ...TOGGLE_ROWS.map((r) => r.key)].sort();
    assert.deepEqual(rows, keys);
  });

  it("formats slider values as whole percent, clamped", () => {
    assert.equal(toPercent(0.804), 80);
    assert.equal(toPercent(1.5), 100);
    assert.equal(toPercent(-1), 0);
    assert.equal(toPercent(Number.NaN), 0);
  });

  it("speaker glyph follows mute and master", () => {
    assert.equal(speakerLevel({ muted: true, master: 1 }), "muted");
    assert.equal(speakerLevel({ muted: false, master: 0 }), "muted");
    assert.equal(speakerLevel({ muted: false, master: 0.3 }), "low");
    assert.equal(speakerLevel({ muted: false, master: 0.8 }), "high");
  });

  it("reduceFlashes survives storage round-trips and defaults off", () => {
    assert.equal(DEFAULT_SETTINGS.reduceFlashes, false);
    assert.equal(sanitizeSettings({ reduceFlashes: true }).reduceFlashes, true);
    assert.equal(sanitizeSettings({ reduceFlashes: "yes" }).reduceFlashes, false);
    assert.equal(sanitizeSettings(null).reduceFlashes, false);
  });
});
