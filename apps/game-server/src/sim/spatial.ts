/**
 * Small geometric helpers for event routing (WP2). Pure functions, no Match.
 */

/**
 * Least distance (px) a clipped tracer must start from the hidden shooter. A start point closer
 * than this would pin the shooter's position down; beyond it the client only learns the line.
 */
export const CLIP_MIN_PX = 160;

/**
 * Where a hidden shooter's tracer may start for a listener at (cx, cy) with view radius R.
 * Ray: origin (ox, oy), unit direction (dx, dy), length len (already cut at the first wall).
 * - Origin outside the circle: the entry point into the circle (or null: the ray misses it, or ends
 *   before reaching it). The distance back to the shooter is unknown to the client.
 * - Origin inside the circle (hidden by a wall or the cone, but close): the point of closest
 *   approach to the listener, which depends only on the line, never on where along it the shooter
 *   stands; null when that point is behind the shooter, past the end of the ray, or closer than
 *   CLIP_MIN_PX to the shooter (the tracer start would give the shooter away).
 * Returns the distance t along the ray, or null.
 */
export function clipRayToCircle(
  ox: number, oy: number, dx: number, dy: number, len: number,
  cx: number, cy: number, R: number,
): number | null {
  const fx = ox - cx, fy = oy - cy;
  const b = fx * dx + fy * dy;
  const c = fx * fx + fy * fy - R * R;
  if (c > 0) {
    const disc = b * b - c;
    if (disc < 0) return null;
    const t = -b - Math.sqrt(disc);
    return t >= 0 && t <= len ? t : null;
  }
  const t = -b;
  return t >= CLIP_MIN_PX && t <= len ? t : null;
}
