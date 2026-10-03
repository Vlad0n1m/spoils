/**
 * Raid soak / perf bench (perf memo §5, NPC MODEL v5 §2.6): a whole 30-minute raid on the Steppe
 * with N humans and the map's NPCs (boss groups + marauder squads), stepped at 20 Hz in simulated
 * time. Measures Match.step wall time (avg / p99 / max after JIT warm-up), the NPC brain share of
 * it, how many NPCs are awake (dormancy), and tells the raid's story: NPC deaths, leash discipline,
 * and that no NPC ever loots or extracts.
 *
 * Humans are driven one of three ways:
 * - "tour" (default): each human hops (teleport) from one NPC post / boss spot to the next every
 *   `hopMs`, standing in view of the squad without shooting, so squads wake, fight, search and
 *   return all over the map. `observer` tops their HP up so the raid runs its full length;
 * - "scripted": econ/human.ts HumanAgents with mixed strategies (real looting, fighting, extracting);
 * - "idle": standing at their spawn (most NPCs stay dormant).
 *
 * Used by soak.test.ts (asserts against PERF_BUDGET) and runnable on its own:
 *   apps/game-server/node_modules/.bin/tsx apps/game-server/src/sim/perf.bench.ts [humans] [minutes] [seed] [tour|scripted|idle] [roll|max]
 */

import { pathToFileURL } from "node:url";
import { MATCH, NPC, SERVER_TICK_MS, bossGroupNpcCount, generateMap, mulberry32, npcPostsOf, rollBossSpawns, type NpcSquadSpawn } from "@extract/shared";
import { HumanAgent, STRATEGIES } from "./econ/human.js";
import { Match } from "./match.js";
import type { Pt } from "./nav.js";
import { counterUid } from "./test-utils.js";
import type { MatchEvent, PlayerRuntime, RosterEntry } from "./types.js";

export interface SoakOptions {
  humans?: number;
  minutes?: number;
  seed?: number;
  /** Keep the humans alive (default true for "tour" / "idle", false for "scripted"). */
  observer?: boolean;
  drive?: "tour" | "scripted" | "idle";
  /** Tour: time at each stop. */
  hopMs?: number;
  /** "max": every NPC post at its largest squad (cap NPC.MAX_PER_RAID incl. boss groups); "roll": the seed's roll. */
  npcFill?: "roll" | "max";
}

export interface SoakResult {
  m: Match;
  ticks: number;
  stepAvg: number;
  stepP99: number;
  stepMax: number;
  /** Share of step time spent in NPC brains (sampled every tick). */
  npcShare: number;
  counts: Record<string, number>;
  npcs: number;
  npcDeaths: number;
  humanDeaths: number;
  /** Awake (non-dormant) living NPCs per tick: mean and max. */
  awakeAvg: number;
  awakeMax: number;
  /** Shots fired by an NPC inside the peace window before it was hit, with no human inside its post (must be 0). */
  peaceViolations: number;
  /** Share of awake-NPC ticks spent deciding at the LOD rate. */
  lodShare: number;
  /** Largest distance any NPC stood beyond its chase radius (sampled every second; ~0 expected). */
  leashMaxOut: number;
  /** Containers / corpses NPCs searched and NPCs that extracted (must be 0). */
  npcLooted: number;
  npcExtracted: number;
  /** Uncaught exceptions inside step (the soak asserts there are none). */
  errors: unknown[];
}

function roster(humans: number): RosterEntry[] {
  return Array.from({ length: humans }, (_, i) => ({ userId: `soak-human-${i}`, nickname: `Human${i}` }));
}

/** Every post at its largest squad, capped at NPC.MAX_PER_RAID together with the boss groups. */
export function maxNpcFill(seed: number): NpcSquadSpawn[] {
  const map = generateMap("steppe");
  let total = bossGroupNpcCount(rollBossSpawns(seed, map.bosses));
  const out: NpcSquadSpawn[] = [];
  // Highest tiers first so the cap drops road camps / T1 like rollNpcSpawns does.
  const rank = (p: { kind: string; tier: number }) => (p.kind === "road" ? 0 : p.tier);
  const posts = [...npcPostsOf(map)].sort((a, b) => rank(b) - rank(a) || a.id - b.id);
  for (const p of posts) {
    const n = Math.max(1, p.size[1]);
    if (total + n > NPC.MAX_PER_RAID) continue;
    out.push({ postId: p.id, members: n });
    total += n;
  }
  return out.sort((a, b) => a.postId - b.postId);
}

export function runSoak(o: SoakOptions = {}): SoakResult {
  const humans = o.humans ?? 1;
  const minutes = o.minutes ?? MATCH.DURATION_MS / 60_000;
  const seed = o.seed ?? 2026;
  const drive = o.drive ?? "tour";
  const m = new Match({
    roster: roster(humans), rng: mulberry32(seed), mapSeed: seed, mapId: "steppe", newUid: counterUid,
    now: () => 1_700_000_000_000, strictLedger: true,
    npcSpawns: o.npcFill === "max" ? maxNpcFill(seed) : undefined,
  });
  const observer = o.observer ?? drive !== "scripted";
  const people = m.allRuntimes().filter((r) => !r.isNpc);
  const npcs = m.npcs.runtimes();
  // NPC brain time: wrap each brain's update (no change to the brains themselves).
  let npcMs = 0;
  for (const b of m.npcs.brains) {
    const orig = b.update.bind(b);
    b.update = (dt: number) => {
      const t0 = performance.now();
      orig(dt);
      npcMs += performance.now() - t0;
    };
  }
  const agents = drive === "scripted"
    ? people.map((rt, i) => new HumanAgent(m, rt, { strategy: STRATEGIES[i % STRATEGIES.length]!, rng: mulberry32((seed ^ (0x51ed + i * 7919)) >>> 0) }))
    : [];
  // Tour stops: every NPC post and boss spot, 450 px off toward the map centre (in view, out of the post).
  const stops: Pt[] = [
    ...m.npcs.squads.map((sq) => {
      const a = sq.post ?? sq.members[0]!.pub;
      const cx = m.map.width / 2 - a.x, cy = m.map.height / 2 - a.y;
      const d = Math.hypot(cx, cy) || 1;
      return { x: a.x + (cx / d) * 450, y: a.y + (cy / d) * 450 };
    }),
  ];
  const hopMs = o.hopMs ?? 60_000;
  const hop = (rt: PlayerRuntime, k: number) => {
    if (stops.length === 0 || !rt.pub.alive) return;
    const s = stops[k % stops.length]!;
    rt.pub.x = rt.prevX = s.x;
    rt.pub.y = rt.prevY = s.y;
    rt.pub.aim = Math.atan2(m.map.height / 2 - s.y, m.map.width / 2 - s.x) + Math.PI;
  };

  const ticks = Math.round((minutes * 60_000) / SERVER_TICK_MS);
  const ms: number[] = [];
  const counts: Record<string, number> = {};
  const errors: unknown[] = [];
  let npcTotal = 0;
  let stepTotal = 0;
  let peaceViolations = 0;
  const wasHit = new Set<number>();
  let lodTicks = 0;
  let awakeTicks = 0;
  let awakeSum = 0;
  let awakeMax = 0;
  let leashMaxOut = 0;
  let npcDeaths = 0;
  let humanDeaths = 0;
  for (let i = 0; i < ticks && !m.ended; i++) {
    if (drive === "tour" && i % Math.round(hopMs / SERVER_TICK_MS) === 0) {
      const k = Math.floor((i * SERVER_TICK_MS) / hopMs);
      people.forEach((rt, h) => hop(rt, k + h * Math.max(1, Math.floor(stops.length / Math.max(1, humans)))));
    }
    if (observer) for (const h of people) if (h.pub.alive && h.pub.hp < 100) h.pub.hp = 100;
    for (const a of agents) a.update(SERVER_TICK_MS);
    const n0 = npcMs;
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
      npcTotal += npcMs - n0;
    }
    for (const e of m.drainEvents() as MatchEvent[]) {
      counts[e.type] = (counts[e.type] ?? 0) + 1;
      if (e.type === "kill") {
        const v = m.allRuntimes().find((r) => r.id === e.msg.victimId);
        if (v?.isNpc) npcDeaths++;
        else humanDeaths++;
      }
      if (m.clock > NPC.PEACE_MS) continue;
      if (e.type === "hit") wasHit.add(e.target);
      if (e.type === "shot" && m.rosterRuntime(e.src)?.isNpc && !wasHit.has(e.src) && !intruderNear(m, m.rosterRuntime(e.src)!)) peaceViolations++;
    }
    let awake = 0;
    for (const b of m.npcs.brains) {
      if (!b.rt.pub.alive || b.rt.dormant) continue;
      awake++;
      if (b.lod) lodTicks++;
    }
    awakeTicks += awake;
    awakeSum += awake;
    awakeMax = Math.max(awakeMax, awake);
    if (i % 20 === 0) {
      for (const rt of npcs) {
        if (!rt.pub.alive) continue;
        const inf = m.npcs.info(rt)!;
        leashMaxOut = Math.max(leashMaxOut, Math.hypot(rt.pub.x - inf.anchor.x, rt.pub.y - inf.anchor.y) - inf.chase);
      }
    }
  }
  // The first second is JIT warm-up of every system; the budget is about steady state.
  const steady = ms.slice(20).sort((x, y) => x - y);
  const avg = steady.reduce((s, v) => s + v, 0) / Math.max(1, steady.length);
  let npcLooted = 0;
  let npcExtracted = 0;
  for (const rt of npcs) {
    npcLooted += rt.stats.containersSearched + rt.stats.corpsesSearched;
    if (rt.exitReport?.exit === "extract") npcExtracted++;
  }
  return {
    m, ticks: ms.length,
    stepAvg: avg,
    stepP99: steady[Math.floor(steady.length * 0.99)] ?? 0,
    stepMax: steady[steady.length - 1] ?? 0,
    npcShare: stepTotal > 0 ? npcTotal / stepTotal : 0,
    counts, npcs: npcs.length, npcDeaths, humanDeaths,
    awakeAvg: ms.length ? awakeSum / ms.length : 0, awakeMax,
    peaceViolations,
    lodShare: awakeTicks > 0 ? lodTicks / awakeTicks : 0,
    leashMaxOut, npcLooted, npcExtracted, errors,
  };
}

/** A living human inside this NPC's post (its leash of the anchor) or within NPC.PEACE_CLOSE_PX: fair game in the peace window. */
function intruderNear(m: Match, npc: PlayerRuntime): boolean {
  const info = m.npcs.info(npc);
  if (!info) return false;
  return m.allRuntimes().some((h) => !h.isNpc && h.pub.alive &&
    (Math.hypot(h.pub.x - npc.pub.x, h.pub.y - npc.pub.y) <= NPC.PEACE_CLOSE_PX + 80 ||
      Math.hypot(h.pub.x - info.anchor.x, h.pub.y - info.anchor.y) <= info.leash + 80));
}

export function describeSoak(r: SoakResult): string {
  const st = r.m.planner.stats;
  return [
    `raid soak: ${r.ticks} ticks (${((r.ticks * SERVER_TICK_MS) / 60_000).toFixed(1)} min), step avg ${r.stepAvg.toFixed(3)} ms, ` +
      `p99 ${r.stepP99.toFixed(3)} ms, max ${r.stepMax.toFixed(2)} ms; NPC brains ${(r.npcShare * 100).toFixed(0)}% of step`,
    `  humans: ${r.m.allRuntimes().filter((x) => !x.isNpc).length} (deaths ${r.humanDeaths}); NPCs: ${r.npcs} ` +
      `(${r.m.npcs.groups.length} boss groups, ${r.m.npcs.squads.length - r.m.npcs.groups.length} marauder squads), killed ${r.npcDeaths}`,
    `  awake NPCs avg ${r.awakeAvg.toFixed(1)}, max ${r.awakeMax}; LOD share ${(r.lodShare * 100).toFixed(0)}%; leash max out ${r.leashMaxOut.toFixed(0)} px`,
    `  peace violations ${r.peaceViolations}; NPC loot ops ${r.npcLooted}; NPC extracts ${r.npcExtracted}`,
    `  events ${JSON.stringify(r.counts)}`,
    `  planner: served ${st.served}, unreachable ${st.unreachable}, deferred ${st.deferred}, route hits ${st.routeHits}, max tick work ${st.maxTickWork}/${r.m.planner.budgetWork}`,
  ].join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [h, min, seed, drive, fill] = process.argv.slice(2);
  const r = runSoak({
    humans: h ? Number(h) : 24,
    minutes: min ? Number(min) : undefined,
    seed: seed ? Number(seed) : undefined,
    drive: (drive as SoakOptions["drive"]) ?? "scripted",
    npcFill: (fill as SoakOptions["npcFill"]) ?? "max",
  });
  console.log(describeSoak(r));
  if (r.errors.length) console.error(r.errors);
}
