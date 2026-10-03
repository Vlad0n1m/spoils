/**
 * Gameplay spots (map memo §4.8, §6, §7): extracts, side spawns, static containers (indexed —
 * the index is the container id everywhere), loose loot spots, boss spots, ambient emitters, and
 * the reachability validation that makes the generator's output trustworthy.
 */

import { WORLD } from "../constants.js";
import type { Rect } from "../geometry.js";
import { MARAUDER, NPC, NPC_CAMPS, npcClassOfTier } from "../npc.js";
import type { Rng } from "../rng.js";
import type { GenCtx } from "./context.js";
import { floodWalk, getCollisionIndex, getWalkGrid, nearestWalkCell, reachedNear, walkCellOf } from "./query.js";
import { BOSS_BUILDING_PREFS, BOSS_CHANCE, BOSS_GUARD_COUNT, EXTRACT_RADIUS, STEPPE_EXTRACTS } from "./steppe.js";
import { ROAD_MASK } from "./terrain.js";
import {
  TERRAIN,
  TERRAIN_INDOOR,
  TERRAIN_KIND_MASK,
  type BossKind,
  type Building,
  type BuildingArch,
  type ContainerKind,
  type LootTier,
  type MapData,
  type MapSide,
  type NpcPost,
  type Zone,
} from "./types.js";
import { chance, dist2, grow, inRect, pickW, ri, shuffle } from "./util.js";

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
 * 36–40 spawns in a band along the edges, ≥ 1400 px apart and ≥ 2000 px from any extract, never
 * inside a POI. Placed after POIs and before props so trees respect the reserved circle.
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
};

/** Containers per room [min, max] by archetype (memo §4.6 table). */
const PER_ROOM: Record<BuildingArch, readonly [number, number]> = {
  houseS: [1, 2], houseM: [1, 2], barn: [1, 3], shed: [1, 2], warehouse: [3, 5],
  office: [1, 2], shop: [1, 2], barracks: [1, 3], bunker: [2, 3],
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
  for (let attempt = 0; attempt < 12; attempt++) {
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

export const WILD = { STASHES: 80, LOOSE: 320, STASH_APART: 650 } as const;

/** Ground stashes (tier 0) in the forest and steppe, and loose loot spots across the map. */
export function placeWildSpots(ctx: GenCtx): void {
  const rng = ctx.rng("wild-spots");
  const m = 600;
  const area: Rect = { x: m, y: m, w: ctx.width - 2 * m, h: ctx.height - 2 * m };
  const zoneHit = (x: number, y: number, pad: number) => ctx.zones.some((z) => inRect(grow(z.rect, pad), x, y));
  let stashes = 0;
  for (let t = 0; t < 6000 && stashes < WILD.STASHES; t++) {
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
  let loose = 0;
  for (let t = 0; t < 8000 && loose < WILD.LOOSE; t++) {
    const x = Math.round(area.x + rng() * area.w), y = Math.round(area.y + rng() * area.h);
    const k = ctx.terrain.kindAt(x, y);
    if (k === TERRAIN.WATER || (ctx.terrain.byteAt(x, y) & 0x80) !== 0) continue;
    if (!ctx.blocks.free({ x: x - 24, y: y - 24, w: 48, h: 48 }, 16)) continue;
    const z = ctx.zones.find((zz) => inRect(zz.rect, x, y));
    ctx.loot(x, y, z ? (Math.max(1, z.tier - 1) as LootTier) : 0);
    loose++;
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
  map: Pick<MapData, "spawns" | "extracts" | "bosses">, c: ReturnType<typeof npcClearances>, x: number, y: number,
): boolean {
  if (map.spawns.some((s) => dist2(s.x, s.y, x, y) < c.spawn * c.spawn)) return false;
  if (map.extracts.some((e) => dist2(e.x, e.y, x, y) < c.extract * c.extract)) return false;
  if (map.bosses.some((b) => dist2(b.x, b.y, x, y) < c.boss * c.boss)) return false;
  return true;
}

/**
 * Marauder posts (NPC MODEL v5 §2.2), placed last from the "npc-posts" rng stream. Adds no solids
 * and reserves nothing, so the layout and mapHash are unchanged.
 * - POI posts (NPC_CAMPS[zone.id].squads per zone): up to half of them on zone gates (a road entering
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
    const camp = NPC_CAMPS[z.id];
    if (!camp || camp.squads <= 0) continue;
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
    const posts = map.npcPosts.filter(fine);
    report.droppedNpcPosts = map.npcPosts.length - posts.length;
    posts.forEach((p, i) => {
      p.id = i;
      p.patrol = p.patrol.filter(fine);
    });
    map.npcPosts.splice(0, map.npcPosts.length, ...posts);
    const camps = posts.filter((p) => p.kind === "road").length;
    if (camps < NPC.ROAD_CAMPS_MIN) report.errors.push(`only ${camps} road camps (min ${NPC.ROAD_CAMPS_MIN})`);
  }
  return report;
}
