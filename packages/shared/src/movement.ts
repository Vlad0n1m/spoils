/**
 * Player movement — the exact same function runs on the server (authority) and on the client
 * (prediction + replay of unacknowledged inputs), so predicted and server positions agree.
 */

import { INPUT_DT_MS, PLAYER } from "./constants.js";
import { moveCircle, type CollisionIndex } from "./geometry.js";

/** One input sample. The client sends one every INPUT_DT_MS; each moves the player by INPUT_DT_MS. */
export interface InputSample {
  /** Strictly increasing per client. The server echoes the last applied one in Player.lastSeq. */
  seq: number;
  /** Movement direction, each in [-1, 1] (WASD). Normalized to length ≤ 1 before use. */
  mx: number;
  my: number;
  /** Aim angle in radians (atan2 from player to cursor in world space). */
  aim: number;
  /** Trigger held. */
  fire: boolean;
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
  };
}

/** Apply one input's movement for INPUT_DT_MS. `speedMult` covers slow-downs (e.g. healing). */
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
