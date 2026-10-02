/**
 * Voice admission / stealing rules and settings persistence (pure parts of engine.ts and
 * settings.ts; the Web Audio graph itself is exercised on /dev/sfx).
 *
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/audio/*.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VOICE_LIMITS, admitVoice, pickVariant, type VoiceSlot } from "./engine";
import { DEFAULT_SETTINGS, STORAGE_KEY, loadSettings, sanitizeSettings, saveSettings, volumeToGain, type KV } from "./settings";
import { makeThrottle } from "./ui-sounds";

const v = (o: Partial<VoiceSlot> & Pick<VoiceSlot, "cls" | "priority">, i = 0): VoiceSlot => ({ id: "x", gain: 1, startedAt: i, ...o });

describe("admitVoice", () => {
  it("plays freely under every cap", () => {
    assert.deepEqual(admitVoice([], v({ cls: "gun", priority: 3 })), { kind: "play" });
  });

  it("enforces the gun cap by stealing within guns, quietest then oldest", () => {
    const active = Array.from({ length: VOICE_LIMITS.gun }, (_, i) => v({ cls: "gun", priority: 3, id: "gun_rifle", gain: i === 5 ? 0.1 : 1 }, i));
    active.push(v({ cls: "step", priority: 1 }, 100));
    const r = admitVoice(active, v({ cls: "gun", priority: 3 }, 200));
    assert.deepEqual(r, { kind: "steal", index: 5 });
    // equal gains → oldest
    const same = Array.from({ length: VOICE_LIMITS.gun }, (_, i) => v({ cls: "gun", priority: 3 }, 10 - i));
    assert.deepEqual(admitVoice(same, v({ cls: "gun", priority: 3 }, 50)), { kind: "steal", index: VOICE_LIMITS.gun - 1 });
  });

  it("enforces the step cap", () => {
    const active = Array.from({ length: VOICE_LIMITS.step }, (_, i) => v({ cls: "step", priority: 1 }, i));
    assert.deepEqual(admitVoice(active, v({ cls: "step", priority: 1 }, 99)), { kind: "steal", index: 0 });
  });

  it("on the total cap steals the lowest priority voice anywhere", () => {
    const active: VoiceSlot[] = [];
    for (let i = 0; i < VOICE_LIMITS.total; i++) active.push(v({ cls: "other", priority: i === 17 ? 1 : 3 }, i));
    assert.deepEqual(admitVoice(active, v({ cls: "other", priority: 2 }, 99)), { kind: "steal", index: 17 });
  });

  it("never lets a lower-priority sound cut a higher-priority one", () => {
    const active = Array.from({ length: VOICE_LIMITS.total }, (_, i) => v({ cls: "other", priority: 4 }, i));
    assert.deepEqual(admitVoice(active, v({ cls: "step", priority: 1 }, 99)), { kind: "reject" });
    // equal priority may steal (fresh sound wins)
    assert.equal(admitVoice(active, v({ cls: "other", priority: 4 }, 99)).kind, "steal");
  });

  it("caps retriggers per (source, sound) at 3", () => {
    const active = [
      v({ cls: "other", priority: 2, id: "reload_in", key: "p1" }, 0),
      v({ cls: "other", priority: 2, id: "reload_in", key: "p1" }, 1),
      v({ cls: "other", priority: 2, id: "reload_in", key: "p2" }, 2),
      v({ cls: "other", priority: 2, id: "reload_in", key: "p1" }, 3),
    ];
    assert.deepEqual(admitVoice(active, v({ cls: "other", priority: 2, id: "reload_in", key: "p1" }, 9)), { kind: "steal", index: 0 });
    assert.deepEqual(admitVoice(active, v({ cls: "other", priority: 2, id: "reload_in", key: "p2" }, 9)), { kind: "play" });
    assert.deepEqual(admitVoice(active, v({ cls: "other", priority: 2, id: "reload_in" }, 9)), { kind: "play" });
  });

  it("keeps the caps invariant over a long random stream", () => {
    let active: VoiceSlot[] = [];
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let t = 0; t < 5000; t++) {
      const cls = (["gun", "step", "other"] as const)[Math.floor(rnd() * 3)]!;
      const inc = v({ cls, priority: Math.floor(rnd() * 6), gain: rnd(), key: `p${Math.floor(rnd() * 4)}`, id: cls }, t);
      const r = admitVoice(active, inc);
      if (r.kind === "steal") active.splice(r.index, 1);
      if (r.kind !== "reject") active.push(inc);
      if (rnd() < 0.3 && active.length) active.splice(Math.floor(rnd() * active.length), 1); // natural ends
      assert.ok(active.length <= VOICE_LIMITS.total);
      assert.ok(active.filter((x) => x.cls === "gun").length <= VOICE_LIMITS.gun);
      assert.ok(active.filter((x) => x.cls === "step").length <= VOICE_LIMITS.step);
    }
  });
});

describe("pickVariant", () => {
  it("never repeats the previous take when there is a choice", () => {
    for (let i = 0; i < 100; i++) {
      const r = i / 100;
      const last = Math.floor(r * 4);
      assert.notEqual(pickVariant(4, last, r), last);
      const p = pickVariant(4, undefined, r);
      assert.ok(p >= 0 && p < 4);
    }
    assert.equal(pickVariant(1, 0, 0.5), 0);
  });
});

describe("settings", () => {
  function memory(init?: string): KV & { data: Map<string, string> } {
    const data = new Map<string, string>();
    if (init !== undefined) data.set(STORAGE_KEY, init);
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, val) => void data.set(k, val) };
  }

  it("round-trips through storage", () => {
    const kv = memory();
    const s = { ...DEFAULT_SETTINGS, master: 0.3, muted: true };
    assert.equal(saveSettings(s, kv), true);
    assert.deepEqual(loadSettings(kv), s);
  });

  it("falls back to defaults on missing, corrupt or hostile data", () => {
    assert.deepEqual(loadSettings(memory()), DEFAULT_SETTINGS);
    assert.deepEqual(loadSettings(memory("{not json")), DEFAULT_SETTINGS);
    assert.deepEqual(loadSettings(null), DEFAULT_SETTINGS);
    const s = sanitizeSettings({ master: 7, sfx: -1, ambience: "loud", muted: "yes", ui: NaN });
    assert.deepEqual(s, { ...DEFAULT_SETTINGS, master: 1, sfx: 0 });
  });

  it("never throws when storage throws", () => {
    const evil: KV = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceeded");
      },
    };
    assert.deepEqual(loadSettings(evil), DEFAULT_SETTINGS);
    assert.equal(saveSettings(DEFAULT_SETTINGS, evil), false);
  });

  it("maps sliders to gain with a squared curve reaching silence", () => {
    assert.equal(volumeToGain(0), 0);
    assert.equal(volumeToGain(1), 1);
    assert.equal(volumeToGain(0.5), 0.25);
    assert.equal(volumeToGain(2), 1);
    assert.equal(volumeToGain(NaN), 0);
  });
});

describe("ui hover throttle", () => {
  it("lets one call through per window", () => {
    const gate = makeThrottle(50);
    assert.equal(gate(0), true);
    assert.equal(gate(10), false);
    assert.equal(gate(49), false);
    assert.equal(gate(50), true);
    assert.equal(gate(120), true);
  });
});
