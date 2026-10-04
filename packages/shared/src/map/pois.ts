/**
 * POI layouts (map memo §3, §4.5). Village, industrial and military are templated lots (random
 * scatter inside POIs looked noisy in the prototype); rail and quarry are mostly scatter
 * (critique: lot templates time-boxed). Each POI draws from its own rng stream.
 *
 * Map v2 (MAP_GEN_VERSION 4) adds Millbrook (street rows of shops, a diner, a clinic, offices and a
 * garage on the crossroads, houses behind), the Pump Station (fenced works with water tanks), the
 * Ranger Station, Relay Hill (a small walled T3 post) and the Truck Stop, grows the Radar Base by an
 * office, and dresses POIs with fence styles, lamp posts and sign posts at their road entrances.
 *
 * Every layout only *proposes* geometry: buildings and props go through the placement hash, so a
 * POI never overlaps a road, the river or another POI, and validation (spots.ts) later drops any
 * spot that ended up unreachable.
 */

import type { Rect } from "../geometry.js";
import type { Rng } from "../rng.js";
import { ARCH } from "./buildings.js";
import { ALL, LOW, type GenCtx } from "./context.js";
import {
  FENCE_STYLE,
  barrel,
  car,
  clutter,
  crate,
  decor,
  fenceLine,
  groundDecal,
  logpile,
  outdoorContainers,
  pointIn,
  quarterToward,
  rock,
  sandbags,
  scatter,
  shipContainer,
  streetLamps,
  tree,
  bush,
} from "./props.js";
import { ROAD_MASK } from "./terrain.js";
import { TERRAIN, TERRAIN_INDOOR, type BuildingArch, type MapSide, type Zone } from "./types.js";
import { chance, grow, inRect, pick, pickW, polyXAtY, polyYAtX, ri, rs, shuffle } from "./util.js";

export function buildPois(ctx: GenCtx): void {
  zarya(ctx);
  kolkhoz(ctx);
  dachas(ctx);
  fuelStop(ctx);
  sawmill(ctx);
  elevator(ctx);
  depot(ctx);
  checkpoint(ctx);
  radar(ctx);
  quarry(ctx);
  millbrook(ctx);
  pumpworks(ctx);
  ranger(ctx);
  relay(ctx);
  truckstop(ctx);
  hunterCabins(ctx);
  zoneSigns(ctx);
}

const inner = (z: Zone, m: number): Rect => grow(z.rect, -m);

// ───────────────────────── villages: lots along the road frontage

interface LotOpts {
  lotW: number;
  lotH: number;
  colsW: number;
  colsE: number;
  /** House probability by column (0 = road frontage). */
  houseP: readonly number[];
  archs: ReadonlyArray<readonly [BuildingArch, number]>;
  /** Max house width/height (cottages are smaller than village houses). */
  maxW: number;
  maxH: number;
  barnLot?: number;
}

/**
 * Lots on both sides of a roughly N–S road: each lot is a fenced yard (front fence with a gate,
 * one side fence with a back gap — never a closed ring, so yards cannot trap anyone) with a house
 * whose door faces the road, plus yard clutter. Lots without a house become gardens.
 */
function frontageLots(ctx: GenCtx, rng: Rng, z: Zone, road: readonly number[], roadHalf: number, o: LotOpts): void {
  const rows = Math.floor(z.rect.h / o.lotH);
  const y0 = z.rect.y + Math.floor((z.rect.h - rows * o.lotH) / 2);
  let lotNo = 0;
  for (let row = 0; row < rows; row++) {
    const ly = y0 + row * o.lotH;
    const rx = Math.round(polyXAtY(road, ly + o.lotH / 2));
    for (const dir of [-1, 1] as const) {
      const ncols = dir < 0 ? o.colsW : o.colsE;
      for (let k = 0; k < ncols; k++) {
        const lx = dir < 0 ? rx - roadHalf - 48 - (k + 1) * o.lotW : rx + roadHalf + 48 + k * o.lotW;
        const lot: Rect = { x: lx, y: ly, w: o.lotW, h: o.lotH };
        if (lot.x < z.rect.x - 64 || lot.x + lot.w > z.rect.x + z.rect.w + 64) continue;
        if (!ctx.free(lot, 0)) continue;
        const front: MapSide = dir < 0 ? 1 : 3;
        const isBarn = o.barnLot !== undefined && lotNo === o.barnLot;
        lotNo++;
        const house = isBarn || chance(rng, o.houseP[k] ?? 0.1);
        buildLot(ctx, rng, z, lot, front, house ? (isBarn ? "barn" : pickW(rng, o.archs)) : null, o);
      }
    }
  }
}

function buildLot(ctx: GenCtx, rng: Rng, z: Zone, lot: Rect, front: MapSide, arch: BuildingArch | null, o: LotOpts): void {
  // House ↔ lot edge clearance. The building reserves its floor grown by 96 px (props never block
  // a door), so the fence line at 16..32 px needs the house ≥ 144 px in.
  const M = 144;
  let house: Rect | null = null;
  if (arch) {
    const a = ARCH[arch];
    let w = Math.min(o.maxW, rs(rng, a.w[0], a.w[1], 32));
    let h = Math.min(o.maxH, rs(rng, a.h[0], a.h[1], 32));
    w = Math.min(w, lot.w - 2 * M);
    h = Math.min(h, lot.h - 2 * M);
    if (w >= Math.min(384, a.w[0]) && h >= Math.min(320, a.h[0])) {
      const setback = ri(rng, M, M + 96);
      const x = front === 1
        ? Math.max(lot.x + M, lot.x + lot.w - setback - w)
        : Math.min(lot.x + setback, lot.x + lot.w - M - w);
      const yMin = lot.y + M, yMax = lot.y + lot.h - M - h;
      const y = yMin + Math.floor(rng() * (yMax - yMin + 1));
      const bi = ctx.building(rng, arch, z.id, { x: Math.round(x), y, w, h }, { door: front, margin: 48 });
      if (bi >= 0) house = ctx.buildings[bi]!.floor;
    }
  }
  const fenced = house ? chance(rng, 0.85) : chance(rng, 0.45);
  if (fenced) {
    // Front fence (road side) with a wide gate near the middle.
    const fx = front === 1 ? lot.x + lot.w - 24 : lot.x + 24;
    const gate = ri(rng, Math.floor(lot.h * 0.3), Math.floor(lot.h * 0.6) - 192);
    fenceLine(ctx, fx, lot.y + 24, fx, lot.y + lot.h - 24, [[gate, 192]], FENCE_STYLE[z.kind]);
    // North side fence with a back gap (never a closed ring). It stops 40 px short of the front
    // fence: touching panels would fail each other's placement check.
    const x0 = front === 1 ? lot.x + 24 : lot.x + 64;
    const x1 = front === 1 ? lot.x + lot.w - 64 : lot.x + lot.w - 24;
    const gapAt = front === 1 ? 24 : x1 - x0 - 24 - 176;
    fenceLine(ctx, x0, lot.y + 24, x1, lot.y + 24, [[gapAt, 176]], FENCE_STYLE[z.kind]);
  }
  // Yard clutter.
  const yard = grow(lot, -72);
  if (chance(rng, 0.4)) scatter(rng, yard, 1, (x, y) => logpile(ctx, x, y, chance(rng, 0.5), 64), 6);
  if (chance(rng, 0.4)) scatter(rng, yard, 1, (x, y) => barrel(ctx, x, y, 48), 6);
  if (chance(rng, 0.25)) scatter(rng, yard, 1, (x, y) => crate(ctx, x, y, 48), 6);
  scatter(rng, yard, house ? (chance(rng, 0.3) ? 1 : 0) : ri(rng, 1, 3), (x, y) => tree(ctx, x, y, ri(rng, 26, 34), 64), 6);
  scatter(rng, yard, house ? ri(rng, 0, 2) : ri(rng, 2, 4), (x, y) => bush(ctx, x, y, ri(rng, 48, 68)), 6);
  if (chance(rng, 0.5)) {
    const [x, y] = pointIn(rng, yard);
    ctx.decal(x, y, ri(rng, 48, 96), "puddle");
  }
  if (house && chance(rng, 0.5)) {
    const [x, y] = pointIn(rng, yard);
    ctx.decal(x, y, ri(rng, 80, 160), "dirt");
  }
}

function zarya(ctx: GenCtx): void {
  const z = ctx.zone("zarya");
  const rng = ctx.rng("poi:zarya");
  const road = ctx.road("ns").pts;
  frontageLots(ctx, rng, z, road, 80, {
    lotW: 1024, lotH: 896, colsW: 3, colsE: 3, houseP: [0.95, 0.7, 0.35],
    archs: [["houseS", 6], ["houseM", 4]], maxW: 800, maxH: 640, barnLot: 13,
  });
  clutter(ctx, rng, inner(z, 128), { crates: 4, barrels: 3, decals: 8, decal: "dirt" });
}

function dachas(ctx: GenCtx): void {
  const z = ctx.zone("dachas");
  const rng = ctx.rng("poi:dachas");
  const road = ctx.road("dacha").pts;
  frontageLots(ctx, rng, z, road, 80, {
    lotW: 896, lotH: 768, colsW: 2, colsE: 2, houseP: [0.9, 0.65],
    archs: [["houseS", 8], ["shed", 2]], maxW: 512, maxH: 448,
  });
  clutter(ctx, rng, inner(z, 128), { crates: 3, barrels: 2, decals: 6, decal: "dirt" });
}

// ───────────────────────── farm, fuel stop, sawmill: small templated scatter

function kolkhoz(ctx: GenCtx): void {
  const z = ctx.zone("kolkhoz");
  const rng = ctx.rng("poi:kolkhoz");
  const area = inner(z, 160);
  // Farmhouse near the road (east half), barns anywhere.
  const east: Rect = { x: area.x + Math.floor(area.w / 2), y: area.y, w: Math.ceil(area.w / 2), h: area.h };
  ctx.scatterBuilding(rng, "houseM", z.id, east, 40);
  for (let i = 0; i < 3; i++) ctx.scatterBuilding(rng, "barn", z.id, area, 40);
  ctx.scatterBuilding(rng, "shed", z.id, area, 30);
  // Paddock: an open-ended fence U somewhere free.
  for (let t = 0; t < 20; t++) {
    const w = ri(rng, 640, 960), h = ri(rng, 480, 640);
    const [x, y] = pointIn(rng, { x: area.x, y: area.y, w: area.w - w, h: area.h - h });
    if (!ctx.free({ x, y, w, h }, 32)) continue;
    fenceLine(ctx, x, y, x + w, y, [[Math.floor(w / 2) - 96, 192]], 1);
    fenceLine(ctx, x, y + 40, x, y + h, [], 1);
    fenceLine(ctx, x + w, y + 40, x + w, y + h, [[Math.floor(h / 2) - 80, 160]], 1);
    scatter(rng, { x: x + 48, y: y + 48, w: w - 96, h: h - 96 }, 2, (px, py) => logpile(ctx, px, py, chance(rng, 0.5), 48));
    break;
  }
  // Haystacks (log piles), a tractor wreck, barrels.
  scatter(rng, area, 5, (x, y) => logpile(ctx, x, y, chance(rng, 0.5), 64));
  scatter(rng, area, 1, (x, y) => car(ctx, x, y, chance(rng, 0.5), false, 64));
  clutter(ctx, rng, area, { crates: 3, barrels: 3, decals: 6, decal: "dirt" });
  outdoorContainers(ctx, rng, area, 2, z.tier, z.id);
}

function fuelStop(ctx: GenCtx): void {
  const z = ctx.zone("fuel");
  const rng = ctx.rng("poi:fuel");
  const area = inner(z, 128);
  const top: Rect = { x: area.x, y: area.y, w: area.w, h: Math.floor(area.h * 0.55) };
  ctx.scatterBuilding(rng, "shop", z.id, top, 40);
  ctx.scatterBuilding(rng, "shed", z.id, area, 30);
  // Pump islands: two pairs of barrels on the forecourt.
  for (let i = 0; i < 2; i++) {
    for (let t = 0; t < 30; t++) {
      const [x, y] = pointIn(rng, area);
      if (!ctx.free({ x: x - 40, y: y - 120, w: 80, h: 240 }, 48)) continue;
      barrel(ctx, x, y - 64, 0);
      barrel(ctx, x, y + 64, 0);
      break;
    }
  }
  scatter(rng, area, 2, (x, y) => car(ctx, x, y, chance(rng, 0.5), false, 56));
  clutter(ctx, rng, area, { crates: 2, barrels: 2, decals: 5, decal: "oil" });
  outdoorContainers(ctx, rng, area, 2, z.tier, z.id);
}

function sawmill(ctx: GenCtx): void {
  const z = ctx.zone("sawmill");
  const rng = ctx.rng("poi:sawmill");
  const area = inner(z, 128);
  const hall = ctx.scatterBuilding(rng, "warehouse", z.id, area, 60);
  ctx.scatterBuilding(rng, "shed", z.id, area, 40);
  ctx.scatterBuilding(rng, "shed", z.id, area, 40);
  // Log pile rows on a grid (the "yard").
  let piles = 0;
  for (let y = area.y + 120; y < area.y + area.h - 120 && piles < 16; y += 220) {
    for (let x = area.x + 140; x < area.x + area.w - 140 && piles < 16; x += 300) {
      if (chance(rng, 0.45) && logpile(ctx, x, y, false, 56)) piles++;
    }
  }
  clutter(ctx, rng, area, { crates: 4, barrels: 4, decals: 6, decal: "debris" });
  outdoorContainers(ctx, rng, area, 2, z.tier, z.id);
  if (hall >= 0) {
    const f = ctx.buildings[hall]!.floor;
    ctx.ambient.push({ x: Math.round(f.x + f.w / 2), y: Math.round(f.y + f.h / 2), r: 1400, k: "sawmill" });
  }
}

// ───────────────────────── Grain Elevator: industrial pads

function elevator(ctx: GenCtx): void {
  const z = ctx.zone("elevator");
  const rng = ctx.rng("poi:elevator");
  const padW = Math.floor(z.rect.w / 3), padH = Math.floor(z.rect.h / 2);
  const kinds = [["wh", "silo", "wh"], ["yard", "wh", "yard"]] as const;
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 3; c++) {
      const pad: Rect = { x: z.rect.x + c * padW, y: z.rect.y + r * padH, w: padW, h: padH };
      const pin = grow(pad, -128);
      const kind = kinds[r]![c]!;
      if (kind === "wh") {
        ctx.scatterBuilding(rng, "warehouse", z.id, pin, 60);
        ctx.scatterBuilding(rng, "shed", z.id, pin, 40);
        clutter(ctx, rng, pin, { crates: 3, barrels: 2 });
      } else if (kind === "silo") {
        // 2×2 silo cluster (big ALL circles, 120 px lanes between them) + the office (boss).
        const cx = pin.x + 200 + ri(rng, 0, 160), cy = pin.y + 200 + ri(rng, 0, 120);
        for (let i = 0; i < 4; i++) {
          const sx = cx + (i % 2) * 440, sy = cy + Math.floor(i / 2) * 440;
          if (ctx.free({ x: sx - 160, y: sy - 160, w: 320, h: 320 }, 24)) ctx.circle(sx, sy, 160, ALL, "silo", 160);
        }
        const low: Rect = { x: pin.x, y: pin.y + Math.floor(pin.h * 0.42), w: pin.w, h: Math.ceil(pin.h * 0.58) };
        ctx.scatterBuilding(rng, "office", z.id, low, 60);
        ctx.ambient.push({ x: cx + 220, y: cy + 220, r: 900, k: "generator" });
      } else {
        // Security booth first (it needs a clear pad), then the container maze around it.
        ctx.scatterBuilding(rng, "shed", z.id, pin, 40);
        containerYard(ctx, rng, pin);
        // Map v2: 7 → 4 per yard; balanceTiers tops the tier up next to the Foreman instead.
        outdoorContainers(ctx, rng, pin, 4, z.tier, z.id);
      }
    }
  }
  clutter(ctx, rng, inner(z, 128), { crates: 4, barrels: 4, decals: 10, decal: "oil" });
  streetLamps(ctx, ctx.road("highway").pts, 256, z.rect, 640);
}

/**
 * Shipping-container maze: stacks of 2–3 touching rows separated by 192 px lanes; rows have random
 * gaps and holes so the maze has cut-throughs. Row ends stay open (the pad margin), so the maze
 * can never close a pocket off.
 */
function containerYard(ctx: GenCtx, rng: Rng, pin: Rect): void {
  let y = pin.y + 64;
  while (y + 160 <= pin.y + pin.h - 64) {
    const deep = ri(rng, 1, 3);
    for (let d = 0; d < deep && y + 160 <= pin.y + pin.h - 64; d++, y += 160) {
      let x = pin.x + 96 + ri(rng, 0, 96);
      while (x + 384 <= pin.x + pin.w - 96) {
        if (!chance(rng, 0.14)) shipContainer(ctx, x, y, false, 0);
        x += 384 + pickW(rng, [[0, 5], [96, 2], [192, 2]] as const);
      }
    }
    y += 192 + ri(rng, 0, 64);
  }
}

// ───────────────────────── Rail Depot: tracks with wagon rows (scatter for the rest)

function depot(ctx: GenCtx): void {
  const z = ctx.zone("depot");
  const rng = ctx.rng("poi:depot");
  const sideTracks = [ctx.road("track-n"), ctx.road("track-s")];
  const yN = sideTracks[0]!.pts[1]!, yS = sideTracks[1]!.pts[1]!;
  // Wagons on the side tracks (the main line stays a clear lane). Never on the N–S road crossing.
  for (const tr of sideTracks) {
    const ty = tr.pts[1]!;
    let x = tr.pts[0]! + ri(rng, 0, 128);
    while (x + 640 <= tr.pts[2]!) {
      const r = { x, y: ty - 72, w: 640, h: 144 };
      if (ctx.freeOnRoad(r, 0, true)) ctx.rect(r.x, r.y, r.w, r.h, ALL, "wagon", 0);
      x += 640 + pickW(rng, [[96, 3], [256, 3], [640, 2]] as const);
    }
  }
  const north: Rect = { x: z.rect.x + 128, y: z.rect.y + 128, w: z.rect.w - 256, h: yN - 160 - (z.rect.y + 128) };
  const south: Rect = { x: z.rect.x + 128, y: yS + 160, w: z.rect.w - 256, h: z.rect.y + z.rect.h - 128 - (yS + 160) };
  ctx.scatterBuilding(rng, "warehouse", z.id, north, 60);
  ctx.scatterBuilding(rng, "shed", z.id, north, 40);
  ctx.scatterBuilding(rng, "shed", z.id, north, 40);
  ctx.scatterBuilding(rng, "warehouse", z.id, south, 60);
  ctx.scatterBuilding(rng, "shed", z.id, south, 40);
  clutter(ctx, rng, north, { crates: 4, barrels: 3, decals: 6, decal: "oil" });
  clutter(ctx, rng, south, { crates: 4, barrels: 3, decals: 4, decal: "debris" });
  scatter(rng, inner(z, 128), 4, (x, y) => shipContainer(ctx, x, y, chance(rng, 0.5), 64));
  outdoorContainers(ctx, rng, inner(z, 128), 8, z.tier, z.id);
  // Map v2: chain-link along the yard's north edge (roads cut their own gates), two walk-through gaps.
  const fy = z.rect.y + 48;
  fenceLine(ctx, z.rect.x + 64, fy, z.rect.x + z.rect.w - 64, fy, [[Math.floor(z.rect.w * 0.3), 224], [Math.floor(z.rect.w * 0.7), 224]], FENCE_STYLE[z.kind]);
}

// ───────────────────────── Bridge Checkpoint

function checkpoint(ctx: GenCtx): void {
  const z = ctx.zone("checkpoint");
  const rng = ctx.rng("poi:checkpoint");
  const hw = ctx.road("highway").pts;
  const roadY = Math.round(polyYAtX(hw, z.rect.x + 400));
  const area = inner(z, 96);
  const north: Rect = { x: area.x, y: area.y, w: area.w, h: roadY - 200 - area.y };
  const south: Rect = { x: area.x, y: roadY + 200, w: area.w, h: area.y + area.h - roadY - 200 };
  ctx.scatterBuilding(rng, "shed", z.id, north, 40);
  ctx.scatterBuilding(rng, "shed", z.id, south, 40);
  // Sandbag nests (U facing the bridge, i.e. west) on both shoulders.
  for (const ny of [roadY - 520, roadY + 280]) {
    const nx = z.rect.x + 200;
    if (ctx.free({ x: nx - 8, y: ny - 8, w: 208, h: 256 }, 0)) {
      sandbags(ctx, nx, ny, true, 0);
      sandbags(ctx, nx + 48, ny, false, 0);
      sandbags(ctx, nx + 48, ny + 192 - 48, false, 0);
      // Ammo box inside the U (open to the east, 96 px deep: a player fits).
      ctx.container(nx + 150, ny + 96, chance(rng, 0.6) ? "weapon_box" : "med_case", z.tier, z.id);
    }
  }
  // Staggered concrete road blocks: slows vehicles in lore, leaves 144 px lanes for players.
  const bx = z.rect.x + 760;
  if (ctx.freeOnRoad({ x: bx, y: roadY - 128, w: 48, h: 112 }, 0)) ctx.rect(bx, roadY - 128, 48, 112, ALL, "concrete_wall", 1);
  if (ctx.freeOnRoad({ x: bx + 320, y: roadY + 16, w: 48, h: 112 }, 0)) ctx.rect(bx + 320, roadY + 16, 48, 112, ALL, "concrete_wall", 1);
  clutter(ctx, rng, area, { crates: 3, barrels: 2, decals: 3, decal: "debris" });
  outdoorContainers(ctx, rng, area, 2, z.tier, z.id);
  // Map v2: barbed wire on the land side of the post (east edge), with a gap on each shoulder.
  const ex = z.rect.x + z.rect.w - 40;
  fenceLine(ctx, ex, z.rect.y + 64, ex, z.rect.y + z.rect.h - 64, [[Math.floor(z.rect.h * 0.2), 192], [Math.floor(z.rect.h * 0.7), 192]], FENCE_STYLE[z.kind]);
  streetLamps(ctx, hw, 256, z.rect, 560);
}

// ───────────────────────── Radar Base: walled military compound

function radar(ctx: GenCtx): void {
  const z = ctx.zone("radar");
  const rng = ctx.rng("poi:radar");
  const { x: zx, y: zy, w: zw, h: zh } = z.rect;
  const T = 48, G = 288;
  const southGate = Math.round(polyXAtY(ctx.road("radar").pts, zy + zh)) - G / 2;
  const westGate = Math.round(polyYAtX(ctx.road("ford").pts, zx)) - G / 2;
  // Perimeter (concrete, ALL). Gates are plain gaps; the trail and the spur run through them.
  const wall = (x: number, y: number, w: number, h: number) => {
    if (w > 0 && h > 0) ctx.rect(x, y, w, h, ALL, "concrete_wall", w >= h ? 0 : 1);
  };
  wall(zx, zy, zw, T);
  wall(zx, zy + zh - T, southGate - zx, T);
  wall(southGate + G, zy + zh - T, zx + zw - southGate - G, T);
  wall(zx, zy + T, T, westGate - zy - T);
  wall(zx, westGate + G, T, zy + zh - T - westGate - G);
  wall(zx + zw - T, zy + T, T, zh - 2 * T);
  // Watchtowers in the four inner corners.
  for (const [tx, ty] of [[zx + 112, zy + 112], [zx + zw - 240, zy + 112], [zx + 112, zy + zh - 240], [zx + zw - 240, zy + zh - 240]] as const) {
    if (ctx.free({ x: tx, y: ty, w: 128, h: 128 }, 0)) ctx.rect(tx, ty, 128, 128, ALL, "watchtower");
  }
  // Buildings at template slots (rel px), nudged if the slot is blocked.
  const slot = (arch: BuildingArch, rx: number, ry: number, w: number, h: number, door?: MapSide): number => {
    for (let t = 0; t < 8; t++) {
      const jx = t === 0 ? 0 : ri(rng, -128, 128), jy = t === 0 ? 0 : ri(rng, -128, 128);
      const bi = ctx.building(rng, arch, z.id, { x: zx + rx + jx, y: zy + ry + jy, w, h }, { margin: 64, door });
      if (bi >= 0) return bi;
    }
    return -1;
  };
  slot("barracks", 420, 460, 1152, 480, 2);
  slot("barracks", 420, 1240, 1152, 480, 2);
  slot("barracks", 420, 2020, 1152, 480, 0);
  slot("office", 2140, 460, 832, 640, 2);
  slot("warehouse", 3340, 460, 1216, 768, 2);
  slot("bunker", 3700, 3240, 704, 704, 3);
  slot("barracks", 2140, 1560, 1088, 448, 2);
  // Map v2: the base grew to 5.6 blocks — a staff office next to the command office, inside the
  // Commander's guard radius (POOL.GUARDED_RADIUS_PX), so pool uniques stay as boss-guarded as on v6.
  slot("office", 3400, 1400, 768, 576, 3);
  // Radar dish with a sandbag ring.
  const dx = zx + 1500, dy = zy + 3500;
  if (ctx.free({ x: dx - 136, y: dy - 136, w: 272, h: 272 }, 32)) {
    ctx.circle(dx, dy, 128, ALL, "silo", 136);
    sandbags(ctx, dx - 96, dy - 300, false, 0);
    sandbags(ctx, dx - 96, dy + 252, false, 0);
    sandbags(ctx, dx - 300, dy - 96, true, 0);
  }
  // Gate nests (inside the wall).
  sandbags(ctx, southGate - 260, zy + zh - T - 300, false, 16);
  sandbags(ctx, southGate + G + 68, zy + zh - T - 300, false, 16);
  sandbags(ctx, zx + T + 260, westGate - 260, true, 16);
  sandbags(ctx, zx + T + 260, westGate + G + 68, true, 16);
  const area = inner(z, 160);
  // The parade ground would be a shooting gallery: scattered sandbag walls and two containers.
  const yard: Rect = { x: area.x, y: area.y + Math.floor(area.h * 0.5), w: area.w, h: Math.ceil(area.h * 0.5) };
  scatter(rng, yard, 8, (x, y) => sandbags(ctx, x, y, chance(rng, 0.5), 72));
  scatter(rng, yard, 3, (x, y) => shipContainer(ctx, x, y, chance(rng, 0.5), 112));
  clutter(ctx, rng, area, { crates: 10, barrels: 6, decals: 8, decal: "debris", military: true });
  // Map v2: 8 → 5 scattered boxes; balanceTiers tops the tier up next to the Commander instead.
  outdoorContainers(ctx, rng, area, 5, z.tier, z.id);
  streetLamps(ctx, ctx.road("radar").pts, 160, z.rect, 700);
  ctx.ambient.push({ x: zx + 2560, y: zy + 900, r: 1000, k: "generator" });
}

// ───────────────────────── Quarry (scatter)

function quarry(ctx: GenCtx): void {
  const z = ctx.zone("quarry");
  const rng = ctx.rng("poi:quarry");
  const area = inner(z, 128);
  ctx.scatterBuilding(rng, "shed", z.id, area, 40);
  ctx.scatterBuilding(rng, "shed", z.id, area, 40);
  // Excavator wreck (MOVE|SHOT), then the pit's rock clusters.
  for (let t = 0; t < 30; t++) {
    const [x, y] = pointIn(rng, area);
    const r = { x: x - 160, y: y - 88, w: 320, h: 176 };
    if (!ctx.free(r, 64)) continue;
    ctx.rect(r.x, r.y, r.w, r.h, LOW, "car", 0);
    break;
  }
  const pit = grow(z.rect, -420);
  scatter(rng, pit, 24, (x, y) => rock(ctx, x, y, ri(rng, 60, 140), 72), 10);
  clutter(ctx, rng, area, { crates: 4, barrels: 2, decals: 8, decal: "debris" });
  outdoorContainers(ctx, rng, area, 7, z.tier, z.id);
}

// ───────────────────────── wilderness hunter cabins (zone "", containers tier 1)

function hunterCabins(ctx: GenCtx): void {
  const rng = ctx.rng("poi:cabins");
  const area: Rect = { x: 1600, y: 1600, w: ctx.width - 3200, h: ctx.height - 3200 };
  let placed = 0;
  // Spread the cabins: one per sixth of the map (3 columns × 2 rows; map v2 has room for 6).
  const region = (x: number, y: number) => Math.min(2, Math.floor((x * 3) / ctx.width)) + (y < ctx.height / 2 ? 0 : 3);
  for (let t = 0; t < 600 && placed < 6; t++) {
    const [x, y] = pointIn(rng, area);
    if (ctx.terrain.kindAt(x, y) !== TERRAIN.FOREST) continue;
    if (ctx.zones.some((zz) => x > zz.rect.x - 900 && x < zz.rect.x + zz.rect.w + 900 && y > zz.rect.y - 900 && y < zz.rect.y + zz.rect.h + 900)) continue;
    const q = region(x, y);
    if (ctx.buildings.some((b) => b.zone === "" && region(b.floor.x, b.floor.y) === q)) continue;
    const bi = ctx.scatterBuilding(rng, "shed", "", { x: x - 300, y: y - 300, w: 600, h: 600 }, 6, 128);
    if (bi >= 0) placed++;
  }
}

// ───────────────────────── Millbrook: a small town on the crossroads (map v2)

/** Town front-row archetypes: every quadrant draws its row from these. */
const TOWN_FRONT: ReadonlyArray<readonly [BuildingArch, number]> = [
  ["shop", 3], ["office", 2], ["diner", 1.5], ["clinic", 1.2], ["garage", 1.2], ["houseM", 1],
];

/**
 * A row of buildings along a street: doors face the street (`front`), alleys of 160–256 px between
 * them. `dir` +1 walks away from the crossroads to the right/down, −1 to the left/up. The first
 * archetypes in `first` are used before random picks, so every town gets its diner and clinic.
 */
function streetRow(
  ctx: GenCtx, rng: Rng, z: Zone, area: Rect, front: MapSide, dir: 1 | -1, first: BuildingArch[],
): number {
  const horizStreet = front === 0 || front === 2;
  const span = horizStreet ? area.w : area.h;
  let cur = 0, n = 0;
  for (let k = 0; k < 6 && cur < span; k++) {
    const arch = first[k] ?? pickW(rng, TOWN_FRONT);
    const a = ARCH[arch];
    // Street-facing size: the long side along the street.
    const along = Math.min(rs(rng, a.w[0], a.w[1], 32), 960);
    const depth = Math.min(rs(rng, a.h[0], a.h[1], 32), horizStreet ? area.h : area.w);
    if (cur + along > span) break;
    const at = dir > 0 ? (horizStreet ? area.x : area.y) + cur : (horizStreet ? area.x + area.w : area.y + area.h) - cur - along;
    const floor: Rect = horizStreet
      ? { x: at, y: front === 0 ? area.y : area.y + area.h - depth, w: along, h: depth }
      : { x: front === 3 ? area.x : area.x + area.w - depth, y: at, w: depth, h: along };
    const bi = ctx.building(rng, arch, z.id, floor, { door: front, margin: 32 });
    if (bi >= 0) n++;
    cur += along + ri(rng, 160, 256);
  }
  return n;
}

function millbrook(ctx: GenCtx): void {
  const z = ctx.zone("millbrook");
  const rng = ctx.rng("poi:millbrook");
  const hw = ctx.road("highway").pts, ns = ctx.road("ns").pts;
  const X = Math.round(polyXAtY(ns, z.rect.y + z.rect.h / 2));
  const Y = Math.round(polyYAtX(hw, X));
  const t = ctx.terrain;
  // Sidewalks: concrete along both streets inside the town (never over a road cell).
  const pave = (pts: readonly number[], half: number) =>
    t.paintPolyline(pts, half, (old, i) => {
      if (t.roadMask[i] !== ROAD_MASK.NONE || (old & TERRAIN_INDOOR) !== 0) return old;
      const cx = ((i % t.cols) + 0.5) * t.cell, cy = (Math.floor(i / t.cols) + 0.5) * t.cell;
      return inRect(z.rect, cx, cy) ? TERRAIN.CONCRETE : old;
    });
  pave(hw, 128 + 128);
  pave(ns, 80 + 128);
  // Quadrants around the crossroads (street + sidewalk + setback kept clear).
  const gapH = 128 + 160, gapV = 80 + 160;
  const L = z.rect.x + 96, R = z.rect.x + z.rect.w - 96, T = z.rect.y + 96, B = z.rect.y + z.rect.h - 96;
  const nw: Rect = { x: L, y: T, w: X - gapV - L, h: Y - gapH - T };
  const ne: Rect = { x: X + gapV, y: T, w: R - X - gapV, h: Y - gapH - T };
  const sw: Rect = { x: L, y: Y + gapH, w: X - gapV - L, h: B - Y - gapH };
  const se: Rect = { x: X + gapV, y: Y + gapH, w: R - X - gapV, h: B - Y - gapH };
  // Front rows on the highway (main street); the ns street gets the corner buildings' side doors.
  const firsts: BuildingArch[][] = shuffle(rng, [["diner"], ["clinic"], ["shop"], ["garage"]]);
  streetRow(ctx, rng, z, nw, 2, -1, firsts[0]!);
  streetRow(ctx, rng, z, ne, 2, 1, firsts[1]!);
  streetRow(ctx, rng, z, sw, 0, -1, firsts[2]!);
  streetRow(ctx, rng, z, se, 0, 1, firsts[3]!);
  // Back lots: houses behind the shops, wooden yard fences, sheds.
  for (const q of [nw, ne, sw, se]) {
    for (let i = 0; i < 2; i++) ctx.scatterBuilding(rng, chance(rng, 0.5) ? "houseM" : "houseS", z.id, q, 30, 64);
    if (chance(rng, 0.5)) ctx.scatterBuilding(rng, "shed", z.id, q, 20, 64);
    clutter(ctx, rng, q, { crates: 2, barrels: 2, decals: 3, decal: "dirt" });
    scatter(rng, q, 2, (x, y) => tree(ctx, x, y, ri(rng, 26, 34), 56), 6);
    scatter(rng, q, 2, (x, y) => bush(ctx, x, y, ri(rng, 48, 64)), 6);
    scatter(rng, q, 1, (x, y) => groundDecal(ctx, x, y, ri(rng, 48, 72), pick(rng, ["bricks", "planks", "papers"] as const)), 6);
  }
  // Parked cars along the curbs (off the centre lane), lamp posts, a notice board on the corner.
  for (let k = 0; k < 6; k++) {
    const x = z.rect.x + 256 + Math.floor(rng() * (z.rect.w - 512));
    if (Math.abs(x - X) < 360) continue;
    const curb = (chance(rng, 0.5) ? -1 : 1) * (128 - 64);
    car(ctx, x, Math.round(polyYAtX(hw, x)) + curb, false, true, 48);
  }
  streetLamps(ctx, hw, 256, z.rect, 520);
  streetLamps(ctx, ns, 160, z.rect, 520);
  decor(ctx, X + gapV - 64, Y - gapH + 64, "board", 0);
  outdoorContainers(ctx, rng, grow(z.rect, -128), 3, z.tier, z.id);
}

// ───────────────────────── Pump Station: fenced water works (map v2)

function pumpworks(ctx: GenCtx): void {
  const z = ctx.zone("pumpworks");
  const rng = ctx.rng("poi:pumpworks");
  const area = inner(z, 176);
  ctx.scatterBuilding(rng, "warehouse", z.id, area, 60);
  ctx.scatterBuilding(rng, "office", z.id, area, 40);
  ctx.scatterBuilding(rng, "garage", z.id, area, 40);
  // Water tanks (big ALL circles drawn as silos) with lanes between them.
  let tanks = 0;
  for (let t = 0; t < 60 && tanks < 3; t++) {
    const [x, y] = pointIn(rng, grow(area, -160));
    if (!ctx.free({ x: x - 150, y: y - 150, w: 300, h: 300 }, 72)) continue;
    ctx.circle(x, y, 140, ALL, "silo", 150);
    tanks++;
  }
  scatter(rng, area, 2, (x, y) => shipContainer(ctx, x, y, chance(rng, 0.5), 96));
  clutter(ctx, rng, area, { crates: 4, barrels: 5, decals: 6, decal: "oil" });
  outdoorContainers(ctx, rng, area, 4, z.tier, z.id);
  // Corrugated perimeter 32 px inside the zone; the service road makes its own gate, plus a back gap.
  const { x, y, w, h } = z.rect;
  const m = 32, style = FENCE_STYLE[z.kind];
  fenceLine(ctx, x + m, y + m, x + w - m, y + m, [], style);
  fenceLine(ctx, x + m, y + h - m, x + w - m, y + h - m, [[Math.floor(w / 2) - 120, 240]], style);
  fenceLine(ctx, x + m, y + m + 40, x + m, y + h - m - 40, [[Math.floor(h / 2) - 120, 240]], style);
  fenceLine(ctx, x + w - m, y + m + 40, x + w - m, y + h - m - 40, [], style);
  streetLamps(ctx, ctx.road("pump").pts, 160, z.rect, 600);
  ctx.ambient.push({ x: Math.round(x + w / 2), y: Math.round(y + h / 2), r: 900, k: "generator" });
}

// ───────────────────────── Ranger Station (map v2)

function ranger(ctx: GenCtx): void {
  const z = ctx.zone("ranger");
  const rng = ctx.rng("poi:ranger");
  const area = inner(z, 144);
  ctx.scatterBuilding(rng, "houseS", z.id, area, 40);
  ctx.scatterBuilding(rng, "shed", z.id, area, 40);
  for (let t = 0; t < 30; t++) {
    const [tx, ty] = pointIn(rng, area);
    if (!ctx.free({ x: tx, y: ty, w: 128, h: 128 }, 48)) continue;
    ctx.rect(tx, ty, 128, 128, ALL, "watchtower");
    break;
  }
  scatter(rng, area, 4, (x, y) => logpile(ctx, x, y, chance(rng, 0.5), 56));
  clutter(ctx, rng, area, { crates: 2, barrels: 1, decals: 3, decal: "dirt" });
  scatter(rng, area, 1, (x, y) => decor(ctx, x, y, "board", 0), 10);
  outdoorContainers(ctx, rng, area, 3, z.tier, z.id);
}

// ───────────────────────── Relay Hill: small walled T3 post (map v2)

function relay(ctx: GenCtx): void {
  const z = ctx.zone("relay");
  const rng = ctx.rng("poi:relay");
  const { x: zx, y: zy, w: zw, h: zh } = z.rect;
  const T = 48, G = 256;
  const westGate = Math.round(polyYAtX(ctx.road("relay").pts, zx)) - G / 2;
  const southGate = zx + Math.floor(zw * 0.6);
  const wall = (x: number, y: number, w: number, h: number) => {
    if (w > 0 && h > 0) ctx.rect(x, y, w, h, ALL, "concrete_wall", w >= h ? 0 : 1);
  };
  wall(zx, zy, zw, T);
  wall(zx, zy + zh - T, southGate - zx, T);
  wall(southGate + G, zy + zh - T, zx + zw - southGate - G, T);
  wall(zx, zy + T, T, westGate - zy - T);
  wall(zx, westGate + G, T, zy + zh - T - westGate - G);
  wall(zx + zw - T, zy + T, T, zh - 2 * T);
  for (const [tx, ty] of [[zx + zw - 240, zy + 112], [zx + 112, zy + zh - 240]] as const) {
    if (ctx.free({ x: tx, y: ty, w: 128, h: 128 }, 0)) ctx.rect(tx, ty, 128, 128, ALL, "watchtower");
  }
  const area = inner(z, 192);
  const north: Rect = { x: area.x, y: area.y, w: area.w, h: Math.floor(area.h * 0.55) };
  ctx.scatterBuilding(rng, "office", z.id, north, 60, 64);
  const south: Rect = { x: area.x, y: area.y + Math.floor(area.h * 0.45), w: area.w, h: Math.ceil(area.h * 0.55) };
  ctx.scatterBuilding(rng, "bunker", z.id, south, 60, 64);
  ctx.scatterBuilding(rng, "shed", z.id, area, 40, 64);
  // Relay mast (round base) in a sandbag ring.
  for (let t = 0; t < 40; t++) {
    const [mx, my] = pointIn(rng, grow(area, -200));
    if (!ctx.free({ x: mx - 300, y: my - 300, w: 600, h: 600 }, 0)) continue;
    ctx.circle(mx, my, 96, ALL, "silo", 104);
    sandbags(ctx, mx - 96, my - 260, false, 0);
    sandbags(ctx, mx - 96, my + 212, false, 0);
    sandbags(ctx, mx + 212, my - 96, true, 0);
    break;
  }
  scatter(rng, area, 4, (x, y) => sandbags(ctx, x, y, chance(rng, 0.5), 72));
  clutter(ctx, rng, area, { crates: 4, barrels: 3, decals: 4, decal: "debris", military: true });
  outdoorContainers(ctx, rng, area, 2, z.tier, z.id);
  ctx.ambient.push({ x: Math.round(zx + zw / 2), y: Math.round(zy + zh / 2), r: 800, k: "generator" });
}

// ───────────────────────── Truck Stop (map v2)

function truckstop(ctx: GenCtx): void {
  const z = ctx.zone("truckstop");
  const rng = ctx.rng("poi:truckstop");
  const hw = ctx.road("highway").pts;
  const roadY = Math.round(polyYAtX(hw, z.rect.x + z.rect.w / 2));
  const area = inner(z, 128);
  const north: Rect = { x: area.x, y: area.y, w: area.w, h: roadY - 200 - area.y };
  const south: Rect = { x: area.x, y: roadY + 200, w: area.w, h: area.y + area.h - roadY - 200 };
  ctx.scatterBuilding(rng, "diner", z.id, north, 50, 64);
  ctx.scatterBuilding(rng, "garage", z.id, south, 50, 64);
  // Pump islands on the forecourt, trucks and a trailer on the lot.
  for (let i = 0; i < 2; i++) {
    for (let t = 0; t < 30; t++) {
      const [x, y] = pointIn(rng, south);
      if (!ctx.free({ x: x - 40, y: y - 120, w: 80, h: 240 }, 48)) continue;
      barrel(ctx, x, y - 64, 0);
      barrel(ctx, x, y + 64, 0);
      break;
    }
  }
  scatter(rng, south, 2, (x, y) => car(ctx, x, y, chance(rng, 0.5), false, 56, 2));
  scatter(rng, north, 1, (x, y) => shipContainer(ctx, x, y, false, 96));
  clutter(ctx, rng, area, { crates: 2, barrels: 2, decals: 5, decal: "oil" });
  streetLamps(ctx, hw, 256, z.rect, 480);
  outdoorContainers(ctx, rng, area, 3, z.tier, z.id);
}

// ───────────────────────── sign posts where roads enter a place (map v2 decor)

function zoneSigns(ctx: GenCtx): void {
  for (const z of ctx.zones) {
    let placed = 0;
    for (const road of ctx.roads) {
      if (road.kind === "rail" || placed >= 3) continue;
      const p = road.pts;
      for (let i = 0; i + 3 < p.length && placed < 3; i += 2) {
        const ax = p[i]!, ay = p[i + 1]!, bx = p[i + 2]!, by = p[i + 3]!;
        const ina = inRect(z.rect, ax, ay), inb = inRect(z.rect, bx, by);
        if (ina === inb) continue;
        // Walk from the outside end toward the zone until the border, then step back 200 px.
        const dx = bx - ax, dy = by - ay;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len === 0) continue;
        const ux = (ina ? -dx : dx) / len, uy = (ina ? -dy : dy) / len;
        let ox = ina ? bx : ax, oy = ina ? by : ay;
        for (let s = 0; s < len && !inRect(z.rect, ox + ux * 32, oy + uy * 32); s += 32) {
          ox += ux * 32;
          oy += uy * 32;
        }
        const off = road.width / 2 + 56;
        const sx = ox - ux * 200 - uy * off, sy = oy - uy * 200 + ux * off;
        if (decor(ctx, sx, sy, "sign", quarterToward(-uy, ux))) placed++;
      }
    }
  }
}
