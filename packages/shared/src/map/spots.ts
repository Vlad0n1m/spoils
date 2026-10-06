/**
 * Gameplay spots (map memo §4.8, §6, §7): extracts, side spawns, static containers (indexed —
 * the index is the container id everywhere), loose loot spots, boss spots, ambient emitters, and
 * the reachability validation that makes the generator's output trustworthy.
 */

import { WORLD } from "../constants.js";
import type { Rect } from "../geometry.js";
import { MARAUDER, NPC, NPC_CAMPS, POI_GARRISON, npcClassOfTier } from "../npc.js";
import type { Rng } from "../rng.js";
import type { GenCtx } from "./context.js";
import { floodWalk, getCollisionIndex, getWalkGrid, nearestWalkCell, reachedNear, walkCellOf } from "./query.js";
import { BOSS_BUILDING_PREFS, BOSS_CHANCE, BOSS_GUARD_COUNT, CAMP_BY_TIER, EXTRACT_RADIUS, STEPPE_EXTRACTS, ZONE_CAMPS } from "./steppe.js";
import { outdoorContainers } from "./props.js";
import { ROAD_MASK } from "./terrain.js";
import {
  TERRAIN,
  TERRAIN_INDOOR,
  TERRAIN_KIND_MASK,
  type BossKind,
  type Building,
  type BuildingArch,
  type ContainerKind,
  type ContainerSpot,
  type LootTier,
  type MapData,
  type MapSide,
  type NpcPost,
  type Zone,
} from "./types.js";
import { chance, dist2, grow, inRect, overlaps, pickW, ri, shuffle } from "./util.js";

// ───────────────────────── extracts and spawns

export function placeExtracts(ctx: GenCtx): void {
  for (const e of STEPPE_EXTRACTS) {
    const x = ctx.b(e.at[0]), y = ctx.b(e.at[1]);
    ctx.extracts.push({
      id: e.id, name: e.name, x, y, r: EXTRACT_RADIUS, side: e.side, kind: "always",
      ...(e.closesAtMs !== undefined ? { closesAtMs: e.closesAtMs } : {}),
    });
    // Keep the circle (plus a lane around it) clear of every solid.
    const m = EXTRACT_RADIUS + 64;
    ctx.reserve({ x: x - m, y: y - m, w: 2 * m, h: 2 * m });
  }
}

/** Spawn rules at BLOCK = 1024; spacings scale with the block (the 853 px fallback map). */
export const SPAWN = {
  /** Spawn band: this far in from the map edge. */
  DEPTH_MIN: 300,
  DEPTH_MAX: 800,
  /** Candidate slots along each edge. */
  STEP: 1450,
  MIN_APART: 1400,
  MIN_FROM_EXTRACT: 2000,
  MIN_PER_SIDE: 8,
} as const;

/**
 * Spawns in a band along the edges (40 on the 24-block layout, 48 on map v2), ≥ 1400 px apart and
 * ≥ 2000 px from any extract, never inside a POI. Placed after POIs and before props so trees respect the reserved circle.
 */
export function placeSpawns(ctx: GenCtx): void {
  const rng = ctx.rng("spawns");
  const W = ctx.width, H = ctx.height;
  const k = ctx.block / 1024;
  const step = Math.round(SPAWN.STEP * k);
  const apart = Math.round(SPAWN.MIN_APART * k), fromExtract = Math.round(SPAWN.MIN_FROM_EXTRACT * k);
  for (let si = 0; si < 4; si++) {
    const side = si as MapSide;
    const len = side === 0 || side === 2 ? W : H;
    for (let t = Math.round(len * 0.06); t < len * 0.94; t += step) {
      for (let attempt = 0; attempt < 14; attempt++) {
        const along = t + ri(rng, -320, 320);
        const depth = ri(rng, SPAWN.DEPTH_MIN, SPAWN.DEPTH_MAX);
        const x = side === 0 || side === 2 ? along : side === 1 ? W - depth : depth;
        const y = side === 1 || side === 3 ? along : side === 0 ? depth : H - depth;
        if (!spawnOk(ctx, x, y, apart, fromExtract)) continue;
        ctx.spawns.push({ x, y, side });
        ctx.reserve({ x: x - 80, y: y - 80, w: 160, h: 160 });
        break;
      }
    }
  }
}

function spawnOk(ctx: GenCtx, x: number, y: number, apart: number, fromExtract: number): boolean {
  const k = ctx.terrain.kindAt(x, y);
  if (k === TERRAIN.WATER || k === TERRAIN.SHALLOW || k === TERRAIN.BRIDGE) return false;
  if (ctx.zones.some((z) => inRect(grow(z.rect, 300), x, y))) return false;
  if (!ctx.free({ x: x - 64, y: y - 64, w: 128, h: 128 }, 24)) return false;
  if (ctx.spawns.some((s) => dist2(s.x, s.y, x, y) < apart * apart)) return false;
  if (ctx.extracts.some((e) => dist2(e.x, e.y, x, y) < fromExtract * fromExtract)) return false;
  return true;
}

// ───────────────────────── containers and loot inside buildings

const ROOM_KINDS: Record<BuildingArch, ReadonlyArray<readonly [ContainerKind, number]>> = {
  houseS: [["fridge", 3], ["crate", 3], ["toolbox", 1]],
  houseM: [["fridge", 2], ["toolbox", 2], ["crate", 2], ["pc", 1]],
  barn: [["crate", 3], ["toolbox", 2]],
  shed: [["toolbox", 3], ["crate", 2]],
  warehouse: [["crate", 4], ["toolbox", 2], ["pc", 1], ["weapon_box", 1]],
  office: [["pc", 4], ["safe", 1], ["crate", 1]],
  shop: [["fridge", 2], ["crate", 2], ["med_case", 1]],
  barracks: [["med_case", 2], ["weapon_box", 2], ["crate", 1]],
  bunker: [["safe", 2], ["weapon_box", 3], ["med_case", 1]],
  clinic: [["med_case", 4], ["pc", 1], ["crate", 1]],
  garage: [["toolbox", 4], ["crate", 2]],
  diner: [["fridge", 3], ["crate", 2]],
};

/** Containers per room [min, max] by archetype (memo §4.6 table). */
const PER_ROOM: Record<BuildingArch, readonly [number, number]> = {
  houseS: [1, 2], houseM: [1, 2], barn: [1, 3], shed: [1, 2], warehouse: [3, 5],
  office: [1, 2], shop: [1, 2], barracks: [1, 3], bunker: [2, 3],
  clinic: [1, 2], garage: [1, 2], diner: [1, 2],
};

/** Better POIs get better boxes on top of the archetype table. */
const TIER_BONUS: ReadonlyArray<ReadonlyArray<readonly [ContainerKind, number]>> = [
  [], [], [["med_case", 0.5]], [["weapon_box", 1.5], ["safe", 0.6], ["med_case", 0.8]], [["weapon_box", 3], ["safe", 1], ["med_case", 1.2]],
];

function zoneTier(ctx: GenCtx, b: Building): LootTier {
  if (b.zone === "") return 1; // hunter cabins
  return ctx.zone(b.zone).tier;
}

/**
 * Containers hug a room wall (40 px in), away from doors (a box in a doorway is a griefing
 * chokepoint) and shelves; loose loot goes on the room floor. Validation later drops anything a
 * player cannot reach within interact range.
 */
export function placeBuildingSpots(ctx: GenCtx): void {
  const rng = ctx.rng("room-spots");
  ctx.buildings.forEach((b, bi) => {
    const tier = zoneTier(ctx, b);
    const kinds = [...ROOM_KINDS[b.arch], ...TIER_BONUS[tier]!];
    const furniture = ctx.furniture[bi]!;
    const zone = b.zone === "" ? null : b.zone;
    for (const room of b.rooms) {
      const placed: Array<[number, number]> = [];
      const [lo, hi] = PER_ROOM[b.arch];
      const small = room.w < 200 || room.h < 200;
      const n = small ? Math.min(1, hi) : ri(rng, lo, hi);
      for (let c = 0; c < n; c++) {
        const p = wallSpot(rng, room, b.doors, furniture, placed);
        if (!p) break;
        placed.push(p);
        ctx.container(p[0], p[1], pickW(rng, kinds), tier, zone);
      }
      const nl = b.arch === "warehouse" ? ri(rng, 2, 4) : ri(rng, small ? 0 : 1, 2);
      for (let l = 0; l < nl; l++) {
        const p = floorSpot(rng, room, b.doors, furniture, placed);
        if (!p) break;
        placed.push(p);
        ctx.loot(p[0], p[1], tier);
      }
    }
  });
}

function clearOf(x: number, y: number, rects: readonly Rect[], m: number): boolean {
  return !rects.some((r) => x > r.x - m && x < r.x + r.w + m && y > r.y - m && y < r.y + r.h + m);
}

function wallSpot(rng: Rng, room: Rect, doors: readonly Rect[], furniture: readonly Rect[], placed: ReadonlyArray<[number, number]>): [number, number] | null {
  const IN = 40;
  // 20 tries (12 before map v2): furnished rooms leave fewer free stretches of wall.
  for (let attempt = 0; attempt < 20; attempt++) {
    const side = ri(rng, 0, 3);
    const horiz = side === 0 || side === 2;
    const span = horiz ? room.w : room.h;
    if (span < 2 * IN + 8) continue;
    const along = (horiz ? room.x : room.y) + IN + Math.floor(rng() * (span - 2 * IN));
    const x = horiz ? along : side === 1 ? room.x + room.w - IN : room.x + IN;
    const y = horiz ? (side === 0 ? room.y + IN : room.y + room.h - IN) : along;
    if (!clearOf(x, y, doors, 88) || !clearOf(x, y, furniture, 56)) continue;
    if (placed.some(([px, py]) => dist2(px, py, x, y) < 112 * 112)) continue;
    return [x, y];
  }
  return null;
}

function floorSpot(rng: Rng, room: Rect, doors: readonly Rect[], furniture: readonly Rect[], placed: ReadonlyArray<[number, number]>): [number, number] | null {
  const IN = 56;
  if (room.w < 2 * IN + 8 || room.h < 2 * IN + 8) return null;
  for (let attempt = 0; attempt < 10; attempt++) {
    const x = room.x + IN + Math.floor(rng() * (room.w - 2 * IN));
    const y = room.y + IN + Math.floor(rng() * (room.h - 2 * IN));
    if (!clearOf(x, y, doors, 64) || !clearOf(x, y, furniture, 48)) continue;
    if (placed.some(([px, py]) => dist2(px, py, x, y) < 80 * 80)) continue;
    return [x, y];
  }
  return null;
}

// ───────────────────────── wilderness

/**
 * Wilderness spots per 24-block map area (the layout the economy was tuned on); placeWildSpots
 * scales them with the map area so tier-0 density per km² stays the same on bigger maps.
 */
export const WILD = { STASHES: 80, LOOSE: 320, STASH_APART: 650 } as const;
/** The area WILD counts are given for: 24 blocks of 1024 px squared. */
const WILD_BASE_AREA = (24 * 1024) * (24 * 1024);

/** Ground stashes (tier 0) in the forest and steppe, and loose loot spots across the map. */
export function placeWildSpots(ctx: GenCtx): void {
  const rng = ctx.rng("wild-spots");
  const scale = (ctx.width * ctx.height) / WILD_BASE_AREA;
  const wantStashes = Math.round(WILD.STASHES * scale), wantLoose = Math.round(WILD.LOOSE * scale);
  const m = 600;
  const area: Rect = { x: m, y: m, w: ctx.width - 2 * m, h: ctx.height - 2 * m };
  const zoneHit = (x: number, y: number, pad: number) => ctx.zones.some((z) => inRect(grow(z.rect, pad), x, y));
  let stashes = 0;
  for (let t = 0; t < 8000 && stashes < wantStashes; t++) {
    const x = Math.round(area.x + rng() * area.w), y = Math.round(area.y + rng() * area.h);
    const k = ctx.terrain.kindAt(x, y);
    if (k !== TERRAIN.FOREST && !(k === TERRAIN.GRASS && chance(rng, 0.45))) continue;
    if (ctx.terrain.roadAt(x, y) !== ROAD_MASK.NONE || zoneHit(x, y, 200)) continue;
    const r = { x: x - 28, y: y - 28, w: 56, h: 56 };
    if (!ctx.free(r, 32)) continue;
    if (ctx.containers.some((c) => c.zone === null && dist2(c.x, c.y, x, y) < WILD.STASH_APART * WILD.STASH_APART)) continue;
    ctx.container(x, y, chance(rng, 0.6) ? "stash" : "crate", 0, null);
    ctx.reserve(r);
    stashes++;
  }
  // Tier-0 loose loot is capped at the v6 density (a bigger map has a bigger wilderness share, and
  // every extra wild spot would be loot the economy never planned for).
  const capWild = Math.round(V6_TIER_SPOTS.loot[0]! * scale);
  let loose = 0, wild = 0;
  for (let t = 0; t < 11000 && loose < wantLoose; t++) {
    const x = Math.round(area.x + rng() * area.w), y = Math.round(area.y + rng() * area.h);
    const k = ctx.terrain.kindAt(x, y);
    if (k === TERRAIN.WATER || (ctx.terrain.byteAt(x, y) & 0x80) !== 0) continue;
    if (!ctx.blocks.free({ x: x - 24, y: y - 24, w: 48, h: 48 }, 16)) continue;
    const z = ctx.zones.find((zz) => inRect(zz.rect, x, y));
    if (!z && wild >= capWild) continue;
    ctx.loot(x, y, z ? (Math.max(1, z.tier - 1) as LootTier) : 0);
    if (!z) wild++;
    loose++;
  }
}

/**
 * Static containers and loose loot spots per tier on the 24-block layout (MAP_GEN_VERSION 3, the
 * economy's tuning point: §22 balance, loot economy v4). balanceTiers keeps a bigger map at the
 * same density per km² (± a few %), so per-entry loot does not shift with the map size.
 */
export const V6_TIER_SPOTS = {
  containers: [80, 48, 159, 52, 41],
  loot: [178, 156, 139, 43, 31],
  /**
   * Safes per tier. A T3/T4 safe is worth ≈ 900 CR of junk (5× a pc, 10× a weapon box), so the
   * safe count alone moves a tier's value by ± 7 % per safe: balanceTiers sets it exactly.
   */
  safes: [0, 0, 0, 4, 4],
} as const;

/** balanceTiers tops a tier up when it is below this share of its target… */
export const TIER_FLOOR = 0.98;
/** …and drops the newest loose loot spots of a tier above this share (containers are never dropped). */
export const LOOT_CEIL = 1.05;

/** Office-like rooms where a safe belongs (a converted container must stand indoors in one). */
const SAFE_ARCHS: ReadonlySet<BuildingArch> = new Set<BuildingArch>(["office", "bunker", "barracks", "clinic", "warehouse"]);

/**
 * Exactly `want` safes in `tier`: extra safes (newest first) become pcs; missing ones are made from
 * pcs / crates / toolboxes standing in office-like buildings of that tier, spread round-robin over
 * the tier's zones (deterministic: candidates in container order, the zone order of MapData).
 */
function balanceSafes(ctx: GenCtx, rng: Rng, tier: LootTier, want: number): void {
  const safes = ctx.containers.filter((c) => c.tier === tier && c.kind === "safe");
  for (let i = safes.length - 1; i >= want; i--) safes[i]!.kind = "pc";
  let need = want - Math.min(want, safes.length);
  if (need <= 0) return;
  const indoorSafe = (c: ContainerSpot) =>
    ctx.buildings.some((b) => SAFE_ARCHS.has(b.arch) && b.zone === c.zone && inRect(b.floor, c.x, c.y));
  const byZone = ctx.zones
    .filter((z) => z.tier === tier)
    .map((z) => shuffle(rng, ctx.containers.filter((c) => c.zone === z.id && (c.kind === "pc" || c.kind === "crate" || c.kind === "toolbox") && indoorSafe(c))));
  for (let round = 0; need > 0 && byZone.some((l) => l.length > 0); round++) {
    for (const list of byZone) {
      if (need <= 0) break;
      const c = list.shift();
      if (!c) continue;
      c.kind = "safe";
      need--;
    }
  }
}

/**
 * Per-tier top-up (after the POI layouts, room spots and wild spots): a tier 1–4 below
 * TIER_FLOOR × its target (V6_TIER_SPOTS × map area / 24-block area) gets extra outdoor containers
 * round-robin over its zones, and extra floor loot in its buildings' rooms; a tier whose loose loot
 * is above LOOT_CEIL × its target loses its newest spots (the loose ones of placeWildSpots, which
 * come after the room spots). Containers are never removed: layouts are tuned to land at or a little
 * under the target, and generate.test.ts bounds every tier to ± 10 % per km².
 */
export function balanceTiers(ctx: GenCtx): void {
  const rng = ctx.rng("tier-balance");
  const scale = (ctx.width * ctx.height) / WILD_BASE_AREA;
  for (let tier = 1 as LootTier; tier <= 4; tier = (tier + 1) as LootTier) {
    const zones = ctx.zones.filter((z) => z.tier === tier);
    if (zones.length === 0) continue;
    const wantC = Math.round(V6_TIER_SPOTS.containers[tier]! * scale * TIER_FLOOR);
    // A boss zone takes its top-ups inside the boss's guard radius (POOL.GUARDED_RADIUS_PX = 1600):
    // pool uniques then stay about as boss-guarded per km² as on the 24-block layout.
    const areaOf = (z: Zone): Rect => {
      const inner = grow(z.rect, -160);
      const b = ctx.bosses.find((q) => q.zone === z.id);
      if (!b) return inner;
      const g: Rect = { x: b.x - 1100, y: b.y - 1100, w: 2200, h: 2200 };
      const x0 = Math.max(inner.x, g.x), y0 = Math.max(inner.y, g.y);
      const x1 = Math.min(inner.x + inner.w, g.x + g.w), y1 = Math.min(inner.y + inner.h, g.y + g.h);
      return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : inner;
    };
    const order = [...zones.filter((z) => z.boss), ...zones.filter((z) => !z.boss)];
    for (let round = 0; round < 12; round++) {
      let have = ctx.containers.filter((c) => c.tier === tier).length;
      if (have >= wantC) break;
      for (const z of order) {
        if (have >= wantC) break;
        const before = ctx.containers.length;
        outdoorContainers(ctx, rng, areaOf(z), 1, tier, z.id);
        have += ctx.containers.length - before;
      }
    }
    const wantL = Math.round(V6_TIER_SPOTS.loot[tier]! * scale * TIER_FLOOR);
    const capL = Math.round(V6_TIER_SPOTS.loot[tier]! * scale * LOOT_CEIL);
    let over = ctx.lootSpots.filter((l) => l.tier === tier).length - capL;
    for (let i = ctx.lootSpots.length - 1; i >= 0 && over > 0; i--) {
      if (ctx.lootSpots[i]!.tier !== tier) continue;
      ctx.lootSpots.splice(i, 1);
      over--;
    }
    const rooms: Array<{ room: Rect; bi: number }> = [];
    ctx.buildings.forEach((b, bi) => {
      if (b.zone !== "" && ctx.zone(b.zone).tier === tier) for (const room of b.rooms) rooms.push({ room, bi });
    });
    // Rounded up: the rest of a tier lands a little under its target (top-ups stop at TIER_FLOOR).
    balanceSafes(ctx, rng, tier, Math.ceil(V6_TIER_SPOTS.safes[tier]! * scale));
    if (rooms.length === 0) continue;
    let haveL = ctx.lootSpots.filter((l) => l.tier === tier).length;
    for (let t = 0; t < rooms.length * 3 && haveL < wantL; t++) {
      const { room, bi } = rooms[(t * 7) % rooms.length]!;
      const b = ctx.buildings[bi]!;
      const taken: Array<[number, number]> = [];
      for (const c of ctx.containers) if (inRect(room, c.x, c.y)) taken.push([c.x, c.y]);
      for (const l of ctx.lootSpots) if (inRect(room, l.x, l.y)) taken.push([l.x, l.y]);
      const p = floorSpot(rng, room, b.doors, ctx.furniture[bi]!, taken);
      if (!p) continue;
      ctx.loot(p[0], p[1], tier);
      haveL++;
    }
  }
}

// ───────────────────────── bosses (cut 3 may drop them; the server then ignores the array)

export function placeBosses(ctx: GenCtx): void {
  for (const z of ctx.zones) {
    if (!z.boss) continue;
    const kind: BossKind = z.boss;
    const pref: readonly BuildingArch[] = BOSS_BUILDING_PREFS[kind];
    const nGuards = BOSS_GUARD_COUNT[kind];
    let b: Building | undefined;
    for (const arch of pref) {
      b = ctx.buildings.find((q) => q.zone === z.id && q.arch === arch);
      if (b) break;
    }
    if (!b) continue;
    const rooms = b.rooms.slice().sort((p, q) => q.w * q.h - p.w * p.h);
    const main = rooms[0]!;
    const guards: Array<{ x: number; y: number }> = [];
    for (const r of rooms.slice(1)) {
      if (guards.length >= nGuards) break;
      guards.push({ x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) });
    }
    // Not enough rooms: post the rest outside the exterior doors.
    for (const d of b.doors) {
      if (guards.length >= nGuards) break;
      const onEdge = d.x === b.floor.x || d.y === b.floor.y || d.x + d.w === b.floor.x + b.floor.w || d.y + d.h === b.floor.y + b.floor.h;
      if (!onEdge) continue;
      const cx = d.x + d.w / 2, cy = d.y + d.h / 2;
      const ox = d.x === b.floor.x ? -120 : d.x + d.w === b.floor.x + b.floor.w ? 120 : 0;
      const oy = d.y === b.floor.y ? -120 : d.y + d.h === b.floor.y + b.floor.h ? 120 : 0;
      guards.push({ x: Math.round(cx + ox), y: Math.round(cy + oy) });
    }
    ctx.bosses.push({
      kind, zone: z.id, x: Math.round(main.x + main.w / 2), y: Math.round(main.y + main.h / 2), guards, chance: BOSS_CHANCE[kind],
    });
  }
}

// ───────────────────────── marauder posts (NPC MODEL v5)

/** Wild stretches road camps sit on (highway W/E of the zones, N–S road, ford trail, radar spur, rail). */
const ROAD_CAMP_ROADS = ["highway", "ns", "ford", "radar", "rail"] as const;
/** Road camps keep this far from the wild hunter cabins (the rat's reward stays unguarded). */
const CABIN_CLEAR_PX = 800;

/**
 * Marauder squads of a zone: NPC_CAMPS (npc.ts) for the ten places it lists, the map v2 places'
 * ZONE_CAMPS row, else CAMP_BY_TIER (steppe.ts).
 */
export function zoneCamp(z: Pick<Zone, "id" | "tier">): { squads: number; size: readonly [number, number]; chance: number } {
  return NPC_CAMPS[z.id] ?? ZONE_CAMPS[z.id] ?? CAMP_BY_TIER[z.tier];
}

/** Squared distance from a point to a rect (0 inside). */
function rectDist2(r: Rect, x: number, y: number): number {
  const dx = x < r.x ? r.x - x : x > r.x + r.w ? x - (r.x + r.w) : 0;
  const dy = y < r.y ? r.y - y : y > r.y + r.h ? y - (r.y + r.h) : 0;
  return dx * dx + dy * dy;
}

/** Points every `step` px along a flat polyline, with the unit direction of their segment. */
function polySamples(pts: readonly number[], step: number): Array<{ x: number; y: number; nx: number; ny: number }> {
  const out: Array<{ x: number; y: number; nx: number; ny: number }> = [];
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const x0 = pts[i]!, y0 = pts[i + 1]!, dx = pts[i + 2]! - x0, dy = pts[i + 3]! - y0;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) continue;
    const n = Math.max(1, Math.ceil(len / step));
    for (let s = 0; s < n; s++) out.push({ x: Math.round(x0 + (dx * s) / n), y: Math.round(y0 + (dy * s) / n), nx: dx / len, ny: dy / len });
  }
  return out;
}

/** NPC post clearances at map scale `k` (block / 1024): spawns, extracts, boss spots. */
function npcClearances(k: number) {
  const sc = (v: number) => Math.round(v * k);
  return {
    spawn: sc(NPC.SPAWN_CLEAR_PX), extract: sc(NPC.EXTRACT_CLEAR_PX), boss: sc(NPC.BOSS_CLEAR_PX),
    sep: sc(NPC.POST_MIN_SEP_PX), campSep: sc(NPC.ROAD_CAMP_SEP_PX), zone: sc(NPC.ROAD_CAMP_ZONE_CLEAR_PX), cabin: sc(CABIN_CLEAR_PX),
  };
}

/** Nobody spawns or extracts into a camp, and marauders hold the approaches, not the boss room. */
function npcPostClear(
  map: Pick<MapData, "spawns" | "extracts" | "bosses">, c: ReturnType<typeof npcClearances>, x: number, y: number, boss = true,
): boolean {
  if (map.spawns.some((s) => dist2(s.x, s.y, x, y) < c.spawn * c.spawn)) return false;
  if (map.extracts.some((e) => dist2(e.x, e.y, x, y) < c.extract * c.extract)) return false;
  if (boss && map.bosses.some((b) => dist2(b.x, b.y, x, y) < c.boss * c.boss)) return false;
  return true;
}

/**
 * Building posts (POI garrison, npc.ts POI_GARRISON): one "bld" post per building of every POI zone,
 * placed after every other post from its own "npc-bld" rng stream, so the older posts keep their
 * ids and spots. The post stands in the yard of an exterior door (BLD_DOOR_OFFSETS px out, outdoors,
 * free ground, not forest / water, ≥ POI_GARRISON.POST_SEP_PX from every post); a building with no
 * such yard gets an indoor post on a free spot of one of its rooms (clear of furniture and containers,
 * ≥ POST_SEP_PX / 2 from every post). Clearances: ≥ POI_GARRISON.SPAWN_CLEAR_PX from spawns (beyond
 * the T4 chase radius, 900 + 300 px; the 30 s peace window covers the rest) and EXTRACT_CLEAR_PX
 * from extracts; the boss clearance does not apply (on a non-event map the boss building is held by
 * marauders; on the event map they hold its doors, the guards the room). Size =
 * POI_GARRISON.BUILDING_GROUP[tier], chance 0 (rollNpcSpawns spawns them as the garrison), no patrol.
 */
const BLD_DOOR_OFFSETS = [160, 224, 288] as const;

export function placeBuildingPosts(ctx: GenCtx): void {
  const rng = ctx.rng("npc-bld");
  const k = ctx.block / 1024;
  const posts = ctx.npcPosts;
  const sep = Math.round(POI_GARRISON.POST_SEP_PX * k);
  const spawnClear = Math.round(POI_GARRISON.SPAWN_CLEAR_PX * k), extractClear = Math.round(NPC.EXTRACT_CLEAR_PX * k);
  const clear = (x: number, y: number) =>
    !ctx.spawns.some((s) => dist2(s.x, s.y, x, y) < spawnClear * spawnClear) &&
    !ctx.extracts.some((e) => dist2(e.x, e.y, x, y) < extractClear * extractClear);
  const apart = (x: number, y: number, d: number) => posts.every((p) => dist2(p.x, p.y, x, y) >= d * d);
  const terrainOk = (x: number, y: number, indoor: boolean): boolean => {
    const byte = ctx.terrain.byteAt(x, y);
    if (((byte & TERRAIN_INDOOR) !== 0) !== indoor) return false;
    const kind = byte & TERRAIN_KIND_MASK;
    return kind !== TERRAIN.WATER && kind !== TERRAIN.SHALLOW && kind !== TERRAIN.BRIDGE && kind !== TERRAIN.FOREST;
  };
  const yardOk = (x: number, y: number): boolean => {
    const r: Rect = { x: x - 40, y: y - 40, w: 80, h: 80 };
    if (!ctx.inBounds(r, 200) || !terrainOk(x, y, false) || !ctx.blocks.free(r, 8)) return false;
    return !ctx.buildings.some((b) => inRect(grow(b.floor, 64), x, y));
  };
  ctx.buildings.forEach((b, bi) => {
    if (!b.zone) return;
    const z = ctx.zone(b.zone);
    const size = POI_GARRISON.BUILDING_GROUP[z.tier];
    if (size[1] <= 0) return;
    const add = (x: number, y: number) => {
      posts.push({ id: posts.length, zone: z.id, tier: z.tier, kind: "bld", x, y, patrol: [], size: [size[0], size[1]], chance: 0, building: bi });
    };
    const ok = (x: number, y: number) => inRect(z.rect, x, y) && clear(x, y) && apart(x, y, sep);
    for (const d of shuffle(rng, [...b.doors])) {
      const nx = d.x === b.floor.x ? -1 : d.x + d.w === b.floor.x + b.floor.w ? 1 : 0;
      const ny = d.y === b.floor.y ? -1 : d.y + d.h === b.floor.y + b.floor.h ? 1 : 0;
      if (nx === 0 && ny === 0) continue;
      for (const off of BLD_DOOR_OFFSETS) {
        const x = Math.round(d.x + d.w / 2 + nx * off * k), y = Math.round(d.y + d.h / 2 + ny * off * k);
        if (!yardOk(x, y) || !ok(x, y)) continue;
        add(x, y);
        return;
      }
    }
    // No free yard: hold the inside, a free 80 px square in one of its rooms (largest first).
    const furniture = ctx.furniture[bi] ?? [];
    const indoorOk = (room: Rect, x: number, y: number): boolean => {
      const r: Rect = { x: x - 40, y: y - 40, w: 80, h: 80 };
      if (!inRect(grow(room, -48), x, y) || !terrainOk(x, y, true)) return false;
      if (furniture.some((f) => overlaps(f, r, 16))) return false;
      if (ctx.containers.some((q) => dist2(q.x, q.y, x, y) < 96 * 96)) return false;
      return inRect(z.rect, x, y) && clear(x, y) && apart(x, y, sep / 2);
    };
    for (const room of [...b.rooms].sort((p, q) => q.w * q.h - p.w * p.h)) {
      for (let t = 0; t < 24; t++) {
        const fx = t === 0 ? 0.5 : 0.2 + rng() * 0.6, fy = t === 0 ? 0.5 : 0.2 + rng() * 0.6;
        const x = Math.round(room.x + room.w * fx), y = Math.round(room.y + room.h * fy);
        if (!indoorOk(room, x, y)) continue;
        add(x, y);
        return;
      }
    }
  });
}

/**
 * Marauder posts (NPC MODEL v5 §2.2), placed last from the "npc-posts" rng stream. Adds no solids
 * and reserves nothing, so the layout and mapHash are unchanged.
 * - POI posts (zoneCamp(zone).squads: NPC_CAMPS, else the map v2 ZONE_CAMPS / CAMP_BY_TIER): up to half on zone gates (a road entering
 *   the zone, 256 px inside, beside the road), the rest in yards 192 px in front of exterior doors,
 *   then random outdoor points in the zone. ≥ POST_MIN_SEP_PX apart, ≥ BOSS_CLEAR_PX from any boss
 *   spot (guards hold the boss building, marauders the approaches), never indoors.
 * - Road camps (NPC_CAMPS.road.squads): beside the wild stretches of ROAD_CAMP_ROADS, ≥
 *   ROAD_CAMP_ZONE_CLEAR_PX from any zone, ≥ ROAD_CAMP_SEP_PX apart, never on forest / water / a bridge
 *   or the ford, ≥ 800 px from hunter cabins; candidates are taken round-robin over the stretches.
 * - Every post: ≥ SPAWN_CLEAR_PX from spawns, ≥ EXTRACT_CLEAR_PX from extracts (scaled with the block).
 * - Every other POI post patrols 2–3 points within leash/2; road camps hold.
 */
export function placeNpcPosts(ctx: GenCtx): void {
  const rng = ctx.rng("npc-posts");
  const k = ctx.block / 1024;
  const c = npcClearances(k);
  const posts = ctx.npcPosts;

  const groundOk = (x: number, y: number): boolean => {
    const r: Rect = { x: x - 40, y: y - 40, w: 80, h: 80 };
    if (!ctx.inBounds(r, 200)) return false;
    const byte = ctx.terrain.byteAt(x, y);
    if ((byte & TERRAIN_INDOOR) !== 0) return false;
    const kind = byte & TERRAIN_KIND_MASK;
    if (kind === TERRAIN.WATER || kind === TERRAIN.SHALLOW || kind === TERRAIN.BRIDGE || kind === TERRAIN.FOREST) return false;
    if (!ctx.blocks.free(r, 8)) return false;
    return !ctx.buildings.some((b) => inRect(grow(b.floor, 64), x, y));
  };
  const apart = (x: number, y: number, list: readonly NpcPost[], d: number) => list.every((p) => dist2(p.x, p.y, x, y) >= d * d);
  const ok = (x: number, y: number) => groundOk(x, y) && npcPostClear(ctx, c, x, y) && apart(x, y, posts, c.sep);

  const post = (zone: Zone | null, kind: NpcPost["kind"], x: number, y: number, camp: { size: readonly [number, number]; chance: number }): NpcPost => {
    const p: NpcPost = {
      id: posts.length, zone: zone ? zone.id : null, tier: zone ? zone.tier : 0, kind, x, y, patrol: [],
      size: [camp.size[0], camp.size[1]], chance: camp.chance,
    };
    posts.push(p);
    return p;
  };

  let poiIdx = 0;
  for (const z of ctx.zones) {
    const camp = zoneCamp(z);
    if (camp.squads <= 0) continue;
    const inZone = (x: number, y: number) => inRect(grow(z.rect, -96), x, y);
    // Gates: where a road crosses the zone border, 256 px inside, beside the road (or on it).
    const gates: Array<[number, number]> = [];
    for (const road of ctx.roads) {
      const sm = polySamples(road.pts, 64);
      const off = Math.round(road.width / 2 + 96);
      for (let i = 1; i < sm.length; i++) {
        const a = inRect(z.rect, sm[i - 1]!.x, sm[i - 1]!.y), b = inRect(z.rect, sm[i]!.x, sm[i]!.y);
        if (a === b) continue;
        const q = sm[b ? Math.min(sm.length - 1, i + 4) : Math.max(0, i - 5)]!;
        if (!inZone(q.x, q.y)) continue;
        for (const o of [off, -off, 0]) gates.push([Math.round(q.x - q.ny * o), Math.round(q.y + q.nx * o)]);
      }
    }
    // Yards in front of exterior doors.
    const yards: Array<[number, number]> = [];
    for (const b of ctx.buildings) {
      if (b.zone !== z.id) continue;
      for (const d of b.doors) {
        const ox = d.x === b.floor.x ? -192 : d.x + d.w === b.floor.x + b.floor.w ? 192 : 0;
        const oy = d.y === b.floor.y ? -192 : d.y + d.h === b.floor.y + b.floor.h ? 192 : 0;
        if (ox === 0 && oy === 0) continue;
        yards.push([Math.round(d.x + d.w / 2 + ox), Math.round(d.y + d.h / 2 + oy)]);
      }
    }
    const want = camp.squads;
    const maxGates = Math.ceil(want / 2);
    let n = 0, nGates = 0;
    // Gate triples stay together (beside / other side / on the road) so one gate yields one post.
    const gateIdx = shuffle(rng, Array.from({ length: gates.length / 3 }, (_, i) => i));
    for (const gi of gateIdx) {
      if (n >= want || nGates >= maxGates) break;
      for (let j = 0; j < 3; j++) {
        const [x, y] = gates[gi * 3 + j]!;
        if (!inZone(x, y) || !ok(x, y)) continue;
        post(z, "gate", x, y, camp);
        n++;
        nGates++;
        break;
      }
    }
    for (const [x, y] of shuffle(rng, yards)) {
      if (n >= want) break;
      if (!inZone(x, y) || !ok(x, y)) continue;
      post(z, "poi", x, y, camp);
      n++;
    }
    for (let t = 0; t < 600 && n < want; t++) {
      const x = Math.round(z.rect.x + 96 + rng() * (z.rect.w - 192));
      const y = Math.round(z.rect.y + 96 + rng() * (z.rect.h - 192));
      if (!ok(x, y)) continue;
      post(z, "poi", x, y, camp);
      n++;
    }
  }

  // Patrols: every other POI post walks 2–3 points within leash/2 of its anchor.
  for (const p of posts) {
    if (poiIdx++ % 2 === 0) continue;
    const z = ctx.zone(p.zone!);
    const L = Math.round((MARAUDER[npcClassOfTier(p.tier)].leashPx / 2) * k);
    const want = ri(rng, 2, 3);
    for (let t = 0; t < 40 && p.patrol.length < want; t++) {
      const dx = ri(rng, -L, L), dy = ri(rng, -L, L);
      const d2 = dx * dx + dy * dy;
      if (d2 > L * L || d2 * 9 < L * L) continue;
      const x = p.x + dx, y = p.y + dy;
      if (!inRect(z.rect, x, y) || !groundOk(x, y) || !npcPostClear(ctx, c, x, y)) continue;
      if (p.patrol.some((q) => dist2(q.x, q.y, x, y) < (L / 2) * (L / 2))) continue;
      p.patrol.push({ x, y });
    }
  }

  // Road camps on the wild stretches.
  const road = NPC_CAMPS.road;
  if (!road || road.squads <= 0) return;
  // Candidates per stretch (shuffled within it), taken round-robin over the stretches so camps
  // spread over different roads instead of clustering on the longest one.
  const perRoad: Array<Array<[number, number]>> = [];
  for (const id of ROAD_CAMP_ROADS) {
    const ri0 = ctx.roadIds.indexOf(id);
    if (ri0 < 0) continue;
    const rd = ctx.roads[ri0]!;
    const off = Math.round(rd.width / 2 + 160);
    const list: Array<[number, number]> = [];
    for (const q of polySamples(rd.pts, 256)) {
      for (const o of [off, -off]) list.push([Math.round(q.x - q.ny * o), Math.round(q.y + q.nx * o)]);
    }
    perRoad.push(shuffle(rng, list));
  }
  const cabins = ctx.buildings.filter((b) => b.zone === "");
  const campOk = (x: number, y: number, camps: readonly NpcPost[]): boolean => {
    if (ctx.zones.some((z) => rectDist2(z.rect, x, y) < c.zone * c.zone)) return false;
    if (cabins.some((b) => rectDist2(b.floor, x, y) < c.cabin * c.cabin)) return false;
    return apart(x, y, camps, c.campSep) && ok(x, y);
  };
  const camps: NpcPost[] = [];
  const cursor = perRoad.map(() => 0);
  for (let progress = true; progress && camps.length < road.squads; ) {
    progress = false;
    for (let r = 0; r < perRoad.length && camps.length < road.squads; r++) {
      const list = perRoad[r]!;
      while (cursor[r]! < list.length) {
        const [x, y] = list[cursor[r]!++]!;
        if (!campOk(x, y, camps)) continue;
        camps.push(post(null, "road", x, y, road));
        progress = true;
        break;
      }
    }
  }
}

// ───────────────────────── ambient emitters (audio reads positions instead of hardcoding them)

export function placeAmbient(ctx: GenCtx): void {
  // River: every ~2 km along the centre line.
  const p = ctx.river;
  let carry = 0;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const x0 = p[i]!, y0 = p[i + 1]!, dx = p[i + 2]! - x0, dy = p[i + 3]! - y0;
    const len = Math.sqrt(dx * dx + dy * dy);
    let s = carry;
    for (; s < len; s += 2048) ctx.ambient.push({ x: Math.round(x0 + (dx * s) / len), y: Math.round(y0 + (dy * s) / len), r: 900, k: "river" });
    carry = s - len;
  }
  // Forest beds and open-steppe wind on a 4096 px grid.
  const S = 4096;
  let wind = 0;
  for (let gy = 0; gy + S <= ctx.height; gy += S) {
    for (let gx = 0; gx + S <= ctx.width; gx += S) {
      const cell: Rect = { x: gx, y: gy, w: S, h: S };
      const forest = ctx.terrain.fraction(cell, TERRAIN.FOREST);
      const cx = gx + S / 2, cy = gy + S / 2;
      if (forest > 0.4) ctx.ambient.push({ x: cx, y: cy, r: 2200, k: "forest" });
      else if (forest < 0.12 && wind < 8 && !ctx.zones.some((z) => inRect(z.rect, cx, cy))) {
        ctx.ambient.push({ x: cx, y: cy, r: 2200, k: "wind" });
        wind++;
      }
    }
  }
}

// ───────────────────────── validation (memo §4.9)

export interface ValidationReport {
  /** Template-level failures (unreachable extract, too few spawns on a side, boss off the map). */
  errors: string[];
  droppedContainers: number;
  droppedLoot: number;
  nudgedLoot: number;
  droppedSpawns: number;
  /** Marauder posts dropped (unreachable, or a nudge broke a clearance). */
  droppedNpcPosts: number;
}

/** Interact range used for "reachable": a reached cell centre within this of the spot. */
export const REACH_PX = 80;

/**
 * Flood-fill the 32 px walk grid from the first extract. Every extract must be reached (a template
 * bug otherwise — reported in `errors`, which generateMap turns into a throw). Spawns off the main component are dropped; containers need a reached
 * cell within interact range or are dropped; loose loot is nudged onto the nearest reached cell
 * (≤ 96 px) or dropped; boss and guard posts are nudged. Mutates `map` in place.
 */
export function validateMap(map: MapData): ValidationReport {
  const g = getWalkGrid(map);
  void getCollisionIndex(map); // warmed by getWalkGrid; explicit for readers
  const e0 = map.extracts[0]!;
  const reached = floodWalk(g, e0.x, e0.y);
  const report: ValidationReport = { errors: [], droppedContainers: 0, droppedLoot: 0, nudgedLoot: 0, droppedSpawns: 0, droppedNpcPosts: 0 };
  for (const e of map.extracts) {
    if (!reachedNear(g, reached, e.x, e.y, 48)) report.errors.push(`extract ${e.id} unreachable`);
  }

  const onReached = (x: number, y: number) => reached[walkCellOf(g, x, y)] === 1;
  const spawns = map.spawns.filter((s) => onReached(s.x, s.y));
  report.droppedSpawns = map.spawns.length - spawns.length;
  map.spawns.splice(0, map.spawns.length, ...spawns);
  for (let side = 0; side < 4; side++) {
    const n = map.spawns.filter((s) => s.side === side).length;
    if (n < SPAWN.MIN_PER_SIDE) report.errors.push(`side ${side} has only ${n} spawns`);
  }

  const containers = map.containers.filter((c) => reachedNear(g, reached, c.x, c.y, REACH_PX));
  report.droppedContainers = map.containers.length - containers.length;
  map.containers.splice(0, map.containers.length, ...containers);

  const loot: MapData["lootSpots"] = [];
  for (const s of map.lootSpots) {
    if (onReached(s.x, s.y)) {
      loot.push(s);
      continue;
    }
    const near = nearestWalkCell(g, s.x, s.y, 96, reached);
    if (near < 0) {
      report.droppedLoot++;
      continue;
    }
    report.nudgedLoot++;
    loot.push({ x: (near % g.cols) * g.cell + g.cell / 2, y: Math.floor(near / g.cols) * g.cell + g.cell / 2, tier: s.tier });
  }
  map.lootSpots.splice(0, map.lootSpots.length, ...loot);

  const nudge = (p: { x: number; y: number }): boolean => {
    const i = nearestWalkCell(g, p.x, p.y, 192, reached);
    if (i < 0) return false;
    if (!onReached(p.x, p.y)) {
      p.x = (i % g.cols) * g.cell + g.cell / 2;
      p.y = Math.floor(i / g.cols) * g.cell + g.cell / 2;
    }
    return true;
  };
  for (const b of map.bosses) {
    if (!nudge(b)) report.errors.push(`boss ${b.kind} unreachable`);
    b.guards = b.guards.filter(nudge);
  }

  // Marauder posts: anchors and patrol points onto the reached component; a post that cannot be
  // reached, or that a nudge pushed into a clearance, is dropped; ids are renumbered (= index).
  if (map.npcPosts) {
    const c = npcClearances(map.width / WORLD.WIDTH);
    const fine = (p: { x: number; y: number }) => nudge(p) && npcPostClear(map, c, p.x, p.y);
    // Building posts: no boss clearance, POI_GARRISON.SPAWN_CLEAR_PX from spawns (placeBuildingPosts).
    const bc = { ...c, spawn: Math.round((POI_GARRISON.SPAWN_CLEAR_PX * map.width) / WORLD.WIDTH) };
    const posts = map.npcPosts.filter((p) => (p.kind === "bld" ? nudge(p) && npcPostClear(map, bc, p.x, p.y, false) : fine(p)));
    report.droppedNpcPosts = map.npcPosts.length - posts.length;
    posts.forEach((p, i) => {
      p.id = i;
      p.patrol = p.patrol.filter(fine);
    });
    map.npcPosts.splice(0, map.npcPosts.length, ...posts);
    const camps = posts.filter((p) => p.kind === "road").length;
    if (camps < NPC.ROAD_CAMPS_MIN) report.errors.push(`only ${camps} road camps (min ${NPC.ROAD_CAMPS_MIN})`);
    // POI garrison: a zone with a garrison but no post at all would stand unguarded.
    for (const z of map.zones) {
      if (POI_GARRISON.POI_MIN[z.tier][0] > 0 && !posts.some((p) => p.zone === z.id)) report.errors.push(`zone ${z.id} has no npc post (POI garrison)`);
    }
  }
  return report;
}
