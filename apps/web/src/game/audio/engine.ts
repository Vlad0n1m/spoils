/**
 * AudioEngine: the one Web Audio graph for the whole client (module-level singleton).
 *
 *   voice: BufferSource(rate ±jitter) → lowpass → Gain → StereoPanner → bus
 *   sfx bus  → sfxMuffle (lowpass, 20 kHz normally) ┐
 *   ambience → ambMuffle (indoor lowpass)           ├→ DynamicsCompressor → output Gain → destination
 *   ui bus  ────────────────────────────────────────┘
 *
 * Why the compressor is mandatory: the PoC's worst-case fight (4 rifles full-auto + shotgun +
 * sniper + steps + hits) peaked at +0.7 dBFS raw and clipped; through this compressor it peaked
 * at -2.9 dBFS with zero clipped samples.
 *
 * Lifecycle: the bank bakes before any user gesture (OfflineAudioContext needs none). The live
 * AudioContext is created on the first pointerdown/keydown (autoplay policy). Until then, and while
 * a sound is not baked yet, play() silently returns null — gameplay code never has to check.
 *
 * Nothing here touches `window` at import time, so the pure parts (admitVoice) are unit-testable.
 */
import { bakeAll, bakeOrder, DEFAULT_SAMPLE_RATE } from "./bake";
import { SFX, SFX_IDS, farVariantOf, type Bus, type SfxDef, type SfxId, type VoiceClass } from "./recipes";
import { SAMPLE_JITTER, SAMPLE_MANIFEST, loadSamples, type SampleStatus } from "./samples";
import { getSettings, subscribeSettings, volumeToGain, type AudioSettings } from "./settings";
import { dbToGain, spatialize, spatializeHidden, type HiddenInput, type SpatialResult, type SpatializeInput } from "./spatial";

// ---------------------------------------------------------------- pure voice admission

/** 32 voices ≈ 2% of the audio thread (PoC: 200 voices rendered 1 s in 111 ms offline). */
export const VOICE_LIMITS = { total: 32, gun: 12, step: 8, perKey: 3 } as const;
export type VoiceLimits = { total: number; gun: number; step: number; perKey: number };

export interface VoiceSlot {
  id: string;
  cls: VoiceClass;
  priority: number;
  /** Current linear gain; quieter voices are stolen first among equal priority. */
  gain: number;
  startedAt: number;
  /** Retrigger group, usually the source id: at most `perKey` voices per (key, id). */
  key?: string;
}

export type Admission = { kind: "play" } | { kind: "steal"; index: number } | { kind: "reject" };

/** Among `candidates`, the voice to steal: lowest priority, then lowest gain, then oldest. */
function pickVictim(active: readonly VoiceSlot[], candidates: number[]): number {
  let best = -1;
  for (const i of candidates) {
    if (best < 0) {
      best = i;
      continue;
    }
    const a = active[i]!;
    const b = active[best]!;
    if (a.priority !== b.priority ? a.priority < b.priority : a.gain !== b.gain ? a.gain < b.gain : a.startedAt < b.startedAt) best = i;
  }
  return best;
}

/**
 * Decide whether a new voice may start, and which existing voice to steal if a cap is hit.
 * Constraints are checked narrowest first (per-key, then class, then total); stealing inside the
 * narrowest violated set keeps every wider count unchanged, so one steal is always enough.
 * A new voice never steals a strictly higher-priority one (a footstep can't cut a gunshot).
 */
export function admitVoice(active: readonly VoiceSlot[], incoming: VoiceSlot, limits: VoiceLimits = VOICE_LIMITS): Admission {
  const sets: number[][] = [];
  if (incoming.key !== undefined) {
    const same: number[] = [];
    active.forEach((v, i) => {
      if (v.key === incoming.key && v.id === incoming.id) same.push(i);
    });
    if (same.length >= limits.perKey) sets.push(same);
  }
  const cap = incoming.cls === "gun" ? limits.gun : incoming.cls === "step" ? limits.step : Infinity;
  if (cap < Infinity) {
    const cls: number[] = [];
    active.forEach((v, i) => {
      if (v.cls === incoming.cls) cls.push(i);
    });
    if (cls.length >= cap) sets.push(cls);
  }
  if (active.length >= limits.total) sets.push(active.map((_, i) => i));
  if (sets.length === 0) return { kind: "play" };
  const victim = pickVictim(active, sets[0]!);
  if (victim < 0 || active[victim]!.priority > incoming.priority) return { kind: "reject" };
  return { kind: "steal", index: victim };
}

/** Pick a random take, avoiding an immediate repeat of the previous one. */
export function pickVariant(n: number, last: number | undefined, rnd: number): number {
  if (n <= 1) return 0;
  let v = Math.floor(rnd * n) % n;
  if (v === last) v = (v + 1) % n;
  return v;
}

// ---------------------------------------------------------------- master chain

/** PoC-validated settings (threshold -10, knee 6, ratio 12, 3 ms / 250 ms, makeup 0.8). */
export const MASTER_COMP = { threshold: -10, knee: 6, ratio: 12, attack: 0.003, release: 0.25, makeup: 0.8 } as const;

/** Compressor → output gain → dest. Shared by the live engine and the /dev/sfx offline mix test. */
export function buildMasterChain(c: BaseAudioContext, dest: AudioNode): { input: AudioNode; comp: DynamicsCompressorNode; out: GainNode } {
  const comp = c.createDynamicsCompressor();
  comp.threshold.value = MASTER_COMP.threshold;
  comp.knee.value = MASTER_COMP.knee;
  comp.ratio.value = MASTER_COMP.ratio;
  comp.attack.value = MASTER_COMP.attack;
  comp.release.value = MASTER_COMP.release;
  const out = c.createGain();
  out.gain.value = MASTER_COMP.makeup;
  comp.connect(out);
  out.connect(dest);
  return { input: comp, comp, out };
}

// ---------------------------------------------------------------- engine

export interface PlayOpts {
  /** Force a take; default random without immediate repeats. */
  variant?: number;
  /** Extra dB on top of the sound's mix level (e.g. self steps -8). */
  db?: number;
  /** Linear multiplier (spatial distance gain). */
  gain?: number;
  pan?: number;
  /** Per-voice lowpass cutoff, Hz. */
  cutoff?: number;
  /** Base playbackRate before jitter. */
  rate?: number;
  priority?: number;
  /** Retrigger group (source id). */
  key?: string;
  /** Seconds from now. */
  delay?: number;
  bus?: Bus;
  /** "synth" forces the procedural takes even when a recorded sample is installed (/dev/sfx A/B). */
  source?: "auto" | "synth";
}

export interface Voice {
  readonly id: SfxId;
  readonly ended: boolean;
  /** Multiplier relative to the voice's start gain. */
  setGain(mult: number, tau?: number): void;
  setPan(pan: number): void;
  setCutoff(hz: number): void;
  /** Re-apply a spatial result (long voices such as the siren recompute occlusion at ~5 Hz). */
  applySpatial(s: SpatialResult): void;
  stop(fadeS?: number): void;
}

export interface LoopHandle {
  readonly id: SfxId;
  /** Linear 0..1 relative to the loop's mix level; smoothed with time constant `tau` seconds. */
  setGain(v: number, tau?: number): void;
  setCutoff(hz: number, tau?: number): void;
  stop(fadeS?: number): void;
}

export interface BakeProgress {
  done: number;
  total: number;
  ms: number;
  finished: boolean;
}

export const STEAL_FADE_S = 0.03;
/** Voices quieter than this (-60 dB) are not worth a voice slot. */
export const MIN_VOICE_GAIN = 0.001;
const NORMAL_CUTOFF = 20000;
const LOW_HP_CUTOFF = 3500;

type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };

class VoiceImpl implements Voice {
  ended = false;
  constructor(
    private readonly eng: AudioEngine,
    readonly id: SfxId,
    readonly slot: VoiceSlot,
    readonly src: AudioBufferSourceNode,
    readonly f: BiquadFilterNode,
    readonly g: GainNode,
    readonly p: StereoPannerNode,
    private readonly baseGain: number,
  ) {}
  private now() {
    return this.src.context.currentTime;
  }
  setGain(mult: number, tau = 0.05) {
    if (this.ended) return;
    const v = Math.max(0, this.baseGain * mult);
    this.slot.gain = v;
    this.g.gain.setTargetAtTime(v, this.now(), tau);
  }
  setPan(pan: number) {
    if (!this.ended) this.p.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)), this.now(), 0.05);
  }
  setCutoff(hz: number) {
    if (!this.ended) this.f.frequency.setTargetAtTime(Math.max(20, Math.min(NORMAL_CUTOFF, hz)), this.now(), 0.05);
  }
  applySpatial(s: SpatialResult) {
    this.setGain(s.gain, 0.08);
    this.setPan(s.pan);
    this.setCutoff(s.cutoff);
  }
  stop(fadeS = STEAL_FADE_S) {
    if (this.ended) return;
    this.ended = true;
    this.eng._release(this);
    const t = this.now();
    try {
      this.g.gain.cancelScheduledValues(t);
      this.g.gain.setValueAtTime(this.g.gain.value, t);
      this.g.gain.linearRampToValueAtTime(0, t + fadeS);
      this.src.stop(t + fadeS + 0.01);
    } catch {
      // Already stopped: nothing to do.
    }
  }
  /** Natural end. */
  _ended() {
    if (this.ended) return;
    this.ended = true;
    this.eng._release(this);
    this.src.disconnect();
    this.p.disconnect();
  }
}

class LoopImpl implements LoopHandle {
  private src: AudioBufferSourceNode | null = null;
  private f: BiquadFilterNode | null = null;
  private g: GainNode | null = null;
  private target = 0;
  private cutoff = NORMAL_CUTOFF;
  stopped = false;
  constructor(
    private readonly eng: AudioEngine,
    readonly id: SfxId,
    private readonly bus: Bus,
  ) {}
  private mix() {
    return dbToGain(SFX[this.id].db);
  }
  /** Starts once both the context and the baked buffer exist; called again on unlock / bake progress. */
  tryStart() {
    if (this.src || this.stopped) return;
    const ctx = this.eng.context;
    const buf = this.eng._buffer(this.id, 0);
    const bus = this.eng._bus(this.bus);
    if (!ctx || !buf || !bus) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = this.cutoff;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(f).connect(g).connect(bus);
    // Random offset: two players' loops (or a restart) never line up audibly.
    src.start(ctx.currentTime, Math.random() * buf.duration);
    g.gain.setTargetAtTime(this.target * this.mix(), ctx.currentTime, 0.5);
    this.src = src;
    this.f = f;
    this.g = g;
  }
  setGain(v: number, tau = 1.5) {
    this.target = Math.max(0, v);
    if (this.g) this.g.gain.setTargetAtTime(this.target * this.mix(), this.g.context.currentTime, tau);
  }
  setCutoff(hz: number, tau = 0.5) {
    this.cutoff = Math.max(20, Math.min(NORMAL_CUTOFF, hz));
    if (this.f) this.f.frequency.setTargetAtTime(this.cutoff, this.f.context.currentTime, tau);
  }
  stop(fadeS = 0.5) {
    if (this.stopped) return;
    this.stopped = true;
    this.eng._dropLoop(this);
    if (this.src && this.g) {
      const t = this.g.context.currentTime;
      this.g.gain.cancelScheduledValues(t);
      this.g.gain.setValueAtTime(this.g.gain.value, t);
      this.g.gain.linearRampToValueAtTime(0, t + fadeS);
      this.src.stop(t + fadeS + 0.02);
    }
  }
}

interface Graph {
  sfx: GainNode;
  sfxMuffle: BiquadFilterNode;
  amb: GainNode;
  ambMuffle: BiquadFilterNode;
  ambMuffleGain: GainNode;
  ui: GainNode;
  comp: DynamicsCompressorNode;
  out: GainNode;
}

let instance: AudioEngine | null = null;

export class AudioEngine {
  /** Lazily created singleton. Safe during SSR (inert until unlock in a browser). */
  static get(): AudioEngine {
    if (!instance) instance = new AudioEngine();
    return instance;
  }

  context: AudioContext | null = null;
  private graph: Graph | null = null;
  private buffers = new Map<SfxId, AudioBuffer[]>();
  /** The baked procedural takes; `buffers` holds the sample takes instead once those decoded. */
  private procBuffers = new Map<SfxId, AudioBuffer[]>();
  /** Per-play pitch/volume variation of sample-backed sounds. */
  private sampleJitter = new Map<SfxId, number>();
  private samples = new Map<SfxId, SampleStatus>();
  private samplePromise: Promise<void> | null = null;
  private sampleListeners = new Set<() => void>();
  private voices: VoiceImpl[] = [];
  private loops = new Set<LoopImpl>();
  private lastVariant = new Map<SfxId, number>();
  private settings: AudioSettings = getSettings();
  private unsubSettings: (() => void) | null = null;
  private bakePromise: Promise<void> | null = null;
  private bakeAbort: AbortController | null = null;
  private progress: BakeProgress = { done: 0, total: SFX_IDS.length, ms: 0, finished: false };
  private progressListeners = new Set<(p: BakeProgress) => void>();
  private unlockInstalled = false;
  private suspendedByVisibility = false;
  private sfxBase = NORMAL_CUTOFF;
  /** Listener aim, used for the behind cue when a call does not pass `facing`. */
  listener: { facing: number | undefined } = { facing: undefined };

  private constructor() {
    this.unsubSettings = subscribeSettings((s) => {
      this.settings = s;
      this.applySettings();
    });
  }

  // ------------------------------------------------------------ unlock / lifecycle

  /** Listen (capture phase) for the first user gesture and unlock the context on it. Idempotent. */
  installUnlock(): void {
    if (this.unlockInstalled || typeof window === "undefined") return;
    this.unlockInstalled = true;
    for (const ev of ["pointerdown", "keydown", "touchend"] as const) window.addEventListener(ev, this.onGesture, { capture: true });
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  private onGesture = () => {
    void this.unlock();
  };

  private removeGestureListeners() {
    if (typeof window === "undefined") return;
    for (const ev of ["pointerdown", "keydown", "touchend"] as const) window.removeEventListener(ev, this.onGesture, { capture: true });
  }

  private onVisibility = () => {
    const ctx = this.context;
    if (!ctx) return;
    if (document.hidden) {
      if (ctx.state === "running") {
        this.suspendedByVisibility = true;
        void ctx.suspend();
      }
    } else if (this.suspendedByVisibility) {
      this.suspendedByVisibility = false;
      void ctx.resume();
    }
  };

  /** Create/resume the live context. Must run inside a user gesture the first time. */
  async unlock(): Promise<boolean> {
    if (typeof window === "undefined") return false;
    if (!this.context) {
      const Ctor = window.AudioContext ?? (window as WebkitWindow).webkitAudioContext;
      if (!Ctor) return false;
      try {
        this.context = new Ctor({ latencyHint: "interactive" });
      } catch {
        return false;
      }
      this.graph = this.buildGraph(this.context);
      this.applySettings();
    }
    try {
      if (this.context.state !== "running") await this.context.resume();
    } catch {
      return false;
    }
    const ok = this.context.state === "running";
    if (ok) {
      this.removeGestureListeners();
      for (const l of this.loops) l.tryStart();
    }
    return ok;
  }

  get unlocked(): boolean {
    return this.context?.state === "running";
  }

  private buildGraph(c: AudioContext): Graph {
    const master = buildMasterChain(c, c.destination);
    const sfx = c.createGain();
    const sfxMuffle = c.createBiquadFilter();
    sfxMuffle.type = "lowpass";
    sfxMuffle.frequency.value = NORMAL_CUTOFF;
    sfx.connect(sfxMuffle).connect(master.input);
    const amb = c.createGain();
    const ambMuffle = c.createBiquadFilter();
    ambMuffle.type = "lowpass";
    ambMuffle.frequency.value = NORMAL_CUTOFF;
    const ambMuffleGain = c.createGain();
    amb.connect(ambMuffle).connect(ambMuffleGain).connect(master.input);
    const ui = c.createGain();
    ui.connect(master.input);
    return { sfx, sfxMuffle, amb, ambMuffle, ambMuffleGain, ui, comp: master.comp, out: master.out };
  }

  private applySettings() {
    const g = this.graph;
    const ctx = this.context;
    if (!g || !ctx) return;
    const s = this.settings;
    const t = ctx.currentTime;
    // setTargetAtTime (30 ms) instead of .value so slider drags don't zipper.
    g.out.gain.setTargetAtTime(s.muted ? 0 : volumeToGain(s.master) * MASTER_COMP.makeup, t, 0.03);
    g.sfx.gain.setTargetAtTime(volumeToGain(s.sfx), t, 0.03);
    g.amb.gain.setTargetAtTime(volumeToGain(s.ambience), t, 0.03);
    g.ui.gain.setTargetAtTime(volumeToGain(s.ui), t, 0.03);
  }

  /** Stop every voice and loop and close the context. The next get() builds a fresh engine. */
  dispose(): void {
    this.bakeAbort?.abort();
    for (const v of [...this.voices]) v.stop(0.01);
    for (const l of [...this.loops]) l.stop(0.01);
    this.removeGestureListeners();
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisibility);
    this.unsubSettings?.();
    void this.context?.close().catch(() => undefined);
    this.context = null;
    this.graph = null;
    if (instance === this) instance = null;
  }

  // ------------------------------------------------------------ baking

  /**
   * Bake the whole bank once (idempotent). Starts in an idle callback so it never competes with
   * page load; resolves when every sound is ready. Sounds become playable one by one as they bake.
   */
  ensureBaked(): Promise<void> {
    if (this.bakePromise) return this.bakePromise;
    if (typeof window === "undefined" || typeof OfflineAudioContext === "undefined") return Promise.resolve();
    this.bakeAbort = new AbortController();
    const signal = this.bakeAbort.signal;
    this.bakePromise = new Promise<void>((resolve) => {
      const start = () => {
        const sampleRate = this.context?.sampleRate ?? DEFAULT_SAMPLE_RATE;
        bakeAll({
          sampleRate,
          signal,
          ids: bakeOrder(),
          onSound: (id, takes) => {
            const bufs = takes.map((d) => toAudioBuffer(d, sampleRate));
            this.procBuffers.set(id, bufs);
            // A sample that is already installed keeps priority over a (re)baked synth take.
            if (!this.sampleJitter.has(id)) this.buffers.set(id, bufs);
            this.progress = { ...this.progress, done: this.buffers.size };
            for (const l of this.loops) if (l.id === id) l.tryStart();
            this.emitProgress();
          },
        })
          .then((r) => {
            this.progress = { done: this.buffers.size, total: SFX_IDS.length, ms: r.totalMs, finished: true };
            this.emitProgress();
          })
          .catch((e) => {
            // A failed bake leaves the game silent rather than broken.
            console.warn("[audio] bake failed", e);
          })
          .finally(() => {
            resolve();
            // Recorded samples decode after the synth bank: the game is never silent while they load.
            void this.ensureSamples();
          });
      };
      const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
      if (ric) ric(start, { timeout: 500 });
      else setTimeout(start, 0);
    });
    return this.bakePromise;
  }

  get bakeProgress(): BakeProgress {
    return this.progress;
  }

  onBakeProgress(l: (p: BakeProgress) => void): () => void {
    this.progressListeners.add(l);
    l(this.progress);
    return () => {
      this.progressListeners.delete(l);
    };
  }

  private emitProgress() {
    for (const l of this.progressListeners) l(this.progress);
  }

  /**
   * Fetch and decode the recorded samples (idempotent; started automatically after the bake). Each
   * sound switches to its samples as soon as they decoded; failures keep the procedural takes.
   */
  ensureSamples(): Promise<void> {
    if (this.samplePromise) return this.samplePromise;
    if (typeof window === "undefined" || typeof OfflineAudioContext === "undefined") return Promise.resolve();
    const signal = this.bakeAbort?.signal;
    const sampleRate = this.procBuffers.values().next().value?.[0]?.sampleRate ?? this.context?.sampleRate ?? DEFAULT_SAMPLE_RATE;
    for (const id of Object.keys(SAMPLE_MANIFEST) as SfxId[]) this.samples.set(id, { state: "pending" });
    this.emitSamples();
    this.samplePromise = new Promise<void>((resolve) => {
      const start = () => {
        loadSamples({
          sampleRate,
          signal,
          proc: (id) => (this.procBuffers.get(id) ?? []).map((b) => b.getChannelData(0)),
          install: (id, takes, status) => {
            if (signal?.aborted) return;
            this.buffers.set(id, takes.map((d) => toAudioBuffer(d, sampleRate)));
            this.sampleJitter.set(id, SAMPLE_MANIFEST[id]?.jitter ?? SAMPLE_JITTER);
            this.lastVariant.delete(id);
            this.samples.set(id, status);
            this.emitSamples();
          },
          fail: (id, status) => {
            this.samples.set(id, status);
            console.warn(`[audio] sample ${id} unavailable, keeping the synth: ${status.state === "failed" ? status.error : ""}`);
            this.emitSamples();
          },
        })
          .catch((e) => console.warn("[audio] sample load failed", e))
          .finally(resolve);
      };
      const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
      if (ric) ric(start, { timeout: 1500 });
      else setTimeout(start, 50);
    });
    return this.samplePromise;
  }

  /** Sample load state per sample-backed sound (/dev/sfx). */
  get sampleStatus(): ReadonlyMap<SfxId, SampleStatus> {
    return this.samples;
  }

  isSampled(id: SfxId): boolean {
    return this.sampleJitter.has(id);
  }

  onSamples(l: () => void): () => void {
    this.sampleListeners.add(l);
    l();
    return () => {
      this.sampleListeners.delete(l);
    };
  }

  private emitSamples() {
    for (const l of this.sampleListeners) l();
  }

  /** The procedural takes, even when samples replaced them (/dev/sfx A/B). */
  getProcBuffers(id: SfxId): readonly AudioBuffer[] {
    return this.procBuffers.get(id) ?? [];
  }

  isBaked(id: SfxId): boolean {
    return this.buffers.has(id);
  }

  /** Baked takes (dev page stats / offline mix test). */
  getBuffers(id: SfxId): readonly AudioBuffer[] {
    return this.buffers.get(id) ?? [];
  }

  // ------------------------------------------------------------ playback

  /** Play a sound. Returns null when locked, not baked, inaudible or refused by the voice cap. */
  play(id: SfxId, o: PlayOpts = {}): Voice | null {
    const ctx = this.context;
    const def: SfxDef = SFX[id];
    if (!ctx || ctx.state !== "running" || !def) return null;
    const synth = o.source === "synth";
    const takes = synth ? this.procBuffers.get(id) : this.buffers.get(id);
    if (!takes || takes.length === 0) return null;
    // Recorded samples vary pitch and level a little per play (the synth bakes several takes instead).
    const sj = synth ? 0 : (this.sampleJitter.get(id) ?? 0);
    const baseGain = dbToGain(def.db + (o.db ?? 0)) * (o.gain ?? 1) * (sj > 0 ? 1 + (Math.random() * 2 - 1) * sj : 1);
    if (!(baseGain >= MIN_VOICE_GAIN)) return null;
    const bus = this._bus(o.bus ?? def.bus);
    if (!bus) return null;

    const slot: VoiceSlot = { id, cls: def.cls, priority: o.priority ?? def.priority, gain: baseGain, startedAt: ctx.currentTime, key: o.key };
    const adm = admitVoice(
      this.voices.map((v) => v.slot),
      slot,
    );
    if (adm.kind === "reject") return null;
    if (adm.kind === "steal") this.voices[adm.index]!.stop(STEAL_FADE_S);

    const variant = o.variant !== undefined ? Math.max(0, Math.min(takes.length - 1, o.variant | 0)) : pickVariant(takes.length, this.lastVariant.get(id), Math.random());
    if (!synth) this.lastVariant.set(id, variant);

    const src = ctx.createBufferSource();
    src.buffer = takes[variant]!;
    src.playbackRate.value = (o.rate ?? 1) * (1 + (Math.random() * 2 - 1) * Math.max(def.jitter, sj));
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = Math.max(20, Math.min(NORMAL_CUTOFF, o.cutoff ?? NORMAL_CUTOFF));
    const g = ctx.createGain();
    g.gain.value = baseGain;
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, o.pan ?? 0));
    src.connect(f).connect(g).connect(p).connect(bus);

    const v = new VoiceImpl(this, id, slot, src, f, g, p, baseGain);
    src.onended = () => v._ended();
    this.voices.push(v);
    src.start(ctx.currentTime + Math.max(0, o.delay ?? 0));
    return v;
  }

  /** Visible source at a known offset (dx, dy) from the listener. Uses the `_far` take past 40% of range. */
  playAt(id: SfxId, i: SpatializeInput & PlayOpts): Voice | null {
    const s = spatialize({ ...i, facing: i.facing ?? this.listener.facing });
    if (!s) return null;
    const use = s.far ? (farVariantOf(id) ?? id) : id;
    return this.play(use, { ...i, gain: (i.gain ?? 1) * s.gain, pan: s.pan, cutoff: s.cutoff });
  }

  /** Hidden source known only by (sector, band, occluded): no coordinates ever reach the client. */
  playHidden(id: SfxId, i: HiddenInput & PlayOpts): Voice | null {
    const s = spatializeHidden({ ...i, facing: i.facing ?? this.listener.facing });
    if (!s) return null;
    const use = s.far ? (farVariantOf(id) ?? id) : id;
    return this.play(use, { ...i, gain: (i.gain ?? 1) * s.gain, pan: s.pan, cutoff: s.cutoff });
  }

  /** Start an ambient bed (silent until setGain). Starts automatically once unlocked and baked. */
  loop(id: SfxId, bus: Bus = "ambience"): LoopHandle {
    const l = new LoopImpl(this, id, bus);
    this.loops.add(l);
    l.tryStart();
    return l;
  }

  stopAll(fadeS = 0.2): void {
    for (const v of [...this.voices]) v.stop(fadeS);
  }

  get voiceCount(): number {
    return this.voices.length;
  }

  // ------------------------------------------------------------ bus effects

  /** Momentary sfx muffle (e.g. getting hit: 900 Hz for 250 ms), then release back to the base. */
  muffle(cutoffHz: number, holdMs: number, releaseMs: number): void {
    const g = this.graph;
    const ctx = this.context;
    if (!g || !ctx) return;
    const t = ctx.currentTime;
    const fq = g.sfxMuffle.frequency;
    fq.cancelScheduledValues(t);
    fq.setValueAtTime(Math.max(20, cutoffHz), t);
    fq.setValueAtTime(Math.max(20, cutoffHz), t + holdMs / 1000);
    fq.exponentialRampToValueAtTime(this.sfxBase, t + (holdMs + Math.max(1, releaseMs)) / 1000);
  }

  /** Resting sfx cutoff: 20 kHz normally, 3.5 kHz at low HP, ~400 Hz on death (ramped). */
  setMuffleBase(hz: number, rampS = 0.3): void {
    this.sfxBase = Math.max(20, Math.min(NORMAL_CUTOFF, hz));
    const g = this.graph;
    const ctx = this.context;
    if (!g || !ctx) return;
    const t = ctx.currentTime;
    const fq = g.sfxMuffle.frequency;
    fq.cancelScheduledValues(t);
    fq.setValueAtTime(fq.value, t);
    fq.exponentialRampToValueAtTime(this.sfxBase, t + Math.max(0.01, rampS));
  }

  setLowHpMuffle(on: boolean): void {
    this.setMuffleBase(on ? LOW_HP_CUTOFF : NORMAL_CUTOFF, 0.4);
  }

  /** Indoors: rain/wind bus through a lowpass and a little quieter ("rain on the roof"). */
  setAmbienceMuffle(cutoffHz: number, gainMult = 1, tau = 0.6): void {
    const g = this.graph;
    const ctx = this.context;
    if (!g || !ctx) return;
    g.ambMuffle.frequency.setTargetAtTime(Math.max(20, Math.min(NORMAL_CUTOFF, cutoffHz)), ctx.currentTime, tau);
    g.ambMuffleGain.gain.setTargetAtTime(Math.max(0, gainMult), ctx.currentTime, tau);
  }

  // ------------------------------------------------------------ internal (used by Voice/Loop)

  /** @internal */
  _release(v: VoiceImpl): void {
    const i = this.voices.indexOf(v);
    if (i >= 0) this.voices.splice(i, 1);
  }
  /** @internal */
  _dropLoop(l: LoopImpl): void {
    this.loops.delete(l);
  }
  /** @internal */
  _buffer(id: SfxId, variant: number): AudioBuffer | undefined {
    return this.buffers.get(id)?.[variant];
  }
  /** @internal */
  _bus(b: Bus): AudioNode | null {
    const g = this.graph;
    if (!g) return null;
    return b === "sfx" ? g.sfx : b === "ambience" ? g.amb : g.ui;
  }
}

/** AudioBuffers are context-independent, so a buffer baked before unlock plays in the live context. */
function toAudioBuffer(d: Float32Array, sampleRate: number): AudioBuffer {
  const b = new AudioBuffer({ length: Math.max(1, d.length), numberOfChannels: 1, sampleRate });
  b.copyToChannel(d as Float32Array<ArrayBuffer>, 0);
  return b;
}
