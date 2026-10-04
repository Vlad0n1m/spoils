/**
 * Recorded samples (Kenney CC0 packs, docs/AUDIO_CREDITS.md) on top of the procedural bank.
 *
 * Every sample is tied to an existing SfxId, so gameplay code, the mix table (recipes.ts `db`), the
 * spatial / occlusion / hidden-sound logic and the voice caps all stay exactly as they are. Two modes:
 *  - "replace": the decoded takes become the sound's buffers;
 *  - "layer":   each procedural take gets a sample mixed under it (guns: the synth keeps the crack,
 *               the sample adds a recorded body), producing one buffer per take as before.
 * Either way the result is level-matched to the procedural take (peak 50 ms-window RMS), so a
 * sample never jumps out of the mix, and it is installed only after it decoded: a missing file,
 * an unsupported codec or a decode error leaves the procedural sound in place.
 *
 * Files live in public/sfx as <name>.ogg (Opus) and <name>.m4a (AAC, Safari); build-sfx.sh makes them.
 * The pure helpers are unit-tested in samples.test.ts; loadSamples needs a browser.
 */
import type { SfxId } from "./recipes";

export type SampleMode = "replace" | "layer";

export interface SampleEntry {
  /** Basenames in /sfx (no extension); one per take. */
  files: readonly string[];
  mode?: SampleMode;
  /** Layer mode: sample level relative to the procedural take, dB (default -3). */
  layerDb?: number;
  /** Extra trim after level matching, dB (default 0). */
  db?: number;
  /** Per-play pitch and volume variation, fraction (default SAMPLE_JITTER). */
  jitter?: number;
}

/** ±5 % pitch and volume per play: repeats of the same recording never sound identical. */
export const SAMPLE_JITTER = 0.05;
export const SFX_BASE_URL = "/sfx/";
/** Peak cap after matching / layering (-0.5 dBFS). */
export const SAMPLE_PEAK = 0.944;
/** Leading samples quieter than this (relative to the take's peak) are cut: codec priming, room tone. */
export const LEAD_TRIM_DB = -45;
export const LEVEL_WINDOW_S = 0.05;

const gun = (files: string[]): SampleEntry => ({ files, mode: "layer", layerDb: -2, jitter: 0.04 });
const gunFar = (files: string[]): SampleEntry => ({ files, mode: "layer", layerDb: -6, jitter: 0.04 });
const steps = (m: string, n: number): SampleEntry => ({ files: Array.from({ length: n }, (_, i) => `step_${m}_${i + 1}`) });
const uiEntry = (files: string[]): SampleEntry => ({ files, jitter: 0.02 });

/**
 * SfxId → sample files. Sounds not listed here (crossbow, siren, heartbeat, boss stings, zipper,
 * bush rustle, water steps, weather and loops) stay procedural: Kenney has nothing closer.
 */
export const SAMPLE_MANIFEST: Readonly<Partial<Record<SfxId, SampleEntry>>> = {
  gun_pistol: gun(["gun_pistol_1", "gun_pistol_2"]),
  gun_pistol_far: gunFar(["gun_pistol_1", "gun_pistol_2"]),
  gun_rifle: gun(["gun_rifle_1", "gun_rifle_2"]),
  gun_rifle_far: gunFar(["gun_rifle_1", "gun_rifle_2"]),
  gun_smg: gun(["gun_smg_1", "gun_smg_2"]),
  gun_smg_far: gunFar(["gun_smg_1", "gun_smg_2"]),
  gun_lmg: gun(["gun_lmg_1", "gun_lmg_2"]),
  gun_lmg_far: gunFar(["gun_lmg_1", "gun_lmg_2"]),
  gun_revolver: gun(["gun_revolver_1"]),
  gun_revolver_far: gunFar(["gun_revolver_1"]),
  gun_sniper: gun(["gun_sniper_1"]),
  gun_sniper_far: gunFar(["gun_sniper_1"]),
  gun_shotgun: gun(["gun_shotgun_1", "gun_shotgun_2"]),
  gun_shotgun_far: gunFar(["gun_shotgun_1", "gun_shotgun_2"]),
  explosion: { files: ["explosion_1", "explosion_2"], mode: "layer", layerDb: 0, jitter: 0.04 },
  explosion_far: { files: ["explosion_far"], mode: "layer", layerDb: -2, jitter: 0.04 },
  grenade_pin: { files: ["grenade_pin"] },
  grenade_bounce: { files: ["grenade_bounce_1", "grenade_bounce_2", "grenade_bounce_3"] },

  reload_out: { files: ["reload_out"] },
  reload_in: { files: ["reload_in"] },
  rack: { files: ["rack"] },
  dry_fire: { files: ["dry_fire"] },
  weapon_switch: { files: ["weapon_switch_1", "weapon_switch_2"] },

  hit_flesh: { files: ["hit_flesh_1", "hit_flesh_2", "hit_flesh_3"] },
  hit_armor: { files: ["hit_armor_1", "hit_armor_2", "hit_armor_3"] },
  hit_wall: { files: ["hit_wall_1", "hit_wall_2", "hit_wall_3"] },
  body_fall: { files: ["body_fall_1", "body_fall_2", "body_fall_3"] },
  hitmarker: uiEntry(["hitmarker"]),
  kill_confirm: uiEntry(["kill_confirm"]),

  step_grass: steps("grass", 5),
  step_dirt: steps("dirt", 5),
  step_concrete: steps("concrete", 5),
  step_wood: steps("wood", 5),
  step_asphalt: steps("asphalt", 3),

  roll: { files: ["roll"] },
  search: { files: ["search_1", "search_2", "search_3"] },
  heal_bandage: { files: ["heal_bandage"] },
  heal_medkit: { files: ["heal_medkit"] },
  chest_open: { files: ["chest_open"] },
  chest_open_metal: { files: ["chest_open_metal"] },
  chest_open_safe: { files: ["chest_open_safe"] },
  item_pickup: { files: ["item_pickup"] },
  item_drop: { files: ["item_drop"] },
  extract_start: uiEntry(["extract_start"]),
  extract_success: uiEntry(["extract_success"]),

  ui_click: uiEntry(["ui_click_1", "ui_click_2"]),
  ui_hover: uiEntry(["ui_hover"]),
  ui_coin: uiEntry(["ui_coin"]),
  ui_error: uiEntry(["ui_error"]),
  ui_equip: uiEntry(["ui_equip"]),
};

export const SAMPLE_IDS = Object.keys(SAMPLE_MANIFEST) as SfxId[];

/** Every distinct file the manifest references. */
export function sampleFiles(m: Readonly<Partial<Record<SfxId, SampleEntry>>> = SAMPLE_MANIFEST): string[] {
  const s = new Set<string>();
  for (const e of Object.values(m)) for (const f of e?.files ?? []) s.add(f);
  return [...s].sort();
}

// ---------------------------------------------------------------- pure DSP helpers

/** Loudest RMS over consecutive windows of `windowS` seconds (short-clip loudness stand-in). */
export function peakWindowRms(d: Float32Array, sampleRate: number, windowS = LEVEL_WINDOW_S): number {
  const w = Math.max(1, Math.round(sampleRate * windowS));
  let best = 0;
  for (let i = 0; i < d.length; i += w) {
    const end = Math.min(d.length, i + w);
    let s = 0;
    for (let j = i; j < end; j++) s += d[j]! * d[j]!;
    const r = Math.sqrt(s / w);
    if (r > best) best = r;
  }
  return best;
}

export function peakOf(d: Float32Array): number {
  let p = 0;
  for (let i = 0; i < d.length; i++) {
    const a = Math.abs(d[i]!);
    if (a > p) p = a;
  }
  return p;
}

/** Index of the first sample within `db` of the take's peak, minus a 1 ms pre-roll. */
export function leadTrimIndex(d: Float32Array, sampleRate: number, db = LEAD_TRIM_DB): number {
  const thr = peakOf(d) * Math.pow(10, db / 20);
  if (!(thr > 0)) return 0;
  for (let i = 0; i < d.length; i++) {
    if (Math.abs(d[i]!) >= thr) return Math.max(0, i - Math.round(sampleRate * 0.001));
  }
  return 0;
}

/** Scale `d` in place by `k`, then pull it down if it would exceed SAMPLE_PEAK. Returns the gain used. */
export function applyGain(d: Float32Array, k: number, cap = SAMPLE_PEAK): number {
  const p = peakOf(d) * k;
  const g = p > cap && p > 0 ? (k * cap) / p : k;
  for (let i = 0; i < d.length; i++) d[i] *= g;
  return g;
}

/**
 * Replace mode: a copy of `sample` (leading silence cut) at the level of the procedural reference
 * (`refRms`, peak-window RMS; 0 = unknown → kept as authored) plus `db`.
 */
export function matchTake(sample: Float32Array, sampleRate: number, refRms: number, db = 0): Float32Array {
  const out = sample.slice(leadTrimIndex(sample, sampleRate));
  const r = peakWindowRms(out, sampleRate);
  const k = (refRms > 0 && r > 0 ? refRms / r : 1) * Math.pow(10, db / 20);
  applyGain(out, k);
  return out;
}

/**
 * Layer mode: procedural take + sample at `layerDb` relative to it, both from t = 0, then the sum is
 * brought back to the procedural take's own level (+ `db`). Length = the longer of the two.
 */
export function layerTake(proc: Float32Array, sample: Float32Array, sampleRate: number, layerDb = -3, db = 0): Float32Array {
  const s = sample.subarray(leadTrimIndex(sample, sampleRate));
  const pr = peakWindowRms(proc, sampleRate);
  const sr = peakWindowRms(s, sampleRate);
  const k = pr > 0 && sr > 0 ? (pr / sr) * Math.pow(10, layerDb / 20) : 0;
  const out = new Float32Array(Math.max(proc.length, s.length));
  out.set(proc);
  for (let i = 0; i < s.length; i++) out[i] += s[i]! * k;
  const or = peakWindowRms(out, sampleRate);
  applyGain(out, (or > 0 && pr > 0 ? pr / or : 1) * Math.pow(10, db / 20));
  return out;
}

/** Mean peak-window RMS of the procedural takes (the replace-mode level target); 0 when none. */
export function referenceRms(takes: readonly Float32Array[], sampleRate: number): number {
  if (takes.length === 0) return 0;
  let s = 0;
  for (const t of takes) s += peakWindowRms(t, sampleRate);
  return s / takes.length;
}

/**
 * The final takes for one sound. Layer mode pairs procedural take i with sample i mod n (so the
 * take count is max of both); without procedural takes it degrades to replace.
 */
export function buildTakes(e: SampleEntry, samples: readonly Float32Array[], proc: readonly Float32Array[], sampleRate: number): Float32Array[] {
  if (samples.length === 0) return [];
  if (e.mode === "layer" && proc.length > 0) {
    const n = Math.max(proc.length, samples.length);
    return Array.from({ length: n }, (_, i) => layerTake(proc[i % proc.length]!, samples[i % samples.length]!, sampleRate, e.layerDb ?? -3, e.db ?? 0));
  }
  const ref = referenceRms(proc, sampleRate);
  return samples.map((s) => matchTake(s, sampleRate, ref, e.db ?? 0));
}

export type SampleFormat = "ogg" | "m4a";

/** Opus in Ogg where the browser says it can, else AAC in MP4 (Safari before 18.4). */
export function formatOrder(canPlay: (mime: string) => string): SampleFormat[] {
  const ogg = canPlay('audio/ogg; codecs="opus"');
  return ogg === "probably" || ogg === "maybe" ? ["ogg", "m4a"] : ["m4a", "ogg"];
}

// ---------------------------------------------------------------- loading (browser only)

export type SampleStatus =
  | { state: "pending" }
  | { state: "ok"; takes: number; format: SampleFormat; ms: number }
  | { state: "failed"; error: string };

export interface LoadSamplesOpts {
  sampleRate: number;
  /** Procedural takes for an id (the level reference and the layer base). */
  proc: (id: SfxId) => readonly Float32Array[];
  /** Called once per id whose samples decoded. */
  install: (id: SfxId, takes: Float32Array[], status: SampleStatus) => void;
  /** Called for an id that keeps its procedural sound. */
  fail: (id: SfxId, status: SampleStatus) => void;
  signal?: AbortSignal;
  baseUrl?: string;
  ids?: readonly SfxId[];
  manifest?: Readonly<Partial<Record<SfxId, SampleEntry>>>;
  /** Concurrent fetches (weak laptops / phones: keep it small). */
  concurrency?: number;
}

type DecodeCtx = BaseAudioContext;

async function decodeFile(ctx: DecodeCtx, url: string, signal?: AbortSignal): Promise<Float32Array> {
  const res = await fetch(url, { signal, cache: "force-cache" });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const ab = await res.arrayBuffer();
  const buf = await ctx.decodeAudioData(ab);
  if (buf.numberOfChannels === 1) return buf.getChannelData(0).slice();
  // Downmix (the files are mono; this is only a guard).
  const out = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) out[i] += d[i]! / buf.numberOfChannels;
  }
  return out;
}

/**
 * Fetch, decode, level-match and hand over every manifest entry. Never throws: a file that fails
 * in both formats marks its sounds as failed and they keep the procedural takes.
 */
export async function loadSamples(o: LoadSamplesOpts): Promise<void> {
  if (typeof window === "undefined" || typeof OfflineAudioContext === "undefined" || typeof fetch === "undefined") return;
  const manifest = o.manifest ?? SAMPLE_MANIFEST;
  const ids = (o.ids ?? (Object.keys(manifest) as SfxId[])).filter((id) => manifest[id]);
  // decodeAudioData resamples to its context's rate: decode straight to the bake rate.
  let ctx: DecodeCtx;
  try {
    ctx = new OfflineAudioContext(1, 1, o.sampleRate);
  } catch (e) {
    for (const id of ids) o.fail(id, { state: "failed", error: String(e) });
    return;
  }
  const probe = typeof Audio !== "undefined" ? new Audio() : null;
  const formats = formatOrder((m) => probe?.canPlayType(m) ?? "");
  const base = o.baseUrl ?? SFX_BASE_URL;

  const cache = new Map<string, Promise<{ data: Float32Array; format: SampleFormat }>>();
  const file = (name: string) => {
    let p = cache.get(name);
    if (!p) {
      p = (async () => {
        let last: unknown = null;
        for (const f of formats) {
          try {
            return { data: await decodeFile(ctx, `${base}${name}.${f}`, o.signal), format: f };
          } catch (e) {
            if (o.signal?.aborted) throw e;
            last = e;
          }
        }
        throw last ?? new Error(`no format for ${name}`);
      })();
      cache.set(name, p);
    }
    return p;
  };

  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      if (o.signal?.aborted) return;
      const id = ids[next++]!;
      const e = manifest[id]!;
      const t0 = performance.now();
      try {
        const got = await Promise.all(e.files.map(file));
        const takes = buildTakes(
          e,
          got.map((g) => g.data),
          o.proc(id),
          o.sampleRate,
        );
        if (takes.length === 0 || takes.some((t) => t.length === 0 || !Number.isFinite(t[0]!))) throw new Error("empty decode");
        o.install(id, takes, { state: "ok", takes: takes.length, format: got[0]!.format, ms: Math.round(performance.now() - t0) });
      } catch (err) {
        if (o.signal?.aborted) return;
        o.fail(id, { state: "failed", error: err instanceof Error ? err.message : String(err) });
      }
      // Yield between sounds so decoding never holds a frame.
      await new Promise((r) => setTimeout(r, 0));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency ?? 3) }, worker));
}
