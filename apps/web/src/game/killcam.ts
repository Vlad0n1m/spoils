/**
 * Death replay ("killcam"): the last seconds before the local player's death, replayed from their
 * own perspective before the recap card.
 *
 * Fog-safe by construction: nothing is asked of the server. The renderer records, every frame,
 * what it ALREADY drew — the camera, the fog eye, each player sprite it showed (position, aim,
 * fog alpha, pose flags, look) — and the effects it played (tracers, impacts, damage numbers,
 * bursts). The replay re-draws exactly that, so it can never show a player, a shot or a position
 * this client did not render live. Owner-only data and other players' views never enter it.
 *
 * Memory-bounded and cheap: two fixed-capacity rings whose slot objects are created once and then
 * overwritten (no per-frame allocation once warm). At ≤ 60 samples/s the frame ring holds a bit
 * more than BUFFER_MS; each frame keeps at most MAX_ENTS sprites. Recording stops (freeze) on the
 * death frame; the effects ring takes FX_TAIL_MS more (the killing tracer of a remote shooter is
 * drawn INTERP_DELAY_MS late).
 *
 * Playback: the last REPLAY_MS before the death, the first part at 1×, the final SLOWMO_MS at
 * SLOWMO (0.5×), then the death frame holds HOLD_MS while the fall plays: ≈ 5.2 s of wall time.
 * Pure (no Pixi): the renderer draws, this module decides what and when.
 */

export const KILLCAM = {
  /** History kept (ms of recorded time). */
  BUFFER_MS: 6_000,
  /** Recorded time replayed, ending at the death. */
  REPLAY_MS: 3_600,
  /** The final part of it in slow motion… */
  SLOWMO_MS: 1_200,
  /** …at this speed. */
  SLOWMO: 0.5,
  /** The death frame holds this long at the end (the body falls). */
  HOLD_MS: 400,
  /** At most one sample per this many ms (~60 Hz). */
  SAMPLE_MS: 16,
  /** Frame ring capacity: BUFFER_MS at SAMPLE_MS, plus slack. */
  MAX_FRAMES: 400,
  /** Sprites kept per frame (players drawn on screen at once). */
  MAX_ENTS: 48,
  /** Effects ring capacity. */
  MAX_FX: 512,
  /** Effects keep being recorded this long after the death frame. */
  FX_TAIL_MS: 300,
  /** A recording shorter than this is not worth a replay. */
  MIN_MS: 1_000,
} as const;

/** One sprite as it was drawn. Strings are references to the decoded state (no copies). */
export interface EntSnap {
  id: string;
  self: boolean;
  x: number;
  y: number;
  aim: number;
  /** Fog alpha it was drawn with (0..1). */
  alpha: number;
  alive: boolean;
  act: number;
  weapon: string;
  color: number;
  skin: number;
  nick: string;
  role: number;
  bp: number;
  hp: number;
  maxHp: number;
  armor: number;
  armorDur: number;
  armorMax: number;
  /** HP bar shown (it was hit by us recently, a mate, a boss). */
  bars: boolean;
}

export interface FrameSnap {
  /** performance.now() of the frame. */
  t: number;
  camX: number;
  camY: number;
  zoom: number;
  /** Fog eye (hasEye false: no fog). */
  hasEye: boolean;
  eyeX: number;
  eyeY: number;
  eyeAim: number;
  eyeRange: number;
  /** Sprites used in `ents` (the array keeps older slots for reuse). */
  n: number;
  ents: EntSnap[];
}

/** Effect kinds the renderer replays (FxSnap.k). */
export const FX = {
  /** effects.shot: s = shooter id, w = weapon, a = [cx, cy, x, y], arr = angles, self = own shot. */
  SHOT: 1,
  /** effects.stopTracer: s = shooter, a = [x, y]. */
  STOP: 2,
  /** effects.hitBurst: a = [x, y, dx, dy], flag = armor. */
  BURST: 3,
  /** PlayerView.flashHit: s = target, a = [dx, dy]. */
  FLASH: 4,
  /** effects.damageNumber: s = target, a = [x, y, dmg], flag = armor, self = on us. */
  DMG: 5,
  /** effects.confirmPuff: a = [x, y]. */
  PUFF: 6,
  /** effects.ring: a = [x, y, color, radius, ms]. */
  RING: 7,
  /** effects.burst: a = [x, y, color, count, ms]. */
  SPARK: 8,
  /** PlayerView.kick: s = shooter, a = [px]. */
  KICK: 9,
} as const;
export type FxKind = (typeof FX)[keyof typeof FX];

export interface FxSnap {
  t: number;
  k: FxKind;
  s: string;
  w: string;
  /** Up to 5 numbers (reused array, `na` used). */
  a: number[];
  na: number;
  /** Angles of a shot (the message's own array, never mutated). */
  arr: readonly number[] | null;
  flag: boolean;
  self: boolean;
}

/**
 * Fixed-capacity ring of reusable slots, oldest first. push() hands out the slot to overwrite:
 * a fresh one until the ring is full, then the oldest. Slots are created once by `make`.
 */
export class Ring<T extends { t: number }> {
  private readonly slots: T[] = [];
  private head = 0;
  private count = 0;

  constructor(
    readonly capacity: number,
    private readonly make: () => T,
  ) {}

  get size(): number {
    return this.count;
  }

  /** Slot objects ever created (memory bound: never above capacity). */
  get allocated(): number {
    return this.slots.length;
  }

  push(): T {
    if (this.count < this.capacity) {
      const i = (this.head + this.count) % this.capacity;
      if (!this.slots[i]) this.slots[i] = this.make();
      this.count++;
      return this.slots[i]!;
    }
    const s = this.slots[this.head]!;
    this.head = (this.head + 1) % this.capacity;
    return s;
  }

  /** The i-th oldest (0 = oldest). */
  get(i: number): T {
    return this.slots[(this.head + i) % this.capacity]!;
  }

  newest(): T | null {
    return this.count > 0 ? this.get(this.count - 1) : null;
  }

  oldest(): T | null {
    return this.count > 0 ? this.get(0) : null;
  }

  /** Index of the newest entry with t ≤ `t` (entries are pushed in time order), −1 if none. */
  indexAtOrBefore(t: number): number {
    let lo = 0;
    let hi = this.count - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.get(mid).t <= t) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found;
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
  }
}

const makeEnt = (): EntSnap => ({
  id: "", self: false, x: 0, y: 0, aim: 0, alpha: 0, alive: true, act: 0, weapon: "", color: 0, skin: 0, nick: "", role: 0, bp: 0,
  hp: 0, maxHp: 0, armor: 0, armorDur: 0, armorMax: 0, bars: false,
});
const makeFrame = (): FrameSnap => ({ t: 0, camX: 0, camY: 0, zoom: 1, hasEye: false, eyeX: 0, eyeY: 0, eyeAim: 0, eyeRange: 0, n: 0, ents: [] });
const makeFx = (): FxSnap => ({ t: 0, k: FX.SHOT, s: "", w: "", a: [0, 0, 0, 0, 0], na: 0, arr: null, flag: false, self: false });

/** What the renderer drew, frame by frame, until the death froze it. */
export class KillcamRecorder {
  readonly frames = new Ring<FrameSnap>(KILLCAM.MAX_FRAMES, makeFrame);
  readonly fx = new Ring<FxSnap>(KILLCAM.MAX_FX, makeFx);
  private lastAt = Number.NEGATIVE_INFINITY;
  private frozenAt: number | null = null;

  get frozen(): boolean {
    return this.frozenAt !== null;
  }

  /** The death frame's time (null while recording). */
  get endAt(): number | null {
    return this.frozenAt;
  }

  /**
   * A new frame at `t`, to fill (camera, eye, then ent() per sprite); null when frozen or the last
   * sample is younger than SAMPLE_MS (`force`: the death frame is always taken).
   */
  beginFrame(t: number, force = false): FrameSnap | null {
    if (this.frozenAt !== null) return null;
    if (!force && t - this.lastAt < KILLCAM.SAMPLE_MS) return null;
    this.lastAt = t;
    const f = this.frames.push();
    f.t = t;
    f.n = 0;
    f.hasEye = false;
    return f;
  }

  /** The next sprite slot of `f`, or null past MAX_ENTS. */
  ent(f: FrameSnap): EntSnap | null {
    if (f.n >= KILLCAM.MAX_ENTS) return null;
    let e = f.ents[f.n];
    if (!e) {
      e = makeEnt();
      f.ents[f.n] = e;
    }
    f.n++;
    return e;
  }

  /** Record one effect played at `t` (a0..a4: its numbers, see FX). */
  addFx(t: number, k: FxKind, s: string, a0 = 0, a1 = 0, a2 = 0, a3 = 0, a4 = 0, na = 0, o?: { w?: string; arr?: readonly number[]; flag?: boolean; self?: boolean }): void {
    if (this.frozenAt !== null && t > this.frozenAt + KILLCAM.FX_TAIL_MS) return;
    if (this.frames.size === 0) return;
    const e = this.fx.push();
    e.t = t;
    e.k = k;
    e.s = s;
    e.a[0] = a0;
    e.a[1] = a1;
    e.a[2] = a2;
    e.a[3] = a3;
    e.a[4] = a4;
    e.na = na;
    e.w = o?.w ?? "";
    e.arr = o?.arr ?? null;
    e.flag = o?.flag ?? false;
    e.self = o?.self ?? false;
  }

  /** The death: no more frames (effects for FX_TAIL_MS more). */
  freeze(t: number): void {
    if (this.frozenAt === null) this.frozenAt = t;
  }

  /** Recorded window to replay, or null when there is too little of it. */
  window(): { start: number; end: number } | null {
    const last = this.frames.newest();
    const first = this.frames.oldest();
    if (!last || !first) return null;
    const end = this.frozenAt ?? last.t;
    const start = Math.max(first.t, end - KILLCAM.REPLAY_MS);
    return end - start >= KILLCAM.MIN_MS ? { start, end } : null;
  }

  clear(): void {
    this.frames.clear();
    this.fx.clear();
    this.lastAt = Number.NEGATIVE_INFINITY;
    this.frozenAt = null;
  }
}

/** Wall time of a replay of [start, end]: 1× part, slow-motion tail, final hold. */
export function replayDurationMs(start: number, end: number): number {
  const len = Math.max(0, end - start);
  const slow = Math.min(KILLCAM.SLOWMO_MS, len);
  return len - slow + slow / KILLCAM.SLOWMO + KILLCAM.HOLD_MS;
}

/**
 * Recorded time shown `elapsed` ms of wall time into a replay of [start, end]: 1× until the last
 * SLOWMO_MS, SLOWMO× through them, then held at `end`. `done` once replayDurationMs has passed.
 */
export function replayTimeAt(elapsed: number, start: number, end: number): { t: number; done: boolean; progress: number } {
  const len = Math.max(0, end - start);
  const slow = Math.min(KILLCAM.SLOWMO_MS, len);
  const fast = len - slow;
  const total = replayDurationMs(start, end);
  const e = Math.max(0, elapsed);
  let t: number;
  if (e <= fast) t = start + e;
  else t = Math.min(end, start + fast + (e - fast) * KILLCAM.SLOWMO);
  return { t, done: e >= total, progress: total > 0 ? Math.min(1, e / total) : 1 };
}

/** One replay frame: the recorded frames around `t` and the blend between them. */
export interface ReplaySample {
  t: number;
  a: FrameSnap;
  b: FrameSnap;
  /** 0 = a, 1 = b. */
  k: number;
  done: boolean;
  progress: number;
}

/** Plays a frozen (or live) recording once. */
export class KillcamPlayer {
  readonly start: number;
  readonly end: number;
  readonly durationMs: number;
  private lastT: number;
  private readonly sample: ReplaySample;

  constructor(
    private readonly rec: KillcamRecorder,
    private readonly wallStart: number,
    win: { start: number; end: number },
  ) {
    this.start = win.start;
    this.end = win.end;
    this.durationMs = replayDurationMs(win.start, win.end);
    // Effects at exactly `start` belong to the replay too.
    this.lastT = win.start - 1e-3;
    const f = rec.frames.get(0);
    this.sample = { t: win.start, a: f, b: f, k: 0, done: false, progress: 0 };
  }

  /** The frames to draw at wall time `now` (the same object every call). */
  at(now: number): ReplaySample {
    const s = this.sample;
    const r = replayTimeAt(now - this.wallStart, this.start, this.end);
    s.t = r.t;
    s.done = r.done;
    s.progress = r.progress;
    const frames = this.rec.frames;
    const i = Math.max(0, frames.indexAtOrBefore(r.t));
    s.a = frames.get(i);
    s.b = i + 1 < frames.size ? frames.get(i + 1) : s.a;
    const span = s.b.t - s.a.t;
    s.k = span > 0 ? Math.min(1, Math.max(0, (r.t - s.a.t) / span)) : 0;
    return s;
  }

  /**
   * Effects whose time passed since the last call (lastT, t], oldest first. During the final hold
   * the effects recorded after the death frame (FX_TAIL_MS) play out too.
   */
  dueFx(t: number, done: boolean, out: FxSnap[]): FxSnap[] {
    out.length = 0;
    const upTo = t >= this.end ? this.end + KILLCAM.FX_TAIL_MS : t;
    if (upTo <= this.lastT && !done) return out;
    const fx = this.rec.fx;
    let i = fx.indexAtOrBefore(this.lastT) + 1;
    for (; i < fx.size; i++) {
      const e = fx.get(i);
      if (e.t > upTo) break;
      if (e.t >= this.start) out.push(e);
    }
    this.lastT = Math.max(this.lastT, upTo);
    return out;
  }
}

/** The entry of `id` in frame `f` (linear: a frame holds a handful of sprites). */
export function entOf(f: FrameSnap, id: string): EntSnap | null {
  for (let i = 0; i < f.n; i++) if (f.ents[i]!.id === id) return f.ents[i]!;
  return null;
}

/** Shortest-way angle blend. */
export function lerpAngle(a: number, b: number, k: number): number {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + d * k;
}
