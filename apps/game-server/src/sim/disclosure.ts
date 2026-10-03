/**
 * Deferred publication of world changes made by players (finding: public world state as a live
 * position marker). containerState is one unfiltered root array, and ground items / corpses reach
 * every view whose ±1792 px AOI ring holds them, with no line of sight: an OPENED / EMPTIED flip, a
 * floor item vanishing or changing quantity, a dropped item appearing or a corpse turning
 * opened / empty would tell a far client, in the same tick, that a hidden player stands right there.
 *
 * So such a change is applied to the server's truth at once (rules, NPCs and the actor's own
 * session use the truth) but published to the shared state only after every actor has been away
 * from the spot (farther than AWAY_PX, or dead / extracted) for QUIET_MS. A far client then learns
 * "someone was here and left a while ago", which is no finer than the sound it already heard.
 * Viewers that do see an actor get ground-item spawns / pickups at once through per-view AOI
 * restrictions (aoi.ts); container and corpse flags are a shared value, so they simply wait.
 */

import { VISION } from "@extract/shared";
import type { Match } from "./match.js";
import type { PlayerRuntime } from "./types.js";

export const DISCLOSE = {
  /** An actor closer than this to the spot keeps the change private (VISION.RANGE). */
  AWAY_PX: VISION.RANGE,
  /** ...and the change goes public this long after the last actor left. */
  QUIET_MS: 3_000,
} as const;

interface Pending {
  x: number;
  y: number;
  actors: Set<PlayerRuntime>;
  /** Earliest clock the change may go public. */
  at: number;
  publish: () => void;
}

export class Disclosure {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly m: Match) {}

  /**
   * Publish `publish` once every actor has left the spot. A second change under the same key
   * merges into the first (actors add up, the latest publish wins, the timer restarts).
   */
  defer(key: string, x: number, y: number, actors: Iterable<PlayerRuntime>, publish: () => void): void {
    const at = this.m.clock + DISCLOSE.QUIET_MS;
    const p = this.pending.get(key);
    if (p) {
      for (const a of actors) p.actors.add(a);
      p.publish = publish;
      p.at = Math.max(p.at, at);
      return;
    }
    this.pending.set(key, { x, y, actors: new Set(actors), at, publish });
  }

  has(key: string): boolean {
    return this.pending.has(key);
  }

  /** Per tick (Match.step, before vision / AOI): publish what is due. */
  step(): void {
    if (this.pending.size === 0) return;
    const clock = this.m.clock;
    const r2 = DISCLOSE.AWAY_PX * DISCLOSE.AWAY_PX;
    for (const [key, p] of this.pending) {
      let near = false;
      for (const a of p.actors) {
        if (a.pub.alive && (a.pub.x - p.x) ** 2 + (a.pub.y - p.y) ** 2 < r2) {
          near = true;
          break;
        }
      }
      if (near) {
        p.at = Math.max(p.at, clock + DISCLOSE.QUIET_MS);
        continue;
      }
      if (clock < p.at) continue;
      this.pending.delete(key);
      p.publish();
    }
  }

  /** Publish everything now (tests / tooling). */
  flush(): void {
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) p.publish();
  }
}
