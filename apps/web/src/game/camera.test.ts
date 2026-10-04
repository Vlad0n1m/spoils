/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/camera.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CameraRig,
  KICK,
  LOOK,
  MOTION_KEY,
  RECOIL_PX,
  SHAKE,
  approach,
  closeShotShake,
  createCameraSystem,
  explosionShake,
  getCameraRig,
  hitShake,
  lookAheadTarget,
  readReducedMotion,
} from "./camera";

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

describe("approach", () => {
  it("moves 63% of the way in one time constant and snaps when done", () => {
    near(approach(0, 100, 120, 120), 100 * (1 - Math.exp(-1)), 1e-9);
    assert.equal(approach(5, 5, 16, 100), 5);
    assert.equal(approach(0, 10, 16, 0), 10, "tau 0 = jump");
    assert.equal(approach(0, 10, -5, 100), 0, "negative dt does nothing");
  });
});

describe("lookAheadTarget", () => {
  const out = { x: 0, y: 0 };
  it("is zero with the cursor on the screen centre", () => {
    lookAheadTarget(800, 450, 1600, 900, 1, out);
    assert.deepEqual(out, { x: 0, y: 0 });
  });
  it("points at the cursor with a quarter of its distance", () => {
    lookAheadTarget(800 + 400, 450, 1600, 900, 1, out);
    near(out.x, 100);
    near(out.y, 0);
    lookAheadTarget(800, 450 - 200, 1600, 900, 2, out);
    near(out.x, 0);
    near(out.y, -25, 1e-9); // 200 screen px at zoom 2 = 100 world px → 25
  });
  it("caps at MAX_PX", () => {
    lookAheadTarget(800 + 3000, 450 + 3000, 1600, 900, 1, out);
    near(Math.hypot(out.x, out.y), LOOK.MAX_PX, 1e-9);
    assert.ok(out.x > 0 && out.y > 0);
  });
});

describe("shake amplitudes", () => {
  it("close shots fall off to zero at the radius, louder guns shake more", () => {
    assert.equal(closeShotShake("rifle", SHAKE.CLOSE_SHOT_PX), 0);
    assert.equal(closeShotShake("rifle", 5000), 0);
    near(closeShotShake("sniper", 0), SHAKE.CLOSE_SHOT_AMP.sniper);
    assert.ok(closeShotShake("shotgun", 100) > closeShotShake("pistol", 100));
    assert.ok(closeShotShake("rifle", 100) > closeShotShake("rifle", 300));
    assert.ok(closeShotShake("unknown", 0) > 0, "unknown weapons fall back to the pistol");
  });
  it("hit shake is clamped and zero without damage", () => {
    assert.equal(hitShake(0), 0);
    assert.equal(hitShake(1), SHAKE.HIT_MIN);
    assert.equal(hitShake(500), SHAKE.HIT_MAX);
  });
  it("explosion shake decays with distance and never exceeds the max", () => {
    assert.equal(explosionShake(0, 0), 0);
    assert.equal(explosionShake(5, 5 * SHAKE.RADIUS_PER_POWER), 0);
    assert.ok(explosionShake(5, 100) > explosionShake(5, 300));
    assert.ok(explosionShake(100, 0) <= SHAKE.MAX);
  });
});

describe("readReducedMotion", () => {
  const store = (v: string | null) => ({ getItem: (k: string) => (k === MOTION_KEY ? v : null) });
  it("prefers a stored override over the OS query", () => {
    assert.equal(readReducedMotion(store("reduce"), { matches: false }), true);
    assert.equal(readReducedMotion(store("full"), { matches: true }), false);
    assert.equal(readReducedMotion(store(null), { matches: true }), true);
    assert.equal(readReducedMotion(null, null), false);
  });
  it("survives a throwing storage", () => {
    const bad = { getItem: () => { throw new Error("blocked"); } };
    assert.equal(readReducedMotion(bad, { matches: true }), true);
  });
});

describe("CameraRig", () => {
  const run = (rig: CameraRig, ms: number) => {
    for (let t = 0; t < ms; t += 16) rig.update(16);
  };

  it("kicks against the aim and is back within ~150 ms", () => {
    const rig = new CameraRig();
    rig.kick(0, RECOIL_PX.shotgun);
    rig.update(0);
    near(rig.shakeX, -RECOIL_PX.shotgun);
    near(rig.shakeY, 0);
    run(rig, 160);
    assert.ok(Math.abs(rig.shakeX) < 0.5, `recovered: ${rig.shakeX}`);
  });

  it("caps stacked kicks (full-auto) at KICK.MAX_PX", () => {
    const rig = new CameraRig();
    for (let i = 0; i < 20; i++) rig.kick(Math.PI / 2, RECOIL_PX.rifle);
    rig.update(0);
    assert.ok(Math.hypot(rig.shakeX, rig.shakeY) <= KICK.MAX_PX + 1e-9);
    assert.ok(rig.shakeY < 0, "aiming down kicks the view up");
  });

  it("eases the look-ahead and adds the focus pan to the offset", () => {
    const rig = new CameraRig();
    rig.setLook(100, 0);
    rig.update(60);
    near(rig.offX, 100 * (1 - Math.exp(-60 / LOOK.TAU_MS)), 1e-6);
    run(rig, 1500);
    near(rig.offX, 100, 1e-3);
    rig.focusTo(0, 50, 100);
    run(rig, 1500);
    near(rig.offY, 50, 1e-3);
    rig.clearFocus(100);
    run(rig, 1500);
    near(rig.offY, 0, 1e-3);
  });

  it("zooms from a snapped start toward the target", () => {
    const rig = new CameraRig();
    rig.snapZoom(0.86);
    rig.zoomTo(1, 420);
    rig.update(16);
    assert.ok(rig.zoomMul > 0.86 && rig.zoomMul < 1);
    run(rig, 4000);
    near(rig.zoomMul, 1, 1e-3);
  });

  it("does nothing showy under reduced motion", () => {
    const rig = new CameraRig();
    rig.reduced = true;
    rig.kick(0, 10);
    rig.shake(8);
    rig.snapZoom(0.5);
    rig.zoomTo(1.3, 100);
    rig.focusTo(300, 300, 100);
    rig.setLook(100, 0);
    run(rig, 2000);
    assert.equal(rig.shakeX, 0);
    assert.equal(rig.shakeY, 0);
    assert.equal(rig.shakeScale, 0, "the legacy Effects shake is muted too");
    assert.equal(rig.zoomMul, 1);
    near(rig.offX, 100 * LOOK.REDUCED, 1e-3);
    near(rig.offY, 0, 1e-3);
  });

  it("shake decays to zero", () => {
    const rig = new CameraRig();
    rig.shake(6);
    rig.update(16);
    assert.ok(rig.shakeScale === 1);
    run(rig, 800);
    assert.equal(rig.shakeX, 0);
    assert.equal(rig.shakeY, 0);
  });
});

describe("kill punch and reduce screen shake", () => {
  it("a punch pushes the zoom in about 3% and settles back", () => {
    const rig = new CameraRig();
    rig.update(16);
    rig.punch();
    let peak = 1;
    for (let i = 0; i < 10; i++) {
      rig.update(10);
      peak = Math.max(peak, rig.zoomMul);
    }
    assert.ok(peak > 1.02 && peak <= 1.031, `peak ${peak}`);
    for (let t = 0; t < 1000; t += 16) rig.update(16);
    assert.equal(rig.zoomMul, 1);
  });

  it("noShake drops shake and punch and softens the kick", () => {
    const rig = new CameraRig();
    rig.noShake = true;
    rig.shake(8);
    rig.punch();
    rig.kick(0, 10);
    rig.update(1);
    assert.equal(rig.shakeScale, 0);
    assert.equal(rig.zoomMul, 1);
    // Only the kick remains: straight back along -x, at REDUCED_SHAKE_KICK.
    assert.ok(rig.shakeX < -3 && rig.shakeX > -3.6, `kick ${rig.shakeX}`);
    assert.equal(rig.shakeY, 0);
  });

  it("reduced motion also skips the punch", () => {
    const rig = new CameraRig();
    rig.reduced = true;
    rig.punch();
    rig.update(50);
    assert.equal(rig.zoomMul, 1);
  });
});

describe("camera system", () => {
  it("exposes no rig before init and is safe to dispose twice", () => {
    const s = createCameraSystem();
    assert.equal(s.id, "camera");
    assert.equal(getCameraRig(), null);
    s.dispose();
    s.dispose();
  });
});
