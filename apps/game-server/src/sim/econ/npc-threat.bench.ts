/**
 * NPC threat micro-bench (NPC MODEL v5 targets, "NPC threat sanity"): one marauder of a class holds a
 * post on the real Steppe map; after the peace window an unarmed scripted human appears 400 px away
 * in its line of sight and strafes there (never shoots; its HP is topped up every step so the trial
 * always runs the full window). Per trial it records the NPC's shots, hits, damage, the delay from
 * its first sighting to its first shot, and shots fired at a target it could not see.
 *
 *   T=apps/game-server/node_modules/.bin/tsx
 *   $T apps/game-server/src/sim/econ/npc-threat.bench.ts [--classes low,mid,high,top] [--seeds 12]
 *      [--seed0 1] [--dist 400] [--window-s 20] [--strafe-ms 1200] [--walk] [--out DIR] [--tag T]
 *
 * Writes DIR/npc-threat[-tag].json ({ summary, trials }) and a .md table. Targets (design v5 §A):
 * hit rate low 10–20%, mid 20–30%, high 25–35%, top 30–45%; first shot >= reactMs[0] after the
 * first sighting; 0 shots at targets the NPC cannot see. "Hit rate" counts shots with >= 1 hit
 * (a shotgun's pellets are one shot); pellet hits and damage per shot are reported beside it.
 * Bosses and guards are not covered here (their post is inside a building, see loot-yield --strategy boss).
 * Sim core only: the posts are taken from the generated map's road camps (open ground, no forest),
 * re-tiered per class; emptyWorld, no boss groups, no other NPCs.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  INPUT_DT_MS,
  MARAUDER,
  NPC,
  NPC_CLASSES,
  PLAYER,
  SERVER_TICK_MS,
  circleIsFree,
  hasLineOfSight,
  mulberry32,
  npcPostsOf,
  type NpcClass,
  type NpcPost,
} from "@extract/shared";
import { activeWeapon } from "../bag.js";
import { Match, matchMap } from "../match.js";

const TIER_OF: Readonly<Record<NpcClass, 1 | 2 | 3 | 4>> = { low: 1, mid: 2, high: 3, top: 4 };

export interface ThreatOptions {
  cls: NpcClass;
  seed: number;
  /** Human distance from the NPC (px). */
  dist?: number;
  /** Measured window after the human appears (ms). */
  windowMs?: number;
  /** Strafe direction flips every strafeMs. */
  strafeMs?: number;
  /** Walk (quiet, slower) instead of run. */
  walk?: boolean;
}

export interface ThreatTrial {
  cls: NpcClass;
  seed: number;
  weapon: string;
  armor: number;
  /** Human placed in LOS of the post (false: no LOS spot found, trial skipped). */
  placed: boolean;
  shots: number;
  /** Shots with at least one hit. */
  shotHits: number;
  /** Hit events (pellets count one each). */
  hits: number;
  damage: number;
  /** ms from the human's appearance to the NPC's first sighting / first shot (-1 never). */
  seenAfterMs: number;
  firstShotAfterMs: number;
  /** First shot minus first sighting (-1 when it never fired). */
  reactMs: number;
  /** Shots while the NPC did not see the human (this step and the one before). */
  shotsUnseen: number;
  /** Share of the window the NPC saw the human. */
  seenShare: number;
}

export function runThreatTrial(o: ThreatOptions): ThreatTrial {
  const dist = o.dist ?? 400;
  const windowMs = o.windowMs ?? 20_000;
  const strafeMs = o.strafeMs ?? 1200;
  const rng = mulberry32((o.seed * 0x9e3779b1) >>> 0);
  const matchSeed = Math.floor(rng() * 2 ** 32) >>> 0;
  const map = matchMap(matchSeed, "steppe");
  const camps = npcPostsOf(map).filter((p) => p.kind === "road");
  const base = camps[o.seed % Math.max(1, camps.length)] ?? npcPostsOf(map)[0];
  if (!base) throw new Error("npc-threat: the map has no NPC posts");
  const post: NpcPost = { ...base, id: 0, kind: "poi", tier: TIER_OF[o.cls], patrol: [], size: [1, 1], chance: 1 };
  const m = new Match({
    roster: [{ userId: "threat-human", nickname: "Target" }],
    rng: mulberry32((matchSeed ^ 0x7e57) >>> 0),
    mapSeed: matchSeed,
    mapId: "steppe",
    mode: "live",
    emptyWorld: true,
    bosses: false,
    npcPosts: [post],
    npcSpawns: [{ postId: 0, members: 1 }],
    now: () => 1_700_000_000_000,
  });
  const h = m.allRuntimes().find((r) => !r.isNpc)!;
  const npc = m.npcs.runtimes()[0]!;
  const weapon = activeWeapon(npc)?.def ?? "";
  const armor = Number((npc.self.slots.get("armor")?.def ?? "armor_0").split("_")[1] ?? 0);
  const trial: ThreatTrial = {
    cls: o.cls, seed: o.seed, weapon, armor, placed: false, shots: 0, shotHits: 0, hits: 0, damage: 0,
    seenAfterMs: -1, firstShotAfterMs: -1, reactMs: -1, shotsUnseen: 0, seenShare: 0,
  };
  // A spot `dist` from the NPC with a clear line of sight and room to strafe.
  const nx = npc.pub.x;
  const ny = npc.pub.y;
  let spot: { x: number; y: number; a: number } | null = null;
  const a0 = rng() * Math.PI * 2;
  for (let k = 0; k < 24 && !spot; k++) {
    const a = a0 + (k * Math.PI * 2) / 24;
    const x = nx + Math.cos(a) * dist;
    const y = ny + Math.sin(a) * dist;
    if (x < 200 || y < 200 || x > map.width - 200 || y > map.height - 200) continue;
    if (!circleIsFree(m.idx, x, y, PLAYER.RADIUS + 6) || !hasLineOfSight(m.idx, nx, ny, x, y)) continue;
    // Room to strafe both ways.
    const px = -Math.sin(a) * 150;
    const py = Math.cos(a) * 150;
    if (!hasLineOfSight(m.idx, nx, ny, x + px, y + py) || !hasLineOfSight(m.idx, nx, ny, x - px, y - py)) continue;
    spot = { x, y, a };
  }
  if (!spot) return trial;
  trial.placed = true;
  // Peace window: the human waits far away (beyond any NPC view), then appears at the spot.
  const far = { x: nx + Math.cos(spot.a) * 3000, y: ny + Math.sin(spot.a) * 3000 };
  const place = (x: number, y: number) => {
    h.pub.x = h.prevX = Math.max(100, Math.min(map.width - 100, x));
    h.pub.y = h.prevY = Math.max(100, Math.min(map.height - 100, y));
  };
  place(far.x, far.y);
  const npcIdx = npc.rosterIndex;
  const hIdx = h.rosterIndex;
  let seq = 0;
  let inputAcc = 0;
  const step = (mx: number, my: number, aim: number) => {
    inputAcc += SERVER_TICK_MS;
    while (inputAcc >= INPUT_DT_MS) {
      inputAcc -= INPUT_DT_MS;
      m.enqueueInput(h.id, { seq: ++seq, mx, my, aim, fire: false, roll: false, walk: !!o.walk });
    }
    m.step(SERVER_TICK_MS);
  };
  while (m.clock < NPC.PEACE_MS + 500 && !m.ended) {
    step(0, 0, 0);
    m.drainEvents();
  }
  place(spot.x, spot.y);
  const t0 = m.clock;
  let seenPrev = false;
  let seenTicks = 0;
  let ticks = 0;
  while (m.clock - t0 < windowMs && !m.ended && npc.pub.alive) {
    const t = m.clock - t0;
    const dx = npc.pub.x - h.pub.x;
    const dy = npc.pub.y - h.pub.y;
    const d = Math.hypot(dx, dy);
    const toNpc = Math.atan2(dy, dx);
    const side = Math.floor(t / strafeMs) % 2 ? 1 : -1;
    // Strafe across the line of fire, pulled back toward the measuring distance.
    const radial = Math.max(-0.6, Math.min(0.6, (d - dist) / 200));
    const mx = Math.cos(toNpc) * radial - Math.sin(toNpc) * side;
    const my = Math.sin(toNpc) * radial + Math.cos(toNpc) * side;
    const len = Math.hypot(mx, my) || 1;
    h.pub.hp = h.pub.maxHp || 100;
    step(mx / len, my / len, toNpc);
    const seen = m.vision.sees(npcIdx, hIdx);
    ticks++;
    if (seen) seenTicks++;
    if (seen && trial.seenAfterMs < 0) trial.seenAfterMs = Math.round(m.clock - t0);
    let hitThisTick = false;
    for (const ev of m.drainEvents()) {
      if (ev.type === "shot" && ev.src === npcIdx) {
        trial.shots++;
        if (trial.firstShotAfterMs < 0) trial.firstShotAfterMs = Math.round(m.clock - t0);
        if (!seen && !seenPrev) trial.shotsUnseen++;
      } else if (ev.type === "hit" && ev.src === npcIdx && ev.target === hIdx) {
        trial.hits++;
        trial.damage += ev.msg.d;
        hitThisTick = true;
      }
    }
    if (hitThisTick) trial.shotHits++;
    seenPrev = seen;
  }
  trial.damage = Math.round(trial.damage);
  trial.seenShare = ticks ? Math.round((seenTicks / ticks) * 100) / 100 : 0;
  if (trial.firstShotAfterMs >= 0 && trial.seenAfterMs >= 0) trial.reactMs = trial.firstShotAfterMs - trial.seenAfterMs;
  return trial;
}

export interface ThreatSummary {
  cls: NpcClass;
  trials: number;
  placed: number;
  shots: number;
  /** Shots with >= 1 hit / shots. */
  hitRate: number;
  pelletHitsPerShot: number;
  damagePerShot: number;
  /** Damage per second of the window (strafing human, never shooting back). */
  dps: number;
  reactMsMin: number;
  reactMsMedian: number;
  reactTarget: readonly [number, number];
  shotsUnseen: number;
  seenShare: number;
  byWeapon: Record<string, { trials: number; shots: number; hitRate: number }>;
}

export function summarizeThreat(trials: readonly ThreatTrial[], windowMs: number): ThreatSummary[] {
  const out: ThreatSummary[] = [];
  for (const cls of NPC_CLASSES) {
    const ts = trials.filter((t) => t.cls === cls);
    if (!ts.length) continue;
    const pl = ts.filter((t) => t.placed);
    const sum = (f: (t: ThreatTrial) => number) => pl.reduce((a, t) => a + f(t), 0);
    const shots = sum((t) => t.shots);
    const reacts = pl.map((t) => t.reactMs).filter((v) => v >= 0).sort((a, b) => a - b);
    const byWeapon: ThreatSummary["byWeapon"] = {};
    for (const t of pl) {
      const w = (byWeapon[t.weapon] ??= { trials: 0, shots: 0, hitRate: 0 });
      w.trials++;
      w.shots += t.shots;
      w.hitRate += t.shotHits;
    }
    for (const w of Object.values(byWeapon)) w.hitRate = w.shots ? r3(w.hitRate / w.shots) : 0;
    out.push({
      cls,
      trials: ts.length,
      placed: pl.length,
      shots,
      hitRate: shots ? r3(sum((t) => t.shotHits) / shots) : 0,
      pelletHitsPerShot: shots ? r3(sum((t) => t.hits) / shots) : 0,
      damagePerShot: shots ? r3(sum((t) => t.damage) / shots) : 0,
      dps: pl.length ? r3(sum((t) => t.damage) / pl.length / (windowMs / 1000)) : 0,
      reactMsMin: reacts.length ? reacts[0]! : -1,
      reactMsMedian: reacts.length ? reacts[Math.floor(reacts.length / 2)]! : -1,
      reactTarget: MARAUDER[cls].reactMs,
      shotsUnseen: sum((t) => t.shotsUnseen),
      seenShare: pl.length ? r3(sum((t) => t.seenShare) / pl.length) : 0,
      byWeapon,
    });
  }
  return out;
}

function r3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

const TARGET_HIT: Readonly<Record<NpcClass, string>> = { low: "10–20%", mid: "20–30%", high: "25–35%", top: "30–45%" };

export function threatMarkdown(s: readonly ThreatSummary[], note: string): string {
  const L = [`# NPC threat micro-bench`, "", note, "",
    "| class | trials (placed) | shots | hit rate | target | pellet hits/shot | dmg/shot | DPS | react min / median ms | reactMs target | shots unseen | seen share | by weapon |",
    "|---|---:|---:|---:|---|---:|---:|---:|---|---|---:|---:|---|"];
  for (const c of s) {
    const w = Object.entries(c.byWeapon).map(([k, v]) => `${k} ${v.trials}× ${Math.round(v.hitRate * 100)}%`).join(", ");
    L.push(`| ${c.cls} | ${c.trials} (${c.placed}) | ${c.shots} | ${Math.round(c.hitRate * 100)}% | ${TARGET_HIT[c.cls]} | ${c.pelletHitsPerShot} | ${c.damagePerShot} | ${c.dps} | ${c.reactMsMin} / ${c.reactMsMedian} | ${c.reactTarget.join("–")} | ${c.shotsUnseen} | ${c.seenShare} | ${w} |`);
  }
  return L.join("\n") + "\n";
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const classes = (arg("classes") ?? NPC_CLASSES.join(",")).split(",") as NpcClass[];
  for (const c of classes) if (!NPC_CLASSES.includes(c)) throw new Error(`--classes: unknown ${c}`);
  const seeds = Number(arg("seeds") ?? 12);
  const seed0 = Number(arg("seed0") ?? 1);
  const dist = Number(arg("dist") ?? 400);
  const windowMs = Number(arg("window-s") ?? 20) * 1000;
  const strafeMs = Number(arg("strafe-ms") ?? 1200);
  const walk = process.argv.includes("--walk");
  const out = resolve(arg("out") ?? join(tmpdir(), "extract-econ"));
  const tag = arg("tag") ?? "";
  const trials: ThreatTrial[] = [];
  for (const cls of classes) {
    for (let i = 0; i < seeds; i++) {
      const t = runThreatTrial({ cls, seed: seed0 + i, dist, windowMs, strafeMs, walk });
      trials.push(t);
      console.log(`[${cls}] seed ${t.seed} ${t.weapon} a${t.armor}: ${t.placed ? `shots ${t.shots}, hit ${t.shotHits} (${t.hits} pellets, ${t.damage} dmg), seen +${t.seenAfterMs} ms, first shot +${t.firstShotAfterMs} ms, unseen shots ${t.shotsUnseen}` : "no LOS spot"}`);
    }
  }
  const summary = summarizeThreat(trials, windowMs);
  const note = `Steppe, one marauder per trial on a road-camp spot re-tiered per class, human ${dist} px away, ${walk ? "walking" : "running"} strafe flipping every ${strafeMs} ms, ${windowMs / 1000} s window after the ${NPC.PEACE_MS / 1000} s peace window; never shoots back.`;
  mkdirSync(out, { recursive: true });
  const base = join(out, `npc-threat${tag ? "-" + tag : ""}`);
  writeFileSync(`${base}.json`, JSON.stringify({ note, summary, trials }, null, 1));
  writeFileSync(`${base}.md`, threatMarkdown(summary, note));
  console.log(threatMarkdown(summary, note));
  console.log(`wrote ${base}.json / .md`);
}
