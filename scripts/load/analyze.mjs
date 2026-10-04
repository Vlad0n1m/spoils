#!/usr/bin/env node
/**
 * Summarise a load run directory (written by run.mjs, or by server-probe.mts + clients.mjs + a ps
 * sampler on a VPS): per phase (N clients) the tick time p50 / p95 / p99 / max, the sim step, ticks
 * over budget, process CPU and RSS (ps and the in-process probe), GC pauses, event-loop delay, NPCs
 * awake, and per client: bytes/s received by kind (patch, ev, …), bytes/s sent, RTT.
 *
 *   node scripts/load/analyze.mjs <run dir>      → <run dir>/summary.json + summary.md (and prints the .md)
 *
 * Inputs (all optional except phases.json): phases.json, ticks.csv, probe.jsonl, ps.csv, clients.jsonl, stub.json.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { mean, pct } from "./lib.mjs";

const TICK_BUDGET_MS = 50; // SERVER_TICK_MS at 20 Hz

const readLines = (f) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : []);
const readJsonl = (f) => readLines(f).map((l) => JSON.parse(l));

export function readTicks(file) {
  const out = [];
  for (const l of readLines(file).slice(1)) {
    const [t, s, k] = l.split(",").map(Number);
    if (Number.isFinite(t)) out.push({ t, step: s, tick: k });
  }
  return out;
}

/** ps.csv: t,role,pid,pcpu,rssKB,cpuSec */
export function readPs(file) {
  const out = [];
  for (const l of readLines(file).slice(1)) {
    const [t, role, pid, pcpu, rssKB, cpuSec] = l.split(",");
    out.push({ t: Number(t), role, pid: Number(pid), pcpu: Number(pcpu), rssKB: Number(rssKB), cpuSec: Number(cpuSec) });
  }
  return out;
}

/** The analysed window of a phase: its first `settleMs` (joins, JIT of new paths) are skipped. */
export function phaseWindow(phase, settleMs = 10_000) {
  const len = phase.endMs - phase.startMs;
  const skip = Math.min(settleMs, Math.floor(len * 0.3));
  return { from: phase.startMs + skip, to: phase.endMs };
}

const r2 = (v) => (Number.isFinite(v) ? +v.toFixed(2) : null);

export function tickStats(ticks, w) {
  const inW = ticks.filter((x) => x.t > w.from && x.t <= w.to);
  const tick = inW.map((x) => x.tick);
  const step = inW.map((x) => x.step);
  const secs = (w.to - w.from) / 1000;
  return {
    ticks: inW.length,
    ticksPerSec: r2(inW.length / secs),
    tickP50: r2(pct(tick, 0.5)),
    tickP95: r2(pct(tick, 0.95)),
    tickP99: r2(pct(tick, 0.99)),
    tickMax: r2(tick.length ? Math.max(...tick) : NaN),
    tickMean: r2(mean(tick)),
    stepP50: r2(pct(step, 0.5)),
    stepP95: r2(pct(step, 0.95)),
    stepMax: r2(step.length ? Math.max(...step) : NaN),
    overBudget: tick.filter((v) => v > TICK_BUDGET_MS).length,
  };
}

/** CPU % from the cumulative CPU time of the first and last ps sample inside the window. */
export function psStats(ps, w, role) {
  const rows = ps.filter((x) => x.role === role && x.t >= w.from && x.t <= w.to);
  if (rows.length < 2) return { cpuPct: null, rssMaxMB: rows[0] ? r2(rows[0].rssKB / 1024) : null, samples: rows.length };
  const a = rows[0];
  const b = rows[rows.length - 1];
  return {
    cpuPct: r2(((b.cpuSec - a.cpuSec) / ((b.t - a.t) / 1000)) * 100),
    rssMaxMB: r2(Math.max(...rows.map((x) => x.rssKB)) / 1024),
    rssMeanMB: r2(mean(rows.map((x) => x.rssKB)) / 1024),
    samples: rows.length,
  };
}

/** Probe windows that end inside the phase window (each covers the LOAD_PROBE_WINDOW_MS before its t). */
export function probeStats(probe, w) {
  const rows = probe.filter((x) => x.t - x.dtMs >= w.from - 1000 && x.t <= w.to);
  if (!rows.length) return null;
  const sum = (f) => rows.reduce((a, x) => a + f(x), 0);
  const ms = sum((x) => x.dtMs);
  const shard = rows.map((x) => x.shard).filter(Boolean);
  return {
    windows: rows.length,
    cpuPct: r2((sum((x) => x.cpuUserMs + x.cpuSysMs) / ms) * 100),
    rssMaxMB: r2(Math.max(...rows.map((x) => x.rssMB))),
    heapUsedMaxMB: r2(Math.max(...rows.map((x) => x.heapUsedMB))),
    heapUsedMeanMB: r2(mean(rows.map((x) => x.heapUsedMB))),
    gcPerSec: r2(sum((x) => x.gc.count) / (ms / 1000)),
    gcMsPerSec: r2(sum((x) => x.gc.totalMs) / (ms / 1000)),
    gcMaxMs: r2(Math.max(...rows.map((x) => x.gc.maxMs))),
    gcMajor: sum((x) => x.gc.major),
    eldP99MaxMs: r2(Math.max(...rows.map((x) => x.eld.p99))),
    eldMaxMs: r2(Math.max(...rows.map((x) => x.eld.max))),
    eluMean: r2(mean(rows.map((x) => x.elu))),
    humansMean: r2(mean(shard.map((s) => s.humans))),
    npcsMean: r2(mean(shard.map((s) => s.npcs))),
    npcsAwakeMean: r2(mean(shard.map((s) => s.npcsAwake))),
    npcsAwakeMax: shard.length ? Math.max(...shard.map((s) => s.npcsAwake)) : null,
    runtimesMax: shard.length ? Math.max(...shard.map((s) => s.runtimes)) : null,
  };
}

/**
 * Client traffic in the window: counter deltas between the last snapshot at or before `from` and the
 * last one at or before `to`, divided by the window length and the mean number of connected clients.
 */
export function clientStats(snaps, w) {
  const before = snaps.filter((s) => s.t <= w.from);
  const upto = snaps.filter((s) => s.t <= w.to);
  // No snapshot before the window (a phase shorter than the snapshot period): start at the first one inside.
  const a = before[before.length - 1] ?? snaps.find((s) => s.t > w.from && s.t <= w.to);
  const b = upto[upto.length - 1];
  if (!a || !b || b.t <= a.t) return null;
  const inside = snaps.filter((s) => s.t > a.t && s.t <= b.t);
  const conn = mean(inside.map((s) => s.connected));
  const secs = (b.t - a.t) / 1000;
  const per = (d) => (conn > 0 ? r2(d / secs / conn) : null);
  const inByKind = {};
  const msgsByKind = {};
  let inTotal = 0;
  for (const k of Object.keys(b.inBytes)) {
    const d = b.inBytes[k] - (a.inBytes[k] ?? 0);
    inTotal += d;
    if (d > 0) inByKind[k] = per(d);
    const m = b.inMsgs[k] - (a.inMsgs[k] ?? 0);
    if (m > 0) msgsByKind[k] = per(m);
  }
  const rtts = inside.flatMap((s) => s.rtts);
  const outcomes = {};
  // outcomes are cumulative: the window's share is b − a
  for (const [k, v] of Object.entries(b.outcomes ?? {})) {
    const d = v - (a.outcomes?.[k] ?? 0);
    if (d > 0) outcomes[k] = d;
  }
  return {
    connectedMean: r2(conn),
    inBytesPerSecPerClient: per(inTotal),
    inByKind,
    inMsgsPerSecPerClient: msgsByKind,
    outBytesPerSecPerClient: per(b.outBytes - a.outBytes),
    avgPatchBytes: b.inMsgs.patch - a.inMsgs.patch > 0 ? r2((b.inBytes.patch - a.inBytes.patch) / (b.inMsgs.patch - a.inMsgs.patch)) : null,
    avgEvBytes: b.inMsgs.ev - a.inMsgs.ev > 0 ? r2((b.inBytes.ev - a.inBytes.ev) / (b.inMsgs.ev - a.inMsgs.ev)) : null,
    rttP50: r2(pct(rtts, 0.5)),
    rttP95: r2(pct(rtts, 0.95)),
    rttMax: r2(rtts.length ? Math.max(...rtts) : NaN),
    joinMs: inside.flatMap((s) => s.joinMs),
    outcomes,
  };
}

/** Least-squares line y = a + b·x over the phases with clients > 0. */
export function linearFit(xs, ys) {
  const pts = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (pts.length < 2) return null;
  const mx = mean(pts.map((p) => p[0]));
  const my = mean(pts.map((p) => p[1]));
  let sxy = 0;
  let sxx = 0;
  for (const [x, y] of pts) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
  }
  const b = sxx ? sxy / sxx : 0;
  return { a: my - b * mx, b };
}

export function analyzeRun(dir, { settleMs = 10_000 } = {}) {
  const phases = JSON.parse(readFileSync(path.join(dir, "phases.json"), "utf8"));
  const ticks = readTicks(path.join(dir, "ticks.csv"));
  const probe = readJsonl(path.join(dir, "probe.jsonl"));
  const ps = readPs(path.join(dir, "ps.csv"));
  const snaps = readJsonl(path.join(dir, "clients.jsonl"));
  const stub = existsSync(path.join(dir, "stub.json")) ? JSON.parse(readFileSync(path.join(dir, "stub.json"), "utf8")) : null;
  const meta = existsSync(path.join(dir, "meta.json")) ? JSON.parse(readFileSync(path.join(dir, "meta.json"), "utf8")) : null;
  const out = [];
  for (const ph of phases) {
    const w = phaseWindow(ph, settleMs);
    out.push({
      name: ph.name ?? `${ph.clients} clients`,
      clients: ph.clients,
      seconds: r2((w.to - w.from) / 1000),
      tick: tickStats(ticks, w),
      ps: psStats(ps, w, "server"),
      psClients: psStats(ps, w, "clients"),
      probe: probeStats(probe, w),
      net: clientStats(snaps, w),
    });
  }
  const loaded = out.filter((p) => p.clients > 0);
  const fit = (f) => linearFit(loaded.map((p) => p.clients), loaded.map(f));
  const fits = {
    tickMean: fit((p) => p.tick.tickMean),
    tickP95: fit((p) => p.tick.tickP95),
    cpuPct: fit((p) => p.ps?.cpuPct ?? p.probe?.cpuPct),
    inBytesPerSecPerClient: fit((p) => p.net?.inBytesPerSecPerClient),
  };
  return { dir, meta, phases: out, fits, stub };
}

const f = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toFixed(d));

export function renderMarkdown(r) {
  const L = [];
  L.push(`# Load run ${path.basename(r.dir)}`);
  if (r.meta) L.push("", "```", JSON.stringify(r.meta, null, 1), "```");
  L.push("", "## Server tick (ms; budget 50 ms at 20 Hz)", "");
  L.push("| phase | s | ticks/s | tick p50 | p95 | p99 | max | mean | step p50 | step p95 | >50 ms |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const p of r.phases) {
    const t = p.tick;
    L.push(`| ${p.name} | ${f(p.seconds, 0)} | ${f(t.ticksPerSec, 1)} | ${f(t.tickP50)} | ${f(t.tickP95)} | ${f(t.tickP99)} | ${f(t.tickMax)} | ${f(t.tickMean)} | ${f(t.stepP50)} | ${f(t.stepP95)} | ${t.overBudget} |`);
  }
  L.push("", "## Server process", "");
  L.push("| phase | CPU % (ps) | CPU % (probe) | RSS max MB | heap used max MB | GC/s | GC ms/s | GC max ms | major GCs | ELD p99 max ms | ELU | humans | NPCs | NPCs awake (mean/max) |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const p of r.phases) {
    const q = p.probe ?? {};
    L.push(
      `| ${p.name} | ${f(p.ps?.cpuPct, 1)} | ${f(q.cpuPct, 1)} | ${f(p.ps?.rssMaxMB ?? q.rssMaxMB, 0)} | ${f(q.heapUsedMaxMB, 0)} | ${f(q.gcPerSec, 1)} | ${f(q.gcMsPerSec)} | ${f(q.gcMaxMs)} | ${q.gcMajor ?? "—"} | ${f(q.eldP99MaxMs)} | ${f(q.eluMean)} | ${f(q.humansMean, 1)} | ${f(q.npcsMean, 0)} | ${f(q.npcsAwakeMean, 1)}/${q.npcsAwakeMax ?? "—"} |`,
    );
  }
  L.push("", "## Network per client (WebSocket payload bytes; no frame / TCP overhead)", "");
  L.push("| phase | connected | in B/s | patch B/s | ev B/s | other in B/s | out B/s | patch msg/s | avg patch B | avg ev B | RTT p50 | RTT p95 | clients CPU % |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const p of r.phases) {
    const n = p.net;
    if (!n) {
      L.push(`| ${p.name} | 0 | — | — | — | — | — | — | — | — | — | — | ${f(p.psClients?.cpuPct, 1)} |`);
      continue;
    }
    const other = (n.inBytesPerSecPerClient ?? 0) - (n.inByKind.patch ?? 0) - (n.inByKind.ev ?? 0);
    L.push(
      `| ${p.name} | ${f(n.connectedMean, 1)} | ${f(n.inBytesPerSecPerClient, 0)} | ${f(n.inByKind.patch, 0)} | ${f(n.inByKind.ev, 0)} | ${f(other, 0)} | ${f(n.outBytesPerSecPerClient, 0)} | ${f(n.inMsgsPerSecPerClient.patch, 1)} | ${f(n.avgPatchBytes, 0)} | ${f(n.avgEvBytes, 0)} | ${f(n.rttP50)} | ${f(n.rttP95)} | ${f(p.psClients?.cpuPct, 1)} |`,
    );
  }
  const outc = r.phases.map((p) => `${p.name}: ${JSON.stringify(p.net?.outcomes ?? {})}`).join("; ");
  L.push("", `Outcomes per phase: ${outc}`);
  L.push("", "## Linear fits over the loaded phases (y = a + b·clients; an extrapolation aid only)", "");
  for (const [k, v] of Object.entries(r.fits)) if (v) L.push(`- ${k}: a = ${f(v.a, 3)}, b = ${f(v.b, 3)} per client → at 24: ${f(v.a + v.b * 24, 2)}`);
  if (r.stub) {
    L.push("", "## Web stub (what the server posted)", "", "| path | requests | bytes | max body | p50 ms |", "|---|---|---|---|---|");
    for (const [p, s] of Object.entries(r.stub)) L.push(`| ${p} | ${s.n} | ${s.bytes} | ${s.maxBytes} | ${f(s.p50Ms)} |`);
  }
  return L.join("\n") + "\n";
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const dir = path.resolve(process.argv[2] ?? ".");
  const r = analyzeRun(dir);
  writeFileSync(path.join(dir, "summary.json"), JSON.stringify(r, null, 1));
  const md = renderMarkdown(r);
  writeFileSync(path.join(dir, "summary.md"), md);
  process.stdout.write(md);
}
