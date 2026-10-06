/**
 * Party mates in the battle client (shared party.ts; game server sim/party.ts + battle-room.ts).
 *
 * S2C.PARTY brings this player's party mates at ~PARTY.POS_HZ: [{key, id, name, x, y, alive}] —
 * never this player, never anyone outside the party, so fog and the StateView rules stay the same
 * for everyone else. A dead mate stays listed for a few seconds (alive: false, at the body); an
 * extracted one drops out. The renderer feeds the messages into a PartyTracker and hands the
 * smoothed mates to:
 *   - the minimap (minimap.ts: a dot per mate, an edge pip when outside the window, × when down);
 *   - the full map (fullmap.ts: dot + name);
 *   - createPartySystem (screen layer, above the fog): a chevron over a mate in view (their own
 *     name tag is the entity's), a ghost ring + name where a mate stands behind fog or walls, an ×
 *     + "Name · down" at a fallen mate, and an arrow at the screen edge with "Name · 34 m" toward a
 *     mate off screen.
 * There is no damage feedback between mates: the server never lets a mate's bullet hit (it passes
 * through), so no hit / kill events ever name a mate of the shooter.
 *
 * Pure parts (parsePartyMsg, PartyTracker, edgeAnchor, mateLabel) are tested in party.test.ts.
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/party.test.ts
 */

import { Container, Graphics, Text } from "pixi.js";
import { PARTY, PLAYER } from "@extract/shared";
import { PX_PER_METER } from "./cinematics";
import { MINIMAP_MARGIN, minimapSize } from "./minimap";
import type { GameContext, GameSystem } from "./systems";
import { hudReservedRects } from "./touch-controls";
import { NO_INSETS, safeInsets, type SafeInsets } from "./safe-area";
import { shouldUseTouch } from "./touch-mode";

/** One mate as the client draws it (world px, smoothed). */
export interface PartyMateView {
  /** BattleState self key of the mate ("p<rosterIndex>"): stable for one entry. */
  key: string;
  /** The mate's current state.players key ("" = unknown): links the marker to the entity in view. */
  id: string;
  name: string;
  x: number;
  y: number;
  alive: boolean;
  /** Marker colour (MATE_COLORS), stable per mate for the raid. */
  color: number;
}

/** Mate marker colours (minimap, full map, world markers): cyan, violet, pink — none is an extract / boss / tier colour. */
export const MATE_COLORS = [0x4fd1ff, 0xc084fc, 0xff8fd8] as const;
/** A party has at most PARTY.MAX_SIZE − 1 mates; anything beyond is ignored. */
export const MAX_MATES = PARTY.MAX_SIZE - 1;
/** Positions glide to each new update over one S2C.PARTY period. */
export const PARTY_LERP_MS = 1000 / PARTY.POS_HZ;
/** No S2C.PARTY for this long (mates gone, connection hiccup): the markers go away. */
export const PARTY_STALE_MS = 3_000;
/** A jump this long (a re-entry, a long gap) snaps instead of gliding across the map. */
const SNAP_PX = 600;
const KEY_RE = /^p\d{1,4}$/;
const NAME_MAX = 24;
const ID_MAX = 64;

/** One sanitized S2C.PARTY mate (the message comes from the network: untrusted shape). */
export interface PartyMateIn {
  key: string;
  id: string;
  name: string;
  x: number;
  y: number;
  alive: boolean;
}

/** The mates of an S2C.PARTY message, or null when it is not one. Bad entries are skipped. */
export function parsePartyMsg(raw: unknown): PartyMateIn[] | null {
  if (!raw || typeof raw !== "object") return null;
  const list = (raw as { mates?: unknown }).mates;
  if (!Array.isArray(list)) return null;
  const out: PartyMateIn[] = [];
  for (const m of list) {
    if (out.length >= MAX_MATES) break;
    if (!m || typeof m !== "object") continue;
    const { key, id, name, x, y, alive } = m as Record<string, unknown>;
    if (typeof key !== "string" || !KEY_RE.test(key) || out.some((o) => o.key === key)) continue;
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    const nick = typeof name === "string" ? [...name.trim()].slice(0, NAME_MAX).join("") : "";
    out.push({
      key,
      id: typeof id === "string" && id.length <= ID_MAX ? id : "",
      name: nick || "Mate",
      x,
      y,
      alive: alive !== false,
    });
  }
  return out;
}

interface Track {
  view: PartyMateView;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  t0: number;
}

/**
 * The latest S2C.PARTY, smoothed: each mate glides from where it was drawn to its new position
 * over PARTY_LERP_MS (a jump > SNAP_PX or a death snaps). A mate missing from a message is gone;
 * everything is gone after PARTY_STALE_MS without a message. Colours stay with a mate's key.
 */
export class PartyTracker {
  private readonly tracks = new Map<string, Track>();
  private readonly colorOf = new Map<string, number>();
  private readonly out: PartyMateView[] = [];
  private lastAt = -Infinity;

  /** Feed one S2C.PARTY message received at `now` (performance.now()). False if it was malformed. */
  ingest(raw: unknown, now: number): boolean {
    const mates = parsePartyMsg(raw);
    if (!mates) return false;
    this.lastAt = now;
    const seen = new Set<string>();
    for (const m of mates) {
      seen.add(m.key);
      const t = this.tracks.get(m.key);
      if (!t) {
        const view: PartyMateView = { key: m.key, id: m.id, name: m.name, x: m.x, y: m.y, alive: m.alive, color: 0 };
        this.tracks.set(m.key, { view, fromX: m.x, fromY: m.y, toX: m.x, toY: m.y, t0: now });
        continue;
      }
      this.place(t, now);
      const snap = !m.alive || Math.hypot(m.x - t.view.x, m.y - t.view.y) > SNAP_PX;
      t.fromX = snap ? m.x : t.view.x;
      t.fromY = snap ? m.y : t.view.y;
      t.toX = m.x;
      t.toY = m.y;
      t.t0 = now;
      t.view.id = m.id;
      t.view.name = m.name;
      t.view.alive = m.alive;
    }
    for (const key of [...this.tracks.keys()]) if (!seen.has(key)) this.tracks.delete(key);
    for (const t of this.tracks.values()) t.view.color = this.colorFor(t.view.key);
    return true;
  }

  /** Mates at `now` (the array and its objects are reused: read them, do not keep them). */
  mates(now: number): readonly PartyMateView[] {
    this.out.length = 0;
    if (now - this.lastAt > PARTY_STALE_MS) return this.out;
    for (const t of this.tracks.values()) {
      this.place(t, now);
      this.out.push(t.view);
    }
    return this.out;
  }

  clear(): void {
    this.tracks.clear();
    this.out.length = 0;
    this.lastAt = -Infinity;
  }

  private place(t: Track, now: number): void {
    const k = Math.max(0, Math.min(1, (now - t.t0) / PARTY_LERP_MS));
    t.view.x = t.fromX + (t.toX - t.fromX) * k;
    t.view.y = t.fromY + (t.toY - t.fromY) * k;
  }

  /** The mate's colour: kept for the raid when still free, else the first one no current mate uses. */
  private colorFor(key: string): number {
    const used = new Set<number>();
    for (const t of this.tracks.values()) {
      if (t.view.key === key) continue;
      const c = this.colorOf.get(t.view.key);
      if (c !== undefined) used.add(c);
    }
    let c = this.colorOf.get(key);
    if (c === undefined || used.has(c)) {
      c = 0;
      while (used.has(c) && c < MATE_COLORS.length - 1) c++;
      this.colorOf.set(key, c);
    }
    return MATE_COLORS[c]!;
  }
}

/** Screen-edge margins of the off-screen arrows (CSS px). */
export interface EdgeInsets {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** A screen rect the arrows keep out of (the minimap). */
export interface ScreenRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Where the off-screen arrow toward screen point (sx, sy) sits: on the inset screen rect, along the
 * ray from the rect's centre, pointing at `angle`. A point that would land inside an `avoid` rect
 * (the minimap in the top-right corner; on touch also the top stack and the bottom bar) slides along
 * its edge to just past it, to the nearer side that stays on the edge. `onScreen`: the point is on
 * screen (≥ `pad` px inside) and needs no arrow.
 */
export function edgeAnchor(
  w: number,
  h: number,
  sx: number,
  sy: number,
  ins: EdgeInsets,
  avoid: ScreenRect | readonly ScreenRect[] | null = null,
  pad = 12,
): { x: number; y: number; angle: number; onScreen: boolean } {
  const x0 = ins.left, x1 = w - ins.right, y0 = ins.top, y1 = h - ins.bottom;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const angle = Math.atan2(sy - cy, sx - cx);
  if (sx >= pad && sx <= w - pad && sy >= pad && sy <= h - pad) return { x: sx, y: sy, angle, onScreen: true };
  const dx = sx - cx;
  const dy = sy - cy;
  let t = Infinity;
  if (dx > 1e-9) t = Math.min(t, (x1 - cx) / dx);
  else if (dx < -1e-9) t = Math.min(t, (x0 - cx) / dx);
  if (dy > 1e-9) t = Math.min(t, (y1 - cy) / dy);
  else if (dy < -1e-9) t = Math.min(t, (y0 - cy) / dy);
  if (!Number.isFinite(t)) t = 0;
  let x = cx + dx * t;
  let y = cy + dy * t;
  const rects = !avoid ? [] : Array.isArray(avoid) ? (avoid as readonly ScreenRect[]) : [avoid as ScreenRect];
  // A slide can land in a neighbouring rect: a few passes settle it (rects that leave no room on
  // the edge keep the arrow where it was).
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (const r of rects) {
      if (x <= r.x0 || x >= r.x1 || y <= r.y0 || y >= r.y1) continue;
      const side = Math.abs(x - x1) < 1e-6 || Math.abs(x - x0) < 1e-6;
      const lo = side ? y0 : x0;
      const hi = side ? y1 : x1;
      const at = side ? y : x;
      const a = side ? r.y0 : r.x0;
      const b = side ? r.y1 : r.x1;
      // The nearer way out that stays on the edge: the minimap (top-right) sends a right-edge
      // arrow below it and a top-edge arrow left of it.
      const ok = [a, b].filter((v) => v >= lo && v <= hi).sort((p, q) => Math.abs(p - at) - Math.abs(q - at));
      if (ok.length === 0) continue;
      if (side) y = ok[0]!;
      else x = ok[0]!;
      moved = true;
    }
    if (!moved) break;
  }
  return { x, y, angle, onScreen: false };
}

/** "Name · 34 m" toward a living mate, "Name · down" at a fallen one. */
export function mateLabel(name: string, distPx: number, alive: boolean): string {
  if (!alive) return `${name} · down`;
  return `${name} · ${Math.max(1, Math.round(distPx / PX_PER_METER))} m`;
}

// ---------------------------------------------------------------------------------------------
// World markers (GameSystem)
// ---------------------------------------------------------------------------------------------

const FONT = "ui-rounded, 'Trebuchet MS', system-ui, sans-serif";
/** Off-screen arrows keep this far from the screen edges (CSS px). */
const ARROW_INSETS: EdgeInsets = { left: 26, right: 26, top: 26, bottom: 30 };
/**
 * Touch: the top edge runs below the HUD v3 top row (menu chips, ping, wipe pill, XP chip, extract
 * pill: 40 px from top-2), so an arrow and its label never sit on them.
 */
const ARROW_INSETS_TOUCH: EdgeInsets = { ...ARROW_INSETS, top: 64 };
/** Touch HUD areas an arrow slides out of are widened by this much (CSS px) for its centred label. */
const ARROW_LABEL_HALF = 56;

/**
 * The screen rects the arrows keep out of: the minimap; on touch also the top stack (wipe / boss toasts)
 * and the bottom bar (touch-controls.ts hudReservedRects), widened for the label.
 */
export function arrowObstacles(w: number, h: number, touch: boolean, ins: SafeInsets = NO_INSETS): ScreenRect[] {
  // The canvas is full-bleed; the HUD lives in the safe area (safe-area.ts), ins.left px in.
  const l = ins.left;
  const sw = Math.max(0, w - ins.left - ins.right);
  const mm = minimapSize(sw, h);
  const out: ScreenRect[] = [{ x0: l + sw - mm - MINIMAP_MARGIN - 14, y0: 0, x1: w, y1: mm + MINIMAP_MARGIN + 14 }];
  if (!touch) return out;
  for (const r of hudReservedRects(sw, h)) {
    if (r.soft || (r.id !== "top" && r.id !== "bar")) continue;
    out.push({ x0: l + r.x - ARROW_LABEL_HALF, y0: r.y, x1: l + r.x + r.w + ARROW_LABEL_HALF, y1: r.y + r.h });
  }
  return out;
}

/** The arrows' edge margins pushed in by the safe-area insets (the canvas is full-bleed). */
export function arrowInsets(base: EdgeInsets, ins: SafeInsets): EdgeInsets {
  return { left: base.left + ins.left, right: base.right + ins.right, top: base.top + ins.top, bottom: base.bottom + ins.bottom };
}
/** The arrow's label sits this far inward of its tip. */
const ARROW_LABEL_PX = 30;
/** lastSeen(id).at this recent = the mate's entity is drawn this frame (in the client's view). */
const IN_VIEW_MS = 120;

type MarkMode = "chevron" | "ghost" | "down" | "arrow";

interface MateMark {
  root: Container;
  chevron: Graphics;
  ghost: Graphics;
  down: Graphics;
  arrow: Graphics;
  label: Text;
  color: number;
}

function makeMark(parent: Container): MateMark {
  const root = new Container();
  root.eventMode = "none";
  // Drawn white and tinted per mate, so a colour change never re-tessellates.
  const chevron = new Graphics().poly([-9, -6, 0, 3, 9, -6, 9, 0, 0, 9, -9, 0]).fill({ color: 0xffffff }).stroke({ width: 2, color: 0x0b0b0b, alpha: 0.85 });
  const ghost = new Graphics()
    .circle(0, 0, PLAYER.RADIUS + 6)
    .fill({ color: 0xffffff, alpha: 0.12 })
    .stroke({ width: 3, color: 0xffffff, alpha: 0.9 });
  const down = new Graphics()
    .moveTo(-9, -9)
    .lineTo(9, 9)
    .moveTo(9, -9)
    .lineTo(-9, 9)
    .stroke({ width: 7, color: 0x0b0b0b, alpha: 0.7, cap: "round" })
    .moveTo(-9, -9)
    .lineTo(9, 9)
    .moveTo(9, -9)
    .lineTo(-9, 9)
    .stroke({ width: 4, color: 0xffffff, cap: "round" });
  // Points along +x; rotated toward the mate.
  const arrow = new Graphics().poly([14, 0, -8, -10, -3, 0, -8, 10]).fill({ color: 0xffffff }).stroke({ width: 2.5, color: 0x0b0b0b, alpha: 0.9 });
  const label = new Text({
    text: "",
    style: { fontFamily: FONT, fontSize: 13, fontWeight: "800", fill: 0xffffff, stroke: { color: 0x0b0b0b, width: 4 } },
    resolution: 2,
  });
  label.anchor.set(0.5, 1);
  root.addChild(ghost, down, chevron, arrow, label);
  parent.addChild(root);
  return { root, chevron, ghost, down, arrow, label, color: -1 };
}

function showMode(mk: MateMark, mode: MarkMode) {
  mk.chevron.visible = mode === "chevron";
  mk.ghost.visible = mode === "ghost";
  mk.down.visible = mode === "down";
  mk.arrow.visible = mode === "arrow";
}

/**
 * Party mates in the world (module comment): screen layer, above the fog, under the full map.
 * Reads ctx.partyMates() (renderer: PartyTracker), ctx.lastSeen() (is the mate's entity in view),
 * ctx.toScreen(), ctx.camera(), ctx.selfPos().
 */
export function createPartySystem(): GameSystem {
  let root: Container | null = null;
  const marks = new Map<string, MateMark>();
  const live = new Set<string>();
  let disposed = false;
  const touch = shouldUseTouch();
  let avoidFor: { w: number; h: number; safe: SafeInsets | null; rects: ScreenRect[]; ins: EdgeInsets } = {
    w: -1,
    h: -1,
    safe: null,
    rects: [],
    ins: ARROW_INSETS,
  };

  return {
    id: "party",
    init(ctx) {
      root = new Container();
      root.label = "party";
      root.eventMode = "none";
      root.interactiveChildren = false;
      ctx.layers.screen.addChild(root);
    },
    frame(_dt, ctx: GameContext) {
      if (!root || disposed) return;
      // The death replay shows the past: live mate markers would sit beside their replayed sprites.
      const mates = ctx.view?.() === "replay" ? [] : (ctx.partyMates?.() ?? []);
      live.clear();
      if (mates.length > 0) {
        const cam = ctx.camera();
        const w = cam.width;
        const h = cam.height;
        const now = performance.now();
        const me = ctx.selfPos();
        const safe = safeInsets();
        if (avoidFor.w !== w || avoidFor.h !== h || avoidFor.safe !== safe) {
          avoidFor = { w, h, safe, rects: arrowObstacles(w, h, touch, safe), ins: arrowInsets(touch ? ARROW_INSETS_TOUCH : ARROW_INSETS, safe) };
        }
        const avoid = avoidFor.rects;
        for (const m of mates) {
          live.add(m.key);
          let mk = marks.get(m.key);
          if (!mk) {
            mk = makeMark(root);
            marks.set(m.key, mk);
          }
          if (mk.color !== m.color) {
            mk.color = m.color;
            mk.chevron.tint = mk.ghost.tint = mk.down.tint = mk.arrow.tint = m.color;
            mk.label.style.fill = m.color;
          }
          // The mate's entity is drawn this frame: mark it where it is drawn (no lag).
          const seen = m.id ? ctx.lastSeen(m.id) : null;
          const inView = !!seen && m.alive && now - seen.at <= IN_VIEW_MS;
          const wx = inView ? seen!.x : m.x;
          const wy = inView ? seen!.y : m.y;
          const s = ctx.toScreen(wx, wy);
          const a = edgeAnchor(w, h, s.x, s.y, avoidFor.ins, avoid);
          mk.root.visible = true;
          if (a.onScreen) {
            const mode: MarkMode = !m.alive ? "down" : inView ? "chevron" : "ghost";
            showMode(mk, mode);
            mk.root.position.set(s.x, s.y);
            const head = (PLAYER.RADIUS + 34) * cam.zoom;
            mk.chevron.position.set(0, -head - 4);
            mk.ghost.scale.set(cam.zoom);
            // A mate in view already wears their own name tag (the entity's).
            mk.label.visible = mode !== "chevron";
            if (mk.label.visible) {
              const text = mode === "down" ? mateLabel(m.name, 0, false) : m.name;
              if (mk.label.text !== text) mk.label.text = text;
              mk.label.position.set(0, mode === "ghost" ? -(PLAYER.RADIUS + 10) * cam.zoom : -14);
            }
          } else {
            showMode(mk, "arrow");
            mk.root.position.set(a.x, a.y);
            mk.arrow.rotation = a.angle;
            mk.label.visible = true;
            const text = mateLabel(m.name, Math.hypot(wx - me.x, wy - me.y), m.alive);
            if (mk.label.text !== text) mk.label.text = text;
            // Inward of the tip, nudged so the text never crosses the screen edge.
            const lx = -Math.cos(a.angle) * ARROW_LABEL_PX;
            const ly = -Math.sin(a.angle) * ARROW_LABEL_PX + 8;
            const half = mk.label.width / 2 + 4;
            const gx = Math.max(safe.left + half, Math.min(w - safe.right - half, a.x + lx)) - a.x;
            mk.label.position.set(gx, ly);
          }
          mk.root.alpha = m.alive ? 1 : 0.75;
        }
      }
      for (const [key, mk] of marks) {
        if (live.has(key)) continue;
        mk.root.destroy({ children: true });
        marks.delete(key);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      marks.clear();
      root?.destroy({ children: true });
      root = null;
    },
  };
}
