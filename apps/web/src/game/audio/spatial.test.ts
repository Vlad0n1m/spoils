/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/audio/*.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BAND_GAIN,
  HIDDEN_BEHIND_CUTOFF,
  MAX_CUTOFF,
  MIN_CUTOFF,
  NEAR_PX,
  SECTORS,
  angleDiff,
  behindAmount,
  dbToGain,
  sectorAngle,
  spatialize,
  spatializeHidden,
  thunderDelayMs,
  unpackBand,
} from "./spatial";

const UP = -Math.PI / 2; // screen up (y down)
const RIGHT = 0;

describe("spatialize (visible sources)", () => {
  it("returns null at and beyond range, and for bad input", () => {
    assert.equal(spatialize({ dx: 1000, dy: 0, range: 1000 }), null);
    assert.equal(spatialize({ dx: 900, dy: 900, range: 1000 }), null);
    assert.equal(spatialize({ dx: NaN, dy: 0, range: 1000 }), null);
    assert.equal(spatialize({ dx: 0, dy: 0, range: 0 }), null);
  });

  it("is full gain and full brightness inside NEAR", () => {
    const s = spatialize({ dx: NEAR_PX - 1, dy: 0, range: 2000 })!;
    assert.equal(s.gain, 1);
    assert.equal(s.cutoff, MAX_CUTOFF);
    assert.equal(s.far, false);
  });

  it("gain and cutoff fall monotonically with distance", () => {
    let prev = spatialize({ dx: 0, dy: 50, range: 2400 })!;
    for (let d = 100; d < 2400; d += 100) {
      const s = spatialize({ dx: 0, dy: d, range: 2400 })!;
      assert.ok(s.gain <= prev.gain, `gain at ${d}`);
      assert.ok(s.cutoff <= prev.cutoff, `cutoff at ${d}`);
      assert.ok(s.gain >= 0 && s.gain <= 1);
      prev = s;
    }
    // near the edge it is almost silent and ~1.6 kHz
    const edge = spatialize({ dx: 0, dy: 2399, range: 2400 })!;
    assert.ok(edge.gain < 0.001);
    assert.ok(edge.cutoff > 1500 && edge.cutoff < 1700);
  });

  it("switches to the far take past 40% of range", () => {
    const range = 2120; // u = (d-120)/2000
    assert.equal(spatialize({ dx: 120 + 700, dy: 0, range })!.far, false);
    assert.equal(spatialize({ dx: 120 + 900, dy: 0, range })!.far, true);
  });

  it("pan sign follows dx, is clamped, and collapses on top of the listener", () => {
    assert.ok(spatialize({ dx: 300, dy: 0, range: 2000 })!.pan > 0);
    assert.ok(spatialize({ dx: -300, dy: 0, range: 2000 })!.pan < 0);
    assert.equal(spatialize({ dx: 0, dy: 300, range: 2000 })!.pan, 0);
    const hard = spatialize({ dx: 1500, dy: 0, range: 2000 })!;
    assert.ok(Math.abs(hard.pan - 0.85) < 1e-9);
    const close = spatialize({ dx: 10, dy: 0, range: 2000 })!;
    assert.ok(close.pan < 0.02);
    assert.equal(spatialize({ dx: 0, dy: 0, range: 2000 })!.pan, 0);
  });

  it("sources behind the aim are darker and slightly quieter than in front", () => {
    const front = spatialize({ dx: 0, dy: -600, range: 2400, facing: UP })!;
    const side = spatialize({ dx: 600, dy: 0, range: 2400, facing: UP })!;
    const back = spatialize({ dx: 0, dy: 600, range: 2400, facing: UP })!;
    assert.ok(back.cutoff < front.cutoff);
    assert.ok(back.gain < front.gain);
    // 90° is the cone edge: no behind cue yet
    assert.equal(side.cutoff, front.cutoff);
    assert.equal(side.gain, front.gain);
    // no facing → no cue
    const none = spatialize({ dx: 0, dy: 600, range: 2400 })!;
    assert.equal(none.cutoff, front.cutoff);
  });

  it("each wall lowers gain and caps the cutoff, floored at 250 Hz", () => {
    const base = { dx: 300, dy: 0, range: 2400 };
    const w0 = spatialize({ ...base, walls: 0 })!;
    const w1 = spatialize({ ...base, walls: 1 })!;
    const w2 = spatialize({ ...base, walls: 2 })!;
    const w3 = spatialize({ ...base, walls: 3 })!;
    assert.ok(w1.gain < w0.gain && w2.gain < w1.gain && w3.gain < w2.gain);
    assert.ok(Math.abs(w1.gain / w0.gain - 0.55) < 1e-9);
    assert.ok(w1.cutoff <= 2200 && w2.cutoff <= 880 && w3.cutoff >= MIN_CUTOFF);
    assert.deepEqual(spatialize({ ...base, occluded: true }), w1);
  });
});

describe("spatializeHidden (sector + band only)", () => {
  it("pans by the sector cosine", () => {
    assert.ok(Math.abs(spatializeHidden({ sector: 0, band: 0 })!.pan - 0.8) < 1e-9); // right
    assert.ok(Math.abs(spatializeHidden({ sector: 8, band: 0 })!.pan + 0.8) < 1e-9); // left
    assert.ok(Math.abs(spatializeHidden({ sector: 4, band: 0 })!.pan) < 1e-9); // below
    assert.ok(Math.abs(spatializeHidden({ sector: 12, band: 0 })!.pan) < 1e-9); // above
  });

  it("uses the band gain table and gets darker with distance", () => {
    const b = [0, 1, 2].map((band) => spatializeHidden({ sector: 3, band })!);
    b.forEach((s, i) => assert.ok(Math.abs(s.gain - BAND_GAIN[i]!) < 1e-9));
    assert.ok(b[0]!.cutoff > b[1]!.cutoff && b[1]!.cutoff > b[2]!.cutoff);
    assert.equal(b[0]!.far, false);
    assert.equal(b[2]!.far, true);
  });

  it("lowpasses sources behind the aim and occluded sources", () => {
    const front = spatializeHidden({ sector: 12, band: 0, facing: UP })!;
    const behind = spatializeHidden({ sector: 4, band: 0, facing: UP })!;
    assert.ok(behind.cutoff <= HIDDEN_BEHIND_CUTOFF && behind.cutoff < front.cutoff);
    assert.ok(behind.gain < front.gain);
    const occ = spatializeHidden({ sector: 12, band: 0, facing: UP, occluded: true })!;
    assert.ok(occ.cutoff <= 2200 && occ.gain < front.gain);
  });

  it("wraps sectors and clamps bands instead of throwing", () => {
    assert.deepEqual(spatializeHidden({ sector: SECTORS, band: 0 }), spatializeHidden({ sector: 0, band: 0 }));
    assert.deepEqual(spatializeHidden({ sector: -1, band: 0 }), spatializeHidden({ sector: SECTORS - 1, band: 0 }));
    assert.deepEqual(spatializeHidden({ sector: 2, band: 7 }), spatializeHidden({ sector: 2, band: 2 }));
    assert.equal(spatializeHidden({ sector: NaN, band: 0 }), null);
  });

  it("unpacks band | occluded << 2", () => {
    assert.deepEqual(unpackBand(0), { band: 0, occluded: false });
    assert.deepEqual(unpackBand(2), { band: 2, occluded: false });
    assert.deepEqual(unpackBand(1 | (1 << 2)), { band: 1, occluded: true });
    assert.deepEqual(unpackBand(3), { band: 2, occluded: false });
  });
});

describe("angle helpers", () => {
  it("angleDiff wraps into (-π, π]", () => {
    assert.ok(Math.abs(angleDiff(0.1, 2 * Math.PI - 0.1) - 0.2) < 1e-9);
    assert.ok(Math.abs(angleDiff(Math.PI, -Math.PI)) < 1e-9);
  });
  it("behindAmount is 0 in front, 1 directly behind", () => {
    assert.equal(behindAmount(RIGHT, RIGHT), 0);
    assert.equal(behindAmount(Math.PI / 2, RIGHT), 0);
    assert.ok(Math.abs(behindAmount(Math.PI, RIGHT) - 1) < 1e-9);
    assert.equal(behindAmount(Math.PI, undefined), 0);
  });
  it("sectorAngle matches the 16-way split", () => {
    assert.equal(sectorAngle(0), 0);
    assert.ok(Math.abs(sectorAngle(4) - Math.PI / 2) < 1e-9);
  });
  it("dbToGain and thunder delay", () => {
    assert.ok(Math.abs(dbToGain(-6) - 0.501) < 0.001);
    assert.equal(dbToGain(0), 1);
    assert.equal(thunderDelayMs(3000), 1000);
    assert.equal(thunderDelayMs(-5), 0);
  });
});
