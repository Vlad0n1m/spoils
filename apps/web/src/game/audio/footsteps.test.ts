/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/audio/*.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  IDLE_RESET_MS,
  INDOOR_BIT,
  SELF_STEP_DB,
  STEP_EVERY_PX,
  Stride,
  TELEPORT_PX,
  WALK_STEP_DB,
  footstepLayers,
  isIndoorTerrain,
  materialFromVariant,
  materialOfTerrain,
  stepRangeMultOfTerrain,
  stepSoundId,
} from "./footsteps";
import { surfaceOf } from "@extract/shared";
import { SFX, STEP_MATERIALS, isSfxId } from "./recipes";

/** Simulate moving at `speed` px/s for `seconds` at 60 fps; returns step timestamps (ms). */
function walk(stride: Stride, speed: number, seconds: number, t0 = 0): number[] {
  const out: number[] = [];
  const dt = 1000 / 60;
  for (let t = t0; t < t0 + seconds * 1000; t += dt) if (stride.add((speed * dt) / 1000, t)) out.push(t);
  return out;
}

describe("Stride cadence", () => {
  it("fires one step per STEP_EVERY_PX at run speed (~2.2/s at 260 px/s)", () => {
    const steps = walk(new Stride(), 260, 10);
    // 2600 px travelled: the first step after half a stride, then one per stride.
    const expected = Math.floor((2600 - STEP_EVERY_PX / 2) / STEP_EVERY_PX) + 1;
    assert.ok(Math.abs(steps.length - expected) <= 1, `${steps.length} vs ${expected}`);
    const gaps = steps.slice(1).map((t, i) => t - steps[i]!);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    assert.ok(Math.abs(mean - (STEP_EVERY_PX / 260) * 1000) < 20, `mean gap ${mean}`);
  });

  it("walking (half speed) steps half as often", () => {
    const run = walk(new Stride(), 260, 6).length;
    const sneak = walk(new Stride(), 130, 6).length;
    assert.ok(Math.abs(sneak * 2 - run) <= 2, `${sneak} vs ${run}`);
  });

  it("first step after standing still comes after half a stride", () => {
    const s = new Stride();
    assert.equal(s.add(STEP_EVERY_PX / 2 - 1, 0), 0);
    assert.equal(s.add(2, 16), 1);
    // stand still, then move again: the half-stride head start applies again
    assert.equal(s.add(STEP_EVERY_PX / 2 + 1, 16 + IDLE_RESET_MS + 1), 1);
  });

  it("never bursts more than one step per frame on a hitch", () => {
    const s = new Stride();
    assert.equal(s.add(STEP_EVERY_PX * 3 - 1, 0), 1);
    assert.equal(s.add(1, 16), 0, "remainder is sub-stride, no queued backlog");
  });

  it("ignores teleports and non-movement", () => {
    const s = new Stride();
    assert.equal(s.add(TELEPORT_PX, 0), 0);
    assert.equal(s.add(0, 10), 0);
    assert.equal(s.add(-50, 20), 0);
    assert.equal(s.add(NaN, 30), 0);
  });

  it("alternates feet", () => {
    const s = new Stride();
    const feet: number[] = [];
    for (let i = 0; i < 4; i++) {
      s.add(STEP_EVERY_PX, i * 16);
      feet.push(s.foot);
    }
    assert.deepEqual(feet, [0, 1, 0, 1]);
  });

  it("reset restarts the cadence (roll)", () => {
    const s = new Stride();
    s.add(STEP_EVERY_PX - 1, 0);
    s.reset(5);
    assert.equal(s.add(10, 10), 0);
  });
});

describe("material selection", () => {
  it("maps every terrain code to a baked step sound", () => {
    for (let t = 0; t < 10; t++) {
      const id = stepSoundId(materialOfTerrain(t));
      assert.ok(isSfxId(id), `terrain ${t} → ${id}`);
    }
    assert.equal(materialOfTerrain(5), "wood");
    assert.equal(materialOfTerrain(7), "wood"); // bridge
    assert.equal(materialOfTerrain(9), "water"); // shallow ford
    assert.equal(materialOfTerrain(200 & ~INDOOR_BIT), materialOfTerrain(200)); // unknown → fallback
  });

  it("ignores the INDOOR bit for the material and reports it separately", () => {
    assert.equal(materialOfTerrain(4 | INDOOR_BIT), "concrete");
    assert.equal(isIndoorTerrain(4 | INDOOR_BIT), true);
    assert.equal(isIndoorTerrain(4), false);
  });

  it("decodes wire variants by index or name, falling back to dirt", () => {
    STEP_MATERIALS.forEach((m, i) => {
      assert.equal(materialFromVariant(i), m);
      assert.equal(materialFromVariant(m), m);
    });
    assert.equal(materialFromVariant(99), "dirt");
    assert.equal(materialFromVariant(1.5), "dirt");
    assert.equal(materialFromVariant("lava"), "dirt");
    assert.equal(materialFromVariant(undefined), "dirt");
  });

  it("decodes the shared wire materials beyond the six baked ones", () => {
    // Shared STEP_MATERIALS: … water(5), forest(6), gravel(7).
    assert.equal(materialFromVariant(6), "grass");
    assert.equal(materialFromVariant(7), "dirt");
    assert.equal(materialFromVariant("forest"), "grass");
    assert.equal(materialFromVariant("gravel"), "dirt");
    assert.equal(materialOfTerrain(8), "dirt"); // GRAVEL
    assert.equal(materialOfTerrain(1), "grass"); // FOREST
  });

  it("agrees with the shared surface table for the server's step variant", () => {
    for (let t = 0; t < 10; t++) {
      assert.equal(materialFromVariant(surfaceOf(t).variant), materialOfTerrain(t), `terrain ${t}`);
      assert.equal(stepRangeMultOfTerrain(t | INDOOR_BIT), surfaceOf(t).stepRangeMult);
    }
  });

  it("has a step sound for every material", () => {
    for (const m of STEP_MATERIALS) assert.equal(SFX[stepSoundId(m)].cls, "step");
  });
});

describe("footstepLayers", () => {
  it("remote run step is a single layer at the base level", () => {
    assert.deepEqual(footstepLayers({ material: "grass" }), [{ id: "step_grass", db: 0 }]);
  });

  it("self and walking steps are quieter", () => {
    const [self] = footstepLayers({ material: "wood", self: true });
    const [walkSelf] = footstepLayers({ material: "wood", self: true, walking: true });
    assert.equal(self!.db, SELF_STEP_DB);
    assert.equal(walkSelf!.db, SELF_STEP_DB + WALK_STEP_DB);
  });

  it("adds a splash layer on wet outdoor ground only", () => {
    assert.equal(footstepLayers({ material: "dirt", wetness: 0.8 }).length, 2);
    assert.equal(footstepLayers({ material: "dirt", wetness: 0.8 })[1]!.id, "step_water");
    assert.equal(footstepLayers({ material: "dirt", wetness: 0.3 }).length, 1);
    assert.equal(footstepLayers({ material: "concrete", wetness: 0.9, indoor: true }).length, 1);
    assert.equal(footstepLayers({ material: "water", wetness: 1 }).length, 1);
  });

  it("adds a rustle layer in bushes", () => {
    const l = footstepLayers({ material: "grass", bush: true });
    assert.deepEqual(
      l.map((x) => x.id),
      ["step_grass", "rustle"],
    );
  });
});
