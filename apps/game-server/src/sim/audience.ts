/**
 * Per-client event routing (critique "Shot, hit and event routing", fog memo §2.5, WP2): one
 * batched EventsMsg per client per tick, built from the tick's drained MatchEvents. Nothing here
 * may reveal a position the recipient's published vision row does not already show:
 *
 * - SHOT → the shooter and every recipient that sees the shooter get the full message. Anyone else
 *   whose VISION.RANGE circle the bullet path crosses (path cut at the first SHOT wall) gets a
 *   clipped copy: the tracer starts where the path enters their circle (spatial.ts), `s` = "",
 *   cx/cy = that entry point, and only the pellets that cross are kept. The copy is blurred per
 *   recipient and shot (start shifted sideways, angles turned the other way, CLIP_BLUR): an exact
 *   point plus an exact angle is a line through the hidden shooter, and two such lines would
 *   intersect right on them. The gunshot audio always comes from the `snd` entries (sound.ts),
 *   never from SHOT, so nothing plays twice.
 * - Recipients that left the map (dead / extracted) before this tick get no shot, hit or chest
 *   events at all (no spectating): only the kill feed and their personal sends.
 * - HIT → the target (its copy carries `fa`, the quantized direction to the shooter), the shooter
 *   and every recipient that sees the target. `s` is blanked for recipients that do not see the
 *   shooter. An area hit (grenade, MatchEvent.area) whose attacker does not see the target gives the
 *   attacker only a position-less copy: t = "", x/y = the blast centre, d = 0 ("hit confirmed").
 * - KILL → everyone, names / ids / roles only (the kill feed; no position) — except a marauder or
 *   guard death, which goes to its killer only (a personal "You ✕ Marauder" row: NPC deaths must
 *   not become a map-wide radar of who is fighting where). Boss and human deaths are broadcast.
 * - CHEST (a static container opened) → the opener and recipients that see the opener (with `by`).
 *   Everyone else learns it from the lid sound and, later, the deferred containerState flip.
 * - snd → the listener it was built for (sound.ts deliverSounds already applied every rule).
 * - nade / boom (Weapons v2 grenades) → the recipient they were built for (grenade.ts applied the
 *   rules: the full flight only to those who see the thrower, a resting copy to those who see it).
 * Raw `sound` events are the sim's input to deliverSounds and are never forwarded.
 */

import {
  NPC_ROLE,
  SOLID,
  VISION,
  WEAPONS,
  quantizeFa,
  raycastSolidsDDA,
  type EventsMsg,
  type ShotMsg,
  type SoundMsg,
} from "@extract/shared";
import { getRandomValues } from "node:crypto";
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
 * Blur of a clipped tracer (finding: two exact lines triangulate the hidden shooter). Per recipient
 * and shot: the start point moves sideways by SHIFT px and every kept angle turns by TURN rad, in
 * opposite senses so both push the line's back-extension the same way off the shooter: the line
 * misses them by ≥ MIN_SHIFT_PX + d·sin(MIN_TURN) (d = shooter → start), and two shots no longer
 * intersect on them. The start never gets closer to the shooter (the shift is perpendicular).
 */
export const CLIP_BLUR = {
  MIN_SHIFT_PX: 24,
  MAX_SHIFT_PX: 64,
  MIN_TURN: (3 * Math.PI) / 180,
  MAX_TURN: (8 * Math.PI) / 180,
} as const;

/** Uniform [0, 1) from the CSPRNG: the blur must not be predictable from the protocol. */
const rnd = new Uint32Array(1);
export function secureRandom(): number {
  getRandomValues(rnd);
  return rnd[0]! / 2 ** 32;
}

/**
 * The clipped copy of a hidden shooter's shot for a listener at (lx, ly), or null when no pellet
 * path crosses the listener's view circle. `rand` draws the blur (CLIP_BLUR); null = exact
 * geometry (tests of the clipping itself).
 */
export function clipShot(
  msg: ShotMsg,
  pellets: readonly Pellet[],
  lx: number,
  ly: number,
  rand: (() => number) | null = secureRandom,
): ShotMsg | null {
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
  let x = msg.cx + first.dx * best, y = msg.cy + first.dy * best;
  if (rand) {
    const sign = rand() < 0.5 ? -1 : 1;
    const shift = CLIP_BLUR.MIN_SHIFT_PX + rand() * (CLIP_BLUR.MAX_SHIFT_PX - CLIP_BLUR.MIN_SHIFT_PX);
    const turn = CLIP_BLUR.MIN_TURN + rand() * (CLIP_BLUR.MAX_TURN - CLIP_BLUR.MIN_TURN);
    // Left normal of the tracer; shift one way, turn the other (both move the back-extension the same way).
    x += -first.dy * shift * sign;
    y += first.dx * shift * sign;
    for (let i = 0; i < a.length; i++) a[i] = a[i]! - sign * turn;
  }
  return { s: "", w: msg.w, x, y, cx: x, cy: y, a };
}

/**
 * Left the map before this tick (dead / extracted): no more world events. The tick of the death or
 * extraction itself still counts as on the map (the killing shot, the own corpse).
 */
export function offMap(m: Match, r: number): boolean {
  const rt = m.rosterRuntime(r);
  if (!rt || rt.pub.alive) return false;
  return !rt.exitReport || rt.exitReport.atMs < m.clock;
}

/**
 * Batches for `recipients` (roster indexes of connected humans). Recipients with nothing this tick
 * are absent from the result (the room sends nothing to them). `rand` draws the clipped-tracer blur.
 */
export function buildBatches(
  m: Match,
  events: readonly MatchEvent[],
  recipients: readonly number[],
  rand: (() => number) | null = secureRandom,
): Map<number, EventsMsg> {
  const out = new Map<number, EventsMsg>();
  if (recipients.length === 0) return out;
  const vision = m.vision;
  const pos = (r: number) => m.rosterRuntime(r)?.pub;
  // Shot / hit / chest audiences: only players still on the map (no spectating after death).
  const onMap = recipients.filter((r) => !offMap(m, r));
  for (const ev of events) {
    switch (ev.type) {
      case "shot": {
        let pellets: Pellet[] | null = null;
        for (const r of onMap) {
          if (r === ev.src || vision.sees(r, ev.src)) {
            (batchOf(out, r).shots ??= []).push(ev.msg);
            continue;
          }
          const l = pos(r);
          if (!l) continue;
          pellets ??= pelletsOf(m, ev.msg);
          const clipped = clipShot(ev.msg, pellets, l.x, l.y, rand);
          if (clipped) (batchOf(out, r).shots ??= []).push(clipped);
        }
        break;
      }
      case "hit":
        for (const r of recipients) {
          const isTarget = r === ev.target;
          const seesTarget = isTarget || vision.sees(r, ev.target);
          if (!isTarget && (offMap(m, r) || (r !== ev.src && !seesTarget))) continue;
          if (!seesTarget && ev.area) {
            // The thrower of a grenade that hurt someone they do not see: "hit confirmed" only. The
            // target's id, spot and HP loss would turn every blast into a 240 px scan through bushes
            // and sight-blocking fences; the blast centre is already theirs.
            (batchOf(out, r).hits ??= []).push({ t: "", s: ev.msg.s, x: Math.round(ev.area.x * 10) / 10, y: Math.round(ev.area.y * 10) / 10, d: 0, ar: false });
            continue;
          }
          const knowsShooter = ev.src >= 0 && (r === ev.src || vision.sees(r, ev.src));
          let msg = knowsShooter || ev.msg.s === "" ? ev.msg : { ...ev.msg, s: "" };
          if (isTarget && ev.fa !== undefined) msg = { ...msg, fa: quantizeFa(ev.fa) };
          (batchOf(out, r).hits ??= []).push(msg);
        }
        break;
      case "kill": {
        const role = ev.msg.victimRole ?? NPC_ROLE.NONE;
        const personal = role === NPC_ROLE.GUARD || role === NPC_ROLE.MARAUDER;
        for (const r of recipients) {
          if (personal && r !== ev.src) continue;
          (batchOf(out, r).kills ??= []).push(ev.msg);
        }
        break;
      }
      case "chest": {
        // Only the opener and those who see them: anyone else would learn that a hidden player
        // stands at a known container right now. They hear the lid (sound.ts) and see the
        // container flip once containerState is published (containers.ts, deferred).
        const by = m.rosterRuntime(ev.src)?.id;
        for (const r of onMap) {
          if (by === undefined || (r !== ev.src && !vision.sees(r, ev.src))) continue;
          (batchOf(out, r).chest ??= []).push({ idx: ev.idx, by });
        }
        break;
      }
      case "snd":
        if (recipients.includes(ev.to)) mergeSnd(batchOf(out, ev.to), ev.msg);
        break;
      case "nade":
        if (recipients.includes(ev.to)) (batchOf(out, ev.to).nades ??= []).push(ev.msg);
        break;
      case "boom":
        if (recipients.includes(ev.to)) (batchOf(out, ev.to).booms ??= []).push(ev.msg);
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
