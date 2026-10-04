import { BOSSES, TERRAIN, TERRAIN_KIND_MASK, TREE_CANOPY_MULT, type MapData, type PropKind, type Terrain, type ZoneKind } from "@extract/shared";
import type { View } from "./replay-view";

/**
 * Static map of the admin replay viewer, drawn from the same shared generator the game uses
 * (generateMap(mapId) of this build's MAP_GEN_VERSION; no Pixi): terrain, roads, building floors,
 * walls, props and trees are painted ONCE into an OVERVIEW_PX² offscreen canvas per MapData (cached),
 * which every frame draws with the camera transform. From DETAIL_SCALE up the walls, props and trees
 * in view are drawn again as vectors (a culling grid keeps that to the visible cells), so a close-up
 * stays sharp. Zones (POIs), extracts and containers are a live vector overlay with readable labels.
 */

export const OVERVIEW_PX = 2048;
/** Vector walls / props / trees from this camera scale (one overview texel ≈ 1.2 screen px) up. */
export const DETAIL_SCALE = 0.1;
/** Containers appear from this scale, their index labels from CONTAINER_LABEL_SCALE. */
export const CONTAINER_SCALE = 0.14;
export const CONTAINER_LABEL_SCALE = 0.45;

/** Terrain colours: the game's palette (game/terrain-tiles.ts TERRAIN_COLOR), a little darker so markers pop. */
const TERRAIN_RGB: Record<Terrain, [number, number, number]> = {
  [TERRAIN.GRASS]: [70, 112, 50],
  [TERRAIN.FOREST]: [38, 70, 36],
  [TERRAIN.DIRT]: [118, 92, 62],
  [TERRAIN.ASPHALT]: [64, 68, 77],
  [TERRAIN.CONCRETE]: [124, 124, 118],
  [TERRAIN.WOOD]: [104, 72, 44],
  [TERRAIN.WATER]: [40, 88, 134],
  [TERRAIN.BRIDGE]: [118, 86, 52],
  [TERRAIN.GRAVEL]: [112, 106, 96],
  [TERRAIN.SHALLOW]: [72, 126, 148],
};

const PROP_COLOR: Partial<Record<PropKind, string>> = {
  border: "#30342d",
  wall: "#d9b382",
  window: "#8fb7d6",
  concrete_wall: "#b7b9b3",
  fence: "#8c7c5c",
  crate: "#8a6a3a",
  ship_container: "#5f7489",
  shelf: "#6b5a44",
  wagon: "#7a5040",
  sandbags: "#a39470",
  car: "#56606e",
  logpile: "#7a5a36",
  watchtower: "#9a8a6a",
  silo: "#c9cbc4",
  // Map v2 furniture (MAP_GEN_VERSION 4): low cover in warm wood tones, the tall lockers darker.
  table: "#9b7650",
  desk: "#87664a",
  sofa: "#7d5a5a",
  armchair: "#7d5a5a",
  bed: "#8a8fa6",
  counter: "#a08566",
  lockers: "#5d6873",
};

const CIRCLE_COLOR = { rock: "#8d8d86", barrel: "#b4503c", silo: "#c9cbc4" } as const;
const CANOPY = "rgba(24, 52, 24, 0.55)";
const TRUNK = "#3b2a1a";
const FLOOR = "#3d4654";

/** Zone outline / label colour by loot tier (0 wilderness … 4 best). */
export const TIER_COLOR = ["#9aa3ad", "#b8c4a0", "#e3c45a", "#f0913a", "#ff5a5a"] as const;

export const ZONE_KIND_LABEL: Record<ZoneKind, string> = {
  village: "деревня",
  farm: "ферма",
  lumber: "лесопилка",
  industrial: "промзона",
  gas: "заправка",
  rail: "ж/д",
  military: "военная база",
  checkpoint: "блокпост",
  quarry: "карьер",
};

// ------------------------------------------------------------------------------- culling (pure)

/** Rect / circle indexes of the map bucketed by `cell` px squares (an item sits in every cell it touches). */
export interface CullGrid {
  cell: number;
  cols: number;
  rows: number;
  rects: number[][];
  circles: number[][];
}

/** Things the detail pass draws (water runs are terrain already; the border is drawn by the overview). */
const DETAIL_SKIP: ReadonlySet<PropKind> = new Set<PropKind>(["water", "border"]);

export function buildCullGrid(map: Pick<MapData, "width" | "height" | "rects" | "circles">, cell = 1024): CullGrid {
  const cols = Math.max(1, Math.ceil(map.width / cell));
  const rows = Math.max(1, Math.ceil(map.height / cell));
  const g: CullGrid = { cell, cols, rows, rects: Array.from({ length: cols * rows }, () => []), circles: Array.from({ length: cols * rows }, () => []) };
  const put = (list: number[][], i: number, x0: number, y0: number, x1: number, y1: number) => {
    const c0 = Math.max(0, Math.floor(x0 / cell));
    const c1 = Math.min(cols - 1, Math.floor(x1 / cell));
    const r0 = Math.max(0, Math.floor(y0 / cell));
    const r1 = Math.min(rows - 1, Math.floor(y1 / cell));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) list[r * cols + c]!.push(i);
  };
  map.rects.forEach((q, i) => {
    if (!DETAIL_SKIP.has(q.k)) put(g.rects, i, q.x, q.y, q.x + q.w, q.y + q.h);
  });
  map.circles.forEach((q, i) => {
    const r = q.k === "tree" ? q.r * TREE_CANOPY_MULT : q.r;
    put(g.circles, i, q.x - r, q.y - r, q.x + r, q.y + r);
  });
  return g;
}

/** Distinct rect / circle indexes in cells touching the box (ascending: the map's draw order). */
export function queryCull(g: CullGrid, x0: number, y0: number, x1: number, y1: number): { rects: number[]; circles: number[] } {
  const c0 = Math.max(0, Math.floor(x0 / g.cell));
  const c1 = Math.min(g.cols - 1, Math.floor(x1 / g.cell));
  const r0 = Math.max(0, Math.floor(y0 / g.cell));
  const r1 = Math.min(g.rows - 1, Math.floor(y1 / g.cell));
  const rects = new Set<number>();
  const circles = new Set<number>();
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      for (const i of g.rects[r * g.cols + c]!) rects.add(i);
      for (const i of g.circles[r * g.cols + c]!) circles.add(i);
    }
  }
  return { rects: [...rects].sort((a, b) => a - b), circles: [...circles].sort((a, b) => a - b) };
}

/** World box the canvas shows. */
export function viewBounds(v: View, w: number, h: number): { x0: number; y0: number; x1: number; y1: number } {
  const hw = w / 2 / v.scale;
  const hh = h / 2 / v.scale;
  return { x0: v.cx - hw, y0: v.cy - hh, x1: v.cx + hw, y1: v.cy + hh };
}

// ------------------------------------------------------------------------------- painting (DOM)

const overviews = new WeakMap<MapData, HTMLCanvasElement>();
const grids = new WeakMap<MapData, CullGrid>();

function cullGridOf(map: MapData): CullGrid {
  let g = grids.get(map);
  if (!g) {
    g = buildCullGrid(map);
    grids.set(map, g);
  }
  return g;
}

/** The cached overview bitmap of a map (painted on first use, ~20–60 ms). */
export function overviewOf(map: MapData): HTMLCanvasElement {
  let c = overviews.get(map);
  if (!c) {
    c = paintOverview(map, OVERVIEW_PX);
    overviews.set(map, c);
  }
  return c;
}

function paintOverview(map: MapData, size: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  g.fillStyle = "#1b2616";
  g.fillRect(0, 0, size, size);

  // Terrain: one pixel per terrain cell, smoothed up.
  const cells = document.createElement("canvas");
  cells.width = map.terrainCols;
  cells.height = map.terrainRows;
  const cg = cells.getContext("2d")!;
  const img = cg.createImageData(map.terrainCols, map.terrainRows);
  for (let i = 0; i < map.terrain.length; i++) {
    const rgb = TERRAIN_RGB[(map.terrain[i]! & TERRAIN_KIND_MASK) as Terrain] ?? TERRAIN_RGB[TERRAIN.GRASS];
    img.data[i * 4] = rgb[0];
    img.data[i * 4 + 1] = rgb[1];
    img.data[i * 4 + 2] = rgb[2];
    img.data[i * 4 + 3] = 255;
  }
  cg.putImageData(img, 0, 0);
  const k = size / Math.max(map.width, map.height);
  g.imageSmoothingEnabled = true;
  g.drawImage(cells, 0, 0, map.terrainCols * map.terrainCell * k, map.terrainRows * map.terrainCell * k);

  g.save();
  g.scale(k, k);
  g.lineJoin = "round";
  g.lineCap = "round";
  for (const road of map.roads) {
    if (road.pts.length < 4) continue;
    g.beginPath();
    g.moveTo(road.pts[0]!, road.pts[1]!);
    for (let i = 2; i < road.pts.length; i += 2) g.lineTo(road.pts[i]!, road.pts[i + 1]!);
    if (road.kind === "asphalt") {
      g.lineWidth = road.width;
      g.strokeStyle = "#3c4049";
      g.stroke();
    } else if (road.kind === "dirt") {
      g.lineWidth = road.width;
      g.strokeStyle = "rgba(122, 96, 64, 0.85)";
      g.stroke();
    } else {
      g.lineWidth = 40;
      g.strokeStyle = "#5c5248";
      g.stroke();
      g.lineWidth = 14;
      g.strokeStyle = "rgba(185, 188, 194, 0.8)";
      g.setLineDash([60, 50]);
      g.stroke();
      g.setLineDash([]);
    }
  }
  for (const s of map.circles) {
    if (s.k !== "tree") continue;
    g.fillStyle = CANOPY;
    g.beginPath();
    g.arc(s.x, s.y, s.r * TREE_CANOPY_MULT, 0, Math.PI * 2);
    g.fill();
  }
  for (const b of map.buildings) {
    g.fillStyle = FLOOR;
    g.fillRect(b.floor.x, b.floor.y, b.floor.w, b.floor.h);
  }
  for (const r of map.rects) {
    if (r.k === "water") continue;
    g.fillStyle = PROP_COLOR[r.k] ?? "#888";
    // Thin walls would vanish at 12 world px per texel: give them at least a texel.
    const minPx = 1 / k;
    g.fillRect(r.x, r.y, Math.max(r.w, minPx), Math.max(r.h, minPx));
  }
  for (const s of map.circles) {
    if (s.k === "tree") continue;
    g.fillStyle = CIRCLE_COLOR[s.k];
    g.beginPath();
    g.arc(s.x, s.y, Math.max(s.r, 1 / k), 0, Math.PI * 2);
    g.fill();
  }
  g.restore();
  return c;
}

/** Applies the camera to ctx so world coordinates can be drawn directly (callers save/restore). */
export function applyView(ctx: CanvasRenderingContext2D, v: View, w: number, h: number): void {
  ctx.translate(w / 2, h / 2);
  ctx.scale(v.scale, v.scale);
  ctx.translate(-v.cx, -v.cy);
}

/** Background, overview bitmap and (close up) vector detail of the static map. */
export function drawMapBase(ctx: CanvasRenderingContext2D, map: MapData, v: View, w: number, h: number): void {
  ctx.fillStyle = "#0d1117";
  ctx.fillRect(0, 0, w, h);
  const ov = overviewOf(map);
  const side = Math.max(map.width, map.height);
  ctx.save();
  applyView(ctx, v, w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(ov, 0, 0, side, side);
  if (v.scale >= DETAIL_SCALE) drawDetail(ctx, map, v, w, h);
  ctx.restore();
}

function drawDetail(ctx: CanvasRenderingContext2D, map: MapData, v: View, w: number, h: number): void {
  const vb = viewBounds(v, w, h);
  const { rects, circles } = queryCull(cullGridOf(map), vb.x0, vb.y0, vb.x1, vb.y1);
  // Canopies stay the overview's (soft is fine); floors, walls, props and trunks are redrawn sharp.
  for (const b of map.buildings) {
    const f = b.floor;
    if (f.x > vb.x1 || f.y > vb.y1 || f.x + f.w < vb.x0 || f.y + f.h < vb.y0) continue;
    ctx.fillStyle = FLOOR;
    ctx.fillRect(f.x, f.y, f.w, f.h);
  }
  for (const i of rects) {
    const r = map.rects[i]!;
    ctx.fillStyle = PROP_COLOR[r.k] ?? "#888";
    ctx.fillRect(r.x, r.y, r.w, r.h);
  }
  for (const i of circles) {
    const s = map.circles[i]!;
    ctx.fillStyle = s.k === "tree" ? TRUNK : CIRCLE_COLOR[s.k];
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Outlined label (readable on any ground). */
export function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, o: { size?: number; weight?: number; align?: CanvasTextAlign; base?: CanvasTextBaseline; alpha?: number } = {}): void {
  ctx.save();
  ctx.globalAlpha = o.alpha ?? 1;
  ctx.font = `${o.weight ?? 600} ${o.size ?? 12}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.textAlign = o.align ?? "center";
  ctx.textBaseline = o.base ?? "middle";
  ctx.lineJoin = "round";
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(8, 10, 14, 0.9)";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

/**
 * Zones (POI outlines by tier, name and kind; the boss's name on a boss zone), extracts (green rings
 * with id and name) and, close up, containers (with their index, as events name them).
 */
export function drawMapOverlay(ctx: CanvasRenderingContext2D, map: MapData, v: View, w: number, h: number): void {
  const sx = (x: number) => (x - v.cx) * v.scale + w / 2;
  const sy = (y: number) => (y - v.cy) * v.scale + h / 2;
  ctx.save();
  ctx.setLineDash([6, 5]);
  ctx.lineWidth = 1;
  for (const z of map.zones) {
    const c = TIER_COLOR[z.tier] ?? TIER_COLOR[0];
    ctx.strokeStyle = c;
    ctx.globalAlpha = 0.55;
    ctx.strokeRect(sx(z.rect.x), sy(z.rect.y), z.rect.w * v.scale, z.rect.h * v.scale);
  }
  ctx.restore();
  for (const z of map.zones) {
    const c = TIER_COLOR[z.tier] ?? TIER_COLOR[0];
    const x = sx(z.rect.x + z.rect.w / 2);
    const y = sy(z.rect.y) + 12;
    label(ctx, z.name, x, y, c, { size: 12, weight: 700, alpha: 0.95 });
    const sub = `${ZONE_KIND_LABEL[z.kind]} · T${z.tier}${z.boss ? ` · босс ${BOSSES[z.boss]?.name ?? z.boss}` : ""}`;
    if (v.scale >= 0.035) label(ctx, sub, x, y + 13, "rgba(255,255,255,0.6)", { size: 10, weight: 500 });
  }
  if (v.scale >= CONTAINER_SCALE) {
    const b = viewBounds(v, w, h);
    ctx.fillStyle = "rgba(214, 178, 74, 0.9)";
    const s = Math.max(3, 26 * v.scale);
    map.containers.forEach((c, i) => {
      if (c.x < b.x0 || c.x > b.x1 || c.y < b.y0 || c.y > b.y1) return;
      ctx.fillRect(sx(c.x) - s / 2, sy(c.y) - s / 2, s, s);
      if (v.scale >= CONTAINER_LABEL_SCALE) label(ctx, `#${i}`, sx(c.x), sy(c.y) - s / 2 - 7, "rgba(240, 214, 140, 0.95)", { size: 10, weight: 600 });
    });
  }
  for (const e of map.extracts) {
    const x = sx(e.x);
    const y = sy(e.y);
    const r = Math.max(6, e.r * v.scale);
    ctx.save();
    ctx.fillStyle = "rgba(62, 224, 122, 0.16)";
    ctx.strokeStyle = "rgba(62, 224, 122, 0.95)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    label(ctx, `${e.id} · ${e.name}`, x, y + r + 9, "#7cf0a6", { size: 11, weight: 700 });
  }
}
