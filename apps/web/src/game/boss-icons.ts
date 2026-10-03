/**
 * Shared boss icons (skull marker, guard badge) as cached GraphicsContexts: every map marker, name
 * tag and toast reuses the same geometry, so nothing is re-tessellated per frame.
 */

import { GraphicsContext } from "pixi.js";
import { BOSS_COLOR, GUARD_COLOR, MARAUDER_COLOR } from "./boss";

const DARK = 0x16090a;
const skulls = new Map<string, GraphicsContext>();

/**
 * A skull about 2·r wide on a dark disc (r = disc radius). `ring` adds a coloured outline for map
 * markers. Cached per (color, r, ring).
 */
export function skullContext(color = BOSS_COLOR, r = 9, ring = true): GraphicsContext {
  const key = `${color}|${r}|${ring}`;
  const hit = skulls.get(key);
  if (hit && !hit.destroyed) return hit;
  const k = r / 9;
  const g = new GraphicsContext();
  g.circle(0, 0, r).fill({ color: DARK, alpha: 0.85 });
  if (ring) g.circle(0, 0, r).stroke({ width: Math.max(1.5, 2 * k), color, alpha: 0.95 });
  // Cranium + jaw.
  g.circle(0, -1.2 * k, 5.4 * k).fill(color);
  g.roundRect(-3.4 * k, 1.6 * k, 6.8 * k, 4.4 * k, 1.2 * k).fill(color);
  // Eye sockets, nose, teeth gaps.
  g.circle(-2.2 * k, -1.2 * k, 1.6 * k).fill(DARK);
  g.circle(2.2 * k, -1.2 * k, 1.6 * k).fill(DARK);
  g.poly([0, 0.6 * k, -0.9 * k, 2.2 * k, 0.9 * k, 2.2 * k]).fill(DARK);
  g.rect(-1.3 * k, 3.6 * k, 0.8 * k, 2.4 * k).fill(DARK);
  g.rect(0.5 * k, 3.6 * k, 0.8 * k, 2.4 * k).fill(DARK);
  skulls.set(key, g);
  return g;
}

let badge: GraphicsContext | null = null;

/** Guard badge: a small amber shield with a chevron (next to a guard's name tag). */
export function guardBadgeContext(): GraphicsContext {
  if (badge && !badge.destroyed) return badge;
  badge = new GraphicsContext()
    .poly([-6, -7, 6, -7, 6, 1, 0, 7, -6, 1])
    .fill({ color: GUARD_COLOR })
    .stroke({ width: 1.5, color: 0x111111 })
    .poly([-3.5, -3, 0, 0, 3.5, -3, 3.5, -0.5, 0, 2.5, -3.5, -0.5])
    .fill({ color: 0x2a1a08 });
  return badge;
}

let npcBadge: GraphicsContext | null = null;

/**
 * Marauder "NPC" badge (NPC MODEL v5): a small khaki tag with a double chevron, left of the name
 * tag and in kill-feed rows — marks a non-player at a glance without looking like a rank.
 */
export function npcBadgeContext(): GraphicsContext {
  if (npcBadge && !npcBadge.destroyed) return npcBadge;
  npcBadge = new GraphicsContext()
    .roundRect(-7, -6, 14, 12, 3)
    .fill({ color: MARAUDER_COLOR })
    .stroke({ width: 1.5, color: 0x111111 })
    .poly([-4, -3.2, 0, -0.6, 4, -3.2, 4, -1.2, 0, 1.4, -4, -1.2])
    .fill({ color: 0x23210f })
    .poly([-4, 0.6, 0, 3.2, 4, 0.6, 4, 2.6, 0, 5.2, -4, 2.6])
    .fill({ color: 0x23210f });
  return npcBadge;
}
