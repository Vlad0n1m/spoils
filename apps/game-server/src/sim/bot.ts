/**
 * Bots drive their player through exactly the same pipeline as humans: they enqueue InputSamples
 * at INPUT_HZ (movement, aim, trigger, roll, walk) and call the same interact / reload / switch /
 * heal / inventory intents a client sends. They get no extra powers:
 *
 * - Sight is the server vision matrix (m.vision.sees), the same cone / range / bush / LOS rules a
 *   human gets, with VISION.BOT_RANGE_CAP. A bot sees nothing behind it unless it turns.
 * - Hearing is the sound system's quantized per-listener delivery (heardBy): sector + distance band
 *   for hidden sources, never coordinates. A bot turns toward what it hears and may walk over to
 *   investigate (sneaking — Shift — on the last stretch).
 * - Hits come with the same quantized "damage from" direction a human's HUD shows; the bot turns
 *   and may roll (same input, same cooldown).
 * - Looting is the real search flow: open → wait the open delay → take revealed items one by one
 *   through INV_MOVE (rate bucket and slot engine included), dropping low-value junk for better
 *   loot when the bag is full, then equipping better weapons / armor / backpacks from storage.
 *
 * Tuned to be beatable: reaction delay, aim error growing with distance and target speed, a slow
 * trigger finger and bursts. For the first BOT_PEACE_MS they only loot (and answer fire). Each bot
 * has a personal extraction time (8–26 min on the Steppe; earlier with a full bag or when hurt
 * without meds, or when the clock runs out) and uses only the extracts its side allows.
 *
 * Roles: ~1/3 of the bots on a map with zones are "scavs": they patrol one POI (leashed to its
 * rect), fight anyone they see inside it, investigate every noise there and leave its containers
 * to the players (they loot bodies and the floor). The rest ("PMCs") roam from POI to POI.
 *
 * Cost (perf memo): paths come from the region PathPlanner (2 ms/tick budget, windowed routes);
 * decisions run at 10 Hz near humans or in contact and at 2 Hz otherwise (LOD), while steering
 * along the current path stays at 10 Hz so LOD never makes a bot walk into walls.
 */

import {
  AMMO,
  CONTAINER_STATE,
  HEAL,
  INPUT_DT_MS,
  ITEM_FLAG,
  MATCH,
  PLAYER,
  SEARCH,
  SOLID,
  SOUND,
  SoundKind,
  VISION,
  WEAPONS,
  armorIsUpgrade,
  bandMid,
  baseSoundRadius,
  bpLevelOf,
  dogTagCr,
  itemDef,
  planPlace,
  quantizeFa,
  raycastSolids,
  sectorAngle,
  storageKeys,
  weaponVariant,
  type Band,
  type InvItem,
  type ItemLike,
  type Rect,
  type SlotKey,
  type WeaponId,
} from "@extract/shared";
import { activeWeapon, ammoCount, medCount, weaponDefOf } from "./bag.js";
import { currentTarget, lootItems, type SearchTarget } from "./containers.js";
import { envNow } from "./environment.js";
import { extractAllowed, extractIsOpen } from "./extraction.js";
import type { GroundRt } from "./inventory.js";
import { toPlain } from "./items.js";
import type { Match } from "./match.js";
import type { Pt } from "./nav.js";
import { heardBy } from "./sound.js";
import type { PlayerRuntime } from "./types.js";

/** Opening window: bots loot and do not start fights (they still answer an attacker). */
export const BOT_PEACE_MS = 30_000;
/** During the peace window a bot shoots back only at someone who hit it this recently. */
export const BOT_RETALIATE_MS = 3_000;
/** Bot sight range (the vision system caps bot rows here; LOS, cone and bushes as for humans). */
export const BOT_VIEW_RANGE = VISION.BOT_RANGE_CAP;
/** Decision LOD: with no human within this range (and nothing going on) a bot decides at 2 Hz. */
export const BOT_LOD_RANGE = 3000;
export const BOT_THINK_MS = 100;
export const BOT_LOD_THINK_MS = 500;
/** Chance to roll when hit (× skill), mobility memo. Rolls obey the player cooldown. */
export const BOT_ROLL_ON_HIT = 0.35;
/** Chance to roll when a hidden gunshot cracks right next to the bot (× skill). */
const BOT_ROLL_ON_BURST = 0.2;
/** Share of bots that play the scav role on maps with zones (every 3rd bot). */
export const BOT_SCAV_EVERY = 3;

/** Reaction delay to a newly seen enemy. */
const REACT_MIN_MS = 450;
const REACT_MAX_MS = 800;
/** Aim error half-width: base + per 1000 px of distance + extra for a target moving at full speed. */
const AIM_ERR_BASE = 0.1;
const AIM_ERR_PER_1000PX = 0.12;
const AIM_ERR_MOVING = 0.1;
/** Semi-auto bots never press faster than this, whatever the weapon allows. */
const MIN_PRESS_INTERVAL_MS = 420;

/** Each bot heads for extraction somewhere in this window (legacy 4800 px map, v1 tuning). */
const EXTRACT_AFTER_MIN_MS = 150_000;
const EXTRACT_AFTER_MAX_MS = 330_000;
/**
 * On a big map (the 24,576 px Steppe, 30-minute raid) bots stay 8–26 minutes so the map is alive
 * for the whole raid. The legacy 4800 px map keeps the v1 window (its whole-match tests are tuned
 * to it).
 */
const BIG_MAP_PX = 8000;
export const EXTRACT_AFTER_BIG_MIN_MS = 8 * 60_000;
export const EXTRACT_AFTER_BIG_MAX_MS = 26 * 60_000;
/**
 * A full bag worth max(FULL_BAG_VALUE, per slot × slots) brings the personal timer forward by up to
 * FULL_BAG_EARLY_MS, but never before the window's start (big map).
 */
const FULL_BAG_EARLY_MS = 10 * 60_000;
const FULL_BAG_VALUE = 800;
const FULL_BAG_VALUE_PER_SLOT = 200;
/** Time-pressure margin on top of the walk to the nearest allowed extract and the channel. */
const LAST_CALL_MARGIN_MS = 45_000;

/** Search session budget: open delay + this per item + base, capped. */
const SEARCH_BASE_MS = 2500;
const SEARCH_PER_ITEM_MS = 700;
const SEARCH_MAX_MS = 16_000;
/** A target a bot already searched is skipped for this long (it took what it wanted). */
const SEARCHED_BLACKLIST_MS = 600_000;
/** At most this many inventory ops per decision (the server's rate bucket also applies). */
const OPS_PER_THINK = 3;

/** Least aggressive bots start fights only this close. */
const PICK_FIGHT_MIN = 300;
/** A bot on its way out only starts a fight this close. */
const PICK_FIGHT_EXTRACTING = 300;
/** The most aggressive bots start fights this far. */
const PICK_FIGHT_MAX = 700;
/** A wary bot keeps loot goals at least this far from players it can see. */
const PERSONAL_SPACE_PX = 500;
/** A wary bot that sees someone this close steps aside. */
const GIVE_WAY_PX = 300;
/** Big map: PMC fight-picking reach ramps up over this long after the peace window. */
const OPENING_RAMP_MS = 4 * 60_000;
const OPENING_RAMP_FROM = 0.2;

const GOAL_REEVAL_MS = 1200;
const GOAL_TIMEOUT_MS = 20_000;
const GOAL_TIMEOUT_BIG_MS = 45_000;
/** Crossing the map and channeling takes longer than a loot run. */
const EXTRACT_GOAL_TIMEOUT_MS = 75_000;
const EXTRACT_GOAL_TIMEOUT_BIG_MS = 240_000;
const LOOT_RANGE = 1800;
const HEAL_BELOW_HP = 55;
const FLEE_BELOW_HP = 35;
/** Investigating: walk (Shift) for the last stretch, and give up after reaching the spot. */
const SNEAK_RANGE = 650;
const INVESTIGATE_DONE_PX = 110;
/** Scav leash around its zone rect. */
const SCAV_LEASH_PX = 700;
/** Path refresh: periodic, and early when the end of a partial (windowed) route is near. */
const REPLAN_MS = 3000;
const WINDOW_REFRESH_PX = 600;
/** No 200 px of progress toward the navigation target in this long = stuck. */
const PROGRESS_MS = 12_000;

/** Base value of each weapon for "is this an upgrade" decisions. */
const WEAPON_VALUE: Record<WeaponId, number> = { pistol: 1, shotgun: 2.4, sniper: 2.2, rifle: 3 };

/** How interesting a heard sound kind is (0 = ignored). */
const HEAR_PRIO: Readonly<Record<SoundKind, number>> = {
  [SoundKind.step]: 2,
  [SoundKind.stepBush]: 2,
  [SoundKind.roll]: 2,
  [SoundKind.shot]: 4,
  [SoundKind.reload]: 1,
  [SoundKind.heal]: 1,
  [SoundKind.loot]: 2,
  [SoundKind.search]: 2,
  [SoundKind.extract]: 1,
  [SoundKind.hurt]: 3,
  [SoundKind.death]: 3,
  [SoundKind.bodyFall]: 2,
  [SoundKind.dryFire]: 1,
  [SoundKind.switch]: 1,
};

/** Shot sound variant of the shotgun (a blast next to the bot is a "burst"). */
const SHOTGUN_VARIANT = weaponVariant("shotgun");

/** Combat sounds (investigated from farther away than footsteps). */
function isCombatSound(k: SoundKind): boolean {
  return k === SoundKind.shot || k === SoundKind.hurt || k === SoundKind.death || k === SoundKind.bodyFall;
}

export type BotRole = "pmc" | "scav";

type Goal =
  /** A static container (idx ≥ 0) or a corpse (idx −1); id = its loot key c<idx> / k<id>. */
  | { kind: "search"; id: string; idx: number; x: number; y: number }
  | { kind: "item"; id: string; x: number; y: number; needsInteract: boolean }
  | { kind: "extract"; id: string; x: number; y: number; r: number }
  | { kind: "wander"; id: string; x: number; y: number };

/** What a bot made of one heard sound: an estimated source position. */
interface HeardNote {
  kind: SoundKind;
  prio: number;
  angle: number;
  band: Band;
  dist: number;
  x: number;
  y: number;
  at: number;
}

/** Bot-side value of a weapon instance for "is this an upgrade" decisions. */
function weaponValue(it: { def: string; rarity: number } | undefined): number {
  const w = it ? itemDef(it.def)?.weapon : undefined;
  return w ? WEAPON_VALUE[w] * (1 + 0.12 * it!.rarity) : 0;
}

function inRect(r: Rect, x: number, y: number, pad = 0): boolean {
  return x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad;
}

export class BotBrain {
  private seq = 0;
  private inputAcc = 0;
  private thinkAcc = BOT_THINK_MS;
  private nextDecideAt = 0;
  private thinkCount = 0;
  private lodNow = false;
  private gone = false;

  private mx = 0;
  private my = 0;
  private aim = 0;
  private walk = false;
  private wantFire = false;
  private lastFire = false;
  private nextPressAt = 0;
  private burstUntil = 0;
  private pauseUntil = 0;

  private rollSamples = 0;
  private rollDx = 0;
  private rollDy = 0;
  private hitSeenAt = -Infinity;
  private lookAngle = 0;
  private lookUntil = 0;
  private sneakUntil = 0;
  private scanAt = 0;

  private goal: Goal | null = null;
  private goalSince = 0;
  private goalEvalAt = 0;
  private readonly blacklist = new Map<string, number>();
  private path: Pt[] = [];
  private pathIdx = 0;
  private pathFor: Pt | null = null;
  private pathComplete = true;
  private replanAt = 0;
  private replanMinAt = 0;
  private unreachable = 0;

  private heard: HeardNote | null = null;
  private investigate: { x: number; y: number; until: number; prio: number } | null = null;

  private enemyId = "";
  private enemySeen: { x: number; y: number; at: number } | null = null;
  private lastEnemyAt = -Infinity;
  private enemySpeed = 0;
  private reactAt = 0;
  private aimErr = 0;
  private aimErrUntil = 0;
  private strafe = 1;
  private strafeUntil = 0;
  private switchAt = 0;
  private equipAt = 0;

  private side = 1;
  private stuckAt = 0;
  private stuckPos: Pt = { x: 0, y: 0 };
  private stuckCount = 0;
  private detourUntil = 0;
  private detourAngle = 0;
  private wantMove = false;
  /** Progress watchdog: closest distance to the navigation target so far, and when it improved. */
  private progressFor: Pt | null = null;
  private progressBest = Infinity;
  private progressAt = 0;

  /** Give way: walk to this point until avoidUntil (a wary bot stepping aside from someone). */
  private avoid: Pt | null = null;
  private avoidUntil = 0;
  /** Positions of the other players this bot sees right now (refreshed per decision). */
  private seen: Pt[] = [];
  /** Cached per decision: carried value and whether every storage slot is taken. */
  private carriedValue = 0;
  private bagFull = false;

  /** Per-bot skill: < 1 is sharper. Scales aim error (and inversely the roll chance). */
  private readonly sloppiness: number;
  /** Match clock after which this bot wants out. */
  readonly extractAt: number;
  /** Match clock when the current search session was first seen (0 = none). */
  private searchSince = 0;
  /** How far away this bot starts a fight on its own (attackers are answered at any visible range). */
  private pickFightRange: number;
  /** 0.4–1: how readily this bot walks over to check a noise. */
  private curiosity: number;
  readonly role: BotRole;
  /** Scav home zone (null for PMCs and on maps without zones). */
  readonly home: { id: string; rect: Rect } | null;
  /** Probability per hit of a dodge roll (tests may set it to 0 / 1). */
  rollChance: number;
  private readonly big: boolean;

  constructor(private readonly m: Match, readonly rt: PlayerRuntime) {
    this.sloppiness = 0.85 + m.rng() * 0.4;
    this.big = m.map.width > BIG_MAP_PX;
    // The n-th bot of the match (bots are pushed right after construction).
    const nth = m.bots.length;
    const zones = m.map.zones.filter((z) => z.tier >= 1);
    this.role = zones.length > 0 && nth % BOT_SCAV_EVERY === BOT_SCAV_EVERY - 1 ? "scav" : "pmc";
    this.home = null;
    if (this.role === "scav") {
      // Home POI: better tiers and closer zones are likelier (scavs spread over the map).
      const p = rt.pub;
      const w = zones.map((z) => (1 + z.tier) / (1 + Math.hypot(z.rect.x + z.rect.w / 2 - p.x, z.rect.y + z.rect.h / 2 - p.y) / 6000));
      let r = m.rng() * w.reduce((a, b) => a + b, 0);
      let k = 0;
      while (k < zones.length - 1 && r >= w[k]!) r -= w[k++]!;
      this.home = { id: zones[k]!.id, rect: zones[k]!.rect };
    }
    const lo = this.big ? EXTRACT_AFTER_BIG_MIN_MS : EXTRACT_AFTER_MIN_MS;
    const hi = this.big ? EXTRACT_AFTER_BIG_MAX_MS : EXTRACT_AFTER_MAX_MS;
    // Scavs hold their POI: they lean to the later half of the window.
    const u = m.rng();
    this.extractAt = lo + (this.role === "scav" ? 0.35 + 0.65 * u : u) * (hi - lo);
    this.pickFightRange = PICK_FIGHT_MIN + m.rng() * (PICK_FIGHT_MAX - PICK_FIGHT_MIN);
    this.curiosity = 0.4 + m.rng() * 0.6;
    this.rollChance = Math.min(0.6, BOT_ROLL_ON_HIT / this.sloppiness);
  }

  /**
   * Called once per server step with its dt. Input accumulator (mobility memo, mandatory): a bot
   * enqueues floor(acc / INPUT_DT_MS) samples per step and carries the remainder, so it produces
   * exactly INPUT_HZ samples per second of match time like a real client — one sample per 50 ms
   * step would run bot movement, rolls and roll cooldowns at 2/3 speed.
   */
  update(dtMs: number): void {
    const p = this.rt.pub;
    if (!p.alive) {
      if (!this.gone) {
        this.gone = true;
        this.m.planner.forget(this.rt.rosterIndex);
      }
      return;
    }
    // Every step (cheap): what was heard in the last delivery, and whether we were just hit.
    const heardUrgent = this.listen();
    const hit = this.checkHit();
    const urgent = heardUrgent || hit;
    this.thinkAcc += dtMs;
    if (this.thinkAcc >= BOT_THINK_MS) {
      this.thinkAcc = 0;
      if (this.lodNow && !urgent && this.m.clock < this.nextDecideAt) {
        this.move();
      } else {
        this.thinkCount++;
        this.think();
        this.lodNow = this.computeLod();
        this.nextDecideAt = this.m.clock + (this.lodNow ? BOT_LOD_THINK_MS : BOT_THINK_MS);
      }
    }
    this.inputAcc += dtMs;
    const n = Math.floor((this.inputAcc + 1e-6) / INPUT_DT_MS);
    this.inputAcc = Math.max(0, this.inputAcc - n * INPUT_DT_MS);
    for (let i = 0; i < n; i++) this.emitInput();
  }

  /** Pin the per-bot random traits (tests, debug tools). */
  tune(t: { curiosity?: number; pickFightRange?: number; rollChance?: number }): void {
    if (t.curiosity !== undefined) this.curiosity = t.curiosity;
    if (t.pickFightRange !== undefined) this.pickFightRange = t.pickFightRange;
    if (t.rollChance !== undefined) this.rollChance = t.rollChance;
  }

  /** Samples enqueued so far (tests: INPUT_HZ per second). */
  get samples(): number {
    return this.seq;
  }

  /** Full decisions taken so far (tests: LOD). */
  get thinks(): number {
    return this.thinkCount;
  }

  /** Deciding at the reduced LOD rate right now. */
  get lod(): boolean {
    return this.lodNow;
  }

  /** Current investigate point (tests / debug), or null. */
  get investigating(): Pt | null {
    return this.investigate ? { x: this.investigate.x, y: this.investigate.y } : null;
  }

  /** Current goal kind (tests / debug). */
  get goalKind(): Goal["kind"] | "" {
    return this.goal?.kind ?? "";
  }

  private emitInput(): void {
    let fire = false;
    let roll = false;
    let mx = this.mx;
    let my = this.my;
    if (this.rollSamples > 0) {
      // Repeat roll:true on a few samples like the client's input buffer; the server starts it
      // only when its cooldown allows (same rule as a player's Space).
      if (this.rt.self.rollLeft > 0) {
        this.rollSamples = 0;
      } else {
        roll = true;
        mx = this.rollDx;
        my = this.rollDy;
        this.rollSamples--;
      }
    }
    const def = weaponDefOf(activeWeapon(this.rt));
    if (this.wantFire && def && !roll) {
      const clock = this.m.clock;
      if (def.auto) {
        // Bursts instead of a perfect laser: hold 0.25–0.5 s, pause 0.4–0.8 s.
        if (clock >= this.pauseUntil && clock < this.burstUntil) fire = true;
        else if (clock >= this.burstUntil && clock >= this.pauseUntil) {
          this.burstUntil = clock + this.rand(250, 500);
          this.pauseUntil = this.burstUntil + this.rand(400, 800);
          fire = true;
        }
      } else if (!this.lastFire && clock >= this.nextPressAt) {
        fire = true;
        this.nextPressAt = clock + Math.max(def.fireIntervalMs, MIN_PRESS_INTERVAL_MS) + this.rand(40, 220) * this.sloppiness;
      }
    }
    this.lastFire = fire;
    this.m.enqueueInput(this.rt.id, { seq: ++this.seq, mx, my, aim: this.aim, fire, roll, walk: this.walk && !roll && !fire });
  }

  // ------------------------------------------------------------------ senses

  private canSee(o: PlayerRuntime): boolean {
    return o.pub.alive && this.m.vision.sees(this.rt.rosterIndex, o.rosterIndex);
  }

  /**
   * Read the last sound delivery (sound.ts heardBy). Hidden entries carry only a sector and a
   * distance band: the bot estimates the source at bandMid × the kind's radius (× env.hear, an
   * occluded source is closer than it sounds). Keeps the most interesting note until the next
   * decision. Returns true when something urgent was heard (a shot or a death nearby).
   */
  private listen(): boolean {
    const list = heardBy(this.m, this.rt.rosterIndex);
    if (list.length === 0) return false;
    const p = this.rt.pub;
    const hear = envNow(this.m).hear;
    const clock = this.m.clock;
    let urgent = false;
    for (const s of list) {
      if (!s.hidden) {
        // Seen sources are handled by sight; a visible shotgun blast right next to us is a burst.
        if (s.kind === SoundKind.shot && s.variant === SHOTGUN_VARIANT) {
          const src = this.m.runtime(s.id);
          if (src && Math.hypot(src.pub.x - p.x, src.pub.y - p.y) < 300) {
            this.tryRoll(Math.atan2(src.pub.y - p.y, src.pub.x - p.x), BOT_ROLL_ON_BURST / this.sloppiness);
          }
        }
        continue;
      }
      const prio = HEAR_PRIO[s.kind] ?? 0;
      if (prio <= 0) continue;
      const R = baseSoundRadius(s.kind, s.variant) * hear;
      const dist = (bandMid(s.b) * R) / (s.occluded ? SOUND.OCCLUSION_MULT : 1);
      const angle = sectorAngle(s.a);
      const note: HeardNote = {
        kind: s.kind, prio, angle, band: s.b, dist,
        x: p.x + Math.cos(angle) * dist, y: p.y + Math.sin(angle) * dist, at: clock,
      };
      const h = this.heard;
      if (!h || prio > h.prio || (prio === h.prio && dist < h.dist)) this.heard = note;
      if (prio >= 3 && s.b === 0) urgent = true;
      // A gunshot cracking right next to us from someone we cannot see: dive for cover.
      if (s.kind === SoundKind.shot && s.b === 0) this.tryRoll(angle, BOT_ROLL_ON_BURST / this.sloppiness);
    }
    return urgent;
  }

  /**
   * New damage since the last check: turn toward where it came from (the same quantized direction
   * a human's damage arc shows) and maybe roll. Returns true when there was a new hit.
   */
  private checkHit(): boolean {
    const rt = this.rt;
    if (!(rt.lastHitAt > this.hitSeenAt)) return false;
    this.hitSeenAt = rt.lastHitAt;
    const by = rt.lastHitBy;
    if (!by) return true;
    const p = rt.pub;
    const a = quantizeFa(Math.atan2(by.pub.y - p.y, by.pub.x - p.x));
    this.look(a, 1500);
    if (this.m.clock - rt.lastHitAt <= 300) this.tryRoll(a, this.rollChance);
    return true;
  }

  /**
   * Dodge roll perpendicular to a threat at `threat` (radians), when the roll is off cooldown (the
   * bot reads its own SelfState like a player reads the HUD pie) and the dice say so.
   */
  private tryRoll(threat: number, chance: number): void {
    const s = this.rt.self;
    if (s.rollCd > 0 || s.rollLeft > 0 || this.rollSamples > 0) return;
    // Leaving an extraction circle would reset the channel.
    if (s.extractId !== "") return;
    if (this.m.rng() >= chance) return;
    const first = this.m.rng() < 0.5 ? 1 : -1;
    for (const sign of [first, -first]) {
      // Sideways and a little away from the threat.
      const a = threat + sign * (Math.PI / 2 + 0.3);
      if (this.clear(a, 140)) {
        this.rollDx = Math.cos(a);
        this.rollDy = Math.sin(a);
        this.rollSamples = 3;
        return;
      }
    }
  }

  private look(angle: number, ms: number): void {
    this.lookAngle = angle;
    this.lookUntil = this.m.clock + ms;
  }

  /** Decide at the LOD rate: nobody human nearby and nothing going on around this bot. */
  private computeLod(): boolean {
    const clock = this.m.clock;
    if (this.enemyId !== "" || clock - this.lastEnemyAt < 5000 || clock - this.rt.lastHitAt < 5000) return false;
    if (this.rt.search || this.rt.self.extractId !== "" || this.investigate) return false;
    const p = this.rt.pub;
    const r2 = BOT_LOD_RANGE * BOT_LOD_RANGE;
    for (const o of this.m.allRuntimes()) {
      if (o.isBot || !o.pub.alive) continue;
      if ((o.pub.x - p.x) ** 2 + (o.pub.y - p.y) ** 2 <= r2) return false;
    }
    return true;
  }

  // ------------------------------------------------------------------ decisions

  /** Weapon in a weapon slot (w1 / w2). */
  private weaponAt(key: "w1" | "w2"): InvItem | undefined {
    const it = this.rt.self.slots.get(key);
    return it && itemDef(it.def)?.weapon ? it : undefined;
  }

  private rounds(it: InvItem | undefined): number {
    const def = weaponDefOf(it);
    return it && def ? it.mag + ammoCount(this.rt, def.ammo) : 0;
  }

  private armed(): boolean {
    return (["w1", "w2"] as const).some((k) => this.rounds(this.weaponAt(k)) > 0);
  }

  private think(): void {
    const p = this.rt.pub;
    const s = this.rt.self;
    const clock = this.m.clock;
    this.walk = false;
    this.updateBag();
    this.seen.length = 0;
    for (const j of this.m.vision.row(this.rt.rosterIndex)) {
      const o = this.m.rosterRuntime(j);
      if (o?.pub.alive) this.seen.push({ x: o.pub.x, y: o.pub.y });
    }
    const enemy = this.findEnemy();
    this.manageWeapons(enemy);
    this.wantFire = false;

    // Out of ammo entirely: no point standing in a gunfight — keep looting (ammo is wanted most).
    if (enemy && this.armed()) {
      this.fight(enemy);
      return;
    }
    if (this.enemyId !== "") {
      // Lost sight of the enemy mid-fight: check its last known position (it was seen there).
      const lost = this.m.runtime(this.enemyId);
      const seen = this.enemySeen;
      if (lost?.pub.alive && seen && clock >= BOT_PEACE_MS && p.hp >= 50 && this.goal?.kind !== "extract") {
        this.investigate = { x: seen.x, y: seen.y, until: clock + 8000, prio: 5 };
      }
      this.enemyId = "";
      this.enemySeen = null;
    }

    // Searching a container / corpse (search session): stand, take what is worth it, close.
    if (this.rt.search) {
      this.processHeard();
      this.stepSearch();
      return;
    }
    this.searchSince = 0;

    const calm = clock - this.lastEnemyAt > 2500 && clock - this.rt.lastHitAt > 2000;
    if (calm && p.hp < HEAL_BELOW_HP && s.healUntil === 0 && s.reloadUntil === 0) {
      const medkits = medCount(this.rt, "medkit");
      const kind = (p.hp <= 40 && medkits > 0) || medCount(this.rt, "bandage") === 0 ? "medkit" : "bandage";
      this.m.heal(this.rt.id, kind);
    }
    const w = activeWeapon(this.rt);
    const def = weaponDefOf(w);
    if (w && def && s.reloadUntil === 0 && s.healUntil === 0) {
      if (w.mag < def.magSize * 0.4 && ammoCount(this.rt, def.ammo) > 0) this.m.reload(this.rt.id);
    }
    if (calm && clock >= this.equipAt) {
      this.equipAt = clock + 2000;
      this.equipBest();
    }

    this.processHeard();
    this.updateGoal();
    if (this.giveWay()) return;
    if (this.investigate && this.goal?.kind !== "extract") {
      this.followInvestigate();
      return;
    }
    this.followGoal(true);
  }

  /**
   * A wary bot that sees someone close steps aside (away and to the side of them) for a moment
   * instead of walking shoulder to shoulder into the same POI. Returns true while giving way.
   */
  private giveWay(): boolean {
    const p = this.rt.pub;
    const clock = this.m.clock;
    if (clock >= this.avoidUntil) this.avoid = null;
    if (!this.avoid && this.seen.length > 0 && this.goal?.kind !== "extract" && this.wary()) {
      let near: Pt | null = null;
      let nd = GIVE_WAY_PX;
      for (const o of this.seen) {
        const d = Math.hypot(o.x - p.x, o.y - p.y);
        if (d < nd) { nd = d; near = o; }
      }
      if (near) {
        const away = Math.atan2(p.y - near.y, p.x - near.x) + (this.m.rng() < 0.5 ? -0.6 : 0.6);
        const W = this.m.map.width;
        const H = this.m.map.height;
        this.avoid = {
          x: Math.max(200, Math.min(W - 200, p.x + Math.cos(away) * 450)),
          y: Math.max(200, Math.min(H - 200, p.y + Math.sin(away) * 450)),
        };
        this.avoidUntil = clock + 2500;
      }
    }
    if (!this.avoid) return false;
    this.navigate(this.avoid.x, this.avoid.y);
    this.aim = Math.atan2(this.my, this.mx);
    return true;
  }

  /** Between LOD decisions: keep walking the current route (no scans, no new decisions). */
  private move(): void {
    if (this.rt.search) {
      this.stop();
      return;
    }
    if (this.avoid && this.m.clock < this.avoidUntil) {
      this.navigate(this.avoid.x, this.avoid.y);
      return;
    }
    if (this.investigate && this.goal?.kind !== "extract") {
      this.followInvestigate();
      return;
    }
    this.followGoal(false);
  }

  /** Turn toward the best sound heard since the last decision; maybe go and look. */
  private processHeard(): void {
    const h = this.heard;
    this.heard = null;
    if (!h) return;
    const clock = this.m.clock;
    if (clock - h.at > 2000) return;
    if (h.prio >= 2 || h.dist < 450) this.look(h.angle + this.rand(-0.15, 0.15), 1600);
    if (!isCombatSound(h.kind) && h.dist < SNEAK_RANGE) this.sneakUntil = clock + 4000;
    if (this.rt.search || !this.mayInvestigate(h)) return;
    const cur = this.investigate;
    if (cur && clock < cur.until && cur.prio > h.prio) return;
    const W = this.m.map.width;
    const H = this.m.map.height;
    this.investigate = {
      x: Math.max(200, Math.min(W - 200, h.x)),
      y: Math.max(200, Math.min(H - 200, h.y)),
      until: clock + Math.min(30_000, (h.dist / (PLAYER.SPEED * 0.6)) * 1000 + 4000),
      prio: h.prio,
    };
  }

  private mayInvestigate(h: HeardNote): boolean {
    if (this.m.clock < BOT_PEACE_MS) return false;
    if (this.goal?.kind === "extract" || this.shouldExtract()) return false;
    if (this.rt.pub.hp < 50 || !this.armed()) return false;
    if (this.home) return h.prio >= 2 && inRect(this.home.rect, h.x, h.y, SCAV_LEASH_PX);
    // Opening (wary) PMCs do not walk into other people's gunfights.
    if (this.wary() || this.m.rng() > this.curiosity) return false;
    if (isCombatSound(h.kind)) return h.dist <= this.pickFightRange * 2;
    return h.prio >= 2 && h.dist <= 900;
  }

  /** Walk to the investigate point, sneaking on the last stretch and looking at it. */
  private followInvestigate(): void {
    const inv = this.investigate!;
    const p = this.rt.pub;
    const clock = this.m.clock;
    const d = Math.hypot(inv.x - p.x, inv.y - p.y);
    if (d < INVESTIGATE_DONE_PX || clock > inv.until) {
      this.investigate = null;
      // Nothing here: check behind.
      this.look(this.aim + Math.PI, 900);
      this.stop();
      return;
    }
    this.walk = d < SNEAK_RANGE;
    this.navigate(inv.x, inv.y);
    this.aim = clock < this.lookUntil ? this.lookAngle : Math.atan2(inv.y - p.y, inv.x - p.x);
  }

  /** Walk toward the current goal; `act` = also interact / face the way (false while fighting / LOD). */
  private followGoal(act = false): void {
    const p = this.rt.pub;
    const g = this.goal;
    const clock = this.m.clock;
    if (!g) {
      this.stop();
      // Idle: look around now and then (the vision cone only covers the front).
      if (clock >= this.scanAt) {
        this.scanAt = clock + this.rand(1500, 3000);
        this.aim += this.rand(-2, 2);
      }
      return;
    }
    const d = Math.hypot(g.x - p.x, g.y - p.y);
    if (g.kind === "extract") {
      if (d < g.r * 0.4) this.stop();
      else this.navigate(g.x, g.y);
      if (act) this.aim = clock < this.lookUntil ? this.lookAngle : Math.atan2(g.y - p.y, g.x - p.x);
      return;
    }
    const reach = g.kind === "search" ? SEARCH.OPEN_RANGE * 0.75 : PLAYER.INTERACT_RADIUS * 0.7;
    if ((g.kind === "search" || (g.kind === "item" && g.needsInteract)) && d < reach) {
      this.stop();
      if (!act) return;
      // Targeted intents: the generic F (Match.interact) would open a container next to the item,
      // or pick up whatever lies nearest when the goal container is out of sight.
      if (g.kind === "item") {
        this.prepareSlotForPickup();
        this.m.pickupItem(this.rt.id, g.id);
      } else {
        this.m.openSearch(this.rt.id, g.id);
      }
      // Opened (the session blacklists it on close), picked up, or out of reach: do not retry soon.
      this.blacklist.set(g.id, clock + 30_000);
      this.goal = null;
      return;
    }
    if (g.kind === "item" && !g.needsInteract && d < 8) {
      // Standing on it and it is still there: we are at the carry cap.
      this.blacklist.set(g.id, clock + 30_000);
      this.goal = null;
      return;
    }
    if (g.kind === "wander" && d < 80) {
      this.goal = null;
      return;
    }
    // Sneak toward loot when someone was heard close by (scavs at home stay loud: it is their turf).
    this.walk = act && clock < this.sneakUntil && !this.home && d < 900;
    this.navigate(g.x, g.y);
    this.aim = clock < this.lookUntil ? this.lookAngle : Math.atan2(this.my, this.mx);
  }

  // ------------------------------------------------------------------ looting

  /**
   * One decision of an open search session: wait for the open delay, take revealed items worth
   * having (best first, through the same INV_MOVE path as a client), swap out junk when full, and
   * close once everything is revealed and nothing wanted is left — or the session ran too long.
   */
  private stepSearch(): void {
    this.stop();
    const rt = this.rt;
    const search = rt.search!;
    const t = currentTarget(this.m, rt);
    const clock = this.m.clock;
    if (clock < this.lookUntil) this.aim = this.lookAngle;
    if (!this.searchSince) this.searchSince = clock;
    const budget = t ? Math.min(SEARCH_MAX_MS, t.openMs + SEARCH_BASE_MS + t.loot.total * SEARCH_PER_ITEM_MS) : 0;
    let pending = false;
    const ready = !!t && t.ready.has(rt) && clock >= search.readyAt;
    if (ready) pending = this.takeRevealed(t);
    const done = ready && t.loot.revealed >= t.loot.total && !pending;
    const tooLong = clock - this.searchSince > budget;
    if (!t || done || tooLong || this.lastCall()) {
      // Search keys are c<idx> / k<corpse>, the same ids search goals use.
      this.blacklist.set(search.key, clock + SEARCHED_BLACKLIST_MS);
      this.m.searchClose(rt.id);
      this.searchSince = 0;
      this.updateBag();
      this.equipBest();
    }
  }

  /** Take revealed slots, most valuable first. Returns true while something wanted is left. */
  private takeRevealed(t: SearchTarget): boolean {
    const items = lootItems(t)
      .filter(({ item }) => !(item.flags & ITEM_FLAG.BROKEN))
      .map((e) => ({ ...e, v: this.lootValue(e.item) }))
      .filter((e) => e.v > 0)
      .sort((a, b) => b.v - a.v);
    let ops = 0;
    for (const { key, item, v } of items) {
      if (ops >= OPS_PER_THINK) return true;
      const plan = planPlace(this.rt.self.slots, item);
      if (plan.ok) {
        ops++;
        if (this.m.invMove(this.rt.id, { from: "loot", key, uid: item.uid, def: item.def }) === "rate") return true;
        continue;
      }
      // Full: drop the cheapest droppable thing if this is clearly better (one swap per decision).
      const worst = this.worstDroppable();
      if (!worst || v <= worst.v * 1.3 + 20) continue;
      ops++;
      this.m.invDrop(this.rt.id, { key: worst.key, uid: worst.item.uid, def: worst.item.def });
      return true;
    }
    return false;
  }

  /**
   * Rough CR-ish value of an item for this bot right now: junk at its sale price, equipment as an
   * upgrade (big) or as loot, ammo it can shoot (a lot when low), meds by need. FREE kit is 0.
   */
  private lootValue(it: ItemLike): number {
    const d = itemDef(it.def);
    if (!d || it.flags & ITEM_FLAG.FREE) return 0;
    const s = this.rt.self.slots;
    switch (d.cat) {
      case "junk":
        return (d.id === "junk_dogtag" ? dogTagCr(it.lvl ?? 0) : (d.value ?? 0)) * it.qty;
      case "weapon": {
        const worst = Math.min(weaponValue(this.weaponAt("w1")), weaponValue(this.weaponAt("w2")));
        return 150 + 150 * it.rarity + (weaponValue(it) > worst + 0.05 ? 2000 : 0);
      }
      case "armor": {
        const worn = s.get("armor");
        const level = worn ? (itemDef(worn.def)?.armorLevel ?? 0) : 0;
        const up = armorIsUpgrade({ armor: level, armorDur: worn?.dur ?? 0 }, d.armorLevel ?? 0, it.dur);
        return 120 * (d.armorLevel ?? 1) + (up ? 2000 : 0);
      }
      case "backpack":
        return 100 * (d.bpLevel ?? 1) + ((d.bpLevel ?? 0) > bpLevelOf(s) ? 3000 : 0);
      case "ammo": {
        const type = d.ammo!;
        const uses = (["w1", "w2"] as const).some((k) => weaponDefOf(this.weaponAt(k))?.ammo === type);
        if (!uses) return 0;
        return ammoCount(this.rt, type) < AMMO[type].maxCarry * 0.6 ? 400 : 30;
      }
      case "med":
        if (d.med === "medkit") return medCount(this.rt, "medkit") < HEAL.medkit.MAX_CARRY ? 300 * it.qty : 20;
        return medCount(this.rt, "bandage") < 6 ? 80 * it.qty : 10;
      default:
        return 0;
    }
  }

  /**
   * Cheapest storage item the bot would give up for better loot. Never ammo or meds (they would be
   * auto-picked right back up) and never FREE kit (it would just vanish).
   */
  private worstDroppable(): { key: SlotKey; item: ItemLike; v: number } | null {
    const s = this.rt.self.slots;
    let best: { key: SlotKey; item: ItemLike; v: number } | null = null;
    for (const k of storageKeys(s)) {
      const it = s.get(k);
      if (!it || it.flags & (ITEM_FLAG.FREE | ITEM_FLAG.BROKEN)) continue;
      const cat = itemDef(it.def)?.cat;
      if (cat === "ammo" || cat === "med") continue;
      const v = this.lootValue(it);
      if (!best || v < best.v) best = { key: k, item: toPlain(it), v };
    }
    return best;
  }

  /** Carried value and fullness, refreshed once per decision. */
  private updateBag(): void {
    const s = this.rt.self.slots;
    let v = 0;
    let full = true;
    for (const k of storageKeys(s)) {
      const it = s.get(k);
      if (!it) {
        full = false;
        continue;
      }
      const d = itemDef(it.def);
      if (it.flags & ITEM_FLAG.FREE) continue;
      if (d?.cat === "junk") v += this.lootValue(it);
      else if (d?.unique) v += 150;
    }
    for (const k of ["w1", "w2", "armor", "bp"] as const) {
      const it = s.get(k);
      if (it && !(it.flags & ITEM_FLAG.FREE)) v += 150;
    }
    this.carriedValue = v;
    this.bagFull = full;
  }

  /**
   * Equip better gear sitting in storage (own INV_MOVE with a target slot = swap): a better weapon
   * over the worse weapon slot, better armor, a bigger backpack. One move per call.
   */
  private equipBest(): void {
    const rt = this.rt;
    const s = rt.self.slots;
    if (rt.self.reloadUntil > 0 || rt.self.healUntil > 0) return;
    const w1 = weaponValue(this.weaponAt("w1"));
    const w2 = weaponValue(this.weaponAt("w2"));
    const worseKey: "w1" | "w2" = !s.get("w1") ? "w1" : !s.get("w2") ? "w2" : w1 <= w2 ? "w1" : "w2";
    const worse = Math.min(s.get("w1") ? w1 : 0, s.get("w2") ? w2 : 0);
    const worn = s.get("armor");
    const wornLevel = worn ? (itemDef(worn.def)?.armorLevel ?? 0) : 0;
    for (const k of storageKeys(s)) {
      const it = s.get(k);
      if (!it || it.flags & ITEM_FLAG.BROKEN) continue;
      const d = itemDef(it.def);
      let to: SlotKey | null = null;
      if (d?.cat === "weapon" && weaponValue(it) > worse + 0.05) to = worseKey;
      else if (d?.cat === "armor" && armorIsUpgrade({ armor: wornLevel, armorDur: worn?.dur ?? 0 }, d.armorLevel ?? 0, it.dur)) to = "armor";
      else if (d?.cat === "backpack" && (d.bpLevel ?? 0) > bpLevelOf(s)) to = "bp";
      if (!to) continue;
      if (this.m.invMove(rt.id, { from: "self", key: k, uid: it.uid, def: it.def, to }) === null) return;
    }
  }

  /** With both slots full the pickup replaces the active slot, so make the worse weapon active first. */
  private prepareSlotForPickup(): void {
    const w1 = this.weaponAt("w1");
    const w2 = this.weaponAt("w2");
    if (!w1 || !w2) return;
    const worse = weaponValue(w1) <= weaponValue(w2) ? "w1" : "w2";
    if (worse !== this.rt.self.active) this.m.switchSlot(this.rt.id, worse);
  }

  // ------------------------------------------------------------------ combat

  /** The player who hit this bot within BOT_RETALIATE_MS, if still alive. */
  private recentAttacker(): PlayerRuntime | null {
    const by = this.rt.lastHitBy;
    if (!by || this.m.clock - this.rt.lastHitAt > BOT_RETALIATE_MS) return null;
    return by.pub.alive ? by : null;
  }

  private findEnemy(): PlayerRuntime | null {
    const p = this.rt.pub;
    const attacker = this.recentAttacker();
    // Peace: nobody starts a fight; only answer whoever is shooting at us.
    if (this.m.clock < BOT_PEACE_MS) return attacker && this.canSee(attacker) ? attacker : null;

    let best: PlayerRuntime | null = null;
    let bestD = Infinity;
    const leaving = this.goal?.kind === "extract";
    // Scavs fight anyone they see on their turf.
    const atHome = !!this.home && inRect(this.home.rect, p.x, p.y, SCAV_LEASH_PX);
    const pick = leaving ? PICK_FIGHT_EXTRACTING : atHome ? BOT_VIEW_RANGE : this.pickFightRange * this.openingRamp();
    const vision = this.m.vision;
    const me = this.rt.rosterIndex;
    for (const j of vision.row(me)) {
      const ort = this.m.rosterRuntime(j);
      if (!ort || !ort.pub.alive) continue;
      const o = ort.pub;
      let d = Math.hypot(o.x - p.x, o.y - p.y);
      // Starting a fight (vs. answering one or keeping the current target) has a shorter reach.
      // Scavs are one faction: they never start a fight with another scav.
      const answer = ort === attacker || ort.id === this.enemyId;
      if (!answer && this.home && this.isScav(ort)) continue;
      const reach = answer ? Infinity : pick;
      if (d > reach) continue;
      // Stick to the current target unless someone is much closer; answer an attacker first.
      if (ort.id === this.enemyId) d *= 0.7;
      if (ort === attacker) d *= 0.5;
      if (d < bestD) {
        best = ort;
        bestD = d;
      }
    }
    return best;
  }

  private isScav(o: PlayerRuntime): boolean {
    if (!o.isBot) return false;
    for (const b of this.m.bots) if (b.rt === o) return b.role === "scav";
    return false;
  }

  private fight(ert: PlayerRuntime): void {
    const p = this.rt.pub;
    const e = ert.pub;
    const clock = this.m.clock;
    const dx = e.x - p.x;
    const dy = e.y - p.y;
    const dist = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx);
    this.lastEnemyAt = clock;
    this.investigate = null;
    if (ert.id !== this.enemyId) {
      this.enemyId = ert.id;
      this.enemySeen = null;
      this.enemySpeed = 0;
      this.reactAt = clock + this.rand(REACT_MIN_MS, REACT_MAX_MS);
    }
    // Target speed from what the bot saw (smoothed), not from hidden state.
    if (this.enemySeen && clock > this.enemySeen.at) {
      const v = Math.hypot(e.x - this.enemySeen.x, e.y - this.enemySeen.y) / ((clock - this.enemySeen.at) / 1000);
      this.enemySpeed = this.enemySpeed * 0.5 + Math.min(v, PLAYER.SPEED * 1.5) * 0.5;
    }
    this.enemySeen = { x: e.x, y: e.y, at: clock };
    if (clock >= this.aimErrUntil) {
      const moving = Math.min(1, this.enemySpeed / PLAYER.SPEED);
      const spread = (AIM_ERR_BASE + (dist / 1000) * AIM_ERR_PER_1000PX + moving * AIM_ERR_MOVING) * this.sloppiness;
      this.aimErr = (this.m.rng() * 2 - 1) * spread;
      this.aimErrUntil = clock + this.rand(180, 380);
    }
    this.aim = angle + this.aimErr;

    const def = weaponDefOf(activeWeapon(this.rt)) ?? WEAPONS.pistol;
    const engage = Math.min(def.range * 0.9, BOT_VIEW_RANGE);
    this.wantFire = dist <= engage && clock >= this.reactAt;

    // Hold the extraction circle while fighting in it: leaving would reset the channel.
    const g = this.goal;
    if (g?.kind === "extract" && Math.hypot(g.x - p.x, g.y - p.y) < g.r) {
      if (Math.hypot(g.x - p.x, g.y - p.y) > g.r * 0.5) this.navigate(g.x, g.y);
      else this.stop();
      return;
    }

    // Badly hurt with meds in the pocket: break line of sight and patch up (heal runs once the
    // enemy is out of view). Only shoot back when cornered.
    if (p.hp < FLEE_BELOW_HP && medCount(this.rt, "bandage") + medCount(this.rt, "medkit") > 0 && dist > 220) {
      this.wantFire = false;
      const W = this.m.map.width;
      const H = this.m.map.height;
      const fx = Math.max(200, Math.min(W - 200, p.x - (dx / dist) * 600));
      const fy = Math.max(200, Math.min(H - 200, p.y - (dy / dist) * 600));
      this.navigate(fx, fy);
      return;
    }
    // On the way out: keep walking to the extract and shoot on the move.
    if (g?.kind === "extract") {
      this.followGoal();
      return;
    }
    if (dist > engage * 0.85) {
      // Only healthy bots go hunting (scavs at home with less); others keep doing their thing.
      const atHome = !!this.home && inRect(this.home.rect, p.x, p.y, SCAV_LEASH_PX);
      if (p.hp >= (atHome ? 40 : 70)) this.navigate(e.x, e.y);
      else this.followGoal();
      return;
    }
    if (clock >= this.strafeUntil) {
      this.strafe = this.m.rng() < 0.5 ? -1 : 1;
      this.strafeUntil = clock + this.rand(500, 1300);
    }
    const [near, far] = def.id === "shotgun" ? [140, 260] : [260, def.range * 0.6];
    const radial = dist < near ? -0.7 : dist > far ? 0.7 : 0;
    let a = Math.atan2(Math.sin(angle) * radial + Math.cos(angle) * this.strafe,
      Math.cos(angle) * radial - Math.sin(angle) * this.strafe);
    if (!this.clear(a, 60)) {
      this.strafe = -this.strafe;
      a += Math.PI;
    }
    this.mx = Math.cos(a);
    this.my = Math.sin(a);
    this.wantMove = true;
    this.checkStuck(a);
  }

  /**
   * Big map: right after the peace window PMCs that spawned on the same edge all head inland, and
   * full aggression turned every opening into a spawn brawl. Their pick-a-fight reach ramps from
   * OPENING_RAMP_FROM to full over OPENING_RAMP_MS (answering an attacker is never limited).
   */
  private openingRamp(): number {
    if (!this.big) return 1;
    const t = (this.m.clock - BOT_PEACE_MS) / OPENING_RAMP_MS;
    return t >= 1 ? 1 : OPENING_RAMP_FROM + (1 - OPENING_RAMP_FROM) * Math.max(0, t);
  }

  private manageWeapons(enemy: PlayerRuntime | null): void {
    const p = this.rt.pub;
    const s = this.rt.self;
    if (s.reloadUntil > 0 || this.m.clock < this.switchAt) return;
    const dist = enemy ? Math.hypot(enemy.pub.x - p.x, enemy.pub.y - p.y) : 400;
    let best = s.active as "w1" | "w2";
    let bestScore = -1;
    for (const k of ["w1", "w2"] as const) {
      const w = this.weaponAt(k);
      const def = weaponDefOf(w);
      if (!w || !def) continue;
      let score = weaponValue(w);
      if (def.id === "shotgun" && dist > 330) score *= 0.4;
      if (def.id === "sniper" && dist < 250) score *= 0.5;
      if (this.rounds(w) <= 0) score = 0.01;
      if (score > bestScore) { bestScore = score; best = k; }
    }
    const activeEmpty = this.rounds(activeWeapon(this.rt)) <= 0;
    // Mid-fight only switch away from a dry weapon; out of combat pick the best one.
    if (best !== s.active && (!enemy || activeEmpty)) {
      this.m.switchSlot(this.rt.id, best);
      this.switchAt = this.m.clock + 900;
    }
  }

  // ------------------------------------------------------------------ goals

  /** Not enough time left to walk to the nearest allowed extract and channel: go now. */
  private lastCall(): boolean {
    const m = this.m;
    if (m.state.phase !== "open") return false;
    const p = this.rt.pub;
    let best = Infinity;
    for (const e of m.state.extracts.values()) {
      if (!extractIsOpen(e, m.clock) || !extractAllowed(m, this.rt, e)) continue;
      best = Math.min(best, Math.hypot(e.x - p.x, e.y - p.y));
    }
    if (best === Infinity) return false;
    const need = (best / (PLAYER.SPEED * 0.55)) * 1000 + MATCH.EXTRACT_CHANNEL_MS + LAST_CALL_MARGIN_MS;
    return MATCH.DURATION_MS - m.clock < need;
  }

  private shouldExtract(): boolean {
    if (this.m.state.phase !== "open") return false;
    const clock = this.m.clock;
    if (clock >= this.extractAt) return true;
    // Hurt with nothing to heal: cash out.
    if (this.rt.pub.hp < 40 && medCount(this.rt, "bandage") + medCount(this.rt, "medkit") === 0) return true;
    // A full bag of good loot: nothing more to gain here.
    const slots = storageKeys(this.rt.self.slots).length;
    if (this.bagFull && this.carriedValue >= Math.max(FULL_BAG_VALUE, FULL_BAG_VALUE_PER_SLOT * slots) &&
      (!this.big || clock >= Math.max(EXTRACT_AFTER_BIG_MIN_MS, this.extractAt - FULL_BAG_EARLY_MS))) return true;
    // Legacy map: good loot makes a bot leave up to 45 s earlier (v1 rule).
    if (!this.big && clock >= this.extractAt - 45_000 && this.carriedValue >= 600) return true;
    return this.lastCall();
  }

  private goalValid(g: Goal): boolean {
    const timeout = g.kind === "extract"
      ? (this.big ? EXTRACT_GOAL_TIMEOUT_BIG_MS : EXTRACT_GOAL_TIMEOUT_MS)
      : (this.big ? GOAL_TIMEOUT_BIG_MS : GOAL_TIMEOUT_MS);
    if (this.m.clock - this.goalSince > timeout) {
      this.blacklist.set(g.id, this.m.clock + 30_000);
      return false;
    }
    switch (g.kind) {
      case "search":
        if (g.idx >= 0) return this.m.containers.stateOf(g.idx) !== CONTAINER_STATE.EMPTIED;
        return !(this.m.containers.targets.get(g.id)?.emptied ?? true);
      case "item":
        return this.m.ground.byId.has(g.id);
      case "extract": {
        const e = this.m.state.extracts.get(g.id);
        return !!e && extractIsOpen(e, this.m.clock) && this.shouldExtract();
      }
      default:
        return true;
    }
  }

  /**
   * Wary (peace window, opening ramp, or hurt): a bot does not loot right next to someone it can
   * see — in v1 everyone shared the nearest crate during the peace and the opening was a brawl.
   */
  private wary(): boolean {
    if (this.home && inRect(this.home.rect, this.rt.pub.x, this.rt.pub.y, SCAV_LEASH_PX)) return false;
    return this.m.clock < BOT_PEACE_MS + (this.big ? OPENING_RAMP_MS : 0) || this.rt.pub.hp < 50;
  }

  private crowded(x: number, y: number): boolean {
    for (const o of this.seen) if ((o.x - x) ** 2 + (o.y - y) ** 2 < PERSONAL_SPACE_PX * PERSONAL_SPACE_PX) return true;
    return false;
  }

  private updateGoal(): void {
    const clock = this.m.clock;
    if (this.goal && !this.goalValid(this.goal)) this.goal = null;
    const g = this.goal;
    if (g && (g.kind === "search" || g.kind === "item") && this.seen.length > 0 && this.wary() && this.crowded(g.x, g.y)) {
      this.blacklist.set(g.id, clock + 20_000);
      this.goal = null;
    }
    // Extraction overrides looting as soon as it becomes the plan.
    const extractNow = this.shouldExtract() && this.goal?.kind !== "extract";
    if (this.goal && clock < this.goalEvalAt && !extractNow) return;
    this.goalEvalAt = clock + GOAL_REEVAL_MS;
    const next = this.pickGoal();
    if (!next) {
      this.goal = null;
      return;
    }
    if (!this.goal || this.goal.id !== next.id) {
      // Keep wandering toward the old point instead of jittering between random targets.
      if (this.goal?.kind === "wander" && next.kind === "wander") return;
      this.goal = next;
      this.goalSince = clock;
      this.stuckCount = 0;
      this.unreachable = 0;
    }
  }

  /** Inside the scav's leash (always true for PMCs). */
  private leashed(x: number, y: number): boolean {
    return !this.home || inRect(this.home.rect, x, y, SCAV_LEASH_PX);
  }

  private pickGoal(): Goal | null {
    const p = this.rt.pub;
    const clock = this.m.clock;
    for (const [k, until] of this.blacklist) if (until <= clock) this.blacklist.delete(k);

    if (this.shouldExtract()) {
      let best: Goal | null = null;
      let bestD = Infinity;
      for (const e of this.m.state.extracts.values()) {
        if (!extractIsOpen(e, clock) || !extractAllowed(this.m, this.rt, e) || this.blacklist.has(e.id)) continue;
        let d = Math.hypot(e.x - p.x, e.y - p.y);
        // Avoid racing toward an extract that will close before we get there.
        if (e.closeAt > 0 && e.closeAt < clock + d / (PLAYER.SPEED * 0.6) * 1000 + MATCH.EXTRACT_CHANNEL_MS) d += 50_000;
        if (d < bestD) { bestD = d; best = { kind: "extract", id: e.id, x: e.x, y: e.y, r: e.r }; }
      }
      if (best) return best;
    }

    let best: Goal | null = null;
    let bestScore = Infinity;
    const wary = this.seen.length > 0 && this.wary();
    const consider = (g: Goal, score: number) => {
      if (wary && this.crowded(g.x, g.y)) score *= 4;
      if (this.blacklist.has(g.id) || score >= bestScore || !this.leashed(g.x, g.y)) return;
      best = g;
      bestScore = score;
    };
    // A full bag only searches when it could still swap junk for something better.
    const searchMult = this.bagFull ? 1.6 : 1;
    // Scavs guard their POI's containers (they take bodies and floor loot only).
    const containers = this.home ? [] : this.m.map.containers;
    for (let idx = 0; idx < containers.length; idx++) {
      const c = containers[idx]!;
      if (Math.abs(c.x - p.x) > LOOT_RANGE || Math.abs(c.y - p.y) > LOOT_RANGE) continue;
      if (this.m.containers.stateOf(idx) === CONTAINER_STATE.EMPTIED) continue;
      const d = Math.hypot(c.x - p.x, c.y - p.y);
      if (d < LOOT_RANGE) consider({ kind: "search", id: `c${idx}`, idx, x: c.x, y: c.y }, d * (1 - c.tier * 0.08) * searchMult);
    }
    for (const t of this.m.containers.corpses()) {
      if (t.emptied || t.owner === this.rt.rosterIndex) continue;
      const d = Math.hypot(t.x - p.x, t.y - p.y);
      // Bodies are worth a detour: gear plus a dog tag.
      if (d < LOOT_RANGE) consider({ kind: "search", id: t.key, idx: -1, x: t.x, y: t.y }, d * 0.7 * searchMult);
    }
    for (const g of this.m.ground.near(p.x, p.y, LOOT_RANGE)) {
      const it = g.schema;
      const want = this.itemWant(g);
      if (want <= 0) continue;
      const d = Math.hypot(it.x - p.x, it.y - p.y);
      const cat = itemDef(it.def)?.cat;
      consider({ kind: "item", id: it.id, x: it.x, y: it.y, needsInteract: cat !== "ammo" && cat !== "med" }, d / want);
    }
    if (best) return best;

    if (this.goal?.kind === "wander") return this.goal;
    const to = this.wanderTarget();
    return { kind: "wander", id: `w${clock}`, x: to.x, y: to.y };
  }

  /**
   * Where to roam next: a scav stays inside its zone; a PMC on a map with zones heads for a POI
   * (better tiers and closer ones likelier); otherwise a random hop biased to the map centre.
   * Snapped to a walkable cell so the planner can route there.
   */
  private wanderTarget(): Pt {
    const p = this.rt.pub;
    const W = this.m.map.width;
    const H = this.m.map.height;
    let x: number;
    let y: number;
    const zones = this.m.map.zones;
    const inset = (r: Rect) => {
      const ix = Math.min(300, r.w / 4);
      const iy = Math.min(300, r.h / 4);
      return { x: r.x + ix + this.m.rng() * (r.w - 2 * ix), y: r.y + iy + this.m.rng() * (r.h - 2 * iy) };
    };
    if (this.home) {
      ({ x, y } = inset(this.home.rect));
    } else if (zones.length > 0 && this.m.rng() < 0.75) {
      const w = zones.map((z) => {
        const here = inRect(z.rect, p.x, p.y);
        const d = Math.hypot(z.rect.x + z.rect.w / 2 - p.x, z.rect.y + z.rect.h / 2 - p.y);
        return ((1 + z.tier) / (1 + d / 5000)) * (here ? 0.3 : 1);
      });
      let r = this.m.rng() * w.reduce((a, b) => a + b, 0);
      let k = 0;
      while (k < zones.length - 1 && r >= w[k]!) r -= w[k++]!;
      ({ x, y } = inset(zones[k]!.rect));
    } else {
      const hop = this.big ? 2200 : 1400;
      x = p.x + this.rand(-hop, hop) + (W / 2 - p.x) * 0.3;
      y = p.y + this.rand(-hop, hop) + (H / 2 - p.y) * 0.3;
    }
    x = Math.max(300, Math.min(W - 300, x));
    y = Math.max(300, Math.min(H - 300, y));
    const g = this.m.planner.regions;
    const c = g.cellAt(x, y, 512);
    return c >= 0 ? { x: g.cellX(c), y: g.cellY(c) } : { x, y };
  }

  /** How much the bot wants a ground item (0 = not at all; higher = worth a longer walk). */
  private itemWant(g: GroundRt): number {
    const it = g.item;
    const d = itemDef(it.def);
    if (!d) return 0;
    const s = this.rt.self.slots;
    switch (d.cat) {
      case "weapon": {
        const def = WEAPONS[d.weapon as WeaponId];
        let value = weaponValue(it);
        if (ammoCount(this.rt, def.ammo) + it.mag <= 0) value *= 0.5;
        const worst = Math.min(weaponValue(this.weaponAt("w1")), weaponValue(this.weaponAt("w2")));
        return value > worst + 0.05 ? 1.3 : 0;
      }
      case "armor": {
        const worn = s.get("armor");
        const level = worn ? (itemDef(worn.def)?.armorLevel ?? 0) : 0;
        return armorIsUpgrade({ armor: level, armorDur: worn?.dur ?? 0 }, d.armorLevel ?? 0, it.dur) ? 1.3 : 0;
      }
      case "backpack":
        return (d.bpLevel ?? 0) > bpLevelOf(s) ? 1.2 : 0;
      case "ammo": {
        const type = d.ammo!;
        const uses = (["w1", "w2"] as const).some((k) => weaponDefOf(this.weaponAt(k))?.ammo === type);
        const have = ammoCount(this.rt, type);
        if (!uses || have >= AMMO[type].maxCarry * 0.6) return 0;
        // Room for it at all (a merge or a free slot)?
        if (!planPlace(s, it).ok) return 0;
        return have < AMMO[type].pickup ? 1.2 : 0.6;
      }
      case "med":
        if (!planPlace(s, it).ok) return 0;
        return d.med === "bandage"
          ? (medCount(this.rt, "bandage") < 4 ? 0.8 : 0)
          : (medCount(this.rt, "medkit") < HEAL.medkit.MAX_CARRY ? 1 : 0);
      default:
        return 0;
    }
  }

  // ------------------------------------------------------------------ movement

  private stop(): void {
    this.mx = 0;
    this.my = 0;
    this.wantMove = false;
    this.stuckAt = this.m.clock + 800;
  }

  /**
   * Follow a planner route to (tx, ty). Routes come from the region PathPlanner (budgeted per tick):
   * while a request waits in its queue the bot keeps its old route (or steers straight when it has
   * none); a windowed (partial) route is refreshed before its end; unreachable targets are steered
   * at directly and the goal is dropped after a couple of failures.
   */
  private navigate(tx: number, ty: number): void {
    const p = this.rt.pub;
    const clock = this.m.clock;
    const moved = !this.pathFor || Math.hypot(this.pathFor.x - tx, this.pathFor.y - ty) > 80;
    const last = this.path.length - 1;
    const windowEnd = !this.pathComplete && last >= 1
      ? Math.hypot(this.path[last - 1]!.x - p.x, this.path[last - 1]!.y - p.y) < WINDOW_REFRESH_PX
      : false;
    if ((moved && clock >= this.replanMinAt) || clock >= this.replanAt || (windowEnd && clock >= this.replanMinAt)) {
      const r = this.m.planner.request(this.rt.rosterIndex, { x: p.x, y: p.y }, { x: tx, y: ty });
      if (r.status === "ok") {
        this.path = r.path;
        this.pathComplete = r.complete;
        this.pathIdx = 0;
        this.pathFor = { x: tx, y: ty };
        this.replanAt = clock + REPLAN_MS;
        this.replanMinAt = clock + 400;
        this.unreachable = 0;
      } else if (r.status === "pending") {
        // Queued for a later tick: keep the old route if it leads to (about) the same place.
        if (moved || this.path.length === 0) {
          this.path = [{ x: tx, y: ty }];
          this.pathComplete = true;
          this.pathIdx = 0;
          this.pathFor = { x: tx, y: ty };
        }
        this.replanAt = clock + 150;
        this.replanMinAt = clock + 150;
      } else {
        this.path = [{ x: tx, y: ty }];
        this.pathComplete = true;
        this.pathIdx = 0;
        this.pathFor = { x: tx, y: ty };
        this.replanAt = clock + REPLAN_MS;
        this.replanMinAt = clock + 1000;
        if (++this.unreachable >= 3 && this.goal) {
          this.blacklist.set(this.goal.id, clock + 60_000);
          this.goal = null;
          this.unreachable = 0;
        }
      }
    } else if (this.pathFor && (this.pathFor.x !== tx || this.pathFor.y !== ty) && this.path.length > 0) {
      // Chasing a moving target: keep the route, just aim its end at the new position.
      this.path[this.path.length - 1] = { x: tx, y: ty };
      this.pathFor = { x: tx, y: ty };
    }
    // Lazy string pulling: head for the farthest upcoming waypoint we can walk to in a straight line.
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
    this.wantMove = true;
    this.checkStuck(desired);
  }

  /** Probe ahead; if blocked try ±30/60/90/120/150°, preferring the side that worked last. */
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

  /** Is a body-wide corridor of length `probe` in direction `a` free of solids? */
  private clear(a: number, probe: number): boolean {
    const p = this.rt.pub;
    const cx = Math.cos(a);
    const cy = Math.sin(a);
    const off = PLAYER.RADIUS - 4;
    for (const o of [-off, 0, off]) {
      const sx = p.x - cy * o;
      const sy = p.y + cx * o;
      // MOVE: water, windows and fences block walking but not bullets.
      if (raycastSolids(this.m.idx, sx, sy, sx + cx * probe, sy + cy * probe, SOLID.MOVE) !== Infinity) return false;
    }
    return true;
  }

  /**
   * Oscillating in front of an obstacle moves the bot but gets it nowhere: no 200 px of progress
   * toward the target in PROGRESS_MS counts as stuck (replan + detour; the goal is dropped after
   * the second time).
   */
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
    if (d < this.progressBest - 200) {
      this.progressBest = d;
      this.progressAt = clock;
      return;
    }
    if (clock - this.progressAt < (this.walk ? PROGRESS_MS * 2 : PROGRESS_MS)) return;
    this.progressAt = clock;
    this.progressBest = d;
    this.stuckCount += 2;
    this.side = -this.side;
    this.detourAngle = desired + this.side * this.rand(1.6, 2.6);
    this.detourUntil = clock + this.rand(1200, 2200);
    this.replanAt = 0;
    if (this.stuckCount >= 4) this.giveUpTarget(clock);
  }

  private giveUpTarget(clock: number): void {
    if (this.investigate) this.investigate = null;
    else if (this.goal) {
      this.blacklist.set(this.goal.id, clock + 30_000);
      this.goal = null;
    }
    this.stuckCount = 0;
  }

  private checkStuck(desired: number): void {
    const p = this.rt.pub;
    const clock = this.m.clock;
    if (clock < this.stuckAt) return;
    const moved = Math.hypot(p.x - this.stuckPos.x, p.y - this.stuckPos.y);
    this.stuckPos = { x: p.x, y: p.y };
    this.stuckAt = clock + 800;
    if (!this.wantMove) return;
    // Walking (Shift) covers half the ground.
    if (moved < (this.walk ? 15 : 30)) {
      this.stuckCount++;
      this.side = this.m.rng() < 0.5 ? -1 : 1;
      this.detourAngle = desired + this.side * this.rand(1.6, 2.6);
      this.detourUntil = clock + this.rand(600, 1300);
      this.replanAt = 0;
      if (this.stuckCount >= 4) this.giveUpTarget(clock);
    } else if (this.stuckCount > 0) {
      this.stuckCount--;
    }
  }

  private rand(min: number, max: number): number {
    return min + this.m.rng() * (max - min);
  }
}
