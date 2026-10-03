/**
 * Loot-yield harness (economy): what one player takes out of a LIVE-economy Steppe raid, by play
 * style, with the real sim core. Per raid: a fresh lost pool sampled like the seeded DB pool
 * (pool-mirror.ts seedPool), the web's v4 release rule mirrored in-process (poolReleasePlanV4 +
 * boss slots + planAllocation → RaidStartResponse.containerLoot), the match's own boss spawns
 * (rollBossSpawns), 31 − boss-group bots, and one scripted human (human.ts) playing a strategy
 * through client intents only.
 *
 *   apps/game-server/node_modules/.bin/tsx apps/game-server/src/sim/econ/loot-yield.bench.ts \
 *     --strategy rat|poi|full|boss|fighter [--seeds 40] [--seed0 1] [--kit starter|free] [--leave-min M]
 *     [--lobby-r R] [--wiring v4|prod] [--boss-target nearest|foreman|commander|warden] [--max-tier T]
 *     [--pool 700] [--bots N] [--human-only] [--spawn game|random] [--tag T] [--out DIR]
 *     [--boss-ai '{"BOSS_SLOPPINESS":1}'] [--boss-hold-pool-weapon]   (tuning experiments, harness only)
 *
 * --lobby-r: the lobby's riskUnits for the pool release (default: the human's own kit, 3 / 0);
 *   other lobby members are not simulated, only their risk drives poolReleasePlanV4.
 * --wiring v4 (default): raids/start carries bosses[] (raidBossSlots) and containers[].guarded
 *   (design §5); bots = 31 − boss NPCs. "prod": what MatchmakingRoom.planLaunch sends today
 *   (bossSlots 0, no bosses[], no guarded flags; 31 bots + the NPCs on top).
 *
 * Writes DIR/yield-<strategy>.json (every raid) and DIR/yield-<strategy>.md (mean / median / p90).
 * The game server resolves @extract/shared from packages/shared/dist: after changing shared tuning
 * (CONTAINER, CONTAINER_LOOT, POOL, map) run `pnpm --filter @extract/shared build` first — the CLI
 * warns when a shared source file is newer than the build.
 *
 * Kits: "starter" = a giveaway kit (rifle r0 + armor_1 + backpack_1, 90 light rounds, 3 bandages,
 * 1 medkit; 3 risk units, like the owner's test account); "free" = nothing (free pistol kit only,
 * 0 risk units: the pool releases only the demo floor).
 * By default the raid keeps running after the human left (bots-only, to 30:00) so the bots'
 * extraction numbers cover the whole raid; --human-only stops at the human's exit (faster).
 */

import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  BOSSES,
  BOSS_AI,
  ITEM_FLAG,
  MATCH,
  SERVER_TICK_MS,
  ammoDefOf,
  storageKeys,
  type BossKind,
  containerGuarded,
  itemDef,
  raidBossSlots,
  rollBossSpawns,
  uniqueTierScore,
  extractMask,
  junkSellCr,
  mulberry32,
  type LoadoutSnapshot,
  type PlayerExitReport,
  type SettledItem,
  type SlotKey,
} from "@extract/shared";
import { fixActive, placeItem, syncPublic } from "../bag.js";
import { bossNpcCount } from "../boss.js";
import { cloneItem, makeItem, toPlain } from "../items.js";
import { Match, matchMap } from "../match.js";
import type { PlayerRuntime, RosterEntry } from "../types.js";
import { HumanAgent, STRATEGIES, consumableUnitCr, type BossTarget, type Strategy } from "./human.js";
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

export type Kit = "starter" | "free";

export interface YieldOptions {
  strategy: Strategy;
  seed: number;
  kit?: Kit;
  /** Override the strategy's leave clock (minutes). */
  leaveMin?: number;
  /** Lobby riskUnits for the pool release (default: the human's own kit). */
  lobbyR?: number;
  /** "v4" (default): bosses[] + guarded flags sent; "prod": today's planLaunch (bossSlots 0). */
  wiring?: "v4" | "prod";
  /** boss strategy target. */
  bossTarget?: BossTarget;
  /** poi / fighter: only POIs of at most this tier. */
  maxTier?: number;
  /**
   * Tuning experiment (process-wide, harness only): BOSS_AI fields to override, e.g.
   * { BOSS_SLOPPINESS: 1.0, REACT_MS: [450, 800] }. Applied before the match is built.
   */
  bossAi?: Record<string, unknown>;
  /** Tuning experiment: bosses wield their FREE BOSSES[kind].weapon and keep pool weapons in the bag. */
  bossHoldPoolWeapon?: boolean;
  poolSize?: number;
  /** Bot count (default: v4 31 − boss NPCs, prod 31). */
  bots?: number;
  /** Stop when the human leaves (default false: run the raid to its end for the bot numbers). */
  humanOnly?: boolean;
  /**
   * "game" (default): the match's own spawn rule — a lone human always gets one of the two spots
   * farthest from the bots. "random": any side spawn (what a human in a fuller lobby may get).
   */
  spawn?: "game" | "random";
  /** Debug hook, called after every server step. */
  trace?: (m: Match, human: HumanAgent, rt: PlayerRuntime) => void;
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
  /** Who killed it: human | pmc | scav | npc | alive (survived the raid). */
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

export interface RaidRecord {
  strategy: Strategy;
  seed: number;
  matchSeed: number;
  kit: Kit;
  spawn: { x: number; y: number; side: number };
  survived: boolean;
  /** Who killed the human: boss | guard | pmc | scav | env ("" = not killed). */
  killedBy: string;
  exit: string;
  minutes: number;
  leftAtMin: number;
  leaveReason: string;
  extractId: string;
  contacts: number;
  seenBy: number;
  firstContactMin: number;
  hitsTaken: number;
  shotsFired: number;
  kills: number;
  /** What the human brought out (gross). */
  haul: Haul;
  /** Consumables extracted minus non-FREE consumables brought in (negative = used up). */
  consumablesNet: Consumables;
  /** Uniques gained (extracted, not the human's own). */
  gained: UniqueOut[];
  /** Own loadout uniques lost (death / timeout) → back to the pool. */
  ownLost: UniqueOut[];
  riskUnits: number;
  /** Junk CR + net consumables CR. */
  crTotal: number;
  containers: { total: number; byTier: Record<string, number>; byZone: Record<string, number> };
  corpsesSearched: number;
  /** CR-equivalent value taken into the bag, by source (before drops / death). */
  taken: Record<string, number>;
  pool: {
    released: number;
    risk: number;
    boss: number;
    container: number;
    guarded: number;
    leftOnMap: number;
    extractedByHuman: number;
    extractedByBots: number;
    /** Pool size / top-tier items before the release. */
    sizeBefore: number;
    topBefore: number;
    /** Lobby riskUnits used. */
    lobbyR: number;
  };
  /** Consumables found (gained into the bag) and used (shot / healed), CR-eq, non-FREE only. */
  cons: { foundCr: number; usedCr: number; rounds: number; meds: number };
  bosses: BossFate[];
  /** Boss NPCs (bosses + guards) in the raid. */
  npcs: number;
  humanBossKills: number;
  hunt: { kind: string; reachedMin: number; endMin: number; end: string };
  bots: {
    count: number;
    extracted: number;
    died: number;
    timedOut: number;
    junkCr: number;
    consumablesCr: number;
    uniques: number;
    uniquesByOrigin: Record<string, number>;
  };
  wallMs: number;
}

const ZERO_CONS = (): Consumables => ({ ammoRounds: 0, ammo_light: 0, ammo_shell: 0, ammo_heavy: 0, bandage: 0, medkit: 0, cr: 0 });

function addConsumable(c: Consumables, def: string, qty: number): void {
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

function uniqueOut(s: SettledItem, origin: UniqueOrigin): UniqueOut {
  const durPct = fromRaidDur(s.def, s.dur);
  const v = { def: s.def, rarity: s.rarity, dur: durPct };
  return {
    uid: s.uid, def: s.def, rarity: s.rarity, durPct: Math.round(durPct), origin,
    refCr: Math.round(refValueCr(v)), minor: npcPriceMinor(v), tier: uniqueTierScore(s.def, s.rarity),
  };
}

function haulOf(items: readonly SettledItem[], originOf: (uid: string) => UniqueOrigin): Haul {
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

/** A giveaway kit like the owner's test account (3 risk units). */
function starterLoadout(userId: string): LoadoutSnapshot {
  const e = (key: SlotKey, def: string, qty: number, uid = "", rarity = 0, durPct = 100) =>
    ({ key, uid, def, qty, rarity, dur: toRaidDur(def, durPct) });
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

export function runYieldRaid(o: YieldOptions): RaidRecord {
  const t0 = performance.now();
  const kit = o.kit ?? "starter";
  const wiring = o.wiring ?? "v4";
  const rng = mulberry32((o.seed * 0x9e3779b1) >>> 0);
  const matchSeed = Math.floor(rng() * 2 ** 32) >>> 0;
  const userId = "bench-human";
  const loadout = kit === "starter" ? starterLoadout(userId) : null;
  const ownUids = new Set(loadout?.entries.filter((e) => e.uid).map((e) => e.uid) ?? []);
  const riskUnits = ownUids.size;
  const lobbyR = o.lobbyR ?? riskUnits;

  // raids/start: a fresh seeded-like pool, the v4 release rule mirrored in-process.
  const pool = seedPool(o.poolSize ?? 700, mulberry32((o.seed ^ 0x5eed9001) >>> 0));
  const sizeBefore = pool.length;
  const topBefore = topTierCount(pool);
  let uidSeq = 0;
  const newUid = () => `u${o.seed}-${uidSeq++}`;
  if (o.bossAi) Object.assign(BOSS_AI as unknown as Record<string, unknown>, o.bossAi);
  const map = matchMap(matchSeed, "steppe");
  // The match rolls its bosses from the match seed alone; the room makes the same roll for raids/start.
  const spawned = rollBossSpawns(matchSeed, map.bosses);
  const npcs = bossNpcCount(spawned);
  const bots = o.bots ?? (wiring === "v4" ? Math.max(0, MATCH.MAX_PLAYERS - 1 - npcs) : MATCH.MAX_PLAYERS - 1);
  const containers = map.containers.map((c, idx) => ({
    idx, kind: c.kind, tier: c.tier, guarded: wiring === "v4" && containerGuarded(c, map.bosses),
  }));
  const alloc = mirrorAllocatePool(
    pool,
    { matchSeed, containers, bosses: wiring === "v4" ? raidBossSlots(spawned) : [], riskUnits: lobbyR },
    mulberry32((o.seed ^ 0xa110c) >>> 0),
  );

  const roster: RosterEntry[] = [
    { userId, nickname: "Bench", isBot: false, loadoutId: loadout?.loadoutId },
    ...Array.from({ length: bots }, (_, i) => ({ userId: null, nickname: `Bot${i}`, isBot: true })),
  ];
  const m = new Match({
    roster,
    rng: mulberry32((matchSeed ^ 0x2026) >>> 0),
    mapSeed: matchSeed,
    mapId: "steppe",
    mode: "live",
    loadouts: loadout ? [loadout] : [],
    containerLoot: alloc.containerLoot,
    newUid,
    now: () => 1_700_000_000_000,
  });
  if (o.bossHoldPoolWeapon) for (const g of m.bosses.groups) holdPoolWeapon(g.boss, g.kind);
  // Bench only: keep the raid running after the human left (bots-only to 30:00) for bot numbers.
  if (!o.humanOnly) (m as unknown as { hasHumans: boolean }).hasHumans = false;
  const rt = m.allRuntimes().find((r) => !r.isBot)!;
  if (o.spawn === "random") {
    const sp = m.map.spawns[Math.floor(mulberry32((o.seed ^ 0x59a7) >>> 0)() * m.map.spawns.length)]!;
    rt.pub.x = rt.prevX = sp.x;
    rt.pub.y = rt.prevY = sp.y;
    rt.self.side = sp.side;
    rt.self.extractMask = extractMask(m.map, sp.side);
  }
  const spawn = { x: Math.round(rt.pub.x), y: Math.round(rt.pub.y), side: rt.self.side };
  const human = new HumanAgent(m, rt, {
    strategy: o.strategy,
    rng: mulberry32((o.seed ^ 0x4a3a) >>> 0),
    leaveAtMs: o.leaveMin !== undefined ? o.leaveMin * 60_000 : undefined,
    bossTarget: o.bossTarget,
    maxTier: o.maxTier,
  });

  const byId = new Map(m.allRuntimes().map((r) => [r.id, r]));
  const bossFate = new Map<PlayerRuntime, BossFate>();
  for (const g of m.bosses.groups) {
    const n = alloc.containerLoot[`boss:${g.kind}`]?.length ?? 0;
    bossFate.set(g.boss, { kind: g.kind, fate: "alive", atMin: -1, poolItems: n });
  }
  const roleOf = (k: PlayerRuntime | undefined): string => {
    if (!k) return "other";
    if (k === rt) return "human";
    if (k.pub.role !== 0) return "npc";
    const b = m.bots.find((x) => x.rt === k);
    return b ? b.role : "other";
  };
  let killedBy = "";
  while (!m.ended) {
    human.update(SERVER_TICK_MS);
    m.step(SERVER_TICK_MS);
    o.trace?.(m, human, rt);
    for (const ev of m.drainEvents()) {
      if (ev.type !== "kill") continue;
      const v = byId.get(ev.msg.victimId) ?? m.allRuntimes().find((r) => r.id === ev.msg.victimId);
      if (v === rt) {
        const k = ev.msg.killerId ? m.allRuntimes().find((r) => r.id === ev.msg.killerId) : undefined;
        killedBy = k ? (k.pub.role === 2 ? "guard" : k.pub.role === 1 ? "boss" : roleOf(k)) : "env";
      }
      const f = v ? bossFate.get(v) : undefined;
      if (!f) continue;
      const k = ev.msg.killerId ? (byId.get(ev.msg.killerId) ?? m.allRuntimes().find((r) => r.id === ev.msg.killerId)) : undefined;
      f.fate = roleOf(k);
      f.atMin = round2(m.clock / 60_000);
    }
  }

  const originOf = (uid: string): UniqueOrigin => (ownUids.has(uid) ? "own" : (alloc.origin.get(uid) ?? "other"));
  const rep = rt.exitReport as PlayerExitReport;
  const haul = haulOf(rep.extracted, originOf);
  const brought = ZERO_CONS();
  for (const e of loadout?.entries ?? []) if (!e.uid) addConsumable(brought, e.def, e.qty);
  const net = ZERO_CONS();
  for (const k of Object.keys(net) as Array<keyof Consumables>) net[k] = haul.consumables[k] - brought[k];
  const gained = haul.uniques.filter((u) => u.origin !== "own");
  const ownLost = rep.lost.filter((s) => ownUids.has(s.uid)).map((s) => uniqueOut(s, "own"));

  const byTier: Record<string, number> = {};
  const byZone: Record<string, number> = {};
  for (const s of human.log.searched) {
    byTier[`T${s.tier}`] = (byTier[`T${s.tier}`] ?? 0) + 1;
    byZone[s.zone] = (byZone[s.zone] ?? 0) + 1;
  }

  const botRec: RaidRecord["bots"] = { count: 0, extracted: 0, died: 0, timedOut: 0, junkCr: 0, consumablesCr: 0, uniques: 0, uniquesByOrigin: {} };
  let poolByBots = 0;
  const pooled = (o: UniqueOrigin) => o === "pool" || o === "floor" || o === "boss";
  for (const b of m.allRuntimes()) {
    if (!b.isBot || !b.exitReport) continue;
    botRec.count++;
    const r = b.exitReport;
    if (r.exit === "extract") {
      botRec.extracted++;
      const h = haulOf(r.extracted, originOf);
      botRec.junkCr += h.junkCr;
      botRec.consumablesCr += h.consumables.cr;
      botRec.uniques += h.uniques.length;
      for (const u of h.uniques) {
        botRec.uniquesByOrigin[u.origin] = (botRec.uniquesByOrigin[u.origin] ?? 0) + 1;
        if (pooled(u.origin)) poolByBots++;
      }
    } else if (r.exit === "dead") botRec.died++;
    else botRec.timedOut++;
  }
  const leftOnMap = (m.report?.leftOnMap ?? []).filter((s) => alloc.origin.has(s.uid)).length;
  const k = rt.self.kills;

  return {
    strategy: o.strategy,
    seed: o.seed,
    matchSeed,
    kit,
    spawn,
    survived: rep.exit === "extract",
    killedBy,
    exit: rep.exit,
    minutes: round2(rep.atMs / 60_000),
    leftAtMin: human.log.leftAt >= 0 ? round2(human.log.leftAt / 60_000) : -1,
    leaveReason: human.log.leaveReason,
    extractId: human.log.extractId,
    contacts: human.log.contacts.size,
    seenBy: human.log.seenBy.size,
    firstContactMin: human.log.firstContactAt >= 0 ? round2(human.log.firstContactAt / 60_000) : -1,
    hitsTaken: human.log.hitsTaken,
    shotsFired: human.log.shotsFired,
    kills: k,
    haul,
    consumablesNet: net,
    gained,
    ownLost,
    riskUnits,
    crTotal: Math.round(haul.junkCr + net.cr),
    containers: { total: human.log.searched.length, byTier, byZone },
    corpsesSearched: human.log.corpsesSearched,
    taken: Object.fromEntries(Object.entries(human.log.taken).map(([s, v]) => [s, Math.round(v)])),
    pool: {
      released: alloc.released,
      risk: alloc.risk,
      boss: alloc.boss,
      container: alloc.container,
      guarded: alloc.guarded,
      leftOnMap,
      extractedByHuman: gained.filter((u) => u.origin !== "other").length,
      extractedByBots: poolByBots,
      sizeBefore,
      topBefore,
      lobbyR,
    },
    cons: {
      foundCr: Math.round(human.log.consFoundCr),
      usedCr: Math.round(human.log.consUsedCr),
      rounds: human.log.roundsUsed,
      meds: human.log.medsUsed,
    },
    bosses: [...bossFate.values()],
    npcs,
    humanBossKills: rt.stats.bossKills,
    hunt: {
      kind: human.log.boss.kind,
      reachedMin: human.log.boss.reachedAt >= 0 ? round2(human.log.boss.reachedAt / 60_000) : -1,
      endMin: human.log.boss.huntEndAt >= 0 ? round2(human.log.boss.huntEndAt / 60_000) : -1,
      end: human.log.boss.huntEnd,
    },
    bots: botRec,
    wallMs: Math.round(performance.now() - t0),
  };
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

function round2(v: number): number {
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
  ["contacts (players seen)", (r) => r.contacts],
  ["seen by (players)", (r) => r.seenBy],
  ["hits taken", (r) => r.hitsTaken],
  ["kills", (r) => r.kills],
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
  ["uniques gained, market minor", (r) => r.gained.reduce((a, u) => a + u.minor, 0)],
  ["own uniques lost", (r) => r.ownLost.length],
  ["net pool drain (gained − own lost)", (r) => r.gained.length - r.ownLost.length],
  ["consumables found CR-eq (non-FREE)", (r) => r.cons.foundCr],
  ["consumables used CR-eq (non-FREE)", (r) => r.cons.usedCr],
  ["consumables found − used CR-eq", (r) => r.cons.foundCr - r.cons.usedCr],
  ["rounds used", (r) => r.cons.rounds],
  ["meds used", (r) => r.cons.meds],
  ["boss kills by the human", (r) => r.humanBossKills],
  ["containers searched", (r) => r.containers.total],
  ["containers searched in wilds (T0/T1 no zone)", (r) => r.containers.byZone["wild"] ?? 0],
  ["bodies searched", (r) => r.corpsesSearched],
  ["pool released into raid", (r) => r.pool.released],
  ["pool released to bosses", (r) => r.pool.boss],
  ["pool released to containers", (r) => r.pool.container],
  ["pool released to guarded containers", (r) => r.pool.guarded],
  ["boss NPCs (bosses + guards)", (r) => r.npcs],
  ["pool uniques left on map", (r) => r.pool.leftOnMap],
  ["bots extracted", (r) => r.bots.extracted],
  ["bots died", (r) => r.bots.died],
  ["bot junk CR extracted (all bots)", (r) => r.bots.junkCr],
  ["bot uniques extracted (all bots)", (r) => r.bots.uniques],
];

export interface YieldSummary {
  strategy: Strategy;
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
  /** Per boss kind: spawned raids, and fates (human / pmc / scav / npc / alive). */
  bossFates: Record<string, Record<string, number>>;
  /** boss strategy: hunt target kind → { raids, spawned, killedByHuman, rate | spawned }. */
  hunt: Record<string, { raids: number; spawned: number; reached: number; killedByHuman: number; rateIfSpawned: number; rateAll: number; ends: Record<string, number> }>;
}

export function summarize(records: readonly RaidRecord[]): YieldSummary {
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
    strategy: records[0]?.strategy ?? "rat",
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
    bossFates: bossFates(records),
    hunt: huntStats(records),
  };
}

function bossFates(records: readonly RaidRecord[]): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const r of records) {
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
  L.push("", "**Leave reasons:** " + kv(s.leaveReasons) + " · **exits:** " + kv(s.exits));
  L.push("", "**Boss fates (spawned / killed by):** " + (Object.entries(s.bossFates).map(([k, v]) => `${k}: ${kv(v)}`).join(" · ") || "-"));
  if (Object.keys(s.hunt).length) {
    L.push("", "**Boss hunt:** " + Object.entries(s.hunt).map(([k, h]) =>
      `${k}: ${h.killedByHuman}/${h.spawned} spawned killed (${pct(h.rateIfSpawned)}; ${pct(h.rateAll)} of ${h.raids} raids), reached ${h.reached}, ends ${kv(h.ends)}`).join(" · "));
  }
  L.push("", "## Raids", "", "| seed | exit | min | contacts | seen by | junk CR | cons. net CR | found/used | CR total | uniques (origin) | containers (wild) | bosses |", "|---:|---|---:|---:|---:|---:|---:|---|---:|---|---:|---|");
  for (const r of records) {
    const u = r.gained.map((g) => `${g.def}${g.rarity ? "r" + g.rarity : ""}/${g.origin}`).join(", ") || "-";
    const b = r.bosses.map((x) => `${x.kind[0]}:${x.fate}`).join(" ") || "-";
    L.push(`| ${r.seed} | ${r.exit} | ${r.minutes} | ${r.contacts} | ${r.seenBy} | ${r.haul.junkCr} | ${Math.round(r.consumablesNet.cr)} | ${r.cons.foundCr}/${r.cons.usedCr} | ${r.crTotal} | ${u} | ${r.containers.total} (${r.containers.byZone["wild"] ?? 0}) | ${b} |`);
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const strategy = (arg("strategy") ?? "rat") as Strategy;
  if (!STRATEGIES.includes(strategy)) throw new Error(`--strategy must be one of ${STRATEGIES.join("|")}`);
  const seeds = Number(arg("seeds") ?? 40);
  const seed0 = Number(arg("seed0") ?? 1);
  const kit = (arg("kit") ?? "starter") as Kit;
  const leaveMin = arg("leave-min") !== undefined ? Number(arg("leave-min")) : undefined;
  const lobbyR = arg("lobby-r") !== undefined ? Number(arg("lobby-r")) : undefined;
  const wiring = (arg("wiring") ?? "v4") as "v4" | "prod";
  const bossTarget = (arg("boss-target") ?? undefined) as BossTarget | undefined;
  const maxTier = arg("max-tier") !== undefined ? Number(arg("max-tier")) : undefined;
  const bossAi = arg("boss-ai") !== undefined ? (JSON.parse(arg("boss-ai")!) as Record<string, unknown>) : undefined;
  const bossHoldPoolWeapon = process.argv.includes("--boss-hold-pool-weapon");
  const poolSize = arg("pool") !== undefined ? Number(arg("pool")) : undefined;
  const bots = arg("bots") !== undefined ? Number(arg("bots")) : undefined;
  const humanOnly = process.argv.includes("--human-only");
  const spawn = (arg("spawn") ?? "game") as "game" | "random";
  const out = resolve(arg("out") ?? join(tmpdir(), "extract-econ"));
  const tag = arg("tag") ?? "";
  const stale = staleShared();
  if (stale.length) console.warn(`[loot-yield] WARNING: shared sources newer than packages/shared/dist (rebuild it): ${stale.slice(0, 5).join(", ")}`);

  const records: RaidRecord[] = [];
  for (let i = 0; i < seeds; i++) {
    const r = runYieldRaid({ strategy, seed: seed0 + i, kit, leaveMin, lobbyR, wiring, bossTarget, maxTier, bossAi, bossHoldPoolWeapon, poolSize, bots, humanOnly, spawn });
    records.push(r);
    console.log(
      `[${strategy}] seed ${r.seed}: ${r.exit} @${r.minutes}m (left ${r.leftAtMin}m: ${r.leaveReason}) contacts ${r.contacts}/${r.seenBy} ` +
        `junk ${r.haul.junkCr} CR, cons net ${Math.round(r.consumablesNet.cr)} CR, uniques ${r.gained.map((u) => `${u.def}/${u.origin}`).join(",") || "-"}, ` +
        `containers ${r.containers.total} (wild ${r.containers.byZone["wild"] ?? 0}), cons ${r.cons.foundCr}/${r.cons.usedCr}, ` +
        `pool ${r.pool.released} (boss ${r.pool.boss}), bosses ${r.bosses.map((b) => `${b.kind}:${b.fate}`).join(",") || "-"}` +
        `${r.hunt.kind ? ` hunt ${r.hunt.kind}:${r.hunt.end}` : ""} — ${r.wallMs} ms`,
    );
  }
  const s = summarize(records);
  const note =
    `Tuning: v4 pool rule (poolReleasePlanV4), wiring ${wiring}, lobby R ${lobbyR ?? "own kit"}, pool ${poolSize ?? 700}, ` +
    `bots ${bots ?? (wiring === "v4" ? "31 − boss NPCs" : 31)}, kit ${kit}${bossTarget ? `, boss target ${bossTarget}` : ""}${maxTier !== undefined ? `, POI tier <= ${maxTier}` : ""}` +
    `${bossAi ? `, BOSS_AI override ${JSON.stringify(bossAi)}` : ""}${bossHoldPoolWeapon ? ", bosses hold pool weapons (FREE default wielded)" : ""}, ` +
    `leave ${leaveMin !== undefined ? leaveMin + " min" : "default"}, ` +
    `${humanOnly ? "human-only" : "full raid"}, spawn ${spawn}. CR values at autosell mult 1 and CONSUMABLES_CR.`;
  mkdirSync(out, { recursive: true });
  const base = join(out, `yield-${strategy}${tag ? "-" + tag : ""}`);
  writeFileSync(`${base}.json`, JSON.stringify({ summary: s, note, records }, null, 1));
  writeFileSync(`${base}.md`, summaryMarkdown(s, records, note));
  console.log(`wrote ${base}.json / .md`);
  for (const [name, st] of Object.entries(s.metrics)) console.log(`  ${name}: mean ${st.mean} median ${st.median} p90 ${st.p90}`);
}
