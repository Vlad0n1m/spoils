/**
 * Minimap (top-right corner; the React HUD keeps that corner free) and the map overview texture.
 *
 * The overview is painted ONCE per MapData into a 1024² canvas (terrain colours, roads, rails,
 * buildings, perimeter walls; ~24 world px per texel) and shared by reference count between the
 * minimap, the full map (fullmap.ts) and the ground-chunk fallback (ground-chunks.ts). The v1
 * minimap re-tessellated thousands of tree circles every frame; this one only moves a texture
 * window and a handful of markers.
 *
 * Shows a 4096 px window around the local player, extraction points by state (allowed ones
 * brighter; off-window allowed extracts as edge pips), boss POI skulls (an edge skull when a boss
 * spot is near but off-window), the local player and their party mates (S2C.PARTY, party.ts: a
 * coloured dot, an edge pip when outside the window, an × when down) — never any other player.
 */

import { CanvasSource, Container, Graphics, Rectangle, Sprite, Text, Texture } from "pixi.js";
import { TERRAIN_KIND_MASK, type MapData, type Terrain } from "@extract/shared";
import { COLORS } from "./assets";
import { bossSpotShown, minimapBossHint, type EventBossState } from "./boss";
import { skullContext } from "./boss-icons";
import { TERRAIN_COLOR, groundKinds } from "./terrain-tiles";

/** Overview canvas size (px). 24,576 / 1024 = 24 world px per texel. */
export const OVERVIEW_PX = 1024;
/** World px shown across the minimap (map memo §9). */
export const MINIMAP_WINDOW = 4096;

/** Minimap is drawn at this size and scaled to the layout size. */
const BASE = 200;
/** Gap between the minimap and the top-right corner (px). */
export const MINIMAP_MARGIN = 16;

/** Laid-out minimap side (px) for a screen; it sits MINIMAP_MARGIN from the top-right corner. */
export function minimapSize(screenW: number, screenH: number): number {
  return Math.max(120, Math.min(BASE, Math.min(screenW, screenH) * 0.24));
}

function rgb(c: number): [number, number, number] {
  return [(c >> 16) & 255, (c >> 8) & 255, c & 255];
}

function css(c: number, a = 1): string {
  const [r, g, b] = rgb(c);
  return `rgba(${r},${g},${b},${a})`;
}

/**
 * Paints the map overview: terrain (1 texel per terrain cell, bilinear-upscaled), roads, rails,
 * building floors with wall outlines, perimeter (concrete) walls. ~10–20 ms once per map.
 */
export function paintOverview(map: MapData, size = OVERVIEW_PX): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const cells = document.createElement("canvas");
  cells.width = map.terrainCols;
  cells.height = map.terrainRows;
  const cg = cells.getContext("2d")!;
  const img = cg.createImageData(map.terrainCols, map.terrainRows);
  const kinds = groundKinds(map);
  for (let i = 0; i < kinds.length; i++) {
    const [r, gg, b] = rgb(TERRAIN_COLOR[(kinds[i]! & TERRAIN_KIND_MASK) as Terrain]);
    img.data[i * 4] = r;
    img.data[i * 4 + 1] = gg;
    img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = 255;
  }
  cg.putImageData(img, 0, 0);
  const kx = size / map.width;
  const ky = size / map.height;
  g.imageSmoothingEnabled = true;
  g.drawImage(cells, 0, 0, map.terrainCols * map.terrainCell * kx, map.terrainRows * map.terrainCell * ky);

  g.save();
  g.scale(kx, ky);
  g.lineJoin = "round";
  for (const road of map.roads) {
    if (road.pts.length < 4) continue;
    g.beginPath();
    g.moveTo(road.pts[0]!, road.pts[1]!);
    for (let i = 2; i < road.pts.length; i += 2) g.lineTo(road.pts[i]!, road.pts[i + 1]!);
    if (road.kind === "asphalt") {
      g.lineWidth = road.width;
      g.strokeStyle = css(0x3c4049);
      g.stroke();
    } else if (road.kind === "rail") {
      g.lineWidth = 40;
      g.strokeStyle = css(0x5c5248);
      g.stroke();
      g.lineWidth = 14;
      g.strokeStyle = css(0xb9bcc2, 0.8);
      g.setLineDash([60, 50]);
      g.stroke();
      g.setLineDash([]);
    }
  }
  for (const b of map.buildings) {
    const f = b.floor;
    g.fillStyle = css(COLORS.floorFill);
    g.fillRect(f.x, f.y, f.w, f.h);
    g.lineWidth = 48;
    g.strokeStyle = css(COLORS.wallFill);
    g.strokeRect(f.x, f.y, f.w, f.h);
  }
  g.fillStyle = css(0xb7b9b3);
  for (const r of map.rects) {
    if (r.k === "concrete_wall" || r.k === "ship_container" || r.k === "wagon") g.fillRect(r.x, r.y, r.w, r.h);
  }
  for (const s of map.circles) {
    if (s.k !== "silo") continue;
    g.beginPath();
    g.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    g.fill();
  }
  g.restore();
  return c;
}

interface OverviewEntry {
  texture: Texture;
  refs: number;
}
const overviews = new WeakMap<MapData, OverviewEntry>();

/**
 * Shared overview texture of a map; call releaseOverview(map) once per acquire. The texture is
 * destroyed when the last user releases it (renderer restart / rematch builds a fresh one).
 */
export function acquireOverview(map: MapData): Texture {
  let e = overviews.get(map);
  if (!e || e.texture.destroyed) {
    const source = new CanvasSource({ resource: paintOverview(map), scaleMode: "linear" });
    e = { texture: new Texture({ source }), refs: 0 };
    overviews.set(map, e);
  }
  e.refs++;
  return e.texture;
}

export function releaseOverview(map: MapData): void {
  const e = overviews.get(map);
  if (!e) return;
  e.refs--;
  if (e.refs <= 0) {
    e.texture.destroy(true);
    overviews.delete(map);
  }
}

/**
 * Top-left of a window of `win` world px centred on (x, y), clamped inside the map (near the edge
 * the player marker moves off-centre instead of the window showing outside the map).
 */
export function minimapWindow(map: { width: number; height: number }, x: number, y: number, win = MINIMAP_WINDOW) {
  const w = Math.min(win, map.width);
  const h = Math.min(win, map.height);
  return {
    x: Math.max(0, Math.min(map.width - w, x - w / 2)),
    y: Math.max(0, Math.min(map.height - h, y - h / 2)),
    w,
    h,
  };
}

/** Same union as entities.ts ExtractStatus (kept local: entities.ts is another lane's file). */
export type ExtractStatus = "waiting" | "open" | "closed";

export interface MinimapExtract {
  x: number;
  y: number;
  r: number;
  status: ExtractStatus;
  /** False = not one of this player's extracts (drawn dim, no edge pip). Default true. */
  allowed?: boolean;
}

/** A party mate on the minimap (party.ts PartyMateView). */
export interface MinimapMate {
  x: number;
  y: number;
  alive: boolean;
  color: number;
}

/**
 * Where a mate sits on a minimap of side `base` showing window `win`: inside → its point; outside
 * → clamped `inset` px inside the frame (an edge pip). Pure (minimap tests).
 */
export function minimapMatePoint(
  win: { x: number; y: number; w: number; h: number },
  x: number,
  y: number,
  base: number,
  inset = 5,
): { x: number; y: number; edge: boolean } {
  const px = ((x - win.x) / win.w) * base;
  const py = ((y - win.y) / win.h) * base;
  const inside = px >= 0 && px <= base && py >= 0 && py <= base;
  if (inside) return { x: px, y: py, edge: false };
  return { x: Math.max(inset, Math.min(base - inset, px)), y: Math.max(inset, Math.min(base - inset, py)), edge: true };
}

const statusColor = (s: ExtractStatus) =>
  s === "open" ? COLORS.extractOpen : s === "waiting" ? COLORS.extractWaiting : COLORS.extractClosed;

interface Marker {
  g: Graphics;
  key: string;
}

export class Minimap {
  readonly root = new Container();
  private readonly frame = new Graphics();
  private readonly view: Sprite;
  private readonly windowTex: Texture;
  private readonly markers = new Container();
  private readonly marks: Marker[] = [];
  /** One skull per map.bosses spot (inside the window, or an edge hint when near). */
  private readonly skulls: Graphics[] = [];
  /** Party mate dots (redrawn only when colour / alive / edge changes). */
  private readonly mateLayer = new Container();
  private readonly mateMarks: Marker[] = [];
  private readonly me = new Graphics();
  private readonly north: Text;
  private readonly k: number;
  private released = false;

  constructor(readonly map: MapData) {
    const overview = acquireOverview(map);
    this.k = OVERVIEW_PX / Math.max(map.width, map.height);
    // A private Texture over the shared source: only its frame moves each frame.
    this.windowTex = new Texture({ source: overview.source, frame: new Rectangle(0, 0, 1, 1), orig: new Rectangle(0, 0, 1, 1) });
    this.view = new Sprite(this.windowTex);

    this.frame.roundRect(-5, -5, BASE + 10, BASE + 10, 9).fill({ color: 0x0c120a, alpha: 0.78 });
    this.frame.roundRect(-1, -1, BASE + 2, BASE + 2, 4).stroke({ width: 2, color: 0xffffff, alpha: 0.45 });

    this.me.circle(0, 0, 9).fill({ color: 0xffffff, alpha: 0.25 });
    this.me.poly([10, 0, -6, -7, -3, 0, -6, 7]).fill({ color: 0xffffff }).stroke({ width: 2, color: 0x111111 });

    this.north = new Text({
      text: "N",
      style: { fontFamily: "ui-rounded, 'Trebuchet MS', system-ui, sans-serif", fontSize: 13, fontWeight: "800", fill: 0xffffff, stroke: { color: 0x000000, width: 3 } },
    });
    this.north.anchor.set(0.5, 0);
    this.north.position.set(BASE / 2, 2);

    for (let i = 0; i < (map.bosses?.length ?? 0); i++) {
      const g = new Graphics(skullContext(undefined, 7));
      g.visible = false;
      this.skulls.push(g);
      this.markers.addChild(g);
    }

    this.root.addChild(this.frame, this.view, this.markers, this.mateLayer, this.me, this.north);
    this.root.eventMode = "none";
    this.root.interactiveChildren = false;
  }

  layout(screenW: number, screenH: number) {
    const size = minimapSize(screenW, screenH);
    this.root.scale.set(size / BASE);
    this.root.position.set(screenW - size - MINIMAP_MARGIN, MINIMAP_MARGIN);
  }

  /**
   * Per frame. Moves the texture window, repositions ≤ 8 markers (a marker's Graphics is redrawn
   * only when its status/allowed changes), pulses open extracts with scale (no re-tessellation).
   */
  update(
    extracts: readonly MinimapExtract[],
    self: { x: number; y: number; aim: number } | null,
    nowMs: number,
    /** WORLD v6: BattleState boss fields — only the live event boss gets a skull (null = every spot). */
    boss: EventBossState | null = null,
    /** Party mates (S2C.PARTY, party.ts), drawn under the local player's arrow. */
    mates: readonly MinimapMate[] = [],
  ) {
    const map = this.map;
    const cx = self ? self.x : map.width / 2;
    const cy = self ? self.y : map.height / 2;
    const win = minimapWindow(map, cx, cy);
    const k = this.k;
    // Move the window (frame and orig together, then update() so the Sprite refreshes its quad).
    const fr = this.windowTex.frame;
    const or = this.windowTex.orig;
    fr.x = win.x * k;
    fr.y = win.y * k;
    or.width = fr.width = win.w * k;
    or.height = fr.height = win.h * k;
    this.windowTex.update();
    this.view.scale.set(BASE / fr.width, BASE / fr.height);
    const s = BASE / win.w;
    const toMini = (x: number, y: number) => ({ x: (x - win.x) * s, y: (y - win.y) * s });

    while (this.marks.length < extracts.length) {
      const g = new Graphics();
      this.markers.addChild(g);
      this.marks.push({ g, key: "" });
    }
    for (let i = 0; i < this.marks.length; i++) {
      const m = this.marks[i]!;
      const e = extracts[i];
      if (!e) {
        m.g.visible = false;
        continue;
      }
      const allowed = e.allowed !== false;
      let p = toMini(e.x, e.y);
      const inside = p.x >= 0 && p.x <= BASE && p.y >= 0 && p.y <= BASE;
      if (!inside && !allowed) {
        m.g.visible = false;
        continue;
      }
      const edge = !inside;
      if (edge) p = { x: Math.max(6, Math.min(BASE - 6, p.x)), y: Math.max(6, Math.min(BASE - 6, p.y)) };
      const key = `${e.status}|${allowed}|${edge}|${Math.round(Math.max(5, e.r * s))}`;
      if (key !== m.key) {
        m.key = key;
        const color = allowed ? statusColor(e.status) : COLORS.extractClosed;
        m.g.clear();
        if (edge) m.g.circle(0, 0, 4.5).fill({ color }).stroke({ width: 1.5, color: 0x111111 });
        else {
          const r = Math.max(5, e.r * s);
          m.g.circle(0, 0, r).fill({ color, alpha: allowed ? 0.35 : 0.15 }).stroke({ width: 2, color, alpha: allowed ? 1 : 0.5 });
        }
      }
      m.g.visible = true;
      m.g.position.set(p.x, p.y);
      m.g.scale.set(e.status === "open" && allowed && !edge ? 1 + 0.25 * Math.sin(nowMs / 250) : 1);
    }

    const bosses = map.bosses ?? [];
    for (let i = 0; i < this.skulls.length; i++) {
      const g = this.skulls[i]!;
      const spot = bosses[i];
      const hint = spot && bossSpotShown(bosses, i, boss) ? minimapBossHint(win, spot, self, BASE) : null;
      g.visible = !!hint;
      if (!hint) continue;
      g.position.set(hint.x, hint.y);
      g.scale.set(hint.edge ? 0.8 + 0.1 * Math.sin(nowMs / 300) : 1);
      g.alpha = hint.edge ? 0.95 : 0.85;
    }

    while (this.mateMarks.length < mates.length) {
      const g = new Graphics();
      this.mateLayer.addChild(g);
      this.mateMarks.push({ g, key: "" });
    }
    for (let i = 0; i < this.mateMarks.length; i++) {
      const mk = this.mateMarks[i]!;
      const mate = mates[i];
      mk.g.visible = !!mate;
      if (!mate) continue;
      const p = minimapMatePoint(win, mate.x, mate.y, BASE);
      const key = `${mate.color}|${mate.alive}|${p.edge}`;
      if (key !== mk.key) {
        mk.key = key;
        mk.g.clear();
        if (!mate.alive) {
          mk.g.moveTo(-4, -4).lineTo(4, 4).moveTo(4, -4).lineTo(-4, 4).stroke({ width: 4, color: 0x111111, alpha: 0.8 });
          mk.g.moveTo(-4, -4).lineTo(4, 4).moveTo(4, -4).lineTo(-4, 4).stroke({ width: 2, color: mate.color });
        } else if (p.edge) {
          mk.g.circle(0, 0, 4).fill({ color: mate.color }).stroke({ width: 1.5, color: 0x111111 });
        } else {
          mk.g.circle(0, 0, 8).fill({ color: mate.color, alpha: 0.22 });
          mk.g.circle(0, 0, 5).fill({ color: mate.color }).stroke({ width: 2, color: 0x111111 });
        }
      }
      mk.g.position.set(p.x, p.y);
      mk.g.alpha = mate.alive ? 1 : 0.8;
    }

    this.me.visible = !!self;
    if (self) {
      const p = toMini(self.x, self.y);
      this.me.position.set(p.x, p.y);
      this.me.rotation = self.aim;
    }
  }

  destroy() {
    this.root.destroy({ children: true });
    this.windowTex.destroy(false);
    if (!this.released) {
      this.released = true;
      releaseOverview(this.map);
    }
  }
}
