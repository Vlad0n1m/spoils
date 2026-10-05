/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/own-shot.test.ts
 * Own-shot prediction (own-shot.ts): the client shows its shot on the input that fires it, with
 * the server's rules, and swallows exactly that many echoes.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { INPUT_DT_MS, WEAPONS } from "@extract/shared";
import { OWN_SHOT_ECHO_WINDOW_MS, OwnShotPredictor, predictedAngles, type OwnShotInput } from "./own-shot";

const pistol = WEAPONS.pistol;
const auto = Object.values(WEAPONS).find((w) => w.auto)!;
const base = (over: Partial<OwnShotInput>): OwnShotInput => ({
  now: 1000,
  fire: true,
  prevFire: false,
  def: pistol,
  mag: 12,
  reloading: false,
  rolling: false,
  ...over,
});

describe("OwnShotPredictor", () => {
  it("fires a semi-auto weapon on a press, not while it is held", () => {
    const p = new OwnShotPredictor();
    assert.equal(p.tryFire(base({})), true);
    assert.equal(p.tryFire(base({ now: 1000 + pistol.fireIntervalMs + 1, prevFire: true })), false);
  });

  it("never fires faster than the fire interval", () => {
    const p = new OwnShotPredictor();
    assert.equal(p.tryFire(base({})), true);
    assert.equal(p.tryFire(base({ now: 1000 + pistol.fireIntervalMs - 1 })), false);
    assert.equal(p.tryFire(base({ now: 1000 + pistol.fireIntervalMs })), true);
  });

  it("does not fire while reloading, rolling, without a weapon or with the rounds already spent", () => {
    assert.equal(new OwnShotPredictor().tryFire(base({ reloading: true })), false);
    assert.equal(new OwnShotPredictor().tryFire(base({ rolling: true })), false);
    assert.equal(new OwnShotPredictor().tryFire(base({ def: null })), false);
    assert.equal(new OwnShotPredictor().tryFire(base({ mag: 0 })), false);
    // One round left in the last patch, one predicted shot still waiting for its echo: empty.
    const p = new OwnShotPredictor();
    assert.equal(p.tryFire(base({ mag: 1 })), true);
    assert.ok(pistol.fireIntervalMs < OWN_SHOT_ECHO_WINDOW_MS);
    assert.equal(p.tryFire(base({ mag: 1, now: 1000 + pistol.fireIntervalMs })), false);
  });

  it("keeps an automatic weapon's held rate at the interval, whatever the sample cadence", () => {
    const p = new OwnShotPredictor();
    let shots = 0;
    const steps = 300;
    for (let i = 0; i < steps; i++) {
      const now = 1000 + i * INPUT_DT_MS;
      if (p.tryFire(base({ now, def: auto, mag: 255, prevFire: i > 0 }))) shots++;
      p.consumeEcho(now);
    }
    const expected = (steps * INPUT_DT_MS) / auto.fireIntervalMs;
    assert.ok(Math.abs(shots - expected) <= 1.5, `${shots} shots, expected ~${expected}`);
  });

  it("swallows one echo per predicted shot, and none after the window", () => {
    const p = new OwnShotPredictor();
    p.tryFire(base({}));
    assert.equal(p.pendingCount, 1);
    assert.equal(p.consumeEcho(1080), true);
    assert.equal(p.consumeEcho(1090), false, "an unpredicted echo is drawn as before");
    p.tryFire(base({ now: 3000 }));
    assert.equal(p.consumeEcho(3000 + OWN_SHOT_ECHO_WINDOW_MS + 1), false, "a lost prediction expires");
  });

  it("reset drops everything pending", () => {
    const p = new OwnShotPredictor();
    p.tryFire(base({}));
    p.reset();
    assert.equal(p.consumeEcho(1010), false);
    assert.equal(p.tryFire(base({ now: 1001 })), true, "and the interval starts over");
  });
});

describe("predictedAngles", () => {
  it("rolls one angle per pellet within the weapon's spread", () => {
    const shotgun = Object.values(WEAPONS).find((w) => w.pellets > 1) ?? pistol;
    const a = predictedAngles(1, shotgun);
    assert.equal(a.length, shotgun.pellets);
    for (const x of a) assert.ok(Math.abs(x - 1) <= shotgun.spread + 1e-9);
  });
});
