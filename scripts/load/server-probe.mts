/**
 * Game-server process probe for load tests: starts the real server (apps/game-server/src/index.ts)
 * in this process and records, without changing any server code:
 * - every tick's step and total time (BATTLE_PERF_LOG=1 must be set: the probe wraps
 *   TickStats.prototype.add, which battle-room.ts calls once per tick only when the perf log is on);
 * - GC pauses (PerformanceObserver "gc"), event-loop delay (beyond the 5 ms sampling interval) and
 *   utilisation;
 * - process CPU (user / system) and memory (rss, heap, external, array buffers) every window;
 * - the shard's runtimes: humans alive, NPCs alive / awake (not dormant).
 *
 * Output (LOAD_PROBE_DIR, default ./load-probe): ticks.csv (wallMs,stepMs,tickMs) and probe.jsonl
 * (one JSON line per LOAD_PROBE_WINDOW_MS, default 5000).
 *
 * Run from apps/game-server (its tsconfig: useDefineForClassFields false matters for the rooms):
 *   cd apps/game-server && BATTLE_PERF_LOG=1 node --import tsx ../../scripts/load/server-probe.mts
 * run.mjs does this with the load-test environment (port, web stub, a per-run HMAC secret).
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PerformanceObserver, monitorEventLoopDelay, performance } from "node:perf_hooks";

const outDir = path.resolve(process.env.LOAD_PROBE_DIR ?? "load-probe");
const windowMs = Number(process.env.LOAD_PROBE_WINDOW_MS ?? 5000);
mkdirSync(outDir, { recursive: true });
const ticksFile = path.join(outDir, "ticks.csv");
const probeFile = path.join(outDir, "probe.jsonl");
writeFileSync(ticksFile, "wallMs,stepMs,tickMs\n");
writeFileSync(probeFile, "");

if (process.env.BATTLE_PERF_LOG !== "1") console.warn("[probe] BATTLE_PERF_LOG is not 1: no tick samples will be recorded");

// ---- tick samples (tick-stats.ts has no imports, so loading it first changes nothing for index.ts)
const { TickStats } = await import("../../apps/game-server/src/rooms/tick-stats.js");
let tickRows: string[] = [];
let tickCount = 0;
const origAdd = TickStats.prototype.add;
TickStats.prototype.add = function (stepMs: number, tickMs: number) {
  tickRows.push(`${Date.now()},${stepMs.toFixed(4)},${tickMs.toFixed(4)}`);
  tickCount++;
  return origAdd.call(this, stepMs, tickMs);
};

// ---- GC
interface GcWindow {
  count: number;
  totalMs: number;
  maxMs: number;
  major: number;
  majorMs: number;
}
const freshGc = (): GcWindow => ({ count: 0, totalMs: 0, maxMs: 0, major: 0, majorMs: 0 });
let gc = freshGc();
const gcObs = new PerformanceObserver((list) => {
  for (const e of list.getEntries()) {
    gc.count++;
    gc.totalMs += e.duration;
    gc.maxMs = Math.max(gc.maxMs, e.duration);
    // detail.kind: 1 minor (scavenge), 2 major (mark-sweep-compact), 4 incremental, 8 weak callbacks.
    const kind = (e as unknown as { detail?: { kind?: number } }).detail?.kind ?? 0;
    if (kind === 2) {
      gc.major++;
      gc.majorMs += e.duration;
    }
  }
});
gcObs.observe({ entryTypes: ["gc"] });

// ---- event loop
// The histogram's samples include its own timer interval: ELD_RES_MS is subtracted when reported.
const ELD_RES_MS = 5;
const eld = monitorEventLoopDelay({ resolution: ELD_RES_MS });
eld.enable();
let elu = performance.eventLoopUtilization();
let cpu = process.cpuUsage();
let lastAt = Date.now();

// ---- the server itself (top-level await: resolves once it listens and the directory has started)
const bootT0 = performance.now();
await import("../../apps/game-server/src/index.js");
const bootMs = performance.now() - bootT0;
const { worldDirectory } = await import("../../apps/game-server/src/world/directory.js");
console.log(`[probe] server up in ${bootMs.toFixed(0)} ms; writing ${path.relative(process.cwd(), outDir) || "."}`);

function shardCounts() {
  const shard = worldDirectory.current();
  if (!shard) return null;
  let humans = 0;
  let npcs = 0;
  let awake = 0;
  const all = shard.room.match.allRuntimes();
  for (const rt of all) {
    if (!rt.pub.alive) continue;
    if (rt.isNpc) {
      npcs++;
      if (!rt.dormant) awake++;
    } else humans++;
  }
  return { humans, npcs, npcsAwake: awake, runtimes: all.length, clock: Math.round(shard.room.match.clock) };
}

function flush() {
  const now = Date.now();
  const dt = now - lastAt;
  lastAt = now;
  if (tickRows.length) {
    appendFileSync(ticksFile, tickRows.join("\n") + "\n");
    tickRows = [];
  }
  const c = process.cpuUsage(cpu);
  cpu = process.cpuUsage();
  const e = performance.eventLoopUtilization(elu);
  elu = performance.eventLoopUtilization();
  const m = process.memoryUsage();
  const ns = (v: number) => +Math.max(0, v / 1e6 - ELD_RES_MS).toFixed(2);
  const line = {
    t: now,
    dtMs: dt,
    ticks: tickCount,
    cpuUserMs: +(c.user / 1000).toFixed(1),
    cpuSysMs: +(c.system / 1000).toFixed(1),
    cpuPct: +(((c.user + c.system) / 1000 / dt) * 100).toFixed(1),
    rssMB: +(m.rss / 2 ** 20).toFixed(1),
    heapUsedMB: +(m.heapUsed / 2 ** 20).toFixed(1),
    heapTotalMB: +(m.heapTotal / 2 ** 20).toFixed(1),
    externalMB: +(m.external / 2 ** 20).toFixed(1),
    arrayBuffersMB: +(m.arrayBuffers / 2 ** 20).toFixed(1),
    gc: { ...gc, totalMs: +gc.totalMs.toFixed(2), maxMs: +gc.maxMs.toFixed(2), majorMs: +gc.majorMs.toFixed(2) },
    eld: { p50: ns(eld.percentile(50)), p99: ns(eld.percentile(99)), max: ns(eld.max) },
    elu: +e.utilization.toFixed(3),
    shard: shardCounts(),
  };
  gc = freshGc();
  eld.reset();
  tickCount = 0;
  appendFileSync(probeFile, JSON.stringify(line) + "\n");
}

const timer = setInterval(flush, windowMs);
timer.unref();
const stop = () => {
  clearInterval(timer);
  try {
    flush();
  } finally {
    process.exit(0);
  }
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
