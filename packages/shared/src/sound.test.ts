import assert from "node:assert/strict";
import { test } from "node:test";
import { SOLID, buildCollisionIndex } from "./geometry.js";
import { WEAPONS, WEAPON_IDS } from "./items.js";
import {
  OCCLUSION,
  SOUND,
  SOUND_KIND_COUNT,
  SOUND_PRIORITY,
  SOUND_VIZ,
  SoundKind,
  bandMid,
  baseSoundRadius,
  decodeSoundMsg,
  effectiveSoundRadius,
  isBehind,
  occlusionMult,
  pushHiddenSound,
  pushVisibleSound,
  quantizeSound,
  sectorAngle,
  soundMsgEmpty,
  soundOcclusion,
  weaponVariant,
  type SoundMsg,
} from "./sound.js";

test("quantizeSound: sectors at 0/90/180/-90°, bands, occlusion, inaudible", () => {
  assert.deepEqual(quantizeSound(0, 0, 100, 0, 800, false), { a: 0, b: 0, occluded: false });
  assert.deepEqual(quantizeSound(0, 0, 0, 500, 900, false), { a: 4, b: 1, occluded: false }); // +y = 90°
  assert.deepEqual(quantizeSound(0, 0, -800, -1, 900, false), { a: 8, b: 2, occluded: false });
  assert.deepEqual(quantizeSound(0, 0, 0, -10, 900, false), { a: 12, b: 0, occluded: false });
  assert.equal(quantizeSound(0, 0, 600, 0, 800, true), null, "600 × 1.6 > 800");
  assert.deepEqual(quantizeSound(0, 0, 400, 0, 800, true), { a: 0, b: 2, occluded: true }, "640/800 → far band");
  assert.equal(quantizeSound(0, 0, 900, 0, 800, false), null);
  assert.equal(quantizeSound(0, 0, 10, 0, 0, false), null, "radius 0");
  assert.equal(quantizeSound(0, 0, 10, 0, NaN, false), null);
  // Band thresholds at 0.33 / 0.66 of the radius.
  assert.equal(quantizeSound(0, 0, 0.32 * 1000, 0, 1000, false)!.b, 0);
  assert.equal(quantizeSound(0, 0, 0.34 * 1000, 0, 1000, false)!.b, 1);
  assert.equal(quantizeSound(0, 0, 0.67 * 1000, 0, 1000, false)!.b, 2);
  assert.equal(quantizeSound(0, 0, 1000, 0, 1000, false)!.b, 2, "exactly at the radius is audible");
  // Sector boundary rounding: ±(half sector − ε) stays in sector 0; just past it is 1 / 15.
  const half = Math.PI / SOUND.SECTORS;
  const at = (ang: number) => quantizeSound(0, 0, Math.cos(ang) * 100, Math.sin(ang) * 100, 800, false)!.a;
  assert.equal(at(half - 1e-6), 0);
  assert.equal(at(half + 1e-6), 1);
  assert.equal(at(-half + 1e-6), 0);
  assert.equal(at(-half - 1e-6), 15);
  assert.equal(at(Math.PI), 8);
  assert.equal(at(-Math.PI + 1e-9), 8);
});

test("same bucket → identical payload (no sub-bucket position leak)", () => {
  assert.deepEqual(quantizeSound(0, 0, 400, 10, 800, false), quantizeSound(0, 0, 420, -12, 800, false));
  assert.deepEqual(quantizeSound(0, 0, 250, 10, 900, false), quantizeSound(0, 0, 240, -20, 900, false));
  const a: SoundMsg = {}, b: SoundMsg = {};
  pushHiddenSound(a, SoundKind.step, quantizeSound(1000, 1000, 1400, 1010, 800, false)!, 2);
  pushHiddenSound(b, SoundKind.step, quantizeSound(1000, 1000, 1390, 990, 800, false)!, 2);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("hidden payload carries only small integers (no ids, no coordinates)", () => {
  const m: SoundMsg = {};
  for (let i = 0; i < 50; i++) {
    const ang = i * 0.37, d = 50 + i * 13;
    const h = quantizeSound(5000, 5000, 5000 + Math.cos(ang) * d, 5000 + Math.sin(ang) * d, 2400, i % 3 === 0);
    if (h) pushHiddenSound(m, (i % SOUND_KIND_COUNT) as SoundKind, h, i % 4);
  }
  assert.equal(m.v, undefined);
  assert.ok(m.h!.length > 0 && m.h!.length % 4 === 0);
  for (const v of m.h!) assert.ok(Number.isInteger(v) && v >= 0 && v < 16, String(v));
});

test("sectorAngle / bandMid / isBehind", () => {
  assert.equal(sectorAngle(0), 0);
  assert.ok(Math.abs(sectorAngle(4) - Math.PI / 2) < 1e-12);
  assert.deepEqual([bandMid(0), bandMid(1), bandMid(2)], [0.17, 0.5, 0.83]);
  for (const b of [0, 1, 2] as const) {
    const lo = b === 0 ? 0 : SOUND.BANDS[b - 1], hi = SOUND.BANDS[b];
    assert.ok(bandMid(b) > lo && bandMid(b) < hi, "band mid lies inside its band");
  }
  assert.equal(isBehind(sectorAngle(8), 0), true);
  assert.equal(isBehind(sectorAngle(1), 0), false);
  assert.equal(isBehind(sectorAngle(15), 0), false);
  assert.equal(isBehind(sectorAngle(8), Math.PI), false, "flips when the aim rotates 180°");
  assert.equal(isBehind(sectorAngle(0), Math.PI), true);
  assert.equal(isBehind(0, 7 * Math.PI), true, "aim not normalised");
  assert.equal(isBehind(sectorAngle(5), 0, Math.PI / 4), true, "custom fov");
});

test("radius table (critique numbers) and env/surface scaling", () => {
  assert.equal(SOUND.STEP_EVERY_PX, 120);
  assert.equal(baseSoundRadius(SoundKind.step), 800);
  assert.equal(baseSoundRadius(SoundKind.step, 0, true), 180);
  assert.equal(baseSoundRadius(SoundKind.roll), 900);
  assert.deepEqual(WEAPON_IDS.map((w) => baseSoundRadius(SoundKind.shot, weaponVariant(w))), [2000, 2400, 2200, 3600]);
  for (const w of WEAPON_IDS) assert.equal(baseSoundRadius(SoundKind.shot, weaponVariant(w)), WEAPONS[w].soundRadius);
  assert.equal(baseSoundRadius(SoundKind.shot, 99), WEAPONS.pistol.soundRadius, "unknown variant falls back");
  assert.equal(baseSoundRadius(SoundKind.reload), 500);
  assert.equal(baseSoundRadius(SoundKind.heal), 450);
  assert.equal(baseSoundRadius(SoundKind.loot), 900);
  assert.equal(baseSoundRadius(SoundKind.search), 600);
  assert.equal(baseSoundRadius(SoundKind.extract), 2400);
  assert.equal(SOUND.EXTRACT_REPEAT_MS, 2500);
  assert.equal(baseSoundRadius(SoundKind.hurt), 700);
  assert.equal(baseSoundRadius(SoundKind.death), 1400);
  for (let k = 0; k < SOUND_KIND_COUNT; k++) assert.ok(baseSoundRadius(k as SoundKind) > 0, `kind ${k}`);
  assert.ok(baseSoundRadius(SoundKind.stepBush, 0, true) < baseSoundRadius(SoundKind.stepBush));
  assert.equal(effectiveSoundRadius(800, 0.65, 1.25), 800 * 0.65 * 1.25);
});

test("priority and viz tables cover every kind; deaths and shots outrank steps", () => {
  for (let k = 0; k < SOUND_KIND_COUNT; k++) {
    assert.ok(SOUND_PRIORITY[k as SoundKind] !== undefined && SOUND_VIZ[k as SoundKind] !== undefined, `kind ${k}`);
  }
  assert.equal(Object.keys(SoundKind).length, SOUND_KIND_COUNT);
  assert.ok(SOUND_PRIORITY[SoundKind.death] > SOUND_PRIORITY[SoundKind.shot]);
  assert.ok(SOUND_PRIORITY[SoundKind.shot] > SOUND_PRIORITY[SoundKind.step]);
});

test("encode/decode roundtrip and malformed input", () => {
  const m: SoundMsg = {};
  assert.equal(soundMsgEmpty(m), true);
  pushHiddenSound(m, SoundKind.shot, { a: 3, b: 2, occluded: true }, 1);
  pushVisibleSound(m, SoundKind.step, "abc", 4);
  assert.equal(soundMsgEmpty(m), false);
  const d = decodeSoundMsg(JSON.parse(JSON.stringify(m)));
  assert.deepEqual(d, [
    { kind: SoundKind.shot, hidden: true, a: 3, b: 2, occluded: true, variant: 1 },
    { kind: SoundKind.step, hidden: false, id: "abc", variant: 4 },
  ]);
  // Out-of-range kind, out-of-range sector, band 3, odd trailing lengths, non-string id: all skipped.
  assert.deepEqual(decodeSoundMsg({ h: [99, 0, 0, 0, 3, SOUND.SECTORS, 0, 0, 3, 1, 3, 0, 3, 1, 2], v: [1, 2, 3, 1, "x"] }), []);
  assert.deepEqual(decodeSoundMsg({ h: [3, -1, 0, 0, 3, 1.5, 0, 0] }), []);
  assert.deepEqual(decodeSoundMsg({ h: "nope" as unknown as number[], v: {} as unknown as string[] }), []);
  assert.deepEqual(decodeSoundMsg(null), []);
  assert.deepEqual(decodeSoundMsg(undefined), []);
  // A non-numeric variant decodes as 0 rather than throwing.
  assert.deepEqual(decodeSoundMsg({ h: [0, 1, 0, "x" as unknown as number] }), [
    { kind: SoundKind.step, hidden: true, a: 1, b: 0, occluded: false, variant: 0 },
  ]);
});

test("windows: an opening in the wall — WINDOW_MULT× the distance, no muffle flag; a wall still muffles", () => {
  assert.equal(occlusionMult(OCCLUSION.OPEN), 1);
  assert.equal(occlusionMult(OCCLUSION.WINDOW), SOUND.WINDOW_MULT);
  assert.equal(occlusionMult(OCCLUSION.WALL), SOUND.OCCLUSION_MULT);
  assert.ok(SOUND.WINDOW_MULT > 1 && SOUND.WINDOW_MULT < SOUND.OCCLUSION_MULT);
  // Walls-only index: a wall x 1000..1024 with a window at y 900..1100.
  const walls = buildCollisionIndex(
    {
      rects: [
        { x: 1000, y: 0, w: 24, h: 900, f: SOLID.ALL },
        { x: 1000, y: 900, w: 24, h: 200, f: SOLID.WINDOW },
        { x: 1000, y: 1100, w: 24, h: 900, f: SOLID.ALL },
      ],
      circles: [],
    },
    2000, 2000,
  );
  assert.equal(soundOcclusion(walls, 800, 1000, 900, 1000), OCCLUSION.OPEN);
  assert.equal(soundOcclusion(walls, 800, 1000, 1300, 1000), OCCLUSION.WINDOW);
  assert.equal(soundOcclusion(walls, 800, 500, 1300, 500), OCCLUSION.WALL);
  // An oblique path that meets the wall beside the window is muffled.
  assert.equal(soundOcclusion(walls, 800, 1000, 1300, 1600), OCCLUSION.WALL);
  // 600 px footstep (800): open 0.75 and window 750 → far band, unflagged; wall 960 → inaudible.
  assert.deepEqual(quantizeSound(0, 0, 600, 0, 800, false), { a: 0, b: 2, occluded: false });
  assert.deepEqual(quantizeSound(0, 0, 600, 0, 800, false, occlusionMult(OCCLUSION.WINDOW)), { a: 0, b: 2, occluded: false });
  assert.equal(quantizeSound(0, 0, 700, 0, 800, false, occlusionMult(OCCLUSION.WINDOW)), null, "875 > 800");
  assert.equal(quantizeSound(0, 0, 600, 0, 800, true, occlusionMult(OCCLUSION.WALL)), null);
  // 220 px: open near band (0.275), window 275 → mid band (0.34).
  assert.equal(quantizeSound(0, 0, 220, 0, 800, false)!.b, 0);
  assert.equal(quantizeSound(0, 0, 220, 0, 800, false, SOUND.WINDOW_MULT)!.b, 1);
  // The default distMult keeps the old boolean contract.
  assert.deepEqual(quantizeSound(0, 0, 400, 0, 800, true), quantizeSound(0, 0, 400, 0, 800, true, SOUND.OCCLUSION_MULT));
});
