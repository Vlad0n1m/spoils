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
import { BOSSES, BOSS_FIGHT, BOSS_TELL, type BossKind, type EventsMsg, type MapData, type Player } from "@extract/shared";
import { AudioEngine, type Voice } from "./audio/engine";
import {
  BOSS_COLOR,
  BossAlertTracker,
  TENSION_REPEAT_MS,
  bossBeatText,
  heldBarBoss,
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
/** Boss fight beat toast under the bar ("FOREMAN IS ENRAGED"). */
const BEAT_MS = 2800;
const TELL_COLOR = 0xff3b30;

/**
 * Screen bar top: below the React HUD's top-centre stack (timer ≈ 12–58 px, extract compass
 * ≈ 68–106 px), its name label clear of the compass; the zone toast sits under it (fullmap.ts
 * zoneToastY). On a short landscape phone (< 480 px) the touch top stack is scaled to 80 % and the
 * compact compass ends at ~80 px (hud.tsx), so the name label sits just under it.
 */
export function bossBarY(screenH: number): number {
  return screenH < 480 ? 106 : 136;
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
  /** Player.bossPhase (1 / 2; 0 = an older server). */
  phase: number;
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
  /** Phase pips (two diamonds right of the bar); the second fills in phase 2. */
  private readonly pips = new Graphics();
  private phase = -1;
  private stale = false;
  private readonly beat: Text;
  private beatUntil = 0;
  private barShown = false;

  constructor() {
    this.name = new Text({
      text: "",
      style: { fontFamily: FONT, fontSize: 15, fontWeight: "900", fill: 0xffffff, stroke: { color: 0x101010, width: 4 }, letterSpacing: 3 },
    });
    this.name.anchor.set(0.5, 1);
    this.beat = new Text({
      text: "",
      style: { fontFamily: FONT, fontSize: 14, fontWeight: "900", fill: 0xffc93c, stroke: { color: 0x101010, width: 4 }, letterSpacing: 2 },
    });
    this.beat.anchor.set(0.5, 0);
    this.beat.visible = false;
    this.root.addChild(this.back, this.fill, this.skull, this.name, this.pips, this.beat);
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
    this.pips.position.set(w / 2 + 18, BAR_H / 2);
    this.beat.position.set(0, BAR_H + 10);
    this.phase = -1;
    this.root.position.set(Math.round(screenW / 2 + 9), bossBarY(screenH));
  }

  show(b: SeenBoss | null, nowMs: number, stale = false) {
    this.barShown = !!b;
    if (!b) {
      // Keep the "DOWN" banner (or a fight beat toast) up for a moment.
      this.root.visible = nowMs < this.downUntil || nowMs < this.beatUntil;
      return;
    }
    this.stale = stale;
    this.setPhase(b.phase);
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

  /** Two pips: phase 1 = first filled, phase 2 = both (drawn only on change). */
  private setPhase(phase: number) {
    if (phase === this.phase) return;
    this.phase = phase;
    const g = this.pips.clear();
    if (phase <= 0) return;
    for (let i = 0; i < 2; i++) {
      const x = i * 14;
      g.poly([x, -6, x + 5, 0, x, 6, x - 5, 0]);
      g.fill(i < phase ? { color: i === 1 ? 0xffc93c : BOSS_COLOR } : { color: 0x3a1414 });
      g.stroke({ width: 2, color: i < phase ? 0x101010 : BOSS_COLOR, alpha: i < phase ? 1 : 0.7 });
    }
  }

  /** A fight beat toast under the bar (shown even without the bar). */
  beatToast(text: string, nowMs: number) {
    this.beat.text = text;
    this.beat.visible = true;
    this.beatUntil = nowMs + BEAT_MS;
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
    this.root.alpha = this.downUntil > 0 ? Math.max(0, Math.min(1, (this.downUntil - nowMs) / 600)) : this.stale ? 0.6 : 1;
    if (this.beat.visible && nowMs >= this.beatUntil) this.beat.visible = false;
    // A toast alone (no boss in view, no banner): only the toast line shows.
    const barOn = this.barShown || this.downUntil > nowMs;
    this.back.visible = this.fill.visible = this.skull.visible = this.name.visible = this.pips.visible = barOn;
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
  /** Last boss the bar showed and when (BAR_HOLD_MS after it leaves view, if engaged). */
  private lastBar: { boss: SeenBoss; at: number } | null = null;
  /** Boss id → when the local player last hit it or was hit by it (performance.now()). */
  private readonly engaged = new Map<string, number>();
  /** World-space telegraphs of the bosses in view (charge lane, throw wind-up, radio call). */
  private tells: Graphics | null = null;

  init(ctx: GameContext): void {
    this.eng = AudioEngine.get();
    this.bar = new BossBar();
    ctx.layers.screen.addChild(this.bar.root);
    this.tells = new Graphics();
    this.tells.eventMode = "none";
    ctx.layers.worldTop.addChild(this.tells);
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
    const pick = heldBarBoss(pickBarBoss(this.seen, cam, reach), this.lastBar, (id) => this.engaged.get(id), now);
    if (pick && !pick.stale) this.lastBar = { boss: pick.boss, at: now };
    this.bar.show(pick?.boss ?? null, now, pick?.stale ?? false);
    this.bar.frame(dtMs, now);
    this.drawTells(ctx, now);
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
        this.seen.push({ id, kind: k.kind, x: p.x, y: p.y, hp: p.hp, maxHp: p.maxHp, armor: p.armor, armorDur: p.armorDur, phase: p.bossPhase ?? 0 });
      }
    });
    this.alert.prune(now);
  }

  /**
   * Telegraphs (Player.bossTell) of the bosses in view, drawn where the boss is drawn: the Warden's
   * charge lane along its locked aim (pulsing while it winds up, solid while it dashes), the
   * Foreman's wind-up ring before a throw (the grenade's own warning ring follows), the
   * Commander's radio arcs. Only bosses this client sees carry a tell at all.
   */
  private drawTells(ctx: GameContext, now: number) {
    const g = this.tells;
    if (!g) return;
    g.clear();
    const state = ctx.state();
    if (!state) return;
    const pulse = 0.5 + 0.5 * Math.sin(now / 70);
    for (const b of this.seen) {
      const p = state.players.get(b.id);
      if (!p || !p.alive || !p.bossTell) continue;
      const seen = ctx.lastSeen(b.id);
      const x = seen?.x ?? p.x;
      const y = seen?.y ?? p.y;
      const tell = p.bossTell;
      if (tell === BOSS_TELL.CHARGE || tell === BOSS_TELL.DASH) {
        const len = BOSS_FIGHT.WARDEN.MAX_PX;
        const ca = Math.cos(p.aim);
        const sa = Math.sin(p.aim);
        const w = 26;
        const nx = -sa * w;
        const ny = ca * w;
        const ex = x + ca * len;
        const ey = y + sa * len;
        const a = tell === BOSS_TELL.DASH ? 0.6 : 0.3 + 0.35 * pulse;
        g.poly([x + nx, y + ny, ex + nx * 0.6, ey + ny * 0.6, ex - nx * 0.6, ey - ny * 0.6, x - nx, y - ny])
          .fill({ color: TELL_COLOR, alpha: a })
          .stroke({ width: 3, color: 0xffd0c8, alpha: 0.55 + 0.35 * pulse });
        // Chevrons along the lane: "it is coming this way".
        for (let d = 90; d < len - 20; d += 110) {
          const cx = x + ca * d;
          const cy = y + sa * d;
          g.moveTo(cx - ca * 14 + nx * 0.5, cy - sa * 14 + ny * 0.5).lineTo(cx, cy).lineTo(cx - ca * 14 - nx * 0.5, cy - sa * 14 - ny * 0.5);
        }
        g.stroke({ width: 4, color: 0xffffff, alpha: 0.35 + 0.4 * pulse });
      } else if (tell === BOSS_TELL.THROW) {
        g.circle(x, y, 46 + 10 * pulse).stroke({ width: 5, color: 0xffa630, alpha: 0.85 });
        g.circle(x, y - 62, 11).fill({ color: 0xffa630, alpha: 0.9 }).stroke({ width: 3, color: 0x101010 });
      } else if (tell === BOSS_TELL.CALL) {
        for (let i = 0; i < 3; i++) {
          const r = 40 + ((now / 6 + i * 40) % 120);
          g.moveTo(x + Math.cos(-Math.PI * 0.8) * r, y + Math.sin(-Math.PI * 0.8) * r);
          g.arc(x, y, r, -Math.PI * 0.8, -Math.PI * 0.2).stroke({ width: 4, color: 0x7fd3ff, alpha: Math.max(0, 1 - (r - 40) / 120) });
        }
      }
    }
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
        // "Recently engaged" for the bar hold: we hit a boss, or a boss hit us.
        if (h.s === sid && h.t && this.known.get(h.t)?.role === "boss") this.engaged.set(h.t, now);
        if (h.t === sid && h.s && this.known.get(h.s)?.role === "boss") this.engaged.set(h.s, now);
        if (h.t !== sid || !h.s) continue;
        const k = this.known.get(h.s);
        const role = k?.role ?? npcRole(ctx.state()?.players.get(h.s)?.role);
        const sting = this.alert.shotBy(role, now);
        if (sting) this.sting(sting);
      }
    }
    if (ev.boss) {
      // Fight beats for the arena (server boss-fight.ts): a roar / the radio, and a toast.
      for (const b of ev.boss) {
        if (!(b.k in BOSSES)) continue;
        this.bar?.beatToast(bossBeatText(b.k, b.e), this.lastFrameAt || now);
        this.eng?.play(b.e === "phase2" ? "boss_roar" : "boss_radio", { priority: 5 });
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
        this.lastBar = null;
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopTension(0.3);
    this.bar?.destroy();
    this.bar = null;
    this.tells?.destroy();
    this.tells = null;
    this.engaged.clear();
    this.known.clear();
    this.seen.length = 0;
  }
}

/** GameSystem factory for the renderer registry (systems-registry.ts). */
export function createBossHudSystem(): GameSystem {
  return new BossHudSystem();
}
