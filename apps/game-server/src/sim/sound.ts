/**
 * Sound server (critique "Sound contract", mobility memo Part 3–4, WP3).
 *
 * Emission: the sim calls emitSound wherever something audible happens. Each call queues a pending
 * sound {src, kind, x, y, base radius, variant} for this match (positions captured at emit time,
 * so a death sound still plays after the body is gone) and also emits a raw `sound` MatchEvent
 * (tests, debugging, and NPC hearing through heardBy). Raw events are never sent to clients.
 *
 * Delivery (deliverSounds, end of Match.step, after vision.update so "visible" agrees with the
 * patch cut in the same tick): for every alive listener other than the source —
 *   1. R = base radius × env.hear (footsteps were already scaled by the surface stepRangeMult);
 *      cheap squared-distance reject;
 *   2. listener sees the source (published vision row) → visible entry [kind, sessionId, variant]:
 *      the client places it on the entity it already renders;
 *   3. otherwise → hidden entry [kind, sector, band | occluded<<2, variant] from quantizeSound,
 *      where the occlusion is soundOcclusion: a ray against the walls-only index (crates, cars
 *      and trees never muffle). A solid wall → `occluded`, OCCLUSION_MULT× farther, so it may drop
 *      out; windows only (an opening in the wall) → WINDOW_MULT× farther, not flagged.
 *      Hidden entries never carry coordinates or ids: moving the source anywhere inside one
 *      (sector, band) bucket gives a byte-identical payload.
 *   Per listener per tick: dedupe identical entries, cap at SOUND.MAX_PER_TICK by SOUND_PRIORITY,
 *   then one `snd` event (humans; the room merges it into that client's `ev` batch) or the NPC's
 *   heardBy list (WP-G investigates from it). Dead / extracted listeners hear nothing.
 *
 * Sounds emitted between ticks (reload / heal / switch / interact messages) wait in the queue and go
 * out with the next tick, ≤ 50 ms later.
 */

import {
  OCCLUSION,
  SOUND,
  SOUND_PRIORITY,
  SoundKind,
  baseSoundRadius,
  bushIndexAt,
  decodeSoundMsg,
  getWallIndex,
  occlusionMult,
  pushHiddenSound,
  pushVisibleSound,
  quantizeSound,
  soundOcclusion,
  surfaceAt,
  type DecodedSound,
  type SoundMsg,
} from "@extract/shared";
import { envNow } from "./environment.js";
import type { Match } from "./match.js";
import type { PlayerRuntime } from "./types.js";

/** One emitted, not yet delivered sound. `radius` is before env.hear. */
export interface PendingSound {
  /** Source rosterIndex; -1 = a world sound (always hidden). */
  src: number;
  kind: SoundKind;
  x: number;
  y: number;
  radius: number;
  variant: number;
}

interface SoundRuntime {
  pending: PendingSound[];
  /** What each NPC heard in the last delivery (rosterIndex → decoded entries). */
  heard: Map<number, DecodedSound[]>;
}

/** Per-match sound state, kept here so Match needs no sound fields. */
const runtimes = new WeakMap<Match, SoundRuntime>();

function soundRt(m: Match): SoundRuntime {
  let s = runtimes.get(m);
  if (!s) {
    s = { pending: [], heard: new Map() };
    runtimes.set(m, s);
  }
  return s;
}

/**
 * Emit one sound. `src` = the player making it (null = world). Steps carry the surface material as
 * the variant and are scaled by its stepRangeMult; shots carry the weapon index (weaponVariant).
 */
export function emitSound(
  m: Match,
  src: PlayerRuntime | null,
  kind: SoundKind,
  x: number,
  y: number,
  variant = 0,
  opts: { walk?: boolean; rangeMult?: number } = {},
): void {
  const radius = baseSoundRadius(kind, variant, opts.walk === true) * (opts.rangeMult ?? 1);
  const s: PendingSound = { src: src?.rosterIndex ?? -1, kind, x, y, radius, variant };
  soundRt(m).pending.push(s);
  m.emit({ type: "sound", ...s });
}

/** Run distance (px) a step may contain and still count as walked (float noise only). */
const STEP_RUN_EPS_PX = 0.5;

/**
 * Footstep accumulator: one step sound per SOUND.STEP_EVERY_PX of non-roll travel. Rolling resets
 * it (the roll has its own sound). Variant = terrain material under the player; inside a bush it is
 * the louder rustle. A step gets the quiet (walk) radius only when its whole distance was covered
 * by walk inputs: the flag of the input that happens to complete the step decides nothing, so a
 * client cannot run and send walk=true just on the crossing input (rt.stepRunAcc).
 */
export function footstep(m: Match, rt: PlayerRuntime, moved: number, walk: boolean): void {
  rt.stepAcc += moved;
  if (!walk) rt.stepRunAcc += moved;
  if (rt.stepAcc < SOUND.STEP_EVERY_PX) return;
  rt.stepAcc -= SOUND.STEP_EVERY_PX;
  const quiet = rt.stepRunAcc - (walk ? 0 : rt.stepAcc) <= STEP_RUN_EPS_PX;
  // The carried remainder came from this input: it is run distance of the next step unless walked.
  rt.stepRunAcc = walk ? 0 : rt.stepAcc;
  const p = rt.pub;
  const surf = surfaceAt(m.map, p.x, p.y);
  const kind = bushIndexAt(m.bushIndex, p.x, p.y) >= 0 ? SoundKind.stepBush : SoundKind.step;
  emitSound(m, rt, kind, p.x, p.y, surf.variant, { walk: quiet, rangeMult: surf.stepRangeMult });
}

/**
 * Channelled sounds that repeat while an action lasts: search (every SEARCH_REPEAT_MS while a
 * search session is open, first one at its start). Extraction repeats live in extraction.ts.
 */
function channelSounds(m: Match): void {
  for (const rt of m.allRuntimes()) {
    if (!rt.pub.alive || !rt.search) continue;
    if (m.clock < rt.nextSearchSoundAt) continue;
    emitSound(m, rt, SoundKind.search, rt.pub.x, rt.pub.y);
    rt.nextSearchSoundAt = m.clock + SOUND.SEARCH_REPEAT_MS;
  }
}

/** Sounds an NPC heard in the last delivery (npc.ts: suspicious / squad alert by sector / band). */
export function heardBy(m: Match, rosterIndex: number): readonly DecodedSound[] {
  return soundRt(m).heard.get(rosterIndex) ?? [];
}

/** Pending sounds not delivered yet (tests). */
export function pendingSounds(m: Match): readonly PendingSound[] {
  return soundRt(m).pending;
}

interface Entry {
  kind: SoundKind;
  prio: number;
  /** Dedupe key. */
  key: string;
  push(msg: SoundMsg): void;
}

/**
 * Per-listener delivery: vision, env.hear, occlusion, quantization, dedupe, cap. Called at the end
 * of Match.step (after vision.update).
 */
export function deliverSounds(m: Match): void {
  channelSounds(m);
  const srt = soundRt(m);
  srt.heard.clear();
  if (srt.pending.length === 0) return;
  // One sound per (source, kind, variant) per tick before any per-listener work (raycasts): the
  // listener-side dedupe would merge them anyway, and a message flood must not cost
  // pending × listeners rays. World sounds (src −1) are all kept.
  const pending: PendingSound[] = [];
  const once = new Set<number>();
  for (const s of srt.pending) {
    if (s.src >= 0) {
      const k = (s.src * 64 + s.kind) * 256 + s.variant;
      if (once.has(k)) continue;
      once.add(k);
    }
    pending.push(s);
  }
  srt.pending = [];
  const hear = envNow(m).hear;
  const walls = getWallIndex(m.map);
  for (const l of m.allRuntimes()) {
    if (!l.pub.alive) continue;
    // Disconnected humans have nobody to send to; dormant NPCs do not listen (npc.ts).
    if (l.isNpc ? l.dormant : !l.connected) continue;
    const lx = l.pub.x, ly = l.pub.y;
    const entries: Entry[] = [];
    const seen = new Set<string>();
    for (const s of pending) {
      if (s.src === l.rosterIndex) continue;
      // NPCs are one faction: an NPC listener ignores other NPCs' footsteps and chatter (they
      // would keep every squad suspicious of itself); their gunshots still carry.
      if (l.isNpc && s.src >= 0 && s.kind !== SoundKind.shot && m.rosterRuntime(s.src)?.isNpc) continue;
      const R = s.radius * hear;
      if (!(R >= 1)) continue;
      const dx = s.x - lx, dy = s.y - ly;
      if (dx * dx + dy * dy > R * R) continue;
      const src = s.src >= 0 ? m.rosterRuntime(s.src) : undefined;
      let e: Entry | null = null;
      if (src && m.vision.sees(l.rosterIndex, s.src)) {
        const id = src.id;
        e = { kind: s.kind, prio: SOUND_PRIORITY[s.kind], key: `v${s.kind}:${id}:${s.variant}`, push: (msg) => pushVisibleSound(msg, s.kind, id, s.variant) };
      } else {
        // A wall muffles (flagged, OCCLUSION_MULT); a window is an opening (WINDOW_MULT, no flag).
        const occ = soundOcclusion(walls, lx, ly, s.x, s.y);
        const occluded = occ === OCCLUSION.WALL;
        const q = quantizeSound(lx, ly, s.x, s.y, R, occluded, occlusionMult(occ));
        if (q) {
          e = {
            kind: s.kind, prio: SOUND_PRIORITY[s.kind], key: `h${s.kind}:${q.a}:${q.b}:${occluded ? 1 : 0}:${s.variant}`,
            push: (msg) => pushHiddenSound(msg, s.kind, q, s.variant),
          };
        }
      }
      if (!e || seen.has(e.key)) continue;
      seen.add(e.key);
      entries.push(e);
    }
    if (entries.length === 0) continue;
    // Stable sort: equal priorities keep emit order.
    if (entries.length > SOUND.MAX_PER_TICK) {
      entries.sort((a, b) => b.prio - a.prio);
      entries.length = SOUND.MAX_PER_TICK;
    }
    const msg: SoundMsg = {};
    for (const e of entries) e.push(msg);
    if (l.isNpc) srt.heard.set(l.rosterIndex, decodeSoundMsg(msg));
    else m.emit({ type: "snd", to: l.rosterIndex, msg });
  }
}
