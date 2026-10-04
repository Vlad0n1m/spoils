/**
 * Loot-yield harness, WORLD v6 world mode (spec §8.4, addendum A2): one 45-minute shard-cycle of the
 * persistent world on the real sim core (Match world mode: cycle clock, addHuman, server pool
 * placement, event boss with the HP reset, marauder respawns, A6 ground / corpse expiry, the wipe)
 * with scripted humans (human.ts) dropping in and out. There are no player-bots: every runtime is a
 * scripted human or an NPC the match spawns itself.
 *
 *   T=apps/game-server/node_modules/.bin/tsx; B=apps/game-server/src/sim/econ/loot-yield.bench.ts
 *   nice -n 10 $T $B --world [--cycles 4] [--users 36] [--seed0 1] [--boss foreman,commander,warden,foreman]
 *        [--enter-at 0,10,20,30] [--probe-strats full,poi] [--taggers 3] [--pool 700] [--tag T] [--out DIR]
 *
 * At most 4 shard-cycles per run (addendum A2: the owner's laptop). The wall clock is injected and
 * advanced in lockstep with the server ticks, so a 45-minute cycle runs as fast as the CPU allows.
 *
 * Arrivals: `users` distinct users make a first entry, 35 % uniformly in minutes 0:20–5:00 and the rest
 * in 5:00–35:00 (entry closes at 35:00); after a death 40 % and after an extract 20 % come back 1–3 min
 * later (≤ WORLD.MAX_ENTRIES_PER_CYCLE entries, only while entry is open). A full map (WORLD.CAPACITY
 * humans on it) turns the arrival away as `world_full`. Probes (`--enter-at`) are fixed-strategy
 * entries at fixed minutes for the late-joiner curve; taggers (`--taggers`) are free-kit "tags"
 * entries in minutes 25–33 that only search other humans' bodies (tag CR per late free-kit entry).
 *
 * The web side of raids/enter is mirrored in-process (KEEP IN SYNC with apps/web/src/lib/economy/
 * pool.ts releaseForEntry / fillBossBag): the per-entry release with the real poolReleaseForEntry
 * over the per-(cycle, user) / per-day / per-shard aggregates and Match.poolTargetCount(), items picked
 * at random with tier score ≤ the user's max tier risked this cycle; the boss bag once per shard with
 * the real bossFillPlan, best tier first (top only down to POOL.TOP_RESERVE), only while the boss lives.
 *
 * Per entry the record carries the entry minute, the exit, CR (junk, D22 tag CR, consumables found /
 * used / net), pool items released / captured, kills by NPC role (respawned marauders apart) and the
 * XP of the exit (xpForExit, no daily state: grindToday 0, no first-extract bonus). Per shard: pool
 * flow (released → placed / returned / extracted / broken / left / expired), the boss event (attempts,
 * reached, killed, HP resets, bag), respawns, A6 expiry (to the treasury / to the pool) and how the
 * surviving uniques of dead humans ended (looted by another human / expired to the treasury / left).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BOSSES,
  CONTAINER_STATE,
  DOG_TAG,
  ITEM_FLAG,
  NPC_ROLE,
  SERVER_TICK_MS,
  WORLD,
  bossFillPlan,
  cycleEnvSeed,
  dogTagCr,
  itemDef,
  junkSellCr,
  mulberry32,
  poolReleaseForEntry,
  riskUnitOf,
  uniqueTierScore,
  xpForExit,
  type BossKind,
  type LoadoutSnapshot,
  type PlayerExitReport,
  type SettledItem,
  type XpLine,
} from "@extract/shared";
import { Match } from "../match.js";
import type { PlayerRuntime } from "../types.js";
import { DEFAULT_STANCE, HumanAgent, consumableUnitCr, type PvpStance, type Strategy } from "./human.js";
import {
  ZERO_CONS,
  addConsumable,
  round2,
  starterLoadout,
  stat,
  withUidPrefix,
  isBoundUid,
  type Consumables,
  type Kit,
  type Stat,
} from "./loot-yield.bench.js";
import { fromRaidDur, refValueCr, seedPool, toRaidDur, topTierCount, type PoolItem } from "./pool-mirror.js";

/** Hard cap of shard-cycles per run (addendum A2). */
export const WORLD_MAX_CYCLES = 4;

export interface WorldShardOptions {
  seed: number;
  /** Cycle number (default 2000 + seed; the wall clock starts at its cycle start). */
  cycleId?: number;
  /** The event boss of this cycle (bossEventOf on the real schedule; the harness may force one). */
  bossEvent: BossKind | null;
  /** Distinct users making a first entry over the entry window (default 36). */
  users?: number;
  /** Share of first entries in minutes 0:20–5:00 (default 0.35). */
  earlyShare?: number;
  /** Re-entry chance after a death / an extract (defaults 0.4 / 0.2). */
  reenterDead?: number;
  reenterExtract?: number;
  /** Strategy / kit mix of the background users. */
  mix?: ReadonlyArray<{ key: Strategy; w: number }>;
  kitMix?: ReadonlyArray<{ key: Kit; w: number }>;
  /** Share of non-rat, non-full humans that hunt other humans (default 0.25). */
  huntShare?: number;
  /** Fixed-strategy entries at fixed minutes (late-joiner curve). */
  probes?: ReadonlyArray<{ atMin: number; strategy: Strategy; kit: Kit }>;
  /** Free-kit "tags" entries, uniform in [fromMin, toMin]. */
  taggers?: { n: number; fromMin: number; toMin: number };
  /** Lost pool size at the cycle start (seedPool, default 700). */
  poolSize?: number;
  /** POOL.RISK_K (economy_params pool_risk_k). */
  k?: number;
  /** Progress lines (default none). */
  log?: (line: string) => void;
}

export interface WorldEntryRecord {
  seed: number;
  cycle: number;
  entryId: string;
  userId: string;
  /** 1 = the user's first entry this cycle. */
  n: number;
  strategy: Strategy;
  stance: PvpStance;
  kit: Kit;
  role: "background" | "probe" | "tagger";
  enterMin: number;
  /** Probe minute (probes only), else -1. */
  probeMin: number;
  exit: string;
  /** boss | guard | marauder | human | env ("" = not killed). */
  killedBy: string;
  onMapMin: number;
  /** Humans on the map when this entry was admitted (itself excluded). */
  humansAtEntry: number;
  /** Match.poolTargetCount() at admission. */
  targetsAtEntry: number;
  /** Static containers already opened (not untouched) at admission, of the map's total. */
  openedAtEntry: number;
  /** Boss strategy on a boss map: admitted while the event boss was alive (one attempt). */
  attempt: boolean;
  riskUnits: number;
  maxTier: number;
  /** Junk CR (dog tags excluded) at autosell 1, before / after the free-kit × FREE_KIT.AUTOSELL_MULT. */
  junkCr: number;
  junkPaidCr: number;
  /** Dog tags extracted and their CR under D22 (full only for the killer, else × NON_KILLER_MULT). */
  tags: number;
  tagCr: number;
  /** Consumables (CR-eq, non-FREE): found / used by the agent, extracted − brought. */
  consFoundCr: number;
  consUsedCr: number;
  consNetCr: number;
  /** junkPaidCr + tagCr + consNetCr. */
  crTotal: number;
  /** Containers opened (agent) and the server count that pays XP (open delay passed, once per user). */
  containers: number;
  containersXp: number;
  corpsesSearched: number;
  kills: { human: number; boss: number; guard: number; marauder: number; respawned: number };
  /** Pool items released to this entry / never placed (extract before APPLY_AFTER_MS) / boss bag items it triggered. */
  pool: { released: number; unplaced: number; bossFill: number };
  /** Uniques extracted that were not this entry's own, by origin. */
  gained: { pool: number; carrier: number; boss: number; corpse: number; other: number; top: number };
  /** Boss strategy: reached the event boss's spot / killed it. */
  hunt: { reached: boolean; killed: boolean };
  xp: number;
  xpLines: XpLine[];
  leaveReason: string;
}

export interface WorldShardResult {
  seed: number;
  cycle: number;
  bossEvent: BossKind | null;
  wallMs: number;
  entries: number;
  users: number;
  /** Arrivals turned away: map full / the user's entry cap. */
  worldFull: number;
  entryLimit: number;
  maxHumans: number;
  exits: Record<string, number>;
  pool: {
    sizeBefore: number;
    topBefore: number;
    released: number;
    entriesWithRelease: number;
    /** Never placed: handed back at an extract (unplaced) / still waiting at the wipe. */
    returnedUnplaced: number;
    pendingAtWipe: number;
    placed: number;
    /** Fate of every released entry item (last life). */
    fate: Record<string, number>;
    /** Released / extracted by any human, by the releasing entry's minute bucket (0, 5, 10, …). */
    byEntryMin: Record<string, { released: number; extracted: number }>;
  };
  boss: {
    kind: BossKind | null;
    attempts: number;
    reached: number;
    killedAtMin: number;
    /** human | npc | "" (alive at the wipe). */
    killedBy: string;
    resets: number;
    bagFilled: number;
    bagStowed: boolean;
    bagFate: Record<string, number>;
  };
  respawn: { squads: number; npcs: number; killedByHumans: number; consumablesCr: number };
  expiry: {
    /** A6: player valuables → treasury (count, top tier, scrap CR) and NPC-corpse pool items → pool. */
    treasury: number;
    treasuryTop: number;
    treasuryRefCr: number;
    toPool: number;
  };
  /** Uniques that survived on dead humans' bodies, by final fate. */
  corpseUniques: Record<string, number>;
  /** Human deaths on the map. */
  humanDeaths: number;
  /** Map age once a minute: static containers opened (any) / emptied, T3+T4 opened, of `containers`. */
  mapAge: Array<{ min: number; opened: number; emptied: number; t34Opened: number; humans: number }>;
  containers: number;
  t34Containers: number;
}

interface User {
  id: string;
  strategy: Strategy;
  kit: Kit;
  stance: PvpStance;
  level: number;
  entries: number;
  maxRisk: number;
  maxTier: number;
  released: number;
}

interface Live {
  rec: WorldEntryRecord;
  user: User;
  rt: PlayerRuntime;
  agent: HumanAgent;
  ownUids: Set<string>;
  brought: Consumables;
}

const MIN = 60_000;
const bucketOf = (min: number) => String(Math.max(0, Math.min(30, Math.floor(min / 5) * 5)));

function drawMix<T extends string>(mix: ReadonlyArray<{ key: T; w: number }>, rng: () => number): T {
  const total = mix.reduce((a, e) => a + e.w, 0);
  let roll = rng() * total;
  for (const e of mix) {
    roll -= e.w;
    if (roll <= 0) return e.key;
  }
  return mix[mix.length - 1]!.key;
}

/** One shard-cycle of the world with scripted humans dropping in (see the header). */
export function runWorldShard(o: WorldShardOptions): { result: WorldShardResult; entries: WorldEntryRecord[] } {
  const t0 = performance.now();
  const cycle = o.cycleId ?? 2000 + o.seed;
  const startAt = cycle * WORLD.CYCLE_MS;
  const entryCloseMs = WORLD.CYCLE_MS - WORLD.ENTRY_CLOSE_MS;
  const rng = mulberry32((o.seed * 0x9e3779b1) >>> 0);
  const matchSeed = Math.floor(rng() * 2 ** 32) >>> 0;
  const lootSeed = Math.floor(rng() * 2 ** 32) >>> 0;
  const wall = { t: startAt };
  let uidSeq = 0;
  const m = new Match({
    roster: [],
    rng: mulberry32((matchSeed ^ 0x2026) >>> 0),
    mapSeed: matchSeed,
    lootSeed,
    mapId: "steppe",
    mode: "live",
    newUid: () => `w${o.seed}-${uidSeq++}`,
    now: () => wall.t,
    envSeed: cycleEnvSeed(cycle),
    world: { cycleId: cycle, shard: 0, cycleStartsAt: startAt, entryCloseMs, bossEvent: o.bossEvent },
  });

  // ---- the lost pool and the web's per-entry release (mirrored in-process)
  const pool: PoolItem[] = seedPool(o.poolSize ?? 700, mulberry32((o.seed ^ 0x5eed9001) >>> 0), `wp${o.seed}`);
  const sizeBefore = pool.length;
  const topBefore = topTierCount(pool);
  const prng = mulberry32((o.seed ^ 0xa110c) >>> 0);
  const tierOf = (p: PoolItem) => uniqueTierScore(p.def, p.rarity);
  const take = (n: number, maxTier: number, bestFirst: boolean): SettledItem[] => {
    const cand = pool.map((p, i) => ({ p, i, r: prng() })).filter((c) => tierOf(c.p) <= maxTier);
    cand.sort((a, b) => (bestFirst ? tierOf(b.p) - tierOf(a.p) : 0) || a.r - b.r);
    const picked = cand.slice(0, Math.max(0, n));
    const idx = new Set(picked.map((c) => c.i));
    for (let i = pool.length - 1; i >= 0; i--) if (idx.has(i)) pool.splice(i, 1);
    return picked.map(({ p }) => ({ uid: p.uid, def: p.def, qty: 1, rarity: p.rarity, dur: toRaidDur(p.def, p.dur) }));
  };
  let shardReleased = 0;
  let bagFilled = false;
  const riskUsers = new Set<string>();
  const poolUid = new Map<string, { entry: WorldEntryRecord; boss: boolean }>();

  // ---- users and arrivals
  const mix = o.mix ?? [{ key: "rat", w: 0.3 }, { key: "poi", w: 0.4 }, { key: "boss", w: o.bossEvent ? 0.15 : 0 }, { key: "full", w: 0.15 }];
  const kitMix = o.kitMix ?? [{ key: "starter", w: 3 }, { key: "free", w: 1 }, { key: "hunter", w: 1 }];
  const usable = mix.filter((e) => e.w > 0);
  const arng = mulberry32((o.seed ^ 0x10bb7) >>> 0);
  const users: User[] = [];
  const newUser = (strategy: Strategy, kit: Kit, stance?: PvpStance): User => {
    const u: User = {
      id: `ws${o.seed}-u${users.length}`, strategy, kit, stance: stance ?? DEFAULT_STANCE[strategy],
      level: kit === "hunter" ? 5 : kit === "starter" ? 3 : 1 /* "pistol": a new kit buyer */, entries: 0, maxRisk: 0, maxTier: 0, released: 0,
    };
    users.push(u);
    return u;
  };
  type Arrival = { at: number; user: User; role: WorldEntryRecord["role"]; probeMin: number };
  const queue: Arrival[] = [];
  const open = WORLD.RESET_MS;
  const nUsers = o.users ?? 36;
  for (let i = 0; i < nUsers; i++) {
    const strategy = drawMix(usable, arng);
    const kit = strategy === "npcfarm" ? "free" : drawMix(kitMix, arng);
    const hunts = strategy !== "rat" && strategy !== "full" && arng() < (o.huntShare ?? 0.25);
    const early = arng() < (o.earlyShare ?? 0.35);
    const at = early ? open + arng() * (5 * MIN - open) : 5 * MIN + arng() * (entryCloseMs - 5 * MIN - 1000);
    queue.push({ at, user: newUser(strategy, kit, hunts ? "hunt" : undefined), role: "background", probeMin: -1 });
  }
  for (const p of o.probes ?? []) {
    queue.push({ at: Math.max(open, Math.min(entryCloseMs - 1000, p.atMin * MIN)), user: newUser(p.strategy, p.kit), role: "probe", probeMin: p.atMin });
  }
  if (o.taggers) {
    for (let i = 0; i < o.taggers.n; i++) {
      const at = (o.taggers.fromMin + arng() * (o.taggers.toMin - o.taggers.fromMin)) * MIN;
      queue.push({ at: Math.min(entryCloseMs - 1000, at), user: newUser("tags", "free"), role: "tagger", probeMin: -1 });
    }
  }
  const sortQueue = () => queue.sort((a, b) => a.at - b.at);
  sortQueue();

  // ---- bookkeeping
  const lives: Live[] = [];
  const byRoster = new Map<number, Live>();
  const records: WorldEntryRecord[] = [];
  const res: WorldShardResult = {
    seed: o.seed, cycle, bossEvent: o.bossEvent, wallMs: 0, entries: 0, users: 0, worldFull: 0, entryLimit: 0, maxHumans: 0, exits: {},
    pool: { sizeBefore, topBefore, released: 0, entriesWithRelease: 0, returnedUnplaced: 0, pendingAtWipe: 0, placed: 0, fate: {}, byEntryMin: {} },
    boss: { kind: o.bossEvent, attempts: 0, reached: 0, killedAtMin: -1, killedBy: "", resets: 0, bagFilled: 0, bagStowed: false, bagFate: {} },
    respawn: { squads: 0, npcs: 0, killedByHumans: 0, consumablesCr: 0 },
    expiry: { treasury: 0, treasuryTop: 0, treasuryRefCr: 0, toPool: 0 },
    corpseUniques: {}, humanDeaths: 0, mapAge: [],
    containers: m.map.containers.length, t34Containers: m.map.containers.filter((c) => c.tier >= 3).length,
  };
  /** uid → fate of its last life ("extracted:<entryId>", "broken", "mia", "returned", "left", "expired", "expired_pool"). */
  const fate = new Map<string, string>();
  const corpseUids = new Set<string>();
  const seenCorpses = new Set<string>();
  const respawned = new Set<PlayerRuntime>();
  const seenSquads = new Set<object>();
  let bossPrevHp = -1;
  let bossStowSeen = false;
  const usedUsers = new Set<string>();

  const mapAgeNow = () => {
    let opened = 0, emptied = 0, t34Opened = 0;
    m.map.containers.forEach((c, i) => {
      const st = m.containers.stateOf(i);
      if (st === CONTAINER_STATE.UNTOUCHED) return;
      opened++;
      if (st === CONTAINER_STATE.EMPTIED) emptied++;
      if (c.tier >= 3) t34Opened++;
    });
    return { opened, emptied, t34Opened };
  };

  const admit = (a: Arrival): void => {
    const u = a.user;
    if (m.ended || m.clock >= entryCloseMs) return;
    const cur = m.currentOf(u.id);
    if (cur?.pub.alive) return;
    if (u.entries >= WORLD.MAX_ENTRIES_PER_CYCLE) {
      res.entryLimit++;
      return;
    }
    if (m.humansOnMap() >= WORLD.CAPACITY || m.allRuntimes().length >= WORLD.MAX_RUNTIMES_PER_SHARD - WORLD.RUNTIME_HEADROOM) {
      res.worldFull++;
      return;
    }
    u.entries++;
    const entryId = `${u.id}-e${u.entries}`;
    const snapshot: LoadoutSnapshot | null = u.kit === "free" ? null : withUidPrefix(starterLoadout(u.id, u.kit), `${entryId}:`);
    if (snapshot) snapshot.level = u.level;
    const risky = (snapshot?.entries ?? []).filter((e) => e.uid && !isBoundUid(e.uid) && riskUnitOf({ bound: false, dur: fromRaidDur(e.def, e.dur) }) === 1);
    const risk = risky.length;
    const entryTier = risky.reduce((t, e) => Math.max(t, uniqueTierScore(e.def, e.rarity)), 0);
    if (risk >= 1) riskUsers.add(u.id);
    const humansAtEntry = m.humansOnMap();
    const targets = m.poolTargetCount();
    const age = mapAgeNow();
    // raids/enter step 6 (releaseForEntry): budget per (cycle, user), shard cap, daily cap, taper, targets.
    const plan = poolReleaseForEntry({
      poolSize: pool.length, entryRisk: risk, userCycleMaxRisk: u.maxRisk, userCycleReleased: u.released,
      userDayReleased: u.released, shardReleased, riskUsers: riskUsers.size, atMs: m.clock, entryCloseMs, targets, k: o.k,
    });
    const maxTier = Math.max(u.maxTier, entryTier);
    const released = take(plan.n, maxTier, false);
    u.maxRisk = Math.max(u.maxRisk, risk);
    u.maxTier = maxTier;
    u.released += released.length;
    shardReleased += released.length;
    // Step 7 (fillBossBag): once per shard, while the event boss lives, gated by the shard's risk.
    let bossFill: SettledItem[] = [];
    if (o.bossEvent && !bagFilled && m.bossAlive()) {
      const shardRiskSum = users.filter((x) => x.entries > 0).reduce((s, x) => s + x.maxRisk, 0);
      const anyTopRisk = users.some((x) => x.entries > 0 && x.maxTier === 2);
      const fp = bossFillPlan({
        slots: BOSSES[o.bossEvent].poolSlots, shardRiskSum, anyTopRisk, poolSize: pool.length, topInPool: topTierCount(pool), filled: bagFilled,
      });
      if (fp.n > 0) {
        const best = fp.maxTop > 0 ? take(Math.min(fp.n, fp.maxTop), 2, true) : [];
        bossFill = [...best, ...take(fp.n - best.length, Math.min(fp.maxTier, 1), true)];
        bagFilled = bossFill.length > 0;
        res.boss.bagFilled = bossFill.length;
      }
    }
    const rt = m.addHuman({
      entryId, userId: u.id, nickname: u.id.toUpperCase(), loadoutId: snapshot?.loadoutId ?? "", guest: false, level: u.level,
      snapshot, pool: released, bossFill,
    });
    m.attachHuman(u.id, `s-${entryId}`);
    const agent = new HumanAgent(m, rt, {
      strategy: u.strategy,
      rng: mulberry32((o.seed ^ 0x4a3a ^ Math.imul(rt.rosterIndex, 0x2c1b3c6d)) >>> 0),
      bossTarget: u.strategy === "boss" ? (o.bossEvent ?? "nearest") : undefined,
      stance: u.stance,
    });
    const brought = ZERO_CONS();
    for (const e of snapshot?.entries ?? []) if (!e.uid) addConsumable(brought, e.def, e.qty);
    const rec: WorldEntryRecord = {
      seed: o.seed, cycle, entryId, userId: u.id, n: u.entries, strategy: u.strategy, stance: agent.stance, kit: u.kit, role: a.role,
      enterMin: round2(m.clock / MIN), probeMin: a.probeMin, exit: "", killedBy: "", onMapMin: 0, humansAtEntry, targetsAtEntry: targets,
      openedAtEntry: age.opened, attempt: u.strategy === "boss" && !!o.bossEvent && m.bossAlive(),
      riskUnits: risk, maxTier: entryTier, junkCr: 0, junkPaidCr: 0, tags: 0, tagCr: 0, consFoundCr: 0, consUsedCr: 0, consNetCr: 0, crTotal: 0,
      containers: 0, containersXp: 0, corpsesSearched: 0, kills: { human: 0, boss: 0, guard: 0, marauder: 0, respawned: 0 },
      pool: { released: released.length, unplaced: 0, bossFill: bossFill.length }, gained: { pool: 0, carrier: 0, boss: 0, corpse: 0, other: 0, top: 0 },
      hunt: { reached: false, killed: false }, xp: 0, xpLines: [], leaveReason: "",
    };
    for (const s of released) poolUid.set(s.uid, { entry: rec, boss: false });
    for (const s of bossFill) poolUid.set(s.uid, { entry: rec, boss: true });
    if (released.length) res.pool.entriesWithRelease++;
    res.pool.released += released.length;
    const b = (res.pool.byEntryMin[bucketOf(rec.enterMin)] ??= { released: 0, extracted: 0 });
    b.released += released.length;
    const live: Live = { rec, user: u, rt, agent, ownUids: new Set((snapshot?.entries ?? []).map((e) => e.uid).filter(Boolean)), brought };
    lives.push(live);
    byRoster.set(rt.rosterIndex, live);
    records.push(rec);
    usedUsers.add(u.id);
    res.entries++;
    if (rec.attempt) res.boss.attempts++;
    o.log?.(`  [${(m.clock / MIN).toFixed(1)}m] enter ${entryId} ${u.strategy}/${u.kit} humans ${humansAtEntry} targets ${targets} pool +${released.length}${bossFill.length ? ` bag ${bossFill.length}` : ""}`);
  };

  const finalize = (l: Live, rep: PlayerExitReport): void => {
    const r = l.rec;
    if (r.exit) return;
    const u = l.user;
    r.exit = rep.exit;
    r.onMapMin = round2((rep.atMs - (rep.enteredAtMs ?? 0)) / MIN);
    res.exits[rep.exit] = (res.exits[rep.exit] ?? 0) + 1;
    const tagsOut = rep.extracted.filter((s) => s.def === "junk_dogtag");
    const junkOut = rep.extracted.filter((s) => s.def !== "junk_dogtag");
    r.junkCr = junkSellCr(junkOut, 1).total;
    r.junkPaidCr = Math.floor(r.junkCr * (u.kit === "free" ? 0.5 : 1));
    r.tags = tagsOut.reduce((a, s) => a + s.qty, 0);
    r.tagCr = Math.floor(tagsOut.reduce((a, s) => a + dogTagCr(s.lvl ?? 0) * s.qty * (s.by === u.id ? 1 : DOG_TAG.NON_KILLER_MULT), 0));
    const out = ZERO_CONS();
    for (const s of rep.extracted) if (!itemDef(s.def)?.unique) addConsumable(out, s.def, s.qty);
    r.consFoundCr = Math.round(l.agent.log.consFoundCr);
    r.consUsedCr = Math.round(l.agent.log.consUsedCr);
    r.consNetCr = Math.round(out.cr - l.brought.cr);
    r.crTotal = r.junkPaidCr + r.tagCr + r.consNetCr;
    r.containers = l.agent.log.searched.length;
    r.containersXp = rep.stats.containersSearched;
    r.corpsesSearched = l.agent.log.corpsesSearched;
    r.leaveReason = l.agent.log.leaveReason;
    r.hunt.reached = l.agent.log.boss.reachedAt >= 0;
    r.hunt.killed = rep.stats.bossKills > 0;
    if (r.hunt.reached && o.bossEvent && u.strategy === "boss") res.boss.reached++;
    r.pool.unplaced = rep.unplaced?.length ?? 0;
    res.pool.returnedUnplaced += r.pool.unplaced;
    for (const s of rep.extracted) {
      if (!itemDef(s.def)?.unique) continue;
      fate.set(s.uid, `extracted:${r.entryId}`);
      if (l.ownUids.has(s.uid)) continue;
      const src = l.agent.log.uniqueSource.get(s.uid);
      const pu = poolUid.get(s.uid);
      if (uniqueTierScore(s.def, s.rarity) === 2) r.gained.top++;
      if (pu?.boss || src === "boss_body") r.gained.boss++;
      else if (pu && src === "npc_body") r.gained.carrier++;
      else if (pu) r.gained.pool++;
      else if (src === "human_body") r.gained.corpse++;
      else r.gained.other++;
    }
    for (const s of rep.lost) fate.set(s.uid, rep.exit === "mia" ? "mia" : rep.exit === "dead" ? "broken" : rep.exit);
    for (const s of rep.destroyed ?? []) fate.set(s.uid, "destroyed");
    for (const s of rep.unplaced ?? []) fate.set(s.uid, "returned");
    const npcKills = rep.stats.npcKills ?? 0;
    const guards = rep.stats.guardKills ?? 0;
    const xp = xpForExit({
      exit: rep.exit, onMapMs: rep.atMs - (rep.enteredAtMs ?? 0), haulCr: r.junkPaidCr, containers: rep.stats.containersSearched,
      marauders: npcKills - guards, guards, bosses: rep.stats.bossKills, rankedPvp: rep.victims?.length ?? 0, grindToday: 0, firstExtractToday: false,
    });
    r.xp = xp.total;
    r.xpLines = xp.lines;
    // A re-entry (D5) while entry is open.
    const p = rep.exit === "dead" ? (o.reenterDead ?? 0.4) : rep.exit === "extract" ? (o.reenterExtract ?? 0.2) : 0;
    if (r.role === "background" && u.entries < WORLD.MAX_ENTRIES_PER_CYCLE && arng() < p) {
      const at = m.clock + MIN + arng() * 2 * MIN;
      if (at < entryCloseMs) {
        queue.push({ at, user: u, role: "background", probeMin: -1 });
        sortQueue();
      }
    }
  };

  // ---- the cycle
  while (!m.ended) {
    while (queue.length && queue[0]!.at <= m.clock) admit(queue.shift()!);
    for (const l of lives) if (l.rt.pub.alive) l.agent.update(SERVER_TICK_MS);
    if (m.clock >= WORLD.CYCLE_MS - 2 * SERVER_TICK_MS) {
      res.pool.pendingAtWipe =
        m.allRuntimes().reduce((n, rt) => n + rt.pendingPool.filter((it) => poolUid.has(it.uid) && !poolUid.get(it.uid)!.boss).length, 0) +
        m.unplacedPool.filter((u) => poolUid.has(u.it.uid)).length;
    }
    wall.t += SERVER_TICK_MS;
    m.step(SERVER_TICK_MS);
    for (const ev of m.drainEvents()) {
      if (ev.type === "snd") {
        const l = byRoster.get(ev.to);
        if (l?.rt.pub.alive) l.agent.hear(ev.msg);
      } else if (ev.type === "kill") {
        const killer = ev.src >= 0 ? m.rosterRuntime(ev.src) : undefined;
        const victim = m.runtime(ev.msg.victimId) ?? m.allRuntimes().find((x) => x.id === ev.msg.victimId);
        const kl = killer ? byRoster.get(killer.rosterIndex) : undefined;
        const vRole = victim?.pub.role ?? NPC_ROLE.NONE;
        if (kl && victim) {
          if (vRole === NPC_ROLE.NONE) kl.rec.kills.human++;
          else if (vRole === NPC_ROLE.BOSS) kl.rec.kills.boss++;
          else if (vRole === NPC_ROLE.GUARD) kl.rec.kills.guard++;
          else kl.rec.kills.marauder++;
          if (respawned.has(victim)) {
            kl.rec.kills.respawned++;
            res.respawn.killedByHumans++;
          }
        }
        const vl = victim ? byRoster.get(victim.rosterIndex) : undefined;
        if (vl) {
          vl.rec.killedBy = !killer ? "env" : killer.isNpc ? (killer.pub.role === NPC_ROLE.BOSS ? "boss" : killer.pub.role === NPC_ROLE.GUARD ? "guard" : "marauder") : "human";
          res.humanDeaths++;
        }
        if (victim && victim === m.eventBoss()) {
          res.boss.killedAtMin = round2(m.clock / MIN);
          res.boss.killedBy = kl ? "human" : "npc";
        }
      } else if (ev.type === "exit") {
        const rt = m.entryById(ev.report.entryId ?? "");
        const l = rt ? byRoster.get(rt.rosterIndex) : undefined;
        if (l) finalize(l, ev.report);
      }
    }
    // Boss HP reset (D14) and the bag being stowed (D19).
    const boss = m.eventBoss();
    if (boss?.pub.alive) {
      if (bossPrevHp >= 0 && bossPrevHp < boss.pub.maxHp && boss.pub.hp >= boss.pub.maxHp) res.boss.resets++;
      bossPrevHp = boss.pub.hp;
      if (!bossStowSeen && bagFilled && m.pendingBossFill.length === 0) bossStowSeen = res.boss.bagStowed = true;
    }
    if (m.clock % MIN < SERVER_TICK_MS) res.mapAge.push({ min: Math.round(m.clock / MIN), ...mapAgeNow(), humans: m.humansOnMap() });
    // Once a second: respawned squads (D15), new human bodies (their surviving uniques).
    if (m.clock % 1000 < SERVER_TICK_MS) {
      for (const sq of m.npcs.squads) {
        if (sq.gen < 1 || seenSquads.has(sq)) continue;
        seenSquads.add(sq);
        res.respawn.squads++;
        for (const rt of sq.members) {
          respawned.add(rt);
          res.respawn.npcs++;
          for (const it of rt.self.slots.values()) if (!(it.flags & ITEM_FLAG.FREE)) res.respawn.consumablesCr += consumableUnitCr(it.def) * it.qty;
        }
      }
      for (const t of m.containers.corpses()) {
        if (seenCorpses.has(t.key)) continue;
        seenCorpses.add(t.key);
        if (t.npcCorpse) continue;
        for (const it of t.initial) if (it.uid && itemDef(it.def)?.unique && !(it.flags & ITEM_FLAG.FREE)) corpseUids.add(it.uid);
      }
    }
    res.maxHumans = Math.max(res.maxHumans, m.humansOnMap());
  }
  // MIA exits come out of the wipe; anything not finalized by an exit event is finalized here.
  for (const l of lives) if (!l.rec.exit && l.rt.exitReport) finalize(l, l.rt.exitReport);
  const end = m.report!;
  for (const s of end.leftOnMap) fate.set(s.uid, "left");
  for (const s of end.expired ?? []) fate.set(s.uid, "expired");
  for (const s of end.expiredToPool ?? []) fate.set(s.uid, "expired_pool");
  // Pool flow.
  const kindOf = (f: string) => (f.startsWith("extracted:") ? "extracted" : f);
  for (const [uid, pu] of poolUid) {
    const f = kindOf(fate.get(uid) ?? "unknown");
    if (pu.boss) {
      res.boss.bagFate[f] = (res.boss.bagFate[f] ?? 0) + 1;
      continue;
    }
    res.pool.fate[f] = (res.pool.fate[f] ?? 0) + 1;
    if (f === "extracted") res.pool.byEntryMin[bucketOf(pu.entry.enterMin)]!.extracted++;
  }
  res.pool.placed = res.pool.released - res.pool.returnedUnplaced - res.pool.pendingAtWipe;
  // A6 expiry.
  for (const s of end.expired ?? []) {
    res.expiry.treasury++;
    if (uniqueTierScore(s.def, s.rarity) === 2) res.expiry.treasuryTop++;
    res.expiry.treasuryRefCr += Math.round(refValueCr({ def: s.def, rarity: s.rarity, dur: fromRaidDur(s.def, s.dur) }));
  }
  res.expiry.toPool = (end.expiredToPool ?? []).length;
  for (const uid of corpseUids) {
    const f = fate.get(uid) ?? "unknown";
    const k = f.startsWith("extracted:") ? "looted" : f;
    res.corpseUniques[k] = (res.corpseUniques[k] ?? 0) + 1;
  }
  res.respawn.consumablesCr = Math.round(res.respawn.consumablesCr);
  res.users = usedUsers.size;
  res.wallMs = Math.round(performance.now() - t0);
  return { result: res, entries: records };
}

// ---------------------------------------------------------------- summary

export interface WorldSummary {
  cycles: number;
  entries: number;
  /** Late-joiner curve: entries by entry-minute bucket (background + probes; taggers apart). */
  byMinute: Record<string, { n: number; junk: Stat; crTotal: Stat; xp: Stat; extractRate: number; humansAtEntry: number; targets: number }>;
  /** Probes only, per strategy and probe minute: junk CR (paid) per entry. */
  probes: Record<string, Record<string, Stat>>;
  byStrategy: Record<string, { n: number; junk: Stat; crTotal: Stat; consFound: Stat; consUsed: Stat; consFoundMinusUsed: Stat; containers: Stat; xp: Stat; extractRate: number }>;
  taggers: { n: number; tagCr: Stat; tags: Stat; crTotal: Stat };
  freeLate: { n: number; tagCr: Stat };
  pool: { released: number; placed: number; returned: number; pendingAtWipe: number; fate: Record<string, number>; captureOfReleased: number; captureOfPlaced: number; byEntryMin: Record<string, { released: number; extracted: number; rate: number }> };
  boss: { events: number; killed: number; attempts: number; reached: number; perAttempt: number; perEvent: number; resets: number; bagFilled: number; bagFate: Record<string, number> };
  respawn: { squads: number; npcs: number; killedByHumans: number; consumablesCr: number };
  expiry: { treasury: number; treasuryTop: number; treasuryRefCr: number; toPool: number; perCycle: number };
  corpseUniques: Record<string, number>;
  mia: number;
  worldFull: number;
  medianHumansAtEntry: number;
  xpPerEntry: Stat;
}

export function summarizeWorld(results: readonly WorldShardResult[], entries: readonly WorldEntryRecord[]): WorldSummary {
  const add = (a: Record<string, number>, b: Record<string, number>) => {
    for (const [k, v] of Object.entries(b)) a[k] = (a[k] ?? 0) + v;
    return a;
  };
  const curve = entries.filter((e) => e.role !== "tagger");
  const byMinute: WorldSummary["byMinute"] = {};
  for (const b of ["0", "5", "10", "15", "20", "25", "30"]) {
    const es = curve.filter((e) => bucketOf(e.enterMin) === b);
    if (!es.length) continue;
    byMinute[b] = {
      n: es.length, junk: stat(es.map((e) => e.junkPaidCr)), crTotal: stat(es.map((e) => e.crTotal)), xp: stat(es.map((e) => e.xp)),
      extractRate: round2(es.filter((e) => e.exit === "extract").length / es.length),
      humansAtEntry: stat(es.map((e) => e.humansAtEntry)).median, targets: stat(es.map((e) => e.targetsAtEntry)).median,
    };
  }
  const probes: WorldSummary["probes"] = {};
  for (const e of entries) {
    if (e.role !== "probe") continue;
    ((probes[`${e.strategy}:${e.kit}`] ??= {})[String(e.probeMin)] ??= stat([]));
  }
  for (const [k, byMin] of Object.entries(probes)) {
    for (const min of Object.keys(byMin)) {
      byMin[min] = stat(entries.filter((e) => e.role === "probe" && `${e.strategy}:${e.kit}` === k && String(e.probeMin) === min).map((e) => e.junkPaidCr));
    }
  }
  const byStrategy: WorldSummary["byStrategy"] = {};
  for (const k of [...new Set(entries.map((e) => `${e.strategy}:${e.kit}`))].sort()) {
    const es = entries.filter((e) => `${e.strategy}:${e.kit}` === k);
    byStrategy[k] = {
      n: es.length, junk: stat(es.map((e) => e.junkPaidCr)), crTotal: stat(es.map((e) => e.crTotal)),
      consFound: stat(es.map((e) => e.consFoundCr)), consUsed: stat(es.map((e) => e.consUsedCr)), consFoundMinusUsed: stat(es.map((e) => e.consFoundCr - e.consUsedCr)),
      containers: stat(es.map((e) => e.containers)), xp: stat(es.map((e) => e.xp)), extractRate: round2(es.filter((e) => e.exit === "extract").length / es.length),
    };
  }
  const tg = entries.filter((e) => e.role === "tagger");
  const freeLate = entries.filter((e) => e.kit === "free" && e.enterMin >= 25);
  const poolFate: Record<string, number> = {};
  const poolBy: Record<string, { released: number; extracted: number; rate: number }> = {};
  let released = 0, placed = 0, returned = 0, pending = 0;
  for (const r of results) {
    add(poolFate, r.pool.fate);
    released += r.pool.released;
    placed += r.pool.placed;
    returned += r.pool.returnedUnplaced;
    pending += r.pool.pendingAtWipe;
    for (const [b, v] of Object.entries(r.pool.byEntryMin)) {
      const o = (poolBy[b] ??= { released: 0, extracted: 0, rate: 0 });
      o.released += v.released;
      o.extracted += v.extracted;
    }
  }
  for (const o of Object.values(poolBy)) o.rate = round2(o.released ? o.extracted / o.released : 0);
  const events = results.filter((r) => r.bossEvent);
  const attempts = events.reduce((n, r) => n + r.boss.attempts, 0);
  const killedByHuman = events.filter((r) => r.boss.killedBy === "human").length;
  const bossKillsByAttempt = entries.filter((e) => e.attempt && e.hunt.killed).length;
  return {
    cycles: results.length,
    entries: entries.length,
    byMinute,
    probes,
    byStrategy,
    taggers: { n: tg.length, tagCr: stat(tg.map((e) => e.tagCr)), tags: stat(tg.map((e) => e.tags)), crTotal: stat(tg.map((e) => e.crTotal)) },
    freeLate: { n: freeLate.length, tagCr: stat(freeLate.map((e) => e.tagCr)) },
    pool: {
      released, placed, returned, pendingAtWipe: pending, fate: poolFate,
      captureOfReleased: round2(released ? (poolFate["extracted"] ?? 0) / released : 0),
      captureOfPlaced: round2(placed ? (poolFate["extracted"] ?? 0) / placed : 0),
      byEntryMin: poolBy,
    },
    boss: {
      events: events.length, killed: killedByHuman, attempts, reached: events.reduce((n, r) => n + r.boss.reached, 0),
      perAttempt: round2(attempts ? bossKillsByAttempt / attempts : 0), perEvent: round2(events.length ? killedByHuman / events.length : 0),
      resets: events.reduce((n, r) => n + r.boss.resets, 0), bagFilled: events.reduce((n, r) => n + r.boss.bagFilled, 0),
      bagFate: events.reduce((a, r) => add(a, r.boss.bagFate), {} as Record<string, number>),
    },
    respawn: results.reduce((a, r) => ({ squads: a.squads + r.respawn.squads, npcs: a.npcs + r.respawn.npcs, killedByHumans: a.killedByHumans + r.respawn.killedByHumans, consumablesCr: a.consumablesCr + r.respawn.consumablesCr }), { squads: 0, npcs: 0, killedByHumans: 0, consumablesCr: 0 }),
    expiry: {
      ...results.reduce((a, r) => ({ treasury: a.treasury + r.expiry.treasury, treasuryTop: a.treasuryTop + r.expiry.treasuryTop, treasuryRefCr: a.treasuryRefCr + r.expiry.treasuryRefCr, toPool: a.toPool + r.expiry.toPool }), { treasury: 0, treasuryTop: 0, treasuryRefCr: 0, toPool: 0 }),
      perCycle: round2(results.reduce((n, r) => n + r.expiry.treasury, 0) / Math.max(1, results.length)),
    },
    corpseUniques: results.reduce((a, r) => add(a, r.corpseUniques), {} as Record<string, number>),
    mia: round2(entries.filter((e) => e.exit === "mia").length / Math.max(1, entries.length)),
    worldFull: results.reduce((n, r) => n + r.worldFull, 0),
    medianHumansAtEntry: stat(entries.map((e) => e.humansAtEntry)).median,
    xpPerEntry: stat(entries.map((e) => e.xp)),
  };
}

export function worldMarkdown(s: WorldSummary, results: readonly WorldShardResult[], note: string): string {
  const L: string[] = [`# World harness — ${s.cycles} shard-cycles, ${s.entries} entries`, "", note, ""];
  L.push("## Late-joiner curve (background + probes)", "", "| entry min | entries | junk CR paid (mean / median) | CR total (mean) | XP (mean) | extracted | humans at entry | pool targets |", "|---|---:|---|---:|---:|---:|---:|---:|");
  for (const [b, v] of Object.entries(s.byMinute)) {
    L.push(`| ${b}–${Number(b) + 5} | ${v.n} | ${v.junk.mean} / ${v.junk.median} | ${v.crTotal.mean} | ${v.xp.mean} | ${Math.round(v.extractRate * 100)}% | ${v.humansAtEntry} | ${v.targets} |`);
  }
  L.push("", "**Probes (junk CR paid, mean / n by probe minute):** " + Object.entries(s.probes).map(([k, by]) => `${k}: ${Object.entries(by).map(([mn, st]) => `${mn}m ${st.mean}`).join(", ")}`).join(" · "));
  L.push("", "## By strategy", "", "| strategy:kit | entries | junk paid | CR total | cons found / used / f−u | containers | XP | extracted |", "|---|---:|---:|---:|---|---:|---:|---:|");
  for (const [k, v] of Object.entries(s.byStrategy)) {
    L.push(`| ${k} | ${v.n} | ${v.junk.mean} | ${v.crTotal.mean} | ${v.consFound.mean} / ${v.consUsed.mean} / ${v.consFoundMinusUsed.mean} | ${v.containers.mean} | ${v.xp.mean} | ${Math.round(v.extractRate * 100)}% |`);
  }
  L.push(
    "",
    `**Tag tour (free-kit late taggers):** ${s.taggers.n} entries, tag CR median ${s.taggers.tagCr.median} (mean ${s.taggers.tagCr.mean}, p90 ${s.taggers.tagCr.p90}), tags median ${s.taggers.tags.median}; every free-kit entry after minute 25: ${s.freeLate.n}, tag CR median ${s.freeLate.tagCr.median}.`,
    "",
    `**Pool:** released ${s.pool.released}, placed ${s.pool.placed}, returned unplaced ${s.pool.returned}, waiting at the wipe ${s.pool.pendingAtWipe}; fates ${JSON.stringify(s.pool.fate)}; captured ${Math.round(s.pool.captureOfReleased * 100)}% of released, ${Math.round(s.pool.captureOfPlaced * 100)}% of placed; by entry minute ${JSON.stringify(s.pool.byEntryMin)}.`,
    "",
    `**Boss events:** ${s.boss.events}, killed by humans ${s.boss.killed} (${Math.round(s.boss.perEvent * 100)}% per event); attempts ${s.boss.attempts}, reached ${s.boss.reached}, per-attempt kill ${Math.round(s.boss.perAttempt * 100)}%; HP resets ${s.boss.resets}; bag items ${s.boss.bagFilled} → ${JSON.stringify(s.boss.bagFate)}.`,
    "",
    `**Respawns:** squads ${s.respawn.squads}, NPCs ${s.respawn.npcs}, killed by humans ${s.respawn.killedByHumans}, consumables in their bags ${s.respawn.consumablesCr} CR-eq.`,
    "",
    `**A6 expiry:** to the treasury ${s.expiry.treasury} uniques (${s.expiry.perCycle} per cycle, top ${s.expiry.treasuryTop}, scrap ${s.expiry.treasuryRefCr} CR), NPC-corpse pool items to the pool ${s.expiry.toPool}. Surviving uniques on dead humans: ${JSON.stringify(s.corpseUniques)}.`,
    "",
    `**Entries:** MIA ${Math.round(s.mia * 100)}%, map full ${s.worldFull} arrivals, median humans at entry ${s.medianHumansAtEntry}, XP per entry mean ${s.xpPerEntry.mean} / median ${s.xpPerEntry.median}.`,
    "",
    "## Shards",
    "",
    "| seed | boss | entries | users | full | max humans | exits | pool rel → fates | boss killed (min) / resets / bag | respawn sq / killed | expired → treasury / pool | wall s |",
    "|---:|---|---:|---:|---:|---:|---|---|---|---|---|---:|",
  );
  for (const r of results) {
    L.push(`| ${r.seed} | ${r.bossEvent ?? "-"} | ${r.entries} | ${r.users} | ${r.worldFull} | ${r.maxHumans} | ${JSON.stringify(r.exits)} | ${r.pool.released} → ${JSON.stringify(r.pool.fate)} | ${r.boss.killedBy || "alive"} (${r.boss.killedAtMin}) / ${r.boss.resets} / ${r.boss.bagFilled} | ${r.respawn.squads} / ${r.respawn.killedByHumans} | ${r.expiry.treasury} / ${r.expiry.toPool} | ${round2(r.wallMs / 1000)} |`);
  }
  return L.join("\n") + "\n";
}

/** CLI body of `loot-yield.bench.ts --world` (see the header). */
export function worldCli(arg: (name: string) => string | undefined, out: string, tag: string, stale: string[]): void {
  const num = (n: string): number | undefined => (arg(n) !== undefined ? Number(arg(n)) : undefined);
  const want = Math.max(1, Math.floor(num("cycles") ?? WORLD_MAX_CYCLES));
  const cycles = Math.min(WORLD_MAX_CYCLES, want);
  if (want > WORLD_MAX_CYCLES) console.warn(`[world] --cycles ${want}: at most ${WORLD_MAX_CYCLES} shard-cycles per run (addendum A2); running ${cycles}`);
  const seed0 = num("seed0") ?? 1;
  const bossList = (arg("boss") ?? "foreman,commander,warden,foreman").split(",").map((x) => x.trim());
  const enterAt = (arg("enter-at") ?? "0,10,20,30").split(",").filter(Boolean).map(Number);
  const probeStrats = (arg("probe-strats") ?? "full,poi").split(",").filter(Boolean) as Strategy[];
  const taggers = num("taggers") ?? 3;
  const users = num("users") ?? 36;
  const poolSize = num("pool");
  // --kit-mix pistol:3,free:2,starter:1,hunter:1 (background users) and --probe-kit (default starter).
  const kitMix = arg("kit-mix")
    ?.split(",")
    .filter(Boolean)
    .map((x) => {
      const [key, w] = x.split(":");
      if (!["starter", "free", "hunter", "pistol"].includes(key!)) throw new Error(`--kit-mix: unknown kit ${key}`);
      return { key: key as Kit, w: Number(w ?? 1) };
    });
  const probeKit = (arg("probe-kit") ?? "starter") as Kit;
  const results: WorldShardResult[] = [];
  const entries: WorldEntryRecord[] = [];
  for (let i = 0; i < cycles; i++) {
    const seed = seed0 + i;
    const b = bossList[i % bossList.length]!;
    const bossEvent = b === "none" || b === "" ? null : (b as BossKind);
    const probes = enterAt.flatMap((atMin) => probeStrats.map((strategy) => ({ atMin, strategy, kit: probeKit })));
    const r = runWorldShard({ seed, bossEvent, users, probes, kitMix, taggers: { n: taggers, fromMin: 25, toMin: 33 }, poolSize });
    results.push(r.result);
    entries.push(...r.entries);
    const x = r.result;
    console.log(
      `[world] seed ${seed} boss ${bossEvent ?? "-"}: ${x.entries} entries (${x.users} users, map full ${x.worldFull}, max ${x.maxHumans} on map), exits ${JSON.stringify(x.exits)}, ` +
        `pool ${x.pool.released} → ${JSON.stringify(x.pool.fate)}, boss ${x.boss.killedBy || "alive"} @${x.boss.killedAtMin}m resets ${x.boss.resets} bag ${x.boss.bagFilled}, ` +
        `respawn ${x.respawn.squads}/${x.respawn.killedByHumans}, expired ${x.expiry.treasury}/${x.expiry.toPool} — ${round2(x.wallMs / 1000)} s`,
    );
  }
  const s = summarizeWorld(results, entries);
  const note =
    `WORLD v6 harness (spec §8.4): ${cycles} shard-cycles on the real sim (Match world mode, 45 min, wipe), ${users} users per cycle ` +
    `(35 % arriving in minutes 0–5, re-entry 40 % after death / 20 % after extract), probes ${probeStrats.join("+")} ${probeKit} at ${enterAt.join("/")} min, kits ${kitMix ? kitMix.map((k) => `${k.key}:${k.w}`).join(",") : "starter:3,free:1,hunter:1"}, ` +
    `${taggers} free-kit taggers in minutes 25–33, boss events ${bossList.slice(0, cycles).join(", ")} (forced: one per cycle), pool ${poolSize ?? 700}. ` +
    `CR at autosell 1; free-kit junk × 0.5; tags under D22. XP per entry without daily state (no cap, no first-extract bonus).` +
    (stale.length ? ` WARNING: shared sources newer than the dist: ${stale.slice(0, 3).join(", ")}.` : "");
  mkdirSync(out, { recursive: true });
  const base = join(out, `yield-world${tag ? "-" + tag : ""}`);
  writeFileSync(`${base}.json`, JSON.stringify({ v: 6, mode: "world", summary: s, shards: results, note, entries }, null, 1));
  writeFileSync(`${base}.md`, worldMarkdown(s, results, note));
  console.log(`wrote ${base}.json / .md`);
  console.log(worldMarkdown(s, results, note).split("\n## Shards")[0]);
}
