/**
 * Minimap in the top-right corner of the canvas (the React HUD keeps that corner free).
 * Shows map bounds, buildings, extraction points by state and the local player only —
 * never other players.
 */

import { Container, Graphics } from "pixi.js";
import type { MapData } from "@extract/shared";
import { COLORS } from "./assets";
import type { ExtractStatus } from "./entities";

/** Minimap is drawn at this size and scaled to the layout size. */
const BASE = 200;
const MARGIN = 16;

export class Minimap {
  readonly root = new Container();
  private readonly bg = new Graphics();
  private readonly dyn = new Graphics();
  private readonly me = new Graphics();
  private k = 1;

  constructor(map: MapData) {
    this.k = BASE / Math.max(map.width, map.height);
    const k = this.k;
    const g = this.bg;
    g.roundRect(-4, -4, map.width * k + 8, map.height * k + 8, 8).fill({ color: 0x0c120a, alpha: 0.72 });
    g.rect(0, 0, map.width * k, map.height * k).fill({ color: 0x3f6b33, alpha: 0.85 });
    for (const d of map.dirt) g.circle(d.x * k, d.y * k, d.r * k);
    g.fill({ color: 0x7a5a32, alpha: 0.45 });
    for (const t of map.trees) g.circle(t.x * k, t.y * k, Math.max(1.5, t.r * 2 * k));
    g.fill({ color: 0x24501f, alpha: 0.9 });
    for (const b of map.buildings) {
      g.rect(b.floor.x * k, b.floor.y * k, b.floor.w * k, b.floor.h * k);
    }
    g.fill({ color: COLORS.floorFill });
    for (const b of map.buildings) {
      g.rect(b.floor.x * k, b.floor.y * k, b.floor.w * k, b.floor.h * k);
    }
    g.stroke({ width: 1.5, color: COLORS.wallFill });
    g.rect(0, 0, map.width * k, map.height * k).stroke({ width: 2, color: 0xffffff, alpha: 0.5 });

    this.me.circle(0, 0, 9).fill({ color: 0xffffff, alpha: 0.25 });
    this.me.poly([10, 0, -6, -7, -3, 0, -6, 7]).fill({ color: 0xffffff }).stroke({ width: 2, color: 0x111111 });

    this.root.addChild(this.bg, this.dyn, this.me);
    this.root.eventMode = "none";
  }

  layout(screenW: number, screenH: number) {
    const size = Math.max(120, Math.min(200, Math.min(screenW, screenH) * 0.24));
    const s = size / BASE;
    this.root.scale.set(s);
    this.root.position.set(screenW - size - MARGIN, MARGIN);
  }

  update(
    extracts: Array<{ x: number; y: number; r: number; status: ExtractStatus }>,
    self: { x: number; y: number; aim: number } | null,
    nowMs: number,
  ) {
    const k = this.k;
    const g = this.dyn;
    g.clear();
    for (const e of extracts) {
      const color =
        e.status === "open" ? COLORS.extractOpen : e.status === "waiting" ? COLORS.extractWaiting : COLORS.extractClosed;
      const r = Math.max(5, e.r * k);
      const pulse = e.status === "open" ? 1 + 0.25 * Math.sin(nowMs / 250) : 1;
      g.circle(e.x * k, e.y * k, r * pulse).fill({ color, alpha: 0.35 }).stroke({ width: 2, color });
    }
    this.me.visible = !!self;
    if (self) {
      this.me.position.set(self.x * k, self.y * k);
      this.me.rotation = self.aim;
    }
  }

  destroy() {
    this.root.destroy({ children: true });
  }
}
