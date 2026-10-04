"use client";

/**
 * /dev/sfx — audition bench for the procedural sound bank (dev builds only).
 *
 * Bakes every sound through the real AudioEngine, shows per-take stats (flags NaN or a peak above
 * 0 dBFS), plays any take, drives the mixer settings, toggles ambient beds, and has two positional
 * pads: a visible-source pad (exact dx/dy, walls) and a hidden-source ring (16 sectors × 3 bands).
 * A worst-case offline mix checks that the master compressor keeps a firefight from clipping.
 * The Samples panel lists every recorded (Kenney CC0) sample, its decode state, and plays it
 * against the procedural take it replaces or layers onto.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { takeStats, type TakeStats } from "@/game/audio/bake";
import { AudioEngine, buildMasterChain, type BakeProgress, type LoopHandle } from "@/game/audio/engine";
import { SFX, SFX_IDS, type SfxDef, type SfxId } from "@/game/audio/recipes";
import { SAMPLE_IDS, SAMPLE_MANIFEST, type SampleStatus } from "@/game/audio/samples";
import { useAudioSettings } from "@/game/audio/settings";
import { FAR_U, NEAR_PX, SECTORS, dbToGain, sectorAngle, spatialize, spatializeHidden, type SpatialResult } from "@/game/audio/spatial";

export default function SfxDevPage() {
  // Inlined at build time: the bench never ships in production bundles' behaviour.
  if (process.env.NODE_ENV === "production") {
    return <main className="p-8 font-mono text-sm text-white/70">Not available in production builds.</main>;
  }
  return <SfxBench />;
}

const GROUPS: SfxDef["group"][] = ["guns", "steps", "weapon", "hits", "interact", "extract", "ui", "weather", "loops"];
const LOOP_IDS = SFX_IDS.filter((id) => SFX[id].loop);
/** Default hearing range per sound for the pad (critique.md radius table). */
function defaultRange(id: SfxId): number {
  if (id.startsWith("gun_pistol")) return 2000;
  if (id.startsWith("gun_rifle")) return 2400;
  if (id.startsWith("gun_shotgun")) return 2200;
  if (id.startsWith("gun_sniper")) return 3600;
  if (id.startsWith("step_")) return 800;
  if (id === "siren") return 2400;
  return 900;
}
const PAD_WORLD = 2500; // half-width of the pad in world px

const fmt = (v: number | undefined) => (v === undefined ? "" : Number.isFinite(v) ? v.toFixed(1) : "-inf");
const deg = (r: number) => Math.round((r * 180) / Math.PI);

function useEngine(): AudioEngine {
  return useMemo(() => AudioEngine.get(), []);
}

function SfxBench() {
  const eng = useEngine();
  const [progress, setProgress] = useState<BakeProgress>(eng.bakeProgress);
  const [stats, setStats] = useState<Partial<Record<SfxId, TakeStats[]>>>({});
  const [unlocked, setUnlocked] = useState(false);
  const [voices, setVoices] = useState(0);
  const [sampleTick, setSampleTick] = useState(0);
  const statsSampled = useRef(new Set<SfxId>());

  useEffect(() => {
    eng.installUnlock();
    void eng.ensureBaked();
    // Dev bench only: lets a console / automated check read the sample decode state.
    (window as unknown as { __sfxEngine?: AudioEngine }).__sfxEngine = eng;
    const offSamples = eng.onSamples(() => setSampleTick((t) => t + 1));
    const off = eng.onBakeProgress(setProgress);
    const iv = window.setInterval(() => {
      setVoices(eng.voiceCount);
      setUnlocked(eng.unlocked);
    }, 250);
    return () => {
      off();
      offSamples();
      window.clearInterval(iv);
    };
  }, [eng]);

  // Stats for each sound as soon as it is baked.
  useEffect(() => {
    setStats((prev) => {
      let next = prev;
      for (const id of SFX_IDS) {
        const sampled = eng.isSampled(id);
        // Recompute once more when a sample replaces the synth takes.
        if ((prev[id] && sampled === statsSampled.current.has(id)) || !eng.isBaked(id)) continue;
        if (sampled) statsSampled.current.add(id);
        const loop = !!SFX[id].loop;
        const s = eng.getBuffers(id).map((b) => takeStats(b.getChannelData(0), b.sampleRate, loop));
        next = next === prev ? { ...prev } : next;
        next[id] = s;
      }
      return next;
    });
  }, [eng, progress, sampleTick]);

  /** Every play goes through unlock first: the click that plays is also the autoplay gesture. */
  const play = useCallback(
    async (id: SfxId, variant?: number) => {
      await eng.unlock();
      eng.play(id, { variant });
    },
    [eng],
  );

  const problems = SFX_IDS.filter((id) => stats[id]?.some((s) => s.nan > 0 || s.peakDb > 0));
  const bakedBytes = SFX_IDS.reduce((a, id) => a + eng.getBuffers(id).reduce((b, buf) => b + buf.length * 4, 0), 0);

  return (
    <main className="mx-auto max-w-6xl px-4 py-6 font-mono text-[13px] leading-snug text-[#ece9f5] [&_*]:leading-snug">
      <header className="mb-6 flex flex-wrap items-baseline gap-x-6 gap-y-2">
        <h1 className="text-2xl tracking-wide" style={{ fontFamily: "var(--font-luckiest-guy)" }}>
          SFX bench
        </h1>
        <span>
          baked {progress.done}/{progress.total}
          {progress.finished ? ` in ${progress.ms} ms` : "…"}
        </span>
        <span>{(bakedBytes / 1048576).toFixed(1)} MB</span>
        <span>voices {voices}</span>
        <span className={unlocked ? "text-lime-300" : "text-amber-300"}>{unlocked ? "audio on" : "click anywhere to enable audio"}</span>
        {progress.finished && (
          <span className={problems.length ? "text-red-400" : "text-lime-300"}>{problems.length ? `problems: ${problems.join(", ")}` : "no NaN, no clipping"}</span>
        )}
      </header>

      <div className="grid gap-6 lg:grid-cols-2">
        <Mixer eng={eng} />
        <StressTest eng={eng} ready={progress.finished} />
        <VisiblePad eng={eng} />
        <HiddenRing eng={eng} />
      </div>

      <SamplesPanel eng={eng} tick={sampleTick} />

      <SoundTable stats={stats} play={play} isBaked={(id) => eng.isBaked(id)} />
    </main>
  );
}

function sampleLabel(s: SampleStatus | undefined): { text: string; cls: string } {
  if (!s || s.state === "pending") return { text: "loading…", cls: "text-amber-300" };
  if (s.state === "failed") return { text: `synth fallback (${s.error})`, cls: "text-red-400" };
  return { text: `${s.format} · ${s.takes} take${s.takes > 1 ? "s" : ""} · ${s.ms} ms`, cls: "text-lime-300" };
}

/** Every sample-backed sound: decode state, and the sample vs the procedural take it replaces/layers. */
function SamplesPanel({ eng, tick }: { eng: AudioEngine; tick: number }) {
  void tick;
  const st = eng.sampleStatus;
  const ok = SAMPLE_IDS.filter((id) => st.get(id)?.state === "ok").length;
  const failed = SAMPLE_IDS.filter((id) => st.get(id)?.state === "failed");
  const playAs = async (id: SfxId, source: "auto" | "synth") => {
    await eng.unlock();
    eng.play(id, { source });
  };
  return (
    <section className="mt-6 overflow-x-auto rounded-lg border border-white/10" data-testid="samples-panel">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 px-3 py-2">
        <h2 className="text-xs uppercase tracking-widest text-white/50">Samples (Kenney CC0)</h2>
        <span className={failed.length ? "text-red-400" : ok === SAMPLE_IDS.length ? "text-lime-300" : "text-amber-300"} data-testid="samples-summary">
          decoded {ok}/{SAMPLE_IDS.length}
          {failed.length ? ` · fallback: ${failed.join(", ")}` : ""}
        </span>
      </div>
      <table className="w-full min-w-[760px] border-collapse">
        <thead className="text-left text-xs uppercase tracking-wider text-white/50">
          <tr className="border-b border-white/10">
            <th className="px-3 py-2">sound</th>
            <th className="px-2">mode</th>
            <th className="px-2">files</th>
            <th className="px-2">state</th>
            <th className="px-2">play</th>
          </tr>
        </thead>
        <tbody>
          {SAMPLE_IDS.map((id) => {
            const e = SAMPLE_MANIFEST[id]!;
            const s = st.get(id);
            const lab = sampleLabel(s);
            return (
              <tr key={id} className="border-b border-white/5" data-sample={id} data-state={s?.state ?? "pending"}>
                <td className="px-3 py-1">{id}</td>
                <td className="px-2 text-white/60">{e.mode ?? "replace"}</td>
                <td className="px-2 text-white/60">{e.files.join(" ")}</td>
                <td className={`px-2 ${lab.cls}`}>{lab.text}</td>
                <td className="px-2 py-1">
                  <div className="flex gap-1">
                    <button className={btn} disabled={s?.state !== "ok"} onClick={() => void playAs(id, "auto")} aria-label={`play ${id} sample`}>
                      sample
                    </button>
                    <button className={btn} disabled={!eng.isBaked(id)} onClick={() => void playAs(id, "synth")} aria-label={`play ${id} synth`}>
                      synth
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
      <h2 className="mb-3 text-xs uppercase tracking-widest text-white/50">{title}</h2>
      {children}
    </section>
  );
}

function Slider({ label, value, onChange, min = 0, max = 1, step = 0.01, suffix = "" }: { label: string; value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; suffix?: string }) {
  return (
    <label className="flex items-center gap-3">
      <span className="w-24 shrink-0 text-white/70">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="min-w-0 flex-1 accent-lime-300" />
      <span className="w-14 text-right tabular-nums">
        {step >= 1 ? Math.round(value) : value.toFixed(2)}
        {suffix}
      </span>
    </label>
  );
}

const btn = "rounded border border-white/15 bg-white/5 px-2 py-1 hover:bg-white/15 active:bg-white/25 disabled:opacity-40";

// ---------------------------------------------------------------- mixer + beds + bus effects

function Mixer({ eng }: { eng: AudioEngine }) {
  const [s, update] = useAudioSettings();
  const loops = useRef<Partial<Record<SfxId, LoopHandle>>>({});
  const [bed, setBed] = useState<Partial<Record<SfxId, number>>>({});
  const [lowHp, setLowHp] = useState(false);
  const [indoor, setIndoor] = useState(false);

  useEffect(() => {
    const ref = loops.current;
    return () => {
      for (const l of Object.values(ref)) l?.stop(0.2);
    };
  }, []);

  const setBedGain = async (id: SfxId, v: number) => {
    await eng.unlock();
    const h = (loops.current[id] ??= eng.loop(id));
    h.setGain(v, 0.3);
    setBed((b) => ({ ...b, [id]: v }));
  };

  return (
    <Panel title="Mixer (saved to localStorage)">
      <div className="flex flex-col gap-2">
        <Slider label="master" value={s.master} onChange={(v) => update({ master: v })} />
        <Slider label="sfx" value={s.sfx} onChange={(v) => update({ sfx: v })} />
        <Slider label="ambience" value={s.ambience} onChange={(v) => update({ ambience: v })} />
        <Slider label="ui" value={s.ui} onChange={(v) => update({ ui: v })} />
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={s.muted} onChange={(e) => update({ muted: e.target.checked })} className="accent-lime-300" /> muted
        </label>
      </div>
      <h3 className="mb-2 mt-4 text-white/50">Ambient beds</h3>
      <div className="flex flex-col gap-2">
        {LOOP_IDS.map((id) => (
          <Slider key={id} label={id.replace("loop_", "")} value={bed[id] ?? 0} onChange={(v) => void setBedGain(id, v)} />
        ))}
      </div>
      <h3 className="mb-2 mt-4 text-white/50">Bus effects</h3>
      <div className="flex flex-wrap gap-2">
        <button className={btn} onClick={async () => {
            await eng.unlock();
            eng.play("hit_flesh");
            eng.muffle(900, 250, 400);
          }}>
          hit muffle
        </button>
        <button
          className={btn}
          onClick={async () => {
            await eng.unlock();
            eng.setLowHpMuffle(!lowHp);
            setLowHp(!lowHp);
          }}
        >
          low HP {lowHp ? "on" : "off"}
        </button>
        <button className={btn} onClick={async () => {
            await eng.unlock();
            eng.setMuffleBase(400, 1.5);
          }}>
          death
        </button>
        <button className={btn} onClick={async () => {
            await eng.unlock();
            eng.setMuffleBase(20000, 0.3);
            setLowHp(false);
          }}>
          reset
        </button>
        <button
          className={btn}
          onClick={async () => {
            await eng.unlock();
            eng.setAmbienceMuffle(indoor ? 20000 : 900, indoor ? 1 : 0.7);
            setIndoor(!indoor);
          }}
        >
          indoor {indoor ? "on" : "off"}
        </button>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------- offline worst-case mix

interface MixResult {
  peakDb: number;
  clipped: number;
}

async function mixTest(eng: AudioEngine, limited: boolean): Promise<MixResult> {
  const sr = eng.getBuffers("gun_rifle")[0]?.sampleRate ?? 48000;
  const c = new OfflineAudioContext(2, sr * 3, sr);
  const dest = limited ? buildMasterChain(c, c.destination).input : c.destination;
  // Seeded so raw vs limited compare the same mix.
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const at = (id: SfxId, t: number, pan: number, g = 1) => {
    const takes = eng.getBuffers(id);
    const b = takes[Math.floor(rnd() * takes.length)];
    if (!b) return;
    const s = c.createBufferSource();
    s.buffer = b;
    const gn = c.createGain();
    gn.gain.value = dbToGain(SFX[id].db) * g;
    const p = c.createStereoPanner();
    p.pan.value = pan;
    s.connect(gn).connect(p).connect(dest);
    s.start(t);
  };
  // PoC scenario: 4 rifles full-auto for 1 s, shotgun, sniper, 6 steps, 5 hits + hitmarkers.
  for (let k = 0; k < 4; k++) for (let i = 0; i < 10; i++) at("gun_rifle", 0.1 + i * 0.1 + k * 0.013, -0.6 + k * 0.4, [1, 0.6, 0.4, 0.3][k]);
  at("gun_shotgun", 0.35, 0.2);
  at("gun_sniper", 0.55, -0.3);
  for (let i = 0; i < 6; i++) at("step_grass", 0.1 + i * 0.33, 0);
  for (let i = 0; i < 5; i++) {
    at("hit_flesh", 0.2 + i * 0.2, 0.1);
    at("hitmarker", 0.2 + i * 0.2, 0);
  }
  const buf = await c.startRendering();
  let peak = 0;
  let clipped = 0;
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]!);
      if (a > peak) peak = a;
      if (a >= 1) clipped++;
    }
  }
  return { peakDb: 20 * Math.log10(peak), clipped };
}

function StressTest({ eng, ready }: { eng: AudioEngine; ready: boolean }) {
  const [res, setRes] = useState<{ raw: MixResult; limited: MixResult } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      setRes({ raw: await mixTest(eng, false), limited: await mixTest(eng, true) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title="Worst-case fight mix (offline)">
      <p className="mb-3 text-white/60">4 rifles full-auto + shotgun + sniper + steps + hits, rendered with and without the master compressor.</p>
      <button className={btn} disabled={!ready || busy} onClick={run}>
        {busy ? "rendering…" : "run"}
      </button>
      {res && (
        <table className="mt-3">
          <tbody>
            {(["raw", "limited"] as const).map((k) => (
              <tr key={k}>
                <td className="pr-4 text-white/60">{k}</td>
                <td className="pr-4 tabular-nums">peak {fmt(res[k].peakDb)} dBFS</td>
                <td className={res[k].clipped ? "text-red-400" : "text-lime-300"}>{res[k].clipped} clipped</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- visible-source pad

function SpatialReadout({ r }: { r: SpatialResult | null | undefined }) {
  if (r === undefined) return <p className="text-white/50">click to place a source</p>;
  if (r === null) return <p className="text-amber-300">out of range: no voice</p>;
  return (
    <p className="tabular-nums">
      gain {r.gain.toFixed(3)} ({fmt(20 * Math.log10(Math.max(1e-6, r.gain)))} dB) · pan {(Math.abs(r.pan) < 0.005 ? 0 : r.pan).toFixed(2)} · lowpass {Math.round(r.cutoff)} Hz{r.far ? " · far take" : ""}
    </p>
  );
}

function SoundSelect({ value, onChange }: { value: SfxId; onChange: (id: SfxId) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as SfxId)} className="rounded border border-white/15 bg-[#14121a] px-2 py-1">
      {SFX_IDS.filter((id) => SFX[id].bus !== "ui" && !SFX[id].loop && !id.endsWith("_far")).map((id) => (
        <option key={id} value={id}>
          {id}
        </option>
      ))}
    </select>
  );
}

function FacingArrow({ facing, cx, cy, len }: { facing: number; cx: number; cy: number; len: number }) {
  return (
    <g>
      <line x1={cx} y1={cy} x2={cx + Math.cos(facing) * len} y2={cy + Math.sin(facing) * len} stroke="#d9f99d" strokeWidth={2} />
      <circle cx={cx} cy={cy} r={5} fill="#d9f99d" />
    </g>
  );
}

function VisiblePad({ eng }: { eng: AudioEngine }) {
  const [id, setId] = useState<SfxId>("gun_rifle");
  const [range, setRange] = useState(2400);
  const [walls, setWalls] = useState(0);
  const [facingDeg, setFacingDeg] = useState(-90);
  const [src, setSrc] = useState<{ dx: number; dy: number } | null>(null);
  const [res, setRes] = useState<SpatialResult | null | undefined>(undefined);
  const size = 300;
  const k = size / 2 / PAD_WORLD;
  const facing = (facingDeg * Math.PI) / 180;

  const onPad = async (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const dx = ((e.clientX - rect.left) / rect.width) * 2 * PAD_WORLD - PAD_WORLD;
    const dy = ((e.clientY - rect.top) / rect.height) * 2 * PAD_WORLD - PAD_WORLD;
    setSrc({ dx, dy });
    setRes(spatialize({ dx, dy, range, facing, walls }));
    await eng.unlock();
    eng.playAt(id, { dx, dy, range, facing, walls });
  };

  return (
    <Panel title="Visible source: spatialize(dx, dy, walls)">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SoundSelect
          value={id}
          onChange={(v) => {
            setId(v);
            setRange(defaultRange(v));
          }}
        />
        <span className="text-white/60">walls</span>
        {[0, 1, 2, 3].map((w) => (
          <button key={w} className={`${btn} ${w === walls ? "border-lime-300 text-lime-300" : ""}`} onClick={() => setWalls(w)}>
            {w}
          </button>
        ))}
      </div>
      <div className="mb-3 flex flex-col gap-2">
        <Slider label="range px" value={range} min={200} max={4000} step={50} onChange={setRange} />
        <Slider label="aim °" value={facingDeg} min={-180} max={180} step={5} onChange={setFacingDeg} />
      </div>
      <svg viewBox={`0 0 ${size} ${size}`} className="aspect-square w-full max-w-[300px] cursor-crosshair rounded bg-black/40" onClick={onPad}>
        <circle cx={size / 2} cy={size / 2} r={range * k} fill="none" stroke="#ffffff22" />
        <circle cx={size / 2} cy={size / 2} r={(NEAR_PX + FAR_U * (range - NEAR_PX)) * k} fill="none" stroke="#ffffff14" strokeDasharray="3 3" />
        {/* the 180° vision cone edge */}
        <line
          x1={size / 2 + Math.cos(facing + Math.PI / 2) * size}
          y1={size / 2 + Math.sin(facing + Math.PI / 2) * size}
          x2={size / 2 + Math.cos(facing - Math.PI / 2) * size}
          y2={size / 2 + Math.sin(facing - Math.PI / 2) * size}
          stroke="#ffffff18"
        />
        <FacingArrow facing={facing} cx={size / 2} cy={size / 2} len={28} />
        {src && <circle cx={size / 2 + src.dx * k} cy={size / 2 + src.dy * k} r={6} fill="#ff5a3c" />}
      </svg>
      <p className="mt-2 text-white/50">dashed ring: far-take threshold (40% of range). Pad spans ±{PAD_WORLD} px.</p>
      <div className="mt-1">
        <SpatialReadout r={res} />
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------- hidden-source ring

function HiddenRing({ eng }: { eng: AudioEngine }) {
  const [id, setId] = useState<SfxId>("step_dirt");
  const [occluded, setOccluded] = useState(false);
  const [facingDeg, setFacingDeg] = useState(-90);
  const [sel, setSel] = useState<{ sector: number; band: number } | null>(null);
  const [res, setRes] = useState<SpatialResult | null | undefined>(undefined);
  const size = 300;
  const c = size / 2;
  const radii = [45, 90, 135];
  const facing = (facingDeg * Math.PI) / 180;

  const hit = async (sector: number, band: number) => {
    setSel({ sector, band });
    setRes(spatializeHidden({ sector, band, occluded, facing }));
    await eng.unlock();
    eng.playHidden(id, { sector, band, occluded, facing });
  };

  return (
    <Panel title="Hidden source: (sector, band, occluded)">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <SoundSelect value={id} onChange={setId} />
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={occluded} onChange={(e) => setOccluded(e.target.checked)} className="accent-lime-300" /> occluded
        </label>
      </div>
      <div className="mb-3">
        <Slider label="aim °" value={facingDeg} min={-180} max={180} step={5} onChange={setFacingDeg} />
      </div>
      <svg viewBox={`0 0 ${size} ${size}`} className="aspect-square w-full max-w-[300px] rounded bg-black/40">
        {radii.map((r) => (
          <circle key={r} cx={c} cy={c} r={r} fill="none" stroke="#ffffff14" />
        ))}
        <FacingArrow facing={facing} cx={c} cy={c} len={28} />
        {Array.from({ length: SECTORS }, (_, s) =>
          radii.map((r, b) => {
            const a = sectorAngle(s);
            const on = sel?.sector === s && sel.band === b;
            return (
              <circle
                key={`${s}-${b}`}
                cx={c + Math.cos(a) * r}
                cy={c + Math.sin(a) * r}
                r={on ? 8 : 6}
                fill={on ? "#ff5a3c" : "#ffffff30"}
                className="cursor-pointer hover:fill-white/70"
                onClick={() => void hit(s, b)}
              >
                <title>{`sector ${s} (${deg(a)}°), band ${b}`}</title>
              </circle>
            );
          }),
        )}
      </svg>
      <p className="mt-2 text-white/50">Inner ring = band 0 (near). No coordinates: pan = 0.8·cos(sector), gain from band.</p>
      <div className="mt-1">
        <SpatialReadout r={res} />
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------- sound table

function SoundTable({ stats, play, isBaked }: { stats: Partial<Record<SfxId, TakeStats[]>>; play: (id: SfxId, v?: number) => Promise<void>; isBaked: (id: SfxId) => boolean }) {
  return (
    <section className="mt-6 overflow-x-auto rounded-lg border border-white/10">
      <table className="w-full min-w-[860px] border-collapse">
        <thead className="text-left text-xs uppercase tracking-wider text-white/50">
          <tr className="border-b border-white/10">
            <th className="px-3 py-2">sound</th>
            <th className="px-2">bus</th>
            <th className="px-2 text-right">mix dB</th>
            <th className="px-2">play</th>
            <th className="px-2 text-right">dur ms</th>
            <th className="px-2 text-right">active ms</th>
            <th className="px-2 text-right">peak</th>
            <th className="px-2 text-right">rms</th>
            <th className="px-2 text-right">rms 100ms</th>
            <th className="px-2 text-right">tail</th>
            <th className="px-2 text-right">NaN</th>
          </tr>
        </thead>
        {GROUPS.map((g) => (
          <tbody key={g}>
            <tr>
              <td colSpan={11} className="bg-white/[0.04] px-3 py-1 text-xs uppercase tracking-widest text-white/40">
                {g}
              </td>
            </tr>
            {SFX_IDS.filter((id) => SFX[id].group === g).map((id) => {
              const def: SfxDef = SFX[id];
              const s0 = stats[id]?.[0];
              const bad = stats[id]?.some((s) => s.nan > 0 || s.peakDb > 0);
              const baked = isBaked(id);
              return (
                <tr key={id} className={`border-b border-white/5 ${bad ? "bg-red-500/15 text-red-300" : ""}`}>
                  <td className="px-3 py-1">{id}</td>
                  <td className="px-2 text-white/60">{def.bus}</td>
                  <td className="px-2 text-right tabular-nums">{def.db}</td>
                  <td className="px-2 py-1">
                    <div className="flex gap-1">
                      {Array.from({ length: def.variants }, (_, v) => (
                        <button key={v} className={btn} disabled={!baked} onClick={() => void play(id, v)} aria-label={`play ${id} take ${v + 1}`}>
                          {v + 1}
                        </button>
                      ))}
                    </div>
                  </td>
                  <td className="px-2 text-right tabular-nums">{s0?.durMs ?? ""}</td>
                  <td className="px-2 text-right tabular-nums">{s0?.activeMs ?? ""}</td>
                  <td className="px-2 text-right tabular-nums">{fmt(s0?.peakDb)}</td>
                  <td className="px-2 text-right tabular-nums">{fmt(s0?.rmsDb)}</td>
                  <td className="px-2 text-right tabular-nums">{fmt(s0?.rms100Db)}</td>
                  <td className="px-2 text-right tabular-nums">{def.loop ? `seam ${s0?.seam ?? ""}` : fmt(s0?.tailDb)}</td>
                  <td className="px-2 text-right tabular-nums">{stats[id] ? stats[id]!.reduce((a, s) => a + s.nan, 0) : ""}</td>
                </tr>
              );
            })}
          </tbody>
        ))}
      </table>
    </section>
  );
}
