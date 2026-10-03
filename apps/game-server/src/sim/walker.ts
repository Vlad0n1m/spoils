/**
 * Path following for agents that walk through the same input pipeline as a client (NPC brains,
 * scripted test / bench humans). Routes come from the region PathPlanner (budgeted per tick): while
 * a request waits in its queue the walker keeps its old route (or steers straight when it has
 * none); a windowed (partial) route is refreshed before its end; a target the planner calls
 * unreachable is steered at directly, and after a few failures (or when stuck) the owner is told
 * through `onGiveUp` so it can pick something else.
 *
 * Output is a unit direction (mx, my) the owner puts into its next InputSamples; the walker never
 * moves the player itself.
 */

import { PLAYER, SOLID, raycastSolids } from "@extract/shared";
import type { Match } from "./match.js";
import type { Pt } from "./nav.js";
import type { PlayerRuntime } from "./types.js";

/** Path refresh: periodic, and early when the end of a partial (windowed) route is near. */
const REPLAN_MS = 3000;
const WINDOW_REFRESH_PX = 600;
/** No 200 px of progress toward the navigation target in this long = stuck. */
const PROGRESS_MS = 12_000;

export class Walker {
  /** Desired movement direction (unit vector, or 0 / 0 when standing). */
  mx = 0;
  my = 0;
  /** The owner wants to move this decision (stuck detection only runs then). */
  wantMove = false;
  /** Walking (Shift): covers half the ground, so the stuck threshold halves too. */
  walk = false;
  /** Called when the walker gives up on its current target (stuck, or unreachable 3×). */
  onGiveUp: (() => void) | null = null;

  private side = 1;
  private path: Pt[] = [];
  private pathIdx = 0;
  private pathFor: Pt | null = null;
  private pathComplete = true;
  private replanAt = 0;
  private replanMinAt = 0;
  private unreachable = 0;
  private stuckAt = 0;
  private stuckPos: Pt = { x: 0, y: 0 };
  private stuckCount = 0;
  private detourUntil = 0;
  private detourAngle = 0;
  /** Progress watchdog: closest distance to the navigation target so far, and when it improved. */
  private progressFor: Pt | null = null;
  private progressBest = Infinity;
  private progressAt = 0;

  constructor(private readonly m: Match, private readonly rt: PlayerRuntime) {}

  /** Stand still. */
  stop(): void {
    this.mx = 0;
    this.my = 0;
    this.wantMove = false;
    this.stuckAt = this.m.clock + 800;
  }

  /** Head in direction `a` (strafing, backing off) without a route; obstacles count as stuck. */
  heading(a: number): void {
    this.mx = Math.cos(a);
    this.my = Math.sin(a);
    this.wantMove = true;
    this.checkStuck(a);
  }

  /** Waypoints still ahead on the current route (the last one is the target). */
  ahead(): readonly Pt[] {
    return this.path.slice(this.pathIdx);
  }

  /** Drop the agent's planner state (death). */
  forget(): void {
    this.m.planner.forget(this.rt.rosterIndex);
    this.path = [];
    this.pathFor = null;
  }

  /** Walk toward (tx, ty) along a planner route. */
  navigate(tx: number, ty: number): void {
    const p = this.rt.pub;
    const clock = this.m.clock;
    const moved = !this.pathFor || Math.hypot(this.pathFor.x - tx, this.pathFor.y - ty) > 80;
    if (moved) {
      this.stuckCount = 0;
      this.unreachable = 0;
    }
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
        if (moved || this.path.length === 0) this.direct(tx, ty);
        this.replanAt = clock + 150;
        this.replanMinAt = clock + 150;
      } else {
        this.direct(tx, ty);
        this.replanAt = clock + REPLAN_MS;
        this.replanMinAt = clock + 1000;
        if (++this.unreachable >= 3) {
          this.unreachable = 0;
          this.onGiveUp?.();
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

  private direct(tx: number, ty: number): void {
    this.path = [{ x: tx, y: ty }];
    this.pathComplete = true;
    this.pathIdx = 0;
    this.pathFor = { x: tx, y: ty };
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
  clear(a: number, probe: number): boolean {
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
   * Oscillating in front of an obstacle moves the agent but gets it nowhere: no 200 px of progress
   * toward the target in PROGRESS_MS counts as stuck (replan + detour; give up the second time).
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
    if (this.stuckCount >= 4) this.giveUp();
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
      if (this.stuckCount >= 4) this.giveUp();
    } else if (this.stuckCount > 0) {
      this.stuckCount--;
    }
  }

  private giveUp(): void {
    this.stuckCount = 0;
    this.onGiveUp?.();
  }

  private rand(min: number, max: number): number {
    return min + this.m.rng() * (max - min);
  }
}
