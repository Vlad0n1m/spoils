/**
 * Pure helpers for drawing other players' combat events (no Pixi, no DOM, unit-tested):
 * - where a shot really starts and how far each tracer may fly (the server's bullet rules);
 * - a small delay queue that plays remote events on the same ~100 ms-late timeline as remote bodies.
 */

import { raycastSolids, type CollisionIndex, type ShotMsg } from "@extract/shared";

/**
 * Centre of the shooter when the shot was fired. The server spawns pellets there (not at the
 * muzzle) and stops them at the first wall from there. ShotMsg carries the muzzle point
 * (centre + aim * muzzle); when the message also carries the centre (`cx`, `cy`) it is used as is,
 * otherwise the centre is recovered from the muzzle along the mean pellet angle (off by at most
 * muzzle * spread, a few px, because the server used the aim and pellets deviate from it).
 */
export function shotCentre(m: ShotMsg, muzzle: number): { x: number; y: number } {
  if (Number.isFinite(m.cx) && Number.isFinite(m.cy)) return { x: m.cx, y: m.cy };
  if (!m.a.length) return { x: m.x, y: m.y };
  const a = m.a.reduce((s, v) => s + v, 0) / m.a.length;
  return { x: m.x - Math.cos(a) * muzzle, y: m.y - Math.sin(a) * muzzle };
}

/**
 * Tracer length drawn from the muzzle (mx, my) for every pellet angle, following the server's
 * bullets: each one starts at the centre (cx, cy), flies `range` and stops at the first solid.
 * Returns null when a solid lies between the centre and the muzzle (the gun pokes through a wall):
 * the server's bullets stop at once, so neither a tracer nor a muzzle flash may be drawn there.
 */
export function tracerLengths(
  idx: CollisionIndex | null,
  cx: number,
  cy: number,
  mx: number,
  my: number,
  angles: number[],
  range: number,
): number[] | null {
  if (idx && (mx !== cx || my !== cy) && raycastSolids(idx, cx, cy, mx, my) !== Infinity) return null;
  return angles.map((a) => {
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    let reach = range;
    if (idx) {
      const t = raycastSolids(idx, cx, cy, cx + dx * range, cy + dy * range);
      if (t !== Infinity) reach = range * t;
    }
    // The tracer is drawn from the muzzle, which is already this far along the pellet's path.
    const muzzleAlong = (mx - cx) * dx + (my - cy) * dy;
    return Math.max(0, reach - muzzleAlong);
  });
}

/**
 * Runs callbacks no earlier than their due time, in the order they were queued. Bounded: while
 * nothing flushes it (a hidden tab stops the ticker) the oldest entries are dropped.
 */
export class DelayQueue {
  private queue: Array<{ at: number; run: (now: number) => void }> = [];

  constructor(private readonly max = 512) {}

  get size(): number {
    return this.queue.length;
  }

  push(at: number, run: (now: number) => void): void {
    this.queue.push({ at, run });
    if (this.queue.length > this.max) this.queue.splice(0, this.queue.length - this.max);
  }

  /** Runs everything due at `now`. Stops at the first entry that is not due, to keep the order. */
  flush(now: number): void {
    let n = 0;
    while (n < this.queue.length && this.queue[n]!.at <= now) n++;
    if (n === 0) return;
    for (const e of this.queue.splice(0, n)) e.run(now);
  }

  clear(): void {
    this.queue.length = 0;
  }
}
