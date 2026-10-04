/**
 * Weapons, armor, ammo, rarity, the hand grenade and the demo chest loot tables. Inventory item
 * definitions (ids, stacks, icons, junk values) live in item-defs.ts and build on these.
 * Weapons v2 (docs/WEAPONS_V2.md): SMG, LMG, revolver and crossbow are appended AFTER the four v1
 * guns. Never reorder WEAPONS: WEAPON_IDS order is the shot-sound variant (sound.ts weaponVariant)
 * and the replay weapon code (replay.ts REPLAY_WEAPONS).
 */

import { SOLID, forEachSolidNear, segmentCircleT, type CollisionIndex } from "./geometry.js";

export type WeaponId = "pistol" | "rifle" | "shotgun" | "sniper" | "smg" | "lmg" | "revolver" | "crossbow";
export type AmmoType = "light" | "shell" | "heavy" | "bolt";
/** What a kill is credited to (KillMsg.weapon, replays): a gun or a thrown hand grenade. */
export type KillWeapon = WeaponId | "grenade";
export type HealKind = "bandage" | "medkit";
/** v1 loot-roll kinds (CHEST_TABLES); v2 ground items carry an item def id instead. */
export type GroundItemKind = "weapon" | "armor" | "ammo" | "bandage" | "medkit";

/** 0 common, 1 rare, 2 epic, 3 legendary. */
export type Rarity = 0 | 1 | 2 | 3;
export const RARITY_NAMES = ["common", "rare", "epic", "legendary"] as const;
export const RARITY_COLORS = [0xb8c0c8, 0x3d8bff, 0xa64dff, 0xffc21a] as const;
/** Damage multiplier by rarity. */
export const RARITY_DAMAGE_MULT = [1.0, 1.1, 1.2, 1.3] as const;

export interface WeaponDef {
  id: WeaponId;
  name: string;
  ammo: AmmoType;
  /** Damage per pellet before rarity and armor. */
  damage: number;
  pellets: number;
  /** Minimum time between shots. */
  fireIntervalMs: number;
  /** Full-auto when the trigger is held; otherwise one shot per press. */
  auto: boolean;
  /** Projectile speed, px/s. */
  bulletSpeed: number;
  /** Max projectile travel distance, px. */
  range: number;
  /** Max random deviation of each pellet from the aim, radians (uniform in [-spread, spread]). */
  spread: number;
  magSize: number;
  reloadMs: number;
  /** Distance from the player center to the muzzle along the aim. */
  muzzle: number;
  /** Gunshot hearing radius, px (sound.ts; × sampleEnv().hear). */
  soundRadius: number;
  /**
   * false = no muzzle flash (crossbow): the shot never reveals the shooter through the flash rule
   * (vision FLASH_MS), and clients draw no flash. Absent = a normal gun with a flash.
   */
  flash?: false;
  /** Lowest rarity the weapon exists at in live play (LMG and crossbow: rare and above). Absent = common. */
  minRarity?: Rarity;
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  pistol: {
    id: "pistol", name: "Pistol", ammo: "light",
    damage: 15, pellets: 1, fireIntervalMs: 280, auto: false,
    bulletSpeed: 1700, range: 750, spread: 0.035,
    magSize: 12, reloadMs: 1200, muzzle: 44, soundRadius: 2000,
  },
  rifle: {
    id: "rifle", name: "Assault rifle", ammo: "light",
    damage: 12, pellets: 1, fireIntervalMs: 100, auto: true,
    bulletSpeed: 1900, range: 900, spread: 0.06,
    magSize: 30, reloadMs: 2000, muzzle: 58, soundRadius: 2400,
  },
  shotgun: {
    id: "shotgun", name: "Shotgun", ammo: "shell",
    damage: 9, pellets: 7, fireIntervalMs: 850, auto: false,
    bulletSpeed: 1500, range: 420, spread: 0.2,
    magSize: 5, reloadMs: 2600, muzzle: 56, soundRadius: 2200,
  },
  sniper: {
    id: "sniper", name: "Sniper rifle", ammo: "heavy",
    damage: 75, pellets: 1, fireIntervalMs: 1400, auto: false,
    bulletSpeed: 3200, range: 1700, spread: 0.004,
    magSize: 5, reloadMs: 2800, muzzle: 66, soundRadius: 3600,
  },
  // ---- Weapons v2 (docs/WEAPONS_V2.md §3). Append only, never reorder.
  smg: {
    id: "smg", name: "SMG", ammo: "light",
    damage: 9, pellets: 1, fireIntervalMs: 75, auto: true,
    bulletSpeed: 1700, range: 600, spread: 0.1,
    magSize: 25, reloadMs: 1600, muzzle: 48, soundRadius: 1800,
  },
  lmg: {
    id: "lmg", name: "Light machine gun", ammo: "light",
    damage: 12, pellets: 1, fireIntervalMs: 110, auto: true,
    bulletSpeed: 2000, range: 1000, spread: 0.07,
    magSize: 60, reloadMs: 5000, muzzle: 70, soundRadius: 2800, minRarity: 1,
  },
  revolver: {
    id: "revolver", name: "Revolver", ammo: "heavy",
    damage: 34, pellets: 1, fireIntervalMs: 450, auto: false,
    bulletSpeed: 2100, range: 800, spread: 0.025,
    magSize: 6, reloadMs: 2800, muzzle: 46, soundRadius: 2300,
  },
  crossbow: {
    id: "crossbow", name: "Crossbow", ammo: "bolt",
    damage: 60, pellets: 1, fireIntervalMs: 400, auto: false,
    bulletSpeed: 1100, range: 1100, spread: 0.008,
    magSize: 1, reloadMs: 2300, muzzle: 52, soundRadius: 450, flash: false, minRarity: 1,
  },
};

export const WEAPON_IDS = Object.keys(WEAPONS) as WeaponId[];

/** Does `weapon` exist at `rarity` in live play (WeaponDef.minRarity)? Loot tables and offers obey it. */
export function weaponRarityAllowed(weapon: WeaponId, rarity: number): boolean {
  return rarity >= (WEAPONS[weapon].minRarity ?? 0) && rarity <= 3;
}

/** Does this weapon show a muzzle flash (vision flash reveal, client flash sprite)? */
export function weaponHasFlash(weapon: WeaponId): boolean {
  return WEAPONS[weapon].flash !== false;
}

export interface ArmorDef {
  level: 1 | 2 | 3;
  /** Share of incoming damage absorbed while durability lasts. */
  absorb: number;
  /** Damage points the armor can absorb before it breaks. */
  durability: number;
}

export const ARMOR: Record<1 | 2 | 3, ArmorDef> = {
  1: { level: 1, absorb: 0.2, durability: 80 },
  2: { level: 2, absorb: 0.35, durability: 130 },
  3: { level: 3, absorb: 0.5, durability: 180 },
};

export const AMMO = {
  light: { pickup: 30, maxCarry: 180 },
  shell: { pickup: 10, maxCarry: 40 },
  heavy: { pickup: 10, maxCarry: 30 },
  bolt: { pickup: 5, maxCarry: 20 },
} as const satisfies Record<AmmoType, { pickup: number; maxCarry: number }>;

/** One possible drop inside a chest; `weight` is relative within its table. */
export type LootRoll =
  | { kind: "weapon"; weapon: WeaponId; rarity: Rarity; weight: number }
  | { kind: "armor"; level: 1 | 2 | 3; weight: number }
  | { kind: "ammo"; ammo: AmmoType; weight: number }
  | { kind: "bandage" | "medkit"; weight: number };

export interface ChestTable {
  /** How many rolls a chest of this rarity gives. */
  rolls: number;
  loot: LootRoll[];
}

/**
 * Chest contents by chest rarity. DEMO MODE ONLY: in live mode valuables come only from the lost
 * pool. lootRollToItem (item-defs.ts) converts a roll to a def.
 */
export const CHEST_TABLES: Record<Rarity, ChestTable> = {
  0: {
    rolls: 2,
    loot: [
      { kind: "ammo", ammo: "light", weight: 30 },
      { kind: "ammo", ammo: "shell", weight: 12 },
      { kind: "bandage", weight: 25 },
      { kind: "weapon", weapon: "rifle", rarity: 0, weight: 10 },
      { kind: "weapon", weapon: "shotgun", rarity: 0, weight: 10 },
      { kind: "armor", level: 1, weight: 10 },
      { kind: "medkit", weight: 3 },
      // Weapons v2 (WEAPONS_V2 §7.5, demo only).
      { kind: "weapon", weapon: "smg", rarity: 0, weight: 6 },
    ],
  },
  1: {
    rolls: 3,
    loot: [
      { kind: "weapon", weapon: "rifle", rarity: 1, weight: 14 },
      { kind: "weapon", weapon: "shotgun", rarity: 1, weight: 12 },
      { kind: "weapon", weapon: "sniper", rarity: 0, weight: 6 },
      { kind: "armor", level: 2, weight: 12 },
      { kind: "ammo", ammo: "light", weight: 18 },
      { kind: "ammo", ammo: "heavy", weight: 8 },
      { kind: "medkit", weight: 10 },
      { kind: "weapon", weapon: "smg", rarity: 1, weight: 8 },
      { kind: "weapon", weapon: "revolver", rarity: 0, weight: 6 },
    ],
  },
  2: {
    rolls: 3,
    loot: [
      { kind: "weapon", weapon: "rifle", rarity: 2, weight: 12 },
      { kind: "weapon", weapon: "sniper", rarity: 1, weight: 10 },
      { kind: "weapon", weapon: "shotgun", rarity: 2, weight: 10 },
      { kind: "armor", level: 3, weight: 8 },
      { kind: "armor", level: 2, weight: 10 },
      { kind: "ammo", ammo: "heavy", weight: 10 },
      { kind: "medkit", weight: 12 },
      { kind: "weapon", weapon: "lmg", rarity: 1, weight: 5 },
      { kind: "weapon", weapon: "crossbow", rarity: 1, weight: 6 },
      { kind: "weapon", weapon: "revolver", rarity: 1, weight: 6 },
      { kind: "ammo", ammo: "bolt", weight: 4 },
    ],
  },
  3: {
    rolls: 4,
    loot: [
      { kind: "weapon", weapon: "rifle", rarity: 3, weight: 10 },
      { kind: "weapon", weapon: "sniper", rarity: 3, weight: 10 },
      { kind: "weapon", weapon: "shotgun", rarity: 3, weight: 6 },
      { kind: "armor", level: 3, weight: 14 },
      { kind: "medkit", weight: 12 },
      { kind: "ammo", ammo: "heavy", weight: 8 },
      { kind: "weapon", weapon: "lmg", rarity: 3, weight: 5 },
      { kind: "weapon", weapon: "crossbow", rarity: 3, weight: 5 },
      { kind: "ammo", ammo: "bolt", weight: 4 },
    ],
  },
};

/**
 * Should F take this armor over what is worn? Remaining durability is the total damage a vest can
 * still absorb, so it decides first; the level only breaks ties. A worn-out high-level vest never
 * blocks a fresh lower-level one. One rule for the server, the bots and the HUD hint.
 */
export function armorIsUpgrade(
  worn: { armor: number; armorDur: number },
  level: number,
  dur: number,
): boolean {
  const wornDur = worn.armor > 0 ? worn.armorDur : 0;
  return dur > wornDur || (dur === wornDur && level > worn.armor);
}

/** Damage after rarity and armor. Returns the HP loss and how much armor durability was used. */
export function applyDamage(
  rawDamage: number,
  armorLevel: number,
  armorDur: number,
): { hpLoss: number; armorUsed: number } {
  if (armorLevel < 1 || armorLevel > 3 || armorDur <= 0) {
    return { hpLoss: rawDamage, armorUsed: 0 };
  }
  const def = ARMOR[armorLevel as 1 | 2 | 3];
  const absorbed = Math.min(rawDamage * def.absorb, armorDur);
  return { hpLoss: rawDamage - absorbed, armorUsed: absorbed };
}

// ---------------------------------------------------------------- hand grenade (WEAPONS_V2 §4)

/**
 * Hand grenade: a consumable (item def "grenade", category "throwable", stack 2, no uid, never sold
 * for SOL, never in the pool). The server computes the whole flight when it is thrown (straight
 * line, slowing to rest at the aimed point after FLIGHT_MS, bouncing off SHOT walls with BOUNCE_KEEP
 * of its speed) and explodes it FUSE_MS after the throw. Damage falls off linearly from DAMAGE at
 * FULL_PX to EDGE_DAMAGE at EDGE_PX (centre to centre) and only reaches a target whose centre the
 * blast centre sees through SHOT walls (windows let it through, like bullets). Armor absorbs it as
 * any hit; it hurts the thrower, never a party mate (PARTY.FRIENDLY_FIRE).
 */
export const GRENADE = {
  /** Throw distance at throw fraction 0 / 1 (the cursor distance picks a point in between). */
  MIN_PX: 120,
  MAX_PX: 560,
  /** Time to reach the aimed point when nothing is in the way. */
  FLIGHT_MS: 600,
  /** From the throw to the explosion. */
  FUSE_MS: 2500,
  /** Share of the speed kept after hitting a wall (loses 65 %). */
  BOUNCE_KEEP: 0.35,
  /** At most this many bounces are simulated (then it rests where it is). */
  MAX_BOUNCES: 4,
  /** Distance kept from a wall face after a bounce. */
  WALL_GAP_PX: 3,
  DAMAGE: 85,
  /** Full damage within this distance of the blast centre… */
  FULL_PX: 64,
  /** …falling linearly to EDGE_DAMAGE at EDGE_PX, nothing beyond. */
  EDGE_PX: 240,
  EDGE_DAMAGE: 10,
  /** No firing for this long after a throw. */
  FIRE_LOCK_MS: 600,
  /** At least this long between two throws. */
  COOLDOWN_MS: 1000,
  /** Client: the warning ring (radius EDGE_PX) shows for the last WARN_MS of the fuse. */
  WARN_MS: 1000,
  /** NPCs run from a grenade resting / landing within this distance (server npc.ts). */
  NPC_FLEE_PX: 260,
  /** NPCs notice a thrown grenade this long after the throw. */
  NPC_NOTICE_MS: 300,
} as const;

/** Distance of a throw with fraction `frac` (0..1, clamped; non-finite = 1). */
export function grenadeThrowPx(frac: number): number {
  const f = Number.isFinite(frac) ? Math.max(0, Math.min(1, frac)) : 1;
  return GRENADE.MIN_PX + (GRENADE.MAX_PX - GRENADE.MIN_PX) * f;
}

/** Raw blast damage at `dist` px from the blast centre (before armor); 0 beyond EDGE_PX. */
export function grenadeDamageAt(dist: number): number {
  if (!(dist >= 0)) return 0;
  if (dist <= GRENADE.FULL_PX) return GRENADE.DAMAGE;
  if (dist > GRENADE.EDGE_PX) return 0;
  const k = (dist - GRENADE.FULL_PX) / (GRENADE.EDGE_PX - GRENADE.FULL_PX);
  return GRENADE.DAMAGE - (GRENADE.DAMAGE - GRENADE.EDGE_DAMAGE) * k;
}

/** One point of a grenade flight; `t` = ms after the throw. `bounce` = it hit a wall here. */
export interface GrenadePoint {
  x: number;
  y: number;
  t: number;
  bounce: boolean;
}

const GRENADE_EPS = 1e-9;

/** First SHOT solid on the segment, with the outward normal of the face hit; null when clear. */
function rayHit(idx: CollisionIndex, x0: number, y0: number, x1: number, y1: number): { t: number; nx: number; ny: number } | null {
  const dx = x1 - x0;
  const dy = y1 - y0;
  let best: { t: number; nx: number; ny: number } | null = null;
  forEachSolidNear(
    idx, x0, y0, x1, y1, SOLID.SHOT,
    (r) => {
      // Slab test that remembers which axis set the entry time (the face normal).
      let tmin = 0;
      let tmax = 1;
      let nx = 0;
      let ny = 0;
      for (const ax of [0, 1] as const) {
        const p = ax === 0 ? x0 : y0;
        const d = ax === 0 ? dx : dy;
        const lo = ax === 0 ? r.x : r.y;
        const hi = ax === 0 ? r.x + r.w : r.y + r.h;
        if (Math.abs(d) < GRENADE_EPS) {
          if (p < lo || p > hi) return;
          continue;
        }
        const t1 = (lo - p) / d;
        const t2 = (hi - p) / d;
        const tin = Math.min(t1, t2);
        const tout = Math.max(t1, t2);
        if (tin > tmin) {
          tmin = tin;
          nx = ax === 0 ? -Math.sign(d) : 0;
          ny = ax === 1 ? -Math.sign(d) : 0;
        }
        tmax = Math.min(tmax, tout);
        if (tmin > tmax) return;
      }
      if (nx === 0 && ny === 0) {
        // Started inside (or on) the rect: bounce straight back.
        const l = Math.hypot(dx, dy) || 1;
        nx = -dx / l;
        ny = -dy / l;
      }
      if (!best || tmin < best.t) best = { t: tmin, nx, ny };
    },
    (c) => {
      const t = segmentCircleT(x0, y0, dx, dy, c.x, c.y, c.r);
      if (t === Infinity || (best && t >= best.t)) return;
      const hx = x0 + dx * t - c.x;
      const hy = y0 + dy * t - c.y;
      const l = Math.hypot(hx, hy);
      const dl = Math.hypot(dx, dy) || 1;
      best = l > GRENADE_EPS ? { t, nx: hx / l, ny: hy / l } : { t, nx: -dx / dl, ny: -dy / dl };
    },
  );
  return best;
}

/** First crossing of the map edge (x 0..w, y 0..h) by the segment, as a wall hit; null when it stays inside. */
function edgeHit(x0: number, y0: number, x1: number, y1: number, w: number, h: number): { t: number; nx: number; ny: number } | null {
  let best: { t: number; nx: number; ny: number } | null = null;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const test = (t: number, nx: number, ny: number) => {
    if (t >= 0 && t <= 1 && (!best || t < best.t)) best = { t, nx, ny };
  };
  if (x1 < 0 && dx < 0) test((0 - x0) / dx, 1, 0);
  if (x1 > w && dx > 0) test((w - x0) / dx, -1, 0);
  if (y1 < 0 && dy < 0) test((0 - y0) / dy, 0, 1);
  if (y1 > h && dy > 0) test((h - y0) / dy, 0, -1);
  return best;
}

/**
 * The whole flight of a grenade thrown from (x0, y0) toward `angle` to land `dist` px away: uniform
 * deceleration that comes to rest at the aimed point after GRENADE.FLIGHT_MS when nothing is in the
 * way. A SHOT wall (and, with `bounds`, the map edge) reflects it (GRENADE.WALL_GAP_PX off the face)
 * keeping GRENADE.BOUNCE_KEEP of its speed, at most GRENADE.MAX_BOUNCES times; then it rests. Players
 * never stop it. Pure: the server's throw and the client's aim preview call it alike.
 */
export function grenadePath(
  idx: CollisionIndex,
  x0: number,
  y0: number,
  angle: number,
  dist: number,
  bounds?: { width: number; height: number },
): GrenadePoint[] {
  const T = GRENADE.FLIGHT_MS / 1000;
  const d0 = Math.max(0, dist);
  let v = (2 * d0) / T;
  const a = v > 0 ? v / T : 1;
  let dx = Math.cos(angle);
  let dy = Math.sin(angle);
  let x = x0;
  let y = y0;
  let t = 0;
  const pts: GrenadePoint[] = [{ x, y, t: 0, bounce: false }];
  for (let b = 0; b <= GRENADE.MAX_BOUNCES; b++) {
    const travel = (v * v) / (2 * a);
    if (travel < 0.5) break;
    const ex = x + dx * travel;
    const ey = y + dy * travel;
    const wall = rayHit(idx, x, y, ex, ey);
    const edge = bounds ? edgeHit(x, y, ex, ey, bounds.width, bounds.height) : null;
    const hit = wall && edge ? (edge.t < wall.t ? edge : wall) : (wall ?? edge);
    if (!hit) {
      t += (v / a) * 1000;
      pts.push({ x: ex, y: ey, t, bounce: false });
      return pts;
    }
    const s = Math.max(0, hit.t * travel - GRENADE.WALL_GAP_PX);
    const vAt = Math.sqrt(Math.max(0, v * v - 2 * a * s));
    t += ((v - vAt) / a) * 1000;
    x += dx * s;
    y += dy * s;
    pts.push({ x, y, t, bounce: true });
    const dot = dx * hit.nx + dy * hit.ny;
    dx -= 2 * dot * hit.nx;
    dy -= 2 * dot * hit.ny;
    v = vAt * GRENADE.BOUNCE_KEEP;
  }
  // Out of bounces (or speed): it rests where it is (the last point).
  const last = pts[pts.length - 1]!;
  if (last.bounce && pts.length > 1) {
    // Keep a resting point distinct from the bounce so the client's polyline ends cleanly.
    pts.push({ x: last.x, y: last.y, t: last.t + 1, bounce: false });
  }
  return pts;
}
