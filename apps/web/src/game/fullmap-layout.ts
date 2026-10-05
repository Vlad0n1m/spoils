/**
 * Full map v2 — pure layout helpers (no Pixi, node-testable): where the panel, title and legend go
 * on a screen, the world → panel transform, label placement with collision avoidance, the legend's
 * rows, the title line, the scale bar and the grid ruler.
 */

import { mapNumber, type MapSide } from "@extract/shared";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * "side": title + legend in a column left of the map; "below": under it; "gutter": a narrow
 * compact column left of the map (landscape phones, between the touch buttons and the map; its x
 * is the column's RIGHT edge); "inside": a corner box on the map.
 */
export type LegendMode = "side" | "below" | "gutter" | "inside";

export interface FullMapLayout {
  /** The map square (screen px). */
  panel: { x: number; y: number; size: number };
  /** Grid ruler band drawn outside the map's top and left edges (px), 0 = no ruler. */
  ruler: number;
  /** Title block: top-left corner and its width (text is left-aligned in "side", centred otherwise). */
  title: { x: number; y: number; w: number; align: "left" | "center" };
  legend: { mode: LegendMode; x: number; y: number; w: number };
  /** Close hint ("M — close"), hidden when there is no room for it. */
  hint: { x: number; y: number; visible: boolean };
  /** Small screens: one-line title, compact legend, no ruler. */
  compact: boolean;
  /** Label / icon scale for this map size. */
  fontScale: number;
}

/** Width of the side column (title + legend) left of the map on wide screens. */
export const SIDE_COLUMN_W = 220;
const SIDE_GAP = 30;
/** React HUD keep-outs: the top status pill, the desktop inventory bar, touch sticks / buttons. */
const TOP_HUD = 84;
const BOTTOM_HUD_DESKTOP = 132;

/** Minimap side as minimap.ts lays it out (kept here so the layout stays free of Pixi imports). */
function minimapSide(w: number, h: number): number {
  return Math.max(h < 480 ? 100 : 120, Math.min(200, Math.min(w, h) * 0.24));
}

/**
 * Where the full map goes on a `w`×`h` screen. Desktop: a square between the HUD's top pill and the
 * inventory bar, centred, with the title and legend in a column on its left when there is room
 * (else the title above and the legend in a corner). Short landscape phones (< 480 px tall): the
 * square between the touch control columns under a one-line title, legend inside. Portrait: under
 * the minimap, legend below.
 */
export function fullMapLayout(w: number, h: number, touch: boolean): FullMapLayout {
  const short = h < 480;
  const portrait = !short && h > w * 1.1;
  if (short) {
    const sideKeep = touch ? 176 : 16;
    const top = 64;
    const size = Math.max(160, Math.min(h - top - 8, w - sideKeep * 2));
    const x = Math.round((w - size) / 2);
    return {
      panel: { x, y: top, size },
      ruler: 0,
      title: { x, y: top - 22, w: size, align: "center" },
      // The gutter between the left touch buttons (MAP, items, stick: x < ~160) and the map.
      legend: x - 8 - 160 >= 80 ? { mode: "gutter", x: x - 8, y: top, w: x - 8 - 160 } : { mode: "inside", x: x + 6, y: top + size - 6, w: 0 },
      hint: { x: x + size / 2, y: top + size + 2, visible: false },
      compact: true,
      fontScale: Math.max(0.72, Math.min(0.85, size / 420)),
    };
  }
  if (portrait) {
    const top = minimapSide(w, h) + 32 + 34;
    const size = Math.max(200, Math.min(w - 24, h - top - 160));
    const x = Math.round((w - size) / 2);
    return {
      panel: { x, y: top, size },
      ruler: 0,
      title: { x, y: top - 34, w: size, align: "center" },
      legend: { mode: "below", x, y: top + size + 12, w: size },
      hint: { x: x + size / 2, y: h - 28, visible: true },
      compact: size < 440,
      fontScale: Math.max(0.75, Math.min(1, size / 560)),
    };
  }
  const bottom = touch ? 24 : BOTTOM_HUD_DESKTOP;
  let size = Math.max(200, Math.min(h - TOP_HUD - bottom, w - 32));
  // Keep clear of the minimap (top-right corner).
  const mm = minimapSide(w, h) + 32;
  const right = (w + size) / 2;
  if (right > w - mm) size = Math.max(200, Math.min(size, w - 2 * mm));
  const sideFits = (w - size) / 2 >= SIDE_COLUMN_W + SIDE_GAP + 8;
  if (sideFits) {
    const x = Math.round((w - size) / 2);
    const colX = x - SIDE_GAP - SIDE_COLUMN_W;
    return {
      panel: { x, y: TOP_HUD, size },
      ruler: 16,
      title: { x: colX, y: TOP_HUD, w: SIDE_COLUMN_W, align: "left" },
      legend: { mode: "side", x: colX, y: TOP_HUD + 96, w: SIDE_COLUMN_W },
      hint: { x: colX, y: TOP_HUD + size - 16, visible: true },
      compact: false,
      fontScale: Math.max(0.8, Math.min(1.1, size / 680)),
    };
  }
  // Narrow desktop: the title takes a row above the map, the legend a corner of it.
  size = Math.max(200, size - 30);
  const x = Math.round((w - size) / 2);
  const y = TOP_HUD + 30;
  return {
    panel: { x, y, size },
    ruler: 0,
    title: { x, y: y - 30, w: size, align: "center" },
    legend: { mode: "inside", x: x + 8, y: y + size - 8, w: 0 },
    hint: { x: x + size / 2, y: y + size + 6, visible: touch },
    compact: size < 440,
    fontScale: Math.max(0.75, Math.min(1, size / 620)),
  };
}

/** World → panel scale for a map drawn in a `size` px square. */
export function mapScale(size: number, map: { width: number; height: number }): number {
  return size / Math.max(map.width, map.height);
}

/** World point → screen point on the panel. */
export function worldToPanel(panel: { x: number; y: number }, k: number, wx: number, wy: number): { x: number; y: number } {
  return { x: panel.x + wx * k, y: panel.y + wy * k };
}

// ---------------------------------------------------------------------------------------------
// Label placement
// ---------------------------------------------------------------------------------------------

export interface LabelRequest {
  id: string;
  w: number;
  h: number;
  /** Top-left positions to try, best first. */
  candidates: ReadonlyArray<{ x: number; y: number }>;
  /** Higher places first (extract names before POIs, T4 before T1). */
  priority: number;
}

export interface PlacedLabel {
  x: number;
  y: number;
  /** True when no candidate was free (the least-overlapping one was taken). */
  overlap: boolean;
}

function overlapArea(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Greedy label placement: by priority (ties keep input order), each label takes its first
 * candidate (clamped inside `bounds`) that overlaps no placed label and no obstacle (icons, legend,
 * compass), padded by `pad`; when none is free, the least-overlapping candidate. Deterministic.
 */
export function placeLabels(
  reqs: readonly LabelRequest[],
  bounds: Box,
  obstacles: readonly Box[] = [],
  pad = 2,
): Map<string, PlacedLabel> {
  const order = reqs.map((r, i) => ({ r, i })).sort((a, b) => b.r.priority - a.r.priority || a.i - b.i);
  const placed: Box[] = [];
  const out = new Map<string, PlacedLabel>();
  for (const { r } of order) {
    let best: { x: number; y: number; cost: number } | null = null;
    for (const c of r.candidates) {
      const x = Math.max(bounds.x, Math.min(bounds.x + bounds.w - r.w, c.x));
      const y = Math.max(bounds.y, Math.min(bounds.y + bounds.h - r.h, c.y));
      const box = { x: x - pad, y: y - pad, w: r.w + pad * 2, h: r.h + pad * 2 };
      let cost = 0;
      for (const p of placed) cost += overlapArea(box, p);
      for (const o of obstacles) cost += overlapArea(box, o);
      if (!best || cost < best.cost) best = { x, y, cost };
      if (cost === 0) break;
    }
    if (!best) continue;
    placed.push({ x: best.x, y: best.y, w: r.w, h: r.h });
    out.set(r.id, { x: best.x, y: best.y, overlap: best.cost > 0 });
  }
  return out;
}

/** Candidates for a POI name pill of w×h over the zone's panel rect: centre, upper / lower third, just above, just below. */
export function zoneLabelCandidates(rect: Box, w: number, h: number): Array<{ x: number; y: number }> {
  const cx = rect.x + rect.w / 2 - w / 2;
  const cy = rect.y + rect.h / 2 - h / 2;
  return [
    { x: cx, y: cy },
    { x: cx, y: rect.y + rect.h * 0.25 - h / 2 },
    { x: cx, y: rect.y + rect.h * 0.75 - h / 2 },
    { x: cx, y: rect.y - h - 2 },
    { x: cx, y: rect.y + rect.h + 2 },
    { x: rect.x + rect.w + 2, y: cy },
    { x: rect.x - w - 2, y: cy },
  ];
}

/**
 * Candidates for an extract's label next to its icon at (px, py) (radius r) on map side `side`:
 * inward from the edge first (N → below, E → left, S → above, W → right), then along the edge.
 */
export function extractLabelCandidates(px: number, py: number, side: MapSide, w: number, h: number, r: number): Array<{ x: number; y: number }> {
  const g = r + 4;
  const below = { x: px - w / 2, y: py + g };
  const above = { x: px - w / 2, y: py - g - h };
  const left = { x: px - g - w, y: py - h / 2 };
  const right = { x: px + g, y: py - h / 2 };
  switch (side) {
    case 0:
      return [below, { x: px + g, y: py + 2 }, { x: px - g - w, y: py + 2 }];
    case 1:
      return [left, { x: px - g - w, y: py + g }, { x: px - g - w, y: py - g - h }];
    case 2:
      return [above, { x: px + g, y: py - h - 2 }, { x: px - g - w, y: py - h - 2 }];
    default:
      return [right, { x: px + g, y: py + g }, { x: px + g, y: py - g - h }];
  }
}

// ---------------------------------------------------------------------------------------------
// Legend, title, scale bar, ruler
// ---------------------------------------------------------------------------------------------

export type LegendKey = "you" | "party" | "extract-open" | "extract-waiting" | "extract-closed" | "spawn" | "boss" | "hot" | "drop" | "clue";

export interface LegendRow {
  key: LegendKey;
  label: string;
}

/** What the map shows right now, for the legend. */
export interface LegendState {
  mates: number;
  boss: boolean;
  hot: boolean;
  drop: boolean;
  clue: boolean;
  spawn: boolean;
}

/**
 * Legend rows for what is on the map: you and your extracts always; party, spawn side, event boss,
 * hot zone, supply drop and clue areas only while present. (Tier chips T1–T4 are a fixed row the
 * overlay adds under these.)
 */
export function legendItems(s: LegendState, short = false): LegendRow[] {
  const rows: LegendRow[] = [{ key: "you", label: "You" }];
  if (s.mates > 0) rows.push({ key: "party", label: s.mates === 1 ? (short ? "Mate" : "Party mate") : "Party" });
  rows.push(
    { key: "extract-open", label: short ? "Exit open" : "Your extract · open" },
    { key: "extract-waiting", label: short ? "Opening" : "Your extract · opening" },
    { key: "extract-closed", label: short ? "Closed" : "Closed / not yours" },
  );
  if (s.spawn) rows.push({ key: "spawn", label: short ? "Spawn" : "Your spawn side" });
  if (s.boss) rows.push({ key: "boss", label: short ? "Boss" : "Event boss" });
  if (s.hot) rows.push({ key: "hot", label: "Hot zone" });
  if (s.drop) rows.push({ key: "drop", label: short ? "Drop" : "Supply drop" });
  if (s.clue) rows.push({ key: "clue", label: short ? "Clue" : "Clue area" });
  return rows;
}

/** Stable key of a legend state (the overlay rebuilds the legend only when it changes). */
export function legendKey(s: LegendState): string {
  return legendItems(s).map((r) => r.key).join(",") + `|${s.mates}`;
}

/** "m:ss" (ceil to whole seconds, never negative). */
export function clock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Meta line: "MAP #212 · WIPE IN 31:20" (map number only for a world cycle, wipe only when known). */
export function fullMapMeta(cycle: number, wipeInMs: number | null): string {
  const parts: string[] = [];
  if (cycle > 0) {
    const n = mapNumber(cycle);
    parts.push(n >= 1 ? `MAP #${n}` : "PREVIEW MAP");
  }
  if (wipeInMs !== null) parts.push(wipeInMs > 0 ? `WIPE IN ${clock(wipeInMs)}` : "WIPING");
  return parts.join(" · ");
}

/**
 * Title line: "THE OUTSKIRTS · MAP #212 · WIPE IN 31:20". The map number only for a world cycle
 * (cycle > 0; before Map #1 "PREVIEW MAP"), the wipe only when known (wipeInMs !== null).
 */
export function fullMapTitle(mapName: string, cycle: number, wipeInMs: number | null): string {
  const meta = fullMapMeta(cycle, wipeInMs);
  return meta ? `${mapName.toUpperCase()} · ${meta}` : mapName.toUpperCase();
}

/**
 * Legend corner inside the map (compact layouts): of the candidate corners (top-left positions of
 * a w×h box), the one covering the fewest of `points` (extract icons, POI centres), first on ties.
 */
export function pickLegendCorner(
  corners: ReadonlyArray<{ x: number; y: number }>,
  w: number,
  h: number,
  points: ReadonlyArray<{ x: number; y: number }>,
): { x: number; y: number } {
  let best = corners[0]!;
  let bestN = Infinity;
  for (const c of corners) {
    let n = 0;
    for (const p of points) if (p.x >= c.x && p.x <= c.x + w && p.y >= c.y && p.y <= c.y + h) n++;
    if (n < bestN) {
      bestN = n;
      best = c;
    }
  }
  return best;
}

const SIDE_NAME = ["north", "east", "south", "west"] as const;

/** Sub line: "Spawned west · 3 extracts are yours". */
export function fullMapSubtitle(side: MapSide | null, yours: number | null): string {
  const parts: string[] = [];
  if (side !== null) parts.push(`Spawned ${SIDE_NAME[side]}`);
  if (yours !== null) parts.push(yours === 1 ? "1 extract is yours" : `${yours} extracts are yours`);
  return parts.join(" · ");
}

/** Status line under an extract's name: "OPEN", "OPEN · CLOSES 4:10", "OPENS IN 1:20", "CLOSED". */
export function extractStatusText(status: "waiting" | "open" | "closed", suffix: string): string {
  if (status === "closed") return "CLOSED";
  const s = suffix.replace(/^ · /, "").toUpperCase();
  if (status === "waiting") return s || "OPENING";
  return s ? `OPEN · ${s.replace(/^CLOSES IN /, "CLOSES ")}` : "OPEN";
}

const NICE_METERS = [10, 20, 25, 50, 100, 200, 250, 500, 1000];

/** Scale bar: the smallest nice length (m) at least `minPx` long at scale k (px per world px). */
export function scaleBar(k: number, pxPerMeter = 40, minPx = 56): { meters: number; px: number } {
  for (const m of NICE_METERS) {
    const px = m * pxPerMeter * k;
    if (px >= minPx) return { meters: m, px };
  }
  const m = NICE_METERS[NICE_METERS.length - 1]!;
  return { meters: m, px: m * pxPerMeter * k };
}

/** Column letters / row numbers of the map grid ("A"…, "1"…), one per `cell` world px. */
export function gridRuler(mapW: number, mapH: number, cell: number): { cols: string[]; rows: string[] } {
  const nc = Math.ceil(mapW / cell);
  const nr = Math.ceil(mapH / cell);
  const cols = Array.from({ length: nc }, (_, i) => (i < 26 ? String.fromCharCode(65 + i) : `A${String.fromCharCode(65 + i - 26)}`));
  const rows = Array.from({ length: nr }, (_, i) => String(i + 1));
  return { cols, rows };
}
