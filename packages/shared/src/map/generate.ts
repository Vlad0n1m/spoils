/**
 * v2 map generator entry point (WP-M1). generateMap(id) is deterministic per (id, MAP_GEN_VERSION),
 * memoized per id, and never depends on the match seed: the match seed only drives loot, bosses
 * and weather (critique). Server and client both build the map locally; mapHash() catches drift.
 *
 * Pipeline (map memo §4):
 *   1. terrain: forest noise, zone grounds, river + banks, roads, the 3 crossings;
 *   2. water → MOVE-only row-run rects; roads/water reserved in the placement hash;
 *   3. extracts (fixed by the template), POI layouts (BSP buildings, props), hunter cabins;
 *   4. side spawns (before props so trees keep the circles clear);
 *   5. props: road car wrecks, forest/steppe scatter, bushes, decals;
 *   6. spots: room containers + loot, wilderness stashes + loot, bosses, ambient emitters, then
 *      marauder posts (NPC MODEL v5; own rng stream, no reservations, not part of mapHash);
 *   7. validation: flood-fill reachability drops/nudges unreachable spots (spots.ts).
 *
 * Determinism rules (types.ts header; determinism.test.ts greps these sources): mulberry32 only,
 * + - * / and Math.floor/ceil/round/min/max/abs/sqrt/imul; integer output coordinates.
 */

import { MAP_GEN_VERSION, WORLD } from "../constants.js";
import { SOLID } from "../geometry.js";
import { ALL, GenCtx } from "./context.js";
import { buildPois } from "./pois.js";
import { roadCars, wildProps } from "./props.js";
import {
  placeAmbient,
  placeBosses,
  placeBuildingSpots,
  placeExtracts,
  placeNpcPosts,
  placeSpawns,
  placeWildSpots,
  validateMap,
  type ValidationReport,
} from "./spots.js";
import { RIVER_BANK, RIVER_HALF_WIDTH, STEPPE_CROSSINGS, STEPPE_RIVER, STEPPE_ROADS, STEPPE_ZONES } from "./steppe.js";
import { ROAD_MASK } from "./terrain.js";
import { MAPS, TERRAIN, type MapData, type MapId, type ZoneKind } from "./types.js";
import { polyXAtY } from "./util.js";

/** Ground painted over a zone's rect (clears forest inside POIs). */
const ZONE_GROUND: Record<ZoneKind, number> = {
  village: TERRAIN.GRASS,
  farm: TERRAIN.DIRT,
  lumber: TERRAIN.DIRT,
  industrial: TERRAIN.CONCRETE,
  gas: TERRAIN.ASPHALT,
  rail: TERRAIN.DIRT,
  military: TERRAIN.CONCRETE,
  checkpoint: TERRAIN.CONCRETE,
  quarry: TERRAIN.GRAVEL,
};

/** Target forest share before zones/roads carve it (≈ 30–33% of the final map). */
const FOREST_FRAC = 0.47;

export interface GenReport {
  validation: ValidationReport;
  counts: Record<string, number>;
}

const cache = new Map<MapId, MapData>();

/** The map for `id`, built once per process (≈ 0.1–0.3 s) and shared by every room and the client. */
export function generateMap(id: MapId = "steppe"): MapData {
  let m = cache.get(id);
  if (!m) {
    m = generateMapWithReport(id).map;
    cache.set(id, m);
  }
  return m;
}

/**
 * Uncached build + stats (tests, tooling). Same output as generateMap. `strict: false` returns a
 * broken layout for inspection instead of throwing.
 */
export function generateMapWithReport(
  id: MapId = "steppe",
  opts: { strict?: boolean; block?: number } = {},
): { map: MapData; report: GenReport } {
  const seed = MAPS[id].layoutSeed;
  // `block` overrides WORLD.BLOCK (tests prove the 853 px / 20,480 px fallback of critique cut 8).
  const block = opts.block ?? WORLD.BLOCK;
  const size = WORLD.BLOCKS * block;
  const ctx = new GenCtx(seed, size, size, block, WORLD.BORDER, WORLD.TERRAIN_CELL);
  const W = ctx.width, H = ctx.height, Bd = ctx.border;

  // Border walls (ALL) — listed first so they are rects[0..3] like v1.
  ctx.rect(0, 0, W, Bd, ALL, "border", 0);
  ctx.rect(0, H - Bd, W, Bd, ALL, "border", 0);
  ctx.rect(0, Bd, Bd, H - 2 * Bd, ALL, "border", 1);
  ctx.rect(W - Bd, Bd, Bd, H - 2 * Bd, ALL, "border", 1);

  for (const z of STEPPE_ZONES) {
    const [x, y, w, h] = z.rect;
    ctx.zones.push({
      id: z.id, name: z.name, kind: z.kind, tier: z.tier,
      rect: { x: ctx.b(x), y: ctx.b(y), w: ctx.b(x + w) - ctx.b(x), h: ctx.b(y + h) - ctx.b(y) },
      ...(z.boss ? { boss: z.boss } : {}),
    });
  }
  for (const r of STEPPE_ROADS) {
    ctx.roads.push({ kind: r.kind, width: r.width, pts: r.pts.flatMap(([x, y]) => [ctx.b(x), ctx.b(y)]) });
    ctx.roadIds.push(r.id);
  }
  ctx.river = STEPPE_RIVER.flatMap(([x, y]) => [ctx.b(x), ctx.b(y)]);

  paintTerrain(ctx);
  reserveTerrain(ctx);
  placeExtracts(ctx);
  buildPois(ctx);
  placeSpawns(ctx);
  roadCars(ctx);
  wildProps(ctx);
  placeBuildingSpots(ctx);
  placeWildSpots(ctx);
  placeBosses(ctx);
  placeAmbient(ctx);
  // Last, from its own rng stream and reserving nothing: posts never move geometry (not hashed).
  placeNpcPosts(ctx);

  const t = ctx.terrain;
  const map: MapData = {
    id,
    genVersion: MAP_GEN_VERSION,
    seed,
    width: W,
    height: H,
    terrain: t.data,
    terrainCols: t.cols,
    terrainRows: t.rows,
    terrainCell: t.cell,
    zones: ctx.zones,
    roads: ctx.roads,
    river: ctx.river,
    rects: ctx.rects,
    circles: ctx.circles,
    bushes: ctx.bushes,
    decals: ctx.decals,
    buildings: ctx.buildings,
    containers: ctx.containers,
    lootSpots: ctx.lootSpots,
    spawns: ctx.spawns,
    extracts: ctx.extracts,
    bosses: ctx.bosses,
    ambient: ctx.ambient,
    npcPosts: ctx.npcPosts,
  };
  const validation = validateMap(map);
  // A template bug (unreachable extract, starved side) must never ship silently.
  if (opts.strict !== false && validation.errors.length > 0) {
    throw new Error(`map ${id}: ${validation.errors.join("; ")}`);
  }
  const counts: Record<string, number> = {
    rects: map.rects.length,
    circles: map.circles.length,
    bushes: map.bushes.length,
    decals: map.decals.length,
    buildings: map.buildings.length,
    rooms: map.buildings.reduce((s, b) => s + b.rooms.length, 0),
    containers: map.containers.length,
    lootSpots: map.lootSpots.length,
    spawns: map.spawns.length,
    extracts: map.extracts.length,
    bosses: map.bosses.length,
    ambient: map.ambient.length,
    npcPosts: map.npcPosts?.length ?? 0,
  };
  return { map, report: { validation, counts } };
}

function paintTerrain(ctx: GenCtx): void {
  const t = ctx.terrain;
  // ~768 px edge band gets extra forest: spawns start in cover.
  t.fillForest(ctx.rng("forest"), FOREST_FRAC, 12, 0.3);
  for (const z of ctx.zones) {
    const g = ZONE_GROUND[z.kind];
    t.paintRect(z.rect, () => g);
  }
  t.paintPolyline(ctx.river, RIVER_HALF_WIDTH + RIVER_BANK, (old) => (old === TERRAIN.WATER ? old : TERRAIN.DIRT));
  t.paintPolyline(ctx.river, RIVER_HALF_WIDTH, () => TERRAIN.WATER);
  ctx.roads.forEach((road) => {
    const kind = road.kind === "asphalt" ? TERRAIN.ASPHALT : road.kind === "rail" ? TERRAIN.GRAVEL : TERRAIN.DIRT;
    const mask = road.kind === "asphalt" ? ROAD_MASK.ASPHALT : road.kind === "rail" ? ROAD_MASK.RAIL : ROAD_MASK.DIRT;
    t.paintPolyline(road.pts, road.width / 2, (old, i) => {
      // Roads never pave the river: only the crossing bands below turn water into bridge/ford.
      if (old === TERRAIN.WATER) return old;
      // An earlier asphalt/dirt road keeps its mask where a rail line crosses it (wagons check it).
      if (!(mask === ROAD_MASK.RAIL && t.roadMask[i] !== ROAD_MASK.NONE)) t.roadMask[i] = mask;
      return kind;
    });
  });
  // Exactly three crossings: horizontal bands where water becomes BRIDGE (walkable, full speed)
  // or SHALLOW (the ford: walkable at 0.6× with loud splash steps).
  for (const c of STEPPE_CROSSINGS) {
    const cy = ctx.b(c.y);
    const rx = Math.round(polyXAtY(ctx.river, cy));
    const band = { x: rx - 1024, y: cy - c.height / 2, w: 2048, h: c.height };
    const kind = c.kind === "ford" ? TERRAIN.SHALLOW : TERRAIN.BRIDGE;
    const mask = c.kind === "ford" ? ROAD_MASK.DIRT : ROAD_MASK.ASPHALT;
    t.paintRect(band, (old, i) => {
      if (old !== TERRAIN.WATER) return old;
      t.roadMask[i] = mask;
      return kind;
    });
  }
}

/** Water → MOVE-only rects (shoot and see across; never walk). Roads/water → placement hash. */
function reserveTerrain(ctx: GenCtx): void {
  const t = ctx.terrain;
  for (const r of t.runs((i) => t.data[i] === TERRAIN.WATER)) {
    ctx.rects.push({ ...r, f: SOLID.MOVE, k: "water" });
    ctx.reserve(r);
  }
  for (const r of t.runs((i) => t.roadMask[i] !== ROAD_MASK.NONE)) ctx.reserve(r, true);
}
