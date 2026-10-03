/**
 * Boss presentation helpers (loot economy v4, client side). Pure: no Pixi, no window, no audio —
 * boss-hud.ts (the GameSystem), entities.ts (PlayerView), minimap.ts and fullmap.ts draw with them.
 *
 * The server marks NPCs with Player.role (NPC_ROLE: 1 boss, 2 guard) and Player.maxHp; the boss kind
 * is only in the nickname (BOSSES[kind].name / guardName), so kindOfNpc falls back to the nearest
 * BossSpot when a nickname does not match (renamed bosses, older servers).
 */

import { BOSSES, BOSS_KINDS, NPC_ROLE, PLAYER, zoneAt, type BossKind, type BossSpot, type MapData } from "@extract/shared";

export type NpcRole = "boss" | "guard" | null;

export function npcRole(role: number | undefined): NpcRole {
  if (role === NPC_ROLE.BOSS) return "boss";
  if (role === NPC_ROLE.GUARD) return "guard";
  return null;
}

/** Boss red / guard amber: rings, name tags, map skulls. */
export const BOSS_COLOR = 0xff3b30;
export const GUARD_COLOR = 0xff922b;
/** Guard body tint (khaki: reads as "uniformed", distinct from the player colour rings). */
export const GUARD_TINT = 0xd8c08a;
/** Boss sprite size relative to PLAYER_SPRITE_SIZE. */
export const BOSS_SCALE = 1.4;
/** Guard sprite size relative to PLAYER_SPRITE_SIZE (a touch bigger than a player). */
export const GUARD_SCALE = 1.08;

/** Boss kind from a nickname (boss name or guard name, case-insensitive), or null. */
export function kindOfNickname(nickname: string): BossKind | null {
  const n = nickname.trim().toLowerCase();
  if (!n) return null;
  for (const k of BOSS_KINDS) {
    const b = BOSSES[k];
    if (n === b.name.toLowerCase() || n === b.guardName.toLowerCase()) return k;
  }
  for (const k of BOSS_KINDS) {
    if (n.startsWith(BOSSES[k].name.toLowerCase())) return k;
  }
  return null;
}

/** Nearest boss spot's kind within maxDist (fallback when the nickname does not tell). */
export function nearestBossKind(bosses: readonly Pick<BossSpot, "kind" | "x" | "y">[], x: number, y: number, maxDist = 4000): BossKind | null {
  let best: BossKind | null = null;
  let bestD = maxDist * maxDist;
  for (const b of bosses) {
    const d = (b.x - x) ** 2 + (b.y - y) ** 2;
    if (d <= bestD) {
      bestD = d;
      best = b.kind;
    }
  }
  return best;
}

/** Boss kind of an NPC (role ≠ 0): nickname first, then the nearest boss spot. */
export function kindOfNpc(
  p: { nickname: string; x: number; y: number },
  bosses: readonly Pick<BossSpot, "kind" | "x" | "y">[] = [],
): BossKind | null {
  return kindOfNickname(p.nickname) ?? nearestBossKind(bosses, p.x, p.y);
}

/** Name tag: "FOREMAN" for a boss, the guard name for a guard ("Elevator thug"), else the nickname. */
export function npcNameTag(role: NpcRole, kind: BossKind | null, nickname: string): string {
  if (role === "boss") return (kind ? BOSSES[kind].name : nickname).toUpperCase();
  if (role === "guard") return kind ? BOSSES[kind].guardName : nickname;
  return nickname;
}

/** "Foreman's turf". */
export function turfLine(kind: BossKind): string {
  return `${BOSSES[kind].name}'s turf`;
}

/** HP fraction 0..1 against the per-runtime maximum (Player.maxHp; 0 / missing = PLAYER.MAX_HP). */
export function hpFraction(hp: number, maxHp: number | undefined): number {
  const max = maxHp && maxHp > 0 ? maxHp : PLAYER.MAX_HP;
  return Math.max(0, Math.min(1, hp / max));
}

/** The boss kind whose turf (POI zone with `boss`) contains (x, y), or null. */
export function bossTurfAt(map: Pick<MapData, "zones">, x: number, y: number): BossKind | null {
  return zoneAt(map as MapData, x, y)?.boss ?? null;
}

// ---------------------------------------------------------------------------------------------
// Minimap hint
// ---------------------------------------------------------------------------------------------

/** World px: a boss spot this close gets an edge pip on the minimap even when off-window. */
export const BOSS_HINT_NEAR_PX = 4200;

export interface BossHint {
  /** Minimap coords (0..size). */
  x: number;
  y: number;
  /** Clamped to the minimap edge (the spot is outside the window). */
  edge: boolean;
}

/**
 * Where to draw a boss spot on a minimap window `win` (world rect) of `size` px. Inside the window:
 * its position. Outside but within `near` of the player: clamped to the edge (inset by `inset`).
 * Otherwise null.
 */
export function minimapBossHint(
  win: { x: number; y: number; w: number; h: number },
  spot: { x: number; y: number },
  self: { x: number; y: number } | null,
  size: number,
  near = BOSS_HINT_NEAR_PX,
  inset = 7,
): BossHint | null {
  const s = size / win.w;
  const px = (spot.x - win.x) * s;
  const py = (spot.y - win.y) * (size / win.h);
  if (px >= 0 && px <= size && py >= 0 && py <= size) return { x: px, y: py, edge: false };
  if (!self || Math.hypot(spot.x - self.x, spot.y - self.y) > near) return null;
  // Clamp along the ray from the minimap centre, so the pip points toward the spot.
  const cx = size / 2;
  const cy = size / 2;
  const dx = px - cx;
  const dy = py - cy;
  const half = size / 2 - inset;
  const k = half / Math.max(Math.abs(dx), Math.abs(dy), 1e-6);
  return { x: cx + dx * k, y: cy + dy * k, edge: true };
}

// ---------------------------------------------------------------------------------------------
// Alert sting
// ---------------------------------------------------------------------------------------------

/** No second sting within this (a fight keeps re-seeing the same group). */
export const STING_COOLDOWN_MS = 30_000;
/** An NPC that left view this long ago counts as a fresh sighting when it comes back. */
export const RESIGHT_MS = 20_000;

/**
 * Decides when the boss alert sting plays: the first sighting of a boss or guard, or being shot by
 * one, at most once per STING_COOLDOWN_MS. A sighting of the boss itself is "major" (a boss sting
 * may break a guard sting's cooldown once). Pure: feed it ids and a clock.
 */
export class BossAlertTracker {
  private readonly lastSeen = new Map<string, number>();
  private lastStingAt = Number.NEGATIVE_INFINITY;
  private bossStung = new Set<BossKind>();

  constructor(
    private readonly cooldownMs = STING_COOLDOWN_MS,
    private readonly resightMs = RESIGHT_MS,
  ) {}

  /**
   * An NPC is in view this scan. Returns "boss" / "guard" when a sting should play now, else null.
   */
  sight(id: string, role: NpcRole, kind: BossKind | null, nowMs: number): NpcRole {
    if (!role) return null;
    const prev = this.lastSeen.get(id);
    this.lastSeen.set(id, nowMs);
    const fresh = prev === undefined || nowMs - prev > this.resightMs;
    if (!fresh) return null;
    // First look at the boss itself always lands (once per boss), even inside a guard's cooldown.
    if (role === "boss" && kind && !this.bossStung.has(kind)) {
      this.bossStung.add(kind);
      this.lastStingAt = nowMs;
      return "boss";
    }
    if (nowMs - this.lastStingAt < this.cooldownMs) return null;
    this.lastStingAt = nowMs;
    return role;
  }

  /** The local player was hit by an NPC of this role. */
  shotBy(role: NpcRole, nowMs: number): NpcRole {
    if (!role || nowMs - this.lastStingAt < this.cooldownMs) return null;
    this.lastStingAt = nowMs;
    return role;
  }

  /** Keep the map small: forget NPCs not seen for a long time. */
  prune(nowMs: number): void {
    for (const [id, t] of this.lastSeen) if (nowMs - t > this.resightMs * 3) this.lastSeen.delete(id);
  }
}

// ---------------------------------------------------------------------------------------------
// Tension cue
// ---------------------------------------------------------------------------------------------

/** A tension swell restarts this often while you stay on a living boss's turf. */
export const TENSION_REPEAT_MS = 7_000;

/**
 * Whether the tension cue should be running: alive, on a boss turf, and that boss not known dead.
 */
export function tensionKind(turf: BossKind | null, alive: boolean, dead: ReadonlySet<BossKind>): BossKind | null {
  if (!alive || !turf || dead.has(turf)) return null;
  return turf;
}

// ---------------------------------------------------------------------------------------------
// Screen boss bar
// ---------------------------------------------------------------------------------------------

/** Ease the displayed HP fraction toward the real one (damage chunks drain, not jump). */
export function easeBar(shown: number, target: number, dtMs: number, tauMs = 180): number {
  if (!Number.isFinite(shown)) return target;
  if (target > shown) return target; // heals snap up
  const k = 1 - Math.exp(-Math.max(0, dtMs) / tauMs);
  const v = shown + (target - shown) * k;
  return Math.abs(v - target) < 0.002 ? target : v;
}

/** The boss to show on the screen bar: the closest living one to `cam` within `maxDist`. */
export function pickBarBoss<T extends { x: number; y: number }>(bosses: readonly T[], cam: { x: number; y: number }, maxDist: number): T | null {
  let best: T | null = null;
  let bestD = maxDist * maxDist;
  for (const b of bosses) {
    const d = (b.x - cam.x) ** 2 + (b.y - cam.y) ** 2;
    if (d <= bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}
