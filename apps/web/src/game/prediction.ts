/**
 * Pure netcode helpers (no Pixi, no DOM) so they can be unit-tested with node:test:
 * - Predictor: client-side prediction of the local player + Gambetta-style reconciliation.
 * - SnapshotBuffer: snapshot interpolation of remote players.
 */

import type { InputSample } from "@extract/shared";

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

export class Predictor {
  /** Predicted position after every input sent so far. */
  x = 0;
  y = 0;
  private pending: PendingInput[] = [];
  private seq = 0;
  private initialized = false;

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

  /** Forget pending inputs and jump to a server position (spawn, death, teleport). */
  reset(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.pending.length = 0;
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
  reconcile(serverX: number, serverY: number, lastSeq: number): { dx: number; dy: number } {
    if (!this.initialized) {
      this.reset(serverX, serverY);
      return { dx: 0, dy: 0 };
    }
    let drop = 0;
    while (drop < this.pending.length && this.pending[drop]!.seq <= lastSeq) drop++;
    if (drop > 0) this.pending.splice(0, drop);

    const prevX = this.x;
    const prevY = this.y;
    let x = serverX;
    let y = serverY;
    for (const input of this.pending) {
      const p = this.move(x, y, input, input.speedMult);
      x = p.x;
      y = p.y;
    }
    this.x = x;
    this.y = y;
    return { dx: x - prevX, dy: y - prevY };
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
