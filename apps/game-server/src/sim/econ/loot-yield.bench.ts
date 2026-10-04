/**
 * Loot-yield harness (economy, NPC MODEL v5): what scripted humans take out of a LIVE-economy
 * Steppe raid, by play style, with the real sim core. There are no player-bots: a raid holds only
 * the scripted humans (human.ts; 1 by default = a PvE measurement, 2–24 = a multi-human lobby with
 * PvP) and the NPCs the match spawns itself (boss groups from rollBossSpawns, marauder squads from
 * rollNpcSpawns over map.npcPosts — the server NPC system). Per raid: a fresh lost pool sampled
 * like the seeded DB pool (pool-mirror.ts seedPool) and the legacy per-match release rule mirrored
 * in-process (poolReleasePlanV4 + boss slots + T3/T4 containers + v5 marauder carriers → containerLoot;
 * the pre-v6 raids/start wiring — WORLD v6 releases per entry, see world-harness.ts).
 *
 *   T=apps/game-server/node_modules/.bin/tsx; B=apps/game-server/src/sim/econ/loot-yield.bench.ts
 *   $T $B --strategy rat|poi|full|boss|fighter|npcfarm [--seeds 40] [--seed0 1] [--kit starter|free|hunter]
 *        [--stance avoid|defend|hunt] [--leave-min M] [--lobby-r R] [--wiring v5|v4|prod]
 *        [--boss-target nearest|foreman|commander|warden] [--max-tier T] [--min-tier T]
 *        [--pool 700] [--spawn game|random] [--tag T] [--out DIR]
 *        [--boss-ai '{"BOSS_SLOPPINESS":1}'] [--boss-hold-pool-weapon] [--set '{"BOSSES.foreman.hp":200}']
 *   # multi-human lobby (PvP): N scripted humans drawn from a strategy / kit mix
 *   $T $B --humans 6 [--mix rat:2,poi:3,boss:1,full:1,fighter:1] [--kit-mix starter:3,free:1,hunter:1]
 *        [--hunt-share 0.25] [--seeds 20] [--tag lobby6]
 *
 * Examples (the v5 target table): rat `--strategy rat`; npc farm `--strategy npcfarm --kit free`;
 * T2 looter `--strategy poi --max-tier 2`; T3/T4 looter `--strategy poi --min-tier 3`;
 * boss hunter `--strategy boss --boss-target foreman [--kit hunter]`; full raid `--strategy full`;
 * pool at a full lobby `--lobby-r 24`.
 *
 * --lobby-r: the lobby's riskUnits for the pool release (default: Σ the scripted humans' own kits —
 *   3 for a starter / hunter kit, 0 for the free kit); lobby members that are not scripted are not
 *   simulated, only their risk drives poolReleasePlanV4.
 * --wiring v5 (default): the legacy raids/start request carries bosses[] (raidBossSlots), containers[].guarded and
 *   carriers[] (raidNpcCarriers over rollNpcSpawns); "v4": no carriers; "prod": the pre-v5
 *   planLaunch request (bossSlots 0, no bosses[] / guarded / carriers).
 * --stance (single human) / --hunt-share (lobby: the chance a non-rat, non-full human hunts other
 *   humans; the rest keep their strategy's default stance, human.ts DEFAULT_STANCE).
 *
 * Writes DIR/yield-<strategy|lobby>[-tag].json ({ summary, byStrategy, lobbies?, note, records }:
 * one record per scripted human per raid — the population sim scripts/econ/econ-sim.mjs reads
 * these) and a .md with mean / median / p90 per metric. The raid ends when every scripted human
 * left (v5: NPCs never keep a match alive), so a solo raid stops at the human's exit.
 * The game server resolves @extract/shared from packages/shared/dist: after changing shared tuning
 * (CONTAINER, POOL, NPC_*, map) run `pnpm --filter @extract/shared build` first — the CLI warns
 * when a shared source file is newer than the build.
 *
 * Scripted humans are attached as connected clients (Match.attachHuman), so they get their
 * per-listener sounds; the "hunt" stance uses them to walk toward gunfire. NPC accuracy / reaction
 * on its own: npc-threat.bench.ts.
 *
 * WORLD v6 world mode (spec §8.4): `--world` runs up to 4 shard-cycles of the persistent world (45-minute
 * map, drop-in entries, server pool placement, event boss, respawns, A6 expiry, the wipe) with scripted
 * humans arriving over the cycle — see world-harness.ts for the flags and the records it writes
 * (DIR/yield-world[-tag].json / .md).
 *
 * Kits: "starter" = a giveaway kit (rifle r0 + armor_1 + backpack_1, 90 light rounds, 3 bandages,
 * 1 medkit; 3 risk units); "hunter" = rifle r1 + armor_2 + backpack_2, 180 light rounds, 3
 * bandages, 2 medkits (3 risk units); "free" = nothing (the server's FREE kit only, 0 risk units).
 */

import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  BOSSES,
  BOSS_AI,
  ITEM_FLAG,
  NPC_ROLE,
  SERVER_TICK_MS,
  ammoDefOf,
  storageKeys,
  type BossKind,
  containerGuarded,
  itemDef,
  npcPostsOf,
  raidBossSlots,
  raidNpcCarriers,
  rollBossSpawns,
  rollNpcSpawns,
  bossGroupNpcCount,
  uniqueTierScore,
  extractMask,
  junkSellCr,
  mulberry32,
  type LoadoutSnapshot,
  type MapData,
  type PlayerExitReport,
  type SettledItem,
  type SlotKey,
} from "@extract/shared";
import * as SHARED from "@extract/shared";
import { fixActive, placeItem, syncPublic } from "../bag.js";
import { cloneItem, makeItem, toPlain } from "../items.js";
import { Match, matchMap } from "../match.js";
import type { PlayerRuntime, RosterEntry } from "../types.js";
import {
  DEFAULT_STANCE,
  HumanAgent,
  PVP_STANCES,
  STRATEGIES,
  consumableUnitCr,
  type BossTarget,
  type PvpStance,
  type Strategy,
} from "./human.js";
import { worldCli } from "./world-harness.js";
import {
  fromRaidDur,
  mirrorAllocatePool,
  npcPriceMinor,
  refValueCr,
  seedPool,
  toRaidDur,
  topTierCount,
  type UniqueOrigin,
} from "./pool-mirror.js";

export type Kit = "starter" | "free" | "hunter";
export const KITS: readonly Kit[] = ["starter", "free", "hunter"];
export type Wiring = "v5" | "v4" | "prod";

/** One scripted human of a raid. */
export interface HumanSpec {
  strategy: Strategy;
  kit?: Kit;
  /** PvP stance (default human.ts DEFAULT_STANCE[strategy]). */
  stance?: PvpStance;
  /** Override the strategy's leave clock (minutes). */
  leaveMin?: number;
  /** boss strategy target. */
  bossTarget?: BossTarget;
  /** poi / fighter: only POIs of at most / at least this tier. */
  maxTier?: number;
  minTier?: number;
}

/** Raid-level options shared by the single-human and the lobby runner. */
export interface RaidOptions {
  seed: number;
  /** Lobby riskUnits for the pool release (default: Σ the scripted humans' own kits). */
  lobbyR?: number;
  /** "v5" (default): bosses[] + guarded + carriers; "v4": no carriers; "prod": pre-v5 planLaunch (bossSlots 0). */
  wiring?: Wiring;
  /**
   * Tuning experiment (process-wide, harness only): BOSS_AI fields to override, e.g.
   * { BOSS_SLOPPINESS: 1.0, REACT_MS: [450, 800] }. Applied before the match is built.
   */
  bossAi?: Record<string, unknown>;
  /**
   * Tuning experiment (process-wide, harness only): shared tuning overrides by dotted path into the
   * @extract/shared exports, e.g. { "BOSSES.foreman.hp": 200, "CONTAINER.FILL_CHANCE": [0.25, 0.45, 0.3, 0.85, 0.9] }.
   * Applied before the map / match are built (same process-wide caveat as bossAi).
   */
  set?: Record<string, unknown>;
  /** Tuning experiment: bosses wield their FREE BOSSES[kind].weapon and keep pool weapons in the bag. */
  bossHoldPoolWeapon?: boolean;
  poolSize?: number;
  /**
   * "game" (default): the match's own humans-only spawn rule (farthest-point sampling over the side
   * spawns). "random": every scripted human on an independent random side spawn.
   */
  spawn?: "game" | "random";
}

/** Single scripted human (a PvE measurement: the raid holds that human and the NPCs). */
export interface YieldOptions extends RaidOptions, HumanSpec {
  /** Debug hook, called after every server step. */
  trace?: (m: Match, human: HumanAgent, rt: PlayerRuntime) => void;
}

/** Multi-human lobby (PvP): every scripted human plays its own spec in the same raid. */
export interface LobbyOptions extends RaidOptions {
  humans: readonly HumanSpec[];
  /** Debug hook, called after every server step. */
  trace?: (m: Match, humans: readonly HumanAgent[]) => void;
}

export interface UniqueOut {
  uid: string;
  def: string;
  rarity: number;
  durPct: number;
  origin: UniqueOrigin;
  /** value.ts itemRefValueCr (scrap CR × dur). */
  refCr: number;
  /** Market reference (NPC price, minor units = SOL cents placeholder). */
  minor: number;
  /** uniqueTierScore: 2 top, 1 rare, 0 common. */
  tier: number;
}

export interface BossFate {
  kind: string;
  /** Who killed it: human (a scripted human) | env | alive (survived the raid). */
  fate: string;
  atMin: number;
  /** Pool items it carried at spawn. */
  poolItems: number;
}

export interface Consumables {
  ammoRounds: number;
  ammo_light: number;
  ammo_shell: number;
  ammo_heavy: number;
  bandage: number;
  medkit: number;
  /** At CONSUMABLES_CR unit prices. */
  cr: number;
}

export interface Haul {
  junkCr: number;
  junkItems: number;
  consumables: Consumables;
  uniques: UniqueOut[];
}

export interface NpcCountsRec {
  boss: number;
  guard: number;
  marauder: number;
}

export interface RaidRecord {
  strategy: Strategy;
  stance: PvpStance;
  seed: number;
  matchSeed: number;
  kit: Kit;
  /** The raid's lobby: scripted humans in it, this human's index, everyone's strategy:kit. */
  lobby: { humans: number; idx: number; members: string[] };
  spawn: { x: number; y: number; side: number };
  survived: boolean;
  /** Who killed the human: boss | guard | marauder | human | env ("" = not killed). */
  killedBy: string;
  exit: string;
  minutes: number;
  leftAtMin: number;
  leaveReason: string;
  extractId: string;
  /** Distinct runtimes seen / seen by (humans and NPCs). */
  contacts: number;
  seenBy: number;
  firstContactMin: number;
  hitsTaken: number;
  shotsFired: number;
  /** Server RaidStats: rounds fired and damage dealt (accuracy calibration). */
  dealt: { rounds: number; dmg: number };
  /** Every kill (humans + NPCs). */
  kills: number;
  /** Kills by victim role, and the server RaidStats (npcKills = marauders + guards). */
  killsBy: { human: number; boss: number; guard: number; marauder: number };
  /** What the human brought out (gross). */
  haul: Haul;
  /** Consumables extracted minus non-FREE consumables brought in (negative = used up). */
  consumablesNet: Consumables;
  /** Uniques gained (extracted, not the human's own). */
  gained: UniqueOut[];
  /** Own loadout uniques lost (death / timeout) → back to the pool, or extracted by another human. */
  ownLost: UniqueOut[];
  riskUnits: number;
  /** Junk CR + net consumables CR. */
  crTotal: number;
  containers: { total: number; byTier: Record<string, number>; byZone: Record<string, number> };
  corpsesSearched: number;
  /** CR-equivalent value taken into the bag, by source (before drops / death). */
  taken: Record<string, number>;
  /** PvP (multi-human raids; all 0 in a solo raid). */
  pvp: {
    /** Other humans this one saw. */
    humansSeen: number;
    kills: number;
    /** Killed by another scripted human. */
    died: boolean;
    /** Uniques extracted that were another human's loadout (items changing hands). */
    lootedUniques: number;
    /** Own uniques another human extracted. */
    ownTaken: number;
  };
  pool: {
    released: number;
    risk: number;
    boss: number;
    container: number;
    guarded: number;
    /** v5: released items stowed on spawned T3/T4 marauders, and carriers offered. */
    carrier: number;
    carriersOffered: number;
    /** Pool items (boss / container / carrier) nobody took out → back to the pool, no wear. */
    leftOnMap: number;
    /** Pool items a scripted human of the lobby broke at death or wore down (armor): released = extractedByLobby + leftOnMap + lostByHumans. */
    lostByHumans: number;
    /** Pool items this human extracted (gained with a pool origin). */
    extractedByHuman: number;
    /** Pool items every scripted human of the lobby extracted. */
    extractedByLobby: number;
    /** Pool size / top-tier items before the release. */
    sizeBefore: number;
    topBefore: number;
    /** Lobby riskUnits used. */
    lobbyR: number;
  };
  /** Consumables found (gained into the bag) and used (shot / healed), CR-eq, non-FREE only. */
  cons: { foundCr: number; usedCr: number; rounds: number; meds: number };
  bosses: BossFate[];
  /** NPCs spawned in the raid (bosses, guards, marauders) and how many any scripted human killed. */
  npc: { spawned: NpcCountsRec; killedByHumans: NpcCountsRec };
  /** NPC runtimes in the raid. */
  npcs: number;
  humanBossKills: number;
  hunt: { kind: string; reachedMin: number; endMin: number; end: string };
  /** npcfarm: low-tier camps reached / swept clear. */
  camps: { visited: number; cleared: number };
  wallMs: number;
}

/** One multi-human raid (lobby view). */
export interface LobbyRecord {
  seed: number;
  matchSeed: number;
  humans: number;
  members: string[];
  lobbyR: number;
  minutes: number;
  extracted: number;
  deaths: { human: number; npc: number; env: number };
  timeouts: number;
  pvpKills: number;
  /** Uniques that left the raid in another human's bag than their owner's loadout. */
  uniquesChangedHands: number;
  pool: { released: number; boss: number; container: number; carrier: number; leftOnMap: number; extracted: number; lostByHumans: number };
  npc: { spawned: NpcCountsRec; killedByHumans: NpcCountsRec };
}

export const ZERO_CONS = (): Consumables => ({ ammoRounds: 0, ammo_light: 0, ammo_shell: 0, ammo_heavy: 0, bandage: 0, medkit: 0, cr: 0 });

export function addConsumable(c: Consumables, def: string, qty: number): void {
  if (def === "ammo_light" || def === "ammo_shell" || def === "ammo_heavy") {
    c[def] += qty;
    c.ammoRounds += qty;
  } else if (def === "bandage" || def === "medkit") {
    c[def] += qty;
  } else {
    return;
  }
  c.cr += consumableUnitCr(def) * qty;
}

export function uniqueOut(s: SettledItem, origin: UniqueOrigin): UniqueOut {
  const durPct = fromRaidDur(s.def, s.dur);
  const v = { def: s.def, rarity: s.rarity, dur: durPct };
  return {
    uid: s.uid, def: s.def, rarity: s.rarity, durPct: Math.round(durPct), origin,
    refCr: Math.round(refValueCr(v)), minor: npcPriceMinor(v), tier: uniqueTierScore(s.def, s.rarity),
  };
}

export function haulOf(items: readonly SettledItem[], originOf: (uid: string) => UniqueOrigin): Haul {
  const consumables = ZERO_CONS();
  const uniques: UniqueOut[] = [];
  let junkItems = 0;
  for (const it of items) {
    const d = itemDef(it.def);
    if (!d) continue;
    if (d.unique) uniques.push(uniqueOut(it, originOf(it.uid)));
    else if (d.cat === "junk") junkItems += it.qty;
    else addConsumable(consumables, it.def, it.qty);
  }
  return { junkCr: junkSellCr(items, 1).total, junkItems, consumables, uniques };
}

/** Applies YieldOptions.set: dotted paths into the shared exports (nested objects are mutable). */
export function applySharedOverrides(set: Record<string, unknown>): void {
  for (const [path, value] of Object.entries(set)) {
    const parts = path.split(".");
    if (parts.length < 2) throw new Error(`--set path needs at least 2 segments: ${path}`);
    let o = (SHARED as unknown as Record<string, unknown>)[parts[0]!] as Record<string, unknown> | undefined;
    for (const k of parts.slice(1, -1)) o = o?.[k] as Record<string, unknown> | undefined;
    if (!o || typeof o !== "object") throw new Error(`--set path not found: ${path}`);
    o[parts.at(-1)!] = value;
  }
}

/** A giveaway kit like the owner's test account (3 risk units), or the hunter kit. */
export function starterLoadout(userId: string, kit: Kit = "starter"): LoadoutSnapshot {
  const e = (key: SlotKey, def: string, qty: number, uid = "", rarity = 0, durPct = 100) =>
    ({ key, uid, def, qty, rarity, dur: toRaidDur(def, durPct) });
  if (kit === "hunter") {
    // A boss hunter's bought kit: rifle r1 + armor_2 + backpack_2, 180 light rounds, 3 bandages, 2 medkits.
    return {
      loadoutId: "bench-loadout",
      userId,
      level: 5,
      entries: [
        e("w1", "rifle", 1, "own-rifle", 1, 92),
        e("armor", "armor_2", 1, "own-armor", 0, 95),
        e("bp", "backpack_2", 1, "own-bp", 0, 96),
        e("p0", "ammo_light", 60),
        e("p1", "ammo_light", 60),
        e("p2", "bandage", 3),
        e("p3", "medkit", 2),
        e("b0", "ammo_light", 60),
      ],
    };
  }
  return {
    loadoutId: "bench-loadout",
    userId,
    level: 3,
    entries: [
      e("w1", "rifle", 1, "own-rifle", 0, 92),
      e("armor", "armor_1", 1, "own-armor", 0, 95),
      e("bp", "backpack_1", 1, "own-bp", 0, 96),
      e("p0", "ammo_light", 60),
      e("p1", "ammo_light", 30),
      e("p2", "bandage", 3),
      e("p3", "medkit", 1),
    ],
  };
}

/** Single scripted human: a PvE measurement (the raid holds that human and the NPCs). */
export function runYieldRaid(o: YieldOptions): RaidRecord {
  const { trace, strategy, kit, stance, leaveMin, bossTarget, maxTier, minTier, ...raid } = o;
  return runLobbyRaid({
    ...raid,
    humans: [{ strategy, kit, stance, leaveMin, bossTarget, maxTier, minTier }],
    trace: trace ? (m, hs) => trace(m, hs[0]!, hs[0]!.rt) : undefined,
  }).records[0]!;
}

const ZERO_NPC = (): NpcCountsRec => ({ boss: 0, guard: 0, marauder: 0 });

/** Killer / victim role name: "human" for scripted humans, else the NPC role. */
export function roleName(rt: PlayerRuntime | undefined): "human" | "boss" | "guard" | "marauder" | "env" {
  if (!rt) return "env";
  switch (rt.pub.role) {
    case NPC_ROLE.BOSS: return "boss";
    case NPC_ROLE.GUARD: return "guard";
    case NPC_ROLE.MARAUDER: return "marauder";
    default: return "human";
  }
}

/**
 * One raid with every scripted human of `o.humans` (1 = PvE, more = a lobby with PvP) and the NPCs
 * the match spawns itself. Returns one RaidRecord per human and the lobby view.
 */
export function runLobbyRaid(o: LobbyOptions): { records: RaidRecord[]; lobby: LobbyRecord } {
  const t0 = performance.now();
  if (o.humans.length < 1) throw new Error("runLobbyRaid: at least one human");
  const wiring = o.wiring ?? "v5";
  const rng = mulberry32((o.seed * 0x9e3779b1) >>> 0);
  const matchSeed = Math.floor(rng() * 2 ** 32) >>> 0;
  const specs = o.humans.map((h) => ({ ...h, kit: h.kit ?? "starter" }));
  const members = specs.map((h) => `${h.strategy}:${h.kit}`);
  // Loadouts: own uids per human ("h<i>:own-rifle" …) so items changing hands are traceable.
  const loadouts = specs.map((h, i) => (h.kit !== "free" ? withUidPrefix(starterLoadout(`bench-human-${i}`, h.kit), `h${i}:`) : null));
  const ownUids = loadouts.map((lo) => new Set(lo?.entries.filter((e) => e.uid).map((e) => e.uid) ?? []));
  const ownerOf = new Map<string, number>();
  ownUids.forEach((s, i) => s.forEach((u) => ownerOf.set(u, i)));
  const riskOf = ownUids.map((s) => s.size);
  const lobbyR = o.lobbyR ?? riskOf.reduce((a, b) => a + b, 0);

  // Legacy raids/start (pre-v6): a fresh seeded-like pool, the per-match release rule mirrored in-process.
  const pool = seedPool(o.poolSize ?? 700, mulberry32((o.seed ^ 0x5eed9001) >>> 0));
  const sizeBefore = pool.length;
  const topBefore = topTierCount(pool);
  let uidSeq = 0;
  const newUid = () => `u${o.seed}-${uidSeq++}`;
  if (o.bossAi) Object.assign(BOSS_AI as unknown as Record<string, unknown>, o.bossAi);
  if (o.set) applySharedOverrides(o.set);
  const map: MapData = matchMap(matchSeed, "steppe");
  // The match rolls its NPCs from the match seed alone; the legacy room made the same rolls for raids/start.
  const spawned = rollBossSpawns(matchSeed, map.bosses);
  const posts = npcPostsOf(map);
  const squads = rollNpcSpawns(matchSeed, posts, bossGroupNpcCount(spawned));
  const containers = map.containers.map((c, idx) => ({
    idx, kind: c.kind, tier: c.tier, guarded: wiring !== "prod" && containerGuarded(c, map.bosses),
  }));
  const alloc = mirrorAllocatePool(
    pool,
    {
      matchSeed,
      containers,
      bosses: wiring !== "prod" ? raidBossSlots(spawned) : [],
      riskUnits: lobbyR,
      carriers: wiring === "v5" ? raidNpcCarriers(squads, posts) : [],
    },
    mulberry32((o.seed ^ 0xa110c) >>> 0),
  );

  const roster: RosterEntry[] = specs.map((_, i) => ({
    userId: `bench-human-${i}`, nickname: `Bench${i}`, loadoutId: loadouts[i]?.loadoutId,
  }));
  const m = new Match({
    roster,
    rng: mulberry32((matchSeed ^ 0x2026) >>> 0),
    mapSeed: matchSeed,
    mapId: "steppe",
    mode: "live",
    loadouts: loadouts.filter((l): l is LoadoutSnapshot => l !== null),
    containerLoot: alloc.containerLoot,
    newUid,
    now: () => 1_700_000_000_000,
  });
  if (o.bossHoldPoolWeapon) for (const g of m.npcs.groups) holdPoolWeapon(g.boss, g.kind);
  // Every scripted human is a connected client (it gets its per-listener sounds like one).
  for (let i = 0; i < specs.length; i++) m.attachHuman(`bench-human-${i}`, `bench-sess-${i}`);
  const rts = m.allRuntimes().filter((r) => !r.isNpc);
  if (rts.length !== specs.length) throw new Error(`roster: ${rts.length} human runtimes for ${specs.length} specs`);
  if (o.spawn === "random") {
    const srng = mulberry32((o.seed ^ 0x59a7) >>> 0);
    for (const rt of rts) {
      const sp = m.map.spawns[Math.floor(srng() * m.map.spawns.length)]!;
      rt.pub.x = rt.prevX = sp.x;
      rt.pub.y = rt.prevY = sp.y;
      rt.self.side = sp.side;
      rt.self.extractMask = extractMask(m.map, sp.side);
    }
  }
  const spawns = rts.map((rt) => ({ x: Math.round(rt.pub.x), y: Math.round(rt.pub.y), side: rt.self.side }));
  const humans = specs.map((h, i) => new HumanAgent(m, rts[i]!, {
    strategy: h.strategy,
    // Human 0 keeps the pre-v5 single-human stream, so a solo seed reproduces the same choices.
    rng: mulberry32((o.seed ^ 0x4a3a ^ Math.imul(i, 0x2c1b3c6d)) >>> 0),
    leaveAtMs: h.leaveMin !== undefined ? h.leaveMin * 60_000 : undefined,
    bossTarget: h.bossTarget,
    maxTier: h.maxTier,
    minTier: h.minTier,
    stance: h.stance,
  }));
  const humanIdx = new Map(rts.map((rt, i) => [rt, i]));
  const humanByRoster = new Map(rts.map((rt, i) => [rt.rosterIndex, humans[i]!]));

  const byId = new Map(m.allRuntimes().map((r) => [r.id, r]));
  const find = (id: string) => (id ? (byId.get(id) ?? m.allRuntimes().find((r) => r.id === id)) : undefined);
  const bossFate = new Map<PlayerRuntime, BossFate>();
  for (const g of m.npcs.groups) {
    const n = alloc.containerLoot[`boss:${g.kind}`]?.length ?? 0;
    bossFate.set(g.boss, { kind: g.kind, fate: "alive", atMin: -1, poolItems: n });
  }
  const killedBy = specs.map(() => "");
  const killsBy = specs.map(() => ({ human: 0, boss: 0, guard: 0, marauder: 0 }));
  const npcKilled = ZERO_NPC();
  while (!m.ended) {
    for (const h of humans) h.update(SERVER_TICK_MS);
    m.step(SERVER_TICK_MS);
    o.trace?.(m, humans);
    for (const ev of m.drainEvents()) {
      if (ev.type === "snd") {
        humanByRoster.get(ev.to)?.hear(ev.msg);
        continue;
      }
      if (ev.type !== "kill") continue;
      const v = find(ev.msg.victimId);
      const k = find(ev.msg.killerId);
      const ki = k ? humanIdx.get(k) : undefined;
      const vRole = roleName(v);
      if (ki !== undefined && vRole !== "env") {
        killsBy[ki]![vRole]++;
        if (vRole !== "human") npcKilled[vRole]++;
      }
      const vi = v ? humanIdx.get(v) : undefined;
      if (vi !== undefined) killedBy[vi] = roleName(k);
      const f = v ? bossFate.get(v) : undefined;
      if (f) {
        f.fate = ki !== undefined ? "human" : roleName(k);
        f.atMin = round2(m.clock / 60_000);
      }
    }
  }

  const reps = rts.map((rt) => rt.exitReport as PlayerExitReport);
  const originFor = (i: number) => (uid: string): UniqueOrigin => {
    const owner = ownerOf.get(uid);
    if (owner !== undefined) return owner === i ? "own" : "looted";
    return alloc.origin.get(uid) ?? "other";
  };
  const hauls = reps.map((rep, i) => haulOf(rep.extracted, originFor(i)));
  const pooled = (u: UniqueOut) => u.origin === "pool" || u.origin === "boss" || u.origin === "carrier" || u.origin === "floor";
  const extractedByLobby = hauls.reduce((n, h) => n + h.uniques.filter(pooled).length, 0);
  const extractedBy = new Map<string, number>();
  hauls.forEach((h, i) => h.uniques.forEach((u) => extractedBy.set(u.uid, i)));
  const leftOnMap = (m.report?.leftOnMap ?? []).filter((s) => alloc.origin.has(s.uid)).length;
  // Pool items a human ended: broken at its death (BREAK_CHANCE_ON_DEATH) or worn armor destroyed (v4 wear).
  const lostByHumans = reps.reduce((n, rep) => n + [...rep.lost, ...(rep.destroyed ?? [])].filter((s) => alloc.origin.has(s.uid)).length, 0);
  const summary = m.npcs.summary();
  const spawnedNpc: NpcCountsRec = { ...summary.spawned };
  const minutes = round2(m.clock / 60_000);

  const records: RaidRecord[] = rts.map((rt, i) => {
    const h = humans[i]!;
    const rep = reps[i]!;
    const haul = hauls[i]!;
    const lo = loadouts[i];
    const brought = ZERO_CONS();
    for (const e of lo?.entries ?? []) if (!e.uid) addConsumable(brought, e.def, e.qty);
    const net = ZERO_CONS();
    for (const k of Object.keys(net) as Array<keyof Consumables>) net[k] = haul.consumables[k] - brought[k];
    const gained = haul.uniques.filter((u) => u.origin !== "own");
    const ownLost = rep.lost.filter((s) => ownUids[i]!.has(s.uid)).map((s) => uniqueOut(s, "own"));
    const ownTaken = [...ownUids[i]!].filter((u) => { const x = extractedBy.get(u); return x !== undefined && x !== i; }).length;
    const byTier: Record<string, number> = {};
    const byZone: Record<string, number> = {};
    for (const s of h.log.searched) {
      byTier[`T${s.tier}`] = (byTier[`T${s.tier}`] ?? 0) + 1;
      byZone[s.zone] = (byZone[s.zone] ?? 0) + 1;
    }
    return {
      strategy: h.strategy,
      stance: h.stance,
      seed: o.seed,
      matchSeed,
      kit: specs[i]!.kit,
      lobby: { humans: specs.length, idx: i, members },
      spawn: spawns[i]!,
      survived: rep.exit === "extract",
      killedBy: rep.exit === "dead" ? killedBy[i] || "env" : "",
      exit: rep.exit,
      minutes: round2(rep.atMs / 60_000),
      leftAtMin: h.log.leftAt >= 0 ? round2(h.log.leftAt / 60_000) : -1,
      leaveReason: h.log.leaveReason,
      extractId: h.log.extractId,
      contacts: h.log.contacts.size,
      seenBy: h.log.seenBy.size,
      firstContactMin: h.log.firstContactAt >= 0 ? round2(h.log.firstContactAt / 60_000) : -1,
      hitsTaken: h.log.hitsTaken,
      shotsFired: h.log.shotsFired,
      dealt: { rounds: rt.stats.shotsFired, dmg: Math.round(rt.stats.dmgDealt) },
      kills: rt.self.kills,
      killsBy: killsBy[i]!,
      haul,
      consumablesNet: net,
      gained,
      ownLost,
      riskUnits: riskOf[i]!,
      crTotal: Math.round(haul.junkCr + net.cr),
      containers: { total: h.log.searched.length, byTier, byZone },
      corpsesSearched: h.log.corpsesSearched,
      taken: Object.fromEntries(Object.entries(h.log.taken).map(([s, v]) => [s, Math.round(v)])),
      pvp: {
        humansSeen: h.log.humanContacts.size,
        kills: killsBy[i]!.human,
        died: killedBy[i] === "human",
        lootedUniques: gained.filter((u) => u.origin === "looted").length,
        ownTaken,
      },
      pool: {
        released: alloc.released,
        risk: alloc.risk,
        boss: alloc.boss,
        container: alloc.container,
        guarded: alloc.guarded,
        carrier: alloc.carrier,
        carriersOffered: alloc.carriersOffered,
        leftOnMap,
        lostByHumans,
        extractedByHuman: gained.filter(pooled).length,
        extractedByLobby,
        sizeBefore,
        topBefore,
        lobbyR,
      },
      cons: {
        foundCr: Math.round(h.log.consFoundCr),
        usedCr: Math.round(h.log.consUsedCr),
        rounds: h.log.roundsUsed,
        meds: h.log.medsUsed,
      },
      bosses: [...bossFate.values()].map((b) => ({ ...b })),
      npc: { spawned: spawnedNpc, killedByHumans: { ...npcKilled } },
      npcs: m.npcs.runtimes().length,
      humanBossKills: rt.stats.bossKills,
      hunt: {
        kind: h.log.boss.kind,
        reachedMin: h.log.boss.reachedAt >= 0 ? round2(h.log.boss.reachedAt / 60_000) : -1,
        endMin: h.log.boss.huntEndAt >= 0 ? round2(h.log.boss.huntEndAt / 60_000) : -1,
        end: h.log.boss.huntEnd,
      },
      camps: { ...h.log.camps },
      wallMs: 0,
    };
  });
  const wallMs = Math.round(performance.now() - t0);
  for (const r of records) r.wallMs = wallMs;
  const lobby: LobbyRecord = {
    seed: o.seed,
    matchSeed,
    humans: specs.length,
    members,
    lobbyR,
    minutes,
    extracted: records.filter((r) => r.survived).length,
    deaths: {
      human: records.filter((r) => r.killedBy === "human").length,
      npc: records.filter((r) => r.killedBy === "boss" || r.killedBy === "guard" || r.killedBy === "marauder").length,
      env: records.filter((r) => r.killedBy === "env").length,
    },
    timeouts: records.filter((r) => r.exit === "timeout").length,
    pvpKills: records.reduce((n, r) => n + r.pvp.kills, 0),
    uniquesChangedHands: records.reduce((n, r) => n + r.pvp.lootedUniques, 0),
    pool: { released: alloc.released, boss: alloc.boss, container: alloc.container, carrier: alloc.carrier, leftOnMap, extracted: extractedByLobby, lostByHumans },
    npc: { spawned: spawnedNpc, killedByHumans: { ...npcKilled } },
  };
  return { records, lobby };
}

/** Prefix every own uid of a loadout (several scripted humans in one raid). */
export function withUidPrefix(lo: LoadoutSnapshot, prefix: string): LoadoutSnapshot {
  return { ...lo, loadoutId: `${prefix}${lo.loadoutId}`, entries: lo.entries.map((e) => (e.uid ? { ...e, uid: `${prefix}${e.uid}` } : e)) };
}

/** Experiment: the boss's pool weapon goes into its bag (still drops), it wields its FREE default. */
function holdPoolWeapon(rt: PlayerRuntime, kind: BossKind): void {
  const s = rt.self.slots;
  const w = s.get("w1");
  if (!w || w.flags & ITEM_FLAG.FREE) return;
  const key = storageKeys(s).find((k) => !s.get(k));
  if (!key) return;
  s.set(key, cloneItem(toPlain(w)));
  const def = BOSSES[kind];
  s.set("w1", cloneItem(makeItem(def.weapon, { rarity: def.weaponRarity, flags: ITEM_FLAG.FREE })));
  placeItem(rt, makeItem(ammoDefOf(def.weapon), { qty: 90, flags: ITEM_FLAG.FREE }));
  rt.self.active = "w1";
  fixActive(rt);
  syncPublic(rt);
}

// ---------------------------------------------------------------- summary

export function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export interface Stat {
  mean: number;
  median: number;
  p90: number;
  min: number;
  max: number;
}

export function stat(values: readonly number[]): Stat {
  if (values.length === 0) return { mean: 0, median: 0, p90: 0, min: 0, max: 0 };
  const s = [...values].sort((a, b) => a - b);
  const q = (f: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(f * s.length) - 1))]!;
  return {
    mean: round2(s.reduce((a, b) => a + b, 0) / s.length),
    median: round2(s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2),
    p90: round2(q(0.9)),
    min: round2(s[0]!),
    max: round2(s[s.length - 1]!),
  };
}

/** Metric name → extractor, in report order. */
export const METRICS: ReadonlyArray<[string, (r: RaidRecord) => number]> = [
  ["survived (0/1)", (r) => (r.survived ? 1 : 0)],
  ["raid minutes", (r) => r.minutes],
  ["humans in the raid", (r) => r.lobby.humans],
  ["contacts (humans + NPCs seen)", (r) => r.contacts],
  ["seen by (humans + NPCs)", (r) => r.seenBy],
  ["hits taken", (r) => r.hitsTaken],
  ["rounds fired", (r) => r.dealt.rounds],
  ["damage dealt per round fired", (r) => (r.dealt.rounds ? r.dealt.dmg / r.dealt.rounds : 0)],
  ["kills (all)", (r) => r.kills],
  ["NPC kills (marauders)", (r) => r.killsBy.marauder],
  ["guard kills", (r) => r.killsBy.guard],
  ["killed by an NPC (0/1)", (r) => (r.killedBy === "boss" || r.killedBy === "guard" || r.killedBy === "marauder" ? 1 : 0)],
  ["killed by a marauder (0/1)", (r) => (r.killedBy === "marauder" ? 1 : 0)],
  ["junk CR extracted", (r) => r.haul.junkCr],
  ["junk items extracted", (r) => r.haul.junkItems],
  ["ammo rounds extracted", (r) => r.haul.consumables.ammoRounds],
  ["bandages extracted", (r) => r.haul.consumables.bandage],
  ["medkits extracted", (r) => r.haul.consumables.medkit],
  ["consumables CR extracted (gross)", (r) => r.haul.consumables.cr],
  ["consumables CR net (− kit brought)", (r) => r.consumablesNet.cr],
  ["CR total (junk + net consumables)", (r) => r.crTotal],
  ["CR per raid minute", (r) => (r.minutes > 0 ? r.crTotal / r.minutes : 0)],
  ["uniques gained", (r) => r.gained.length],
  ["uniques gained, top tier (score 2)", (r) => r.gained.filter((u) => u.tier === 2).length],
  ["uniques gained, rare (score 1)", (r) => r.gained.filter((u) => u.tier === 1).length],
  ["uniques gained from bosses", (r) => r.gained.filter((u) => u.origin === "boss").length],
  ["uniques gained from marauder carriers", (r) => r.gained.filter((u) => u.origin === "carrier").length],
  ["uniques gained, market minor", (r) => r.gained.reduce((a, u) => a + u.minor, 0)],
  ["own uniques lost", (r) => r.ownLost.length],
  ["net pool drain (pool uniques gained − own lost)", (r) => r.pool.extractedByHuman - r.ownLost.length],
  ["consumables found CR-eq (non-FREE)", (r) => r.cons.foundCr],
  ["consumables used CR-eq (non-FREE)", (r) => r.cons.usedCr],
  ["consumables found − used CR-eq", (r) => r.cons.foundCr - r.cons.usedCr],
  ["rounds used", (r) => r.cons.rounds],
  ["meds used", (r) => r.cons.meds],
  ["boss kills by the human", (r) => r.humanBossKills],
  ["containers searched", (r) => r.containers.total],
  ["containers searched in wilds (T0/T1 no zone)", (r) => r.containers.byZone["wild"] ?? 0],
  ["bodies searched", (r) => r.corpsesSearched],
  ["value taken from NPC bodies CR-eq", (r) => r.taken["npc_body"] ?? 0],
  ["PvP: humans seen", (r) => r.pvp.humansSeen],
  ["PvP: kills", (r) => r.pvp.kills],
  ["PvP: killed by a human (0/1)", (r) => (r.pvp.died ? 1 : 0)],
  ["PvP: uniques looted from humans", (r) => r.pvp.lootedUniques],
  ["PvP: own uniques taken by a human", (r) => r.pvp.ownTaken],
  ["pool released into raid", (r) => r.pool.released],
  ["pool released to bosses", (r) => r.pool.boss],
  ["pool released to containers", (r) => r.pool.container],
  ["pool released to guarded containers", (r) => r.pool.guarded],
  ["pool released to marauder carriers", (r) => r.pool.carrier],
  ["carriers offered (spawned T3/T4 marauders)", (r) => r.pool.carriersOffered],
  ["pool uniques left on map", (r) => r.pool.leftOnMap],
  ["NPCs in raid", (r) => r.npcs],
  ["marauders in raid", (r) => r.npc.spawned.marauder],
];

export interface YieldSummary {
  /** The strategy (single-strategy runs), or "lobby" / "<strategy>:<kit>" for lobby groupings. */
  strategy: string;
  raids: number;
  kit: Kit;
  metrics: Record<string, Stat>;
  survivalRate: number;
  zeroContactRate: number;
  anyUniqueRate: number;
  gainedByOrigin: Record<string, number>;
  gainedByDef: Record<string, number>;
  takenBySourceMean: Record<string, number>;
  containersByTierMean: Record<string, number>;
  leaveReasons: Record<string, number>;
  exits: Record<string, number>;
  /** Who killed the human (boss / guard / marauder / human / env), deaths only. */
  killedBy: Record<string, number>;
  /** Per boss kind: spawned raids, and fates (human / env / alive; one count per raid). */
  bossFates: Record<string, Record<string, number>>;
  /** boss strategy: hunt target kind → { raids, spawned, killedByHuman, rate | spawned }. */
  hunt: Record<string, { raids: number; spawned: number; reached: number; killedByHuman: number; rateIfSpawned: number; rateAll: number; ends: Record<string, number> }>;
}

export function summarize(records: readonly RaidRecord[], label?: string): YieldSummary {
  const n = Math.max(1, records.length);
  const metrics: Record<string, Stat> = {};
  for (const [name, f] of METRICS) metrics[name] = stat(records.map(f));
  const count = (f: (r: RaidRecord) => string[]) => {
    const out: Record<string, number> = {};
    for (const r of records) for (const k of f(r)) out[k] = (out[k] ?? 0) + 1;
    return out;
  };
  const meanOf = (f: (r: RaidRecord) => Record<string, number>) => {
    const out: Record<string, number> = {};
    for (const r of records) for (const [k, v] of Object.entries(f(r))) out[k] = (out[k] ?? 0) + v;
    for (const k of Object.keys(out)) out[k] = round2(out[k]! / n);
    return out;
  };
  return {
    strategy: label ?? records[0]?.strategy ?? "rat",
    raids: records.length,
    kit: records[0]?.kit ?? "starter",
    metrics,
    survivalRate: round2(records.filter((r) => r.survived).length / n),
    zeroContactRate: round2(records.filter((r) => r.contacts === 0 && r.seenBy === 0).length / n),
    anyUniqueRate: round2(records.filter((r) => r.gained.length > 0).length / n),
    gainedByOrigin: count((r) => r.gained.map((u) => u.origin)),
    gainedByDef: count((r) => r.gained.map((u) => `${u.def} r${u.rarity}`)),
    takenBySourceMean: meanOf((r) => r.taken),
    containersByTierMean: meanOf((r) => r.containers.byTier),
    leaveReasons: count((r) => [r.leaveReason || "-"]),
    exits: count((r) => [r.exit]),
    killedBy: count((r) => (r.killedBy ? [r.killedBy] : [])),
    bossFates: bossFates(records),
    hunt: huntStats(records),
  };
}

function bossFates(records: readonly RaidRecord[]): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  const seen = new Set<number>();
  for (const r of records) {
    // Lobby runs: every human's record carries the same bosses — one count per raid.
    if (seen.has(r.seed)) continue;
    seen.add(r.seed);
    for (const b of r.bosses) {
      const o = (out[b.kind] ??= { spawned: 0 });
      o.spawned!++;
      o[b.fate] = (o[b.fate] ?? 0) + 1;
    }
  }
  return out;
}

function huntStats(records: readonly RaidRecord[]): YieldSummary["hunt"] {
  const out: YieldSummary["hunt"] = {};
  for (const r of records) {
    if (!r.hunt.kind) continue;
    const h = (out[r.hunt.kind] ??= { raids: 0, spawned: 0, reached: 0, killedByHuman: 0, rateIfSpawned: 0, rateAll: 0, ends: {} });
    h.raids++;
    const b = r.bosses.find((x) => x.kind === r.hunt.kind);
    if (b) h.spawned++;
    if (r.hunt.reachedMin >= 0) h.reached++;
    if (b?.fate === "human") h.killedByHuman++;
    const e = r.hunt.end || "-";
    h.ends[e] = (h.ends[e] ?? 0) + 1;
  }
  for (const h of Object.values(out)) {
    h.rateIfSpawned = round2(h.spawned ? h.killedByHuman / h.spawned : 0);
    h.rateAll = round2(h.raids ? h.killedByHuman / h.raids : 0);
  }
  return out;
}

export function summaryMarkdown(s: YieldSummary, records: readonly RaidRecord[], note = ""): string {
  const L: string[] = [];
  L.push(`# Loot yield — strategy \`${s.strategy}\` (${s.raids} raids, kit ${s.kit})`, "");
  if (note) L.push(note, "");
  L.push(
    `Survival ${pct(s.survivalRate)} · raids with zero contact either way ${pct(s.zeroContactRate)} · ` +
      `raids with ≥1 unique gained ${pct(s.anyUniqueRate)}`,
    "",
    "| metric | mean | median | p90 | min | max |",
    "|---|---:|---:|---:|---:|---:|",
  );
  for (const [name, st] of Object.entries(s.metrics)) L.push(`| ${name} | ${st.mean} | ${st.median} | ${st.p90} | ${st.min} | ${st.max} |`);
  L.push("", "**Uniques gained by origin (all raids):** " + kv(s.gainedByOrigin));
  L.push("", "**Uniques gained by def:** " + kv(s.gainedByDef));
  L.push("", "**Value taken into the bag per raid, by source (CR-eq, mean):** " + kv(s.takenBySourceMean));
  L.push("", "**Containers searched per raid by tier (mean):** " + kv(s.containersByTierMean));
  L.push("", "**Leave reasons:** " + kv(s.leaveReasons) + " · **exits:** " + kv(s.exits) + " · **killed by:** " + kv(s.killedBy));
  L.push("", "**Boss fates (spawned / killed by):** " + (Object.entries(s.bossFates).map(([k, v]) => `${k}: ${kv(v)}`).join(" · ") || "-"));
  if (Object.keys(s.hunt).length) {
    L.push("", "**Boss hunt:** " + Object.entries(s.hunt).map(([k, h]) =>
      `${k}: ${h.killedByHuman}/${h.spawned} spawned killed (${pct(h.rateIfSpawned)}; ${pct(h.rateAll)} of ${h.raids} raids), reached ${h.reached}, ends ${kv(h.ends)}`).join(" · "));
  }
  L.push("", "## Raids", "", "| seed | who | exit (by) | min | contacts | NPC kills m/g/b | PvP k | junk CR | cons. net CR | found/used | CR total | uniques (origin) | containers (wild) | bosses |", "|---:|---|---|---:|---:|---|---:|---:|---:|---|---:|---|---:|---|");
  for (const r of records) {
    const u = r.gained.map((g) => `${g.def}${g.rarity ? "r" + g.rarity : ""}/${g.origin}`).join(", ") || "-";
    const b = r.bosses.map((x) => `${x.kind[0]}:${x.fate}`).join(" ") || "-";
    const who = `${r.lobby.idx}:${r.strategy}/${r.kit}`;
    L.push(`| ${r.seed} | ${who} | ${r.exit}${r.killedBy ? ` (${r.killedBy})` : ""} | ${r.minutes} | ${r.contacts} | ${r.killsBy.marauder}/${r.killsBy.guard}/${r.killsBy.boss} | ${r.pvp.kills} | ${r.haul.junkCr} | ${Math.round(r.consumablesNet.cr)} | ${r.cons.foundCr}/${r.cons.usedCr} | ${r.crTotal} | ${u} | ${r.containers.total} (${r.containers.byZone["wild"] ?? 0}) | ${b} |`);
  }
  return L.join("\n") + "\n";
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function kv(o: Record<string, number>): string {
  const e = Object.entries(o).sort((a, b) => b[1] - a[1]);
  return e.length ? e.map(([k, v]) => `${k} ${v}`).join(", ") : "-";
}

// ---------------------------------------------------------------- CLI

/** Shared sources newer than the build the game server imports (stale tuning warning). */
function staleShared(): string[] {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../packages/shared");
  let built = 0;
  try {
    built = statSync(join(root, "dist/index.js")).mtimeMs;
  } catch {
    return [];
  }
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else if (f.name.endsWith(".ts") && !f.name.endsWith(".test.ts") && statSync(p).mtimeMs > built) out.push(p);
    }
  };
  try {
    walk(join(root, "src"));
  } catch {
    return [];
  }
  return out;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** "rat:2,poi:3" → weighted entries (weights > 0). */
export function parseMix<T extends string>(spec: string, allowed: readonly T[], what: string): Array<{ key: T; w: number }> {
  const out: Array<{ key: T; w: number }> = [];
  for (const part of spec.split(",").map((x) => x.trim()).filter(Boolean)) {
    const [k, w] = part.split(":");
    if (!allowed.includes(k as T)) throw new Error(`--${what}: unknown "${k}" (one of ${allowed.join("|")})`);
    const n = w === undefined ? 1 : Number(w);
    if (!(n > 0)) continue;
    out.push({ key: k as T, w: n });
  }
  if (!out.length) throw new Error(`--${what}: empty mix`);
  return out;
}

function drawMix<T extends string>(mix: ReadonlyArray<{ key: T; w: number }>, rng: () => number): T {
  const total = mix.reduce((a, e) => a + e.w, 0);
  let roll = rng() * total;
  for (const e of mix) {
    roll -= e.w;
    if (roll <= 0) return e.key;
  }
  return mix[mix.length - 1]!.key;
}

/**
 * The scripted humans of lobby raid `seed` (deterministic in the seed): strategy and kit drawn from
 * the mixes (npcfarm always takes the free kit, boss hunters the nearest boss); a non-rat, non-full
 * human hunts other humans with chance `huntShare`, else it keeps its strategy's default stance.
 */
export function lobbyHumans(
  seed: number,
  n: number,
  mix: ReadonlyArray<{ key: Strategy; w: number }>,
  kitMix: ReadonlyArray<{ key: Kit; w: number }>,
  huntShare: number,
): HumanSpec[] {
  const rng = mulberry32((seed ^ 0x10bb7) >>> 0);
  return Array.from({ length: n }, () => {
    const strategy = drawMix(mix, rng);
    const kit = strategy === "npcfarm" ? "free" : drawMix(kitMix, rng);
    const hunts = strategy !== "rat" && strategy !== "full" && rng() < huntShare;
    return { strategy, kit, stance: hunts ? "hunt" : DEFAULT_STANCE[strategy], bossTarget: strategy === "boss" ? "nearest" : undefined };
  });
}

export function lobbyMarkdown(lobbies: readonly LobbyRecord[], note = ""): string {
  const n = Math.max(1, lobbies.length);
  const sum = (f: (l: LobbyRecord) => number) => lobbies.reduce((a, l) => a + f(l), 0);
  const humans = sum((l) => l.humans);
  const deaths = sum((l) => l.deaths.human + l.deaths.npc + l.deaths.env);
  const L: string[] = [`# Lobby raids (${lobbies.length} raids, ${humans} scripted humans)`, ""];
  if (note) L.push(note, "");
  L.push(
    `Extracted ${pct(sum((l) => l.extracted) / Math.max(1, humans))} of humans · deaths ${deaths}: ` +
      `by humans ${sum((l) => l.deaths.human)} (${pct(sum((l) => l.deaths.human) / Math.max(1, deaths))}), ` +
      `by NPCs ${sum((l) => l.deaths.npc)}, env ${sum((l) => l.deaths.env)} · timeouts ${sum((l) => l.timeouts)}`,
    "",
    `Per raid: PvP kills ${round2(sum((l) => l.pvpKills) / n)} · uniques changing hands ${round2(sum((l) => l.uniquesChangedHands) / n)} · ` +
      `pool released ${round2(sum((l) => l.pool.released) / n)} (boss ${round2(sum((l) => l.pool.boss) / n)}, containers ${round2(sum((l) => l.pool.container) / n)}, ` +
      `carriers ${round2(sum((l) => l.pool.carrier) / n)}) → extracted ${round2(sum((l) => l.pool.extracted) / n)}, left on map ${round2(sum((l) => l.pool.leftOnMap) / n)} · ` +
      `NPCs killed by humans m/g/b ${round2(sum((l) => l.npc.killedByHumans.marauder) / n)}/${round2(sum((l) => l.npc.killedByHumans.guard) / n)}/${round2(sum((l) => l.npc.killedByHumans.boss) / n)} ` +
      `of spawned ${round2(sum((l) => l.npc.spawned.marauder) / n)}/${round2(sum((l) => l.npc.spawned.guard) / n)}/${round2(sum((l) => l.npc.spawned.boss) / n)}`,
    "",
    "| seed | humans | members | R | min | extracted | deaths h/npc/env | PvP kills | changed hands | pool rel → out / left |",
    "|---:|---:|---|---:|---:|---:|---|---:|---:|---|",
  );
  for (const l of lobbies) {
    L.push(`| ${l.seed} | ${l.humans} | ${l.members.join(" ")} | ${l.lobbyR} | ${l.minutes} | ${l.extracted} | ${l.deaths.human}/${l.deaths.npc}/${l.deaths.env} | ${l.pvpKills} | ${l.uniquesChangedHands} | ${l.pool.released} → ${l.pool.extracted} / ${l.pool.leftOnMap} |`);
  }
  return L.join("\n") + "\n";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv.includes("--world")) {
  const stale = staleShared();
  if (stale.length) console.warn(`[loot-yield] WARNING: shared sources newer than packages/shared/dist (rebuild it): ${stale.slice(0, 5).join(", ")}`);
  worldCli(arg, resolve(arg("out") ?? join(tmpdir(), "extract-econ")), arg("tag") ?? "", stale);
} else if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const num = (name: string): number | undefined => (arg(name) !== undefined ? Number(arg(name)) : undefined);
  const strategy = (arg("strategy") ?? "rat") as Strategy;
  if (!STRATEGIES.includes(strategy)) throw new Error(`--strategy must be one of ${STRATEGIES.join("|")}`);
  const nHumans = Math.max(1, Math.min(24, Math.floor(num("humans") ?? 1)));
  const lobbyMode = nHumans > 1 || arg("mix") !== undefined;
  const seeds = num("seeds") ?? (lobbyMode ? 20 : 40);
  const seed0 = num("seed0") ?? 1;
  const kit = (arg("kit") ?? (strategy === "npcfarm" ? "free" : "starter")) as Kit;
  if (!KITS.includes(kit)) throw new Error(`--kit must be one of ${KITS.join("|")}`);
  const stance = arg("stance") as PvpStance | undefined;
  if (stance !== undefined && !PVP_STANCES.includes(stance)) throw new Error(`--stance must be one of ${PVP_STANCES.join("|")}`);
  const leaveMin = num("leave-min");
  const lobbyR = num("lobby-r");
  const wiring = (arg("wiring") ?? "v5") as Wiring;
  if (!["v5", "v4", "prod"].includes(wiring)) throw new Error("--wiring must be v5|v4|prod");
  const bossTarget = (arg("boss-target") ?? undefined) as BossTarget | undefined;
  const maxTier = num("max-tier");
  const minTier = num("min-tier");
  const bossAi = arg("boss-ai") !== undefined ? (JSON.parse(arg("boss-ai")!) as Record<string, unknown>) : undefined;
  const bossHoldPoolWeapon = process.argv.includes("--boss-hold-pool-weapon");
  const set = arg("set") !== undefined ? (JSON.parse(arg("set")!) as Record<string, unknown>) : undefined;
  const poolSize = num("pool");
  const spawn = (arg("spawn") ?? "game") as "game" | "random";
  const out = resolve(arg("out") ?? join(tmpdir(), "extract-econ"));
  const tag = arg("tag") ?? "";
  for (const gone of ["bots", "human-only"]) if (process.argv.includes(`--${gone}`)) console.warn(`[loot-yield] --${gone} is gone (NPC MODEL v5: no player-bots); ignored`);
  const stale = staleShared();
  if (stale.length) console.warn(`[loot-yield] WARNING: shared sources newer than packages/shared/dist (rebuild it): ${stale.slice(0, 5).join(", ")}`);
  const mix = lobbyMode ? parseMix(arg("mix") ?? "rat:2,poi:3,boss:1,full:1,fighter:1", STRATEGIES, "mix") : [];
  const kitMix = lobbyMode ? parseMix(arg("kit-mix") ?? "starter:3,free:1,hunter:1", KITS, "kit-mix") : [];
  const huntShare = num("hunt-share") ?? 0.25;
  const raid: RaidOptions = { seed: 0, lobbyR, wiring, bossAi, set, bossHoldPoolWeapon, poolSize, spawn };

  const records: RaidRecord[] = [];
  const lobbies: LobbyRecord[] = [];
  for (let i = 0; i < seeds; i++) {
    const seed = seed0 + i;
    const humans = lobbyMode
      ? lobbyHumans(seed, nHumans, mix, kitMix, huntShare)
      : [{ strategy, kit, stance, leaveMin, bossTarget, maxTier, minTier }];
    const res = runLobbyRaid({ ...raid, seed, humans });
    records.push(...res.records);
    lobbies.push(res.lobby);
    for (const r of res.records) {
      console.log(
        `[${r.strategy}/${r.kit}${lobbyMode ? ` #${r.lobby.idx}` : ""}] seed ${r.seed}: ${r.exit}${r.killedBy ? `(${r.killedBy})` : ""} @${r.minutes}m (left ${r.leftAtMin}m: ${r.leaveReason}) ` +
          `contacts ${r.contacts}/${r.seenBy} npc kills ${r.killsBy.marauder}/${r.killsBy.guard}/${r.killsBy.boss}${lobbyMode ? ` pvp ${r.pvp.kills}` : ""} ` +
          `junk ${r.haul.junkCr} CR, cons net ${Math.round(r.consumablesNet.cr)} CR, uniques ${r.gained.map((u) => `${u.def}/${u.origin}`).join(",") || "-"}, ` +
          `containers ${r.containers.total} (wild ${r.containers.byZone["wild"] ?? 0}), cons ${r.cons.foundCr}/${r.cons.usedCr}, ` +
          `pool ${r.pool.released} (boss ${r.pool.boss}, carrier ${r.pool.carrier}), bosses ${r.bosses.map((b) => `${b.kind}:${b.fate}`).join(",") || "-"}` +
          `${r.hunt.kind ? ` hunt ${r.hunt.kind}:${r.hunt.end}` : ""} — ${r.wallMs} ms`,
      );
    }
  }
  const s = summarize(records, lobbyMode ? "lobby" : strategy);
  const groups = new Map<string, RaidRecord[]>();
  for (const r of records) groups.set(`${r.strategy}:${r.kit}`, [...(groups.get(`${r.strategy}:${r.kit}`) ?? []), r]);
  const byStrategy = Object.fromEntries([...groups].map(([k, rs]) => [k, summarize(rs, k)]));
  const who = lobbyMode
    ? `lobby of ${nHumans} scripted humans (mix ${mix.map((e) => `${e.key}:${e.w}`).join(",")}, kits ${kitMix.map((e) => `${e.key}:${e.w}`).join(",")}, hunt share ${huntShare})`
    : `1 scripted human (kit ${kit}${stance ? `, stance ${stance}` : ""}${bossTarget ? `, boss target ${bossTarget}` : ""}${maxTier !== undefined ? `, POI tier <= ${maxTier}` : ""}${minTier !== undefined ? `, POI tier >= ${minTier}` : ""}, leave ${leaveMin !== undefined ? leaveMin + " min" : "default"})`;
  const note =
    `NPC MODEL v5 (no player-bots): ${who} + the match's NPCs (boss groups, marauder squads). ` +
    `Pool rule poolReleasePlanV4, wiring ${wiring}, lobby R ${lobbyR ?? "Σ scripted kits"}, pool ${poolSize ?? 700}, spawn ${spawn}` +
    `${bossAi ? `, BOSS_AI override ${JSON.stringify(bossAi)}` : ""}${set ? `, shared override ${JSON.stringify(set)}` : ""}${bossHoldPoolWeapon ? ", bosses hold pool weapons (FREE default wielded)" : ""}. ` +
    `CR values at autosell mult 1 and CONSUMABLES_CR.`;
  mkdirSync(out, { recursive: true });
  const base = join(out, `yield-${lobbyMode ? `lobby${nHumans}` : strategy}${tag ? "-" + tag : ""}`);
  writeFileSync(`${base}.json`, JSON.stringify({ v: 5, mode: lobbyMode ? "lobby" : "single", summary: s, byStrategy, lobbies, note, records }, null, 1));
  writeFileSync(`${base}.md`, (lobbyMode ? lobbyMarkdown(lobbies, note) + "\n" : "") + summaryMarkdown(s, records, note));
  console.log(`wrote ${base}.json / .md`);
  for (const [name, st] of Object.entries(s.metrics)) console.log(`  ${name}: mean ${st.mean} median ${st.median} p90 ${st.p90}`);
}
