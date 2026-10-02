/**
 * Sound visualization (WP-S): a screen-space ring of arc markers around the local player for the
 * sounds the server sends in `ev.snd` — hidden sources at their quantized sector/band, visible
 * ones off screen or behind you at their exact direction. A behind-you marker gets a thicker arc
 * and one arrowhead (it pulses only right after a trigger). Every glyph sits on a dark badge
 * with a rim in the kind colour so it reads on any ground. The pure model lives in sound-ring.ts; this file only draws.
 *
 * Drawing budget: one Graphics for all arcs/chevrons, redrawn only while markers live (≤ 12), and a
 * small pool of icon Graphics that share one prebuilt white GraphicsContext per glyph and are
 * tinted — icons are never re-tessellated. The roll cooldown pie and the quiet icon are HUD (C2).
 */

import { Container, Graphics, GraphicsContext } from "pixi.js";
import { decodeSoundMsg, type EventsMsg } from "@extract/shared";
import { getSettings, subscribeSettings } from "./audio/settings";
import {
  RING,
  SoundIndicators,
  chevronAlpha,
  indicatorStyle,
  placeSounds,
  ringRadius,
  type PlacementEnv,
  type RingIcon,
} from "./sound-ring";
import type { GameContext, GameSystem } from "./systems";

/** Outline under every arc so white footsteps stay readable on sand, concrete and snow. */
const HALO = { color: 0x000000, alpha: 0.5, extra: 4 } as const;
/** Gap between the arc and its badge edge / chevron, css px. */
const ICON_GAP = 6;
/** One filled arrowhead per behind-you marker (two thin chevrons read as noise). */
const CHEVRON = { gap: 6, size: 11, width: 2 } as const;
/** Screen margin for "on screen" (a sprite half-way off the edge is still noticed). */
const ON_SCREEN_MARGIN = 16;
/** Badge under every glyph: dark disc + rim. White parts are tinted with the kind colour. */
const BADGE = { fill: 0x0d1117, fillAlpha: 0.82, rim: 2.5 } as const;

/**
 * Badge + white glyph centred at 0,0 (glyph inside ~ICON_PX, badge radius BADGE_R), tinted per kind:
 * the rim and the glyph take the kind colour, the dark disc stays dark, so every marker reads the
 * same way on bright concrete, grass or night ground. Each sound family gets its own silhouette:
 * footprints, muzzle burst, chest, flag, skull…
 */
function buildIcon(icon: RingIcon): GraphicsContext {
  const g = new GraphicsContext();
  const B = RING.BADGE_R;
  g.circle(0, 0, B).fill({ color: BADGE.fill, alpha: BADGE.fillAlpha });
  g.circle(0, 0, B - BADGE.rim / 2).stroke({ width: BADGE.rim, color: 0xffffff, alpha: 0.95 });
  const s = RING.ICON_PX / 2 - 1;
  switch (icon) {
    case "steps":
      // Two shoe prints, left one lower: sole + heel each.
      g.ellipse(-4.3, -1.2, 3.3, 5).circle(-4.3, 6, 2.5).fill(0xffffff);
      g.ellipse(4.3, -5.6, 3.3, 5).circle(4.3, 1.6, 2.5).fill(0xffffff);
      break;
    case "burst": {
      const pts: number[] = [];
      for (let i = 0; i < 16; i++) {
        const r = i % 2 === 0 ? s : s * 0.42;
        const a = (i / 16) * Math.PI * 2;
        pts.push(Math.cos(a) * r, Math.sin(a) * r);
      }
      g.poly(pts).fill(0xffffff);
      g.circle(0, 0, s * 0.22).fill(BADGE.fill);
      break;
    }
    case "swirl":
      g.arc(0, 0, s * 0.62, -Math.PI * 0.2, Math.PI * 1.35).stroke({ width: 3, color: 0xffffff, cap: "round" });
      g.poly([s * 0.5, -s * 0.85, s * 0.98, -s * 0.2, s * 0.2, -s * 0.22]).fill(0xffffff);
      break;
    case "cross":
      g.rect(-2.5, -s * 0.8, 5, s * 1.6).rect(-s * 0.8, -2.5, s * 1.6, 5).fill(0xffffff);
      break;
    case "mag":
      g.roundRect(-3.5, -s * 0.85, 7, s * 1.7, 2).fill(0xffffff);
      g.rect(-1.75, -s * 0.85 + 3, 3.5, 1.8).rect(-1.75, -1, 3.5, 1.8).fill(BADGE.fill);
      break;
    case "chest":
      // Box, lid seam and lock.
      g.roundRect(-s * 0.85, -s * 0.55, s * 1.7, s * 1.2, 2).fill(0xffffff);
      g.rect(-s * 0.85, -s * 0.12, s * 1.7, 1.8).fill(BADGE.fill);
      g.rect(-1.6, -s * 0.28, 3.2, 4.2).fill(BADGE.fill);
      break;
    case "flag":
      g.rect(-s * 0.6, -s * 0.85, 2.4, s * 1.75).fill(0xffffff);
      g.poly([-s * 0.4, -s * 0.85, s * 0.85, -s * 0.42, -s * 0.4, 0]).fill(0xffffff);
      break;
    case "drop":
      g.poly([0, -s * 0.95, s * 0.52, -s * 0.05, -s * 0.52, -s * 0.05]).fill(0xffffff);
      g.circle(0, s * 0.2, s * 0.55).fill(0xffffff);
      break;
    case "skull":
      g.circle(0, -1.5, s * 0.66).fill(0xffffff);
      g.rect(-s * 0.38, 2, s * 0.76, s * 0.5).fill(0xffffff);
      g.circle(-2.8, -2, 2).circle(2.8, -2, 2).fill(BADGE.fill);
      break;
  }
  return g;
}

export class SoundVizSystem implements GameSystem {
  readonly id = "sound-viz";
  readonly model = new SoundIndicators();
  private root: Container | null = null;
  private arcs: Graphics | null = null;
  private iconLayer: Container | null = null;
  private icons = new Map<RingIcon, GraphicsContext>();
  private pool: Graphics[] = [];
  private used = 0;
  private enabled = true;
  private unsubscribe: (() => void) | null = null;
  /** Whether the arc Graphics currently holds geometry (so an empty ring clears only once). */
  private drawn = false;

  /** Icons drawn in the last frame (tests, F3 overlay). */
  get shownMarkers(): number {
    return this.used;
  }

  init(c: GameContext) {
    this.root = new Container();
    this.root.label = "sound-ring";
    this.arcs = new Graphics();
    this.iconLayer = new Container();
    this.root.addChild(this.arcs, this.iconLayer);
    c.layers.screen.addChild(this.root);
    this.enabled = getSettings().visualize;
    this.unsubscribe = subscribeSettings((s) => {
      this.enabled = s.visualize;
      if (!s.visualize) this.model.clear();
    });
  }

  onEvents(ev: EventsMsg, c: GameContext) {
    if (!this.enabled || !this.root || !ev.snd) return;
    const sounds = decodeSoundMsg(ev.snd);
    if (sounds.length === 0) return;
    const now = performance.now();
    for (const m of placeSounds(sounds, this.placementEnv(c))) this.model.push(m, now);
  }

  frame(_dt: number, c: GameContext) {
    const root = this.root, g = this.arcs;
    if (!root || !g) return;
    const now = performance.now();
    if (!this.enabled || this.model.prune(now) === 0) {
      if (this.drawn) this.clearDrawing();
      return;
    }
    const p = c.selfPos();
    const s = c.toScreen(p.x, p.y);
    root.position.set(s.x, s.y);
    root.visible = true;
    const state = c.state();
    // Visible sources keep moving: re-aim their markers at the entity we render.
    if (state) {
      for (const m of this.model.list) {
        if (!m.id) continue;
        const pl = state.players.get(m.id);
        if (pl) m.angle = Math.atan2(pl.y - p.y, pl.x - p.x);
      }
    }
    const cam = c.camera();
    const R = ringRadius(cam.width, cam.height);
    const aim = c.aim();
    g.clear();
    this.used = 0;
    for (const m of this.model.list) {
      const st = indicatorStyle(m, now, aim);
      if (!st || st.alpha <= 0.01) continue;
      const half = (RING.ARC_SPAN / 2) * st.scale;
      const a0 = m.angle - half, a1 = m.angle + half;
      // Halo first, then the colored arc; occluded (muffled) ones are dashed.
      this.arc(g, R, a0, a1, st.width + HALO.extra, HALO.color, st.alpha * HALO.alpha, false);
      this.arc(g, R, a0, a1, st.width, m.color, st.alpha, m.occluded);
      const iconAlpha = st.iconAlpha;
      let edge = R + st.width / 2;
      if (st.behind) {
        // One arrowhead between the arc and the badge, pointing away from the player.
        const base = edge + CHEVRON.gap;
        this.chevron(g, m.angle, base, m.color, iconAlpha * chevronAlpha(now - m.born));
        edge = base + CHEVRON.size;
      }
      const iconR = edge + ICON_GAP + RING.BADGE_R;
      this.placeIcon(m.icon, m.color, Math.cos(m.angle) * iconR, Math.sin(m.angle) * iconR, iconAlpha, st.scale);
    }
    for (let i = this.used; i < this.pool.length; i++) this.pool[i]!.visible = false;
    this.drawn = true;
  }

  dispose() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.root?.destroy({ children: true });
    this.root = null;
    this.arcs = null;
    this.iconLayer = null;
    for (const ctx of this.icons.values()) ctx.destroy();
    this.icons.clear();
    this.pool = [];
    this.used = 0;
    this.model.clear();
  }

  private placementEnv(c: GameContext): PlacementEnv {
    const p = c.selfPos();
    const cam = c.camera();
    const state = c.state();
    return {
      selfId: c.room.sessionId,
      selfX: p.x,
      selfY: p.y,
      aim: c.aim(),
      playerPos: (id) => {
        const pl = state?.players.get(id);
        return pl ? { x: pl.x, y: pl.y } : null;
      },
      onScreen: (x, y) => {
        const s = c.toScreen(x, y);
        const m = ON_SCREEN_MARGIN;
        return s.x >= -m && s.y >= -m && s.x <= cam.width + m && s.y <= cam.height + m;
      },
    };
  }

  private arc(g: Graphics, R: number, a0: number, a1: number, width: number, color: number, alpha: number, dashed: boolean) {
    if (!dashed) {
      g.moveTo(Math.cos(a0) * R, Math.sin(a0) * R).arc(0, 0, R, a0, a1).stroke({ width, color, alpha, cap: "round" });
      return;
    }
    // Three dashes with gaps: reads as "muffled, through a wall".
    const n = 3, span = (a1 - a0) / (n * 2 - 1);
    for (let i = 0; i < n; i++) {
      const s0 = a0 + i * 2 * span;
      g.moveTo(Math.cos(s0) * R, Math.sin(s0) * R).arc(0, 0, R, s0, s0 + span).stroke({ width, color, alpha, cap: "butt" });
    }
  }

  /** A filled arrowhead pointing outward (towards the source) with its base at radius r. */
  private chevron(g: Graphics, angle: number, r: number, color: number, alpha: number) {
    const cx = Math.cos(angle), cy = Math.sin(angle);
    const tx = -cy, ty = cx; // tangent
    const half = CHEVRON.size * 0.8;
    const tipX = cx * (r + CHEVRON.size), tipY = cy * (r + CHEVRON.size);
    const pts = [cx * r + tx * half, cy * r + ty * half, tipX, tipY, cx * r - tx * half, cy * r - ty * half];
    g.poly(pts)
      .fill({ color, alpha })
      .stroke({ width: CHEVRON.width, color: HALO.color, alpha: alpha * 0.7, join: "round" });
  }

  private placeIcon(icon: RingIcon, color: number, x: number, y: number, alpha: number, scale: number) {
    if (!this.iconLayer) return;
    let ctx = this.icons.get(icon);
    if (!ctx) {
      ctx = buildIcon(icon);
      this.icons.set(icon, ctx);
    }
    let sprite = this.pool[this.used];
    if (!sprite) {
      sprite = new Graphics(ctx);
      this.pool.push(sprite);
      this.iconLayer.addChild(sprite);
    } else if (sprite.context !== ctx) {
      sprite.context = ctx;
    }
    this.used++;
    sprite.visible = true;
    sprite.tint = color;
    sprite.alpha = alpha;
    sprite.position.set(x, y);
    sprite.scale.set(scale);
  }

  private clearDrawing() {
    this.arcs?.clear();
    this.used = 0;
    for (const s of this.pool) s.visible = false;
    if (this.root) this.root.visible = false;
    this.drawn = false;
  }
}
