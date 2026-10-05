/**
 * Server-side anti-ESP visibility rules (fog memo §2, numbers binding per critique).
 * canSee is pure: the server VisionSystem, bots and tests call it with plain data. The client
 * draws a narrower cone (CONE_HALF_DEG) than the server keeps (SERVER_CONE_HALF_DEG), so the
 * client never shows something the server hid, and the server is a superset of what the client draws.
 * Range multiplier = clamp(sampleEnv(cfg, clock).vis, MIN_RANGE_MULT, 1) — see visionRangeMult.
 */

import { PLAYER } from "./constants.js";
import { SOLID, raycastSolidsDDA, type Circle, type CollisionIndex } from "./geometry.js";
import { UniformGrid } from "./grid.js";

export const VISION = {
  /** Screen is 1600×900 world units (half-diagonal 918) plus a margin for interpolation lag. */
  RANGE: 1000,
  /** Client cone: full alpha up to CONE_HALF_DEG - CONE_FADE_DEG, 0 at CONE_HALF_DEG. */
  CONE_HALF_DEG: 90,
  CONE_FADE_DEG: 20,
  /** Radial fade starts at this fraction of the range. */
  RANGE_FADE_FROM: 0.8,
  /** 360° awareness (centre distance): 1.5 player diameters, soft to +AWARE_FADE. */
  AWARE_R: 72,
  AWARE_FADE: 24,
  /** Server cone: client 90° + 15° per side for aim changes within one patch and RTT. */
  SERVER_CONE_HALF_DEG: 105,
  SERVER_AWARE_R: 110,
  /** Side sample points at ±(RADIUS + TARGET_PAD) perpendicular to the ray. */
  TARGET_PAD: 8,
  /** Second eye pushed along the viewer's velocity so peeking a corner is not late. */
  LEAD_PX: 32,
  LEAD_S: 0.12,
  /** Keep sending a target this long after LOS is lost. */
  HYSTERESIS_MS: 300,
  /** "Still" when movedAt is at least this long ago. */
  BUSH_STILL_MS: 400,
  /** A still player in a bush is invisible beyond this. */
  BUSH_REVEAL_R: 160,
  /** Moving through a bush: seen at up to RANGE × this. */
  BUSH_MOVING_RANGE_MULT: 0.5,
  /** "In bush" = centre within this fraction of the bush radius (same as the client's bushAt). */
  BUSH_INSIDE_FRAC: 0.9,
  /** Shooting cancels bush concealment for this long. */
  SHOT_REVEAL_MS: 1500,
  /** Muzzle flash: weather/night range penalties and the NPC sight cap ignored this long after a shot. */
  FLASH_MS: 250,
  /** Floor of the environment range multiplier (night fog ≈ 400 px). */
  MIN_RANGE_MULT: 0.4,
  /** Interest management for ground items / corpses: 512 px cells, ±3 cell ring. */
  AOI_CELL: 512,
  AOI_RING: 3,
  /**
   * @deprecated NPC MODEL v5: NPC sight cap moved to NPC.VIEW_RANGE_CAP (npc.ts, same value). Kept
   * for one release while the server renames its bot viewers.
   */
  BOT_RANGE_CAP: 650,
} as const;

/** cos(105°) ≈ -0.2588: dot-product threshold of the server cone (no atan2 per pair). */
export const COS_SERVER_CONE = Math.cos((VISION.SERVER_CONE_HALF_DEG * Math.PI) / 180);

export interface VisionViewer {
  x: number;
  y: number;
  aim: number;
  /** Velocity px/s (from prevX/prevY) for the lead eye. */
  vx: number;
  vy: number;
}

export interface VisionTarget {
  x: number;
  y: number;
  inBush: boolean;
  /** Clock - movedAt. */
  stillMs: number;
  /** Clock - lastShotAt (Infinity if never). */
  sinceShotMs: number;
}

export interface VisionEnv {
  idx: CollisionIndex;
  /** visionRangeMult(sampleEnv(...).vis). */
  rangeMult: number;
  /** NPC viewers: NPC.VIEW_RANGE_CAP (calm) or NPC.VIEW_RANGE_ALERT (alerted); a muzzle flash ignores it. */
  rangeCap?: number;
  /**
   * NPC viewers (fair perception, npc.ts NPC_PERCEPTION): the target must also lie inside this
   * world-axis ellipse (inside a landscape phone's screen around the target), and a muzzle flash
   * widens it only to `flashSight` — never to the full VISION.RANGE.
   */
  sight?: { rx: number; ry: number };
  flashSight?: { rx: number; ry: number };
}

/** Environment vis → range multiplier, clamped to [MIN_RANGE_MULT, 1]. */
export function visionRangeMult(envVis: number): number {
  return Math.max(VISION.MIN_RANGE_MULT, Math.min(1, envVis));
}

/**
 * Authoritative "can V see T". Rays use the SIGHT mask: windows and sandbags are see-through,
 * fences block sight. Early-outs on the first clear ray (up to 2 eyes × 3 target points).
 */
export function canSee(env: VisionEnv, v: VisionViewer, t: VisionTarget): boolean {
  const dx = t.x - v.x, dy = t.y - v.y;
  const d2 = dx * dx + dy * dy;
  let R = VISION.RANGE * env.rangeMult;
  if (env.rangeCap !== undefined) R = Math.min(R, env.rangeCap);
  // Muzzle flash: a shooter is seen to the full VISION.RANGE by every viewer — weather / night and
  // the NPC sight cap included (v5 review fix: the cap used to hide a firing human from NPCs). An
  // NPC viewer still only sees it inside its flash ellipse (fair perception).
  const flash = t.sinceShotMs < VISION.FLASH_MS;
  if (flash) R = VISION.RANGE;
  const ell = flash ? env.flashSight ?? env.sight : env.sight;
  if (ell) {
    const u = dx / ell.rx, w = dy / ell.ry;
    if (u * u + w * w > 1) return false;
  }
  if (t.inBush && t.sinceShotMs > VISION.SHOT_REVEAL_MS) {
    R = t.stillMs >= VISION.BUSH_STILL_MS ? Math.min(R, VISION.BUSH_REVEAL_R) : R * VISION.BUSH_MOVING_RANGE_MULT;
  }
  const maxD = R + PLAYER.RADIUS;
  if (d2 > maxD * maxD) return false;
  const d = Math.sqrt(d2);
  if (d < 1e-6) return true;
  if (d > VISION.SERVER_AWARE_R && dx * Math.cos(v.aim) + dy * Math.sin(v.aim) < d * COS_SERVER_CONE) return false;
  const pad = PLAYER.RADIUS + VISION.TARGET_PAD;
  const px = (-dy / d) * pad, py = (dx / d) * pad;
  const sp = Math.hypot(v.vx, v.vy);
  const eyes: Array<[number, number]> = [[v.x, v.y]];
  if (sp > 1) {
    const l = Math.min(VISION.LEAD_PX, sp * VISION.LEAD_S) / sp;
    eyes.push([v.x + v.vx * l, v.y + v.vy * l]);
  }
  const M = SOLID.SIGHT;
  for (const [ex, ey] of eyes) {
    if (raycastSolidsDDA(env.idx, ex, ey, t.x, t.y, M) === Infinity) return true;
    if (raycastSolidsDDA(env.idx, ex, ey, t.x + px, t.y + py, M) === Infinity) return true;
    if (raycastSolidsDDA(env.idx, ex, ey, t.x - px, t.y - py, M) === Infinity) return true;
  }
  return false;
}

/** Bush lookup grid (bush centres bucketed; maxR bounds the query). Build once per map. */
export interface BushIndex {
  bushes: readonly Circle[];
  grid: UniformGrid;
  maxR: number;
  /** Scratch buffer reused by bushIndexAt. */
  scratch: number[];
}

export function buildBushIndex(bushes: readonly Circle[], width: number, height: number): BushIndex {
  const grid = new UniformGrid(width, height, VISION.AOI_CELL);
  let maxR = 0;
  bushes.forEach((b, i) => {
    grid.set(i, b.x, b.y);
    if (b.r > maxR) maxR = b.r;
  });
  return { bushes, grid, maxR, scratch: [] };
}

/** Index of the bush the point is "inside" (0.9 r), or -1. Same rule as the client's bushAt. */
export function bushIndexAt(bi: BushIndex, x: number, y: number): number {
  const ids = bi.grid.queryCircle(x, y, bi.maxR, bi.scratch);
  let best = -1;
  for (const i of ids) {
    const b = bi.bushes[i]!;
    const r = b.r * VISION.BUSH_INSIDE_FRAC;
    // Lowest index wins so the result does not depend on grid bucket order.
    if ((x - b.x) ** 2 + (y - b.y) ** 2 < r * r && (best < 0 || i < best)) best = i;
  }
  return best;
}

/**
 * Client: cone × range × awareness factor in [0,1] for per-entity alpha (multiplied by a CPU LOS
 * check against the occluder grid). `range` = VISION.RANGE × env range mult.
 */
export function coneAlpha(aim: number, dx: number, dy: number, range: number): number {
  const d = Math.hypot(dx, dy);
  const aware =
    d <= VISION.AWARE_R ? 1 : d >= VISION.AWARE_R + VISION.AWARE_FADE ? 0 : 1 - (d - VISION.AWARE_R) / VISION.AWARE_FADE;
  if (d > range) return aware;
  let a = Math.abs(Math.atan2(dy, dx) - aim) % (2 * Math.PI);
  if (a > Math.PI) a = 2 * Math.PI - a;
  const deg = (a * 180) / Math.PI;
  const full = VISION.CONE_HALF_DEG - VISION.CONE_FADE_DEG;
  const ang = deg <= full ? 1 : deg >= VISION.CONE_HALF_DEG ? 0 : 1 - (deg - full) / VISION.CONE_FADE_DEG;
  const r0 = range * VISION.RANGE_FADE_FROM;
  const rad = d <= r0 ? 1 : 1 - (d - r0) / (range - r0);
  return Math.max(aware, ang * rad);
}

/** AOI cell of a world point (items / corpses interest grid). */
export function aoiCell(x: number, y: number): { cx: number; cy: number } {
  return { cx: Math.floor(x / VISION.AOI_CELL), cy: Math.floor(y / VISION.AOI_CELL) };
}
