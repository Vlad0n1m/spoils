/**
 * Bots drive their player through exactly the same pipeline as humans: they enqueue InputSamples
 * at INPUT_HZ (movement, aim, trigger) and call the same interact / reload / switch / heal intents.
 * They get no extra powers — no wall hacks beyond line of sight, no perfect aim — and are tuned to
 * be beatable: reaction delay, aim error growing with distance and target speed, a slow trigger
 * finger and bursts. For the first BOT_PEACE_MS they only loot (and answer fire), and each bot has
 * its own moment to head for extraction so the core loop is visible in every match.
 */

import {
  AMMO,
  CONTAINER_STATE,
  HEAL,
  INPUT_DT_MS,
  MATCH,
  PLAYER,
  SOLID,
  WEAPONS,
  armorIsUpgrade,
  bpLevelOf,
  hasLineOfSight,
  itemDef,
  raycastSolids,
  type InvItem,
  type WeaponId,
} from "@extract/shared";
import { activeWeapon, ammoCount, carriedItems, medCount, weaponDefOf } from "./bag.js";
import { currentTarget, demoChestRarity, takeAll } from "./containers.js";
import { extractAllowed, extractIsOpen } from "./extraction.js";
import type { GroundRt } from "./inventory.js";
import { isTrackedUnique } from "./items.js";
import type { Match } from "./match.js";
import type { Pt } from "./nav.js";
import type { PlayerRuntime } from "./types.js";

/** Opening window: bots loot and do not start fights (they still answer an attacker). */
export const BOT_PEACE_MS = 30_000;
/** During the peace window a bot shoots back only at someone who hit it this recently. */
export const BOT_RETALIATE_MS = 3_000;
/** Bots do not see further than this (line of sight required as well). */
export const BOT_VIEW_RANGE = 800;
/** A human standing still inside a bush is invisible to bots beyond this distance. */
export const BOT_BUSH_SIGHT = 250;
/** "Standing still": has not moved for this long. */
const STILL_MS = 400;
/** Reaction delay to a newly seen enemy. */
const REACT_MIN_MS = 450;
const REACT_MAX_MS = 800;
/** Aim error half-width: base + per 1000 px of distance + extra for a target moving at full speed. */
const AIM_ERR_BASE = 0.1;
const AIM_ERR_PER_1000PX = 0.12;
const AIM_ERR_MOVING = 0.1;
/** Semi-auto bots never press faster than this, whatever the weapon allows. */
const MIN_PRESS_INTERVAL_MS = 420;
/** Each bot heads for extraction somewhere in this window (earlier with loot or when hurt). */
const EXTRACT_AFTER_MIN_MS = 150_000;
const EXTRACT_AFTER_MAX_MS = 330_000;
/**
 * On a big map (the 24,576 px Steppe, 30-minute raid) the v1 window above would empty the map by
 * minute 6; bots there stay 8-22 minutes. The legacy 4800 px map keeps the v1 window (its whole-
 * match tests are tuned to it).
 */
const BIG_MAP_PX = 8000;
const EXTRACT_AFTER_BIG_MIN_MS = 480_000;
const EXTRACT_AFTER_BIG_MAX_MS = 1_320_000;
/** A bot that opened a container waits for the reveal, then takes everything; at most this long. */
const BOT_SEARCH_MAX_MS = 9_000;
/** A container a bot already searched is skipped for this long (it took what fit). */
const SEARCHED_BLACKLIST_MS = 600_000;

/** Least aggressive bots start fights only this close. */
const PICK_FIGHT_MIN = 300;
/** A bot on its way out only starts a fight this close. */
const PICK_FIGHT_EXTRACTING = 300;
/** The most aggressive bots start fights this far. */
const PICK_FIGHT_MAX = 700;

const THINK_MS = 100;
const GOAL_REEVAL_MS = 1200;
const GOAL_TIMEOUT_MS = 20_000;
/** Crossing the map and channeling takes longer than a loot run. */
const EXTRACT_GOAL_TIMEOUT_MS = 75_000;
const LOOT_RANGE = 1800;
const HEAL_BELOW_HP = 55;
const FLEE_BELOW_HP = 35;
/** Base value of each weapon for "is this an upgrade" decisions. */
const WEAPON_VALUE: Record<WeaponId, number> = { pistol: 1, shotgun: 2.4, sniper: 2.2, rifle: 3 };


type Goal =
  | { kind: "container"; id: string; idx: number; x: number; y: number }
  | { kind: "item"; id: string; x: number; y: number; needsInteract: boolean }
  | { kind: "extract"; id: string; x: number; y: number; r: number }
  | { kind: "wander"; id: string; x: number; y: number };


/**
 * Fair sight for bots: within BOT_VIEW_RANGE and line of sight. A human standing still inside a
 * bush is hidden beyond BOT_BUSH_SIGHT; bots get no such cover (a bot in a bush is still visible).
 * Kept until WP-G moves bots to m.vision.sees() with a range cap (the WP1 vision stub is all-true).
 */
export function botCanSee(m: Match, viewer: PlayerRuntime, target: PlayerRuntime): boolean {
  const v = viewer.pub;
  const o = target.pub;
  const d = Math.hypot(o.x - v.x, o.y - v.y);
  if (d > BOT_VIEW_RANGE) return false;
  if (d > BOT_BUSH_SIGHT && !target.isBot) {
    const still = m.clock - target.movedAt >= STILL_MS;
    if (still && m.map.bushes.some((b) => Math.hypot(o.x - b.x, o.y - b.y) < b.r)) return false;
  }
  return hasLineOfSight(m.idx, v.x, v.y, o.x, o.y, SOLID.SIGHT);
}

/** Bot-side value of a weapon instance for "is this an upgrade" decisions. */
function weaponValue(it: { def: string; rarity: number } | undefined): number {
  const w = it ? itemDef(it.def)?.weapon : undefined;
  return w ? WEAPON_VALUE[w] * (1 + 0.12 * it!.rarity) : 0;
}

export class BotBrain {
  private seq = 0;
  private inputAcc = 0;
  private thinkAcc = THINK_MS;

  private mx = 0;
  private my = 0;
  private aim = 0;
  private wantFire = false;
  private lastFire = false;
  private nextPressAt = 0;
  private burstUntil = 0;
  private pauseUntil = 0;

  private goal: Goal | null = null;
  private goalSince = 0;
  private goalEvalAt = 0;
  private readonly blacklist = new Map<string, number>();
  private path: Pt[] = [];
  private pathIdx = 0;
  private pathFor: Pt | null = null;
  private replanAt = 0;
  private replanMinAt = 0;

  private enemyId = "";
  private enemySeen: { x: number; y: number; at: number } | null = null;
  private enemySpeed = 0;
  private reactAt = 0;
  private aimErr = 0;
  private aimErrUntil = 0;
  private strafe = 1;
  private strafeUntil = 0;
  private switchAt = 0;

  private side = 1;
  private stuckAt = 0;
  private stuckPos: Pt = { x: 0, y: 0 };
  private stuckCount = 0;
  private detourUntil = 0;
  private detourAngle = 0;
  private wantMove = false;

  /** Per-bot skill: < 1 is sharper. Scales aim error. */
  private readonly sloppiness: number;
  /** Match clock after which this bot wants out. */
  private readonly extractAfter: number;
  /** Match clock when the current search session was first seen (0 = none). */
  private searchSince = 0;
  /** How far away this bot starts a fight on its own (attackers are answered at any visible range). */
  private readonly pickFightRange: number;

  constructor(private readonly m: Match, private readonly rt: PlayerRuntime) {
    this.sloppiness = 0.85 + m.rng() * 0.4;
    const big = m.map.width > BIG_MAP_PX;
    const lo = big ? EXTRACT_AFTER_BIG_MIN_MS : EXTRACT_AFTER_MIN_MS;
    const hi = big ? EXTRACT_AFTER_BIG_MAX_MS : EXTRACT_AFTER_MAX_MS;
    this.extractAfter = lo + m.rng() * (hi - lo);
    this.pickFightRange = PICK_FIGHT_MIN + m.rng() * (PICK_FIGHT_MAX - PICK_FIGHT_MIN);
  }

  /**
   * Called once per server step with its dt. Input accumulator (mobility memo, mandatory): a bot
   * enqueues floor(acc / INPUT_DT_MS) samples per step and carries the remainder, so it produces
   * exactly INPUT_HZ samples per second of match time like a real client — one sample per 50 ms
   * step would run bot movement, rolls and roll cooldowns at 2/3 speed.
   */
  update(dtMs: number): void {
    const p = this.rt.pub;
    if (!p.alive) return;
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

  /** Samples enqueued so far (tests: INPUT_HZ per second). */
  get samples(): number {
    return this.seq;
  }

  private emitInput(): void {
    let fire = false;
    const def = weaponDefOf(activeWeapon(this.rt));
    if (this.wantFire && def) {
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
    this.m.enqueueInput(this.rt.id, { seq: ++this.seq, mx: this.mx, my: this.my, aim: this.aim, fire, roll: false, walk: false });
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

  private think(): void {
    const p = this.rt.pub;
    const s = this.rt.self;
    const enemy = this.findEnemy();
    this.manageWeapons(enemy);
    this.wantFire = false;

    // Out of ammo entirely: no point standing in a gunfight — keep looting (ammo is wanted most).
    const armed = (["w1", "w2"] as const).some((k) => this.rounds(this.weaponAt(k)) > 0);
    if (enemy && armed) {
      this.fight(enemy);
      return;
    }
    this.enemyId = "";
    this.enemySeen = null;

    // Searching a container / corpse (search session): stand still until it is revealed, then take all.
    if (this.rt.search) {
      this.stepSearch();
      return;
    }
    this.searchSince = 0;

    if (p.hp < HEAL_BELOW_HP && s.healUntil === 0 && s.reloadUntil === 0) {
      const medkits = medCount(this.rt, "medkit");
      const kind = (p.hp <= 40 && medkits > 0) || medCount(this.rt, "bandage") === 0 ? "medkit" : "bandage";
      this.m.heal(this.rt.id, kind);
    }
    const w = activeWeapon(this.rt);
    const def = weaponDefOf(w);
    if (w && def && s.reloadUntil === 0 && s.healUntil === 0) {
      if (w.mag < def.magSize * 0.4 && ammoCount(this.rt, def.ammo) > 0) this.m.reload(this.rt.id);
    }

    this.updateGoal();
    this.followGoal(true);
  }

  /** Walk toward the current goal; `act` = also interact / face the way (false while fighting). */
  private followGoal(act = false): void {
    const p = this.rt.pub;
    const g = this.goal;
    if (!g) {
      this.stop();
      return;
    }
    const d = Math.hypot(g.x - p.x, g.y - p.y);
    if (g.kind === "extract") {
      if (d < g.r * 0.4) this.stop();
      else this.navigate(g.x, g.y);
      if (act) this.aim = Math.atan2(g.y - p.y, g.x - p.x);
      return;
    }
    if (!act) {
      this.navigate(g.x, g.y);
      return;
    }
    if ((g.kind === "container" || (g.kind === "item" && g.needsInteract)) && d < PLAYER.INTERACT_RADIUS * 0.7) {
      this.stop();
      if (g.kind === "item") this.prepareSlotForPickup();
      this.m.interact(this.rt.id);
      this.blacklist.set(g.id, this.m.clock + 30_000);
      this.goal = null;
      return;
    }
    if (g.kind === "item" && !g.needsInteract && d < 8) {
      // Standing on it and it is still there: we are at the carry cap.
      this.blacklist.set(g.id, this.m.clock + 30_000);
      this.goal = null;
      return;
    }
    if (g.kind === "wander" && d < 60) {
      this.goal = null;
      return;
    }
    this.navigate(g.x, g.y);
    this.aim = Math.atan2(this.my, this.mx);
  }

  /**
   * One think step of an open search session: wait for the open delay and the one-by-one reveal,
   * then take everything that fits and close. Bailing out early (BOT_SEARCH_MAX_MS) keeps a bot from
   * camping a big container.
   */
  private stepSearch(): void {
    this.stop();
    const search = this.rt.search!;
    const t = currentTarget(this.m, this.rt);
    const clock = this.m.clock;
    if (!this.searchSince) this.searchSince = clock;
    const done = !!t && clock >= search.readyAt && t.loot.revealed >= t.loot.total;
    const tooLong = clock - this.searchSince > BOT_SEARCH_MAX_MS;
    if (!t || done || tooLong || this.shouldExtract()) {
      if (t && clock >= search.readyAt) takeAll(this.m, this.rt);
      // Search keys are c<idx> / k<corpse>, the same ids container goals use.
      this.blacklist.set(search.key, clock + SEARCHED_BLACKLIST_MS);
      this.m.searchClose(this.rt.id);
      this.searchSince = 0;
    }
  }

  /** The player who hit this bot within BOT_RETALIATE_MS, if still alive. */
  private recentAttacker(): PlayerRuntime | null {
    const by = this.rt.lastHitBy;
    if (!by || this.m.clock - this.rt.lastHitAt > BOT_RETALIATE_MS) return null;
    return by.pub.alive ? by : null;
  }

  private canSee(o: PlayerRuntime): boolean {
    return botCanSee(this.m, this.rt, o);
  }

  private findEnemy(): PlayerRuntime | null {
    const p = this.rt.pub;
    const attacker = this.recentAttacker();
    // Peace: nobody starts a fight; only answer whoever is shooting at us.
    if (this.m.clock < BOT_PEACE_MS) return attacker && this.canSee(attacker) ? attacker : null;

    let best: PlayerRuntime | null = null;
    let bestD = Infinity;
    const leaving = this.goal?.kind === "extract";
    for (const ort of this.m.allRuntimes()) {
      const o = ort.pub;
      if (!o.alive || ort === this.rt) continue;
      let d = Math.hypot(o.x - p.x, o.y - p.y);
      // Starting a fight (vs. answering one or keeping the current target) has a shorter reach.
      const reach = ort === attacker || ort.id === this.enemyId
        ? BOT_VIEW_RANGE
        : leaving ? PICK_FIGHT_EXTRACTING : this.pickFightRange;
      if (d > reach) continue;
      // Stick to the current target unless someone is much closer; answer an attacker first.
      if (ort.id === this.enemyId) d *= 0.7;
      if (ort === attacker) d *= 0.5;
      if (d < bestD && this.canSee(ort)) {
        best = ort;
        bestD = d;
      }
    }
    return best;
  }

  private fight(ert: PlayerRuntime): void {
    const p = this.rt.pub;
    const e = ert.pub;
    const clock = this.m.clock;
    const dx = e.x - p.x;
    const dy = e.y - p.y;
    const dist = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx);
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
      // Only healthy bots go hunting; others keep doing their thing and shoot if it comes closer.
      if (p.hp >= 70) this.navigate(e.x, e.y);
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

  /** With both slots full the pickup replaces the active slot, so make the worse weapon active first. */
  private prepareSlotForPickup(): void {
    const w1 = this.weaponAt("w1");
    const w2 = this.weaponAt("w2");
    if (!w1 || !w2) return;
    const worse = weaponValue(w1) <= weaponValue(w2) ? "w1" : "w2";
    if (worse !== this.rt.self.active) this.m.switchSlot(this.rt.id, worse);
  }

  // ------------------------------------------------------------------ goals

  private shouldExtract(): boolean {
    if (this.m.state.phase !== "open") return false;
    const clock = this.m.clock;
    if (clock >= this.extractAfter) return true;
    // Hurt with nothing to heal: cash out.
    if (this.rt.pub.hp < 35 && medCount(this.rt, "bandage") + medCount(this.rt, "medkit") === 0) return true;
    // Good loot makes a bot leave up to 45 s earlier.
    return clock >= this.extractAfter - 45_000 &&
      carriedItems(this.rt).some((c) => isTrackedUnique(c.item) && c.item.rarity >= 1);
  }

  private goalValid(g: Goal): boolean {
    if (this.m.clock - this.goalSince > (g.kind === "extract" ? EXTRACT_GOAL_TIMEOUT_MS : GOAL_TIMEOUT_MS)) {
      this.blacklist.set(g.id, this.m.clock + 30_000);
      return false;
    }
    switch (g.kind) {
      case "container":
        // Opened containers stay searchable until emptied (the reveal is shared).
        return this.m.state.containerState[g.idx] !== CONTAINER_STATE.EMPTIED;
      case "item":
        return this.m.state.items.has(g.id);
      case "extract": {
        const e = this.m.state.extracts.get(g.id);
        return !!e && extractIsOpen(e, this.m.clock) && this.shouldExtract();
      }
      default:
        return true;
    }
  }

  private updateGoal(): void {
    const clock = this.m.clock;
    if (this.goal && !this.goalValid(this.goal)) this.goal = null;
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
    }
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
        if (e.closeAt > 0 && e.closeAt < clock + d / (PLAYER.SPEED * 0.6) * 1000 + MATCH.EXTRACT_CHANNEL_MS) d += 5000;
        if (d < bestD) { bestD = d; best = { kind: "extract", id: e.id, x: e.x, y: e.y, r: e.r }; }
      }
      if (best) return best;
    }

    let best: Goal | null = null;
    let bestScore = Infinity;
    const consider = (g: Goal, score: number) => {
      if (this.blacklist.has(g.id) || score >= bestScore) return;
      best = g;
      bestScore = score;
    };
    this.m.map.containers.forEach((c, idx) => {
      if (this.m.state.containerState[idx] === CONTAINER_STATE.EMPTIED) return;
      const d = Math.hypot(c.x - p.x, c.y - p.y);
      if (d < LOOT_RANGE) consider({ kind: "container", id: `c${idx}`, idx, x: c.x, y: c.y }, d * (1 - demoChestRarity(c) * 0.1));
    });
    for (const g of this.m.ground.all()) {
      const it = g.schema;
      const d = Math.hypot(it.x - p.x, it.y - p.y);
      if (d > LOOT_RANGE) continue;
      const want = this.itemWant(g);
      if (want <= 0) continue;
      const cat = itemDef(it.def)?.cat;
      consider({ kind: "item", id: it.id, x: it.x, y: it.y, needsInteract: cat !== "ammo" && cat !== "med" }, d / want);
    }
    if (best) return best;

    if (this.goal?.kind === "wander") return this.goal;
    const W = this.m.map.width;
    const H = this.m.map.height;
    return {
      kind: "wander",
      id: `w${clock}`,
      x: Math.max(300, Math.min(W - 300, p.x + this.rand(-1400, 1400) + (W / 2 - p.x) * 0.3)),
      y: Math.max(300, Math.min(H - 300, p.y + this.rand(-1400, 1400) + (H / 2 - p.y) * 0.3)),
    };
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
        return have < AMMO[type].pickup ? 1.2 : 0.6;
      }
      case "med":
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

  private navigate(tx: number, ty: number): void {
    const p = this.rt.pub;
    const clock = this.m.clock;
    const moved = !this.pathFor || Math.hypot(this.pathFor.x - tx, this.pathFor.y - ty) > 80;
    if ((moved && clock >= this.replanMinAt) || clock >= this.replanAt) {
      this.path = this.m.planner.path(this.rt.rosterIndex, p, { x: tx, y: ty }) ?? [{ x: tx, y: ty }];
      this.pathIdx = 0;
      this.pathFor = { x: tx, y: ty };
      this.replanAt = clock + 2500;
      this.replanMinAt = clock + 400;
    } else if (this.pathFor && (this.pathFor.x !== tx || this.pathFor.y !== ty)) {
      // Chasing a moving target: keep the route, just aim its end at the new position.
      this.path[this.path.length - 1] = { x: tx, y: ty };
    }
    // Lazy string pulling: head for the farthest upcoming waypoint we can walk to in a straight line.
    const last = this.path.length - 1;
    let target = this.pathIdx;
    for (let k = Math.min(last, this.pathIdx + 10); k > this.pathIdx; k--) {
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
      if (target < last) this.pathIdx++;
      else this.stop();
      return;
    }
    let desired = Math.atan2(wp.y - p.y, wp.x - p.x);
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
      if (raycastSolids(this.m.idx, sx, sy, sx + cx * probe, sy + cy * probe) !== Infinity) return false;
    }
    return true;
  }

  private checkStuck(desired: number): void {
    const p = this.rt.pub;
    const clock = this.m.clock;
    if (clock < this.stuckAt) return;
    const moved = Math.hypot(p.x - this.stuckPos.x, p.y - this.stuckPos.y);
    this.stuckPos = { x: p.x, y: p.y };
    this.stuckAt = clock + 800;
    if (!this.wantMove) return;
    if (moved < 30) {
      this.stuckCount++;
      this.side = this.m.rng() < 0.5 ? -1 : 1;
      this.detourAngle = desired + this.side * this.rand(1.6, 2.6);
      this.detourUntil = clock + this.rand(600, 1300);
      this.replanAt = 0;
      if (this.stuckCount >= 4 && this.goal) {
        this.blacklist.set(this.goal.id, clock + 30_000);
        this.goal = null;
        this.stuckCount = 0;
      }
    } else if (this.stuckCount > 0) {
      this.stuckCount--;
    }
  }

  private rand(min: number, max: number): number {
    return min + this.m.rng() * (max - min);
  }
}
