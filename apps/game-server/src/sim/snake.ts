import { ArraySchema } from "@colyseus/schema";
import {
  Player,
  Segment,
  SNAKE,
  economicMassToSnakeLengthMass,
} from "@extract/shared";

const TRAIL_PATH_STEP = 4;
const TRAIL_MAX_ARC_MULT = 2.2;

const headTrails = new Map<string, { x: number; y: number }[]>();

function arcLengthPath(path: { x: number; y: number }[]): number {
  if (path.length < 2) return 0;
  let t = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i]!;
    const b = path[i - 1]!;
    t += Math.hypot(a.x - b.x, a.y - b.y);
  }
  return t;
}

/** Point at distance `dist` from the head, walking backward along the path (oldest → head). */
function pointOnPathFromHead(path: { x: number; y: number }[], distFromHead: number) {
  if (path.length === 0) return { x: 0, y: 0 };
  const h = path[path.length - 1]!;
  if (distFromHead <= 0) return { x: h.x, y: h.y };
  if (path.length < 2) return { x: h.x, y: h.y };

  let i = path.length - 1;
  let need = distFromHead;
  while (i > 0) {
    const p1 = path[i]!;
    const p0 = path[i - 1]!;
    const dx = p0.x - p1.x;
    const dy = p0.y - p1.y;
    const L = Math.hypot(dx, dy);
    if (L < 1e-6) {
      i -= 1;
      continue;
    }
    if (need <= L) {
      const t = need / L;
      return { x: p1.x + t * dx, y: p1.y + t * dy };
    }
    need -= L;
    i -= 1;
  }
  const tail = path[0]!;
  return { x: tail.x, y: tail.y };
}

function trimHeadTrail(path: { x: number; y: number }[], bodyLen: number) {
  const cap = bodyLen * SNAKE.SEGMENT_SPACING * TRAIL_MAX_ARC_MULT;
  if (path.length < 3) return;
  while (path.length > 2 && arcLengthPath(path) > cap) {
    path.shift();
  }
}

function ensureTrailLongEnough(
  p: Player,
  path: { x: number; y: number }[],
  needArc: number,
) {
  if (path.length < 2) return;
  let total = arcLengthPath(path);
  if (total >= needArc) return;
  const maxExtra = p.body.length * SNAKE.SEGMENT_SPACING * 2;
  let added = 0;
  while (total < needArc && added < maxExtra) {
    const a = path[0]!;
    const b = path[1]!;
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const d = Math.hypot(dx, dy) || 0.0001;
    const nx = (dx / d) * TRAIL_PATH_STEP;
    const ny = (dy / d) * TRAIL_PATH_STEP;
    const n0 = { x: a.x + nx, y: a.y + ny };
    path.unshift(n0);
    total += TRAIL_PATH_STEP;
    added += TRAIL_PATH_STEP;
  }
}

function appendHeadToTrail(p: Player, path: { x: number; y: number }[]) {
  const last = path[path.length - 1];
  if (last) {
    const d = Math.hypot(p.headX - last.x, p.headY - last.y);
    if (d < 0.4) {
      last.x = p.headX;
      last.y = p.headY;
      return;
    }
  }
  path.push({ x: p.headX, y: p.headY });
}

function buildInitialTrail(
  p: Player,
  headX: number,
  headY: number,
) {
  const cos = Math.cos(p.angle);
  const sin = Math.sin(p.angle);
  const n = p.body.length;
  const maxD = Math.max(0, n) * SNAKE.SEGMENT_SPACING;
  const path: { x: number; y: number }[] = [];
  for (let d = maxD; d >= 0; d -= TRAIL_PATH_STEP) {
    path.push({ x: headX - cos * d, y: headY - sin * d });
  }
  if (path.length === 0) {
    path.push({ x: headX, y: headY });
  } else {
    const t = path[path.length - 1]!;
    t.x = headX;
    t.y = headY;
  }
  headTrails.set(p.sessionId, path);
}

export function targetSegmentCount(massUnits: bigint): number {
  const extra = massUnits / SNAKE.MASS_UNITS_PER_EXTRA_SEGMENT;
  const n =
    SNAKE.STARTING_SEGMENTS +
    Math.min(Number(extra), Math.max(0, SNAKE.MAX_SEGMENTS - SNAKE.STARTING_SEGMENTS));
  return Math.min(SNAKE.MAX_SEGMENTS, Math.max(SNAKE.STARTING_SEGMENTS, n));
}

/** Fixed head size for collisions; length carries mass growth, not girth. */
export function radiusFor(_massUnits: bigint): number {
  return SNAKE.BASE_HEAD_RADIUS;
}

export function initSnake(
  p: Player,
  x: number,
  y: number,
  mass: bigint,
  entryTierCents: bigint,
) {
  p.headX = x;
  p.headY = y;
  p.angle = Math.random() * Math.PI * 2;
  p.targetAngle = p.angle;
  p.massUnits = mass.toString();
  p.radius = radiusFor(mass);
  p.body = new ArraySchema<Segment>();
  const count = targetSegmentCount(
    economicMassToSnakeLengthMass(mass, entryTierCents),
  );
  for (let i = 0; i < count; i++) {
    const s = new Segment();
    s.x = x - Math.cos(p.angle) * SNAKE.SEGMENT_SPACING * (i + 1);
    s.y = y - Math.sin(p.angle) * SNAKE.SEGMENT_SPACING * (i + 1);
    p.body.push(s);
  }
  p.alive = true;
  p.diedAt = 0;
  p.extractStartedAt = 0;
  p.extractedAt = 0;
  p.exitOrder = 0;
  if (!p.sessionId) return;
  buildInitialTrail(p, x, y);
  const path = headTrails.get(p.sessionId);
  if (path) {
    const need = p.body.length * SNAKE.SEGMENT_SPACING;
    ensureTrailLongEnough(p, path, need);
    for (let i = 0; i < p.body.length; i++) {
      const s = p.body[i]!;
      const pt = pointOnPathFromHead(path, (i + 1) * SNAKE.SEGMENT_SPACING);
      s.x = pt.x;
      s.y = pt.y;
    }
  }
}

export function syncBodyToMass(p: Player, entryTierCents: bigint) {
  const target = targetSegmentCount(
    economicMassToSnakeLengthMass(BigInt(p.massUnits), entryTierCents),
  );
  while (p.body.length > target) {
    p.body.pop();
  }
  while (p.body.length < target) {
    const tail = p.body[p.body.length - 1] ?? { x: p.headX, y: p.headY };
    const s = new Segment();
    s.x = tail.x;
    s.y = tail.y;
    p.body.push(s);
  }
  if (p.sessionId) {
    const path = headTrails.get(p.sessionId);
    if (path) {
      const need = p.body.length * SNAKE.SEGMENT_SPACING;
      ensureTrailLongEnough(p, path, need);
    }
  }
}

export function migrateSnakeTrail(oldSessionId: string, newSessionId: string) {
  const t = headTrails.get(oldSessionId);
  if (t) {
    headTrails.delete(oldSessionId);
    headTrails.set(newSessionId, t);
  }
}

export function clearSnakeTrail(sessionId: string) {
  headTrails.delete(sessionId);
}

export function stepSnake(p: Player, dtMs: number) {
  if (!p.alive) return;
  const dt = dtMs / 1000;
  // Smooth turn
  let delta = p.targetAngle - p.angle;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  const maxTurn = SNAKE.TURN_RATE_PER_SEC * dt;
  if (delta > maxTurn) delta = maxTurn;
  if (delta < -maxTurn) delta = -maxTurn;
  p.angle += delta;

  const speed = SNAKE.BASE_SPEED * (p.boost ? SNAKE.BOOST_MULT : 1);
  p.headX += Math.cos(p.angle) * speed * dt;
  p.headY += Math.sin(p.angle) * speed * dt;

  const path = p.sessionId ? headTrails.get(p.sessionId) : undefined;
  if (!path || path.length === 0) {
    p.radius = radiusFor(BigInt(p.massUnits));
    return;
  }
  appendHeadToTrail(p, path);
  trimHeadTrail(path, p.body.length);
  const need = p.body.length * SNAKE.SEGMENT_SPACING;
  ensureTrailLongEnough(p, path, need);

  const spacing = SNAKE.SEGMENT_SPACING;
  for (let i = 0; i < p.body.length; i++) {
    const s = p.body[i]!;
    const pt = pointOnPathFromHead(path, (i + 1) * spacing);
    s.x = pt.x;
    s.y = pt.y;
  }
  p.radius = radiusFor(BigInt(p.massUnits));
}

export function growSnake(p: Player, add: bigint, entryTierCents: bigint) {
  const newMass = BigInt(p.massUnits) + add;
  p.massUnits = newMass.toString();
  syncBodyToMass(p, entryTierCents);
  p.radius = radiusFor(newMass);
}
