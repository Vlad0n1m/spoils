/**
 * PathPlanner: the one place NPCs and scripted humans get paths from (map memo §8, critique "region nav + planner").
 *
 * A request runs coarse A* over the region graph, then fine A* restricted to a *window* of the
 * region path (the first regions until WINDOW_MIN_PX of centroid travel, at least WINDOW_MIN and at
 * most WINDOW_MAX regions) plus a 1-region ring. Long routes therefore cost about as much as short
 * ones (~0.1–0.3 ms); the agent re-requests before it runs out of window and the cached region path
 * is reused, so a refinement skips the coarse search.
 *
 * Budget: all queries of one tick share PERF_BUDGET.PATH_PLAN_MS_PER_TICK, accounted in node
 * expansions (WORK_PER_MS, calibrated on the Steppe) rather than wall-clock time, so seeded matches
 * stay deterministic. A request that finds the tick's budget spent is queued (FIFO, one entry per
 * agent); the queue is served first thing in the next tick that has budget and the result waits in
 * `poll()` / the next `request()` of that agent. Waiting agents keep their old path or steer
 * straight. Ticks are detected from the match clock, so the sim loop needs no extra hook.
 */

import { PERF_BUDGET } from "@extract/shared";
import type { Pt } from "./nav.js";
import type { RegionGraph } from "./regions.js";

/**
 * Node expansions per millisecond of planning (measured on an M3 Pro: fine corridor A* ≈ 25–35
 * expansions/µs·10⁻³ incl. setup; see planner.test.ts). Conservative so the budget is met on
 * slower hosts too.
 */
export const WORK_PER_MS = 6_000;
/** Window: at least this many regions ahead (map memo K = 4) … */
export const WINDOW_MIN = 4;
/** … and at least this much centroid travel, so a window outlasts the walkers' 3 s replan period. */
export const WINDOW_MIN_PX = 1800;
export const WINDOW_MAX = 12;
/** Start / goal points this close to a walkable cell still plan (players hug walls, chests sit in them). */
const SNAP_PX = 128;
/** A queued result is still good for a re-request whose target moved at most this much. */
const SAME_TARGET_PX = 64;

export type PlanResult =
  | {
      status: "ok";
      /**
       * Waypoints after the start (direction changes of the fine path). When `complete`, the last
       * point is exactly the requested target; otherwise the window ends inside the route and the
       * target itself is appended as the final point (so callers that retarget path[last] keep
       * working), and the agent must re-request before it reaches the window end.
       */
      path: Pt[];
      complete: boolean;
    }
  | { status: "pending" }
  | { status: "unreachable" };

interface Queued {
  agent: number;
  from: Pt;
  to: Pt;
}

interface Route {
  goalRegion: number;
  regions: number[];
}

export interface PlannerStats {
  requests: number;
  served: number;
  unreachable: number;
  /** Requests that had to wait for a later tick. */
  deferred: number;
  /** Requests answered from a cached region route (no coarse search). */
  routeHits: number;
  /** Most work units (expansions) spent in one tick, and the wall time of that tick's planning. */
  maxTickWork: number;
  maxTickMs: number;
  /** Wall-clock ms per served query (for perf tests; capped ring of the last 4096). */
  queryMs: number[];
}

export class PathPlanner {
  readonly budgetWork: number;
  readonly stats: PlannerStats = {
    requests: 0, served: 0, unreachable: 0, deferred: 0, routeHits: 0, maxTickWork: 0, maxTickMs: 0, queryMs: [],
  };
  private readonly queue: Queued[] = [];
  private readonly ready = new Map<number, { to: Pt; result: PlanResult }>();
  private readonly routes = new Map<number, Route>();
  private tickAt = Number.NaN;
  private tickWork = 0;
  private tickMs = 0;

  constructor(
    readonly regions: RegionGraph,
    private readonly clock: () => number,
    budgetMs: number = PERF_BUDGET.PATH_PLAN_MS_PER_TICK,
  ) {
    this.budgetWork = Math.max(1, Math.round(budgetMs * WORK_PER_MS));
  }

  /** Work left in the current tick (tests / debug overlay). */
  get remaining(): number {
    this.rollTick();
    return Math.max(0, this.budgetWork - this.tickWork);
  }

  get queued(): number {
    return this.queue.length;
  }

  /**
   * Plan `agent` from → to. Answers synchronously while the tick has budget, otherwise queues the
   * request ("pending"); a queued result is returned by the agent's next request() for (about) the
   * same target, or by poll().
   */
  request(agent: number, from: Pt, to: Pt): PlanResult {
    this.rollTick();
    this.stats.requests++;
    const done = this.ready.get(agent);
    if (done) {
      this.ready.delete(agent);
      if (near(done.to, to)) return retarget(done.result, to);
    }
    const q = this.queue.find((e) => e.agent === agent);
    if (q) {
      // Keep its place in the line, plan for the newest positions.
      q.from = from;
      q.to = to;
      return { status: "pending" };
    }
    if (this.tickWork >= this.budgetWork) {
      this.stats.deferred++;
      this.queue.push({ agent, from, to });
      return { status: "pending" };
    }
    return this.solve(agent, from, to);
  }

  /** Result of a queued request once served (consumed), else null. */
  poll(agent: number): PlanResult | null {
    this.rollTick();
    const done = this.ready.get(agent);
    if (!done) return null;
    this.ready.delete(agent);
    return done.result;
  }

  /**
   * Bot convenience: waypoints, or null while pending / unreachable (the caller falls back to
   * steering straight at the target, as v1 did on an A* failure).
   */
  path(agent: number, from: Pt, to: Pt): Pt[] | null {
    const r = this.request(agent, from, to);
    return r.status === "ok" ? r.path : null;
  }

  /** Forget an agent (death, extraction): drops its queue entry, result and cached route. */
  forget(agent: number): void {
    const i = this.queue.findIndex((e) => e.agent === agent);
    if (i >= 0) this.queue.splice(i, 1);
    this.ready.delete(agent);
    this.routes.delete(agent);
  }

  /** New tick (clock changed): reset the budget, then serve the queue before any new request. */
  private rollTick(): void {
    const now = this.clock();
    if (now === this.tickAt) return;
    this.tickAt = now;
    this.tickWork = 0;
    this.tickMs = 0;
    while (this.queue.length > 0 && this.tickWork < this.budgetWork) {
      const q = this.queue.shift()!;
      this.ready.set(q.agent, { to: q.to, result: this.solve(q.agent, q.from, q.to) });
    }
  }

  private solve(agent: number, from: Pt, to: Pt): PlanResult {
    const g = this.regions;
    const t0 = performance.now();
    const w0 = g.work;
    const result = this.plan(agent, from, to);
    const ms = performance.now() - t0;
    this.tickWork += g.work - w0 + 1;
    this.tickMs += ms;
    if (this.tickWork > this.stats.maxTickWork) this.stats.maxTickWork = this.tickWork;
    if (this.tickMs > this.stats.maxTickMs) this.stats.maxTickMs = this.tickMs;
    const qm = this.stats.queryMs;
    if (qm.length >= 4096) qm.shift();
    qm.push(ms);
    this.stats.served++;
    if (result.status === "unreachable") this.stats.unreachable++;
    return result;
  }

  private plan(agent: number, from: Pt, to: Pt): PlanResult {
    const g = this.regions;
    const a = g.cellAt(from.x, from.y, SNAP_PX);
    const b = g.cellAt(to.x, to.y, SNAP_PX);
    if (a < 0 || b < 0) return { status: "unreachable" };
    const ra = g.region[a]!;
    const rb = g.region[b]!;
    if (!g.connected(ra, rb)) {
      this.routes.delete(agent);
      return { status: "unreachable" };
    }

    // Region route: reuse the cached one when the agent is still on it (window refinement).
    let rp: number[] | null = null;
    const cached = this.routes.get(agent);
    if (cached && cached.goalRegion === rb) {
      const j = cached.regions.indexOf(ra);
      if (j >= 0) {
        rp = cached.regions.slice(j);
        this.stats.routeHits++;
      }
    }
    if (!rp) {
      rp = g.coarse(ra, rb);
      if (!rp) return { status: "unreachable" };
    }
    this.routes.set(agent, { goalRegion: rb, regions: rp });

    // Window: regions ahead until WINDOW_MIN regions and WINDOW_MIN_PX of travel (≤ WINDOW_MAX).
    let end = 0;
    let travel = 0;
    while (end < rp.length - 1 && end < WINDOW_MAX && (end < WINDOW_MIN || travel < WINDOW_MIN_PX)) {
      const r0 = rp[end]!, r1 = rp[end + 1]!;
      travel += Math.sqrt((g.cx[r1]! - g.cx[r0]!) ** 2 + (g.cy[r1]! - g.cy[r0]!) ** 2);
      end++;
    }
    const complete = end === rp.length - 1;
    const goalCell = complete ? b : g.repCell[rp[end]!]!;
    const cells = g.fine(a, goalCell, rp.slice(0, end + 1));
    if (!cells) return { status: "unreachable" };

    const path = compress(g, cells);
    if (complete) {
      if (path.length === 0) path.push({ x: to.x, y: to.y });
      else path[path.length - 1] = { x: to.x, y: to.y };
    } else {
      path.push({ x: to.x, y: to.y });
    }
    return { status: "ok", path, complete };
  }
}

/** Cell centres where the fine path turns (plus its end), skipping the start cell. */
function compress(g: RegionGraph, cells: readonly number[]): Pt[] {
  const out: Pt[] = [];
  const cols = g.cols;
  for (let k = 1; k < cells.length; k++) {
    const c = cells[k]!;
    const next = cells[k + 1];
    if (next !== undefined) {
      const prev = cells[k - 1]!;
      const d1 = c - prev;
      const d2 = next - c;
      // Same step (same dx and dy) on both sides: a straight run, the point adds nothing.
      if (d1 === d2 && Math.abs((c % cols) - (prev % cols)) <= 1) continue;
    }
    out.push({ x: g.cellX(c), y: g.cellY(c) });
  }
  return out;
}

function near(a: Pt, b: Pt): boolean {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy <= SAME_TARGET_PX * SAME_TARGET_PX;
}

/** A served result for a slightly moved target: aim its end at the new target. */
function retarget(r: PlanResult, to: Pt): PlanResult {
  if (r.status !== "ok" || r.path.length === 0) return r;
  const path = r.path.slice();
  path[path.length - 1] = { x: to.x, y: to.y };
  return { ...r, path };
}
