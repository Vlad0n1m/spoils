/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/haptics.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HAPTICS, HAPTICS_STORAGE_KEY, HapticGate, loadHapticsEnabled, patternMs, saveHapticsEnabled, type HapticKind, type HapticsKV } from "./haptics";
import { lowHp } from "./haptics-system";

const KINDS = Object.keys(HAPTICS) as HapticKind[];

function memKV(init: Record<string, string> = {}): HapticsKV & { data: Record<string, string> } {
  const data = { ...init };
  return { data, getItem: (k) => (k in data ? data[k]! : null), setItem: (k, v) => void (data[k] = v) };
}

describe("haptic patterns", () => {
  it("covers every event with a short, valid pattern", () => {
    assert.deepEqual(KINDS.sort(), ["damage", "extract", "hit", "kill", "loot", "lowHp", "wipe"]);
    for (const k of KINDS) {
      const p = HAPTICS[k].pattern;
      assert.ok(p.length >= 1 && p.length % 2 === 1, `${k}: ends on a pulse`);
      assert.ok(p.every((x) => Number.isInteger(x) && x > 0), `${k}: positive whole ms`);
      assert.ok(patternMs(p) <= 500, `${k}: at most half a second`);
    }
  });

  it("patterns are distinct from each other", () => {
    const keys = new Set(KINDS.map((k) => HAPTICS[k].pattern.join(",")));
    assert.equal(keys.size, KINDS.length);
  });

  it("a landed hit is the lightest pattern", () => {
    for (const k of KINDS) if (k !== "hit") assert.ok(patternMs(HAPTICS.hit.pattern) < patternMs(HAPTICS[k].pattern), k);
  });

  it("patternMs sums on and off times and ignores junk", () => {
    assert.equal(patternMs([30, 50, 70]), 150);
    assert.equal(patternMs([]), 0);
    assert.equal(patternMs([10, -5, Number.NaN]), 10);
  });
});

describe("HapticGate throttle", () => {
  it("automatic fire: hits 100 ms apart buzz at most once per minGap", () => {
    const g = new HapticGate();
    let buzzed = 0;
    for (let t = 0; t < 3_000; t += 100) if (g.fire("hit", t)) buzzed++;
    // 3 s of hits at 10/s → one buzz every 300 ms.
    assert.equal(buzzed, Math.ceil(3_000 / HAPTICS.hit.minGapMs));
    assert.ok(buzzed <= 10);
  });

  it("the gap is per kind: a hit does not delay damage", () => {
    const g = new HapticGate();
    assert.equal(g.fire("hit", 0), true);
    assert.equal(g.fire("damage", 20), true);
    assert.equal(g.fire("damage", 100), false);
    assert.equal(g.fire("damage", 20 + HAPTICS.damage.minGapMs), true);
  });

  it("a weaker pattern never cuts into a stronger one still playing", () => {
    const g = new HapticGate();
    assert.equal(g.fire("kill", 0), true);
    assert.equal(g.fire("hit", 50), false, "kill still buzzing");
    assert.equal(g.fire("damage", 100), false);
    const end = patternMs(HAPTICS.kill.pattern);
    assert.equal(g.fire("damage", end), true, "after the kill pattern ends");
  });

  it("a stronger pattern replaces a weaker one", () => {
    const g = new HapticGate();
    assert.equal(g.fire("loot", 0), true);
    assert.equal(g.fire("extract", 10), true);
    assert.equal(g.fire("loot", 200), false, "extract still buzzing");
  });

  it("a blocked attempt does not use up the gap", () => {
    const g = new HapticGate();
    g.fire("kill", 0);
    assert.equal(g.fire("hit", 10), false);
    assert.equal(g.fire("hit", patternMs(HAPTICS.kill.pattern)), true);
  });

  it("rare warnings repeat only after their long gap", () => {
    const g = new HapticGate();
    assert.equal(g.fire("lowHp", 0), true);
    assert.equal(g.fire("lowHp", 1_000), false);
    assert.equal(g.fire("lowHp", HAPTICS.lowHp.minGapMs), true);
  });

  it("reset forgets the gaps", () => {
    const g = new HapticGate();
    g.fire("extract", 0);
    g.reset();
    assert.equal(g.fire("hit", 1), true);
    assert.equal(g.fire("extract", 2), true);
  });
});

describe("haptics setting", () => {
  it("defaults on, remembers off per device", () => {
    const kv = memKV();
    assert.equal(loadHapticsEnabled(kv), true);
    assert.equal(saveHapticsEnabled(false, kv), true);
    assert.equal(kv.data[HAPTICS_STORAGE_KEY], "0");
    assert.equal(loadHapticsEnabled(kv), false);
    saveHapticsEnabled(true, kv);
    assert.equal(loadHapticsEnabled(kv), true);
  });

  it("junk or blocked storage falls back to on and never throws", () => {
    assert.equal(loadHapticsEnabled(memKV({ [HAPTICS_STORAGE_KEY]: "maybe" })), true);
    assert.equal(loadHapticsEnabled(null), true);
    const throwing: HapticsKV = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
    };
    assert.equal(loadHapticsEnabled(throwing), true);
    assert.equal(saveHapticsEnabled(false, throwing), false);
    assert.equal(saveHapticsEnabled(false, null), false);
  });
});

describe("low HP edge", () => {
  it("only alive, on the map, under the heartbeat threshold", () => {
    assert.equal(lowHp(true, 20, false), true);
    assert.equal(lowHp(true, 80, false), false);
    assert.equal(lowHp(false, 20, false), false);
    assert.equal(lowHp(true, 20, true), false);
    assert.equal(lowHp(true, 0, false), false);
  });
});
