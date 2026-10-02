/**
 * Bake the procedural bank: each recipe variant is rendered once in an OfflineAudioContext, then
 * normalized to -1 dBFS (DC removed), loops crossfaded seamlessly, one-shots trimmed below -60 dB
 * and given a 5 ms end fade so they never click. Gameplay then only plays buffers (cheap, predictable).
 *
 * The PoC measured 41 sounds / 85 buffers in ~0.5 s on an M3 Pro. We await between sounds so a bake
 * never holds the main thread for more than one sound's graph build.
 *
 * Only `bakeOne`/`bakeAll` need a browser; the sample-processing helpers are pure and unit-tested.
 */
import { LOOP_XFADE_S, SFX, SFX_IDS, mulberry32, seedFor, type SfxDef, type SfxId } from "./recipes";

export const DEFAULT_SAMPLE_RATE = 48000;
/** -1 dBFS: headroom so inter-sample peaks and the variant rate jitter can't clip a single voice. */
export const NORMALIZE_PEAK = 0.891;
/** Trailing samples quieter than this (relative to full scale, after normalizing) are dropped. */
export const TRIM_DB = -60;
export const END_FADE_MS = 5;

/** Remove DC and scale to NORMALIZE_PEAK. Returns the pre-normalize peak and the DC offset. */
export function normalize(d: Float32Array): { rawPeak: number; dc: number } {
  if (d.length === 0) return { rawPeak: 0, dc: 0 };
  let mean = 0;
  for (let i = 0; i < d.length; i++) mean += d[i]!;
  mean /= d.length;
  let peak = 0;
  for (let i = 0; i < d.length; i++) {
    const v = d[i]! - mean;
    d[i] = v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  const k = peak > 0 ? NORMALIZE_PEAK / peak : 0;
  for (let i = 0; i < d.length; i++) d[i] *= k;
  return { rawPeak: peak, dc: mean };
}

/**
 * Loops are rendered `extra` samples longer than their loop length; the extra tail is crossfaded
 * into the head, so sample[n-1] → sample[0] continues the same waveform (no seam click).
 */
export function crossfadeLoop(d: Float32Array, loopLen: number): Float32Array {
  const n = Math.min(loopLen, d.length);
  const x = Math.min(d.length - n, n);
  const out = d.slice(0, n);
  for (let i = 0; i < x; i++) {
    const k = i / x;
    out[i] = d[i]! * k + d[n + i]! * (1 - k);
  }
  return out;
}

/** Index one past the last sample louder than `db` (dBFS); keeps at least 1 sample. */
export function trimEnd(d: Float32Array, db = TRIM_DB): number {
  const thr = Math.pow(10, db / 20);
  for (let i = d.length - 1; i >= 0; i--) if (Math.abs(d[i]!) > thr) return i + 1;
  return Math.min(1, d.length);
}

/** Linear fade over the last `ms` so a one-shot ends at exactly zero. */
export function fadeEnd(d: Float32Array, sampleRate: number, ms = END_FADE_MS): void {
  const f = Math.min(d.length, Math.floor((sampleRate * ms) / 1000));
  for (let i = 0; i < f; i++) d[d.length - 1 - i] *= i / f;
}

/** Full post-processing of one rendered take. Pure: also used by the tests on synthetic data. */
export function finishTake(raw: Float32Array, def: Pick<SfxDef, "dur" | "loop">, sampleRate: number): Float32Array {
  let d = raw;
  if (def.loop) d = crossfadeLoop(raw, Math.ceil(def.dur * sampleRate));
  normalize(d);
  if (!def.loop) {
    // Keep a small tail past the -60 dB point so the fade itself is not cut short.
    const end = Math.min(d.length, trimEnd(d) + Math.floor(sampleRate * 0.01));
    if (end < d.length) d = d.slice(0, end);
    fadeEnd(d, sampleRate);
  }
  return d;
}

export interface TakeStats {
  peakDb: number;
  rmsDb: number;
  /** RMS of the first 100 ms: the "punch" a listener judges loudness by. */
  rms100Db: number;
  /** Peak of the last 10 ms (a loud tail means the buffer is too short). */
  tailDb: number;
  /** Last sample above -50 dBFS, ms. */
  activeMs: number;
  durMs: number;
  nan: number;
  /** Loops only: |last − first| sample jump. */
  seam?: number;
}

// "+ 0" turns -0 into 0 so a full-scale peak reads "0.0", not "-0.0".
const toDb = (x: number) => (x > 0 ? Math.round(200 * Math.log10(x)) / 10 + 0 : -Infinity);

export function takeStats(d: Float32Array, sampleRate: number, loop = false): TakeStats {
  let peak = 0;
  let sum = 0;
  let sum100 = 0;
  let nan = 0;
  const n100 = Math.min(d.length, Math.floor(sampleRate * 0.1));
  for (let i = 0; i < d.length; i++) {
    const v = d[i]!;
    if (!Number.isFinite(v)) {
      nan++;
      continue;
    }
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sum += v * v;
    if (i < n100) sum100 += v * v;
  }
  const tailN = Math.min(d.length, Math.floor(sampleRate * 0.01));
  let tail = 0;
  for (let i = d.length - tailN; i < d.length; i++) tail = Math.max(tail, Math.abs(d[i]!));
  let last = 0;
  for (let i = d.length - 1; i >= 0; i--) {
    if (Math.abs(d[i]!) > 0.00316) {
      last = i;
      break;
    }
  }
  return {
    peakDb: toDb(peak),
    rmsDb: toDb(Math.sqrt(sum / Math.max(1, d.length))),
    rms100Db: toDb(Math.sqrt(sum100 / Math.max(1, n100))),
    tailDb: toDb(tail),
    activeMs: Math.round((last / sampleRate) * 1000),
    durMs: Math.round((d.length / sampleRate) * 1000),
    nan,
    seam: loop && d.length > 1 ? Math.round(Math.abs(d[0]! - d[d.length - 1]!) * 1e4) / 1e4 : undefined,
  };
}

/**
 * Bake order: UI first (tiny, and the menus want them immediately), then guns and steps (the
 * gameplay-critical cues), then everything else, loops last (rain is the slowest recipe).
 */
export function bakeOrder(ids: readonly SfxId[] = SFX_IDS): SfxId[] {
  const rank = (id: SfxId) => {
    const g = SFX[id].group;
    if (g === "ui") return 0;
    if (g === "guns") return 1;
    if (g === "steps") return 2;
    if (g === "hits" || g === "weapon") return 3;
    if (g === "loops") return 5;
    return 4;
  };
  return [...ids].sort((a, b) => rank(a) - rank(b));
}

/** Render one variant of one sound (browser only). */
export async function bakeOne(id: SfxId, variant: number, sampleRate = DEFAULT_SAMPLE_RATE, seed = 1): Promise<Float32Array> {
  const def: SfxDef = SFX[id];
  const extra = def.loop ? LOOP_XFADE_S : 0;
  const len = Math.ceil((def.dur + extra) * sampleRate);
  const c = new OfflineAudioContext(1, len, sampleRate);
  def.build(c, c.destination, mulberry32(seedFor(id, variant, seed)));
  const buf = await c.startRendering();
  // Copy out: we may slice/trim, and the AudioBuffer is discarded with its context.
  return finishTake(new Float32Array(buf.getChannelData(0)), def, sampleRate);
}

export interface BakeOptions {
  sampleRate?: number;
  seed?: number;
  ids?: readonly SfxId[];
  /** Called once per sound with all its variants (in bake order). */
  onSound?: (id: SfxId, takes: Float32Array[], ms: number) => void;
  /** Abort between sounds (e.g. page unmount). */
  signal?: AbortSignal;
  /** Yield to the browser between sounds. Default: a macrotask. */
  yieldFn?: () => Promise<void>;
}

export interface BakeResult {
  takes: Map<SfxId, Float32Array[]>;
  totalMs: number;
  perIdMs: Record<string, number>;
  bytes: number;
}

const macrotask = () => new Promise<void>((r) => setTimeout(r, 0));

export async function bakeAll(o: BakeOptions = {}): Promise<BakeResult> {
  const sampleRate = o.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const yieldFn = o.yieldFn ?? macrotask;
  const takes = new Map<SfxId, Float32Array[]>();
  const perIdMs: Record<string, number> = {};
  let bytes = 0;
  const t0 = performance.now();
  for (const id of bakeOrder(o.ids)) {
    if (o.signal?.aborted) break;
    const s = performance.now();
    const list: Float32Array[] = [];
    for (let v = 0; v < SFX[id].variants; v++) {
      const d = await bakeOne(id, v, sampleRate, o.seed);
      bytes += d.byteLength;
      list.push(d);
    }
    const ms = performance.now() - s;
    perIdMs[id] = Math.round(ms);
    takes.set(id, list);
    o.onSound?.(id, list, ms);
    await yieldFn();
  }
  return { takes, totalMs: Math.round(performance.now() - t0), perIdMs, bytes };
}
