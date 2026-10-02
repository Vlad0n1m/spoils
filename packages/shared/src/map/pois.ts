/**
 * POI layouts (map memo §3, §4.5). Village, industrial and military are templated lots (random
 * scatter inside POIs looked noisy in the prototype); rail and quarry are mostly scatter
 * (critique: lot templates time-boxed). Each POI draws from its own rng stream.
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
  barrel,
  car,
  clutter,
  crate,
  fenceLine,
  logpile,
  outdoorContainers,
  pointIn,
  rock,
  sandbags,
  scatter,
  shipContainer,
  tree,
  bush,
} from "./props.js";
import { TERRAIN, type BuildingArch, type MapSide, type Zone } from "./types.js";
import { chance, grow, pickW, polyXAtY, polyYAtX, ri, rs } from "./util.js";

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
  hunterCabins(ctx);
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
    fenceLine(ctx, fx, lot.y + 24, fx, lot.y + lot.h - 24, [[gate, 192]]);
    // North side fence with a back gap (never a closed ring). It stops 40 px short of the front
    // fence: touching panels would fail each other's placement check.
    const x0 = front === 1 ? lot.x + 24 : lot.x + 64;
    const x1 = front === 1 ? lot.x + lot.w - 64 : lot.x + lot.w - 24;
    const gapAt = front === 1 ? 24 : x1 - x0 - 24 - 176;
    fenceLine(ctx, x0, lot.y + 24, x1, lot.y + 24, [[gapAt, 176]]);
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
    fenceLine(ctx, x, y, x + w, y, [[Math.floor(w / 2) - 96, 192]]);
    fenceLine(ctx, x, y + 40, x, y + h, []);
    fenceLine(ctx, x + w, y + 40, x + w, y + h, [[Math.floor(h / 2) - 80, 160]]);
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
        outdoorContainers(ctx, rng, pin, 7, z.tier, z.id);
      }
    }
  }
  clutter(ctx, rng, inner(z, 128), { crates: 4, barrels: 4, decals: 10, decal: "oil" });
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
  clutter(ctx, rng, area, { crates: 10, barrels: 6, decals: 8, decal: "debris" });
  outdoorContainers(ctx, rng, area, 8, z.tier, z.id);
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
  for (let t = 0; t < 400 && placed < 4; t++) {
    const [x, y] = pointIn(rng, area);
    if (ctx.terrain.kindAt(x, y) !== TERRAIN.FOREST) continue;
    if (ctx.zones.some((zz) => x > zz.rect.x - 900 && x < zz.rect.x + zz.rect.w + 900 && y > zz.rect.y - 900 && y < zz.rect.y + zz.rect.h + 900)) continue;
    // Spread the cabins: one per map quadrant.
    const q = (x < ctx.width / 2 ? 0 : 1) + (y < ctx.height / 2 ? 0 : 2);
    if (ctx.buildings.some((b) => b.zone === "" && ((b.floor.x < ctx.width / 2 ? 0 : 1) + (b.floor.y < ctx.height / 2 ? 0 : 2)) === q)) continue;
    const bi = ctx.scatterBuilding(rng, "shed", "", { x: x - 300, y: y - 300, w: 600, h: 600 }, 6, 128);
    if (bi >= 0) placed++;
  }
}
