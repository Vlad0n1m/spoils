/**
 * Screen-space feedback and the two raid-ending beats (WP-I, immersion memo §4 P0.2, P0.4, P1.11,
 * P1.12). Three GameSystems, all drawing into `layers.screen`:
 *
 *  - hitmarker:  an X at the crosshair on every hit we deal (white, pale blue when armor ate it,
 *                red and bigger on a kill). The sound cue (hitmarker / kill_confirm) is already
 *                played by game-audio for the same events, so sight and sound land together.
 *  - low-hp:     a dark crimson edge vignette that thumps in time with the heartbeat game-audio
 *                plays below 35 HP (same `heartbeatFor` curve; the audio also muffles the mix). It
 *                sits on top of the HUD's static red inset glow and adds the pulse.
 *  - cinematic:  extraction — letterbox bars creep in over the last 3 s of the channel; on success
 *                the camera zooms to 1.3, the bars close, a white flash, an "EXTRACTED" stamp and
 *                the auto-sell total from S2C.OUTCOME. Death — the world desaturates (one
 *                ColorMatrixFilter on the world container, only after death: perf rule), a slow
 *                fade, the camera pans to the killer when we can see them, and a "KILLED BY" card.
 *
 * Every display object is created once in init; per frame only positions / alphas / scales are
 * written. Under reduced motion the camera moves are skipped (CameraRig) and the flash is capped.
 */

import { ColorMatrixFilter, Container, ImageSource, Rectangle, Sprite, Text, Texture } from "pixi.js";
import {
  MATCH,
  S2C,
  WEAPONS,
  zoneAt,
  type EventsMsg,
  type KillMsg,
  type OutcomeMsg,
  type WeaponId,
} from "@extract/shared";
import { LOW_HP } from "./audio/game-audio";
import { getSettings } from "./audio/settings";
import { getCameraRig, PointerTracker, reducedMotion } from "./camera";
import type { GameContext, GameSystem } from "./systems";
import { npcNameOf, npcRoleName, npcRoleOfLabel } from "./npc-labels";

const FONT = "ui-rounded, 'Trebuchet MS', system-ui, sans-serif";
/** HUD convention (hud.tsx PX_PER_METER). */
export const PX_PER_METER = 40;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (v: number) => {
  const k = clamp01(v);
  return k * k * (3 - 2 * k);
};

// ================================================================ hitmarker

export type HitmarkerKind = "hit" | "armor" | "kill";

export const HITMARKER = {
  HIT_MS: 260,
  KILL_MS: 560,
  ARM_LEN: 9,
  ARM_W: 2.5,
  KILL_ARM_LEN: 13,
  KILL_ARM_W: 3.5,
  TINT: { hit: 0xffffff, armor: 0x9fd8ff, kill: 0xff3b3b } as Record<HitmarkerKind, number>,
  /** A kill confirmed this soon after the hitmarker upgrades it instead of starting a new one. */
  UPGRADE_MS: 350,
} as const;

/**
 * Hitmarker pose at `age` ms: alpha, overall scale and the arm gap from the centre (px). Returns
 * false once it is over. Hits pop in big and shrink; kills hold, then spread out while fading.
 */
export function hitmarkerPose(age: number, kind: HitmarkerKind, out: { alpha: number; scale: number; gap: number }): boolean {
  if (age < 0) return false;
  if (kind === "kill") {
    if (age >= HITMARKER.KILL_MS) return false;
    const k = age / HITMARKER.KILL_MS;
    out.scale = 1 + 0.5 * Math.max(0, 1 - age / 90);
    out.alpha = age < 220 ? 1 : 1 - (age - 220) / (HITMARKER.KILL_MS - 220);
    out.gap = 8 + 8 * k;
    return true;
  }
  if (age >= HITMARKER.HIT_MS) return false;
  out.scale = 1 + 0.35 * Math.max(0, 1 - age / 70);
  out.alpha = age < 90 ? 1 : 1 - (age - 90) / (HITMARKER.HIT_MS - 90);
  out.gap = 6 + 2 * Math.max(0, 1 - age / 120);
  return true;
}

class HitmarkerSystem implements GameSystem {
  readonly id = "hitmarker";
  private root: Container | null = null;
  private arms: Sprite[] = [];
  private readonly pointer = new PointerTracker();
  private bornAt = Number.NEGATIVE_INFINITY;
  private kind: HitmarkerKind = "hit";
  private x = 0;
  private y = 0;
  private readonly pose = { alpha: 0, scale: 1, gap: 0 };

  init(ctx: GameContext): void {
    const root = new Container();
    root.label = "hitmarker";
    root.eventMode = "none";
    root.visible = false;
    for (let k = 0; k < 4; k++) {
      const s = new Sprite(Texture.WHITE);
      s.anchor.set(0, 0.5);
      s.rotation = Math.PI / 4 + (k * Math.PI) / 2;
      this.arms.push(s);
      root.addChild(s);
    }
    ctx.layers.screen.addChild(root);
    this.root = root;
    this.pointer.attach(ctx.app.canvas as HTMLCanvasElement);
  }

  onEvents(ev: EventsMsg, ctx: GameContext): void {
    if (!this.root) return;
    const sid = ctx.room.sessionId;
    const now = performance.now();
    let kind: HitmarkerKind | null = null;
    let hx = 0;
    let hy = 0;
    if (ev.hits) {
      for (const h of ev.hits) {
        if (!h || h.s !== sid || h.t === sid) continue;
        const k: HitmarkerKind = h.d > 0 ? "hit" : "armor";
        if (kind === null || (kind === "armor" && k === "hit")) kind = k;
        hx = h.x;
        hy = h.y;
      }
    }
    if (ev.kills) {
      for (const m of ev.kills) if (m && m.killerId === sid && m.victimId !== sid) kind = "kill";
    }
    if (!kind) return;
    if (kind === "kill" && this.kind !== "kill" && now - this.bornAt < HITMARKER.UPGRADE_MS) {
      // The kill lands a tick after the hit: upgrade the running marker in place.
      this.kind = "kill";
      this.bornAt = now;
      return;
    }
    this.kind = kind;
    this.bornAt = now;
    if (this.pointer.has) {
      this.x = this.pointer.x;
      this.y = this.pointer.y;
    } else if (ev.hits && ev.hits.length) {
      const cam = ctx.camera();
      this.x = cam.width / 2 + (hx - cam.x) * cam.zoom;
      this.y = cam.height / 2 + (hy - cam.y) * cam.zoom;
    }
  }

  frame(_dtMs: number, _ctx: GameContext): void {
    const root = this.root;
    if (!root) return;
    const age = performance.now() - this.bornAt;
    if (!hitmarkerPose(age, this.kind, this.pose)) {
      root.visible = false;
      return;
    }
    // Follow the cursor while it lives: the X stays on the crosshair.
    if (this.pointer.has) {
      this.x = this.pointer.x;
      this.y = this.pointer.y;
    }
    const kill = this.kind === "kill";
    const len = (kill ? HITMARKER.KILL_ARM_LEN : HITMARKER.ARM_LEN) * this.pose.scale;
    const w = kill ? HITMARKER.KILL_ARM_W : HITMARKER.ARM_W;
    const tint = HITMARKER.TINT[this.kind];
    root.visible = true;
    root.alpha = this.pose.alpha;
    root.position.set(this.x, this.y);
    for (const s of this.arms) {
      s.tint = tint;
      s.scale.set(len, w);
      s.position.set(Math.cos(s.rotation) * this.pose.gap, Math.sin(s.rotation) * this.pose.gap);
    }
  }

  dispose(): void {
    this.pointer.detach();
    this.root?.destroy({ children: true });
    this.root = null;
    this.arms = [];
  }
}

export function createHitmarkerSystem(): GameSystem {
  return new HitmarkerSystem();
}

// ================================================================ low HP

export const LOW_HP_FX = {
  /** Vignette alpha at full strength: resting level + the heartbeat thump on top. */
  BASE: 0.6,
  PULSE: 0.45,
  /** Pulse depth under reduced motion (the beat is still felt, just not flashed). */
  REDUCED_PULSE: 0.12,
  FADE_TAU_MS: 250,
} as const;

/** 0 at / above the heartbeat threshold (35 HP) → 1 at the floor (10 HP); 0 when dead. */
export function lowHpStrength(hp: number): number {
  if (!(hp > 0) || hp >= LOW_HP.threshold) return 0;
  return clamp01((LOW_HP.threshold - hp) / (LOW_HP.threshold - LOW_HP.floor));
}

/** Beat interval (ms) at `hp` — the same curve as game-audio's heartbeatFor, without allocating. */
export function heartbeatIntervalMs(hp: number): number {
  const t = lowHpStrength(hp);
  return LOW_HP.slowMs - (LOW_HP.slowMs - LOW_HP.fastMs) * t;
}

/** "Lub-dub" shape over one beat (phase 0..1): a strong thump at 0, a softer one at 0.2. */
export function heartbeatPulse(phase: number): number {
  const p = phase - Math.floor(phase);
  // Wrap-around distances so the thump at 0 also shows just before 1.
  const d0 = Math.min(p, 1 - p) / 0.06;
  const a = Math.abs(p - 0.2);
  const d1 = Math.min(a, 1 - a) / 0.06;
  return Math.min(1, Math.exp(-d0 * d0) + 0.6 * Math.exp(-d1 * d1));
}

class LowHpSystem implements GameSystem {
  readonly id = "low-hp";
  private sprite: Sprite | null = null;
  private tex: Texture | null = null;
  private phase = 0;
  private level = 0;

  init(ctx: GameContext): void {
    this.tex = makeVignetteTexture();
    const s = new Sprite(this.tex);
    s.label = "low-hp-vignette";
    s.eventMode = "none";
    s.visible = false;
    s.alpha = 0;
    ctx.layers.screen.addChild(s);
    this.sprite = s;
  }

  frame(dtMs: number, ctx: GameContext): void {
    const s = this.sprite;
    if (!s) return;
    const me = ctx.me();
    const self = ctx.self();
    const hp = me && me.alive && (!self || self.extractedAt === 0) ? me.hp : 0;
    const target = lowHpStrength(hp);
    this.level += (target - this.level) * (1 - Math.exp(-dtMs / LOW_HP_FX.FADE_TAU_MS));
    if (this.level < 0.005 && target === 0) {
      this.level = 0;
      s.visible = false;
      return;
    }
    if (target > 0) this.phase += dtMs / heartbeatIntervalMs(hp);
    if (this.phase > 1e6) this.phase -= Math.floor(this.phase);
    const depth = reducedMotion() ? LOW_HP_FX.REDUCED_PULSE : LOW_HP_FX.PULSE;
    const cam = ctx.camera();
    s.visible = true;
    s.alpha = Math.min(1, this.level * (LOW_HP_FX.BASE + depth * heartbeatPulse(this.phase)));
    s.width = cam.width;
    s.height = cam.height;
  }

  dispose(): void {
    this.sprite?.destroy();
    this.sprite = null;
    this.tex?.destroy(true);
    this.tex = null;
  }
}

export function createLowHpSystem(): GameSystem {
  return new LowHpSystem();
}

// ================================================================ cinematics

export const CINE = {
  /** Letterbox height (fraction of the screen) at the very end of the extract channel. */
  CHANNEL_BARS: 0.05,
  /** The bars start creeping in this long before the channel completes. */
  CHANNEL_LEAD_MS: 3000,
  EXTRACT_BARS: 0.11,
  EXTRACT_BARS_MS: 380,
  EXTRACT_ZOOM: 1.3,
  EXTRACT_ZOOM_TAU_MS: 500,
  FLASH: 0.55,
  FLASH_REDUCED: 0.15,
  FLASH_MS: 300,
  STAMP_AT_MS: 140,
  STAMP_MS: 260,
  EXTRACT_FADE: 0.3,
  EXTRACT_FADE_MS: 1200,
  DEATH_FADE: 0.5,
  DEATH_FADE_MS: 2500,
  DEATH_DESAT: 0.85,
  DEATH_DESAT_MS: 1500,
  DEATH_BARS: 0.08,
  DEATH_BARS_MS: 700,
  DEATH_CARD_AT_MS: 450,
  DEATH_CARD_MS: 600,
  DEATH_ZOOM: 1.1,
  DEATH_ZOOM_TAU_MS: 1400,
  /** Pan this share of the way to a visible killer, at most PAN_MAX_PX, after PAN_AT_MS. */
  PAN_SHARE: 0.75,
  PAN_MAX_PX: 650,
  PAN_AT_MS: 500,
  PAN_TAU_MS: 650,
} as const;

/** Letterbox fraction during the extract channel, from the time left (ms). */
export function channelBars(remainingMs: number): number {
  if (!(remainingMs < CINE.CHANNEL_LEAD_MS)) return 0;
  return CINE.CHANNEL_BARS * smooth(1 - Math.max(0, remainingMs) / CINE.CHANNEL_LEAD_MS);
}

/** Overshooting ease (stamp slam): 0 → 1 with a ~10% overshoot. */
export function easeOutBack(k: number): number {
  const t = clamp01(k) - 1;
  const c = 1.70158;
  return 1 + (c + 1) * t * t * t + c * t * t;
}

export interface CinePose {
  bars: number;
  fade: number;
  flash: number;
  stampAlpha: number;
  stampScale: number;
  desat: number;
  cardAlpha: number;
}

export function emptyPose(): CinePose {
  return { bars: 0, fade: 0, flash: 0, stampAlpha: 0, stampScale: 1, desat: 0, cardAlpha: 0 };
}

/** Extraction beat at `t` ms after extractedAt was seen. `fromBars` = channel bars at that moment. */
export function extractPose(t: number, fromBars: number, flashMax: number, out: CinePose): CinePose {
  const k = smooth(t / CINE.EXTRACT_BARS_MS);
  out.bars = fromBars + (CINE.EXTRACT_BARS - fromBars) * k;
  out.fade = CINE.EXTRACT_FADE * smooth(t / CINE.EXTRACT_FADE_MS);
  out.flash = t < CINE.FLASH_MS ? flashMax * (1 - t / CINE.FLASH_MS) : 0;
  const s = (t - CINE.STAMP_AT_MS) / CINE.STAMP_MS;
  out.stampAlpha = clamp01(s * 2);
  // Slams down from 2.2× to 1× with an overshoot.
  out.stampScale = s <= 0 ? 2.2 : 2.2 - 1.2 * easeOutBack(s);
  out.desat = 0;
  out.cardAlpha = clamp01((t - CINE.STAMP_AT_MS - CINE.STAMP_MS) / 250);
  return out;
}

/** Death beat at `t` ms after the death was seen. */
export function deathPose(t: number, out: CinePose): CinePose {
  out.bars = CINE.DEATH_BARS * smooth(t / CINE.DEATH_BARS_MS);
  out.fade = CINE.DEATH_FADE * smooth(t / CINE.DEATH_FADE_MS);
  out.flash = 0;
  out.stampAlpha = 0;
  out.stampScale = 1;
  out.desat = CINE.DEATH_DESAT * smooth(t / CINE.DEATH_DESAT_MS);
  out.cardAlpha = smooth((t - CINE.DEATH_CARD_AT_MS) / CINE.DEATH_CARD_MS);
  return out;
}

/** "1,240" (no Intl dependency in tests / old engines). */
export function formatCredits(n: number): string {
  const v = Math.max(0, Math.round(n));
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** The line under the EXTRACTED stamp. */
export function autosellLine(o: Pick<OutcomeMsg, "credits" | "guest" | "sold"> | null): string {
  if (!o) return "Settling the haul…";
  const cr = formatCredits(o.credits);
  if (o.guest) return o.credits > 0 ? `Junk worth ${cr} CR · sign up to keep it` : "Guest raid · nothing kept";
  if (o.credits > 0) return `+${cr} CR auto-sold`;
  return "Gear secured";
}

/**
 * Death card: "KILLED BY" / name / "Rifle · 34 m". An NPC killer (KillMsg.killerRole, NPC MODEL v5)
 * shows by its role name ("Marauder", "Elevator thug", "FOREMAN") with the zone where you fell
 * (`zone`, from this client's own map at the death position): "Marauder" / "Rifle · 12 m · Grain Elevator".
 */
export function killCard(
  kill: Pick<KillMsg, "killer" | "weapon" | "killerRole"> | null,
  distPx: number | null,
  zone = "",
): { kicker: string; name: string; sub: string } {
  if (!kill || !kill.killer) return { kicker: "YOU DIED", name: "K.I.A.", sub: "" };
  const parts: string[] = [];
  const w = kill.weapon && kill.weapon in WEAPONS ? WEAPONS[kill.weapon as WeaponId].name : "";
  if (w) parts.push(w);
  if (distPx !== null && Number.isFinite(distPx)) parts.push(`${Math.max(1, Math.round(distPx / PX_PER_METER))} m`);
  const npc = npcRoleName(kill.killerRole) ?? npcRoleOfLabel(kill.killer);
  if (npc && zone) parts.push(zone);
  return { kicker: "KILLED BY", name: npc ? npcNameOf(kill.killerRole, kill.killer) : kill.killer, sub: parts.join(" · ") };
}

/**
 * A last-seen position older than this (ms) is not where the killer stood at the kill (they shot
 * from outside our view): no distance, no pan.
 */
export const KILLER_SEEN_MS = 1000;

/**
 * Where the killer is for the KILLED BY card and the death cam: live from the state while they are
 * still in our view, else where this client last drew them, if that was just now. The server clears
 * a dead viewer's vision at once, so the patch that removes every other player lands before the
 * EV batch with our KillMsg — the state alone never has the killer by then.
 */
export function locateKiller(
  id: string,
  ctx: Pick<GameContext, "state" | "lastSeen">,
  now: number,
  out: { x: number; y: number },
): boolean {
  if (!id) return false;
  const live = ctx.state()?.players.get(id);
  if (live) {
    out.x = live.x;
    out.y = live.y;
    return true;
  }
  const seen = ctx.lastSeen(id);
  if (!seen || !(now - seen.at <= KILLER_SEEN_MS)) return false;
  out.x = seen.x;
  out.y = seen.y;
  return true;
}

/**
 * The local player just went down on the map. Not at a raid timeout: the server then sets
 * alive = false with phase "ended" and no kill (outcome "timeout", "Time's up" — not "YOU DIED").
 * A real kill on the last tick still starts the beat through its KillMsg (onEvents).
 */
export function diedNow(prevAlive: boolean | null, alive: boolean, phase: string | undefined): boolean {
  return prevAlive === true && !alive && phase !== "ended";
}

type CineMode = "idle" | "extracted" | "dead";

class CinematicSystem implements GameSystem {
  readonly id = "cinematic";
  private root: Container | null = null;
  private fade: Sprite | null = null;
  private barTop: Sprite | null = null;
  private barBottom: Sprite | null = null;
  private flash: Sprite | null = null;
  private stamp: Text | null = null;
  private credits: Text | null = null;
  private kicker: Text | null = null;
  private name: Text | null = null;
  private sub: Text | null = null;

  private mode: CineMode = "idle";
  private startedAt = 0;
  private fromBars = 0;
  private lastBars = 0;
  private prevExtractedAt = -1;
  private prevAlive: boolean | null = null;
  private outcome: OutcomeMsg | null = null;
  private creditsShown: OutcomeMsg | null | undefined = undefined;
  private kill: KillMsg | null = null;
  private killerId = "";
  /** The killer's position when the kill was seen (locateKiller), the pan target once they left the state. */
  private readonly killerAt = { x: 0, y: 0 };
  private hasKillerAt = false;
  private panning = false;
  private readonly pose = emptyPose();

  private world: Container | null = null;
  private desat: ColorMatrixFilter | null = null;
  private readonly area = new Rectangle();
  private offOutcome: (() => void) | null = null;

  init(ctx: GameContext): void {
    const root = new Container();
    root.label = "cinematic";
    root.eventMode = "none";
    const solid = (tint: number) => {
      const s = new Sprite(Texture.WHITE);
      s.tint = tint;
      s.visible = false;
      root.addChild(s);
      return s;
    };
    this.fade = solid(0x05070a);
    this.barTop = solid(0x000000);
    this.barBottom = solid(0x000000);
    this.flash = solid(0xffffff);
    const text = (size: number, fill: number, spacing: number, strokeW: number) => {
      const t = new Text({
        text: "",
        style: { fontFamily: FONT, fontSize: size, fontWeight: "900", fill, stroke: { color: 0x0a0a0a, width: strokeW }, letterSpacing: spacing },
      });
      t.anchor.set(0.5);
      t.visible = false;
      root.addChild(t);
      return t;
    };
    this.stamp = text(72, 0xc6f432, 6, 10);
    this.stamp.rotation = -0.06;
    this.credits = text(24, 0xffd43b, 1, 5);
    this.kicker = text(16, 0xff6b6b, 6, 4);
    this.name = text(44, 0xffffff, 1, 7);
    this.sub = text(18, 0xe8ecf2, 2, 4);
    ctx.layers.screen.addChild(root);
    this.root = root;
    this.world = ctx.layers.ground.parent ?? null;

    const off = ctx.room.onMessage(S2C.OUTCOME, (m: OutcomeMsg) => {
      if (m && typeof m === "object") this.outcome = m;
    }) as unknown;
    if (typeof off === "function") this.offOutcome = off as () => void;
  }

  onEvents(ev: EventsMsg, ctx: GameContext): void {
    if (!ev.kills) return;
    const sid = ctx.room.sessionId;
    for (const k of ev.kills) {
      if (!k || k.victimId !== sid) continue;
      // The state patch (alive = false) may have arrived first: then only fill in the killer.
      if (this.mode === "dead") {
        if (!this.kill) this.setKill(k, ctx);
      } else this.startDeath(k, ctx);
      return;
    }
  }

  frame(_dtMs: number, ctx: GameContext): void {
    if (!this.root) return;
    const now = performance.now();
    const self = ctx.self();
    const me = ctx.me();

    // Edge detection. The first observation only primes (a reconnect must not replay a beat).
    if (self) {
      if (this.prevExtractedAt === 0 && self.extractedAt > 0 && this.mode === "idle") this.startExtracted(now);
      this.prevExtractedAt = self.extractedAt;
    }
    if (me) {
      if (diedNow(this.prevAlive, me.alive, ctx.state()?.phase) && this.mode === "idle") this.startDeath(null, ctx);
      this.prevAlive = me.alive;
    }

    const cam = ctx.camera();
    const p = this.pose;
    if (this.mode === "extracted") {
      extractPose(now - this.startedAt, this.fromBars, getSettings().reduceFlashes ? CINE.FLASH_REDUCED : CINE.FLASH, p);
      if (this.creditsShown !== this.outcome) {
        this.creditsShown = this.outcome;
        this.credits!.text = autosellLine(this.outcome);
      }
    } else if (this.mode === "dead") {
      deathPose(now - this.startedAt, p);
      this.updatePan(now, ctx);
    } else {
      // Channel: bars creep in during the last seconds of the extract countdown.
      let bars = 0;
      if (self && self.extractStartedAt > 0 && self.extractedAt === 0 && me?.alive) {
        bars = channelBars(self.extractStartedAt + MATCH.EXTRACT_CHANNEL_MS - ctx.clockMs());
      }
      p.bars = bars;
      p.fade = p.flash = p.stampAlpha = p.desat = p.cardAlpha = 0;
      this.lastBars = bars;
    }
    this.apply(cam.width, cam.height, cam);
  }

  private startExtracted(now: number): void {
    this.mode = "extracted";
    this.startedAt = now;
    this.fromBars = this.lastBars;
    this.stamp!.text = "EXTRACTED";
    this.credits!.text = autosellLine(this.outcome);
    this.creditsShown = this.outcome;
    const rig = getCameraRig();
    rig?.clearFocus(300);
    rig?.zoomTo(CINE.EXTRACT_ZOOM, CINE.EXTRACT_ZOOM_TAU_MS);
  }

  private startDeath(kill: KillMsg | null, ctx: GameContext): void {
    if (this.mode === "dead") return;
    if (this.mode === "extracted") return;
    this.mode = "dead";
    this.startedAt = performance.now();
    this.panning = false;
    this.setKill(kill, ctx);
    getCameraRig()?.zoomTo(CINE.DEATH_ZOOM, CINE.DEATH_ZOOM_TAU_MS);
    // Desaturate the world: one ColorMatrixFilter, only now (no filters during gameplay).
    if (this.world && !this.desat) {
      try {
        const f = new ColorMatrixFilter();
        f.desaturate();
        f.alpha = 0;
        this.desat = f;
        this.world.filterArea = this.area;
        this.world.filters = [f];
      } catch (err) {
        console.error("[cinematic] desaturate failed", err);
        this.desat = null;
      }
    }
  }

  private setKill(kill: KillMsg | null, ctx: GameContext): void {
    this.kill = kill;
    this.killerId = kill?.killerId ?? "";
    let dist: number | null = null;
    this.hasKillerAt = locateKiller(this.killerId, ctx, performance.now(), this.killerAt);
    if (this.hasKillerAt) {
      const p = ctx.selfPos();
      dist = Math.hypot(this.killerAt.x - p.x, this.killerAt.y - p.y);
    }
    const map = ctx.map();
    const at = ctx.selfPos();
    const zone = map ? (zoneAt(map, at.x, at.y)?.name ?? "") : "";
    const card = killCard(kill, dist, zone);
    if (!this.kicker || !this.name || !this.sub) return;
    this.kicker.text = card.kicker;
    this.name.text = card.name;
    this.sub.text = card.sub;
  }

  /** Death cam: after a beat, ease the camera toward the killer (live, or where they stood at the kill). */
  private updatePan(now: number, ctx: GameContext): void {
    const rig = getCameraRig();
    if (!rig || !this.killerId || now - this.startedAt < CINE.PAN_AT_MS) return;
    // Live while the killer is still in our view; otherwise where we saw them at the kill.
    const k = ctx.state()?.players.get(this.killerId);
    if (k ? !k.alive : !this.hasKillerAt) {
      if (this.panning) rig.clearFocus(CINE.PAN_TAU_MS);
      this.panning = false;
      return;
    }
    const tx = k ? k.x : this.killerAt.x;
    const ty = k ? k.y : this.killerAt.y;
    const p = ctx.selfPos();
    let dx = (tx - p.x) * CINE.PAN_SHARE;
    let dy = (ty - p.y) * CINE.PAN_SHARE;
    const m = Math.hypot(dx, dy);
    if (m > CINE.PAN_MAX_PX) {
      dx *= CINE.PAN_MAX_PX / m;
      dy *= CINE.PAN_MAX_PX / m;
    }
    rig.focusTo(dx, dy, CINE.PAN_TAU_MS);
    this.panning = true;
  }

  private apply(w: number, h: number, cam: { x: number; y: number; zoom: number }): void {
    const p = this.pose;
    const bh = Math.round(p.bars * h);
    place(this.barTop!, bh > 0, 0, 0, w, bh, 1);
    place(this.barBottom!, bh > 0, 0, h - bh, w, bh, 1);
    place(this.fade!, p.fade > 0.003, 0, 0, w, h, p.fade);
    place(this.flash!, p.flash > 0.003, 0, 0, w, h, p.flash);

    const st = this.stamp!;
    st.visible = this.mode === "extracted" && p.stampAlpha > 0;
    if (st.visible) {
      st.alpha = p.stampAlpha;
      st.scale.set(p.stampScale);
      st.position.set(w / 2, h * 0.42);
    }
    const cr = this.credits!;
    cr.visible = this.mode === "extracted" && p.cardAlpha > 0;
    if (cr.visible) {
      cr.alpha = p.cardAlpha;
      cr.position.set(w / 2, h * 0.42 + 64);
    }
    const dead = this.mode === "dead" && p.cardAlpha > 0;
    const y0 = h * (1 - CINE.DEATH_BARS) - 118 + (1 - p.cardAlpha) * 12;
    placeText(this.kicker!, dead, w / 2, y0, p.cardAlpha);
    placeText(this.name!, dead, w / 2, y0 + 38, p.cardAlpha);
    placeText(this.sub!, dead && this.sub!.text !== "", w / 2, y0 + 80, p.cardAlpha);

    if (this.desat && this.world) {
      this.desat.alpha = p.desat;
      // Filter only the visible part of the world (bounds of the whole map would be huge).
      const z = cam.zoom > 0 ? cam.zoom : 1;
      const hw = w / 2 / z + 64;
      const hh = h / 2 / z + 64;
      this.area.x = cam.x - hw;
      this.area.y = cam.y - hh;
      this.area.width = hw * 2;
      this.area.height = hh * 2;
    }
  }

  dispose(): void {
    this.offOutcome?.();
    this.offOutcome = null;
    if (this.world && this.desat) {
      try {
        if (!this.world.destroyed) {
          this.world.filters = [];
          (this.world as { filterArea: Rectangle | undefined }).filterArea = undefined;
        }
      } catch {
        /* the world went first */
      }
    }
    this.desat?.destroy();
    this.desat = null;
    this.world = null;
    this.root?.destroy({ children: true });
    this.root = null;
    this.fade = this.barTop = this.barBottom = this.flash = null;
    this.stamp = this.credits = this.kicker = this.name = this.sub = null;
  }
}

function placeText(t: Text, on: boolean, x: number, y: number, alpha: number): void {
  t.visible = on;
  if (!on) return;
  t.alpha = alpha;
  t.position.set(x, y);
}

function place(s: Sprite, on: boolean, x: number, y: number, w: number, h: number, alpha: number): void {
  s.visible = on;
  if (!on) return;
  s.position.set(x, y);
  s.width = w;
  s.height = h;
  s.alpha = alpha;
}

export function createCinematicSystem(): GameSystem {
  return new CinematicSystem();
}

// ================================================================ textures

/** Transparent centre → dark crimson edges (low HP), stretched over the screen. */
function makeVignetteTexture(): Texture {
  const size = 256;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(size / 2, size / 2, size * 0.22, size / 2, size / 2, size * 0.72);
  grad.addColorStop(0, "rgba(70,0,10,0)");
  grad.addColorStop(0.5, "rgba(95,0,14,0.45)");
  grad.addColorStop(1, "rgba(40,0,6,0.95)");
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return new Texture({ source: new ImageSource({ resource: c, scaleMode: "linear" }) });
}
