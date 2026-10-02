/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/sound-viz.test.ts
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { Container } from "pixi.js";
import {
  SOUND_VIZ,
  SoundKind,
  decodeSoundMsg,
  pushHiddenSound,
  pushVisibleSound,
  quantizeSound,
  sectorAngle,
  type EventsMsg,
  type SoundMsg,
} from "@extract/shared";
import { resetSettingsCache, updateSettings } from "./audio/settings";
import {
  RING,
  SoundIndicators,
  bandOfDistance,
  chevronAlpha,
  chevronPulse,
  indicatorStyle,
  placeSounds,
  ringRadius,
  type PlacementEnv,
  type RingInput,
} from "./sound-ring";
import { SoundVizSystem } from "./sound-viz";
import type { GameContext } from "./systems";

const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

/** Listener at the origin aiming +x (east); screen = ±800 × ±450 world px around it. */
function env(players: Record<string, { x: number; y: number }> = {}, aim = 0): PlacementEnv {
  return {
    selfId: "me",
    selfX: 0,
    selfY: 0,
    aim,
    playerPos: (id) => players[id] ?? null,
    onScreen: (x, y) => Math.abs(x) <= 800 && Math.abs(y) <= 450,
  };
}

function input(kind: SoundKind, sector: number, band: 0 | 1 | 2 = 1, occluded = false): RingInput {
  const [m] = placeSounds(decodeSoundMsg({ h: [kind, sector, band | (occluded ? 4 : 0), 0] }), env());
  return m!;
}

describe("placeSounds: decode → marker placement", () => {
  it("puts a hidden source at its sector centre with band and occlusion", () => {
    const msg: SoundMsg = {};
    // A step 500 px south (screen down) behind a wall, heard from the origin.
    const heard = quantizeSound(0, 0, 0, 500, 800, true)!;
    pushHiddenSound(msg, SoundKind.step, heard, 2);
    const [m] = placeSounds(decodeSoundMsg(msg), env());
    assert.ok(m);
    assert.equal(m.kind, SoundKind.step);
    assert.equal(heard.a, 4, "south = sector 4 of 16");
    assert.ok(near(m.angle, sectorAngle(4)) && near(m.angle, Math.PI / 2));
    assert.equal(m.band, heard.b);
    assert.equal(m.occluded, true);
    assert.equal(m.id, null);
    assert.equal(m.key, "steps:s4");
  });

  it("aims a visible source at its exact direction, skipping own, unknown and plainly seen ones", () => {
    const msg: SoundMsg = {};
    pushVisibleSound(msg, SoundKind.shot, "me", 0); // own sound
    pushVisibleSound(msg, SoundKind.shot, "ghost", 0); // not in state.players
    pushVisibleSound(msg, SoundKind.shot, "front", 0); // on screen, in the cone → you see it
    pushVisibleSound(msg, SoundKind.reload, "back", 0); // on screen but behind you
    pushVisibleSound(msg, SoundKind.shot, "far", 0); // ahead but off screen
    const players = { front: { x: 300, y: 50 }, back: { x: -200, y: 0 }, far: { x: 1200, y: 600 } };
    const out = placeSounds(decodeSoundMsg(msg), env(players));
    assert.deepEqual(out.map((m) => m.id), ["back", "far"]);
    const back = out[0]!, far = out[1]!;
    assert.ok(near(Math.abs(back.angle), Math.PI));
    assert.ok(near(far.angle, Math.atan2(600, 1200)));
    assert.equal(far.key, "burst:far");
    assert.equal(back.key, "mag:back");
    // 200 px from a 500 px reload → 0.4 → middle band.
    assert.equal(back.band, 1);
  });

  it("bands visible sources like quantizeSound does", () => {
    assert.equal(bandOfDistance(100, 1000), 0);
    assert.equal(bandOfDistance(500, 1000), 1);
    assert.equal(bandOfDistance(900, 1000), 2);
    assert.equal(bandOfDistance(5000, 1000), 2, "beyond the radius clamps to far");
    assert.equal(bandOfDistance(10, 0), 2);
  });

  it("ignores malformed payloads", () => {
    assert.deepEqual(placeSounds(decodeSoundMsg({ h: [99, 0, 0, 0, SoundKind.step, 1.5, 0, 0], v: [SoundKind.shot, 7, 0] }), env()), []);
  });
});

describe("behind detection", () => {
  it("flags markers outside the 180° forward cone and thickens them", () => {
    const now = 1000;
    const ind = new SoundIndicators();
    const m = ind.push(input(SoundKind.step, 8, 0), now); // west
    const facingEast = indicatorStyle(m, now + 200, 0)!;
    const facingWest = indicatorStyle(m, now + 200, Math.PI)!;
    assert.equal(facingEast.behind, true);
    assert.equal(facingWest.behind, false);
    assert.ok(near(facingEast.width, RING.BAND_WIDTH[0] * RING.BEHIND_WIDTH_MULT));
    assert.equal(facingWest.width, RING.BAND_WIDTH[0]);
    // Just past the side (sector 5 = 112.5° from east) is behind; sector 3 (67.5°) is not.
    assert.equal(indicatorStyle(ind.push(input(SoundKind.shot, 5), now), now, 0)!.behind, true);
    assert.equal(indicatorStyle(ind.push(input(SoundKind.shot, 3), now), now, 0)!.behind, false);
  });

  it("chevron pulse stays within a visible range", () => {
    for (let t = 0; t < 1000; t += 37) {
      const p = chevronPulse(t);
      assert.ok(p >= 0.55 - 1e-9 && p <= 1 + 1e-9);
    }
  });
});

describe("merging", () => {
  it("repeated footsteps in one sector pulse one marker with the stronger band", () => {
    const ind = new SoundIndicators();
    ind.push(input(SoundKind.step, 2, 2, true), 0);
    const m = ind.push(input(SoundKind.step, 2, 0, false), 300);
    ind.push(input(SoundKind.stepBush, 2, 1, true), 500);
    assert.equal(ind.list.length, 1);
    assert.equal(m.band, 0, "keeps the stronger band");
    assert.equal(m.occluded, false, "a clear reading wins over a muffled one");
    assert.equal(m.born, 500, "timer restarted");
    assert.equal(m.kind, SoundKind.stepBush, "takes the newest kind (color)");
    assert.equal(m.color, SOUND_VIZ[SoundKind.stepBush].color);
    assert.equal(indicatorStyle(m, 500, 0)!.scale, RING.POP_SCALE, "re-pops on merge");
  });

  it("does not merge across sectors, glyphs or sources; an expired marker resets the band", () => {
    const ind = new SoundIndicators();
    ind.push(input(SoundKind.step, 2), 0);
    ind.push(input(SoundKind.step, 3), 0);
    ind.push(input(SoundKind.shot, 2), 0);
    assert.equal(ind.list.length, 3);
    const m = ind.push(input(SoundKind.step, 2, 0), 10);
    // Long after it faded the new reading replaces the band instead of keeping "near".
    ind.push(input(SoundKind.step, 2, 2), 10 + SOUND_VIZ[SoundKind.step].lifeMs + 5);
    assert.equal(m.band, 2);
  });
});

describe("fade and cap", () => {
  it("pops in, fades as (1 − t)^1.5 and expires at the kind's life", () => {
    const ind = new SoundIndicators();
    const m = ind.push(input(SoundKind.shot, 0, 0), 0);
    const life = SOUND_VIZ[SoundKind.shot].lifeMs;
    assert.equal(indicatorStyle(m, 0, 0)!.scale, RING.POP_SCALE);
    assert.equal(indicatorStyle(m, RING.POP_MS, 0)!.scale, 1);
    assert.equal(indicatorStyle(m, 0, 0)!.alpha, 1);
    assert.ok(near(indicatorStyle(m, life / 2, 0)!.alpha, Math.pow(0.5, 1.5)));
    assert.equal(indicatorStyle(m, life, 0), null);
    assert.equal(ind.prune(life - 1), 1);
    assert.equal(ind.prune(life), 0);
  });

  it("far and muffled markers are dimmer", () => {
    const ind = new SoundIndicators();
    const nearM = indicatorStyle(ind.push(input(SoundKind.step, 0, 0), 0), 100, 0)!;
    const farM = indicatorStyle(ind.push(input(SoundKind.step, 1, 2), 0), 100, 0)!;
    const muffled = indicatorStyle(ind.push(input(SoundKind.step, 2, 0, true), 0), 100, 0)!;
    assert.ok(farM.alpha < nearM.alpha && farM.width < nearM.width);
    assert.ok(near(muffled.alpha, nearM.alpha * RING.OCCLUDED_ALPHA));
    // Icons say WHAT was heard: floored so a far, muffled shot is still legible.
    const farMuffled = indicatorStyle(ind.push(input(SoundKind.shot, 3, 2, true), 0), 100, 0)!;
    assert.ok(farMuffled.iconAlpha >= RING.ICON_MIN_ALPHA * 0.9 && farMuffled.iconAlpha > farMuffled.alpha * 2);
    assert.ok(nearM.iconAlpha <= 1 && nearM.iconAlpha >= nearM.alpha);
  });

  it("the behind-you chevron pulses only right after a trigger", () => {
    assert.equal(chevronAlpha(0), 1);
    assert.ok(chevronAlpha(RING.CHEVRON_PERIOD_MS / 2) < 0.6);
    assert.equal(chevronAlpha(RING.CHEVRON_PULSE_MS), 1);
    assert.equal(chevronAlpha(5_000), 1);
  });

  it("caps markers, evicting the least important first", () => {
    const ind = new SoundIndicators();
    for (let s = 0; s < 16; s++) ind.push(input(SoundKind.step, s), s);
    assert.equal(ind.list.length, RING.MAX_MARKERS);
    ind.push(input(SoundKind.shot, 0), 100);
    assert.equal(ind.list.length, RING.MAX_MARKERS);
    assert.ok(ind.list.some((m) => m.kind === SoundKind.shot), "a gunshot always gets in");

    const shots = new SoundIndicators(4);
    for (let s = 0; s < 4; s++) shots.push(input(SoundKind.shot, s), 0);
    shots.push(input(SoundKind.step, 9), 10);
    assert.ok(shots.list.every((m) => m.kind === SoundKind.shot), "a footstep never pushes out a gunshot");
    // Equal priority: the one closest to fading goes.
    shots.push(input(SoundKind.shot, 9), 20);
    assert.equal(shots.list.length, 4);
    assert.ok(shots.list.some((m) => m.key === "burst:s9"));
  });

  it("ring radius follows the screen within bounds", () => {
    assert.equal(ringRadius(1600, 900), 162);
    assert.equal(ringRadius(375, 812), RING.RADIUS_MIN);
    assert.equal(ringRadius(3840, 2160), RING.RADIUS_MAX);
  });
});

describe("SoundVizSystem", () => {
  afterEach(() => {
    updateSettings({ visualize: true });
    resetSettingsCache();
  });

  function fakeCtx(players: Record<string, { x: number; y: number }> = {}): GameContext {
    const screen = new Container();
    const map = new Map(Object.entries(players));
    return {
      room: { sessionId: "me" },
      layers: { ground: new Container(), worldFx: new Container(), worldTop: new Container(), screen },
      state: () => ({ players: map }),
      selfPos: () => ({ x: 0, y: 0 }),
      aim: () => 0,
      camera: () => ({ x: 0, y: 0, zoom: 1, width: 1600, height: 900 }),
      toScreen: (x: number, y: number) => ({ x: 800 + x, y: 450 + y }),
    } as unknown as GameContext;
  }

  const ev = (snd: SoundMsg): EventsMsg => ({ snd });

  it("draws markers from ev.snd around the player and hides them once faded", () => {
    const sys = new SoundVizSystem();
    const ctx = fakeCtx({ enemy: { x: -300, y: 0 } });
    sys.init(ctx);
    const root = ctx.layers.screen.children[0] as Container;
    sys.onEvents(ev({ h: [SoundKind.step, 8, 0, 0, SoundKind.shot, 4, 1 | 4, 0], v: [SoundKind.reload, "enemy", 0] }), ctx);
    assert.equal(sys.model.list.length, 3);
    sys.frame(16, ctx);
    assert.equal(sys.shownMarkers, 3);
    assert.equal(root.visible, true);
    assert.equal(root.position.x, 800);
    assert.equal(root.position.y, 450);
    // Fake the passage of time by ageing every marker past its life.
    for (const m of sys.model.list) m.born -= 10_000;
    sys.frame(16, ctx);
    assert.equal(sys.shownMarkers, 0);
    assert.equal(root.visible, false);
    sys.dispose();
    sys.dispose();
  });

  it("respects the 'visualize' setting", () => {
    const sys = new SoundVizSystem();
    const ctx = fakeCtx();
    sys.init(ctx);
    sys.onEvents(ev({ h: [SoundKind.step, 0, 0, 0] }), ctx);
    assert.equal(sys.model.list.length, 1);
    updateSettings({ visualize: false });
    assert.equal(sys.model.list.length, 0, "turning it off clears the ring");
    sys.onEvents(ev({ h: [SoundKind.step, 0, 0, 0] }), ctx);
    sys.frame(16, ctx);
    assert.equal(sys.model.list.length, 0);
    assert.equal(sys.shownMarkers, 0);
    updateSettings({ visualize: true });
    sys.onEvents(ev({ h: [SoundKind.step, 0, 0, 0] }), ctx);
    assert.equal(sys.model.list.length, 1);
    sys.dispose();
  });
});
