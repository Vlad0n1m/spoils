/**
 * Server vision (fog memo §2.3, WP2): who receives whom. Indexed by rosterIndex everywhere —
 * sessionIds change on reconnect (attachHuman re-keys), roster indexes never do.
 *
 * Every tick, at the end of Match.step (positions, shots and deaths of this tick are final):
 * for every alive viewer i and every target j, shared `canSee` decides raw visibility (range ×
 * env.vis, 105° server cone + 110 px awareness, bush concealment, muzzle-flash / shot reveal, SIGHT
 * DDA rays from the centre and a velocity lead eye). A target stays *published* for
 * VISION.HYSTERESIS_MS after the last raw sighting, so a jittery corner does not add/remove the
 * Player every other tick, and a target that dies is still sent for one more patch with
 * alive = false before it drops out (the client plays the death and fades the body).
 *
 * The published matrix is the single truth for every consumer: StateView rows (views.ts), event
 * audiences (audience.ts), visible-vs-hidden sound entries (sound.ts) and, from WP-G, bots.
 * Bot viewers use VISION.BOT_RANGE_CAP so their tuning stays as before.
 *
 * Cost (32 players clustered on the Steppe): well under the 0.2 ms budget — most pairs are rejected
 * by the squared-distance test, the rest early-out on the first clear ray (vision.test.ts bench).
 */

import { VISION, bushIndexAt, canSee, visionRangeMult, type VisionEnv, type VisionTarget, type VisionViewer } from "@extract/shared";
import { envNow } from "./environment.js";
import type { Match } from "./match.js";

/** One published-row flip: viewer i starts / stops receiving target j. */
export interface VisionChange {
  viewer: number;
  target: number;
  on: boolean;
}

interface Pre extends VisionViewer, VisionTarget {
  onMap: boolean;
  bot: boolean;
}

export class VisionSystem {
  /** Last clock viewer i raw-saw target j (k = i*n + j); -Infinity = never. */
  private readonly lastSeen: Float64Array;
  /** 1 = viewer i currently receives target j. */
  private readonly published: Uint8Array;
  /** Flips of the latest update() (and clearRow calls since): consumers that care drain them. */
  private changes: VisionChange[] = [];
  /** Per-target scratch rebuilt every update (no per-tick allocation after the first). */
  private readonly pre: Pre[];

  constructor(readonly n: number) {
    this.lastSeen = new Float64Array(n * n).fill(-Infinity);
    this.published = new Uint8Array(n * n);
    this.pre = Array.from({ length: n }, () => ({
      x: 0, y: 0, aim: 0, vx: 0, vy: 0, inBush: false, stillMs: 0, sinceShotMs: Infinity, onMap: false, bot: false,
    }));
  }

  /** Recompute visibility. Called every tick at the end of Match.step (after vx/vy are known). */
  update(m: Match): void {
    // Changes are per tick: whoever cares (tests, views) drains them right after the step.
    this.changes = [];
    const n = this.n;
    const clock = m.clock;
    const rangeMult = visionRangeMult(envNow(m).vis);
    const human: VisionEnv = { idx: m.idx, rangeMult };
    const bot: VisionEnv = { idx: m.idx, rangeMult, rangeCap: VISION.BOT_RANGE_CAP };
    const rts = m.allRuntimes();
    for (let j = 0; j < n; j++) {
      const rt = rts[j];
      const q = this.pre[j]!;
      if (!rt) {
        q.onMap = false;
        continue;
      }
      const p = rt.pub;
      q.onMap = p.alive;
      q.bot = rt.isBot;
      q.x = p.x;
      q.y = p.y;
      q.aim = p.aim;
      q.vx = rt.vx;
      q.vy = rt.vy;
      q.inBush = p.alive && bushIndexAt(m.bushIndex, p.x, p.y) >= 0;
      q.stillMs = clock - rt.movedAt;
      q.sinceShotMs = clock - rt.lastShotAt;
    }
    for (let i = 0; i < n; i++) {
      const v = this.pre[i]!;
      // Dead / extracted viewers keep the row clearRow emptied: no spectating.
      if (!v.onMap) continue;
      const env = v.bot ? bot : human;
      const row = i * n;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const k = row + j;
        const t = this.pre[j]!;
        if (t.onMap && canSee(env, v, t)) this.lastSeen[k] = clock;
        const want = clock - this.lastSeen[k]! <= VISION.HYSTERESIS_MS ? 1 : 0;
        if (want !== this.published[k]) {
          this.published[k] = want;
          this.changes.push({ viewer: i, target: j, on: want === 1 });
        }
      }
    }
  }

  /** Does roster i currently receive roster j (published, with hysteresis)? Self is always "seen". */
  sees(i: number, j: number): boolean {
    if (i === j) return true;
    if (i < 0 || j < 0 || i >= this.n || j >= this.n) return false;
    return this.published[i * this.n + j] === 1;
  }

  /** Roster indexes viewer i currently receives (its published row), excluding itself. */
  row(i: number): number[] {
    const out: number[] = [];
    if (i < 0 || i >= this.n) return out;
    for (let j = 0; j < this.n; j++) if (j !== i && this.published[i * this.n + j] === 1) out.push(j);
    return out;
  }

  /** Flips of the last update (plus clearRow flips since), then forgets them. */
  drainChanges(): VisionChange[] {
    const out = this.changes;
    this.changes = [];
    return out;
  }

  /**
   * A dead or extracted viewer stops seeing (no spectating): its row is emptied once and update()
   * skips it from then on. The target column is untouched — others still get the final patch.
   */
  clearRow(i: number): void {
    if (i < 0 || i >= this.n) return;
    const row = i * this.n;
    for (let j = 0; j < this.n; j++) {
      this.lastSeen[row + j] = -Infinity;
      if (this.published[row + j] === 1) {
        this.published[row + j] = 0;
        this.changes.push({ viewer: i, target: j, on: false });
      }
    }
  }
}
