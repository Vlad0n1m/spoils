/**
 * Per-client event routing (critique "Shot, hit and event routing", fog memo §2.5, WP2): one
 * batched EventsMsg per client per tick, built from the tick's drained MatchEvents. Nothing here
 * may reveal a position the recipient's published vision row does not already show:
 *
 * - SHOT → the shooter and every recipient that sees the shooter get the full message. Anyone else
 *   whose VISION.RANGE circle the bullet path crosses (path cut at the first SHOT wall) gets a
 *   clipped copy: the tracer starts where the path enters their circle (spatial.ts), `s` = "",
 *   cx/cy = that entry point, and only the pellets that cross are kept. The gunshot audio always
 *   comes from the `snd` entries (sound.ts), never from SHOT, so nothing plays twice.
 * - HIT → the target (its copy carries `fa`, the quantized direction to the shooter), the shooter
 *   and every recipient that sees the target. `s` is blanked for recipients that do not see the
 *   shooter.
 * - KILL → everyone, names / ids only (the kill feed; no position).
 * - CHEST (a static container opened) → recipients whose AOI ring holds the container (its
 *   position is static map data and containerState is public anyway); `by` only for recipients
 *   that see the opener.
 * - snd → the listener it was built for (sound.ts deliverSounds already applied every rule).
 * Raw `sound` events are the sim's input to deliverSounds and are never forwarded.
 */

import {
  SOLID,
  VISION,
  WEAPONS,
  quantizeFa,
  raycastSolidsDDA,
  type EventsMsg,
  type ShotMsg,
  type SoundMsg,
} from "@extract/shared";
import { AoiSystem } from "./aoi.js";
import type { Match } from "./match.js";
import { clipRayToCircle } from "./spatial.js";
import type { MatchEvent } from "./types.js";

function batchOf(out: Map<number, EventsMsg>, r: number): EventsMsg {
  let b = out.get(r);
  if (!b) {
    b = {};
    out.set(r, b);
  }
  return b;
}

function mergeSnd(b: EventsMsg, msg: SoundMsg): void {
  const s = (b.snd ??= {});
  if (msg.h?.length) (s.h ??= []).push(...msg.h);
  if (msg.v?.length) (s.v ??= []).push(...msg.v);
}

interface Pellet {
  a: number;
  dx: number;
  dy: number;
  /** Path length until the first SHOT wall (or the weapon range). */
  len: number;
}

/** Bullet paths of a shot, from the shooter centre (where bullets really start, combat.ts). */
function pelletsOf(m: Match, msg: ShotMsg): Pellet[] {
  const range = WEAPONS[msg.w]?.range ?? 0;
  return msg.a.map((a) => {
    const dx = Math.cos(a), dy = Math.sin(a);
    const t = raycastSolidsDDA(m.idx, msg.cx, msg.cy, msg.cx + dx * range, msg.cy + dy * range, SOLID.SHOT);
    return { a, dx, dy, len: t === Infinity ? range : t * range };
  });
}

/**
 * The clipped copy of a hidden shooter's shot for a listener at (lx, ly), or null when no pellet
 * path crosses the listener's view circle.
 */
export function clipShot(msg: ShotMsg, pellets: readonly Pellet[], lx: number, ly: number): ShotMsg | null {
  let best = Infinity;
  const a: number[] = [];
  for (const p of pellets) {
    const t = clipRayToCircle(msg.cx, msg.cy, p.dx, p.dy, p.len, lx, ly, VISION.RANGE);
    if (t === null) continue;
    a.push(p.a);
    if (t < best) best = t;
  }
  if (a.length === 0) return null;
  // One start point for the kept pellets: the earliest entry (pellets diverge by < spread).
  const first = pellets.find((p) => p.a === a[0])!;
  const x = msg.cx + first.dx * best, y = msg.cy + first.dy * best;
  return { s: "", w: msg.w, x, y, cx: x, cy: y, a };
}

/**
 * Batches for `recipients` (roster indexes of connected humans). Recipients with nothing this tick
 * are absent from the result (the room sends nothing to them).
 */
export function buildBatches(m: Match, events: readonly MatchEvent[], recipients: readonly number[]): Map<number, EventsMsg> {
  const out = new Map<number, EventsMsg>();
  if (recipients.length === 0) return out;
  const vision = m.vision;
  const pos = (r: number) => m.rosterRuntime(r)?.pub;
  for (const ev of events) {
    switch (ev.type) {
      case "shot": {
        let pellets: Pellet[] | null = null;
        for (const r of recipients) {
          if (r === ev.src || vision.sees(r, ev.src)) {
            (batchOf(out, r).shots ??= []).push(ev.msg);
            continue;
          }
          const l = pos(r);
          if (!l) continue;
          pellets ??= pelletsOf(m, ev.msg);
          const clipped = clipShot(ev.msg, pellets, l.x, l.y);
          if (clipped) (batchOf(out, r).shots ??= []).push(clipped);
        }
        break;
      }
      case "hit":
        for (const r of recipients) {
          const isTarget = r === ev.target;
          if (!isTarget && r !== ev.src && !vision.sees(r, ev.target)) continue;
          const knowsShooter = ev.src >= 0 && (r === ev.src || vision.sees(r, ev.src));
          let msg = knowsShooter || ev.msg.s === "" ? ev.msg : { ...ev.msg, s: "" };
          if (isTarget && ev.fa !== undefined) msg = { ...msg, fa: quantizeFa(ev.fa) };
          (batchOf(out, r).hits ??= []).push(msg);
        }
        break;
      case "kill":
        for (const r of recipients) (batchOf(out, r).kills ??= []).push(ev.msg);
        break;
      case "chest": {
        const spot = m.map.containers[ev.idx];
        const by = m.rosterRuntime(ev.src)?.id;
        for (const r of recipients) {
          const l = pos(r);
          if (spot && l && !AoiSystem.ringContains(l.x, l.y, spot.x, spot.y)) continue;
          const seen = by !== undefined && (r === ev.src || vision.sees(r, ev.src));
          (batchOf(out, r).chest ??= []).push(seen ? { idx: ev.idx, by } : { idx: ev.idx });
        }
        break;
      }
      case "snd":
        if (recipients.includes(ev.to)) mergeSnd(batchOf(out, ev.to), ev.msg);
        break;
      default:
        break;
    }
  }
  // Drop batches that ended up empty (e.g. a sound object with no entries).
  for (const [r, b] of out) {
    if (b.snd && !b.snd.h?.length && !b.snd.v?.length) delete b.snd;
    if (Object.keys(b).length === 0) out.delete(r);
  }
  return out;
}
