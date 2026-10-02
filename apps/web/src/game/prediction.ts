/**
 * Pure netcode helpers (no Pixi, no DOM) so they can be unit-tested with node:test:
 * - Predictor: client-side prediction of the local player + Gambetta-style reconciliation.
 * - SnapshotBuffer: snapshot interpolation of remote players.
 */

import {
  HEAL,
  INPUT_DT_MS,
  PLAYER,
  WEAPONS,
  type HealKind,
  type InputSample,
  type Player,
  type WeaponId,
  healSpeedMult,
} from "@extract/shared";

export type MoveFn = (
  x: number,
  y: number,
  input: Pick<InputSample, "mx" | "my">,
  speedMult: number,
) => { x: number; y: number };

export interface PendingInput {
  seq: number;
  mx: number;
  my: number;
  /** Speed multiplier the input was predicted with (healing slows the player down). */
  speedMult: number;
}

/**
 * The server acks at 20 Hz, so normally only a handful of inputs are pending. If acks stop
 * (lag spike, dead player) keep ~2 s worth: older inputs can no longer matter because the
 * server has either applied or dropped them.
 */
const MAX_PENDING = 60;

/** The server's healing slow-down, from the shared contract. */
export { healSpeedMult };

/** Server timing that decides the speed multiplier of inputs the server has not applied yet. */
export interface ServerTiming {
  /** Match clock of the state the position came from. */
  clockMs: number;
  /** Player.healUntil in that state (0 = not healing). */
  healUntil: number;
}

/**
 * A heal start or cancel the client predicted before any server state shows it. Intents and
 * inputs travel over the same ordered socket, so the server applies the change before input
 * `fromSeq` (a HEAL / SWITCH intent sent before it) or right after input `fromSeq - 1` (the shot
 * that cancels the heal). It is the truth for inputs from `fromSeq` on until the server acks
 * `fromSeq`; from then on the server's healUntil already includes it.
 */
interface LocalHeal {
  fromSeq: number;
  /** Predicted Player.healUntil (0 = cancelled). */
  healUntil: number;
}

/** Local heal predictions are dropped on ack, so only a few are ever outstanding. */
const MAX_LOCAL_HEALS = 16;

/** Mirrors the server's startHeal() checks for the local player (false when it would refuse). */
export function canStartHeal(
  p: Pick<Player, "alive" | "hp" | "bandages" | "medkits" | "reloadUntil">,
  kind: HealKind,
): boolean {
  if (!p.alive || p.reloadUntil > 0 || p.hp >= PLAYER.MAX_HP) return false;
  if (!(kind in HEAL)) return false;
  return (kind === "bandage" ? p.bandages : p.medkits) > 0;
}

/**
 * Whether the server's tryFire() will act on this input and so cancel a running heal: a real shot
 * (or an empty-mag reload) with the active weapon, not while reloading. Semi-auto weapons only
 * act on a press (fire after an input without fire), automatic ones while the trigger is held.
 */
export function inputCancelsHeal(
  p: Pick<Player, "active" | "reloadUntil" | "ammoLight" | "ammoShell" | "ammoHeavy"> & {
    slots: { at(i: number): { weapon: string; mag: number } | undefined };
  },
  fire: boolean,
  prevFire: boolean,
): boolean {
  if (!fire || p.reloadUntil > 0) return false;
  const slot = p.slots.at(p.active);
  if (!slot?.weapon || !(slot.weapon in WEAPONS)) return false;
  const def = WEAPONS[slot.weapon as WeaponId];
  if (!def.auto && prevFire) return false;
  if (slot.mag > 0) return true;
  const reserve = def.ammo === "light" ? p.ammoLight : def.ammo === "shell" ? p.ammoShell : p.ammoHeavy;
  return reserve > 0;
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
  private pending: PendingInput[] = [];
  private seq = 0;
  private initialized = false;
  /** Highest Player.lastSeq seen since the last resync; a lower one means the server restarted seq. */
  private lastAck = 0;
  private timing: ServerTiming | null = null;
  /** Heal starts / cancels predicted locally and not yet acknowledged, oldest first. */
  private localHeals: LocalHeal[] = [];

  constructor(private readonly move: MoveFn) {}

  get isInitialized(): boolean {
    return this.initialized;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /**
   * Seq keeps increasing for the lifetime of the room connection: the server only accepts
   * inputs newer than the last applied one, so it must never go back after a reset.
   */
  nextSeq(): number {
    this.seq += 1;
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
    for (const e of this.localHeals) if (seq >= e.fromSeq) h = e.healUntil;
    return h;
  }

  /**
   * Speed multiplier for the pending input at `index` (index = pendingCount for the next input).
   * The server drains one input per INPUT_DT_MS, so pending input k is applied roughly
   * (k + 1) input steps after the last state the client has seen.
   */
  speedMultAt(index: number, seq = this.pending[index]?.seq ?? this.seq + 1): number {
    const t = this.timing;
    if (!t) return 1;
    return healSpeedMult(this.healUntilFor(seq), t.clockMs + (index + 1) * INPUT_DT_MS);
  }

  /** Multiplier for the input about to be sent (`seq` defaults to the one nextSeq() hands out next). */
  nextSpeedMult(seq = this.seq + 1): number {
    return this.speedMultAt(this.pending.length, seq);
  }

  /** A heal is running (server or predicted) when the next input is applied. */
  healingAhead(): boolean {
    return this.nextSpeedMult() < 1;
  }

  /**
   * The local player asked to heal and the server will accept it (see canStartHeal): slow every
   * input sent from now on, without waiting one round trip for healUntil to come back.
   */
  predictHealStart(durationMs: number): void {
    const t = this.timing;
    if (!t) return;
    // The intent lands just before the next input, which runs ~ (pending + 1) steps from now.
    this.pushLocalHeal(this.seq + 1, t.clockMs + this.pending.length * INPUT_DT_MS + durationMs);
  }

  /**
   * The input just sent fires (or a weapon switch was just sent): the server cancels the heal
   * then, so every later input runs at full speed again.
   */
  predictHealCancel(): void {
    if (!this.healingAhead()) return;
    this.pushLocalHeal(this.seq + 1, 0);
  }

  private pushLocalHeal(fromSeq: number, healUntil: number): void {
    this.localHeals.push({ fromSeq, healUntil });
    if (this.localHeals.length > MAX_LOCAL_HEALS) this.localHeals.splice(0, this.localHeals.length - MAX_LOCAL_HEALS);
  }

  /** Forget pending inputs and jump to a server position (spawn, death, teleport). */
  reset(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.pending.length = 0;
    this.localHeals.length = 0;
    this.initialized = true;
  }

  /** Predict one input locally (the same input is sent to the server). */
  apply(input: PendingInput): void {
    const p = this.move(this.x, this.y, input, input.speedMult);
    this.x = p.x;
    this.y = p.y;
    this.pending.push(input);
    if (this.pending.length > MAX_PENDING) this.pending.splice(0, this.pending.length - MAX_PENDING);
  }

  /**
   * Server state arrived: everything up to lastSeq is already included in (serverX, serverY),
   * so start from there and replay the inputs the server has not seen yet.
   * Returns how far the predicted position moved because of the correction (0,0 = prediction
   * was exact), which the renderer turns into a smoothed visual offset.
   */
  reconcile(serverX: number, serverY: number, lastSeq: number, timing?: ServerTiming): Correction {
    if (timing) this.setTiming(timing);
    if (!this.initialized) {
      this.reset(serverX, serverY);
      this.lastAck = lastSeq;
      return { dx: 0, dy: 0, resynced: false };
    }
    const prevX = this.x;
    const prevY = this.y;

    if (lastSeq < this.lastAck) {
      // The server restarted the sequence (reconnect re-keys the player and sets lastSeq = 0,
      // its queue is cleared): the pending inputs were thrown away and will never be acked, so
      // replaying them would run ahead of the server. Start over from the server position; our
      // seq keeps counting up, which the server accepts (it now takes anything above -1).
      this.lastAck = lastSeq;
      this.reset(serverX, serverY);
      return { dx: serverX - prevX, dy: serverY - prevY, resynced: true };
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
    // Acked heal predictions are in the server's healUntil now.
    let acked = 0;
    while (acked < this.localHeals.length && this.localHeals[acked]!.fromSeq <= lastSeq) acked++;
    if (acked > 0) this.localHeals.splice(0, acked);

    let x = serverX;
    let y = serverY;
    for (let k = 0; k < this.pending.length; k++) {
      const input = this.pending[k]!;
      // Re-derive the slow-down from the newest server heal timer (plus local predictions): a heal
      // that started (or was cancelled) after the input was predicted applies to every input the
      // server has not run yet.
      if (timing) input.speedMult = this.speedMultAt(k, input.seq);
      const p = this.move(x, y, input, input.speedMult);
      x = p.x;
      y = p.y;
    }
    this.x = x;
    this.y = y;
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
