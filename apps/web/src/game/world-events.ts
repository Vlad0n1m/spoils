/**
 * WORLD v6 map events on the client (GameSystem; server: game-server sim/world-events.ts, rules:
 * @extract/shared world-events.ts):
 * - supply drop: the announced zone circle on the ground, a landing dust burst, the flare and a
 *   smoke column over the crate while the flare burns (the crate itself is a Corpse "sd<n>" drawn by
 *   entities.ts CorpseView);
 * - hot zone: the POI outline on the ground while announced / active;
 * - toasts for every transition and a status list under the minimap with countdowns;
 * - feeds worldEventsView (world-events-marks.ts) for the minimap / full map markers, including
 *   the per-listener fight signals (EventsMsg.fight) and the full-map heat (BattleState.heat).
 * Reads BattleState.wev / .heat and EventsMsg.fight only: every position drawn here is a public
 * world fact or a quantized server signal.
 */

import { Assets, Container, Graphics, Sprite, Text, Texture } from "pixi.js";
import { WEV_KIND, WEV_STATE, decodeFight, type EventsMsg, type MapData, type WorldEvent } from "@extract/shared";
import { AudioEngine } from "./audio/engine";
import { MINIMAP_MARGIN, minimapSize } from "./minimap";
import type { GameContext, GameSystem } from "./systems";
import {
  DROP_COLOR,
  FIGHT_MARK_MS,
  HOT_COLOR,
  mmss,
  resetWorldEventsView,
  setHeat,
  worldEventsView,
  type WevDropView,
  type WevHotView,
} from "./world-events-marks";

const FONT = "ui-rounded, 'Trebuchet MS', system-ui, sans-serif";

/** Event toast timing (ms). */
const TOAST = { IN: 220, HOLD: 3600, OUT: 600 } as const;

export interface ToastMsg {
  title: string;
  sub: string;
  color: number;
}

/** The toast for a world event reaching `state` (null = nothing to say). Pure (tests). */
export function wevToast(kind: number, state: number, zone: string, at: number, until: number, clock: number, wasActive = false): ToastMsg | null {
  const where = zone || "the map";
  if (kind === WEV_KIND.DROP) {
    if (state === WEV_STATE.ANNOUNCED) return { title: "SUPPLY DROP INBOUND", sub: `${where} · lands in ${mmss(at - clock)}`, color: DROP_COLOR };
    if (state === WEV_STATE.ACTIVE) return { title: "SUPPLY DROP LANDED", sub: `${where} · follow the smoke`, color: DROP_COLOR };
    return null;
  }
  if (kind === WEV_KIND.HOT) {
    if (state === WEV_STATE.ANNOUNCED) return { title: "HOT ZONE SOON", sub: `${where} · in ${mmss(at - clock)} · loot refill · ×1.5 container XP`, color: HOT_COLOR };
    if (state === WEV_STATE.ACTIVE) return { title: "HOT ZONE ACTIVE", sub: `${where} · containers refilled · ×1.5 XP · ${mmss(until - clock)}`, color: HOT_COLOR };
    if (state === WEV_STATE.DONE && wasActive) return { title: "HOT ZONE OVER", sub: where, color: 0xc9ced6 };
  }
  return null;
}

/** Status line of one event under the minimap (null = not listed). Pure (tests). */
export function wevStatusLine(kind: number, state: number, zoneName: string, at: number, until: number, clock: number): string | null {
  if (state === WEV_STATE.DONE) return null;
  const zone = zoneName || "open ground";
  if (kind === WEV_KIND.DROP) return state === WEV_STATE.ANNOUNCED ? `Supply drop · ${zone} · ${mmss(at - clock)}` : `Supply drop · ${zone} · landed`;
  if (kind === WEV_KIND.HOT) return state === WEV_STATE.ANNOUNCED ? `Hot zone · ${zone} · in ${mmss(at - clock)}` : `Hot zone · ${zone} · ${mmss(until - clock)}`;
  return null;
}

/** Toast top (screen px): under the zone toast. */
export function eventToastY(screenH: number): number {
  return screenH < 480 ? 176 : Math.round(screenH * 0.27);
}

interface Puff {
  s: Sprite;
  born: number;
  life: number;
  vx: number;
  vy: number;
  x: number;
  y: number;
}

class EventToast {
  readonly root = new Container();
  private readonly bar = new Graphics();
  private readonly title: Text;
  private readonly sub: Text;
  private shownAt = -Infinity;
  private readonly queue: ToastMsg[] = [];

  constructor() {
    this.title = new Text({ text: "", style: { fontFamily: FONT, fontSize: 24, fontWeight: "900", fill: 0xffffff, stroke: { color: 0x101010, width: 5 }, letterSpacing: 2 } });
    this.sub = new Text({ text: "", style: { fontFamily: FONT, fontSize: 14, fontWeight: "800", fill: 0xffffff, stroke: { color: 0x101010, width: 4 }, letterSpacing: 1 } });
    this.title.anchor.set(0.5, 0);
    this.sub.anchor.set(0.5, 0);
    this.sub.y = 32;
    this.root.addChild(this.bar, this.title, this.sub);
    this.root.visible = false;
    this.root.eventMode = "none";
  }

  push(m: ToastMsg) {
    this.queue.push(m);
  }

  private show(m: ToastMsg, now: number) {
    this.title.text = m.title;
    this.title.style.fill = m.color;
    this.sub.text = m.sub;
    const w = Math.max(this.title.width, this.sub.width) + 44;
    this.bar.clear();
    this.bar.roundRect(-w / 2, -8, w, 66, 12).fill({ color: 0x120c06, alpha: 0.7 });
    this.bar.rect(-w / 2 + 14, 58, w - 28, 3).fill({ color: m.color, alpha: 0.95 });
    this.shownAt = now;
  }

  layout(w: number, h: number) {
    this.root.position.set(w / 2, eventToastY(h));
    this.root.scale.set(h < 480 ? 0.75 : 1);
  }

  frame(now: number) {
    const t = now - this.shownAt;
    const total = TOAST.IN + TOAST.HOLD + TOAST.OUT;
    if (t >= total && this.queue.length > 0) this.show(this.queue.shift()!, now);
    const u = now - this.shownAt;
    const a = u < 0 ? 0 : u < TOAST.IN ? u / TOAST.IN : u < TOAST.IN + TOAST.HOLD ? 1 : u < total ? 1 - (u - TOAST.IN - TOAST.HOLD) / TOAST.OUT : 0;
    this.root.visible = a > 0;
    this.root.alpha = a;
  }
}

class WorldEventsSystem implements GameSystem {
  readonly id = "world-events";
  private built = false;
  private mapRef: MapData | null = null;
  private readonly ground = new Graphics();
  private readonly top = new Container();
  private readonly flare = new Graphics();
  private readonly puffLayer = new Container();
  private readonly toast = new EventToast();
  private readonly status = new Container();
  private readonly statusLines: Text[] = [];
  private smoke: Texture | null = null;
  private readonly puffs: Puff[] = [];
  private readonly free: Sprite[] = [];
  private readonly lastPuff = new Map<string, number>();
  /** Last seen state per event key (transitions → toasts). */
  private readonly seen = new Map<string, number>();
  private readonly wasActive = new Set<string>();
  /** Landing bursts: key → performance.now() of the landing seen live. */
  private readonly bursts = new Map<string, number>();
  private eng: AudioEngine | null = null;
  private size = { w: 0, h: 0 };
  private disposed = false;

  init(ctx: GameContext) {
    resetWorldEventsView();
    try {
      this.eng = AudioEngine.get();
    } catch {
      this.eng = null;
    }
    void Assets.load<Texture>("/sprites/smoke.png").then((t) => {
      if (!this.disposed) this.smoke = t;
    }).catch(() => undefined);
    this.top.addChild(this.flare, this.puffLayer);
    this.status.eventMode = "none";
    ctx.layers.ground.addChild(this.ground);
    ctx.layers.worldTop.addChild(this.top);
    ctx.layers.screen.addChild(this.status, this.toast.root);
    const cam = ctx.camera();
    this.resize(cam.width, cam.height);
    this.built = true;
  }

  resize(w: number, h: number) {
    this.size = { w, h };
    this.toast.layout(w, h);
  }

  onEvents(ev: EventsMsg, ctx: GameContext) {
    if (!ev.fight?.length) return;
    const now = performance.now();
    const at = ctx.selfPos();
    const v = worldEventsView;
    for (const f of decodeFight(ev.fight)) {
      v.fights = v.fights.filter((o) => o.a !== f.a || o.b !== f.b);
      v.fights.push({ a: f.a, b: f.b, until: now + FIGHT_MARK_MS, fromX: at.x, fromY: at.y });
    }
  }

  frame(dtMs: number, ctx: GameContext) {
    if (!this.built || this.disposed) return;
    const state = ctx.state();
    const map = ctx.map();
    if (!state || !map) return;
    if (map !== this.mapRef) {
      this.mapRef = map;
      this.seen.clear();
      this.wasActive.clear();
    }
    const now = performance.now();
    const clock = ctx.clockMs();
    const v = worldEventsView;
    v.clockMs = clock;
    setHeat(state.heat ?? "", map.width);
    const drops: WevDropView[] = [];
    const hots: WevHotView[] = [];
    const lines: string[] = [];
    state.wev?.forEach((e: WorldEvent, key: string) => {
      this.transition(key, e, clock, now);
      if (e.kind === WEV_KIND.DROP) drops.push({ key, state: e.state, x: e.x, y: e.y, r: e.r, at: e.at, until: e.until, zone: e.zone });
      else if (e.kind === WEV_KIND.HOT) {
        const z = map.zones.find((q) => q.id === e.zoneId);
        hots.push({ key, state: e.state, rect: z?.rect ?? null, x: e.x, y: e.y, at: e.at, until: e.until, zone: e.zone });
      }
      const line = wevStatusLine(e.kind, e.state, e.zone, e.at, e.until, clock);
      if (line) lines.push(line);
    });
    v.drops = drops;
    v.hots = hots;
    this.drawGround(drops, hots, now);
    this.drawFlares(drops, now, dtMs, ctx);
    this.drawStatus(lines);
    this.toast.frame(now);
  }

  private transition(key: string, e: WorldEvent, clock: number, now: number) {
    const prev = this.seen.get(key);
    if (prev === e.state) return;
    this.seen.set(key, e.state);
    if (e.state === WEV_STATE.ACTIVE) this.wasActive.add(key);
    // A drop that landed while we watched gets the dust burst (not one we joined into later).
    if (e.kind === WEV_KIND.DROP && e.state === WEV_STATE.ACTIVE && prev === WEV_STATE.ANNOUNCED) this.bursts.set(key, now);
    // A crate whose flare burnt out says nothing; neither does a drop seen for the first time as done.
    if (e.kind === WEV_KIND.DROP && e.state === WEV_STATE.DONE) return;
    const msg = wevToast(e.kind, e.state, e.zone, e.at, e.until, clock, prev === WEV_STATE.ACTIVE);
    if (!msg) return;
    this.toast.push(msg);
    this.eng?.play("boss_sting", { priority: 3, db: -10 });
  }

  private drawGround(drops: readonly WevDropView[], hots: readonly WevHotView[], now: number) {
    const g = this.ground;
    g.clear();
    const pulse = 0.5 + 0.5 * Math.sin(now / 260);
    for (const h of hots) {
      if (h.state === WEV_STATE.DONE || !h.rect) continue;
      const r = h.rect;
      const active = h.state === WEV_STATE.ACTIVE;
      g.roundRect(r.x, r.y, r.w, r.h, 24).stroke({ width: active ? 14 : 8, color: HOT_COLOR, alpha: active ? 0.35 + 0.25 * pulse : 0.3 });
    }
    for (const d of drops) {
      if (d.state !== WEV_STATE.ANNOUNCED) continue;
      g.circle(d.x, d.y, d.r).fill({ color: DROP_COLOR, alpha: 0.05 + 0.04 * pulse });
      // A dashed rim: 24 arcs.
      const n = 24;
      for (let i = 0; i < n; i += 1) {
        if (i % 2) continue;
        const a0 = (i / n) * Math.PI * 2 + now / 4000;
        const a1 = ((i + 1) / n) * Math.PI * 2 + now / 4000;
        g.moveTo(d.x + Math.cos(a0) * d.r, d.y + Math.sin(a0) * d.r).arc(d.x, d.y, d.r, a0, a1);
      }
      g.stroke({ width: 10, color: DROP_COLOR, alpha: 0.75 });
    }
    for (const [key, t0] of this.bursts) {
      const d = drops.find((q) => q.key === key);
      const u = (now - t0) / 700;
      if (!d || u >= 1) {
        this.bursts.delete(key);
        continue;
      }
      g.circle(d.x, d.y, 40 + 220 * u).stroke({ width: 10 * (1 - u), color: 0xd8c8a0, alpha: 0.8 * (1 - u) });
    }
  }

  /** Flare glow + smoke column over landed crates while the flare burns (only near the camera). */
  private drawFlares(drops: readonly WevDropView[], now: number, dtMs: number, ctx: GameContext) {
    const f = this.flare;
    f.clear();
    const cam = ctx.camera();
    const halfW = cam.width / (2 * cam.zoom) + 600;
    const halfH = cam.height / (2 * cam.zoom) + 900;
    const clock = worldEventsView.clockMs;
    for (const d of drops) {
      if (d.state !== WEV_STATE.ACTIVE || clock > d.until) continue;
      if (Math.abs(d.x - cam.x) > halfW || Math.abs(d.y - cam.y) > halfH) continue;
      const flick = 0.75 + 0.25 * Math.sin(now / 47) * Math.sin(now / 113);
      f.circle(d.x + 30, d.y - 26, 46 * flick).fill({ color: 0xff3020, alpha: 0.22 });
      f.circle(d.x + 30, d.y - 26, 16 * flick).fill({ color: 0xffd0a0, alpha: 0.9 });
      const last = this.lastPuff.get(d.key) ?? 0;
      if (this.smoke && now - last > 85 && this.puffs.length < 90) {
        this.lastPuff.set(d.key, now);
        const s = this.free.pop() ?? new Sprite(this.smoke);
        s.texture = this.smoke;
        s.anchor.set(0.5);
        this.puffLayer.addChild(s);
        this.puffs.push({ s, born: now, life: 4200 + Math.random() * 1400, vx: 10 + Math.random() * 16, vy: -(70 + Math.random() * 30), x: d.x + 30, y: d.y - 26 });
      }
    }
    const dt = Math.min(100, dtMs) / 1000;
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i]!;
      const u = (now - p.born) / p.life;
      if (u >= 1) {
        p.s.removeFromParent();
        this.free.push(p.s);
        this.puffs.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.s.position.set(p.x, p.y);
      const size = 70 + 260 * u;
      p.s.width = p.s.height = size;
      p.s.rotation = u * 2;
      // Red-orange flare smoke at the base, grey higher up.
      p.s.tint = u < 0.18 ? 0xff7a5a : u < 0.4 ? 0xf0c8b8 : 0xeeeeee;
      p.s.alpha = (u < 0.1 ? u / 0.1 : 1 - (u - 0.1) / 0.9) * 0.42;
    }
  }

  private drawStatus(lines: readonly string[]) {
    const { w, h } = this.size;
    if (w === 0) return;
    // Short landscape phones: left of the minimap (under it sit the touch action buttons).
    const short = h < 480;
    const mini = minimapSize(w, h);
    const top = short ? MINIMAP_MARGIN : MINIMAP_MARGIN + mini + 8;
    const right = short ? w - MINIMAP_MARGIN - mini - 8 : w - MINIMAP_MARGIN;
    while (this.statusLines.length < lines.length) {
      const t = new Text({ text: "", style: { fontFamily: FONT, fontSize: 13, fontWeight: "800", fill: 0xffffff, stroke: { color: 0x0b0b0b, width: 4 } } });
      t.anchor.set(1, 0);
      this.status.addChild(t);
      this.statusLines.push(t);
    }
    for (let i = 0; i < this.statusLines.length; i++) {
      const t = this.statusLines[i]!;
      const line = lines[i];
      t.visible = !!line;
      if (!line) continue;
      if (t.text !== line) t.text = line;
      t.style.fill = line.startsWith("Hot") ? 0xffb08a : 0xffd27a;
      t.scale.set(short ? 0.8 : 1);
      t.position.set(right, top + i * (short ? 14 : 18));
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.ground.destroy();
    this.top.destroy({ children: true });
    for (const s of this.free) s.destroy();
    this.status.destroy({ children: true });
    this.toast.root.destroy({ children: true });
    resetWorldEventsView();
  }
}

export function createWorldEventsSystem(): GameSystem {
  return new WorldEventsSystem();
}
