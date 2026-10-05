/**
 * Cartographic map art (full map v2, minimap): one smooth, map-styled picture of a MapData, painted
 * once per map into a 2048² canvas and shared by reference count between the full map (fullmap.ts)
 * and the minimap (minimap.ts). The realistic ground overview (minimap.ts paintOverview) stays the
 * ground-chunk fallback; this one is drawn for reading, not for matching the ground sprites.
 *
 *  - Terrain as smooth colour regions: per ground class (field, forest, sand, paved, water) a
 *    blurred cell mask is sampled bilinearly and cut with a smoothstep, so region edges follow soft
 *    contours instead of 64 px cell stairs (rasterTerrain: pure, node-testable). Forest and water
 *    get a darker contour line, the whole sheet a faint paper grain.
 *  - On top, vectors at full resolution: tree crowns as stipple, the river as a smooth band with
 *    banks, roads as rounded strokes with a casing (dirt roads lighter, rails with ties), buildings
 *    as clean blocks with a drop shadow and an outline, walls / containers / silos, a 2 km grid.
 */

import { CanvasSource, Texture } from "pixi.js";
import { TERRAIN, TERRAIN_KIND_MASK, type MapData } from "@extract/shared";
import { groundKinds } from "./terrain-tiles";

/** Map art canvas side (px, a power of two so the texture can carry mipmaps). */
export const MAP_ART_PX = 2048;
/** Terrain raster side (px); upscaled smoothly into the art canvas (soft region edges). */
export const MAP_TERRAIN_PX = 1024;
/** Grid square of the full map (world px): the 2 km fight-heat cells read as map squares too. */
export const MAP_GRID_PX = 2048;

/** Ground classes of the map art, in paint order (field is the base). */
export const GROUND_CLASS = { FIELD: 0, SAND: 1, PAVED: 2, FOREST: 3, WATER: 4 } as const;
export type GroundClass = (typeof GROUND_CLASS)[keyof typeof GROUND_CLASS];

/** Muted, map-like palette: bright markers and tier chips stay the loudest things on the sheet. */
export const MAP_PALETTE = {
  field: 0x7f8c5b,
  sand: 0xa8956b,
  paved: 0x8e8b82,
  forest: 0x4a6a3d,
  forestEdge: 0x2f4527,
  water: 0x3f7fa8,
  waterEdge: 0x29587a,
  bank: 0x9b8a62,
  treeDot: 0x34502c,
  rock: 0x9a978d,
  roadCasing: 0x2a2925,
  road: 0xddd3b6,
  dirtCasing: 0x5e4c34,
  dirt: 0xbea275,
  rail: 0x2c2a27,
  railTie: 0xc9c1ad,
  building: 0x34363a,
  buildingEdge: 0x15161a,
  buildingRoof: 0x4a4d52,
  wall: 0xc4bdaf,
  grid: 0xffffff,
  frame: 0x0e1210,
} as const;

/** Ground class of a terrain kind (INDOOR already stripped). */
export function groundClass(kind: number): GroundClass {
  switch (kind & TERRAIN_KIND_MASK) {
    case TERRAIN.FOREST:
      return GROUND_CLASS.FOREST;
    case TERRAIN.DIRT:
    case TERRAIN.GRAVEL:
      return GROUND_CLASS.SAND;
    case TERRAIN.ASPHALT:
    case TERRAIN.CONCRETE:
    case TERRAIN.WOOD:
    case TERRAIN.BRIDGE:
      return GROUND_CLASS.PAVED;
    case TERRAIN.WATER:
    case TERRAIN.SHALLOW:
      return GROUND_CLASS.WATER;
    default:
      return GROUND_CLASS.FIELD;
  }
}

/** 3-tap box blur along rows then columns, `passes` times (≈ a small gaussian), edge-clamped. `src` is left untouched. */
export function blurMask(src: Float32Array, cols: number, rows: number, passes = 2): Float32Array {
  const a = new Float32Array(src);
  const b = new Float32Array(src.length);
  for (let p = 0; p < passes; p++) {
    for (let r = 0; r < rows; r++) {
      const o = r * cols;
      for (let c = 0; c < cols; c++) {
        b[o + c] = (a[o + (c > 0 ? c - 1 : c)]! + a[o + c]! + a[o + (c < cols - 1 ? c + 1 : c)]!) / 3;
      }
    }
    for (let r = 0; r < rows; r++) {
      const up = (r > 0 ? r - 1 : r) * cols;
      const o = r * cols;
      const dn = (r < rows - 1 ? r + 1 : r) * cols;
      for (let c = 0; c < cols; c++) a[o + c] = (b[up + c]! + b[o + c]! + b[dn + c]!) / 3;
    }
  }
  return a;
}

/** Per-class smoothed masks at terrain-cell resolution (index = GroundClass). */
export function classMasks(kinds: Uint8Array, cols: number, rows: number, passes = 2): Float32Array[] {
  const masks: Float32Array[] = [];
  for (let k = 0; k <= GROUND_CLASS.WATER; k++) masks.push(new Float32Array(cols * rows));
  for (let i = 0; i < kinds.length; i++) masks[groundClass(kinds[i]!)]![i] = 1;
  return masks.map((m) => blurMask(m, cols, rows, passes));
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = x <= e0 ? 0 : x >= e1 ? 1 : (x - e0) / (e1 - e0);
  return t * t * (3 - 2 * t);
}

/** Cheap deterministic per-pixel hash in [0, 1) (paper grain). */
function grain(x: number, y: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

type TerrainSource = Pick<MapData, "width" | "height" | "terrainCols" | "terrainRows" | "terrainCell">;

/**
 * The terrain layer as RGBA (size² px): field base, then sand, paved, forest and water regions with
 * smooth contours (cell masks blurred, sampled bilinearly, cut at 0.5 with a ~half-cell smoothstep),
 * a darker contour band on forest and water, and ±2 % paper grain. Pure: `kinds` is
 * terrain-tiles groundKinds(map) (INDOOR cells already take the outdoor kind around them).
 */
export function rasterTerrain(map: TerrainSource, kinds: Uint8Array, size = MAP_TERRAIN_PX): Uint8ClampedArray {
  const { terrainCols: cols, terrainRows: rows, terrainCell: cell } = map;
  const masks = classMasks(kinds, cols, rows);
  const out = new Uint8ClampedArray(size * size * 4);
  const rgb = (c: number) => [(c >> 16) & 255, (c >> 8) & 255, c & 255] as const;
  const order: Array<{ cls: GroundClass; col: readonly number[]; edge: readonly number[] | null }> = [
    { cls: GROUND_CLASS.SAND, col: rgb(MAP_PALETTE.sand), edge: null },
    { cls: GROUND_CLASS.PAVED, col: rgb(MAP_PALETTE.paved), edge: null },
    { cls: GROUND_CLASS.FOREST, col: rgb(MAP_PALETTE.forest), edge: rgb(MAP_PALETTE.forestEdge) },
    { cls: GROUND_CLASS.WATER, col: rgb(MAP_PALETTE.water), edge: rgb(MAP_PALETTE.waterEdge) },
  ];
  const field = rgb(MAP_PALETTE.field);
  // Column / row sample positions (cell-centre space) computed once.
  const sx = map.width / size / cell;
  const sy = map.height / size / cell;
  const c0 = new Int32Array(size), c1 = new Int32Array(size), tx = new Float32Array(size);
  for (let x = 0; x < size; x++) {
    const f = Math.max(0, Math.min(cols - 1, (x + 0.5) * sx - 0.5));
    c0[x] = Math.floor(f);
    c1[x] = Math.min(cols - 1, c0[x]! + 1);
    tx[x] = f - c0[x]!;
  }
  for (let y = 0; y < size; y++) {
    const f = Math.max(0, Math.min(rows - 1, (y + 0.5) * sy - 0.5));
    const r0 = Math.floor(f);
    const r1 = Math.min(rows - 1, r0 + 1);
    const ty = f - r0;
    const o0 = r0 * cols, o1 = r1 * cols;
    for (let x = 0; x < size; x++) {
      let r = field[0]!, g = field[1]!, b = field[2]!;
      const a0 = o0 + c0[x]!, a1 = o0 + c1[x]!, b0 = o1 + c0[x]!, b1 = o1 + c1[x]!;
      const fx = tx[x]!;
      for (const L of order) {
        const m = masks[L.cls]!;
        const v00 = m[a0]!, v01 = m[a1]!, v10 = m[b0]!, v11 = m[b1]!;
        if (v00 + v01 + v10 + v11 === 0) continue;
        const v = (v00 * (1 - fx) + v01 * fx) * (1 - ty) + (v10 * (1 - fx) + v11 * fx) * ty;
        const a = smoothstep(0.38, 0.62, v);
        if (a <= 0) continue;
        let cr = L.col[0]!, cg = L.col[1]!, cb = L.col[2]!;
        if (L.edge) {
          // Contour: strongest right inside the edge, fading to the region colour further in.
          const e = Math.max(0, 1 - Math.abs(v - 0.62) / 0.16) * 0.75;
          cr += (L.edge[0]! - cr) * e;
          cg += (L.edge[1]! - cg) * e;
          cb += (L.edge[2]! - cb) * e;
        }
        r += (cr - r) * a;
        g += (cg - g) * a;
        b += (cb - b) * a;
      }
      const n = 0.98 + 0.04 * grain(x, y);
      const i = (y * size + x) * 4;
      out[i] = r * n;
      out[i + 1] = g * n;
      out[i + 2] = b * n;
      out[i + 3] = 255;
    }
  }
  return out;
}

function css(c: number, a = 1): string {
  return `rgba(${(c >> 16) & 255},${(c >> 8) & 255},${c & 255},${a})`;
}

/** Smooth path through a flat polyline: straight ends, quadratic curves through segment midpoints. */
function smoothPath(g: CanvasRenderingContext2D, pts: readonly number[]): void {
  const n = pts.length / 2;
  g.beginPath();
  g.moveTo(pts[0]!, pts[1]!);
  if (n === 2) {
    g.lineTo(pts[2]!, pts[3]!);
    return;
  }
  for (let i = 1; i < n - 1; i++) {
    const x = pts[i * 2]!, y = pts[i * 2 + 1]!;
    const nx = pts[i * 2 + 2]!, ny = pts[i * 2 + 3]!;
    g.quadraticCurveTo(x, y, i === n - 2 ? nx : (x + nx) / 2, i === n - 2 ? ny : (y + ny) / 2);
  }
}

function polyPath(g: CanvasRenderingContext2D, pts: readonly number[]): void {
  g.beginPath();
  g.moveTo(pts[0]!, pts[1]!);
  for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i]!, pts[i + 1]!);
}

/** River half width / bank (map/steppe.ts RIVER_HALF_WIDTH, RIVER_BANK; not exported by the package index). */
const RIVER_HALF = 210;
const RIVER_BANK = 96;

/** Paints the map art (terrain raster + vectors) into a fresh canvas. ~60–120 ms once per map. */
export function paintMapArt(map: MapData, size = MAP_ART_PX): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const tpx = Math.min(MAP_TERRAIN_PX, size);
  const raster = document.createElement("canvas");
  raster.width = raster.height = tpx;
  const rg = raster.getContext("2d")!;
  const img = rg.createImageData(tpx, tpx);
  img.data.set(rasterTerrain(map, groundKinds(map), tpx));
  rg.putImageData(img, 0, 0);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(raster, 0, 0, size, size);

  const kx = size / map.width;
  const ky = size / map.height;
  const px = 1 / kx; // one art pixel in world px
  g.save();
  g.scale(kx, ky);
  g.lineJoin = "round";
  g.lineCap = "round";

  // Tree crowns as stipple (forest texture from the real trees), rocks as pale specks.
  g.fillStyle = css(MAP_PALETTE.treeDot, 0.55);
  for (const s of map.circles) {
    if (s.k !== "tree") continue;
    g.beginPath();
    g.arc(s.x, s.y, Math.max(1.4 * px, s.r * 1.6), 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = css(MAP_PALETTE.rock, 0.8);
  for (const s of map.circles) {
    if (s.k !== "rock") continue;
    g.beginPath();
    g.arc(s.x, s.y, Math.max(1.2 * px, s.r), 0, Math.PI * 2);
    g.fill();
  }

  // River: bank, water, a faint current line.
  if (map.river.length >= 4) {
    smoothPath(g, map.river);
    g.lineWidth = (RIVER_HALF + RIVER_BANK) * 2;
    g.strokeStyle = css(MAP_PALETTE.bank, 0.85);
    g.stroke();
    g.lineWidth = RIVER_HALF * 2 + 3 * px;
    g.strokeStyle = css(MAP_PALETTE.waterEdge);
    g.stroke();
    g.lineWidth = RIVER_HALF * 2 - 3 * px;
    g.strokeStyle = css(MAP_PALETTE.water);
    g.stroke();
    g.lineWidth = RIVER_HALF * 0.35;
    g.strokeStyle = css(0xffffff, 0.12);
    g.stroke();
  }

  // Roads: casings first (so crossings merge), then fills; rails on top with ties.
  const casing = 2.2 * px;
  for (const road of map.roads) {
    if (road.pts.length < 4 || road.kind === "rail") continue;
    polyPath(g, road.pts);
    g.lineWidth = road.width * (road.kind === "asphalt" ? 1 : 0.8) + casing * 2;
    g.strokeStyle = road.kind === "asphalt" ? css(MAP_PALETTE.roadCasing, 0.9) : css(MAP_PALETTE.dirtCasing, 0.55);
    g.stroke();
  }
  for (const road of map.roads) {
    if (road.pts.length < 4 || road.kind === "rail") continue;
    polyPath(g, road.pts);
    g.lineWidth = road.width * (road.kind === "asphalt" ? 1 : 0.8);
    g.strokeStyle = road.kind === "asphalt" ? css(MAP_PALETTE.road) : css(MAP_PALETTE.dirt);
    g.stroke();
    if (road.kind === "asphalt") {
      g.lineWidth = 1.2 * px;
      g.strokeStyle = css(0xf5c542, 0.7);
      g.setLineDash([10 * px, 8 * px]);
      g.stroke();
      g.setLineDash([]);
    }
  }
  for (const road of map.roads) {
    if (road.pts.length < 4 || road.kind !== "rail") continue;
    polyPath(g, road.pts);
    g.lineWidth = Math.max(4 * px, 56);
    g.strokeStyle = css(MAP_PALETTE.rail);
    g.stroke();
    g.lineWidth = Math.max(2 * px, 24);
    g.strokeStyle = css(MAP_PALETTE.railTie, 0.9);
    g.setLineDash([7 * px, 6 * px]);
    g.lineCap = "butt";
    g.stroke();
    g.setLineDash([]);
    g.lineCap = "round";
  }

  // Low structures: concrete walls, containers, wagons, silos.
  g.fillStyle = css(MAP_PALETTE.wall);
  for (const r of map.rects) {
    if (r.k === "concrete_wall" || r.k === "ship_container" || r.k === "wagon") g.fillRect(r.x, r.y, r.w, r.h);
  }
  for (const s of map.circles) {
    if (s.k !== "silo") continue;
    g.beginPath();
    g.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    g.fill();
    g.lineWidth = 1.5 * px;
    g.strokeStyle = css(MAP_PALETTE.buildingEdge, 0.8);
    g.stroke();
  }

  // Buildings: shadow, block, roof ridge highlight, crisp outline.
  const sh = 3 * px;
  g.fillStyle = css(0x000000, 0.28);
  for (const b of map.buildings) g.fillRect(b.floor.x + sh, b.floor.y + sh, b.floor.w, b.floor.h);
  for (const b of map.buildings) {
    const f = b.floor;
    g.fillStyle = css(MAP_PALETTE.building);
    g.fillRect(f.x, f.y, f.w, f.h);
    // Roof: a lighter inner panel reads as a top-down roof.
    const inset = Math.min(f.w, f.h) * 0.18;
    g.fillStyle = css(MAP_PALETTE.buildingRoof);
    g.fillRect(f.x + inset, f.y + inset, f.w - inset * 2, f.h - inset * 2);
    g.lineWidth = 1.6 * px;
    g.strokeStyle = css(MAP_PALETTE.buildingEdge);
    g.strokeRect(f.x, f.y, f.w, f.h);
  }

  // Map grid (2 km squares) on top of everything, very faint.
  g.lineWidth = 1.2 * px;
  g.strokeStyle = css(MAP_PALETTE.grid, 0.13);
  g.beginPath();
  for (let x = MAP_GRID_PX; x < map.width; x += MAP_GRID_PX) {
    g.moveTo(x, 0);
    g.lineTo(x, map.height);
  }
  for (let y = MAP_GRID_PX; y < map.height; y += MAP_GRID_PX) {
    g.moveTo(0, y);
    g.lineTo(map.width, y);
  }
  g.stroke();
  g.restore();
  return c;
}

interface ArtEntry {
  texture: Texture;
  refs: number;
}
const arts = new WeakMap<MapData, ArtEntry>();

/**
 * Shared map art texture (linear, mipmapped: crisp at any zoom of the full map and the minimap);
 * call releaseMapArt(map) once per acquire. Destroyed when the last user releases it.
 */
export function acquireMapArt(map: MapData): Texture {
  let e = arts.get(map);
  if (!e || e.texture.destroyed) {
    const source = new CanvasSource({ resource: paintMapArt(map), scaleMode: "linear", autoGenerateMipmaps: true });
    e = { texture: new Texture({ source }), refs: 0 };
    arts.set(map, e);
  }
  e.refs++;
  return e.texture;
}

export function releaseMapArt(map: MapData): void {
  const e = arts.get(map);
  if (!e) return;
  e.refs--;
  if (e.refs <= 0) {
    e.texture.destroy(true);
    arts.delete(map);
  }
}
