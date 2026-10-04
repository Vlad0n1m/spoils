/**
 * Boss presentation system (loot economy v4): the screen boss bar ("FOREMAN" + a wide HP bar while
 * a boss is in view), the alert sting (first sighting of a boss / guard, or being shot by one) and
 * the music-less tension swell while you stand on a living boss's turf.
 *
 * Draws into ctx.layers.screen and plays through the shared AudioEngine; reads only GameContext
 * (state.players role / maxHp, the map's boss zones, own position). The scan over state.players runs
 * every SCAN_MS, the bar is eased per frame without re-tessellating unless its width changes.
 */

import { Container, Graphics, Text } from "pixi.js";
import { BOSSES, type BossKind, type EventsMsg, type MapData, type Player } from "@extract/shared";
import { AudioEngine, type Voice } from "./audio/engine";
import {
  BOSS_COLOR,
  BossAlertTracker,
  TENSION_REPEAT_MS,
  bossTurfAt,
  easeBar,
  hpFraction,
  kindOfNpc,
  liveBossTurf,
  npcRole,
  pickBarBoss,
  tensionKind,
  type NpcRole,
} from "./boss";
import { skullContext } from "./boss-icons";
import type { GameContext, GameSystem } from "./systems";

const FONT = "ui-rounded, 'Trebuchet MS', system-ui, sans-serif";
/** state.players scan period (sightings, bar target). */
const SCAN_MS = 150;
/** Width of the screen bar (CSS px, before the small-screen clamp). */
const BAR_W = 340;
/** Bar width on short screens (< 480 px tall, landscape phones). */
const BAR_W_SHORT = 260;
const BAR_H = 12;
/** "FOREMAN DOWN" banner on the bar after a known boss dies. */
const DOWN_MS = 3500;

/**
 * Screen bar top: below the React HUD's top-centre timer, above the zone toast (16% of h). On a
 * short landscape phone (< 480 px) also below the compact extract compass, which ends at ~70 px
 * there (the touch top stack is scaled to 80 %, hud.tsx).
 */
export function bossBarY(screenH: number): number {
  if (screenH < 480) return 96;
  return Math.round(Math.max(64, Math.min(118, screenH * 0.095)));
}

interface SeenBoss {
  id: string;
  kind: BossKind | null;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  armor: number;
  armorDur: number;
}

class BossBar {
  readonly root = new Container();
  private readonly back = new Graphics();
  private readonly fill = new Graphics();
  private readonly skull = new Graphics(skullContext(BOSS_COLOR, 11));
  private readonly name: Text;
  private shown = 1;
  private target = 1;
  private w = BAR_W;
  private fillKey = -1;
  private kind: BossKind | null = null;
  private downUntil = 0;

  constructor() {
    this.name = new Text({
      text: "",
      style: { fontFamily: FONT, fontSize: 15, fontWeight: "900", fill: 0xffffff, stroke: { color: 0x101010, width: 4 }, letterSpacing: 3 },
    });
    this.name.anchor.set(0.5, 1);
    this.root.addChild(this.back, this.fill, this.skull, this.name);
    this.root.visible = false;
    this.root.eventMode = "none";
    this.root.interactiveChildren = false;
  }

  layout(screenW: number, screenH: number) {
    // Short phones: a narrower bar (BAR_W_SHORT), so it covers less of the world.
    const w = Math.round(Math.max(180, Math.min(screenH < 480 ? BAR_W_SHORT : BAR_W, screenW * 0.42)));
    if (w !== this.w) {
      this.w = w;
      this.fillKey = -1;
    }
    this.back.clear();
    this.back.roundRect(-w / 2 - 4, -4, w + 8, BAR_H + 8, 6).fill({ color: 0x140606, alpha: 0.8 }).stroke({ width: 2, color: BOSS_COLOR, alpha: 0.7 });
    this.skull.position.set(-w / 2 - 18, BAR_H / 2);
    this.name.position.set(0, -6);
    this.root.position.set(Math.round(screenW / 2 + 9), bossBarY(screenH));
  }

  show(b: SeenBoss | null, nowMs: number) {
    if (!b) {
      // Keep the "DOWN" banner up for a moment after the kill.
      this.root.visible = nowMs < this.downUntil;
      return;
    }
    if (b.kind !== this.kind || !this.root.visible) {
      this.kind = b.kind;
      this.name.text = (b.kind ? BOSSES[b.kind].name : "Boss").toUpperCase();
      this.name.style.fill = 0xffffff;
      if (!this.root.visible) this.shown = hpFraction(b.hp, b.maxHp);
    }
    this.downUntil = 0;
    this.target = hpFraction(b.hp, b.maxHp);
    this.root.visible = true;
  }

  down(kind: BossKind | null, nowMs: number) {
    this.name.text = `${(kind ? BOSSES[kind].name : "Boss").toUpperCase()} DOWN`;
    this.name.style.fill = BOSS_COLOR;
    this.target = 0;
    this.downUntil = nowMs + DOWN_MS;
    this.root.visible = true;
  }

  frame(dtMs: number, nowMs: number) {
    if (!this.root.visible) return;
    this.shown = easeBar(this.shown, this.target, dtMs);
    // Redraw only when the drawn width changes by a pixel.
    const px = Math.round(this.w * this.shown);
    if (px !== this.fillKey) {
      this.fillKey = px;
      this.fill.clear();
      if (px > 0) this.fill.roundRect(-this.w / 2, 0, px, BAR_H, 4).fill({ color: BOSS_COLOR });
    }
    this.root.alpha = this.downUntil > 0 ? Math.max(0, Math.min(1, (this.downUntil - nowMs) / 600)) : 1;
  }

  destroy() {
    this.root.destroy({ children: true });
  }
}

class BossHudSystem implements GameSystem {
  readonly id = "boss-hud";
  private bar: BossBar | null = null;
  private eng: AudioEngine | null = null;
  private map: MapData | null = null;
  private readonly alert = new BossAlertTracker();
  /** NPC session id → (role, kind), learned while they were in view (kill attribution). */
  private readonly known = new Map<string, { role: NpcRole; kind: BossKind | null }>();
  private readonly dead = new Set<BossKind>();
  private readonly seen: SeenBoss[] = [];
  private nextScanAt = 0;
  private tensionFor: BossKind | null = null;
  private tensionVoice: Voice | null = null;
  private nextTensionAt = 0;
  private lastFrameAt = 0;
  private disposed = false;

  init(ctx: GameContext): void {
    this.eng = AudioEngine.get();
    this.bar = new BossBar();
    ctx.layers.screen.addChild(this.bar.root);
    const cam = ctx.camera();
    this.bar.layout(cam.width, cam.height);
  }

  resize(w: number, h: number): void {
    this.bar?.layout(w, h);
  }

  frame(dtMs: number, ctx: GameContext): void {
    if (this.disposed || !this.bar) return;
    const state = ctx.state();
    const map = ctx.map();
    if (!state || !map) return;
    this.map = map;
    const now = performance.now();
    this.lastFrameAt = now;

    if (now >= this.nextScanAt) {
      this.nextScanAt = now + SCAN_MS;
      this.scan(ctx, now);
    }
    const cam = ctx.camera();
    // Bosses roughly on screen (server LOS already filtered state.players).
    const reach = Math.max(cam.width, cam.height) / Math.max(0.1, cam.zoom) / 2 + 120;
    this.bar.show(pickBarBoss(this.seen, cam, reach), now);
    this.bar.frame(dtMs, now);
    this.tensionTick(ctx, map, now);
  }

  /** Who of the boss groups is in this client's view; sightings feed the alert sting. */
  private scan(ctx: GameContext, now: number) {
    const state = ctx.state()!;
    const map = this.map!;
    const selfId = ctx.room.sessionId;
    this.seen.length = 0;
    state.players.forEach((p: Player, id: string) => {
      if (id === selfId) return;
      const role = npcRole(p.role);
      if (!role) return;
      let k = this.known.get(id);
      if (!k) {
        k = { role, kind: kindOfNpc(p, map.bosses ?? []) };
        this.known.set(id, k);
      }
      if (!p.alive) return;
      const sting = this.alert.sight(id, role, k.kind, now);
      if (sting) this.sting(sting);
      if (role === "boss") {
        this.seen.push({ id, kind: k.kind, x: p.x, y: p.y, hp: p.hp, maxHp: p.maxHp, armor: p.armor, armorDur: p.armorDur });
      }
    });
    this.alert.prune(now);
  }

  private sting(role: NpcRole) {
    // A guard sighting is a notch quieter than the boss itself.
    this.eng?.play("boss_sting", { priority: 5, db: role === "boss" ? 0 : -4 });
  }

  private tensionTick(ctx: GameContext, map: MapData, now: number) {
    const me = ctx.me();
    const self = ctx.self();
    const alive = !!me && me.alive && (!self || self.extractedAt === 0);
    const pos = ctx.selfPos();
    // WORLD v6: only the live event boss's turf is tense (other boss spots stay empty all map).
    const turf = alive ? liveBossTurf(bossTurfAt(map, pos.x, pos.y), ctx.state()) : null;
    const want = tensionKind(turf, alive, this.dead);
    if (want !== this.tensionFor) {
      this.tensionFor = want;
      if (!want) this.stopTension(1.5);
      else this.nextTensionAt = now;
    }
    if (want && now >= this.nextTensionAt) {
      this.tensionVoice = this.eng?.play("boss_tension", { priority: 2 }) ?? null;
      this.nextTensionAt = now + TENSION_REPEAT_MS;
    }
  }

  private stopTension(fadeS: number) {
    this.tensionVoice?.stop(fadeS);
    this.tensionVoice = null;
  }

  onEvents(ev: EventsMsg, ctx: GameContext): void {
    if (this.disposed) return;
    const sid = ctx.room.sessionId;
    const now = performance.now();
    if (ev.hits) {
      for (const h of ev.hits) {
        if (h.t !== sid || !h.s) continue;
        const k = this.known.get(h.s);
        const role = k?.role ?? npcRole(ctx.state()?.players.get(h.s)?.role);
        const sting = this.alert.shotBy(role, now);
        if (sting) this.sting(sting);
      }
    }
    if (ev.kills) {
      for (const kill of ev.kills) {
        const k = this.known.get(kill.victimId);
        if (!k || k.role !== "boss") continue;
        if (k.kind) this.dead.add(k.kind);
        if (this.tensionFor && this.dead.has(this.tensionFor)) {
          this.tensionFor = null;
          this.stopTension(2.5);
        }
        this.bar?.down(k.kind, this.lastFrameAt || now);
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopTension(0.3);
    this.bar?.destroy();
    this.bar = null;
    this.known.clear();
    this.seen.length = 0;
  }
}

/** GameSystem factory for the renderer registry (systems-registry.ts). */
export function createBossHudSystem(): GameSystem {
  return new BossHudSystem();
}
