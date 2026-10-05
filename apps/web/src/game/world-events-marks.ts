/**
 * WORLD v6 map events on the minimap and the full map (world-events.ts system → this view →
 * minimap.ts / fullmap.ts). The system writes `worldEventsView` once per frame; the two maps own a
 * MinimapWorldMarks / FullmapWorldMarks layer and redraw it from the view (a handful of shapes).
 *
 * Nothing here knows a player position other than the local player's: drop circles, crate points
 * and hot POIs are public world facts (BattleState.wev), fight markers are the server's quantized
 * [sector, band] entries (EventsMsg.fight) placed at the band's middle distance, and the full-map
 * heat is BattleState.heat (2 km cells).
 */

import { Container, Graphics, Text } from "pixi.js";
import { FIGHT, WEV_STATE, bandMid, decodeHeat, fightCellCentre, sectorAngle, type Band, type MapData, type Rect } from "@extract/shared";

export const DROP_COLOR = 0xffb020;
export const HOT_COLOR = 0xff6a2a;
export const FIGHT_COLOR = 0xff3b3b;
/** In-raid objectives (objectives.ts system): clue circles and locked rooms on the full map. */
export const CLUE_COLOR = 0x7fe0c8;
export const LOCK_COLOR = 0xe8c060;

/** A clue note's fuzzy circle (the holder's own notes only). */
export interface ClueMark {
  n: number;
  x: number;
  y: number;
  r: number;
  text: string;
}

/** A locked room's gate (public layout + BattleState.lockState). */
export interface LockMark {
  x: number;
  y: number;
  open: boolean;
}

export interface WevDropView {
  key: string;
  state: number;
  /** Announced: circle centre; landed: crate point. */
  x: number;
  y: number;
  r: number;
  at: number;
  until: number;
  zone: string;
}

export interface WevHotView {
  key: string;
  state: number;
  rect: Rect | null;
  x: number;
  y: number;
  at: number;
  until: number;
  zone: string;
}

export interface FightMark {
  a: number;
  b: Band;
  /** performance.now() when it fades out completely. */
  until: number;
  /** Where the local player stood when it arrived (the sector is relative to that point). */
  fromX: number;
  fromY: number;
}

/** What the maps draw (written by the world-events system every frame). */
export const worldEventsView = {
  drops: [] as WevDropView[],
  hots: [] as WevHotView[],
  fights: [] as FightMark[],
  heat: [] as Array<{ cell: number; level: number }>,
  heatRaw: "",
  clockMs: 0,
  mapW: 0,
  /** Written by the objectives system (objectives.ts) every frame. */
  clues: [] as ClueMark[],
  locks: [] as LockMark[],
};

/** Fight markers live this long on the minimap. */
export const FIGHT_MARK_MS = 2_600;

/** Reset (a new battle). */
export function resetWorldEventsView(): void {
  worldEventsView.drops = [];
  worldEventsView.hots = [];
  worldEventsView.fights = [];
  worldEventsView.heat = [];
  worldEventsView.heatRaw = "";
  worldEventsView.clockMs = 0;
  worldEventsView.clues = [];
  worldEventsView.locks = [];
}

/** Keep the decoded heat in sync with BattleState.heat (decoded only when it changes). */
export function setHeat(raw: string, mapW: number): void {
  if (raw === worldEventsView.heatRaw && mapW === worldEventsView.mapW) return;
  worldEventsView.heatRaw = raw;
  worldEventsView.mapW = mapW;
  worldEventsView.heat = decodeHeat(raw);
}

/** World point of a fight marker: the band's middle distance along the sector from where it was heard. */
export function fightPoint(f: Pick<FightMark, "a" | "b" | "fromX" | "fromY">): { x: number; y: number } {
  const ang = sectorAngle(f.a);
  const d = bandMid(f.b) * FIGHT.RADIUS;
  return { x: f.fromX + Math.cos(ang) * d, y: f.fromY + Math.sin(ang) * d };
}

/** Countdown "m:ss" of `ms` (≥ 0). */
export function mmss(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

type Win = { x: number; y: number; w: number; h: number };

/** Clamp a minimap point to the frame (an edge pip) when it is outside. */
function clampMini(px: number, py: number, base: number, inset: number): { x: number; y: number; edge: boolean } {
  const inside = px >= 0 && px <= base && py >= 0 && py <= base;
  if (inside) return { x: px, y: py, edge: false };
  return { x: Math.max(inset, Math.min(base - inset, px)), y: Math.max(inset, Math.min(base - inset, py)), edge: true };
}

/** Minimap layer: drop circles / crates, hot POIs and fight bursts, redrawn every frame. */
export class MinimapWorldMarks {
  readonly root = new Graphics();

  constructor() {
    this.root.eventMode = "none";
  }

  update(win: Win, base: number, nowMs: number, self: { x: number; y: number } | null): void {
    const g = this.root;
    g.clear();
    const v = worldEventsView;
    const s = base / win.w;
    const toMini = (x: number, y: number) => ({ x: (x - win.x) * s, y: (y - win.y) * s });
    const pulse = 0.5 + 0.5 * Math.sin(nowMs / 220);

    for (const h of v.hots) {
      if (h.state === WEV_STATE.DONE) continue;
      const active = h.state === WEV_STATE.ACTIVE;
      if (h.rect) {
        const a = toMini(h.rect.x, h.rect.y);
        const w = h.rect.w * s, hh = h.rect.h * s;
        const inside = a.x + w >= 0 && a.x <= base && a.y + hh >= 0 && a.y <= base;
        if (inside) {
          const x0 = Math.max(0, a.x), y0 = Math.max(0, a.y);
          const x1 = Math.min(base, a.x + w), y1 = Math.min(base, a.y + hh);
          g.rect(x0, y0, x1 - x0, y1 - y0).fill({ color: HOT_COLOR, alpha: active ? 0.18 + 0.12 * pulse : 0.1 });
          g.rect(x0, y0, x1 - x0, y1 - y0).stroke({ width: 2, color: HOT_COLOR, alpha: active ? 0.95 : 0.6 });
          continue;
        }
      }
      const p = clampMini(toMini(h.x, h.y).x, toMini(h.x, h.y).y, base, 6);
      g.poly([p.x, p.y - 6, p.x + 6, p.y, p.x, p.y + 6, p.x - 6, p.y]).fill({ color: HOT_COLOR, alpha: 0.9 }).stroke({ width: 1.5, color: 0x111111 });
    }

    for (const d of v.drops) {
      if (d.state === WEV_STATE.DONE) continue;
      const m = toMini(d.x, d.y);
      if (d.state === WEV_STATE.ANNOUNCED) {
        const r = Math.max(6, d.r * s);
        const inside = m.x + r >= 0 && m.x - r <= base && m.y + r >= 0 && m.y - r <= base;
        if (inside) {
          g.circle(m.x, m.y, r).fill({ color: DROP_COLOR, alpha: 0.12 + 0.1 * pulse }).stroke({ width: 2, color: DROP_COLOR, alpha: 0.9 });
          continue;
        }
      }
      const p = clampMini(m.x, m.y, base, 6);
      const r = p.edge ? 4.5 : 5 + 1.5 * pulse;
      g.circle(p.x, p.y, r + 3).fill({ color: DROP_COLOR, alpha: 0.25 });
      g.rect(p.x - r, p.y - r, r * 2, r * 2).fill({ color: DROP_COLOR }).stroke({ width: 1.5, color: 0x111111 });
    }

    if (self) {
      v.fights = v.fights.filter((f) => f.until > nowMs);
      for (const f of v.fights) {
        const w = fightPoint(f);
        const m = toMini(w.x, w.y);
        const p = clampMini(m.x, m.y, base, 7);
        const life = Math.max(0, Math.min(1, (f.until - nowMs) / FIGHT_MARK_MS));
        const r = p.edge ? 5 : 6;
        g.moveTo(p.x - r, p.y - r).lineTo(p.x + r, p.y + r).moveTo(p.x + r, p.y - r).lineTo(p.x - r, p.y + r).stroke({ width: 4, color: 0x111111, alpha: 0.6 * life });
        g.moveTo(p.x - r, p.y - r).lineTo(p.x + r, p.y + r).moveTo(p.x + r, p.y - r).lineTo(p.x - r, p.y + r).stroke({ width: 2.2, color: FIGHT_COLOR, alpha: life });
        g.circle(p.x, p.y, r + 3 + (1 - life) * 6).stroke({ width: 1.5, color: FIGHT_COLOR, alpha: 0.6 * life });
      }
    }
  }

  destroy(): void {
    this.root.destroy();
  }
}

/** Full-map layer: fight heat cells, hot POIs, drop circles / crates with short labels. */
export class FullmapWorldMarks {
  readonly root = new Container();
  private readonly g = new Graphics();
  private readonly labels: Text[] = [];

  constructor(private readonly font: string) {
    this.root.addChild(this.g);
    this.root.eventMode = "none";
  }

  private label(i: number): Text {
    while (this.labels.length <= i) {
      const t = new Text({ text: "", style: { fontFamily: this.font, fontSize: 13, fontWeight: "900", fill: 0xffffff, stroke: { color: 0x0b0b0b, width: 4 }, letterSpacing: 1 } });
      t.anchor.set(0.5, 1);
      this.root.addChild(t);
      this.labels.push(t);
    }
    return this.labels[i]!;
  }

  update(map: Pick<MapData, "width">, k: number, nowMs: number, fontScale: number): void {
    const g = this.g;
    g.clear();
    const v = worldEventsView;
    const pulse = 0.5 + 0.5 * Math.sin(nowMs / 260);
    const cell = FIGHT.HEAT_CELL * k;
    for (const h of v.heat) {
      const c = fightCellCentre(h.cell, map.width, FIGHT.HEAT_CELL);
      const a = [0, 0.16, 0.28, 0.42][h.level] ?? 0.16;
      g.roundRect((c.x * k) - cell / 2 + 1, (c.y * k) - cell / 2 + 1, cell - 2, cell - 2, 4).fill({ color: FIGHT_COLOR, alpha: a * (0.8 + 0.2 * pulse) });
    }
    let li = 0;
    const put = (text: string, x: number, y: number, color: number) => {
      const t = this.label(li++);
      t.visible = true;
      if (t.text !== text) t.text = text;
      t.style.fill = color;
      t.scale.set(fontScale);
      t.position.set(x, y);
    };
    const clock = v.clockMs;
    for (const h of v.hots) {
      if (h.state === WEV_STATE.DONE || !h.rect) continue;
      const active = h.state === WEV_STATE.ACTIVE;
      const r = h.rect;
      g.roundRect(r.x * k, r.y * k, r.w * k, r.h * k, 6).fill({ color: HOT_COLOR, alpha: active ? 0.2 + 0.12 * pulse : 0.12 });
      g.roundRect(r.x * k, r.y * k, r.w * k, r.h * k, 6).stroke({ width: 3, color: HOT_COLOR, alpha: 0.95 });
      put(active ? `HOT ZONE · ${mmss(h.until - clock)}` : `HOT ZONE IN ${mmss(h.at - clock)}`, (r.x + r.w / 2) * k, r.y * k - 4, 0xffb08a);
    }
    for (const d of v.drops) {
      if (d.state === WEV_STATE.DONE) continue;
      const x = d.x * k, y = d.y * k;
      if (d.state === WEV_STATE.ANNOUNCED) {
        const r = Math.max(8, d.r * k);
        g.circle(x, y, r).fill({ color: DROP_COLOR, alpha: 0.18 + 0.12 * pulse }).stroke({ width: 3, color: DROP_COLOR, alpha: 0.95 });
        put(`SUPPLY DROP · ${mmss(d.at - clock)}`, x, y - r - 3, 0xffd27a);
      } else {
        const r = 6 + 2 * pulse;
        g.circle(x, y, r + 6).fill({ color: DROP_COLOR, alpha: 0.3 });
        g.rect(x - r, y - r, r * 2, r * 2).fill({ color: DROP_COLOR }).stroke({ width: 2, color: 0x111111 });
        put("SUPPLY DROP", x, y - r - 8, 0xffd27a);
      }
    }
    // In-raid objectives: locked rooms (padlock) and the holder's clue circles (dashed, "?").
    for (const l of v.locks) {
      const x = l.x * k, y = l.y * k;
      const c = l.open ? 0x9aa3ad : LOCK_COLOR;
      g.roundRect(x - 5, y - 2, 10, 8, 2).fill({ color: c }).stroke({ width: 1.5, color: 0x111111 });
      g.moveTo(x - 3, y - 2).arc(x, y - 2, 3, Math.PI, 0).stroke({ width: 2, color: c });
    }
    for (const c of v.clues) {
      const x = c.x * k, y = c.y * k, r = Math.max(10, c.r * k);
      g.circle(x, y, r).fill({ color: CLUE_COLOR, alpha: 0.1 + 0.08 * pulse });
      const n = 28;
      for (let i = 0; i < n; i += 2) {
        const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
        g.moveTo(x + Math.cos(a0) * r, y + Math.sin(a0) * r).arc(x, y, r, a0, a1);
      }
      g.stroke({ width: 2.5, color: CLUE_COLOR, alpha: 0.95 });
      put(`? ${c.text}`, x, y - r - 3, CLUE_COLOR);
    }
    for (let i = li; i < this.labels.length; i++) this.labels[i]!.visible = false;
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }
}
