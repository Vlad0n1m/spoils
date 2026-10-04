/**
 * Procedural SFX recipes: the whole game sound bank, synthesized, no files.
 *
 * Each recipe builds a Web Audio graph on a BaseAudioContext (an OfflineAudioContext at bake time,
 * see bake.ts) starting at t = 0 and writes into `out`. The result is baked once per variant into a
 * mono buffer and normalized to -1 dBFS, so the per-sound loudness lives in one place: the `db`
 * column of the SFX registry below (immersion memo, "Mix table").
 *
 * Why procedural: zero licence risk, zero network, deterministic (mulberry32 seeded by id + variant)
 * and testable offline. If CC0 files show up later they drop into the same registry.
 *
 * This module never touches `window` at import time, so the pure tests can import it under node.
 */

export type Rand = () => number;
type Ctx = BaseAudioContext;

/** Mixer bus a sound plays on. The ambience bus has its own indoor muffle; ui skips the sfx muffle. */
export type Bus = "sfx" | "ambience" | "ui";
/** Voice-cap class: guns and steps have their own caps so a firefight cannot starve everything. */
export type VoiceClass = "gun" | "step" | "other";

export interface SfxDef {
  /** Rendered length in seconds (loops: the loop length; 0.5 s extra is rendered for the crossfade). */
  dur: number;
  /** Number of baked takes; the engine picks one at random so repeats don't sound machine-gunned. */
  variants: number;
  loop?: boolean;
  /** Mix level in dB applied on top of the normalized buffer. */
  db: number;
  bus: Bus;
  cls: VoiceClass;
  /** Voice-stealing priority (higher survives). UI 5, hits 4, guns 3, body/chest 2, steps 1. */
  priority: number;
  /** Max playbackRate jitter (fraction) per play, e.g. 0.04 = ±4%. */
  jitter: number;
  /** Grouping for the /dev/sfx page. */
  group: "guns" | "steps" | "weapon" | "hits" | "interact" | "extract" | "ui" | "weather" | "loops";
  build: (c: Ctx, out: AudioNode, r: Rand) => void;
}

export function mulberry32(seed: number): Rand {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a; mixes the sound id into the per-variant seed. */
export function hashId(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

// ---------------------------------------------------------------- graph helpers

/** Floor for exponential ramps: exponentialRamp cannot reach 0, and -80 dB is inaudible. */
const EPS = 0.0001;
type NoiseColor = "white" | "pink" | "brown";
const noiseCache = new WeakMap<Ctx, Partial<Record<NoiseColor, AudioBuffer>>>();

/** 2 s noise buffer per context and colour, built once and shared by every noise source. */
function noiseBuf(c: Ctx, color: NoiseColor, r: Rand): AudioBuffer {
  let per = noiseCache.get(c);
  if (!per) noiseCache.set(c, (per = {}));
  const hit = per[color];
  if (hit) return hit;
  const n = Math.floor(c.sampleRate * 2);
  const b = c.createBuffer(1, n, c.sampleRate);
  const d = b.getChannelData(0);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let last = 0;
  for (let i = 0; i < n; i++) {
    const w = r() * 2 - 1;
    if (color === "white") d[i] = w;
    else if (color === "pink") {
      // Paul Kellet's economy pink filter: cheap and flat enough for SFX.
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
    } else {
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    }
  }
  per[color] = b;
  return b;
}

/** Looping noise source starting at a random offset, so layers sharing one buffer don't correlate. */
function noise(c: Ctx, color: NoiseColor, r: Rand, t0 = 0, dur = 2): AudioBufferSourceNode {
  const s = c.createBufferSource();
  s.buffer = noiseBuf(c, color, r);
  s.loop = true;
  s.start(t0, r() * 1.5);
  s.stop(t0 + dur);
  return s;
}

function filt(c: Ctx, type: BiquadFilterType, f: number, Q = 0.707): BiquadFilterNode {
  const b = c.createBiquadFilter();
  b.type = type;
  b.frequency.value = f;
  b.Q.value = Q;
  return b;
}

function gain(c: Ctx, v = 0): GainNode {
  const g = c.createGain();
  g.gain.value = v;
  return g;
}

function osc(c: Ctx, type: OscillatorType, f: number, t0: number, dur: number): OscillatorNode {
  const o = c.createOscillator();
  o.type = type;
  o.frequency.value = f;
  o.start(t0);
  o.stop(t0 + dur);
  return o;
}

/** Percussive envelope: linear attack, exponential decay to silence, then hard 0. */
function perc(g: GainNode, t0: number, a: number, peak: number, d: number): void {
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + a);
  g.gain.exponentialRampToValueAtTime(EPS, t0 + a + d);
  g.gain.setValueAtTime(0, t0 + a + d + 0.001);
}

/** Connect nodes in series. The last element may be an AudioParam (LFO → frequency/gain modulation). */
function chain(first: AudioNode, ...rest: Array<AudioNode | AudioParam>): void {
  let prev = first;
  for (const n of rest) {
    // Duck-typed (AudioParam has no `connect`) so the node-side recipe test can use plain mocks.
    if ("connect" in n) {
      prev.connect(n);
      prev = n;
    } else {
      prev.connect(n);
      return;
    }
  }
}

/** tanh waveshaper: gives gunshots their bite without hard clipping. */
function softClip(c: Ctx, drive: number): WaveShaperNode {
  const ws = c.createWaveShaper();
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * drive) / Math.tanh(drive);
  }
  ws.curve = curve;
  ws.oversample = "2x";
  return ws;
}

interface BurstOpts {
  type?: BiquadFilterType;
  f?: number;
  Q?: number;
  a?: number;
  d?: number;
  peak?: number;
  color?: NoiseColor;
}
/** Short filtered noise burst: clicks, scuffs, droplets. */
function burst(c: Ctx, out: AudioNode, r: Rand, t0: number, o: BurstOpts): void {
  const { type = "bandpass", f = 3000, Q = 1, a = 0.0005, d = 0.01, peak = 1, color = "white" } = o;
  const g = gain(c);
  perc(g, t0, a, peak, d);
  chain(noise(c, color, r, t0, a + d + 0.02), filt(c, type, f, Q), g, out);
}

interface ToneOpts {
  type?: OscillatorType;
  f0: number;
  f1?: number;
  glide?: number;
  a?: number;
  d?: number;
  peak?: number;
}
/** Oscillator with optional exponential pitch glide and a percussive envelope. */
function tone(c: Ctx, out: AudioNode, t0: number, o: ToneOpts): void {
  const { type = "sine", f0, f1 = f0, glide = 0.05, a = 0.002, d = 0.1, peak = 1 } = o;
  const node = osc(c, type, f0, t0, a + d + 0.02);
  if (f1 !== f0) {
    node.frequency.setValueAtTime(f0, t0);
    node.frequency.exponentialRampToValueAtTime(f1, t0 + glide);
  }
  const g = gain(c);
  perc(g, t0, a, peak, d);
  chain(node, g, out);
}

/** Three inharmonic partials: a cheap "small metal part" ring. */
function metal(c: Ctx, out: AudioNode, r: Rand, t0: number, base: number, peak = 0.4, d = 0.05): void {
  for (const [m, k] of [
    [1, 1],
    [1.52, 0.6],
    [2.31, 0.4],
  ] as const) {
    tone(c, out, t0, { f0: base * m * (0.97 + r() * 0.06), a: 0.0005, d: d / m, peak: peak * k });
  }
}

/** Brown-noise rumble with random decaying bumps (thunder body). */
function rumble(c: Ctx, out: AudioNode, r: Rand, t0: number, dur: number, lp: number, peak: number, attack = 0.05): void {
  const g = gain(c, 0);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + attack);
  let t = t0 + attack;
  let level = peak;
  while (t < t0 + dur - 0.6) {
    t += 0.15 + r() * 0.35;
    level *= 0.82;
    g.gain.linearRampToValueAtTime(level * (0.4 + r() * 0.6), t);
  }
  g.gain.linearRampToValueAtTime(0, t0 + dur);
  chain(noise(c, "brown", r, t0, dur + 0.1), filt(c, "lowpass", lp, 0.8), g, out);
}

// ---------------------------------------------------------------- gunshots

/** Guns with a powder shot (Weapons v2 adds SMG, LMG, revolver; the crossbow has its own recipe). */
export type GunId = "pistol" | "rifle" | "shotgun" | "sniper" | "smg" | "lmg" | "revolver";
export interface GunParams {
  crackHz: number;
  crackMs: number;
  bodyLp: number;
  bodyMs: number;
  th0: number;
  th1: number;
  thMs: number;
  thG: number;
  tailLp: number;
  tailMs: number;
  tailG: number;
  echoMs: number;
  echoG: number;
  drive: number;
}

/** Per-weapon gunshot character. Heavier guns: lower thump, longer tail and echo, more drive. */
export const GUN_PARAMS: Record<GunId, GunParams> = {
  pistol: { crackHz: 2500, crackMs: 12, bodyLp: 3500, bodyMs: 80, th0: 160, th1: 60, thMs: 70, thG: 0.8, tailLp: 1200, tailMs: 450, tailG: 0.25, echoMs: 90, echoG: 0.25, drive: 2.0 },
  rifle: { crackHz: 3000, crackMs: 10, bodyLp: 4500, bodyMs: 60, th0: 140, th1: 55, thMs: 60, thG: 0.7, tailLp: 1500, tailMs: 500, tailG: 0.3, echoMs: 110, echoG: 0.25, drive: 2.2 },
  shotgun: { crackHz: 1800, crackMs: 18, bodyLp: 2500, bodyMs: 180, th0: 110, th1: 40, thMs: 160, thG: 1.0, tailLp: 900, tailMs: 900, tailG: 0.35, echoMs: 140, echoG: 0.3, drive: 2.6 },
  sniper: { crackHz: 4000, crackMs: 8, bodyLp: 3000, bodyMs: 160, th0: 90, th1: 35, thMs: 220, thG: 1.0, tailLp: 800, tailMs: 1400, tailG: 0.4, echoMs: 220, echoG: 0.35, drive: 2.8 },
  // Weapons v2: the SMG is a light, dry pop (quieter than the rifle), the LMG a heavier rifle with a
  // longer tail, the revolver a deep boom between the pistol and the shotgun.
  smg: { crackHz: 3300, crackMs: 7, bodyLp: 4200, bodyMs: 45, th0: 175, th1: 75, thMs: 45, thG: 0.55, tailLp: 1700, tailMs: 380, tailG: 0.22, echoMs: 85, echoG: 0.2, drive: 1.9 },
  lmg: { crackHz: 2800, crackMs: 11, bodyLp: 4000, bodyMs: 80, th0: 125, th1: 45, thMs: 90, thG: 0.85, tailLp: 1300, tailMs: 650, tailG: 0.33, echoMs: 130, echoG: 0.28, drive: 2.4 },
  revolver: { crackHz: 2200, crackMs: 14, bodyLp: 3200, bodyMs: 120, th0: 120, th1: 45, thMs: 110, thG: 0.95, tailLp: 1000, tailMs: 700, tailG: 0.32, echoMs: 150, echoG: 0.3, drive: 2.5 },
};
export const GUN_IDS = Object.keys(GUN_PARAMS) as GunId[];

/**
 * Gunshot = 5 layers through a tanh soft-clip: crack, body, thump, tail, slapback echo.
 * The far take drops the crack, halves the thump, stretches the tail and lowpasses everything:
 * distance eats the highs first, which is what makes a far shot read as far.
 */
export function gunshot(c: Ctx, out: AudioNode, r: Rand, p: GunParams, far = false): void {
  const jit = (v: number, k = 0.08) => v * (1 + (r() * 2 - 1) * k);
  const sum = gain(c, 1);
  const clip = softClip(c, p.drive);
  let dst: AudioNode = out;
  if (far) {
    const lp = filt(c, "lowpass", p.bodyLp > 3000 ? 900 : 600, 0.5);
    lp.connect(out);
    dst = lp;
  }
  chain(sum, clip, dst);
  // 1. supersonic crack / mechanical transient
  if (!far) burst(c, sum, r, 0, { type: "highpass", f: jit(p.crackHz), Q: 0.7, a: 0.0003, d: p.crackMs / 1000, peak: 0.9 });
  // 2. body: broadband blast
  const bodyG = gain(c);
  perc(bodyG, 0, 0.001, 1.0, (jit(p.bodyMs) / 1000) * (far ? 1.6 : 1));
  chain(noise(c, "white", r, 0, 1), filt(c, "lowpass", jit(p.bodyLp), 0.8), bodyG, sum);
  // 3. low thump (pressure wave) with a pitch drop
  tone(c, sum, 0, { f0: jit(p.th0), f1: p.th1, glide: p.thMs / 1000, a: 0.001, d: p.thMs / 1000, peak: p.thG * (far ? 0.5 : 1) });
  // 4. reverberant tail
  const tailG = gain(c);
  perc(tailG, 0.004, 0.012, p.tailG * (far ? 1.6 : 1), jit(p.tailMs) / 1000);
  chain(noise(c, "pink", r, 0, 2.5), filt(c, "lowpass", jit(p.tailLp), 0.6), tailG, sum);
  // 5. slapback echo from the surroundings (feedback loop needs the DelayNode in the cycle)
  const dl = c.createDelay(1);
  dl.delayTime.value = jit(p.echoMs, 0.2) / 1000;
  const fb = gain(c, 0.3);
  const echoLp = filt(c, "lowpass", 1500);
  const eg = gain(c, p.echoG);
  bodyG.connect(dl);
  chain(dl, echoLp, fb, dl);
  chain(echoLp, eg, sum);
}

/**
 * Weapons v2 crossbow: no powder, so no crack or echo — the string's twang (a plucked, quickly
 * damped low tone with a buzz), the limbs' wooden thwack and the bolt's short hiss. Quiet by
 * design (shared soundRadius 450 px).
 */
export function crossbowShot(c: Ctx, out: AudioNode, r: Rand): void {
  const j = (v: number, k = 0.06) => v * (1 + (r() * 2 - 1) * k);
  // Thwack of the limbs.
  burst(c, out, r, 0, { f: j(900), Q: 1.4, a: 0.0005, d: 0.05, peak: 1, color: "pink" });
  tone(c, out, 0, { f0: j(220), f1: 120, glide: 0.04, a: 0.001, d: 0.06, peak: 0.6 });
  // String twang: a sawtooth pluck through a closing lowpass.
  const g = gain(c);
  perc(g, 0.002, 0.002, 0.55, 0.22);
  const lp = filt(c, "lowpass", 2600, 2.5);
  lp.frequency.setValueAtTime(2600, 0.002);
  lp.frequency.exponentialRampToValueAtTime(380, 0.2);
  const s0 = osc(c, "sawtooth", j(150, 0.04), 0.002, 0.26);
  s0.frequency.setValueAtTime(j(150, 0.04), 0.002);
  s0.frequency.exponentialRampToValueAtTime(118, 0.2);
  chain(s0, lp, g, out);
  // The bolt leaving: a short airy hiss.
  burst(c, out, r, 0.01, { type: "highpass", f: j(4500), a: 0.01, d: 0.09, peak: 0.25 });
}

/**
 * Weapons v2 hand grenade blast: a hard broadband crack, a deep pressure thump with a pitch drop,
 * a long rolling rumble and debris patter. The far take loses the crack and the debris (distance
 * eats the highs) and keeps the rumble.
 */
export function explosion(c: Ctx, out: AudioNode, r: Rand, far = false): void {
  const sum = gain(c, 1);
  const clip = softClip(c, far ? 2.2 : 3.2);
  let dst: AudioNode = out;
  if (far) {
    const lp = filt(c, "lowpass", 420, 0.6);
    lp.connect(out);
    dst = lp;
  }
  chain(sum, clip, dst);
  if (!far) burst(c, sum, r, 0, { type: "highpass", f: 1800, a: 0.0004, d: 0.03, peak: 1 });
  const bodyG = gain(c);
  perc(bodyG, 0, 0.002, 1, far ? 0.5 : 0.35);
  chain(noise(c, "white", r, 0, 1), filt(c, "lowpass", far ? 900 : 2600, 0.7), bodyG, sum);
  tone(c, sum, 0, { f0: 85, f1: 28, glide: 0.45, a: 0.002, d: 0.6, peak: far ? 0.8 : 1.1 });
  rumble(c, sum, r, 0.04, far ? 2.4 : 2.0, far ? 220 : 380, far ? 0.9 : 0.75, 0.03);
  if (!far) {
    // Debris: small clicks raining down for half a second.
    for (let i = 0; i < 14; i++) {
      const t = 0.12 + r() * 0.6;
      burst(c, sum, r, t, { f: 1500 + r() * 2500, Q: 2, a: 0.0003, d: 0.006 + r() * 0.01, peak: 0.15 + r() * 0.2 });
    }
  }
}

// ---------------------------------------------------------------- footsteps

export type StepMaterial = "grass" | "dirt" | "asphalt" | "wood" | "concrete" | "water";
/** Order matters: footsteps.ts uses the index as the wire variant fallback. */
export const STEP_MATERIALS: readonly StepMaterial[] = ["grass", "dirt", "asphalt", "wood", "concrete", "water"];

export function step(c: Ctx, out: AudioNode, r: Rand, surface: StepMaterial): void {
  const j = (v: number) => v * (0.9 + r() * 0.2);
  switch (surface) {
    case "grass":
      burst(c, out, r, 0, { f: j(1800), Q: 0.8, a: 0.005, d: j(0.07), peak: 0.8, color: "pink" });
      for (let i = 0; i < 3; i++) burst(c, out, r, 0.005 + r() * 0.05, { type: "highpass", f: 4000, a: 0.002, d: 0.015, peak: 0.25 });
      break;
    case "dirt":
      burst(c, out, r, 0, { type: "lowpass", f: j(1400), Q: 0.7, a: 0.004, d: j(0.05), peak: 0.9, color: "brown" });
      for (let i = 0; i < 6; i++) burst(c, out, r, r() * 0.045, { f: 2000 + r() * 1500, Q: 2, a: 0.0003, d: 0.002, peak: 0.3 + r() * 0.3 });
      break;
    case "asphalt":
      burst(c, out, r, 0, { f: j(2200), Q: 1.5, a: 0.0005, d: 0.025, peak: 1 });
      tone(c, out, 0, { f0: 140, f1: 90, glide: 0.03, a: 0.001, d: 0.03, peak: 0.5 });
      burst(c, out, r, j(0.045), { f: 2600, Q: 1.5, a: 0.0005, d: 0.015, peak: 0.4 });
      break;
    case "wood":
      burst(c, out, r, 0, { f: j(420), Q: 8, a: 0.0005, d: j(0.11), peak: 1 });
      burst(c, out, r, 0, { f: j(900), Q: 5, a: 0.0005, d: 0.06, peak: 0.5 });
      tone(c, out, 0, { f0: j(110), f1: 90, glide: 0.08, a: 0.002, d: 0.08, peak: 0.5 });
      break;
    case "concrete": {
      const sum = gain(c, 1);
      sum.connect(out);
      const dl = c.createDelay(0.1);
      dl.delayTime.value = 0.025;
      chain(sum, dl, gain(c, 0.25), out);
      burst(c, sum, r, 0, { f: j(1600), Q: 1.2, a: 0.0005, d: 0.035, peak: 1 });
      burst(c, sum, r, 0.01, { type: "highpass", f: 5000, a: 0.002, d: 0.02, peak: 0.3 });
      break;
    }
    case "water":
      burst(c, out, r, 0, { type: "highpass", f: j(1200), a: 0.006, d: 0.12, peak: 0.8 });
      tone(c, out, 0.02, { f0: j(500), f1: 900, glide: 0.04, a: 0.003, d: 0.04, peak: 0.3 });
      tone(c, out, 0.06, { f0: j(700), f1: 1200, glide: 0.03, a: 0.003, d: 0.03, peak: 0.2 });
      break;
  }
}

// ---------------------------------------------------------------- one-shots

type Build = (c: Ctx, out: AudioNode, r: Rand) => void;

export const misc = {
  reload_out(c, out, r) {
    burst(c, out, r, 0, { f: 3500, Q: 3, a: 0.0003, d: 0.004, peak: 1 });
    metal(c, out, r, 0, 2100, 0.3, 0.04);
    burst(c, out, r, 0.02, { f: 1500, Q: 0.8, a: 0.01, d: 0.08, peak: 0.25, color: "pink" });
  },
  reload_in(c, out, r) {
    burst(c, out, r, 0, { f: 3000, Q: 3, a: 0.0003, d: 0.004, peak: 0.6 });
    burst(c, out, r, 0.06, { f: 2600, Q: 2, a: 0.0003, d: 0.008, peak: 1 });
    tone(c, out, 0.06, { f0: 300, f1: 200, glide: 0.03, d: 0.03, peak: 0.5 });
    metal(c, out, r, 0.06, 1800, 0.25, 0.05);
  },
  /** Shotgun pump / sniper bolt; also plays after each sniper or shotgun shot. */
  rack(c, out, r) {
    const g = gain(c);
    perc(g, 0, 0.04, 0.6, 0.09);
    const bp = filt(c, "bandpass", 800, 1.2);
    bp.frequency.setValueAtTime(800, 0);
    bp.frequency.exponentialRampToValueAtTime(2500, 0.12);
    chain(noise(c, "white", r, 0, 0.2), bp, g, out);
    burst(c, out, r, 0.14, { f: 2800, Q: 2, a: 0.0003, d: 0.01, peak: 1 });
    metal(c, out, r, 0.14, 1800, 0.35, 0.06);
  },
  /** Weapons v2: pulling the pin of a hand grenade (ring ping, spoon flick) and the throw's swish. */
  grenade_pin(c, out, r) {
    metal(c, out, r, 0, 3200, 0.35, 0.05);
    burst(c, out, r, 0, { f: 4200, Q: 3, a: 0.0003, d: 0.004, peak: 0.8 });
    burst(c, out, r, 0.09, { f: 2500, Q: 2.5, a: 0.0003, d: 0.006, peak: 0.6 });
    metal(c, out, r, 0.09, 1900, 0.25, 0.06);
    const g = gain(c);
    perc(g, 0.16, 0.05, 0.45, 0.12);
    const bp = filt(c, "bandpass", 700, 0.8);
    bp.frequency.setValueAtTime(700, 0.16);
    bp.frequency.exponentialRampToValueAtTime(2200, 0.32);
    chain(noise(c, "pink", r, 0.16, 0.25), bp, g, out);
  },
  /** Weapons v2: a hand grenade hitting a wall / the floor — a dull metal clonk with a rattle. */
  grenade_bounce(c, out, r) {
    burst(c, out, r, 0, { type: "lowpass", f: 1400, a: 0.0005, d: 0.03, peak: 0.9, color: "pink" });
    tone(c, out, 0, { f0: 320, f1: 210, glide: 0.04, a: 0.0008, d: 0.05, peak: 0.6 });
    metal(c, out, r, 0.002, 1100, 0.3, 0.09);
    burst(c, out, r, 0.07, { f: 2400, Q: 2, a: 0.0003, d: 0.006, peak: 0.35 });
  },
  dry_fire(c, out, r) {
    burst(c, out, r, 0, { type: "highpass", f: 6000, a: 0.0002, d: 0.0015, peak: 1 });
    tone(c, out, 0, { f0: 4000, a: 0.0003, d: 0.015, peak: 0.25 });
  },
  /** Weapon switch: cloth swish as the gun leaves the hand, then two small latch clicks. */
  weapon_switch(c, out, r) {
    const g = gain(c);
    perc(g, 0, 0.05, 0.5, 0.08);
    const bp = filt(c, "bandpass", 1200, 0.9);
    bp.frequency.setValueAtTime(1200, 0);
    bp.frequency.exponentialRampToValueAtTime(2600, 0.12);
    chain(noise(c, "pink", r, 0, 0.18), bp, g, out);
    burst(c, out, r, 0.13, { f: 3200, Q: 3, a: 0.0003, d: 0.005, peak: 0.9 });
    metal(c, out, r, 0.13, 2400, 0.2, 0.03);
    burst(c, out, r, 0.19, { f: 2700, Q: 2, a: 0.0003, d: 0.006, peak: 0.7 });
  },
  hit_flesh(c, out, r) {
    burst(c, out, r, 0, { type: "lowpass", f: 900, a: 0.001, d: 0.06, peak: 1 });
    tone(c, out, 0, { f0: 180, f1: 70, glide: 0.05, d: 0.05, peak: 0.8 });
    burst(c, out, r, 0.005, { type: "highpass", f: 3000, a: 0.001, d: 0.02, peak: 0.25 });
  },
  hit_armor(c, out, r) {
    burst(c, out, r, 0, { type: "highpass", f: 3000, a: 0.0003, d: 0.006, peak: 0.8 });
    const decay = [0.2, 0.15, 0.11, 0.08];
    const peaks = [0.5, 0.35, 0.25, 0.15];
    [1250, 2730, 4120, 5600].forEach((f, i) => tone(c, out, 0, { f0: f * (0.98 + r() * 0.04), a: 0.0005, d: decay[i]!, peak: peaks[i]! }));
  },
  hitmarker(c, out) {
    tone(c, out, 0, { f0: 2600, f1: 2200, glide: 0.025, a: 0.001, d: 0.04, peak: 0.7 });
    tone(c, out, 0, { type: "triangle", f0: 5200, a: 0.0005, d: 0.015, peak: 0.2 });
  },
  kill_confirm(c, out) {
    for (const [t, f] of [
      [0, 1318.5],
      [0.07, 1975.5],
    ] as const) {
      tone(c, out, t, { f0: f, a: 0.002, d: 0.18, peak: 0.6 });
      tone(c, out, t, { type: "triangle", f0: f * 2, a: 0.002, d: 0.08, peak: 0.15 });
    }
  },
  body_fall(c, out, r) {
    tone(c, out, 0, { f0: 90, f1: 40, glide: 0.18, a: 0.003, d: 0.18, peak: 1 });
    burst(c, out, r, 0, { type: "lowpass", f: 600, a: 0.004, d: 0.2, peak: 0.7, color: "brown" });
    for (let i = 0; i < 5; i++) burst(c, out, r, 0.06 + r() * 0.16, { f: 2500 + r() * 1500, Q: 3, a: 0.0003, d: 0.006, peak: 0.2 + r() * 0.2 });
  },
  chest_open(c, out, r) {
    burst(c, out, r, 0, { f: 3200, Q: 3, a: 0.0003, d: 0.005, peak: 0.7 }); // latch
    // Hinge creak: sawtooth with 9 Hz FM through a narrow bandpass.
    const saw = osc(c, "sawtooth", 140, 0.03, 0.5);
    const lfo = osc(c, "sine", 9, 0.03, 0.5);
    chain(lfo, gain(c, 25), saw.frequency);
    saw.frequency.setValueAtTime(140, 0.03);
    saw.frequency.linearRampToValueAtTime(190, 0.45);
    const g = gain(c);
    g.gain.setValueAtTime(0, 0.03);
    g.gain.linearRampToValueAtTime(0.35, 0.08);
    g.gain.linearRampToValueAtTime(0.25, 0.4);
    g.gain.exponentialRampToValueAtTime(EPS, 0.5);
    chain(saw, filt(c, "bandpass", 900, 4), g, out);
    tone(c, out, 0.48, { f0: 120, f1: 70, glide: 0.08, d: 0.1, peak: 0.6 }); // lid thud
    burst(c, out, r, 0.48, { type: "lowpass", f: 700, a: 0.002, d: 0.09, peak: 0.5, color: "brown" });
  },
  /** Backpack zipper, ~0.9 s: 34 clicks with a slow-fast-slow rate curve. */
  zipper(c, out, r) {
    let t = 0.02;
    const n = 34;
    for (let i = 0; i < n; i++) {
      const u = i / n;
      t += 0.012 + 0.03 * Math.abs(u - 0.5);
      burst(c, out, r, t, { f: 4200 + r() * 1200, Q: 2, a: 0.0002, d: 0.003, peak: 0.5 + r() * 0.5 });
    }
  },
  /** Bush rustle (stepBush layer): amplitude-stepped pink noise. */
  rustle(c, out, r) {
    const g = gain(c, 0);
    g.gain.setValueAtTime(0, 0);
    let t = 0;
    while (t < 0.45) g.gain.linearRampToValueAtTime(r() * 0.6, (t += 0.02 + r() * 0.03));
    g.gain.linearRampToValueAtTime(0, 0.5);
    chain(noise(c, "pink", r, 0, 0.55), filt(c, "bandpass", 2500, 0.7), g, out);
  },
  /** Corpse / container search, ~1 s: cloth rummage plus a few small item clinks. Repeats while searching. */
  search(c, out, r) {
    const g = gain(c, 0);
    g.gain.setValueAtTime(0, 0);
    let t = 0;
    while (t < 0.85) g.gain.linearRampToValueAtTime(0.15 + r() * 0.45, (t += 0.04 + r() * 0.06));
    g.gain.linearRampToValueAtTime(0, 0.95);
    chain(noise(c, "pink", r, 0, 1), filt(c, "bandpass", 1600, 0.6), g, out);
    for (let i = 0; i < 4; i++) {
      const at = 0.1 + r() * 0.7;
      burst(c, out, r, at, { f: 2800 + r() * 1500, Q: 3, a: 0.0003, d: 0.006, peak: 0.4 + r() * 0.3 });
      if (r() < 0.5) metal(c, out, r, at, 1500 + r() * 1500, 0.12, 0.04);
    }
  },
  roll(c, out, r) {
    const bp = filt(c, "bandpass", 400, 1.2);
    bp.frequency.setValueAtTime(400, 0);
    bp.frequency.exponentialRampToValueAtTime(1800, 0.15);
    bp.frequency.exponentialRampToValueAtTime(500, 0.38);
    const g = gain(c);
    g.gain.setValueAtTime(0, 0);
    g.gain.linearRampToValueAtTime(0.8, 0.15);
    g.gain.exponentialRampToValueAtTime(EPS, 0.4);
    chain(noise(c, "white", r, 0, 0.45), bp, g, out);
    tone(c, out, 0.33, { f0: 100, f1: 60, glide: 0.06, d: 0.08, peak: 0.6 }); // landing
    burst(c, out, r, 0.33, { type: "lowpass", f: 800, a: 0.002, d: 0.08, peak: 0.5, color: "pink" });
  },
  /** Bandage: two quick cloth tears then a wrap swish. */
  heal_bandage(c, out, r) {
    for (const t0 of [0, 0.22]) {
      let t = t0;
      for (let i = 0; i < 14; i++) {
        burst(c, out, r, t, { type: "highpass", f: 2500 + r() * 2500, a: 0.0003, d: 0.006, peak: 0.4 + r() * 0.5 });
        t += 0.008 + r() * 0.008;
      }
    }
    const g = gain(c);
    perc(g, 0.45, 0.12, 0.4, 0.25);
    chain(noise(c, "pink", r, 0.45, 0.45), filt(c, "bandpass", 1800, 0.8), g, out);
  },
  /** Medkit: case latch, plastic clatter, syringe click + hiss. */
  heal_medkit(c, out, r) {
    burst(c, out, r, 0, { f: 3000, Q: 3, a: 0.0003, d: 0.005, peak: 0.8 });
    tone(c, out, 0.01, { f0: 260, f1: 180, glide: 0.04, d: 0.05, peak: 0.4 });
    for (let i = 0; i < 4; i++) burst(c, out, r, 0.12 + r() * 0.2, { f: 1800 + r() * 1200, Q: 4, a: 0.0003, d: 0.01, peak: 0.3 + r() * 0.3 });
    burst(c, out, r, 0.45, { type: "highpass", f: 5000, a: 0.0003, d: 0.003, peak: 1 });
    const g = gain(c);
    perc(g, 0.47, 0.02, 0.25, 0.3);
    chain(noise(c, "white", r, 0.47, 0.4), filt(c, "highpass", 6000), g, out);
  },
  siren(c, out) {
    const sum = gain(c, 1);
    const lp = filt(c, "lowpass", 2200);
    chain(sum, softClip(c, 1.8), lp, out);
    const dl = c.createDelay(1);
    dl.delayTime.value = 0.23;
    chain(lp, dl, gain(c, 0.3), out);
    for (const [type, det] of [
      ["sawtooth", 1],
      ["square", 1.005],
    ] as const) {
      const o = osc(c, type, 380 * det, 0, 3);
      o.frequency.setValueAtTime(380 * det, 0);
      o.frequency.linearRampToValueAtTime(820 * det, 1.4);
      o.frequency.linearRampToValueAtTime(380 * det, 2.8);
      const g = gain(c);
      g.gain.setValueAtTime(0, 0);
      g.gain.linearRampToValueAtTime(0.25, 0.2);
      g.gain.setValueAtTime(0.25, 2.5);
      g.gain.linearRampToValueAtTime(0, 2.95);
      chain(o, g, sum);
    }
  },
  extract_beep(c, out) {
    tone(c, out, 0, { f0: 880, a: 0.003, d: 0.12, peak: 0.7 });
    tone(c, out, 0, { type: "square", f0: 1760, a: 0.003, d: 0.05, peak: 0.08 });
  },
  extract_success(c, out, r) {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      tone(c, out, i * 0.08, { f0: f, a: 0.004, d: 0.35, peak: 0.45 });
      tone(c, out, i * 0.08, { type: "triangle", f0: f * 2, a: 0.004, d: 0.12, peak: 0.1 });
    });
    const bp = filt(c, "bandpass", 300, 1);
    bp.frequency.setValueAtTime(300, 0);
    bp.frequency.exponentialRampToValueAtTime(3000, 0.6);
    const g = gain(c);
    perc(g, 0, 0.4, 0.3, 0.3);
    chain(noise(c, "white", r, 0, 0.8), bp, g, out);
  },
  heartbeat(c, out, r) {
    for (const [t, k] of [
      [0, 1],
      [0.16, 0.7],
    ] as const) {
      tone(c, out, t, { f0: 60, f1: 45, glide: 0.08, a: 0.01, d: 0.09, peak: k });
      burst(c, out, r, t, { type: "lowpass", f: 120, a: 0.01, d: 0.08, peak: 0.5 * k, color: "brown" });
    }
  },
  ui_click(c, out, r) {
    tone(c, out, 0, { f0: 1400, f1: 900, glide: 0.025, a: 0.001, d: 0.035, peak: 0.6 });
    burst(c, out, r, 0, { type: "highpass", f: 5000, a: 0.0002, d: 0.002, peak: 0.3 });
  },
  ui_hover(c, out) {
    tone(c, out, 0, { f0: 2000, a: 0.001, d: 0.012, peak: 0.3 });
  },
  ui_coin(c, out) {
    for (const [t, f] of [
      [0, 987.77],
      [0.06, 1318.5],
    ] as const) {
      tone(c, out, t, { f0: f, a: 0.001, d: 0.3, peak: 0.5 });
      tone(c, out, t, { f0: f * 2.76, a: 0.001, d: 0.08, peak: 0.15 });
    }
  },
  ui_error(c, out) {
    const g = gain(c);
    perc(g, 0, 0.005, 0.3, 0.16);
    const lp = filt(c, "lowpass", 1200);
    lp.connect(g);
    g.connect(out);
    // Two squares 10 Hz apart beat against each other: reads as "nope".
    osc(c, "square", 160, 0, 0.2).connect(lp);
    osc(c, "square", 170, 0, 0.2).connect(lp);
  },
  /** Equip / slot drop: soft cloth thump + a small buckle click. */
  ui_equip(c, out, r) {
    tone(c, out, 0, { f0: 220, f1: 140, glide: 0.04, a: 0.002, d: 0.06, peak: 0.6 });
    burst(c, out, r, 0, { type: "lowpass", f: 1200, a: 0.002, d: 0.05, peak: 0.5, color: "pink" });
    burst(c, out, r, 0.035, { f: 3400, Q: 3, a: 0.0003, d: 0.006, peak: 0.6 });
  },
  /**
   * Boss alert sting, ~1.6 s: a detuned low brass stab (saw cluster a semitone apart through a
   * closing lowpass), a sub boom and a metal clang. Loud and non-spatial: "you've been spotted".
   */
  boss_sting(c, out, r) {
    const lp = filt(c, "lowpass", 2400, 2);
    lp.frequency.setValueAtTime(2400, 0);
    lp.frequency.exponentialRampToValueAtTime(260, 1.3);
    const g = gain(c);
    g.gain.setValueAtTime(0, 0);
    g.gain.linearRampToValueAtTime(0.55, 0.02);
    g.gain.linearRampToValueAtTime(0.4, 0.25);
    g.gain.exponentialRampToValueAtTime(EPS, 1.45);
    g.gain.setValueAtTime(0, 1.46);
    chain(lp, g, out);
    for (const f of [55, 58.27, 110, 155.56]) {
      const o = osc(c, "sawtooth", f * (0.995 + r() * 0.01), 0, 1.5);
      const k = gain(c, f < 100 ? 0.35 : 0.22);
      chain(o, k, lp);
    }
    tone(c, out, 0, { f0: 90, f1: 32, glide: 0.35, a: 0.004, d: 0.9, peak: 0.9 });
    burst(c, out, r, 0, { type: "lowpass", f: 900, a: 0.003, d: 0.25, peak: 0.6, color: "brown" });
    metal(c, out, r, 0.01, 420 + r() * 40, 0.25, 0.6);
  },
  /**
   * Boss-turf tension swell, ~6 s, no melody: a low two-tone drone (a minor-sixth apart) with a
   * slow tremolo, a rumble bed that breathes in and out, and two muffled heartbeat thumps.
   */
  boss_tension(c, out, r) {
    const dur = 5.8;
    const env = gain(c);
    env.gain.setValueAtTime(0, 0);
    env.gain.linearRampToValueAtTime(0.7, 2.2);
    env.gain.linearRampToValueAtTime(0.55, 4.0);
    env.gain.linearRampToValueAtTime(0, dur);
    const trem = gain(c, 0.75);
    chain(osc(c, "sine", 0.9 + r() * 0.3, 0, dur), gain(c, 0.25), trem.gain);
    chain(trem, env, out);
    const lp = filt(c, "lowpass", 420, 0.9);
    lp.connect(trem);
    for (const [f, k] of [
      [41.2, 0.5],
      [65.4, 0.28],
      [82.4, 0.12],
    ] as const) {
      chain(osc(c, "triangle", f * (0.997 + r() * 0.006), 0, dur), gain(c, k), lp);
    }
    chain(noise(c, "brown", r, 0, dur), filt(c, "lowpass", 180, 0.7), gain(c, 0.35), env);
    // Lub-dub, twice.
    for (const [t, peak] of [
      [1.6, 0.45],
      [1.85, 0.3],
      [3.9, 0.45],
      [4.15, 0.3],
    ] as const) {
      tone(c, out, t, { f0: 70, f1: 40, glide: 0.08, a: 0.004, d: 0.18, peak });
    }
  },
  thunder_near(c, out, r) {
    burst(c, out, r, 0, { type: "highpass", f: 1500, a: 0.002, d: 0.12, peak: 0.9 });
    burst(c, out, r, 0.03, { type: "lowpass", f: 2500, a: 0.004, d: 0.4, peak: 0.6 });
    rumble(c, out, r, 0.05, 5.3, 300, 1.0);
  },
  thunder_far(c, out, r) {
    rumble(c, out, r, 0, 5.3, 160, 0.8, 0.3);
  },
  /** One bird trill, ~0.5 s; the ambience director scatters these with random pan. */
  bird(c, out, r) {
    const notes = 3 + Math.floor(r() * 4);
    let t = 0;
    const base = 2500 + r() * 1500;
    for (let i = 0; i < notes; i++) {
      const d = 0.05 + r() * 0.06;
      const o = osc(c, "sine", base, t, d + 0.02);
      o.frequency.setValueAtTime(base * (0.9 + r() * 0.2), t);
      o.frequency.exponentialRampToValueAtTime(base * (1.3 + r() * 0.4), t + d * 0.5);
      o.frequency.exponentialRampToValueAtTime(base * (0.9 + r() * 0.2), t + d);
      const g = gain(c);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.5, t + 0.005);
      g.gain.linearRampToValueAtTime(0, t + d);
      chain(o, g, out);
      t += d + 0.02 + r() * 0.04;
    }
  },
} satisfies Record<string, Build>;

// ---------------------------------------------------------------- ambient loops

type LoopBuild = (c: Ctx, out: AudioNode, r: Rand, dur: number) => void;
export const loops = {
  wind(c, out, r, dur) {
    const bp = filt(c, "bandpass", 450, 0.6);
    chain(osc(c, "sine", 0.17, 0, dur), gain(c, 180), bp.frequency);
    const g = gain(c, 0.7);
    chain(osc(c, "sine", 0.23, 0, dur), gain(c, 0.3), g.gain);
    chain(noise(c, "brown", r, 0, dur), bp, g, out);
    // Faint narrow-band whistle on top.
    chain(noise(c, "white", r, 0, dur), filt(c, "bandpass", 1200, 8), gain(c, 0.05), out);
  },
  rain(c, out, r, dur) {
    chain(noise(c, "pink", r, 0, dur), filt(c, "highpass", 600), filt(c, "lowpass", 8000), gain(c, 0.5), out);
    for (let i = 0; i < dur * 30; i++) burst(c, out, r, r() * (dur - 0.02), { f: 3000 + r() * 3000, Q: 1.5, a: 0.0003, d: 0.003, peak: 0.1 + r() * 0.3 });
  },
  crickets(c, out, r, dur) {
    for (const pitch of [4400, 4900]) {
      let t = r() * 0.5;
      while (t < dur - 0.3) {
        for (let p = 0; p < 3; p++) tone(c, out, t + p * 0.035, { f0: pitch, a: 0.004, d: 0.02, peak: 0.25 });
        t += 0.45 + r() * 0.45;
      }
    }
  },
} satisfies Record<string, LoopBuild>;

// ---------------------------------------------------------------- registry

/** Extra render time for loops; bake.ts crossfades it into the head so the loop has no seam. */
export const LOOP_XFADE_S = 0.5;
const LOOP_DUR = 6;

type DefOpts = Omit<SfxDef, "build" | "variants" | "jitter"> & { variants?: number; jitter?: number };
function def(build: Build, o: DefOpts): SfxDef {
  return { variants: 1, jitter: 0.02, ...o, build };
}
function gunDef(w: GunId, far: boolean): SfxDef {
  const p = GUN_PARAMS[w];
  // The sniper's echo tail was still at -43 dB with only +0.5 s (measured on /dev/sfx), so +1 s.
  const extra = w === "sniper" ? 1.0 : 0;
  return def((c, o, r) => gunshot(c, o, r, p, far), {
    dur: (p.tailMs / 1000) * (far ? 1.6 : 1) + 0.3 + extra,
    variants: far ? 2 : 4,
    db: far ? -4 : 0,
    bus: "sfx",
    cls: "gun",
    priority: 3,
    jitter: 0.02,
    group: "guns",
  });
}
function stepDef(m: StepMaterial): SfxDef {
  return def((c, o, r) => step(c, o, r, m), { dur: 0.2, variants: 4, db: -14, bus: "sfx", cls: "step", priority: 1, jitter: 0.04, group: "steps" });
}
function loopDef(build: LoopBuild, db: number): SfxDef {
  return def((c, o, r) => build(c, o, r, LOOP_DUR + LOOP_XFADE_S), { dur: LOOP_DUR, loop: true, db, bus: "ambience", cls: "other", priority: 0, jitter: 0, group: "loops" });
}

const sfx = (build: Build, dur: number, db: number, group: SfxDef["group"], priority = 2, extra: Partial<DefOpts> = {}) =>
  def(build, { dur, db, bus: "sfx", cls: "other", priority, group, ...extra });
const ui = (build: Build, dur: number, db: number) => def(build, { dur, db, bus: "ui", cls: "other", priority: 5, jitter: 0, group: "ui" });

/**
 * The bank. `db` is the immersion memo's mix table; steps are tuned for remote listeners (-14) and
 * footsteps.ts lowers your own steps by a further 8 dB (self -22).
 */
export const SFX = {
  gun_pistol: gunDef("pistol", false),
  gun_pistol_far: gunDef("pistol", true),
  gun_rifle: gunDef("rifle", false),
  gun_rifle_far: gunDef("rifle", true),
  gun_shotgun: gunDef("shotgun", false),
  gun_shotgun_far: gunDef("shotgun", true),
  gun_sniper: gunDef("sniper", false),
  gun_sniper_far: gunDef("sniper", true),
  // Weapons v2.
  gun_smg: gunDef("smg", false),
  gun_smg_far: gunDef("smg", true),
  gun_lmg: gunDef("lmg", false),
  gun_lmg_far: gunDef("lmg", true),
  gun_revolver: gunDef("revolver", false),
  gun_revolver_far: gunDef("revolver", true),
  /** No far take: at 450 px a crossbow is never heard far away. */
  gun_crossbow: def(crossbowShot, { dur: 0.45, variants: 3, db: -5, bus: "sfx", cls: "gun", priority: 3, jitter: 0.03, group: "guns" }),
  explosion: def((c, o, r) => explosion(c, o, r, false), { dur: 2.6, variants: 2, db: 0, bus: "sfx", cls: "gun", priority: 4, jitter: 0.03, group: "guns" }),
  explosion_far: def((c, o, r) => explosion(c, o, r, true), { dur: 3.0, variants: 2, db: -4, bus: "sfx", cls: "gun", priority: 4, jitter: 0.03, group: "guns" }),
  grenade_pin: sfx(misc.grenade_pin, 0.45, -10, "weapon"),
  grenade_bounce: sfx(misc.grenade_bounce, 0.25, -8, "weapon", 2, { variants: 3, jitter: 0.05 }),

  step_grass: stepDef("grass"),
  step_dirt: stepDef("dirt"),
  step_asphalt: stepDef("asphalt"),
  step_wood: stepDef("wood"),
  step_concrete: stepDef("concrete"),
  step_water: stepDef("water"),

  reload_out: sfx(misc.reload_out, 0.3, -12, "weapon"),
  reload_in: sfx(misc.reload_in, 0.3, -12, "weapon"),
  rack: sfx(misc.rack, 0.3, -12, "weapon"),
  dry_fire: sfx(misc.dry_fire, 0.1, -14, "weapon"),
  weapon_switch: sfx(misc.weapon_switch, 0.3, -12, "weapon"),

  hit_flesh: sfx(misc.hit_flesh, 0.2, -6, "hits", 4, { variants: 3, jitter: 0.04 }),
  hit_armor: sfx(misc.hit_armor, 0.3, -8, "hits", 4, { variants: 3, jitter: 0.04 }),
  hitmarker: ui(misc.hitmarker, 0.1, -10),
  kill_confirm: ui(misc.kill_confirm, 0.35, -8),
  body_fall: sfx(misc.body_fall, 0.4, -6, "hits", 2, { variants: 3, jitter: 0.04 }),

  chest_open: sfx(misc.chest_open, 0.65, -8, "interact"),
  zipper: sfx(misc.zipper, 1.0, -12, "interact"),
  rustle: sfx(misc.rustle, 0.55, -12, "interact", 1, { variants: 3, jitter: 0.04 }),
  search: sfx(misc.search, 1.0, -12, "interact", 2, { variants: 3, jitter: 0.03 }),
  roll: sfx(misc.roll, 0.45, -12, "interact", 2, { jitter: 0.03 }),
  heal_bandage: sfx(misc.heal_bandage, 0.8, -12, "interact"),
  heal_medkit: sfx(misc.heal_medkit, 0.85, -12, "interact"),

  // 3.3 s: the 230 ms echo of the last sweep rings past the 2.95 s oscillator fade.
  siren: sfx(misc.siren, 3.3, -10, "extract", 3, { jitter: 0 }),
  extract_beep: ui(misc.extract_beep, 0.2, -10),
  extract_success: ui(misc.extract_success, 0.9, -6),
  heartbeat: ui(misc.heartbeat, 0.35, -8),
  // Boss presentation (boss-hud.ts): the alert sting and the boss-turf tension swell.
  boss_sting: ui(misc.boss_sting, 1.6, -6),
  boss_tension: sfx(misc.boss_tension, 6, -14, "extract", 2, { jitter: 0 }),

  ui_click: ui(misc.ui_click, 0.08, -14),
  ui_hover: ui(misc.ui_hover, 0.05, -24),
  ui_coin: ui(misc.ui_coin, 0.45, -10),
  ui_error: ui(misc.ui_error, 0.25, -14),
  ui_equip: ui(misc.ui_equip, 0.15, -12),

  thunder_near: def(misc.thunder_near, { dur: 5.5, db: -2, bus: "ambience", cls: "other", priority: 3, jitter: 0.03, group: "weather", variants: 2 }),
  thunder_far: def(misc.thunder_far, { dur: 5.5, db: -8, bus: "ambience", cls: "other", priority: 1, jitter: 0.03, group: "weather", variants: 2 }),
  bird: def(misc.bird, { dur: 0.7, db: -22, bus: "ambience", cls: "other", priority: 0, jitter: 0.04, group: "weather", variants: 3 }),

  loop_wind: loopDef(loops.wind, -20),
  loop_rain: loopDef(loops.rain, -14),
  loop_crickets: loopDef(loops.crickets, -24),
} satisfies Record<string, SfxDef>;

export type SfxId = keyof typeof SFX;
export const SFX_IDS = Object.keys(SFX) as SfxId[];

export function isSfxId(id: string): id is SfxId {
  return Object.prototype.hasOwnProperty.call(SFX, id);
}

/** `gun_rifle` → `gun_rifle_far` when the bank has a far take, else null. */
export function farVariantOf(id: SfxId): SfxId | null {
  const far = `${id}_far`;
  return isSfxId(far) ? far : null;
}

/** Deterministic seed per (id, variant): the same build always bakes the same sample. */
export function seedFor(id: string, variant: number, seed = 1): number {
  return (Math.imul(seed, 7919) + Math.imul(variant, 104729) + hashId(id)) | 0;
}
