/**
 * Raid soak / perf bench (perf memo §5, WP-G): a whole 30-minute raid on the Steppe with N bots and
 * idle humans, stepped at 20 Hz in simulated time. Measures Match.step wall time (avg / p99 / max
 * after JIT warm-up), the bot share of it, planner load, and tells the raid's story: when bots
 * extracted, who died, how many containers and bodies were searched.
 *
 * Used by soak.test.ts (asserts against PERF_BUDGET) and runnable on its own:
 *   apps/game-server/node_modules/.bin/tsx apps/game-server/src/sim/perf.bench.ts [bots] [minutes] [seed]
 *
 * The idle humans never connect and never send input ("observer" mode keeps them alive by topping
 * up HP each tick, so the raid always runs its full length — a match ends with its last human).
 */

import { pathToFileURL } from "node:url";
import { CONTAINER_STATE, MATCH, SERVER_TICK_MS, mulberry32 } from "@extract/shared";
import { BOT_PEACE_MS } from "./bot.js";
import { Match } from "./match.js";
import { counterUid } from "./test-utils.js";
import type { MatchEvent, RosterEntry } from "./types.js";

export interface SoakOptions {
  bots: number;
  humans?: number;
  minutes?: number;
  seed?: number;
  /** Keep the idle humans alive (default true) so the raid runs its full length. */
  observer?: boolean;
}

export interface SoakResult {
  m: Match;
  ticks: number;
  stepAvg: number;
  stepP99: number;
  stepMax: number;
  /** Share of step time spent in BotBrain.update (sampled every tick). */
  botShare: number;
  counts: Record<string, number>;
  extracts: number[];
  deaths: number[];
  timeouts: number;
  containersOpened: number;
  containersEmptied: number;
  corpsesSearched: number;
  scavs: number;
  /** Bot shots inside the peace window by a bot that had not been hit first (must be 0). */
  peaceViolations: number;
  /** Share of alive-bot ticks spent deciding at the LOD rate. */
  lodShare: number;
  /** Uncaught exceptions inside step (the soak asserts there are none). */
  errors: unknown[];
}

function roster(humans: number, bots: number): RosterEntry[] {
  return [
    ...Array.from({ length: humans }, (_, i) => ({ userId: `soak-human-${i}`, nickname: `Idle${i}`, isBot: false })),
    ...Array.from({ length: bots }, (_, i) => ({ userId: null, nickname: `Bot${i}`, isBot: true })),
  ];
}

export function runSoak(o: SoakOptions): SoakResult {
  const humans = o.humans ?? 1;
  const minutes = o.minutes ?? MATCH.DURATION_MS / 60_000;
  const m = new Match({
    roster: roster(humans, o.bots), rng: mulberry32(o.seed ?? 2026), newUid: counterUid,
    now: () => 1_700_000_000_000, strictLedger: true,
  });
  const observer = o.observer ?? true;
  const people = m.allRuntimes().filter((r) => !r.isBot);
  // Bot time: wrap each brain's update (no change to the brains themselves).
  let botMs = 0;
  for (const b of m.bots) {
    const orig = b.update.bind(b);
    b.update = (dt: number) => {
      const t0 = performance.now();
      orig(dt);
      botMs += performance.now() - t0;
    };
  }
  const ticks = Math.round((minutes * 60_000) / SERVER_TICK_MS);
  const ms: number[] = [];
  const counts: Record<string, number> = {};
  const errors: unknown[] = [];
  let botTotal = 0;
  let stepTotal = 0;
  let peaceViolations = 0;
  const wasHit = new Set<number>();
  let lodTicks = 0;
  let botTicks = 0;
  for (let i = 0; i < ticks && !m.ended; i++) {
    if (observer) for (const h of people) if (h.pub.alive && h.pub.hp < 100) h.pub.hp = 100;
    const b0 = botMs;
    const t0 = performance.now();
    try {
      m.step(SERVER_TICK_MS);
    } catch (e) {
      errors.push(e);
      break;
    }
    const dt = performance.now() - t0;
    ms.push(dt);
    if (i >= 20) {
      stepTotal += dt;
      botTotal += botMs - b0;
    }
    for (const e of m.drainEvents() as MatchEvent[]) {
      counts[e.type] = (counts[e.type] ?? 0) + 1;
      if (m.clock > BOT_PEACE_MS) continue;
      if (e.type === "hit") wasHit.add(e.target);
      if (e.type === "shot" && m.rosterRuntime(e.src)?.isBot && !wasHit.has(e.src)) peaceViolations++;
    }
    for (const b of m.bots) {
      if (!b.rt.pub.alive) continue;
      botTicks++;
      if (b.lod) lodTicks++;
    }
  }
  // The first second is JIT warm-up of every system; the budget is about steady state.
  const steady = ms.slice(20).sort((x, y) => x - y);
  const avg = steady.reduce((s, v) => s + v, 0) / Math.max(1, steady.length);
  const extracts: number[] = [];
  const deaths: number[] = [];
  let timeouts = 0;
  for (const rt of m.allRuntimes()) {
    // Roster bots only: bosses and guards (Player.role != 0) never extract (they hold their POI).
    if (!rt.isBot || rt.pub.role !== 0) continue;
    const r = rt.exitReport;
    if (!r) continue;
    if (r.exit === "extract") extracts.push(r.atMs);
    else if (r.exit === "dead") deaths.push(r.atMs);
    else timeouts++;
  }
  const states = [...m.state.containerState];
  return {
    m, ticks: ms.length,
    stepAvg: avg,
    stepP99: steady[Math.floor(steady.length * 0.99)] ?? 0,
    stepMax: steady[steady.length - 1] ?? 0,
    botShare: stepTotal > 0 ? botTotal / stepTotal : 0,
    counts, extracts: extracts.sort((a, b) => a - b), deaths: deaths.sort((a, b) => a - b), timeouts,
    containersOpened: states.filter((v) => v !== CONTAINER_STATE.UNTOUCHED).length,
    containersEmptied: states.filter((v) => v === CONTAINER_STATE.EMPTIED).length,
    corpsesSearched: m.containers.corpses().filter((t) => t.searchedBy.size > 0).length,
    scavs: m.bots.filter((b) => b.role === "scav").length,
    peaceViolations,
    lodShare: botTicks > 0 ? lodTicks / botTicks : 0,
    errors,
  };
}

const mmss = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`;

export function describeSoak(r: SoakResult): string {
  const st = r.m.planner.stats;
  return [
    `raid soak: ${r.ticks} ticks (${mmss(r.ticks * SERVER_TICK_MS)}), step avg ${r.stepAvg.toFixed(3)} ms, ` +
      `p99 ${r.stepP99.toFixed(3)} ms, max ${r.stepMax.toFixed(2)} ms, bots ${(r.botShare * 100).toFixed(0)}% of step, ` +
      `LOD ${(r.lodShare * 100).toFixed(0)}% of bot ticks`,
    `  bots: ${r.m.bots.length} (${r.scavs} scavs) — extracted ${r.extracts.length}, died ${r.deaths.length}, timed out ${r.timeouts}`,
    `  extract times: ${r.extracts.map(mmss).join(" ") || "-"}`,
    `  death times:   ${r.deaths.map(mmss).join(" ") || "-"}`,
    `  containers opened ${r.containersOpened} / emptied ${r.containersEmptied} of ${r.m.map.containers.length}, ` +
      `bodies searched ${r.corpsesSearched}/${r.m.containers.corpses().length}`,
    `  events ${JSON.stringify(r.counts)}`,
    `  planner served ${st.served} (unreachable ${st.unreachable}, deferred ${st.deferred}, route hits ${st.routeHits}, ` +
      `max tick work ${st.maxTickWork}/${r.m.planner.budgetWork})`,
  ].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [bots = "31", minutes = "30", seed = "2026"] = process.argv.slice(2);
  const r = runSoak({ bots: Number(bots), minutes: Number(minutes), seed: Number(seed) });
  console.log(describeSoak(r));
  if (r.errors.length) console.error(r.errors[0]);
}
