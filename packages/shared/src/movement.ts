/**
 * Player movement — the exact same function runs on the server (authority) and on the client
 * (prediction + replay of unacknowledged inputs), so predicted and server positions agree.
 * v2: stepMovement is the ONLY movement entry point on both sides. It advances the dodge roll
 * state machine once per applied input (never on the clock), so a replay reproduces it exactly.
 */

import { INPUT_DT_MS, PLAYER, ROLL } from "./constants.js";
import { moveCircle, type CollisionIndex } from "./geometry.js";

/** One input sample. The client sends one every INPUT_DT_MS; each moves the player by INPUT_DT_MS. */
export interface InputSample {
  /** Strictly increasing per client. The server echoes the last applied one in SelfState.lastSeq. */
  seq: number;
  /** Movement direction, each in [-1, 1] (WASD). Normalized to length ≤ 1 before use. */
  mx: number;
  my: number;
  /** Aim angle in radians (atan2 from player to cursor in world space). */
  aim: number;
  /** Trigger held. */
  fire: boolean;
  /** Roll requested on this sample (the client repeats it for ROLL.BUFFER_SAMPLES samples per press). */
  roll?: boolean;
  /** Quiet walk held (Shift). */
  walk?: boolean;
}

/** Clamp a raw (possibly malicious) input into valid ranges. Returns null if unusable. */
export function sanitizeInput(raw: unknown): InputSample | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const seq = num(r.seq);
  const mx = num(r.mx);
  const my = num(r.my);
  const aim = num(r.aim);
  if (seq === null || mx === null || my === null || aim === null) return null;
  if (!Number.isInteger(seq) || seq < 0 || seq > 2 ** 31) return null;
  return {
    seq,
    mx: Math.max(-1, Math.min(1, mx)),
    my: Math.max(-1, Math.min(1, my)),
    aim: Math.atan2(Math.sin(aim), Math.cos(aim)),
    fire: r.fire === true,
    roll: r.roll === true,
    walk: r.walk === true,
  };
}

/**
 * Movement multiplier while healing: an input is slowed iff the heal channel is still running at
 * the server clock the input is applied at (a finished or cancelled heal resets healUntil to 0).
 */
export function healSpeedMult(healUntil: number, atClockMs: number): number {
  return healUntil > 0 && atClockMs < healUntil ? PLAYER.HEAL_SPEED_MULT : 1;
}

/** Apply one input's walking movement for INPUT_DT_MS. `speedMult` covers all slow-downs. */
export function applyMovement(
  idx: CollisionIndex,
  x: number,
  y: number,
  input: Pick<InputSample, "mx" | "my">,
  speedMult = 1,
): { x: number; y: number } {
  let mx = input.mx;
  let my = input.my;
  const len = Math.hypot(mx, my);
  if (len < 1e-6) return { x, y };
  if (len > 1) {
    mx /= len;
    my /= len;
  }
  const step = (PLAYER.SPEED * speedMult * INPUT_DT_MS) / 1000;
  return moveCircle(idx, x, y, PLAYER.RADIUS, mx * step, my * step);
}

/** Per-player roll state. Advances exactly once per applied input on server AND client. */
export interface RollState {
  /** Roll ticks still to run (0 = not rolling). */
  left: number;
  /** Inputs until a roll may start again (0 = ready). */
  cd: number;
  /** Locked unit direction while rolling (0,0 otherwise). */
  dx: number;
  dy: number;
}
export const ROLL_IDLE: Readonly<RollState> = Object.freeze({ left: 0, cd: 0, dx: 0, dy: 0 });

/**
 * Per-tick roll travel: ease-out (50% linear + 50% easeOutQuad), 29, 27, …, 11 px; sums to
 * ROLL.DISTANCE. A table (not a formula per tick) so both sides use bit-identical numbers.
 */
export const ROLL_PROFILE: readonly number[] = (() => {
  const g = (k: number) => {
    const t = k / ROLL.TICKS;
    return 0.5 * t + 0.5 * (1 - (1 - t) * (1 - t));
  };
  return Object.freeze(Array.from({ length: ROLL.TICKS }, (_, k) => ROLL.DISTANCE * (g(k + 1) - g(k))));
})();

/** Final walking multiplier: the slowest of heal slow-down and quiet walk. */
export function moveSpeedMult(healMult: number, walk: boolean | undefined): number {
  return Math.min(healMult, walk ? PLAYER.WALK_SPEED_MULT : 1);
}

export interface MoveResult {
  x: number;
  y: number;
  roll: RollState;
  /** This input was a roll tick (no firing, no footsteps, walk/heal mult ignored). */
  rolling: boolean;
  /** A roll started on this input (cancel heal/search, emit roll sound). */
  started: boolean;
}

/**
 * One input of movement incl. the roll state machine. Pure and deterministic: the server applies
 * it per queued input, the client in prediction and in the reconcile replay.
 * - `healMult` = healSpeedMult(healUntil, clock).
 * - `terrainMult` = terrainSpeedMult(terrainAt(map, x, y)) sampled at the input's start position
 *   (SHALLOW water 0.6). It scales both walking and the roll step, so rolling is not a way to
 *   cross water at full speed.
 * No i-frames: the roll only moves you.
 */
export function stepMovement(
  idx: CollisionIndex,
  x: number,
  y: number,
  roll: Readonly<RollState>,
  input: Pick<InputSample, "mx" | "my" | "aim" | "roll" | "walk">,
  healMult = 1,
  terrainMult = 1,
): MoveResult {
  let { left, dx, dy } = roll;
  let cd = roll.cd > 0 ? roll.cd - 1 : 0;
  let started = false;
  if (left === 0 && cd === 0 && input.roll === true) {
    const len = Math.hypot(input.mx, input.my);
    if (len > 1e-6) {
      dx = input.mx / len;
      dy = input.my / len;
    } else {
      // Standing still: roll toward the aim, the direction the player is looking at.
      dx = Math.cos(input.aim);
      dy = Math.sin(input.aim);
    }
    left = ROLL.TICKS;
    cd = ROLL.COOLDOWN_TICKS;
    started = true;
  }
  if (left > 0) {
    const d = ROLL_PROFILE[ROLL.TICKS - left]! * terrainMult;
    const p = moveCircle(idx, x, y, PLAYER.RADIUS, dx * d, dy * d);
    left -= 1;
    if (left === 0) {
      dx = 0;
      dy = 0;
    }
    return { x: p.x, y: p.y, roll: { left, cd, dx, dy }, rolling: true, started };
  }
  const moved = applyMovement(idx, x, y, input, moveSpeedMult(healMult, input.walk) * terrainMult);
  return { x: moved.x, y: moved.y, roll: { left: 0, cd, dx: 0, dy: 0 }, rolling: false, started };
}

/** Remaining cooldown for the HUD pie. */
export function rollCooldownMs(r: Readonly<RollState>): number {
  return r.cd * INPUT_DT_MS;
}

/** Fields of SelfState that hold the roll (kept in SelfState so enemies cannot read your cooldown). */
export interface RollFields {
  rollLeft: number;
  rollCd: number;
  rollDx: number;
  rollDy: number;
}

export function readRoll(p: RollFields): RollState {
  return { left: p.rollLeft, cd: p.rollCd, dx: p.rollDx, dy: p.rollDy };
}

/** Writes only changed fields so an idle player produces no schema patches. */
export function writeRoll(p: RollFields, r: RollState): void {
  if (p.rollLeft !== r.left) p.rollLeft = r.left;
  if (p.rollCd !== r.cd) p.rollCd = r.cd;
  if (p.rollDx !== r.dx) p.rollDx = r.dx;
  if (p.rollDy !== r.dy) p.rollDy = r.dy;
}
