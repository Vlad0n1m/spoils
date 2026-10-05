/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/char-anim.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { INPUT_DT_MS, PLAYER, ROLL } from "@extract/shared";
import {
  ANIM,
  CharAnimator,
  ROLL_MS,
  angleDelta,
  deathAlpha,
  deathFall,
  deathSkid,
  gaitAdvance,
  hitEnvelope,
  reloadCurve,
  rollSpin,
  rollTuck,
  swapHolster,
  type CharInput,
} from "./char-anim";

const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

function input(over: Partial<CharInput> = {}): CharInput {
  return { x: 0, y: 0, aim: 0, nowMs: 0, rolling: false, reloading: false, healing: false, walking: false, reduced: false, ...over };
}

describe("timing curves", () => {
  it("rolls once over exactly the server's roll length", () => {
    assert.equal(ROLL_MS, ROLL.TICKS * INPUT_DT_MS);
    assert.equal(rollSpin(0), 0);
    assert.ok(near(rollSpin(ROLL_MS / 2), Math.PI));
    assert.equal(rollSpin(ROLL_MS), 2 * Math.PI);
    assert.equal(rollSpin(ROLL_MS * 4), 2 * Math.PI);
    assert.equal(rollTuck(0), 1);
    assert.ok(near(rollTuck(ROLL_MS / 2), ANIM.ROLL_TUCK));
    assert.ok(near(rollTuck(ROLL_MS), 1));
  });

  it("advances the gait by distance, with shorter strides when walking quietly", () => {
    const run = gaitAdvance(0, ANIM.STRIDE_PX / 4, false);
    assert.ok(near(run, Math.PI / 2));
    assert.ok(gaitAdvance(0, ANIM.STRIDE_PX / 4, true) > run, "quiet steps are shorter → more phase per px");
    assert.ok(gaitAdvance(6, 1000, false) < 2 * Math.PI, "wrapped");
    assert.equal(gaitAdvance(1, -5, false), 1, "no backward phase");
  });

  it("reload dips in, drops the old mag, seats a new one and comes back", () => {
    const o = { tilt: 0, pull: 0, mag: 0 };
    reloadCurve(0, o);
    assert.equal(o.tilt, 0);
    assert.equal(o.mag, 0);
    reloadCurve(0.3, o);
    assert.ok(o.tilt < 0 && o.pull > 0, "dipped");
    assert.ok(o.mag < 0, "old mag dropping");
    reloadCurve(0.55, o);
    assert.ok(o.mag > 0 && o.mag < 1, "new mag sliding in");
    reloadCurve(1, o);
    assert.ok(near(o.tilt, 0) && near(o.pull, 0) && o.mag === 0, "back to aim");
  });

  it("draws a swapped weapon from the hip with an overshoot, then holds", () => {
    assert.ok(near(swapHolster(0), 1));
    assert.ok(swapHolster(ANIM.SWAP_MS * 0.85) < 0, "overshoot past the aim");
    assert.equal(swapHolster(ANIM.SWAP_MS), 0);
    assert.equal(swapHolster(Number.NEGATIVE_INFINITY), 0);
  });

  it("flinches fast and settles", () => {
    assert.equal(hitEnvelope(0), 0);
    assert.equal(hitEnvelope(30), 1);
    assert.equal(hitEnvelope(ANIM.HIT_MS), 0);
    assert.equal(hitEnvelope(Number.POSITIVE_INFINITY), 0);
  });

  it("falls, overshoots on impact, settles, then crossfades out", () => {
    assert.equal(deathFall(0), 0);
    let peak = 0;
    for (let t = 0; t <= ANIM.DEATH_MS; t += 5) peak = Math.max(peak, deathFall(t));
    assert.ok(peak > 1 && peak < 1.1);
    assert.ok(near(deathFall(ANIM.DEATH_MS), 1));
    assert.equal(deathAlpha(ANIM.DEATH_MS), 1);
    assert.equal(deathAlpha(ANIM.DEATH_MS + ANIM.DEATH_FADE_MS), 0);
    assert.ok(deathSkid(ANIM.DEATH_MS) <= ANIM.DEATH_SKID_PX + 1e-9);
  });

  it("angleDelta takes the short way round", () => {
    assert.ok(near(angleDelta(3, -3), 2 * Math.PI - 6));
    assert.ok(near(angleDelta(0, Math.PI / 2), Math.PI / 2));
  });
});

describe("CharAnimator", () => {
  it("breathes at idle and bobs while running", () => {
    const a = new CharAnimator();
    let maxIdle = 0;
    for (let t = 0; t < 3000; t += 16) maxIdle = Math.max(maxIdle, Math.abs(a.update(input({ nowMs: t })).sx - 1));
    assert.ok(maxIdle > 0 && maxIdle <= ANIM.BREATH + 1e-9, "idle: breathing only");
    const b = new CharAnimator();
    let maxRun = 0;
    let feet = 0;
    for (let t = 0, x = 0; t < 2000; t += 16, x += (PLAYER.SPEED * 16) / 1000) {
      const p = b.update(input({ nowMs: t, x }));
      maxRun = Math.max(maxRun, Math.abs(p.sx - 1));
      feet = Math.max(feet, Math.abs(p.footL));
    }
    assert.ok(maxRun > maxIdle * 1.5, "running bobs more than breathing");
    assert.ok(feet > ANIM.FOOT_STRIDE * 0.8, "boots step");
  });

  it("quiet walk steps lower than a run at the same speed", () => {
    const amp = (walking: boolean) => {
      const a = new CharAnimator();
      let m = 0;
      for (let t = 0, x = 0; t < 2000; t += 16, x += (PLAYER.SPEED * 0.5 * 16) / 1000) m = Math.max(m, a.update(input({ nowMs: t, x, walking })).sx);
      return m;
    };
    assert.ok(amp(true) < amp(false));
  });

  it("plays the roll from the flag edge and reduced motion drops the spin", () => {
    const run = (reduced: boolean) => {
      const a = new CharAnimator();
      a.update(input({ nowMs: 0 }));
      a.update(input({ nowMs: 16, rolling: true, reduced }));
      return a.update(input({ nowMs: 16 + ROLL_MS / 2, rolling: true, reduced }));
    };
    assert.ok(near(run(false).rot, Math.PI, 1e-6));
    assert.ok(Math.abs(run(true).rot) < 1e-6);
    assert.ok(run(true).sx < 1, "still tucks");
  });

  it("reload, heal and swap move only the gun; death drops it and fades the body", () => {
    const a = new CharAnimator();
    a.reloadMs = 1000;
    a.update(input({ nowMs: 0 }));
    for (let t = 16; t <= 400; t += 16) a.update(input({ nowMs: t, reloading: true }));
    assert.ok(a.pose.wRot < -0.2);
    const h = new CharAnimator();
    for (let t = 0; t <= 600; t += 16) h.update(input({ nowMs: t, healing: true }));
    assert.ok(h.pose.wRot > 0.5 && h.pose.heal > 0.9);
    const s = new CharAnimator();
    s.update(input({ nowMs: 0 }));
    s.swap(0);
    assert.ok(s.update(input({ nowMs: 16 })).wRot > 0.5, "starts holstered");
    const d = new CharAnimator();
    d.update(input({ nowMs: 0 }));
    d.hit(0, 1, 0);
    d.die(10, 0);
    assert.ok(d.dying && !d.deathDone(100));
    const mid = d.update(input({ nowMs: 10 + ANIM.DEATH_MS }));
    assert.ok(mid.wDropped && mid.sy < 1 && mid.dx > 0, "fell forward along the aim");
    assert.ok(d.deathDone(10 + ANIM.DEATH_MS + ANIM.DEATH_FADE_MS));
    assert.equal(d.update(input({ nowMs: 10 + ANIM.DEATH_MS + ANIM.DEATH_FADE_MS })).alpha, 0);
    d.revive();
    assert.equal(d.update(input({ nowMs: 2000 })).alpha, 1);
  });

  it("allocates nothing per frame (returns the same pose object)", () => {
    const a = new CharAnimator();
    const p = a.update(input({ nowMs: 0 }));
    assert.equal(a.update(input({ nowMs: 16, x: 4 })), p);
  });
});
