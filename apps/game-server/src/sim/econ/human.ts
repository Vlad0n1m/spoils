/**
 * Scripted "human" for the economy benches (loot-yield.bench.ts). It is a roster entry with a
 * userId (the roster is humans only, NPC MODEL v5), so the match treats it exactly like a connected
 * player, and it acts only through the intents a client sends: InputSamples at INPUT_HZ (move / aim
 * / fire / walk), Match.openSearch (F on a container or body), INV_MOVE from the loot panel and
 * between own slots, INV_DROP, pickupItem (F on a loose item), reload, switchSlot and heal. Sight is
 * its own row of the server vision matrix (cone, range, bushes, LOS — what the client would draw),
 * never the state. It tells NPCs from players the way a client does: by the role ring (pub.role).
 *
 * There are no player-bots (v5): everyone else in the raid is either another scripted human
 * (multi-human runs) or an NPC (boss, guard, marauder) that holds its post.
 *
 * Strategies (what the owner asked to measure):
 * - rat:  stays in the wilds (containers with zone === null, loose loot outside every POI rect and
 *         away from road camps), walks away from anyone it sees, heads out so it reaches its extract
 *         when extraction opens (3:00) — or earlier with a full bag — and loots wild spots on the way;
 * - poi:  goes to the nearest POI of tier [minTier, maxTier] and loots it (then the next nearest),
 *         fights the marauders in its way, keeps out of a living boss's room (no boss kill),
 *         extracts with a full bag or at 12:00 (T2 looter: --max-tier 2; T3/T4 looter: --min-tier 3);
 * - full: loots everything it can anywhere (best tiers a little preferred) for 25 minutes, avoids
 *         fights (walks away, shoots back only when hit) and living bosses' rooms;
 * - boss: hunts one boss (opts.bossTarget, default the nearest BossSpot): walks to its BossSpot,
 *         engages every NPC in reach, sweeps the leash area while the boss lives, then loots the
 *         boss body and the boss POI; gives up the hunt after BOSS_HUNT_GIVEUP_MS at the spot (or
 *         when the boss never spawned) and loots the POI anyway; extracts with a full bag, out of
 *         ammo, or at 15:00;
 * - fighter: like poi (nearest POIs in the tier band) but engages every NPC it sees — measures
 *         consumable use (found vs used) for an average fighter; extracts with a full bag or at 12:00;
 * - npcfarm: (free-kit alt) walks from one low-tier camp (road camps, T0/T1 POI posts) to the next,
 *         kills the marauders there and loots their bodies; leaves dry, hurt, full or at 12:00.
 *
 * PvP stance (multi-human runs; other humans are told apart from NPCs by pub.role === 0):
 * - avoid:  walks away from humans it sees (rat / full default), shoots back when hit;
 * - defend: engages a human only when shot or when one comes within DEFEND_PX (poi / boss /
 *           npcfarm default);
 * - hunt:   engages any human in weapon reach (fighter default), then loots the body; between
 *           fights it walks toward gunfire it hears (its per-listener sounds, like a client).
 *
 * Fighters (every non-avoider) break contact when they are losing (low HP, or outnumbered and hurt)
 * and heal out of the NPCs' leash before they go back in; on the way out, an extract whose route
 * keeps making it flee (a camp, a human) is given up for the next one.
 *
 * Everything is driven by its own rng (`opts.rng`), so a seed reproduces the run.
 */

import {
  CONSUMABLES_CR,
  CONTAINER_STATE,
  INPUT_DT_MS,
  BOSS_AI,
  ITEM_FLAG,
  MATCH,
  PLAYER,
  SEARCH,
  SOLID,
  SOUND,
  SoundKind,
  WEAPON_IDS,
  WEAPONS,
  decodeSoundMsg,
  dogTagCr,
  sectorAngle,
  itemDef,
  npcLeashPx,
  npcPostsOf,
  npcClassOfPost,
  planPlace,
  raycastSolids,
  storageKeys,
  zoneAt,
  type BossKind,
  type BossSpot,
  type ConsumableId,
  type ItemLike,
  type NpcPost,
  type Rng,
  type SlotKey,
  type SoundMsg,
  type Zone,
} from "@extract/shared";
import { activeWeapon, ammoCount, medCount, weaponDefOf } from "../bag.js";
import { currentTarget, lootItems, type SearchTarget } from "../containers.js";
import { extractAllowed, extractIsOpen } from "../extraction.js";
import { toPlain } from "../items.js";
import type { Match } from "../match.js";
import type { Pt } from "../nav.js";
import type { PlayerRuntime } from "../types.js";
import { fromRaidDur, refValueCr } from "./pool-mirror.js";

export type Strategy = "rat" | "poi" | "full" | "boss" | "fighter" | "npcfarm";
export const STRATEGIES: readonly Strategy[] = ["rat", "poi", "full", "boss", "fighter", "npcfarm"];
/** How a scripted human treats other humans (multi-human runs). */
export type PvpStance = "avoid" | "defend" | "hunt";
export const PVP_STANCES: readonly PvpStance[] = ["avoid", "defend", "hunt"];
/** Default stance per strategy. */
export const DEFAULT_STANCE: Readonly<Record<Strategy, PvpStance>> = {
  rat: "avoid",
  full: "avoid",
  poi: "defend",
  boss: "defend",
  fighter: "hunt",
  npcfarm: "defend",
};
/** Boss strategy target: a kind, or the nearest BossSpot to the spawn. */
export type BossTarget = BossKind | "nearest";
/** Boss strategy: hunting time at the spot before it gives up and just loots the POI. */
const BOSS_HUNT_GIVEUP_MS = 6 * 60_000;
/** Boss strategy: "at the spot" radius, and the sweep radius while the boss is unseen. */
const BOSS_SPOT_PX = 450;
/** Aggressive strategies open fire on sight within this share of the weapon's range. */
const ENGAGE_RANGE_FRAC = 0.65;
/** "defend" stance: a human this close is a threat (engaged on sight). */
const DEFEND_PX = 420;
/** poi / full: keep this far from a BossSpot while its boss lives (the boss room). */
const BOSS_ROOM_AVOID_PX = 900;
/** rat: keep this much beyond a road camp's leash. */
const CAMP_AVOID_EXTRA_PX = 500;
/** npcfarm: "at the camp" radius, and how long it sweeps there without seeing an NPC before moving on. */
const CAMP_AT_PX = 350;
const CAMP_CLEAR_MS = 15_000;
/** Auto weapons beyond close range: bursts of BURST_MS, then BURST_PAUSE_MS (a human does not hold the trigger). */
const BURST_MS = 450;
const BURST_PAUSE_MS = 300;

/** Default "head for the extract" clock per strategy (rat: arrive when extraction opens). */
export const LEAVE_AT_MS: Readonly<Record<Strategy, number>> = {
  rat: MATCH.EXTRACT_OPEN_AT_MS,
  poi: 12 * 60_000,
  full: 25 * 60_000,
  boss: 15 * 60_000,
  fighter: 12 * 60_000,
  npcfarm: 12 * 60_000,
};

export interface HumanOptions {
  strategy: Strategy;
  rng: Rng;
  /** Override LEAVE_AT_MS[strategy] (rat: arrival time; others: departure time). */
  leaveAtMs?: number;
  /** boss strategy: which boss to hunt (default nearest BossSpot). */
  bossTarget?: BossTarget;
  /** poi / fighter: only POIs of at most this tier (default 4 = any). */
  maxTier?: number;
  /** poi / fighter: only POIs of at least this tier (default 1). */
  minTier?: number;
  /** PvP stance (default DEFAULT_STANCE[strategy]). */
  stance?: PvpStance;
}

/** Where a taken item came from (CR value at take time, by source). */
export type Source =
  | "wild" | "poi_t1" | "poi_t2" | "poi_t3" | "poi_t4" | "npc_body" | "boss_body" | "human_body" | "ground_wild" | "ground_poi";

export interface HumanLog {
  /** Distinct roster indexes this player saw (its vision row): humans and NPCs. */
  contacts: Set<number>;
  /** Distinct roster indexes that saw this player. */
  seenBy: Set<number>;
  /** Of `contacts`, the other humans. */
  humanContacts: Set<number>;
  /** Clock of the first contact either way (-1 = none). */
  firstContactAt: number;
  hitsTaken: number;
  shotsFired: number;
  /** Static containers this player opened (once each). */
  searched: Array<{ idx: number; tier: number; zone: string }>;
  corpsesSearched: number;
  /** CR-equivalent value taken into the inventory, by source (junk at sell value, consumables at CONSUMABLES_CR, uniques at refValueCr). */
  taken: Record<string, number>;
  /** Uniques taken (uid → source). */
  uniqueSource: Map<string, Source>;
  /** When the agent decided to head out, and why. */
  leftAt: number;
  leaveReason: string;
  /** Extract chosen. */
  extractId: string;
  /** Non-FREE consumables (ammo incl. loaded rounds, bandages, medkits) gained, CR-eq at CONSUMABLES_CR. */
  consFoundCr: number;
  /** …used (shot, healed; drops excluded), CR-eq. */
  consUsedCr: number;
  /** Rounds fired / meds used (non-FREE). */
  roundsUsed: number;
  medsUsed: number;
  /** boss strategy: target kind, when it reached the spot (-1 never), when the hunt ended and why. */
  boss: { kind: string; reachedAt: number; huntEndAt: number; huntEnd: string };
  /** npcfarm: camps visited (reached) and cleared (swept without an NPC in sight). */
  camps: { visited: number; cleared: number };
}

const THINK_MS = 100;
/** Search budget: open delay + base + per item, capped. */
const SEARCH_BASE_MS = 3000;
const SEARCH_PER_ITEM_MS = 1000;
const SEARCH_MAX_MS = 25_000;
/** Ground items further than this are not considered (perf; containers are scanned map-wide). */
const GROUND_SCAN_PX = 2500;
/** Avoiders keep walking away this long after they last saw someone. */
const FLEE_HOLD_MS = 3000;
const FLEE_PX = 800;
/**
 * Fighters break contact to heal (a player who is losing a fight backs out of the camp's reach —
 * NPCs never chase beyond leash + NPC.CHASE_EXTRA_PX): below RETREAT_HP, or below
 * RETREAT_HP_OUTNUMBERED with 2+ hostiles in sight, while it still has meds. Each retreat runs
 * RETREAT_MS; the calm heal (3 s without a hit) then patches it up before it goes back in.
 */
const RETREAT_HP = 45;
const RETREAT_HP_OUTNUMBERED = 65;
const RETREAT_MS = 5000;
/**
 * "hunt" stance: walks toward gunfire it hears (the hidden sound sector + distance band a client
 * gets) — where a fight is, there is a human — while the shot is fresh, for at most
 * INVESTIGATE_MAX_MS per lead, and only from INVESTIGATE_MIN_PX on (closer: its eyes take over).
 */
const INVESTIGATE_FRESH_MS = 20_000;
const INVESTIGATE_MAX_MS = 45_000;
const INVESTIGATE_MIN_PX = 200;
/**
 * On the way out: after this many separate flee episodes toward one extract (an NPC camp or a
 * human on the route), it gives that extract up and takes the next one — a player does not keep
 * bouncing off the same camp until the raid times out.
 */
const EXTRACT_FLEES_MAX = 3;
/** Rat: on the way out, only wild spots that cost at most this much detour. */
const RAT_DETOUR_PX = 700;
/**
 * A rat sticks to the on-the-way target it picked (the Euclidean detour test flips as it walks when
 * the real path runs another way round) for at most this long, then blacklists it.
 */
const RAT_WAY_TIMEOUT_MS = 45_000;
/**
 * Rat: an NPC it walked away from marks that spot as dangerous for this long; wild loot within
 * RAT_DANGER_PX of it is skipped (a player remembers the camp at a POI gate and does not keep
 * detouring back into it on the way out — v5 iteration 3: east-side rats bounced off a gate post
 * until the raid timed out).
 */
const RAT_DANGER_MS = 300_000;
const RAT_DANGER_PX = 1200;
/** Walk + channel + margin before the end of the raid: go now. */
const LAST_CALL_MARGIN_MS = 60_000;
/** Path routing is ~1.35× the straight line on the Steppe. */
const ROUTE_FACTOR = 1.35;
const REPLAN_MS = 3000;
const PROGRESS_MS = 10_000;
/** Searches in a row with a full bag and nothing swapped in before the bag counts as full. */
const FULL_STALL = 3;

type Goal =
  | { kind: "search"; id: string; idx: number; x: number; y: number; src: Source }
  | { kind: "item"; id: string; x: number; y: number; needsInteract: boolean; src: Source }
  | { kind: "extract"; id: string; x: number; y: number; r: number };

/** CR value of one unit of a consumable (CONSUMABLES_CR is priced per pack). */
export function consumableUnitCr(def: string): number {
  const c = CONSUMABLES_CR[def as ConsumableId];
  return c ? c.cr / c.qty : 0;
}

/** What a greedy human values an item at (CR-ish). FREE kit is worth nothing outside the raid. */
export function humanValue(it: ItemLike): number {
  const d = itemDef(it.def);
  if (!d || it.flags & ITEM_FLAG.FREE) return 0;
  switch (d.cat) {
    case "junk":
      return (d.id === "junk_dogtag" ? dogTagCr(it.lvl ?? 0) : (d.value ?? 0)) * it.qty;
    case "ammo":
    case "med":
      return consumableUnitCr(d.id) * it.qty;
    case "weapon":
    case "armor":
    case "backpack":
      // A unique is market (SOL) value: always worth more than any junk.
      return 5000 + refValueCr({ def: it.def, rarity: it.rarity, dur: fromRaidDur(it.def, it.dur) });
    default:
      return 0;
  }
}

function inRect(r: { x: number; y: number; w: number; h: number }, x: number, y: number, pad = 0): boolean {
  return x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad;
}

export class HumanAgent {
  readonly log: HumanLog = {
    contacts: new Set(), seenBy: new Set(), humanContacts: new Set(), firstContactAt: -1, hitsTaken: 0, shotsFired: 0,
    searched: [], corpsesSearched: 0, taken: {}, uniqueSource: new Map(), leftAt: -1, leaveReason: "", extractId: "",
    consFoundCr: 0, consUsedCr: 0, roundsUsed: 0, medsUsed: 0,
    boss: { kind: "", reachedAt: -1, huntEndAt: -1, huntEnd: "" },
    camps: { visited: 0, cleared: 0 },
  };
  readonly strategy: Strategy;
  readonly stance: PvpStance;
  private readonly rng: Rng;
  private readonly leaveAt: number;

  private seq = 0;
  private inputAcc = 0;
  private thinkAcc = THINK_MS;
  private mx = 0;
  private my = 0;
  private aim = 0;
  private walk = false;
  private wantFire = false;
  /** Current fight target is beyond close range (auto weapons fire in bursts). */
  private burstLong = false;
  private lastFire = false;
  private nextPressAt = 0;
  private hitSeenAt = -Infinity;

  private goal: Goal | null = null;
  private goalSince = 0;
  private readonly blacklist = new Map<string, number>();
  private readonly searchedKeys = new Set<string>();
  private extracting = false;
  private zone: Zone | null = null;
  private readonly doneZones = new Set<string>();
  private fleeFrom: Pt | null = null;
  private fleeUntil = 0;
  /** Fighter retreat (break contact to heal): until this clock, away from retreatFrom. */
  private retreatUntil = 0;
  private retreatFrom: Pt | null = null;
  /** Last gunfire heard (estimated position) and when this lead started ("hunt" stance). */
  private heardShot: { x: number; y: number; at: number; since: number } | null = null;
  /** Extracts given up (blocked route), and flee episodes toward the current one. */
  private readonly badExtracts = new Set<string>();
  private extractFlees = 0;
  /** rat: the on-the-way target it is walking to on its way out, and since when. */
  private wayGoal: Goal | null = null;
  private wayGoalSince = 0;
  /** rat: NPC sightings it fled from (RAT_DANGER_MS / RAT_DANGER_PX). */
  private readonly dangers: Array<{ x: number; y: number; until: number }> = [];
  private searchSince = 0;
  private searchSrc: Source = "wild";
  /** Takes / swaps in the current search session. */
  private sessionTakes = 0;
  private fullStall = 0;
  /** Inventory value at the last decision and where the player was getting loot from. */
  private lastInvValue = -1;
  private lastSource: Source = "ground_wild";
  private aimErr = 0;
  private aimErrUntil = 0;
  private strafe = 1;
  private strafeUntil = 0;

  private path: Pt[] = [];
  private pathIdx = 0;
  private pathFor: Pt | null = null;
  private replanAt = 0;
  private replanMinAt = 0;
  private progressFor: Pt | null = null;
  private progressBest = Infinity;
  private progressAt = 0;
  private detourUntil = 0;
  private detourAngle = 0;
  private side = 1;
  private stuckFails = 0;

  /** boss strategy: the BossSpot hunted and the hunt state. */
  private bossSpot: BossSpot | null = null;
  private readonly maxTier: number;
  private readonly minTier: number;
  /** Boss runtime per BossSpot kind, found once at spawn (null: that boss did not spawn). */
  private readonly bossBySpot = new Map<string, PlayerRuntime | null>();
  /** Road-camp posts (rat avoids them) and npcfarm's camp list / current camp. */
  private readonly roadCamps: NpcPost[];
  private readonly farmCamps: NpcPost[];
  private camp: NpcPost | null = null;
  private campReachedAt = -1;
  private campLastNpcAt = 0;
  private readonly doneCamps = new Set<number>();
  private hunting = false;
  private sweepAt: Pt | null = null;
  private sweepUntil = 0;
  /** Non-FREE consumables carried at the last decision (CR-eq / rounds / meds) and drops since. */
  private lastCons: { cr: number; rounds: number; meds: number } | null = null;
  private droppedCons = { cr: 0, rounds: 0, meds: 0 };

  constructor(private readonly m: Match, readonly rt: PlayerRuntime, opts: HumanOptions) {
    this.strategy = opts.strategy;
    this.stance = opts.stance ?? DEFAULT_STANCE[opts.strategy];
    this.rng = opts.rng;
    this.leaveAt = opts.leaveAtMs ?? LEAVE_AT_MS[opts.strategy];
    this.aim = this.rng() * Math.PI * 2;
    this.maxTier = opts.maxTier ?? 4;
    this.minTier = opts.minTier ?? 1;
    // Bosses stand on their BossSpot at spawn: the nearest role-1 runtime within 1200 px is that boss.
    for (const spot of m.map.bosses) {
      let best: PlayerRuntime | null = null;
      let bd = 1200;
      for (const o of m.allRuntimes()) {
        if (o.pub.role !== 1) continue;
        const d = Math.hypot(o.pub.x - spot.x, o.pub.y - spot.y);
        if (d < bd) {
          bd = d;
          best = o;
        }
      }
      this.bossBySpot.set(spot.kind, best);
    }
    const posts = npcPostsOf(m.map);
    this.roadCamps = posts.filter((q) => q.kind === "road");
    this.farmCamps = posts.filter((q) => npcClassOfPost(q) === "low");
    if (this.strategy === "boss") {
      const spots = m.map.bosses;
      const t = opts.bossTarget ?? "nearest";
      const p = rt.pub;
      this.bossSpot =
        t === "nearest"
          ? ([...spots].sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))[0] ?? null)
          : (spots.find((s) => s.kind === t) ?? null);
      this.hunting = !!this.bossSpot;
      this.log.boss.kind = this.bossSpot?.kind ?? "";
      if (this.bossSpot) this.zone = m.map.zones.find((z) => z.id === this.bossSpot!.zone) ?? zoneAt(m.map, this.bossSpot.x, this.bossSpot.y) ?? null;
    }
  }

  /** The hunted boss's runtime (null: it did not spawn). */
  private bossRt(): PlayerRuntime | null {
    const s = this.bossSpot;
    if (!s) return null;
    return this.bossBySpot.get(s.kind) ?? null;
  }

  /** Inside a living boss's room (poi / full keep out: no boss kill). */
  private inBossRoom(x: number, y: number): boolean {
    for (const spot of this.m.map.bosses) {
      const b = this.bossBySpot.get(spot.kind);
      if (b?.pub.alive && Math.hypot(spot.x - x, spot.y - y) < BOSS_ROOM_AVOID_PX) return true;
    }
    return false;
  }

  /** Near a road camp (rat keeps away from them). */
  private nearDanger(x: number, y: number): boolean {
    const clock = this.m.clock;
    for (const z of this.dangers) if (z.until > clock && Math.hypot(z.x - x, z.y - y) < RAT_DANGER_PX) return true;
    return false;
  }

  private nearRoadCamp(x: number, y: number): boolean {
    for (const c of this.roadCamps) if (Math.hypot(c.x - x, c.y - y) < npcLeashPx(c) + CAMP_AVOID_EXTRA_PX) return true;
    return false;
  }

  /** Call once per server step BEFORE Match.step (a client's inputs arrive before the tick). */
  update(dtMs: number): void {
    if (!this.rt.pub.alive) return;
    this.sense();
    this.thinkAcc += dtMs;
    if (this.thinkAcc >= THINK_MS) {
      this.thinkAcc = 0;
      this.think();
    }
    this.inputAcc += dtMs;
    const n = Math.floor((this.inputAcc + 1e-6) / INPUT_DT_MS);
    this.inputAcc = Math.max(0, this.inputAcc - n * INPUT_DT_MS);
    for (let i = 0; i < n; i++) this.emitInput();
  }

  // ------------------------------------------------------------------ senses / input

  private sense(): void {
    const me = this.rt.rosterIndex;
    const v = this.m.vision;
    const n = this.m.allRuntimes().length;
    for (const j of v.row(me)) {
      this.contact(this.log.contacts, j);
      if (this.m.rosterRuntime(j)?.pub.role === 0) this.log.humanContacts.add(j);
    }
    for (let j = 0; j < n; j++) if (j !== me && v.sees(j, me) && this.m.rosterRuntime(j)?.pub.alive) this.contact(this.log.seenBy, j);
    if (this.rt.lastHitAt > this.hitSeenAt) {
      this.hitSeenAt = this.rt.lastHitAt;
      this.log.hitsTaken++;
    }
  }

  private contact(set: Set<number>, j: number): void {
    if (!set.has(j)) set.add(j);
    if (this.log.firstContactAt < 0) this.log.firstContactAt = this.m.clock;
  }

  private emitInput(): void {
    let fire = false;
    const def = weaponDefOf(activeWeapon(this.rt));
    if (this.wantFire && def) {
      if (def.auto) fire = !this.burstLong || (this.m.clock % (BURST_MS + BURST_PAUSE_MS)) < BURST_MS;
      else if (!this.lastFire && this.m.clock >= this.nextPressAt) {
        fire = true;
        this.nextPressAt = this.m.clock + Math.max(def.fireIntervalMs, 250) + this.rng() * 120;
      }
    }
    if (fire && !this.lastFire) this.log.shotsFired++;
    this.lastFire = fire;
    this.m.enqueueInput(this.rt.id, { seq: ++this.seq, mx: this.mx, my: this.my, aim: this.aim, fire, roll: false, walk: this.walk && !fire });
  }

  // ------------------------------------------------------------------ decisions

  /** Walks away from what it sees (rat / full): every NPC, and humans unless it hunts them. */
  private get avoider(): boolean {
    return this.strategy === "rat" || this.strategy === "full";
  }

  /** Engages NPCs on sight (everything but the avoiders). */
  private get npcFighter(): boolean {
    return !this.avoider;
  }

  /** Would it walk away from this visible runtime? */
  private shuns(o: PlayerRuntime): boolean {
    if (o.pub.role !== 0) return this.avoider;
    return this.stance === "avoid" || (this.avoider && this.stance !== "hunt");
  }

  /** Would it open fire on this visible runtime at distance d (not counting return fire)? */
  private wantsFight(o: PlayerRuntime, d: number): boolean {
    if (o.pub.role !== 0) return this.npcFighter;
    if (this.stance === "hunt") return true;
    return this.stance === "defend" && d <= DEFEND_PX;
  }

  /** Nearest visible living runtime in weapon reach it wants to fight. */
  private engageTarget(seen: readonly PlayerRuntime[]): PlayerRuntime | null {
    const def = weaponDefOf(activeWeapon(this.rt));
    if (!def) return null;
    const p = this.rt.pub;
    let best: PlayerRuntime | null = null;
    let bd = Infinity;
    for (const o of seen) {
      const d = Math.hypot(o.pub.x - p.x, o.pub.y - p.y);
      if (d <= def.range * ENGAGE_RANGE_FRAC && d < bd && this.wantsFight(o, d)) {
        bd = d;
        best = o;
      }
    }
    return best;
  }

  private visible(): PlayerRuntime[] {
    const out: PlayerRuntime[] = [];
    for (const j of this.m.vision.row(this.rt.rosterIndex)) {
      const o = this.m.rosterRuntime(j);
      if (o?.pub.alive) out.push(o);
    }
    return out;
  }

  private rounds(key: "w1" | "w2"): number {
    const it = this.rt.self.slots.get(key);
    const def = weaponDefOf(it);
    return it && def ? it.mag + ammoCount(this.rt, def.ammo) : 0;
  }

  private think(): void {
    const rt = this.rt;
    const p = rt.pub;
    const s = rt.self;
    const clock = this.m.clock;
    this.wantFire = false;
    this.walk = false;
    this.account();

    // Weapons: never stand there with a dry gun when the other slot has rounds.
    const active = s.active as "w1" | "w2";
    const other = active === "w1" ? "w2" : "w1";
    if (s.reloadUntil === 0 && this.rounds(active) <= 0 && this.rounds(other) > 0) this.m.switchSlot(rt.id, other);

    const by = rt.lastHitBy;
    const attacker = by && by.pub.alive && clock - rt.lastHitAt < 4000 ? by : null;
    const seen = this.visible();
    const armed = this.rounds("w1") + this.rounds("w2") > 0;
    // Fighters losing a fight break contact (out of the NPCs' leash) and heal once nobody hits them.
    if (!this.avoider && s.extractId === "") {
      const hostiles = seen.filter((o) => o.pub.role !== 0 || o === attacker || this.wantsFight(o, 0));
      const meds = medCount(rt, "medkit") + medCount(rt, "bandage");
      const losing = p.hp < RETREAT_HP || (hostiles.length >= 2 && p.hp < RETREAT_HP_OUTNUMBERED);
      if (losing && meds > 0 && (hostiles.length > 0 || attacker)) {
        let cx = 0, cy = 0;
        const from = hostiles.length ? hostiles : [attacker!];
        for (const o of from) { cx += o.pub.x; cy += o.pub.y; }
        this.retreatFrom = { x: cx / from.length, y: cy / from.length };
        this.retreatUntil = clock + RETREAT_MS;
      }
      if (this.retreatFrom && clock < this.retreatUntil) {
        if (rt.search) this.m.searchClose(rt.id);
        this.flee(this.retreatFrom);
        return;
      }
      this.retreatFrom = null;
    }
    if (attacker && seen.includes(attacker) && armed) {
      this.fight(attacker);
      return;
    }
    if (!this.extracting && armed && s.healUntil === 0) {
      const e = this.engageTarget(seen);
      if (e) {
        this.fight(e);
        return;
      }
    }
    if (attacker && !seen.includes(attacker)) {
      // Shot from somewhere unseen: turn toward it (the HUD damage arc) — avoiders also back off.
      this.aim = Math.atan2(attacker.pub.y - p.y, attacker.pub.x - p.x);
      if (this.avoider) {
        this.fleeFrom = { x: attacker.pub.x, y: attacker.pub.y };
        this.fleeUntil = clock + FLEE_HOLD_MS;
      }
    }
    const inChannel = s.extractId !== "";
    const shunned = seen.filter((o) => this.shuns(o));
    if (shunned.length > 0 && !inChannel) {
      // A rat remembers the NPCs it fled from; an on-the-way detour that led there is dropped and
      // does not count against the extract route.
      let detour = false;
      if (this.strategy === "rat") {
        for (const o of shunned) {
          if (o.pub.role === 0) continue;
          const d = this.dangers.find((z) => Math.hypot(z.x - o.pub.x, z.y - o.pub.y) < 300);
          if (d) d.until = clock + RAT_DANGER_MS;
          else this.dangers.push({ x: o.pub.x, y: o.pub.y, until: clock + RAT_DANGER_MS });
        }
        if (this.wayGoal) {
          this.blacklist.set(this.wayGoal.id, clock + RAT_DANGER_MS);
          this.wayGoal = null;
          detour = true;
        }
      }
      if (!detour && this.extracting && clock >= this.fleeUntil && this.goal?.kind === "extract" && ++this.extractFlees >= EXTRACT_FLEES_MAX) {
        this.badExtracts.add(this.goal.id);
        this.extractFlees = 0;
        this.goal = null;
      }
      let cx = 0, cy = 0;
      for (const o of shunned) { cx += o.pub.x; cy += o.pub.y; }
      this.fleeFrom = { x: cx / shunned.length, y: cy / shunned.length };
      this.fleeUntil = clock + FLEE_HOLD_MS;
    }
    if (this.fleeFrom && clock < this.fleeUntil && !inChannel) {
      if (rt.search) this.m.searchClose(rt.id);
      this.flee(this.fleeFrom);
      return;
    }
    this.fleeFrom = null;

    const calm = clock - rt.lastHitAt > 3000;
    if (calm && p.hp < 60 && s.healUntil === 0 && s.reloadUntil === 0) {
      const kind = p.hp <= 35 && medCount(rt, "medkit") > 0 ? "medkit" : medCount(rt, "bandage") > 0 ? "bandage" : "medkit";
      this.m.heal(rt.id, kind);
    }
    const w = activeWeapon(rt);
    const def = weaponDefOf(w);
    if (w && def && s.reloadUntil === 0 && s.healUntil === 0 && w.mag < def.magSize * 0.5 && ammoCount(rt, def.ammo) > 0) {
      this.m.reload(rt.id);
    }

    if (rt.search) {
      this.stop();
      this.aim += 0.3; // look around while the panel is open
      this.stepSearch();
      return;
    }
    this.searchSince = 0;

    if (!this.extracting) this.checkLeave();
    if (this.extracting) {
      this.goExtract();
      return;
    }
    if (this.stance === "hunt" && this.investigateStep()) return;
    this.lootStep();
  }

  /**
   * A per-listener sound payload (the client's EventsMsg.snd): hidden gunshots become a lead for the
   * "hunt" stance, at the band's middle distance along the sector's direction.
   */
  hear(msg: SoundMsg): void {
    if (this.stance !== "hunt" || !this.rt.pub.alive) return;
    const p = this.rt.pub;
    for (const s of decodeSoundMsg(msg)) {
      if (!s.hidden || s.kind !== SoundKind.shot) continue;
      const w = WEAPON_IDS[s.variant];
      const radius = (w ? WEAPONS[w].soundRadius : 2400) / (s.occluded ? SOUND.OCCLUSION_MULT : 1);
      const lo = s.b === 0 ? 0 : SOUND.BANDS[s.b - 1]!;
      const d = radius * (lo + SOUND.BANDS[s.b]!) / 2;
      const a = sectorAngle(s.a);
      const x = Math.max(200, Math.min(this.m.map.width - 200, p.x + Math.cos(a) * d));
      const y = Math.max(200, Math.min(this.m.map.height - 200, p.y + Math.sin(a) * d));
      const clock = this.m.clock;
      const fresh = this.heardShot && clock - this.heardShot.at < INVESTIGATE_FRESH_MS;
      this.heardShot = { x, y, at: clock, since: fresh ? this.heardShot!.since : clock };
    }
  }

  /** "hunt" stance: walk toward the last gunfire heard; false when there is no live lead. */
  private investigateStep(): boolean {
    const h = this.heardShot;
    const clock = this.m.clock;
    if (!h || clock - h.at > INVESTIGATE_FRESH_MS || clock - h.since > INVESTIGATE_MAX_MS) {
      this.heardShot = null;
      return false;
    }
    const p = this.rt.pub;
    if (Math.hypot(h.x - p.x, h.y - p.y) < INVESTIGATE_MIN_PX) {
      this.heardShot = null;
      return false;
    }
    this.goal = null;
    this.navigate(h.x, h.y);
    this.lookAround();
    return true;
  }

  // ------------------------------------------------------------------ leaving

  /** Every storage slot holds something worth keeping (FREE kit counts as free room). */
  private storageFull(): boolean {
    const s = this.rt.self.slots;
    for (const k of storageKeys(s)) {
      const it = s.get(k);
      if (!it || it.flags & ITEM_FLAG.FREE) return false;
    }
    return true;
  }

  /**
   * "Bag full" as a player means it: storage full AND the last FULL_STALL searches with a full bag
   * found nothing worth swapping in (a greedy player keeps trading junk up while that pays).
   */
  private bagFull(): boolean {
    return this.storageFull() && this.fullStall >= FULL_STALL;
  }

  /** Nearest usable extract that is still open when we would get there, and the walk time. */
  private pickExtract(): { id: string; x: number; y: number; r: number; etaMs: number } | null {
    const p = this.rt.pub;
    const clock = this.m.clock;
    let best: { id: string; x: number; y: number; r: number; etaMs: number } | null = null;
    const blocked = [...this.m.state.extracts.values()].every((e) => !extractAllowed(this.m, this.rt, e) || this.badExtracts.has(e.id));
    if (blocked) this.badExtracts.clear();
    for (const e of this.m.state.extracts.values()) {
      if (!extractAllowed(this.m, this.rt, e) || this.badExtracts.has(e.id)) continue;
      const eta = (Math.hypot(e.x - p.x, e.y - p.y) * ROUTE_FACTOR / PLAYER.SPEED) * 1000;
      const arrive = Math.max(clock + eta, e.openAt);
      if (e.closeAt > 0 && e.closeAt < arrive + MATCH.EXTRACT_CHANNEL_MS + 20_000) continue;
      if (!best || eta < best.etaMs) best = { id: e.id, x: e.x, y: e.y, r: e.r, etaMs: eta };
    }
    return best;
  }

  private checkLeave(): void {
    const clock = this.m.clock;
    const ex = this.pickExtract();
    if (!ex) return;
    let why = "";
    const departAt = this.strategy === "rat" ? this.leaveAt - ex.etaMs - 5000 : this.leaveAt;
    if (clock >= departAt) why = "time";
    else if (this.strategy !== "full" && this.bagFull()) why = "full";
    else if (MATCH.DURATION_MS - clock < ex.etaMs + MATCH.EXTRACT_CHANNEL_MS + LAST_CALL_MARGIN_MS) why = "last_call";
    else if (this.rt.pub.hp < 35 && medCount(this.rt, "bandage") + medCount(this.rt, "medkit") === 0) why = "hurt";
    else if (!this.avoider && this.rounds("w1") + this.rounds("w2") === 0) why = "dry";
    if (!why) return;
    this.startLeaving(why);
  }

  private startLeaving(why: string): void {
    this.extracting = true;
    this.log.leftAt = this.m.clock;
    this.log.leaveReason = why;
    this.goal = null;
  }

  private goExtract(): void {
    const p = this.rt.pub;
    const clock = this.m.clock;
    let g = this.goal;
    if (!g || g.kind !== "extract" || !this.extractStillGood(g.id)) {
      const ex = this.pickExtract();
      if (!ex) {
        this.stop();
        return;
      }
      g = { kind: "extract", id: ex.id, x: ex.x, y: ex.y, r: ex.r };
      this.goal = g;
      this.goalSince = clock;
      this.log.extractId = ex.id;
    }
    // A rat walks out through the wilds and grabs what lies on the way (small detours only).
    if (this.strategy === "rat" && this.rt.self.extractId === "" && !this.bagFull()) {
      let t = this.wayGoal;
      if (t && (!this.goalValid(t) || clock - this.wayGoalSince > RAT_WAY_TIMEOUT_MS)) {
        if (this.goalValid(t)) this.blacklist.set(t.id, clock + 120_000);
        t = null;
      }
      if (!t) {
        t = this.bestTarget(g);
        this.wayGoalSince = clock;
      }
      this.wayGoal = t;
      if (t) {
        this.followTarget(t);
        return;
      }
    }
    const d = Math.hypot(g.x - p.x, g.y - p.y);
    if (d < g.r * 0.4) this.stop();
    else this.navigate(g.x, g.y);
    this.lookAround();
  }

  private extractStillGood(id: string): boolean {
    const e = this.m.state.extracts.get(id);
    if (!e) return false;
    return e.closeAt === 0 || e.closeAt > this.m.clock + MATCH.EXTRACT_CHANNEL_MS + 5000;
  }

  // ------------------------------------------------------------------ looting

  /** Is (x, y) a place this strategy loots? */
  private allowedAt(x: number, y: number, containerZone?: string | null): boolean {
    const zid = containerZone !== undefined ? containerZone : (zoneAt(this.m.map, x, y)?.id ?? null);
    switch (this.strategy) {
      case "rat":
        return zid === null && !this.nearRoadCamp(x, y) && !this.nearDanger(x, y);
      case "full":
        return !this.inBossRoom(x, y);
      case "poi":
        return !!this.zone && zid === this.zone.id && !this.inBossRoom(x, y);
      case "fighter":
      case "boss":
        return !!this.zone && zid === this.zone.id;
      case "npcfarm":
        return !!this.camp && Math.hypot(this.camp.x - x, this.camp.y - y) < npcLeashPx(this.camp) + 300;
    }
  }

  private pickZone(): Zone | null {
    const p = this.rt.pub;
    const lo = this.strategy === "boss" ? 1 : Math.max(1, this.minTier);
    const zones = this.m.map.zones.filter((z) => z.tier >= lo && z.tier <= this.maxTier && !this.doneZones.has(z.id));
    if (zones.length === 0) return null;
    const dist = (z: Zone) => Math.hypot(Math.max(z.rect.x - p.x, 0, p.x - z.rect.x - z.rect.w), Math.max(z.rect.y - p.y, 0, p.y - z.rect.y - z.rect.h));
    zones.sort((a, b) => (this.strategy === "boss" ? b.tier - a.tier : 0) || dist(a) - dist(b));
    return zones[0]!;
  }

  /** Body source by the dead runtime's role (pub.role survives death). */
  private bodySource(owner: number): Source {
    const role = this.m.rosterRuntime(owner)?.pub.role ?? 0;
    return role === 0 ? "human_body" : role === 1 ? "boss_body" : "npc_body";
  }

  private sourceOf(x: number, y: number, tier: number, zone: string | null, kind: "container" | "ground"): Source {
    if (kind === "ground") return zone ?? zoneAt(this.m.map, x, y) ? "ground_poi" : "ground_wild";
    return zone === null ? "wild" : (`poi_t${Math.max(1, Math.min(4, tier))}` as Source);
  }

  /**
   * Best loot target for this strategy, or null. With `via` (rat on its way out) only spots that
   * cost at most RAT_DETOUR_PX of detour count, scored by that detour.
   */
  private bestTarget(via?: { x: number; y: number }): Goal | null {
    const p = this.rt.pub;
    const clock = this.m.clock;
    for (const [k, until] of this.blacklist) if (until <= clock) this.blacklist.delete(k);
    let best: Goal | null = null;
    let bestScore = Infinity;
    const ex = this.strategy === "rat" ? (via ?? this.pickExtract()) : null;
    const dme = ex ? Math.hypot(ex.x - p.x, ex.y - p.y) : 0;
    const score = (x: number, y: number, tier: number) => {
      const d = Math.hypot(x - p.x, y - p.y);
      if (via) {
        const detour = d + Math.hypot(via.x - x, via.y - y) - dme;
        return detour <= RAT_DETOUR_PX ? detour : Infinity;
      }
      if (this.strategy === "rat" && ex) return d + 0.5 * (Math.hypot(ex.x - x, ex.y - y) - dme);
      if (this.strategy === "full") return d * (1 - tier * 0.08);
      return d;
    };
    // A full bag only stops poi / boss / fighter / rat searching; "full" keeps opening everything to trade up.
    const full = this.bagFull() && this.strategy !== "full";
    const cs = this.m.map.containers;
    if (!full) {
      for (let idx = 0; idx < cs.length; idx++) {
        const c = cs[idx]!;
        const id = `c${idx}`;
        if (this.searchedKeys.has(id) || this.blacklist.has(id)) continue;
        if (this.m.containers.stateOf(idx) === CONTAINER_STATE.EMPTIED) continue;
        if (!this.allowedAt(c.x, c.y, c.zone)) continue;
        const sc = score(c.x, c.y, c.tier);
        if (sc < bestScore) {
          bestScore = sc;
          best = { kind: "search", id, idx, x: c.x, y: c.y, src: this.sourceOf(c.x, c.y, c.tier, c.zone, "container") };
        }
      }
      const bossIdx = this.bossRt()?.rosterIndex ?? -1;
      for (const t of this.m.containers.corpses()) {
        if (t.emptied || this.searchedKeys.has(t.key) || this.blacklist.has(t.key)) continue;
        if (!this.allowedAt(t.x, t.y)) continue;
        // The hunted boss's body first (that is what the hunt was for).
        const sc = score(t.x, t.y, 2) * (t.owner === bossIdx ? 0.05 : 0.8);
        if (sc < bestScore) {
          bestScore = sc;
          best = { kind: "search", id: t.key, idx: -1, x: t.x, y: t.y, src: this.bodySource(t.owner) };
        }
      }
    }
    for (const g of this.m.ground.near(p.x, p.y, GROUND_SCAN_PX)) {
      const it = g.item;
      const id = g.schema.id;
      if (this.blacklist.has(id) || !this.allowedAt(g.schema.x, g.schema.y)) continue;
      const v = humanValue(it);
      if (v <= 0) continue;
      if (!planPlace(this.rt.self.slots, it).ok && !(this.worstDroppable() && v > this.worstDroppable()!.v * 1.25 + 5)) continue;
      const sc = score(g.schema.x, g.schema.y, 1) * 0.9;
      if (sc < bestScore) {
        bestScore = sc;
        const cat = itemDef(it.def)?.cat;
        best = {
          kind: "item", id, x: g.schema.x, y: g.schema.y, needsInteract: cat !== "ammo" && cat !== "med",
          src: this.sourceOf(g.schema.x, g.schema.y, 0, null, "ground"),
        };
      }
    }
    return best;
  }

  private lootStep(): void {
    const clock = this.m.clock;
    if (this.strategy === "boss" && this.hunting) {
      this.huntStep();
      return;
    }
    if (this.strategy === "npcfarm") {
      this.campStep();
      return;
    }
    if ((this.strategy === "poi" || this.strategy === "boss" || this.strategy === "fighter") && !this.zone) {
      this.zone = this.pickZone();
      if (!this.zone) {
        this.startLeaving("no_targets");
        return;
      }
    }
    const g = this.goal;
    const stale = !g || clock - this.goalSince > 60_000 || !this.goalValid(g);
    if (stale || clock % 1000 < THINK_MS) {
      if (g && clock - this.goalSince > 60_000) this.blacklist.set(g.id, clock + 120_000);
      const next = this.bestTarget();
      if (!next) {
        if (this.zone) {
          this.doneZones.add(this.zone.id);
          this.zone = null;
          this.stop();
          return;
        }
        this.startLeaving(this.bagFull() ? "full" : "no_targets");
        return;
      }
      if (!g || g.id !== next.id) {
        this.goal = next;
        this.goalSince = clock;
        this.stuckFails = 0;
      }
    }
    if (this.goal) this.followTarget(this.goal);
  }

  private goalValid(g: Goal): boolean {
    if (this.blacklist.has(g.id)) return false;
    if (g.kind === "search") {
      if (this.searchedKeys.has(g.id)) return false;
      if (g.idx >= 0) return this.m.containers.stateOf(g.idx) !== CONTAINER_STATE.EMPTIED;
      return !(this.m.containers.targets.get(g.id)?.emptied ?? true);
    }
    if (g.kind === "item") return this.m.ground.byId.has(g.id);
    return true;
  }

  private followTarget(g: Goal): void {
    const p = this.rt.pub;
    const clock = this.m.clock;
    const d = Math.hypot(g.x - p.x, g.y - p.y);
    if (g.kind === "search" && d < SEARCH.OPEN_RANGE * 0.75) {
      this.stop();
      if (this.m.openSearch(this.rt.id, g.id)) {
        this.searchedKeys.add(g.id);
        this.searchSrc = g.src;
        this.sessionTakes = 0;
        if (g.idx >= 0) {
          const c = this.m.map.containers[g.idx]!;
          this.log.searched.push({ idx: g.idx, tier: c.tier, zone: c.zone ?? "wild" });
        } else {
          this.log.corpsesSearched++;
        }
      } else {
        this.blacklist.set(g.id, clock + 30_000);
      }
      if (this.goal === g) this.goal = null;
      return;
    }
    if (g.kind === "item") {
      if (g.needsInteract && d < PLAYER.INTERACT_RADIUS * 0.7) {
        this.stop();
        const ground = this.m.ground.byId.get(g.id);
        const it = ground ? { ...ground.item } : null;
        if (it && !planPlace(this.rt.self.slots, it).ok) this.dropWorst();
        else if (it && this.m.pickupItem(this.rt.id, g.id)) {
          this.fullStall = 0;
          this.noteUnique(g.src, it);
        }
        else this.blacklist.set(g.id, clock + 30_000);
        if (this.goal === g) this.goal = null;
        return;
      }
      if (!g.needsInteract && d < 10) {
        // Auto-pickup did not take it: no room.
        this.blacklist.set(g.id, clock + 30_000);
        if (this.goal === g) this.goal = null;
        return;
      }
    }
    this.navigate(g.x, g.y);
    this.lookAround();
  }

  private noteUnique(src: Source, it: ItemLike): void {
    if (it.uid && itemDef(it.def)?.unique) this.log.uniqueSource.set(it.uid, src);
  }

  /** Sum of humanValue over everything carried. */
  private invValue(): number {
    let v = 0;
    for (const it of this.rt.self.slots.values()) v += humanValue(toPlain(it));
    return v;
  }

  /**
   * Value bookkeeping per decision: a rise of the carried value since the last decision is loot
   * taken from where the player was getting it (the open search, else the ground it walked over —
   * ammo and meds are auto-picked). Drops, shots and heals only lower it and are not counted.
   */
  /** Non-FREE consumables carried: CR-eq, rounds (incl. loaded in non-FREE weapons), meds. */
  private consCarried(): { cr: number; rounds: number; meds: number } {
    const out = { cr: 0, rounds: 0, meds: 0 };
    for (const it of this.rt.self.slots.values()) {
      if (it.flags & ITEM_FLAG.FREE) continue;
      const d = itemDef(it.def);
      if (!d) continue;
      if (d.cat === "ammo") {
        out.rounds += it.qty;
        out.cr += consumableUnitCr(d.id) * it.qty;
      } else if (d.cat === "med" && (d.id === "bandage" || d.id === "medkit")) {
        out.meds += it.qty;
        out.cr += consumableUnitCr(d.id) * it.qty;
      } else if (d.cat === "weapon" && it.mag > 0 && d.weapon) {
        const ammo = weaponDefOf(it)?.ammo;
        const unit = ammo ? consumableUnitCr(`ammo_${ammo}`) : 0;
        out.rounds += it.mag;
        out.cr += unit * it.mag;
      }
    }
    return out;
  }

  private account(): void {
    const c = this.consCarried();
    if (this.lastCons) {
      const dCr = c.cr - this.lastCons.cr + this.droppedCons.cr;
      const dR = c.rounds - this.lastCons.rounds + this.droppedCons.rounds;
      const dM = c.meds - this.lastCons.meds + this.droppedCons.meds;
      if (dCr > 0) this.log.consFoundCr += dCr;
      else this.log.consUsedCr -= dCr;
      if (dR < 0) this.log.roundsUsed -= dR;
      if (dM < 0) this.log.medsUsed -= dM;
    }
    this.lastCons = c;
    this.droppedCons = { cr: 0, rounds: 0, meds: 0 };
    const v = this.invValue();
    if (this.lastInvValue >= 0 && v > this.lastInvValue) {
      this.log.taken[this.lastSource] = (this.log.taken[this.lastSource] ?? 0) + (v - this.lastInvValue);
    }
    this.lastInvValue = v;
    const p = this.rt.pub;
    const cur = this.rt.search ? currentTarget(this.m, this.rt) : undefined;
    this.lastSource = cur
      ? (cur.kind === "corpse" ? this.bodySource(cur.owner) : this.searchSrc)
      : zoneAt(this.m.map, p.x, p.y) ? "ground_poi" : "ground_wild";
  }

  /** One decision of an open search: take the best revealed items, swap junk out when full, close. */
  private stepSearch(): void {
    const rt = this.rt;
    const t = currentTarget(this.m, rt);
    const clock = this.m.clock;
    if (!this.searchSince) this.searchSince = clock;
    if (!t) {
      this.m.searchClose(rt.id);
      return;
    }
    const ready = t.ready.has(rt) && clock >= rt.search!.readyAt;
    const pending = ready ? this.takeRevealed(t) : true;
    const done = ready && t.loot.revealed >= t.loot.total && !pending;
    const budget = Math.min(SEARCH_MAX_MS, t.openMs + SEARCH_BASE_MS + t.loot.total * SEARCH_PER_ITEM_MS);
    if (done || clock - this.searchSince > budget) {
      this.m.searchClose(rt.id);
      this.searchSince = 0;
      if (this.sessionTakes > 0) this.fullStall = 0;
      else if (this.storageFull()) this.fullStall++;
      this.equipBest();
    }
  }

  /** Returns true while something wanted is still revealed (or the rate bucket said wait). */
  private takeRevealed(t: SearchTarget): boolean {
    const items = lootItems(t)
      .filter(({ item }) => !(item.flags & ITEM_FLAG.BROKEN))
      .map((e) => ({ ...e, v: humanValue(e.item) }))
      .filter((e) => e.v > 0)
      .sort((a, b) => b.v - a.v);
    let ops = 0;
    for (const { key, item, v } of items) {
      if (ops >= 3) return true;
      if (planPlace(this.rt.self.slots, item).ok) {
        ops++;
        const code = this.m.invMove(this.rt.id, { from: "loot", key, uid: item.uid, def: item.def });
        if (code === "rate") return true;
        if (code === null) {
          this.sessionTakes++;
          this.noteUnique(t.kind === "corpse" ? this.bodySource(t.owner) : this.searchSrc, item);
        }
        continue;
      }
      const worst = this.worstDroppable();
      if (!worst || v <= worst.v * 1.25 + 5) continue;
      ops++;
      this.noteDrop(worst.item);
      this.m.invDrop(this.rt.id, { key: worst.key, uid: worst.item.uid, def: worst.item.def });
      return true;
    }
    return false;
  }

  /** Cheapest storage item (FREE kit first: it is worth nothing outside). Never a unique for junk. */
  private worstDroppable(): { key: SlotKey; item: ItemLike; v: number } | null {
    const s = this.rt.self.slots;
    let best: { key: SlotKey; item: ItemLike; v: number } | null = null;
    for (const k of storageKeys(s)) {
      const it = s.get(k);
      if (!it || it.flags & ITEM_FLAG.BROKEN) continue;
      const v = humanValue(it);
      if (!best || v < best.v) best = { key: k, item: toPlain(it), v };
    }
    return best;
  }

  private dropWorst(): void {
    const w = this.worstDroppable();
    if (!w) return;
    this.noteDrop(w.item);
    this.m.invDrop(this.rt.id, { key: w.key, uid: w.item.uid, def: w.item.def });
  }

  /** A dropped consumable is not "used" (consumable accounting). */
  private noteDrop(it: ItemLike): void {
    if (it.flags & ITEM_FLAG.FREE) return;
    const d = itemDef(it.def);
    if (d?.cat === "ammo") {
      this.droppedCons.rounds += it.qty;
      this.droppedCons.cr += consumableUnitCr(d.id) * it.qty;
    } else if (d?.cat === "med" && (d.id === "bandage" || d.id === "medkit")) {
      this.droppedCons.meds += it.qty;
      this.droppedCons.cr += consumableUnitCr(d.id) * it.qty;
    }
  }

  // ------------------------------------------------------------------ npc farm

  /**
   * npcfarm: nearest unvisited low-tier camp; walk there (fights happen in think()), loot the
   * bodies / loose items around it, and move on once it swept the camp CAMP_CLEAR_MS without
   * seeing an NPC and nothing is left to take there.
   */
  private campStep(): void {
    const clock = this.m.clock;
    const p = this.rt.pub;
    if (!this.camp) {
      let best: NpcPost | null = null;
      let bd = Infinity;
      for (const c of this.farmCamps) {
        if (this.doneCamps.has(c.id)) continue;
        const d = Math.hypot(c.x - p.x, c.y - p.y);
        if (d < bd) {
          bd = d;
          best = c;
        }
      }
      if (!best) {
        this.startLeaving("no_targets");
        return;
      }
      this.camp = best;
      this.campReachedAt = -1;
      this.goal = null;
    }
    const camp = this.camp;
    if (this.visible().some((o) => o.pub.role !== 0)) this.campLastNpcAt = clock;
    const at = Math.hypot(camp.x - p.x, camp.y - p.y) < CAMP_AT_PX;
    if (at && this.campReachedAt < 0) {
      this.campReachedAt = clock;
      this.campLastNpcAt = clock;
      this.log.camps.visited++;
    }
    if (this.campReachedAt >= 0) {
      const next = this.bestTarget();
      if (next) {
        if (!this.goal || this.goal.id !== next.id) {
          this.goal = next;
          this.goalSince = clock;
        }
        this.followTarget(next);
        return;
      }
      if (clock - this.campLastNpcAt > CAMP_CLEAR_MS) {
        this.log.camps.cleared++;
        this.doneCamps.add(camp.id);
        this.camp = null;
        this.stop();
        return;
      }
      // Sweep the post's patrol points (where its NPCs walk), else hold at the anchor.
      const pts = camp.patrol.length ? camp.patrol : [{ x: camp.x, y: camp.y }];
      const k = Math.floor((clock - this.campReachedAt) / 5000) % pts.length;
      this.navigate(pts[k]!.x, pts[k]!.y);
      this.lookAround();
      return;
    }
    this.navigate(camp.x, camp.y);
    this.lookAround();
  }

  // ------------------------------------------------------------------ boss hunt

  /**
   * Hunt phase of the boss strategy: walk to the BossSpot, then sweep the leash area until the boss
   * is dead (fights happen in think() — anyone seen in reach is engaged). Ends when the boss is
   * dead, never spawned (seen at the spot: nobody there), or after BOSS_HUNT_GIVEUP_MS at the spot.
   */
  private huntStep(): void {
    const spot = this.bossSpot!;
    const clock = this.m.clock;
    const p = this.rt.pub;
    const boss = this.bossRt();
    const atSpot = Math.hypot(spot.x - p.x, spot.y - p.y) < BOSS_SPOT_PX;
    if (atSpot && this.log.boss.reachedAt < 0) this.log.boss.reachedAt = clock;
    let end = "";
    if (boss && !boss.pub.alive) end = "boss_dead";
    else if (!boss && this.log.boss.reachedAt >= 0 && clock - this.log.boss.reachedAt > 20_000) end = "no_boss";
    else if (this.log.boss.reachedAt >= 0 && clock - this.log.boss.reachedAt > BOSS_HUNT_GIVEUP_MS) end = "gave_up";
    if (end) {
      this.hunting = false;
      this.log.boss.huntEnd = end;
      this.log.boss.huntEndAt = clock;
      this.goal = null;
      return;
    }
    // Known boss position when seen (the HUD shows it), else the spot, then sweep the leash ring.
    let tx = spot.x;
    let ty = spot.y;
    if (boss && this.m.vision.sees(this.rt.rosterIndex, boss.rosterIndex)) {
      tx = boss.pub.x;
      ty = boss.pub.y;
    } else if (this.log.boss.reachedAt >= 0) {
      if (!this.sweepAt || clock >= this.sweepUntil || Math.hypot(this.sweepAt.x - p.x, this.sweepAt.y - p.y) < 60) {
        const a = this.rng() * Math.PI * 2;
        const r = 150 + this.rng() * (BOSS_AI.LEASH_BOSS_PX - 150);
        const g = this.m.planner.regions;
        const c = g.cellAt(spot.x + Math.cos(a) * r, spot.y + Math.sin(a) * r, 256);
        this.sweepAt = c >= 0 ? { x: g.cellX(c), y: g.cellY(c) } : { x: spot.x, y: spot.y };
        this.sweepUntil = clock + 8000;
      }
      tx = this.sweepAt.x;
      ty = this.sweepAt.y;
    }
    this.navigate(tx, ty);
    this.lookAround();
  }

  /** Equip a bigger backpack, better armor, or a real weapon over the FREE pistol (one move). */
  private equipBest(): void {
    const rt = this.rt;
    const s = rt.self.slots;
    if (rt.self.reloadUntil > 0 || rt.self.healUntil > 0) return;
    const bp = s.get("bp");
    const bpLevel = bp ? (itemDef(bp.def)?.bpLevel ?? 0) : 0;
    const armor = s.get("armor");
    const armorLevel = armor ? (itemDef(armor.def)?.armorLevel ?? 0) : 0;
    const freeW = (["w1", "w2"] as const).find((k) => !s.get(k) || (s.get(k)!.flags & ITEM_FLAG.FREE) !== 0);
    for (const k of storageKeys(s)) {
      const it = s.get(k);
      if (!it || it.flags & ITEM_FLAG.BROKEN) continue;
      const d = itemDef(it.def);
      let to: SlotKey | null = null;
      if (d?.cat === "backpack" && (d.bpLevel ?? 0) > bpLevel) to = "bp";
      else if (d?.cat === "armor" && (d.armorLevel ?? 0) > armorLevel) to = "armor";
      else if (d?.cat === "weapon" && freeW) to = freeW;
      if (!to) continue;
      if (this.m.invMove(rt.id, { from: "self", key: k, uid: it.uid, def: it.def, to }) === null) return;
    }
  }

  // ------------------------------------------------------------------ combat / fleeing

  private fight(e: PlayerRuntime): void {
    const p = this.rt.pub;
    const clock = this.m.clock;
    if (this.rt.search) this.m.searchClose(this.rt.id);
    const dx = e.pub.x - p.x;
    const dy = e.pub.y - p.y;
    const dist = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx);
    if (clock >= this.aimErrUntil) {
      // A decent human: tighter than a bot (bots: 0.10 + 0.12/1000 px, × sloppiness).
      this.aimErr = (this.rng() * 2 - 1) * (0.05 + (dist / 1000) * 0.06);
      this.aimErrUntil = clock + 200 + this.rng() * 200;
    }
    this.aim = angle + this.aimErr;
    const def = weaponDefOf(activeWeapon(this.rt));
    this.wantFire = !!def && dist <= def.range * 0.95 && this.rt.self.reloadUntil === 0;
    this.burstLong = dist > 250;
    if (this.rt.self.extractId !== "") {
      this.stop();
      return;
    }
    if (clock >= this.strafeUntil) {
      this.strafe = this.rng() < 0.5 ? -1 : 1;
      this.strafeUntil = clock + 500 + this.rng() * 800;
    }
    // Avoiders back off while shooting; fighters strafe at their weapon's comfortable range.
    const radial = this.avoider ? -0.8 : dist < 260 ? -0.6 : def && dist > def.range * 0.7 ? 0.6 : 0;
    const a = Math.atan2(Math.sin(angle) * radial + Math.cos(angle) * this.strafe, Math.cos(angle) * radial - Math.sin(angle) * this.strafe);
    const mv = this.steer(a, 60);
    this.mx = Math.cos(mv);
    this.my = Math.sin(mv);
  }

  private flee(from: Pt): void {
    const p = this.rt.pub;
    const W = this.m.map.width;
    const H = this.m.map.height;
    const away = Math.atan2(p.y - from.y, p.x - from.x);
    const tx = Math.max(300, Math.min(W - 300, p.x + Math.cos(away) * FLEE_PX));
    const ty = Math.max(300, Math.min(H - 300, p.y + Math.sin(away) * FLEE_PX));
    const g = this.m.planner.regions;
    const c = g.cellAt(tx, ty, 512);
    this.navigate(c >= 0 ? g.cellX(c) : tx, c >= 0 ? g.cellY(c) : ty);
    this.aim = Math.atan2(from.y - p.y, from.x - p.x) + (this.rng() - 0.5) * 0.6;
  }

  private lookAround(): void {
    const moving = this.mx !== 0 || this.my !== 0;
    const base = moving ? Math.atan2(this.my, this.mx) : this.aim;
    this.aim = base + (moving ? Math.sin(this.m.clock / 650) * 0.9 : 0.25);
  }

  // ------------------------------------------------------------------ movement (bot-style)

  private stop(): void {
    this.mx = 0;
    this.my = 0;
  }

  private navigate(tx: number, ty: number): void {
    const p = this.rt.pub;
    const clock = this.m.clock;
    const moved = !this.pathFor || Math.hypot(this.pathFor.x - tx, this.pathFor.y - ty) > 80;
    if ((moved && clock >= this.replanMinAt) || clock >= this.replanAt) {
      const r = this.m.planner.request(this.rt.rosterIndex, { x: p.x, y: p.y }, { x: tx, y: ty });
      if (r.status === "ok") {
        this.path = r.path;
        this.pathIdx = 0;
        this.pathFor = { x: tx, y: ty };
        this.replanAt = clock + REPLAN_MS;
        this.replanMinAt = clock + 400;
      } else if (r.status === "pending") {
        if (moved || this.path.length === 0) {
          this.path = [{ x: tx, y: ty }];
          this.pathIdx = 0;
          this.pathFor = { x: tx, y: ty };
        }
        this.replanAt = clock + 150;
        this.replanMinAt = clock + 150;
      } else {
        this.path = [{ x: tx, y: ty }];
        this.pathIdx = 0;
        this.pathFor = { x: tx, y: ty };
        this.replanAt = clock + REPLAN_MS;
        this.replanMinAt = clock + 1000;
        if (this.goal && this.goal.kind !== "extract") {
          this.blacklist.set(this.goal.id, clock + 120_000);
          this.goal = null;
        }
      }
    }
    const end = this.path.length - 1;
    let target = this.pathIdx;
    for (let k = Math.min(end, this.pathIdx + 10); k > this.pathIdx; k--) {
      const q = this.path[k]!;
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < 1 || this.clear(Math.atan2(q.y - p.y, q.x - p.x), d)) {
        target = k;
        break;
      }
    }
    this.pathIdx = target;
    const wp = this.path[target] ?? { x: tx, y: ty };
    const d = Math.hypot(wp.x - p.x, wp.y - p.y);
    if (d < 6) {
      if (target < end) this.pathIdx++;
      else this.stop();
      return;
    }
    let desired = Math.atan2(wp.y - p.y, wp.x - p.x);
    this.watchProgress(tx, ty, desired);
    if (clock < this.detourUntil) desired = this.detourAngle;
    const a = this.steer(desired, Math.min(70, d + 8));
    this.mx = Math.cos(a);
    this.my = Math.sin(a);
  }

  private watchProgress(tx: number, ty: number, desired: number): void {
    const p = this.rt.pub;
    const clock = this.m.clock;
    const d = Math.hypot(tx - p.x, ty - p.y);
    if (!this.progressFor || Math.hypot(this.progressFor.x - tx, this.progressFor.y - ty) > 300) {
      this.progressFor = { x: tx, y: ty };
      this.progressBest = d;
      this.progressAt = clock;
      return;
    }
    if (d < this.progressBest - 150) {
      this.progressBest = d;
      this.progressAt = clock;
      return;
    }
    if (clock - this.progressAt < PROGRESS_MS) return;
    this.progressAt = clock;
    this.progressBest = d;
    this.side = -this.side;
    this.detourAngle = desired + this.side * (1.6 + this.rng());
    this.detourUntil = clock + 1200 + this.rng() * 1000;
    this.replanAt = 0;
    if (++this.stuckFails >= 2 && this.goal && this.goal.kind !== "extract") {
      this.blacklist.set(this.goal.id, clock + 120_000);
      this.goal = null;
      this.stuckFails = 0;
    }
  }

  private steer(desired: number, probe: number): number {
    const deg = Math.PI / 180;
    for (const off of [0, 30, 60, 90, 120, 150]) {
      for (const sign of off === 0 ? [1] : [this.side, -this.side]) {
        const a = desired + sign * off * deg;
        if (this.clear(a, probe)) {
          if (off >= 60) this.side = sign;
          return a;
        }
      }
    }
    return desired + Math.PI;
  }

  private clear(a: number, probe: number): boolean {
    const p = this.rt.pub;
    const cx = Math.cos(a);
    const cy = Math.sin(a);
    const off = PLAYER.RADIUS - 4;
    for (const o of [-off, 0, off]) {
      const sx = p.x - cy * o;
      const sy = p.y + cx * o;
      if (raycastSolids(this.m.idx, sx, sy, sx + cx * probe, sy + cy * probe, SOLID.MOVE) !== Infinity) return false;
    }
    return true;
  }
}

/** Zone rect check helper for reports. */
export function inZoneRect(z: Zone, x: number, y: number): boolean {
  return inRect(z.rect, x, y);
}
