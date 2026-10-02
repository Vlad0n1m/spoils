/**
 * Bots drive their player through exactly the same pipeline as humans: they enqueue InputSamples
 * at INPUT_HZ (movement, aim, trigger) and call the same interact / reload / switch / heal intents.
 * They get no extra powers — no wall hacks beyond line of sight, no perfect aim — and are tuned to
 * be beatable: reaction delay, aim error growing with distance, trigger pulses and bursts.
 */

import {
  AMMO,
  HEAL,
  INPUT_DT_MS,
  MATCH,
  PLAYER,
  WEAPONS,
  hasLineOfSight,
  raycastSolids,
  type GroundItem,
  type Player,
  type WeaponId,
} from "@extract/shared";
import { ammoOf, armorIsUpgrade, carriedRefs } from "./inventory.js";
import { extractIsOpen } from "./extraction.js";
import type { Match } from "./match.js";
import { navGridFor, type Pt } from "./nav.js";
import type { PlayerRuntime } from "./types.js";

const THINK_MS = 100;
const VIEW_RANGE = 950;
const GOAL_REEVAL_MS = 1200;
const GOAL_TIMEOUT_MS = 20_000;
const LOOT_RANGE = 1800;
const HEAL_BELOW_HP = 55;
const FLEE_BELOW_HP = 35;
/** Base value of each weapon for "is this an upgrade" decisions. */
const WEAPON_VALUE: Record<WeaponId, number> = { pistol: 1, shotgun: 2.4, sniper: 2.2, rifle: 3 };


type Goal =
  | { kind: "chest"; id: string; x: number; y: number }
  | { kind: "item"; id: string; x: number; y: number; needsInteract: boolean }
  | { kind: "extract"; id: string; x: number; y: number; r: number }
  | { kind: "wander"; id: string; x: number; y: number };


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

  /** Per-bot skill: < 1 is sharper. Scales aim error and reaction time. */
  private readonly sloppiness: number;

  constructor(private readonly m: Match, private readonly rt: PlayerRuntime) {
    this.sloppiness = 0.8 + m.rng() * 0.6;
  }

  update(dtMs: number): void {
    const p = this.m.player(this.rt.id);
    if (!p?.alive) return;
    this.thinkAcc += dtMs;
    if (this.thinkAcc >= THINK_MS) {
      this.thinkAcc = 0;
      this.think(p);
    }
    this.inputAcc += dtMs;
    while (this.inputAcc + 1e-6 >= INPUT_DT_MS) {
      this.inputAcc -= INPUT_DT_MS;
      this.emitInput(p);
    }
  }

  private emitInput(p: Player): void {
    let fire = false;
    const slot = p.slots[p.active];
    if (this.wantFire && slot?.weapon) {
      const def = WEAPONS[slot.weapon as WeaponId];
      const clock = this.m.clock;
      if (def.auto) {
        // Bursts instead of a perfect laser: hold 0.3–0.7 s, pause 0.2–0.45 s.
        if (clock >= this.pauseUntil && clock < this.burstUntil) fire = true;
        else if (clock >= this.burstUntil && clock >= this.pauseUntil) {
          this.burstUntil = clock + this.rand(300, 700);
          this.pauseUntil = this.burstUntil + this.rand(200, 450);
          fire = true;
        }
      } else if (!this.lastFire && clock >= this.nextPressAt) {
        fire = true;
        this.nextPressAt = clock + def.fireIntervalMs + this.rand(60, 260) * this.sloppiness;
      }
    }
    this.lastFire = fire;
    this.m.enqueueInput(this.rt.id, { seq: ++this.seq, mx: this.mx, my: this.my, aim: this.aim, fire });
  }

  // ------------------------------------------------------------------ decisions

  private think(p: Player): void {
    const enemy = this.findEnemy(p);
    this.manageWeapons(p, enemy);
    this.wantFire = false;

    // Out of ammo entirely: no point standing in a gunfight — keep looting (ammo is wanted most).
    const armed = p.slots.some((s) => s.weapon && s.mag + ammoOf(p, WEAPONS[s.weapon as WeaponId].ammo) > 0);
    if (enemy && armed) {
      this.fight(p, enemy);
      return;
    }
    this.enemyId = "";

    if (p.hp < HEAL_BELOW_HP && p.healUntil === 0 && p.reloadUntil === 0) {
      const kind = (p.hp <= 40 && p.medkits > 0) || p.bandages === 0 ? "medkit" : "bandage";
      this.m.heal(this.rt.id, kind);
    }
    const slot = p.slots[p.active];
    if (slot?.weapon && p.reloadUntil === 0 && p.healUntil === 0) {
      const def = WEAPONS[slot.weapon as WeaponId];
      if (slot.mag < def.magSize * 0.4 && ammoOf(p, def.ammo) > 0) this.m.reload(this.rt.id);
    }

    this.updateGoal(p);
    this.followGoal(p, true);
  }

  /** Walk toward the current goal; `act` = also interact / face the way (false while fighting). */
  private followGoal(p: Player, act = false): void {
    const g = this.goal;
    if (!g) {
      this.stop();
      return;
    }
    const d = Math.hypot(g.x - p.x, g.y - p.y);
    if (g.kind === "extract") {
      if (d < g.r * 0.4) this.stop();
      else this.navigate(p, g.x, g.y);
      if (act) this.aim = Math.atan2(g.y - p.y, g.x - p.x);
      return;
    }
    if (!act) {
      this.navigate(p, g.x, g.y);
      return;
    }
    if ((g.kind === "chest" || (g.kind === "item" && g.needsInteract)) && d < PLAYER.INTERACT_RADIUS * 0.7) {
      this.stop();
      if (g.kind === "item") this.prepareSlotForPickup(p);
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
    this.navigate(p, g.x, g.y);
    this.aim = Math.atan2(this.my, this.mx);
  }

  private findEnemy(p: Player): Player | null {
    let best: Player | null = null;
    let bestD = VIEW_RANGE;
    for (const o of this.m.state.players.values()) {
      if (!o.alive || o.sessionId === p.sessionId) continue;
      let d = Math.hypot(o.x - p.x, o.y - p.y);
      if (d > VIEW_RANGE) continue;
      // Stick to the current target unless someone is much closer.
      if (o.sessionId === this.enemyId) d *= 0.7;
      if (d < bestD && hasLineOfSight(this.m.idx, p.x, p.y, o.x, o.y)) {
        best = o;
        bestD = d;
      }
    }
    return best;
  }

  private fight(p: Player, e: Player): void {
    const clock = this.m.clock;
    const dx = e.x - p.x;
    const dy = e.y - p.y;
    const dist = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx);
    if (e.sessionId !== this.enemyId) {
      this.enemyId = e.sessionId;
      this.reactAt = clock + this.rand(300, 600) * this.sloppiness;
    }
    if (clock >= this.aimErrUntil) {
      const spread = (0.04 + dist * 0.00012) * this.sloppiness;
      this.aimErr = (this.m.rng() * 2 - 1) * spread;
      this.aimErrUntil = clock + this.rand(180, 380);
    }
    this.aim = angle + this.aimErr;

    const slot = p.slots[p.active];
    const def = slot?.weapon ? WEAPONS[slot.weapon as WeaponId] : WEAPONS.pistol;
    const engage = def.range * 0.9;
    this.wantFire = dist <= engage && clock >= this.reactAt;

    // Hold the extraction circle while fighting in it: leaving would reset the channel.
    const g = this.goal;
    if (g?.kind === "extract" && Math.hypot(g.x - p.x, g.y - p.y) < g.r) {
      if (Math.hypot(g.x - p.x, g.y - p.y) > g.r * 0.5) this.navigate(p, g.x, g.y);
      else this.stop();
      return;
    }

    // Badly hurt with meds in the pocket: break line of sight and patch up (heal runs once the
    // enemy is out of view). Only shoot back when cornered.
    if (p.hp < FLEE_BELOW_HP && p.bandages + p.medkits > 0 && dist > 220) {
      this.wantFire = false;
      const W = this.m.map.width;
      const H = this.m.map.height;
      const fx = Math.max(200, Math.min(W - 200, p.x - (dx / dist) * 600));
      const fy = Math.max(200, Math.min(H - 200, p.y - (dy / dist) * 600));
      this.navigate(p, fx, fy);
      return;
    }
    if (dist > engage * 0.85) {
      // Only healthy bots go hunting; others keep doing their thing and shoot if it comes closer.
      if (p.hp >= 60) this.navigate(p, e.x, e.y);
      else this.followGoal(p);
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
    if (!this.clear(p, a, 60)) {
      this.strafe = -this.strafe;
      a += Math.PI;
    }
    this.mx = Math.cos(a);
    this.my = Math.sin(a);
    this.wantMove = true;
    this.checkStuck(p, a);
  }

  private manageWeapons(p: Player, enemy: Player | null): void {
    if (p.reloadUntil > 0 || this.m.clock < this.switchAt) return;
    const dist = enemy ? Math.hypot(enemy.x - p.x, enemy.y - p.y) : 400;
    let best = p.active;
    let bestScore = -1;
    p.slots.forEach((s, i) => {
      if (!s.weapon) return;
      const def = WEAPONS[s.weapon as WeaponId];
      const ammo = s.mag + ammoOf(p, def.ammo);
      let score = WEAPON_VALUE[def.id] * (1 + 0.12 * s.rarity);
      if (def.id === "shotgun" && dist > 330) score *= 0.4;
      if (def.id === "sniper" && dist < 250) score *= 0.5;
      if (ammo <= 0) score = 0.01;
      if (score > bestScore) { bestScore = score; best = i; }
    });
    const active = p.slots[p.active];
    const activeEmpty = !active?.weapon ||
      active.mag + ammoOf(p, WEAPONS[active.weapon as WeaponId].ammo) <= 0;
    // Mid-fight only switch away from a dry weapon; out of combat pick the best one.
    if (best !== p.active && (!enemy || activeEmpty)) {
      this.m.switchSlot(this.rt.id, best);
      this.switchAt = this.m.clock + 900;
    }
  }

  /** With both slots full the pickup replaces the active slot, so make the worse weapon active first. */
  private prepareSlotForPickup(p: Player): void {
    if (p.slots.some((s) => !s.weapon)) return;
    const value = (i: number) => {
      const s = p.slots[i]!;
      return WEAPON_VALUE[s.weapon as WeaponId] * (1 + 0.12 * s.rarity);
    };
    const worse = value(0) <= value(1) ? 0 : 1;
    if (worse !== p.active) this.m.switchSlot(this.rt.id, worse);
  }

  // ------------------------------------------------------------------ goals

  private shouldExtract(p: Player): boolean {
    if (this.m.state.phase !== "open") return false;
    if (this.m.clock > MATCH.DURATION_MS * 0.45 || p.hp < 35) return true;
    return carriedRefs(p).some((r) => r.rarity >= 1);
  }

  private goalValid(p: Player, g: Goal): boolean {
    if (this.m.clock - this.goalSince > GOAL_TIMEOUT_MS) {
      this.blacklist.set(g.id, this.m.clock + 30_000);
      return false;
    }
    switch (g.kind) {
      case "chest":
        return !this.m.state.chests.get(g.id)?.opened;
      case "item":
        return this.m.state.items.has(g.id);
      case "extract": {
        const e = this.m.state.extracts.get(g.id);
        return !!e && extractIsOpen(e, this.m.clock) && this.shouldExtract(p);
      }
      default:
        return true;
    }
  }

  private updateGoal(p: Player): void {
    const clock = this.m.clock;
    if (this.goal && !this.goalValid(p, this.goal)) this.goal = null;
    // Extraction overrides looting as soon as it becomes the plan.
    const extractNow = this.shouldExtract(p) && this.goal?.kind !== "extract";
    if (this.goal && clock < this.goalEvalAt && !extractNow) return;
    this.goalEvalAt = clock + GOAL_REEVAL_MS;
    const next = this.pickGoal(p);
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

  private pickGoal(p: Player): Goal | null {
    const clock = this.m.clock;
    for (const [k, until] of this.blacklist) if (until <= clock) this.blacklist.delete(k);

    if (this.shouldExtract(p)) {
      let best: Goal | null = null;
      let bestD = Infinity;
      for (const e of this.m.state.extracts.values()) {
        if (!extractIsOpen(e, clock) || this.blacklist.has(e.id)) continue;
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
    for (const c of this.m.state.chests.values()) {
      if (c.opened) continue;
      const d = Math.hypot(c.x - p.x, c.y - p.y);
      if (d < LOOT_RANGE) consider({ kind: "chest", id: c.id, x: c.x, y: c.y }, d * (1 - c.rarity * 0.1));
    }
    for (const it of this.m.state.items.values()) {
      const d = Math.hypot(it.x - p.x, it.y - p.y);
      if (d > LOOT_RANGE) continue;
      const want = this.itemWant(p, it);
      if (want <= 0) continue;
      consider({ kind: "item", id: it.id, x: it.x, y: it.y, needsInteract: it.kind === "weapon" || it.kind === "armor" }, d / want);
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
  private itemWant(p: Player, it: GroundItem): number {
    switch (it.kind) {
      case "weapon": {
        if (!(it.weapon in WEAPONS)) return 0;
        const def = WEAPONS[it.weapon as WeaponId];
        let value = WEAPON_VALUE[def.id] * (1 + 0.12 * it.rarity);
        if (ammoOf(p, def.ammo) + it.mag <= 0) value *= 0.5;
        let worst = Infinity;
        for (const s of p.slots) {
          const v = s.weapon ? WEAPON_VALUE[s.weapon as WeaponId] * (1 + 0.12 * s.rarity) : 0;
          worst = Math.min(worst, v);
        }
        return value > worst + 0.05 ? 1.3 : 0;
      }
      case "armor":
        return armorIsUpgrade(p, it.armor, it.armorDur) ? 1.3 : 0;
      case "ammo": {
        const type = it.ammoType as keyof typeof AMMO;
        if (!(type in AMMO)) return 0;
        const uses = p.slots.some((s) => s.weapon && WEAPONS[s.weapon as WeaponId].ammo === type);
        const have = ammoOf(p, type);
        if (!uses || have >= AMMO[type].maxCarry * 0.6) return 0;
        return have < AMMO[type].pickup ? 1.2 : 0.6;
      }
      case "bandage":
        return p.bandages < 4 ? 0.8 : 0;
      case "medkit":
        return p.medkits < HEAL.medkit.MAX_CARRY ? 1 : 0;
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

  private navigate(p: Player, tx: number, ty: number): void {
    const clock = this.m.clock;
    const moved = !this.pathFor || Math.hypot(this.pathFor.x - tx, this.pathFor.y - ty) > 80;
    if ((moved && clock >= this.replanMinAt) || clock >= this.replanAt) {
      this.path = navGridFor(this.m.map, this.m.idx).findPath(p, { x: tx, y: ty }) ?? [{ x: tx, y: ty }];
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
      if (d < 1 || this.clear(p, Math.atan2(q.y - p.y, q.x - p.x), d)) {
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
    const a = this.steer(p, desired, Math.min(70, d + 8));
    this.mx = Math.cos(a);
    this.my = Math.sin(a);
    this.wantMove = true;
    this.checkStuck(p, desired);
  }

  /** Probe ahead; if blocked try ±30/60/90/120/150°, preferring the side that worked last. */
  private steer(p: Player, desired: number, probe: number): number {
    const deg = Math.PI / 180;
    for (const off of [0, 30, 60, 90, 120, 150]) {
      for (const sign of off === 0 ? [1] : [this.side, -this.side]) {
        const a = desired + sign * off * deg;
        if (this.clear(p, a, probe)) {
          if (off >= 60) this.side = sign;
          return a;
        }
      }
    }
    return desired + Math.PI;
  }

  /** Is a body-wide corridor of length `probe` in direction `a` free of solids? */
  private clear(p: Player, a: number, probe: number): boolean {
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

  private checkStuck(p: Player, desired: number): void {
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
