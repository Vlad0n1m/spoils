import assert from "node:assert/strict";
import { test } from "node:test";
import { MAP_GEN_VERSION, PLAYER, WORLD } from "../constants.js";
import { circleIsFree, SOLID } from "../geometry.js";
import { generateMap, generateMapWithReport } from "./generate.js";
import {
  allowedExtracts,
  extractMask,
  floodWalk,
  getCollisionIndex,
  getWalkGrid,
  mapHash,
  reachedNear,
  terrainAt,
  walkCellOf,
  zoneAt,
} from "./query.js";
import { STEPPE_CROSSINGS } from "./steppe.js";
import { REACH_PX } from "./spots.js";
import { TERRAIN, TERRAIN_INDOOR, TERRAIN_KIND_MASK, type MapData, type MapSide } from "./types.js";

/**
 * Golden layout hash for MAP_GEN_VERSION 2. If this fails you changed generated geometry: if that
 * was intended, bump MAP_GEN_VERSION (constants.ts — clients cache the minimap by it) and update
 * this value; if not, something made the generator non-deterministic.
 */
const GOLDEN_HASH = "d066dcca";

const m = generateMap("steppe");

test("generateMap is memoized, versioned and reproducible (golden mapHash)", () => {
  assert.equal(generateMap(), m);
  assert.equal(m.genVersion, MAP_GEN_VERSION);
  assert.equal(m.width, WORLD.WIDTH);
  assert.equal(m.height, WORLD.HEIGHT);
  const again = generateMapWithReport("steppe").map;
  assert.notEqual(again, m);
  assert.equal(mapHash(again), mapHash(m));
  assert.equal(mapHash(m), GOLDEN_HASH);
});

test("generation time and size budget", () => {
  const runs: number[] = [];
  const before = process.memoryUsage().heapUsed;
  let last: ReturnType<typeof generateMapWithReport> | undefined;
  for (let i = 0; i < 3; i++) {
    const t0 = process.hrtime.bigint();
    last = generateMapWithReport("steppe");
    runs.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const heapMb = (process.memoryUsage().heapUsed - before) / 1048576;
  const best = Math.min(...runs);
  console.log(`[map] generateMap: ${runs.map((r) => r.toFixed(0)).join("/")} ms (incl. validation walk grid); heap Δ≈${heapMb.toFixed(1)} MB for 3 builds; counts ${JSON.stringify(last!.report.counts)}`);
  // Target < 1500 ms (critique); the real number is ~60 ms, so a 10× regression still passes CI
  // on slow runners but a pathological placement loop does not.
  assert.ok(best < 1500, `generation took ${best} ms`);
});

test("BLOCK = 853 fallback (20,480 px, critique cut 8) still validates", () => {
  // strict mode throws on any unreachable extract or a side with < 8 spawns.
  const { map, report } = generateMapWithReport("steppe", { block: 853 });
  assert.equal(map.width, 24 * 853);
  assert.deepEqual(report.validation.errors, []);
  assert.equal(map.extracts.length, 8);
  assert.ok(map.containers.length >= 280, `fallback containers ${map.containers.length}`);
});

test("content counts match the memo targets", () => {
  assert.equal(m.extracts.length, 8);
  assert.equal(new Set(m.extracts.map((e) => e.id)).size, 8);
  assert.ok(m.extracts.every((e) => e.kind === "always"));
  for (let s = 0; s < 4; s++) assert.equal(m.extracts.filter((e) => e.side === s).length, 2, `extracts on side ${s}`);
  assert.ok(m.spawns.length >= 36 && m.spawns.length <= 44, `spawns ${m.spawns.length}`);
  for (let s = 0; s < 4; s++) assert.ok(m.spawns.filter((p) => p.side === s).length >= 8, `spawns on side ${s}`);
  assert.ok(m.containers.length >= 330 && m.containers.length <= 470, `containers ${m.containers.length}`);
  assert.ok(m.lootSpots.length >= 450, `loot spots ${m.lootSpots.length}`);
  assert.equal(m.zones.length, 10);
  assert.ok(m.buildings.length >= 60, `buildings ${m.buildings.length}`);
  assert.deepEqual(m.bosses.map((b) => b.kind).sort(), ["commander", "foreman"]);
  for (const b of m.bosses) assert.ok(b.guards.length >= 2, `${b.kind} guards`);
  const amb = new Set(m.ambient.map((a) => a.k));
  for (const k of ["river", "sawmill", "generator", "forest"] as const) assert.ok(amb.has(k), `ambient ${k}`);
  // Every container kind but the boss stash appears.
  const kinds = new Set(m.containers.map((c) => c.kind));
  for (const k of ["crate", "toolbox", "fridge", "pc", "med_case", "weapon_box", "safe", "stash"] as const) assert.ok(kinds.has(k), `container kind ${k}`);
  // Solids budget (memo: 4.3k–6.1k).
  assert.ok(m.rects.length + m.circles.length < 7000, `solids ${m.rects.length + m.circles.length}`);
});

test("all geometry is integer and inside the world", () => {
  const int = (v: number) => Number.isInteger(v);
  for (const r of m.rects) {
    assert.ok(int(r.x) && int(r.y) && int(r.w) && int(r.h) && r.w > 0 && r.h > 0, JSON.stringify(r));
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= m.width && r.y + r.h <= m.height, JSON.stringify(r));
  }
  for (const c of [...m.circles, ...m.bushes, ...m.decals]) assert.ok(int(c.x) && int(c.y) && int(c.r) && c.r > 0, JSON.stringify(c));
  for (const p of [...m.containers, ...m.lootSpots, ...m.spawns, ...m.extracts]) {
    assert.ok(int(p.x) && int(p.y) && p.x > WORLD.BORDER && p.y > WORLD.BORDER && p.x < m.width - WORLD.BORDER && p.y < m.height - WORLD.BORDER, JSON.stringify(p));
  }
  for (const r of m.roads) assert.ok(r.pts.every(int));
  assert.ok(m.river.every(int));
});

test("collision flags follow the memo table", () => {
  const expect: Record<string, number> = {
    border: SOLID.ALL, wall: SOLID.ALL, concrete_wall: SOLID.ALL, crate: SOLID.ALL, ship_container: SOLID.ALL,
    shelf: SOLID.ALL, wagon: SOLID.ALL, logpile: SOLID.ALL, watchtower: SOLID.ALL,
    window: SOLID.MOVE, water: SOLID.MOVE,
    sandbags: SOLID.MOVE | SOLID.SHOT, car: SOLID.MOVE | SOLID.SHOT,
    fence: SOLID.MOVE | SOLID.SIGHT,
  };
  for (const r of m.rects) assert.equal(r.f, expect[r.k], `${r.k} flags`);
  const cexp: Record<string, number> = { tree: SOLID.ALL, rock: SOLID.ALL, silo: SOLID.ALL, barrel: SOLID.MOVE | SOLID.SHOT };
  for (const c of m.circles) assert.equal(c.f, cexp[c.k], `${c.k} flags`);
  const kinds = new Set(m.rects.map((r) => r.k));
  for (const k of ["car", "ship_container", "sandbags", "fence", "watchtower", "logpile", "wagon", "window", "water", "shelf"]) assert.ok(kinds.has(k as never), `rect kind ${k}`);
  assert.ok(m.circles.some((c) => c.k === "barrel") && m.circles.some((c) => c.k === "tree") && m.circles.some((c) => c.k === "rock"));
  assert.ok(m.decals.some((d) => d.k === "puddle"));
  assert.ok(m.bushes.length > 1000);
});

test("terrain: biomes, INDOOR under every room, shallow ford, forest share", () => {
  assert.equal(m.terrainCell, WORLD.TERRAIN_CELL);
  assert.equal(m.terrain.length, m.terrainCols * m.terrainRows);
  const count = new Array(16).fill(0) as number[];
  for (const v of m.terrain) count[v & TERRAIN_KIND_MASK]!++;
  const share = (k: number) => count[k]! / m.terrain.length;
  assert.ok(share(TERRAIN.FOREST) > 0.24 && share(TERRAIN.FOREST) < 0.42, `forest ${share(TERRAIN.FOREST)}`);
  for (const k of [TERRAIN.GRASS, TERRAIN.DIRT, TERRAIN.ASPHALT, TERRAIN.CONCRETE, TERRAIN.WOOD, TERRAIN.WATER, TERRAIN.BRIDGE, TERRAIN.GRAVEL, TERRAIN.SHALLOW]) {
    assert.ok(count[k]! > 0, `terrain kind ${k} present`);
  }
  for (const b of m.buildings) {
    for (const r of b.rooms) {
      const byte: number = m.terrain[Math.floor((r.y + r.h / 2) / m.terrainCell) * m.terrainCols + Math.floor((r.x + r.w / 2) / m.terrainCell)]!;
      assert.ok((byte & TERRAIN_INDOOR) !== 0, `room centre indoor (${b.arch})`);
      assert.equal(byte & TERRAIN_KIND_MASK, b.floorTerrain);
    }
  }
  // INDOOR only under building floors (one 64 px cell of slack for centre-snapping).
  for (let i = 0; i < m.terrain.length; i++) {
    if ((m.terrain[i]! & TERRAIN_INDOOR) === 0) continue;
    const x = (i % m.terrainCols + 0.5) * m.terrainCell, y = (Math.floor(i / m.terrainCols) + 0.5) * m.terrainCell;
    assert.ok(m.buildings.some((b) => x >= b.floor.x && x < b.floor.x + b.floor.w && y >= b.floor.y && y < b.floor.y + b.floor.h));
  }
});

test("zones: containers carry their zone and tier; wilderness is tier 0–1", () => {
  for (const c of m.containers) {
    if (c.zone === null) {
      assert.ok(c.tier <= 1);
      continue;
    }
    const z = zoneAt(m, c.x, c.y);
    assert.equal(z?.id, c.zone, `container in ${c.zone}`);
    assert.equal(c.tier, z!.tier);
  }
  for (const b of m.buildings) if (b.zone !== "") assert.ok(m.zones.some((z) => z.id === b.zone));
  const radar = m.zones.find((z) => z.id === "radar")!;
  assert.equal(radar.tier, 4);
  assert.equal(radar.boss, "commander");
});

// ───────────────────────── reachability (memo §4.9, §11)

const idx = getCollisionIndex(m);
const grid = getWalkGrid(m);

function floodFromSide(map: MapData, side: MapSide): Uint8Array {
  const s = map.spawns.find((p) => p.side === side)!;
  return floodWalk(grid, s.x, s.y);
}

test("every side's spawns reach every extract, spawn, container and loot spot", () => {
  for (let side = 0 as MapSide; side <= 3; side = (side + 1) as MapSide) {
    const reached = floodFromSide(m, side);
    for (const e of m.extracts) assert.ok(reachedNear(grid, reached, e.x, e.y, 48), `side ${side} → ${e.id}`);
    for (const s of m.spawns) assert.equal(reached[walkCellOf(grid, s.x, s.y)], 1, `side ${side} → spawn ${s.x},${s.y}`);
    const okC = m.containers.filter((c) => reachedNear(grid, reached, c.x, c.y, REACH_PX)).length;
    assert.ok(okC / m.containers.length >= 0.95, `containers reachable ${okC}/${m.containers.length}`);
    assert.equal(okC, m.containers.length, "validation keeps only reachable containers");
    const okL = m.lootSpots.filter((p) => reached[walkCellOf(grid, p.x, p.y)] === 1).length;
    assert.equal(okL, m.lootSpots.length);
    for (const b of m.bosses) {
      assert.equal(reached[walkCellOf(grid, b.x, b.y)], 1, `boss ${b.kind}`);
      for (const g of b.guards) assert.equal(reached[walkCellOf(grid, g.x, g.y)], 1, `guard of ${b.kind}`);
    }
  }
});

test("no solid overlaps a spawn or extract circle; spawns are spaced out", () => {
  for (const s of m.spawns) assert.ok(circleIsFree(idx, s.x, s.y, PLAYER.RADIUS + 16, SOLID.ALL), `spawn ${s.x},${s.y}`);
  for (const e of m.extracts) assert.ok(circleIsFree(idx, e.x, e.y, e.r, SOLID.ALL), `extract ${e.id}`);
  for (const [i, a] of m.spawns.entries()) {
    for (const b of m.spawns.slice(i + 1)) assert.ok((a.x - b.x) ** 2 + (a.y - b.y) ** 2 >= 1400 * 1400);
    for (const e of m.extracts) assert.ok((a.x - e.x) ** 2 + (a.y - e.y) ** 2 >= 2000 * 2000);
  }
  // Containers are never inside a solid (the sprite would be unreachable / clip).
  for (const c of m.containers) assert.ok(circleIsFree(idx, c.x, c.y, 8, SOLID.MOVE), `container ${c.kind} at ${c.x},${c.y}`);
});

test("the river has exactly 3 crossings and they are the only way across", () => {
  // (a) 3 connected components of BRIDGE/SHALLOW terrain, one per template crossing.
  const isX = (i: number) => {
    const k = m.terrain[i]! & TERRAIN_KIND_MASK;
    return k === TERRAIN.BRIDGE || k === TERRAIN.SHALLOW;
  };
  const seen = new Uint8Array(m.terrain.length);
  const comps: number[] = [];
  for (let i = 0; i < m.terrain.length; i++) {
    if (seen[i] || !isX(i)) continue;
    const stack = [i];
    seen[i] = 1;
    let rowSum = 0, n = 0;
    while (stack.length) {
      const j = stack.pop()!;
      rowSum += Math.floor(j / m.terrainCols);
      n++;
      for (const k of [j - 1, j + 1, j - m.terrainCols, j + m.terrainCols]) {
        if (k >= 0 && k < m.terrain.length && !seen[k] && isX(k)) { seen[k] = 1; stack.push(k); }
      }
    }
    comps.push(((rowSum / n + 0.5) * m.terrainCell) / WORLD.BLOCK);
  }
  assert.equal(comps.length, 3, `crossing components ${comps.length}`);
  for (const c of STEPPE_CROSSINGS) assert.ok(comps.some((y) => Math.abs(y - c.y) < 0.3), `crossing ${c.name}`);
  const ford = m.terrain.findIndex((v) => (v & TERRAIN_KIND_MASK) === TERRAIN.SHALLOW);
  assert.ok(ford >= 0);

  // (b) Closing the crossings disconnects the banks.
  const west = m.spawns.find((s) => s.side === 3)!;
  const east = m.spawns.find((s) => s.side === 1)!;
  assert.equal(floodWalk(grid, west.x, west.y)[walkCellOf(grid, east.x, east.y)], 1);
  const closed = { ...grid, blocked: grid.blocked.slice() };
  for (let i = 0; i < closed.blocked.length; i++) {
    const x = (i % closed.cols + 0.5) * closed.cell, y = (Math.floor(i / closed.cols) + 0.5) * closed.cell;
    const k = terrainAt(m, x, y);
    if (k === TERRAIN.BRIDGE || k === TERRAIN.SHALLOW) closed.blocked[i] = 1;
  }
  assert.equal(floodWalk(closed, west.x, west.y)[walkCellOf(closed, east.x, east.y)], 0);
});

test("allowed extracts: never own side, both opposite + one per adjacent side", () => {
  for (let side = 0 as MapSide; side <= 3; side = (side + 1) as MapSide) {
    const allowed = allowedExtracts(m, side);
    assert.equal(allowed.length, 4);
    assert.ok(allowed.every((e) => e.side !== side));
    assert.equal(allowed.filter((e) => e.side === (side + 2) % 4).length, 2);
    assert.ok(allowed.some((e) => e.closesAtMs === undefined), "an always-open option survives 25:00");
    const mask = extractMask(m, side);
    assert.equal(mask.toString(2).split("1").length - 1, 4);
    assert.ok(mask < 256);
    m.extracts.forEach((e, i) => assert.equal(((mask >> i) & 1) === 1, allowed.includes(e)));
  }
});
