/**
 * Pure netcode helpers (no Pixi, no DOM) so they can be unit-tested with node:test:
 * - Predictor: client-side prediction of the local player + Gambetta-style reconciliation.
 * - SnapshotBuffer: snapshot interpolation of remote players.
 *
 * v2: movement goes through the shared stepMovement (walk, terrain, dodge roll). The roll lives in
 * the input stream (advanced once per applied input, never on the clock), so replaying the pending
 * inputs from the server's roll state (SelfState.rollLeft/rollCd/rollDx/rollDy, written in the same
 * loop iteration as lastSeq) reproduces the server bit for bit. Only the heal slow-down is
 * clock-based and keeps the LocalHeal bookkeeping.
 */

import {
  INPUT_DT_MS,
  ITEM_FLAG,
  PLAYER,
  ROLL_IDLE,
  WEAPONS,
  ammoDefOf,
  countOf,
  getCollisionIndex,
  healSpeedMult,
  itemDef,
  readRoll,
  rollCooldownMs,
  sanitizeInput,
  stepMovement,
  terrainAt,
  terrainSpeedMult,
  type CollisionIndex,
  type HealKind,
  type InputSample,
  type MapData,
  type MoveResult,
  type Player,
  type RollFields,
  type RollState,
  type SlotStore,
} from "@extract/shared";

/** The input fields stepMovement reads. */
export type MoveInput = Pick<InputSample, "mx" | "my" | "aim" | "roll" | "walk">;

/**
 * One input of movement: the shared stepMovement bound to the map. `healMult` is the heal
 * slow-down only; walk and terrain are applied inside from the input and the map.
 */
export type MoveFn = (x: number, y: number, roll: Readonly<RollState>, input: MoveInput, healMult: number) => MoveResult;

/**
 * The MoveFn the client and the server must share: terrain is sampled at the input's START
 * position (stepMovement contract), so both sides slow the same input in shallow water.
 */
export function moveFnFor(map: MapData, idx: CollisionIndex = getCollisionIndex(map)): MoveFn {
  return (x, y, roll, input, healMult) =>
    stepMovement(idx, x, y, roll, input, healMult, terrainSpeedMult(terrainAt(map, x, y)));
}

/** One sent, not yet acknowledged input, as the server will apply it (sanitized). */
export interface PendingInput {
  seq: number;
  mx: number;
  my: number;
  /** Already normalized exactly like the server's sanitizeInput (the roll direction uses it). */
  aim: number;
  roll: boolean;
  walk: boolean;
  /** Heal slow-down the input is predicted with; re-derived on every reconcile. */
  healMult: number;
}

/**
 * The server acks at 20 Hz, so normally only a handful of inputs are pending. If acks stop
 * (lag spike, dead player) keep ~2 s worth: older inputs can no longer matter because the
 * server has either applied or dropped them.
 */
const MAX_PENDING = 60;

/** The server's healing slow-down, from the shared contract. */
export { healSpeedMult };

/** Server timing that decides the heal multiplier of inputs the server has not applied yet. */
export interface ServerTiming {
  /** Match clock of the state the position came from. */
  clockMs: number;
  /** SelfState.healUntil in that state (0 = not healing). */
  healUntil: number;
}

/**
 * Everything reconcile needs from one server state. Position comes from the public Player,
 * the rest from the owner-only SelfState; the server writes both in the same input iteration, so
 * one patch always carries a consistent (pos, roll, lastSeq) triple.
 */
export interface ServerMoveState extends ServerTiming {
  x: number;
  y: number;
  lastSeq: number;
  roll: RollState;
  /** SelfState.walking (walk held on the last applied input). */
  walking?: boolean;
}

/** The SelfState fields the client reads for movement and intent checks. */
export interface SelfMoveFields extends RollFields {
  lastSeq: number;
  healUntil: number;
  walking: boolean;
}

/**
 * Collect the reconcile input from the synced state: x/y from players.get(sessionId), the rest
 * from self.get(selfKey). Null while either entry is missing (not joined yet, dead, extracted).
 */
export function readServerMove(
  state: {
    clockMs: number;
    players: { get(k: string): Pick<Player, "x" | "y"> | undefined };
    self: { get(k: string): SelfMoveFields | undefined };
  },
  selfKey: string | null | undefined,
  sessionId: string,
): ServerMoveState | null {
  if (!selfKey) return null;
  const me = state.players.get(sessionId);
  const self = state.self.get(selfKey);
  if (!me || !self) return null;
  return {
    x: me.x,
    y: me.y,
    lastSeq: self.lastSeq,
    roll: readRoll(self),
    clockMs: state.clockMs,
    healUntil: self.healUntil,
    walking: self.walking,
  };
}

/**
 * A heal start or cancel the client predicted before any server state shows it. Intents and
 * inputs travel over the same ordered socket, so the server applies the change before input
 * `fromSeq` (a HEAL / SWITCH intent sent before it) or right after input `fromSeq - 1` (the shot
 * or roll start that cancels the heal). It is the truth for inputs from `fromSeq` on until the
 * server acks `fromSeq`; from then on the server's healUntil already includes it.
 */
interface LocalHeal {
  fromSeq: number;
  /** Predicted SelfState.healUntil (0 = cancelled). */
  healUntil: number;
  /**
   * Cancel caused by a predicted roll start. Re-derived on every replay (the replay may start
   * the roll at another seq than the first prediction, e.g. after a dropped input).
   */
  byRoll?: true;
}

/** Local heal predictions are dropped on ack, so only a few are ever outstanding. */
const MAX_LOCAL_HEALS = 16;

/** SelfState fields the intent checks read; MapSchema<InvItem> satisfies SlotStore. */
export interface SelfIntentFields {
  active: string;
  reloadUntil: number;
  slots: SlotStore;
}

/**
 * Mirrors the server's startHeal() checks for the local player (false when it would refuse).
 * A running heal is NOT checked here: the server's healUntil can be stale against a locally
 * predicted cancel, so callers combine this with !predictor.healingAhead().
 * Med item def ids equal the HealKind ("bandage", "medkit").
 */
export function canStartHeal(
  me: Pick<Player, "alive" | "hp">,
  self: Pick<SelfIntentFields, "reloadUntil" | "slots">,
  kind: HealKind,
): boolean {
  if (!me.alive || self.reloadUntil > 0 || me.hp >= PLAYER.MAX_HP) return false;
  if (itemDef(kind)?.med !== kind) return false;
  return countOf(self.slots, kind) > 0;
}

/**
 * Whether the server's tryFire() will act on this input and so cancel a running heal: a real shot
 * (or an empty-mag reload) with the active weapon, not while reloading and never on a roll tick
 * (no firing while rolling). Semi-auto weapons only act on a press (fire after an input without
 * fire), automatic ones while the trigger is held.
 */
export function inputCancelsHeal(self: SelfIntentFields, fire: boolean, prevFire: boolean, rolling = false): boolean {
  if (!fire || rolling || self.reloadUntil > 0) return false;
  const it = self.slots.get(self.active);
  if (!it || it.flags & ITEM_FLAG.BROKEN) return false;
  const weapon = itemDef(it.def)?.weapon;
  if (!weapon) return false;
  if (!WEAPONS[weapon].auto && prevFire) return false;
  if (it.mag > 0) return true;
  return countOf(self.slots, ammoDefOf(weapon)) > 0;
}

export interface Correction {
  dx: number;
  dy: number;
  /** The server restarted the input sequence (reconnect): prediction jumped to the server position. */
  resynced: boolean;
}

export class Predictor {
  /** Predicted position after every input sent so far. */
  x = 0;
  y = 0;
  /** Predicted roll state after every input sent so far. */
  roll: RollState = { ...ROLL_IDLE };
  /** The latest predicted input was a roll tick (no firing, no footsteps, spin animation). */
  rolling = false;
  /** Walk was held on the latest predicted non-roll input (HUD "quiet" icon, walk animation). */
  walking = false;
  private pending: PendingInput[] = [];
  private seq = 0;
  private initialized = false;
  /** Highest lastSeq seen since the last resync; a lower one means the server restarted seq. */
  private lastAck = 0;
  private timing: ServerTiming | null = null;
  /** Heal starts / cancels predicted locally and not yet acknowledged, ordered by fromSeq. */
  private localHeals: LocalHeal[] = [];

  constructor(private readonly move: MoveFn) {}

  get isInitialized(): boolean {
    return this.initialized;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /** Remaining predicted roll cooldown for the HUD pie (0 = ready). */
  get rollCooldownMs(): number {
    return rollCooldownMs(this.roll);
  }

  /** A Space press now would start a roll on the next input (stepMovement decrements cd first). */
  get rollReady(): boolean {
    return this.roll.left === 0 && this.roll.cd <= 1;
  }

  /**
   * Seq keeps increasing for the lifetime of the room connection: the server only accepts
   * inputs newer than the last applied one, so it must never go back after a reset.
   */
  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** Seq of the newest input handed out (ThrowMsg.q: the server throws right after applying it). */
  get lastSeq(): number {
    return this.seq;
  }

  /** Latest server timing; null until the first state. */
  get serverTiming(): ServerTiming | null {
    return this.timing;
  }

  /** Remember the server clock / heal timer without touching the position (e.g. while dead). */
  setTiming(t: ServerTiming): void {
    this.timing = { clockMs: t.clockMs, healUntil: t.healUntil };
  }

  /** healUntil the server will have when it applies input `seq`: its last state plus local predictions. */
  private healUntilFor(seq: number): number {
    let h = this.timing?.healUntil ?? 0;
    for (const e of this.localHeals) {
      if (seq >= e.fromSeq) h = e.healUntil;
      else break;
    }
    return h;
  }

  /**
   * Heal multiplier for the pending input at `index` (index = pendingCount for the next input).
   * The server drains one input per INPUT_DT_MS, so pending input k is applied roughly
   * (k + 1) input steps after the last state the client has seen.
   */
  healMultAt(index: number, seq = this.pending[index]?.seq ?? this.seq + 1): number {
    const t = this.timing;
    if (!t) return 1;
    return healSpeedMult(this.healUntilFor(seq), t.clockMs + (index + 1) * INPUT_DT_MS);
  }

  /** Multiplier for the input about to be sent (`seq` defaults to the one nextSeq() hands out next). */
  nextHealMult(seq = this.seq + 1): number {
    return this.healMultAt(this.pending.length, seq);
  }

  /** A heal is running (server or predicted) when the next input is applied. */
  healingAhead(): boolean {
    return this.nextHealMult() < 1;
  }

  /**
   * The local player asked to heal and the server will accept it (see canStartHeal): slow every
   * input sent from now on, without waiting one round trip for healUntil to come back.
   */
  predictHealStart(durationMs: number): void {
    const t = this.timing;
    if (!t) return;
    // The intent lands just before the next input, which runs ~ (pending + 1) steps from now.
    this.pushLocalHeal({ fromSeq: this.seq + 1, healUntil: t.clockMs + this.pending.length * INPUT_DT_MS + durationMs });
  }

  /**
   * The input just sent fires (or a weapon switch was just sent): the server cancels the heal
   * then, so every later input runs at full speed again.
   */
  predictHealCancel(): void {
    if (!this.healingAhead()) return;
    this.pushLocalHeal({ fromSeq: this.seq + 1, healUntil: 0 });
  }

  private pushLocalHeal(e: LocalHeal): void {
    this.localHeals.push(e);
    if (this.localHeals.length > MAX_LOCAL_HEALS) this.localHeals.splice(0, this.localHeals.length - MAX_LOCAL_HEALS);
  }

  /**
   * A roll started on input `seq`: the server cancels the heal in that iteration, so inputs from
   * seq + 1 run unslowed. It goes BEFORE intents with the same fromSeq: those were sent after
   * input `seq` and reach the server after the roll start (e.g. a heal started mid-roll).
   */
  private insertRollCancel(seq: number): void {
    const fromSeq = seq + 1;
    let i = 0;
    while (i < this.localHeals.length && this.localHeals[i]!.fromSeq < fromSeq) i++;
    this.localHeals.splice(i, 0, { fromSeq, healUntil: 0, byRoll: true });
    if (this.localHeals.length > MAX_LOCAL_HEALS) this.localHeals.splice(0, this.localHeals.length - MAX_LOCAL_HEALS);
  }

  /** Forget pending inputs and jump to a server position + roll (spawn, death, reconnect). */
  reset(x: number, y: number, roll: Readonly<RollState> = ROLL_IDLE): void {
    this.x = x;
    this.y = y;
    this.roll = { left: roll.left, cd: roll.cd, dx: roll.dx, dy: roll.dy };
    this.rolling = false;
    this.walking = false;
    this.pending.length = 0;
    this.localHeals.length = 0;
    this.initialized = true;
  }

  /**
   * Predict one input locally; `sample` is exactly what is sent to the server. It is sanitized
   * here with the server's own sanitizeInput, so the aim the roll direction is derived from is
   * bit-identical on both sides. `sample.fire` is not used here: the caller checks
   * inputCancelsHeal(self, fire, prevFire, result.rolling). Returns the step result: `started` → dust/sfx/spin and the heal
   * is cancelled for later inputs; `rolling` → do not predict a shot for this input.
   */
  apply(sample: InputSample): MoveResult {
    const s = sanitizeInput(sample);
    // The server drops an unusable sample (sanitizeInput → null), so it is not predicted either.
    if (!s) return { x: this.x, y: this.y, roll: { ...this.roll }, rolling: false, started: false };
    const input: PendingInput = {
      seq: s.seq,
      mx: s.mx,
      my: s.my,
      aim: s.aim,
      roll: s.roll === true,
      walk: s.walk === true,
      healMult: this.nextHealMult(s.seq),
    };
    const r = this.move(this.x, this.y, this.roll, input, input.healMult);
    this.x = r.x;
    this.y = r.y;
    this.roll = r.roll;
    this.rolling = r.rolling;
    this.walking = !r.rolling && input.walk;
    this.pending.push(input);
    if (this.pending.length > MAX_PENDING) this.pending.splice(0, this.pending.length - MAX_PENDING);
    if (r.started) this.insertRollCancel(input.seq);
    return r;
  }

  /**
   * Server state arrived: everything up to lastSeq is already included in (x, y, roll), so start
   * from there and replay the inputs the server has not seen yet.
   * Returns how far the predicted position moved because of the correction (0,0 = prediction
   * was exact), which the renderer turns into a smoothed visual offset.
   */
  reconcile(s: ServerMoveState): Correction {
    this.setTiming(s);
    if (!this.initialized) {
      this.reset(s.x, s.y, s.roll);
      this.walking = s.walking === true;
      this.lastAck = s.lastSeq;
      return { dx: 0, dy: 0, resynced: false };
    }
    const prevX = this.x;
    const prevY = this.y;
    const lastSeq = s.lastSeq;

    if (lastSeq < this.lastAck) {
      // The server restarted the sequence (reconnect re-keys the player and sets lastSeq = 0,
      // its queue is cleared): the pending inputs were thrown away and will never be acked, so
      // replaying them would run ahead of the server. Start over from the server position and
      // roll state; our seq keeps counting up, which the server accepts.
      this.lastAck = lastSeq;
      this.reset(s.x, s.y, s.roll);
      this.walking = s.walking === true;
      return { dx: s.x - prevX, dy: s.y - prevY, resynced: true };
    }
    this.lastAck = lastSeq;
    if (lastSeq > this.seq) {
      // The server has applied seqs we never sent (another client drove this player before us):
      // jump past everything it may still have queued, or it would drop our inputs as stale.
      this.seq = lastSeq + MAX_PENDING;
    }

    let drop = 0;
    while (drop < this.pending.length && this.pending[drop]!.seq <= lastSeq) drop++;
    if (drop > 0) this.pending.splice(0, drop);
    // Acked heal predictions are in the server's healUntil now; roll cancels are re-derived below.
    this.localHeals = this.localHeals.filter((e) => e.fromSeq > lastSeq && !e.byRoll);

    let x = s.x;
    let y = s.y;
    let roll: RollState = { left: s.roll.left, cd: s.roll.cd, dx: s.roll.dx, dy: s.roll.dy };
    let rolling = s.roll.left > 0;
    let walking = s.walking === true;
    for (let k = 0; k < this.pending.length; k++) {
      const input = this.pending[k]!;
      // Re-derive the slow-down from the newest server heal timer (plus local predictions): a heal
      // that started (or was cancelled) after the input was predicted applies to every input the
      // server has not run yet.
      input.healMult = this.healMultAt(k, input.seq);
      const r = this.move(x, y, roll, input, input.healMult);
      x = r.x;
      y = r.y;
      roll = r.roll;
      rolling = r.rolling;
      walking = !r.rolling && input.walk;
      if (r.started) this.insertRollCancel(input.seq);
    }
    this.x = x;
    this.y = y;
    this.roll = roll;
    this.rolling = rolling;
    this.walking = walking;
    return { dx: x - prevX, dy: y - prevY, resynced: false };
  }
}

export interface Snapshot {
  /** Local receive time (performance.now()). */
  t: number;
  x: number;
  y: number;
  aim: number;
}

/** Keep this much history; interpolation only looks ~100 ms back. */
const SNAPSHOT_HISTORY_MS = 1000;
/** A jump this large between two snapshots is a teleport (spawn), not movement. */
const TELEPORT_DIST = 300;

export class SnapshotBuffer {
  private buf: Snapshot[] = [];

  get size(): number {
    return this.buf.length;
  }

  push(s: Snapshot): void {
    const last = this.buf[this.buf.length - 1];
    // Two patches decoded within the same millisecond: keep the newest values only.
    if (last && s.t <= last.t) {
      this.buf[this.buf.length - 1] = { ...s, t: last.t };
    } else {
      this.buf.push(s);
    }
    const cutoff = s.t - SNAPSHOT_HISTORY_MS;
    let drop = 0;
    while (drop < this.buf.length - 2 && this.buf[drop + 1]!.t < cutoff) drop++;
    if (drop > 0) this.buf.splice(0, drop);
  }

  clear(): void {
    this.buf.length = 0;
  }

  /** Interpolated state at renderT; holds the newest snapshot instead of extrapolating. */
  sample(renderT: number): { x: number; y: number; aim: number } | null {
    const n = this.buf.length;
    if (n === 0) return null;
    const first = this.buf[0]!;
    if (n === 1 || renderT <= first.t) return { x: first.x, y: first.y, aim: first.aim };
    const last = this.buf[n - 1]!;
    if (renderT >= last.t) return { x: last.x, y: last.y, aim: last.aim };
    let i = n - 2;
    while (i > 0 && this.buf[i]!.t > renderT) i--;
    const a = this.buf[i]!;
    const b = this.buf[i + 1]!;
    if (Math.hypot(b.x - a.x, b.y - a.y) > TELEPORT_DIST) return { x: b.x, y: b.y, aim: b.aim };
    const k = (renderT - a.t) / Math.max(1e-6, b.t - a.t);
    return {
      x: a.x + (b.x - a.x) * k,
      y: a.y + (b.y - a.y) * k,
      aim: lerpAngle(a.aim, b.aim, k),
    };
  }
}

/** Interpolate along the shortest arc so aim does not spin the long way round at ±π. */
export function lerpAngle(a: number, b: number, k: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}

/** Frame-rate independent exponential decay factor for a time constant tauMs. */
export function decayFactor(dtMs: number, tauMs: number): number {
  return Math.exp(-Math.max(0, dtMs) / tauMs);
}
