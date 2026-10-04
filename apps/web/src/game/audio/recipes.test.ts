/**
 * Recipe sanity without a browser: every recipe is run against a recording mock of
 * BaseAudioContext, and the recorded automation is checked for the mistakes that make Web Audio
 * silently produce silence or NaN (exponential ramps touching 0, negative times, frequencies above
 * Nyquist, sources starting after the buffer ends, delays longer than their max).
 *
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/audio/*.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GUN_IDS, GUN_PARAMS, LOOP_XFADE_S, SFX, SFX_IDS, STEP_MATERIALS, farVariantOf, hashId, mulberry32, seedFor, type SfxDef } from "./recipes";

const SR = 48000;

type Ev = { kind: "set" | "lin" | "exp" | "target"; v: number; t: number };
class MockParam {
  events: Ev[] = [];
  constructor(
    public value: number,
    readonly name: string,
  ) {}
  setValueAtTime(v: number, t: number) {
    this.events.push({ kind: "set", v, t });
    return this;
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.events.push({ kind: "lin", v, t });
    return this;
  }
  exponentialRampToValueAtTime(v: number, t: number) {
    this.events.push({ kind: "exp", v, t });
    return this;
  }
  setTargetAtTime(v: number, t: number) {
    this.events.push({ kind: "target", v, t });
    return this;
  }
  cancelScheduledValues() {
    return this;
  }
}

class MockNode {
  outs: Array<MockNode | MockParam> = [];
  ins = 0;
  constructor(readonly kind: string) {}
  connect<T extends MockNode | MockParam>(n: T): T {
    this.outs.push(n);
    if (n instanceof MockNode) n.ins++;
    return n;
  }
  disconnect() {}
}

class MockSource extends MockNode {
  starts: number[] = [];
  stops: number[] = [];
  buffer: unknown = null;
  loop = false;
  start(t = 0) {
    this.starts.push(t);
  }
  stop(t = 0) {
    this.stops.push(t);
  }
}

class MockCtx {
  readonly sampleRate = SR;
  readonly currentTime = 0;
  params: MockParam[] = [];
  sources: Array<MockSource & { frequency?: MockParam }> = [];
  delays: Array<{ max: number; delayTime: MockParam }> = [];
  shapers: Array<{ curve: Float32Array | null }> = [];
  destination = new MockNode("destination");
  private p(v: number, name: string) {
    const x = new MockParam(v, name);
    this.params.push(x);
    return x;
  }
  createBuffer(_ch: number, n: number) {
    const d = new Float32Array(n);
    return { length: n, getChannelData: () => d };
  }
  createBufferSource() {
    const s = Object.assign(new MockSource("buffer"), { playbackRate: this.p(1, "rate") });
    this.sources.push(s);
    return s;
  }
  createOscillator() {
    const s = Object.assign(new MockSource("osc"), { type: "sine", frequency: this.p(440, "osc.frequency") });
    this.sources.push(s);
    return s;
  }
  createBiquadFilter() {
    return Object.assign(new MockNode("biquad"), { type: "lowpass", frequency: this.p(350, "biquad.frequency"), Q: this.p(1, "Q") });
  }
  createGain() {
    return Object.assign(new MockNode("gain"), { gain: this.p(1, "gain") });
  }
  createDelay(max = 1) {
    const d = Object.assign(new MockNode("delay"), { delayTime: this.p(0, "delayTime"), max });
    this.delays.push(d);
    return d;
  }
  createWaveShaper() {
    const w = Object.assign(new MockNode("shaper"), { curve: null as Float32Array | null, oversample: "none" });
    this.shapers.push(w);
    return w;
  }
}

function run(id: string, def: SfxDef, variant: number) {
  const c = new MockCtx();
  def.build(c as unknown as BaseAudioContext, c.destination as unknown as AudioNode, mulberry32(seedFor(id, variant)));
  return c;
}

describe("SFX registry", () => {
  it("has every sound the game needs", () => {
    const required = [
      ...GUN_IDS.flatMap((g) => [`gun_${g}`, `gun_${g}_far`]),
      ...STEP_MATERIALS.map((m) => `step_${m}`),
      "reload_out", "reload_in", "rack", "dry_fire", "weapon_switch",
      "hit_flesh", "hit_armor", "hitmarker", "kill_confirm", "body_fall",
      "chest_open", "zipper", "search", "rustle", "roll", "heal_bandage", "heal_medkit",
      "siren", "extract_beep", "extract_success", "heartbeat",
      "ui_click", "ui_hover", "ui_coin", "ui_error", "ui_equip",
      "thunder_near", "thunder_far", "bird", "loop_wind", "loop_rain", "loop_crickets",
      // Weapons v2.
      "gun_crossbow", "explosion", "explosion_far", "grenade_pin", "grenade_bounce",
    ];
    for (const id of required) assert.ok(id in SFX, `missing ${id}`);
    assert.ok(SFX_IDS.length >= 40, `${SFX_IDS.length} sounds`);
  });

  it("every entry has sane metadata", () => {
    for (const id of SFX_IDS) {
      const d: SfxDef = SFX[id];
      assert.ok(d.dur > 0 && d.dur <= 8, `${id} dur`);
      assert.ok(Number.isInteger(d.variants) && d.variants >= 1 && d.variants <= 4, `${id} variants`);
      assert.ok(d.db <= 0 && d.db >= -30, `${id} db`);
      assert.ok(["sfx", "ambience", "ui"].includes(d.bus), `${id} bus`);
      assert.ok(d.jitter >= 0 && d.jitter <= 0.05, `${id} jitter`);
      assert.ok(Number.isInteger(d.priority) && d.priority >= 0 && d.priority <= 5, `${id} priority`);
      if (d.loop) assert.equal(d.bus, "ambience", `${id} loop bus`);
      if (d.group === "ui") assert.equal(d.jitter, 0, `${id} UI sounds must not wobble`);
    }
  });

  it("orders guns by weight and keeps far takes quieter", () => {
    const p = GUN_PARAMS;
    assert.ok(p.sniper.tailMs > p.shotgun.tailMs && p.shotgun.tailMs > p.rifle.tailMs && p.rifle.tailMs > p.pistol.tailMs);
    assert.ok(p.sniper.th1 < p.pistol.th1, "heavier guns thump lower");
    for (const g of GUN_IDS) {
      const near = SFX[`gun_${g}` as const];
      const far = SFX[`gun_${g}_far` as const];
      assert.equal(farVariantOf(`gun_${g}` as const), `gun_${g}_far`);
      assert.ok(far.db < near.db, g);
      assert.ok(far.dur > near.dur, `${g} far tail is longer`);
      assert.ok(near.dur * 1000 > GUN_PARAMS[g].tailMs, `${g} buffer holds the tail`);
      assert.equal(near.cls, "gun");
    }
    assert.equal(farVariantOf("ui_click"), null);
    // Weapons v2: the SMG sounds lighter than the rifle, the LMG heavier; the crossbow has no far take.
    assert.ok(p.smg.tailMs < p.rifle.tailMs && p.lmg.tailMs > p.rifle.tailMs && p.revolver.th1 < p.pistol.th1);
    assert.equal(farVariantOf("gun_crossbow"), null);
    assert.equal(farVariantOf("explosion"), "explosion_far");
    assert.equal(SFX.gun_crossbow.cls, "gun");
  });

  it("seeds are deterministic and distinct per id and variant", () => {
    assert.equal(seedFor("gun_rifle", 0), seedFor("gun_rifle", 0));
    assert.notEqual(seedFor("gun_rifle", 0), seedFor("gun_rifle", 1));
    assert.notEqual(seedFor("gun_rifle", 0), seedFor("gun_pistol", 0));
    assert.equal(hashId("abc"), hashId("abc"));
    const r = mulberry32(42);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      assert.ok(v >= 0 && v < 1);
    }
    const a = mulberry32(7);
    const b = mulberry32(7);
    assert.equal(a(), b());
  });
});

describe("recipe graphs (mock context)", () => {
  for (const id of SFX_IDS) {
    const def: SfxDef = SFX[id];
    it(`${id} builds a valid graph for every variant`, () => {
      for (let v = 0; v < def.variants; v++) {
        const c = run(id, def, v);
        const renderLen = def.dur + (def.loop ? LOOP_XFADE_S : 0);
        assert.ok(c.destination.ins > 0, "nothing reaches the output");
        assert.ok(c.sources.length > 0, "no sources");
        for (const s of c.sources) {
          assert.equal(s.starts.length, 1, "each source starts once");
          const t = s.starts[0]!;
          assert.ok(Number.isFinite(t) && t >= 0, `start ${t}`);
          assert.ok(t < renderLen, `source starts at ${t}s, after the ${renderLen}s buffer`);
          for (const st of s.stops) assert.ok(st > t, "stop after start");
          if (s.kind === "buffer") assert.ok(s.buffer, "buffer source without buffer");
        }
        for (const p of c.params) {
          assert.ok(Number.isFinite(p.value), `${p.name} value ${p.value}`);
          let prev = p.value;
          for (const e of p.events) {
            assert.ok(Number.isFinite(e.v) && Number.isFinite(e.t) && e.t >= 0, `${p.name} event ${JSON.stringify(e)}`);
            if (e.kind === "exp") {
              assert.ok(e.v > 0, `${p.name} exponential ramp to ${e.v}`);
              assert.ok(prev > 0, `${p.name} exponential ramp from ${prev}`);
            }
            prev = e.v;
          }
          if (p.name.endsWith("frequency")) {
            const all = [p.value, ...p.events.map((e) => e.v)];
            // LFO-driven params get their value modulated around the base; the base must be sane.
            for (const f of all) assert.ok(f > 0 && f < SR / 2, `${p.name} = ${f}`);
          }
        }
        for (const d of c.delays) assert.ok(d.delayTime.value > 0 && d.delayTime.value <= d.max, "delay within max");
        for (const w of c.shapers) {
          assert.ok(w.curve && w.curve.every(Number.isFinite), "shaper curve");
        }
      }
    });
  }
});
