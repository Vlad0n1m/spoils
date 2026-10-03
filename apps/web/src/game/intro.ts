/**
 * Drop-in title card (WP-I, immersion memo §4 P0.6): when the local player first appears on the
 * map, a lower-third card shows where and when the raid happens —
 *
 *   DEPLOYING
 *   Grain Elevator                         ← zone at the spawn (or "Outskirts of …" / the map edge)
 *   STEPPE OUTSKIRTS · 21:40 · RAIN        ← map name, in-game time, weather (sampleEnv)
 *   EXTRACTS OPEN IN 3:00                  ← live countdown to the first allowed extract (personal arm)
 *   WIPE IN 31:12                          ← WORLD v6: live countdown to the map wipe
 *
 * and, at the start of a fresh raid, the camera eases from a wider zoom onto the player (CameraRig,
 * skipped under reduced motion). The card never blocks input; any key or click fades it early.
 * Pixi Texts are created once in init; their strings change only on show and once per second of
 * the countdown, so the steady-state frame is a few property writes.
 */

import { Container, Graphics, Text } from "pixi.js";
import {
  MAPS,
  MATCH,
  envConfigOf,
  extractOpenAtFor,
  sampleEnv,
  zoneAt,
  type BattleState,
  type MapData,
  type RaidTime,
  type WeatherKind,
  type Zone,
} from "@extract/shared";
import { getCameraRig, reducedMotion } from "./camera";
import { TIER_COLORS } from "./fullmap";
import type { GameContext, GameSystem } from "./systems";

const FONT = "ui-rounded, 'Trebuchet MS', system-ui, sans-serif";

export const INTRO = {
  IN_MS: 450,
  HOLD_MS: 4200,
  OUT_MS: 700,
  /** A key / click fades the card out this fast. */
  SKIP_OUT_MS: 250,
  /** Input during the first moments (the click that started the raid) does not skip. */
  SKIP_GRACE_MS: 400,
  /** Card slides up this far while it fades in. */
  SLIDE_PX: 18,
  /** Fresh raid only: the camera starts this wide and eases in. */
  ZOOM_FROM: 0.86,
  ZOOM_TAU_MS: 420,
  ZOOM_MAX_CLOCK_MS: 20_000,
  /** Legacy matches: joining later than this (a reconnect) says "BACK IN THE RAID" instead of "DEPLOYING". */
  REJOIN_AFTER_MS: 60_000,
  /** WORLD v6: a connection within this long of the entry's own start (SelfState.enteredAt) is a fresh drop-in. */
  FRESH_ENTRY_MS: 5_000,
  /** "Outskirts of X" when the spawn is this close to a zone. */
  NEAR_ZONE_PX: 1400,
  /** Card centre, as a fraction of the screen height (the zone toast sits at 0.16). */
  Y_FRAC: 0.7,
} as const;

export const WEATHER_LABEL: Record<WeatherKind, string> = {
  clear: "Clear",
  cloudy: "Overcast",
  rain: "Rain",
  fog: "Fog",
  storm: "Storm",
};

export const RAID_TIME_LABEL: Record<RaidTime, string> = { day: "Day", dusk: "Dusk", night: "Night", dawn: "Dawn" };

const SIDE_NAME = ["North", "East", "South", "West"] as const;

// ---------------------------------------------------------------- pure helpers

/** In-game minutes since midnight → "21:40". */
export function formatTod(min: number): string {
  const m = ((Math.floor(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** "3:00" for a ms duration (ceil to whole seconds, never negative). */
export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The countdown line: "Extracts open in 3:00", or "Extracts open" once they are. */
export function extractsLine(remainingMs: number): string {
  return remainingMs > 0 ? `Extracts open in ${formatCountdown(remainingMs)}` : "Extracts open";
}

/** WORLD v6: "Wipe in 31:12" ("Wiping" at 0). */
export function wipeLine(remainingMs: number): string {
  return remainingMs > 0 ? `Wipe in ${formatCountdown(remainingMs)}` : "Wiping";
}

/**
 * Fresh drop-in or a reconnect? WORLD v6: by the entry's own start (`clockMs − enteredAtMs <
 * FRESH_ENTRY_MS`); legacy matches (enteredAtMs undefined): by the raid clock.
 */
export function isFreshEntry(clockMs: number, enteredAtMs?: number): boolean {
  if (enteredAtMs === undefined) return clockMs <= INTRO.REJOIN_AFTER_MS;
  return clockMs - enteredAtMs < INTRO.FRESH_ENTRY_MS;
}

function rectDist(z: Zone, x: number, y: number): number {
  const dx = Math.max(z.rect.x - x, 0, x - (z.rect.x + z.rect.w));
  const dy = Math.max(z.rect.y - y, 0, y - (z.rect.y + z.rect.h));
  return Math.hypot(dx, dy);
}

/** Where the player spawned: the zone, "Outskirts of …" near one, else the map edge. */
export function spawnPlace(
  map: Pick<MapData, "zones">,
  x: number,
  y: number,
  side: number | null,
): { name: string; zone: Zone | null } {
  const z = zoneAt(map as MapData, x, y);
  if (z) return { name: z.name, zone: z };
  let best: Zone | null = null;
  let bestD: number = INTRO.NEAR_ZONE_PX;
  for (const c of map.zones) {
    const d = rectDist(c, x, y);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  if (best) return { name: `Outskirts of ${best.name}`, zone: best };
  const s = side !== null && side >= 0 && side <= 3 ? SIDE_NAME[side] : null;
  return { name: s ? `${s} wilds` : "The wilds", zone: null };
}

/**
 * Earliest open time among the extracts this player may use (SelfState.extractMask bit i =
 * map.extracts[i]); every extract when the mask is empty, the rule time when none is known.
 * WORLD v6: never before the player's own arm (`armAt` = SelfState.extractArmAt, extractOpenAtFor).
 */
export function firstExtractOpenAt(
  map: Pick<MapData, "extracts"> | null,
  extracts: { get(id: string): { openAt: number } | undefined; forEach(cb: (e: { openAt: number }) => void): void },
  mask: number,
  armAt = 0,
): number {
  return extractOpenAtFor({ openAt: firstMapOpenAt(map, extracts, mask) }, { extractArmAt: armAt });
}

function firstMapOpenAt(
  map: Pick<MapData, "extracts"> | null,
  extracts: { get(id: string): { openAt: number } | undefined; forEach(cb: (e: { openAt: number }) => void): void },
  mask: number,
): number {
  let best = Number.POSITIVE_INFINITY;
  if (map && mask) {
    map.extracts.forEach((e, i) => {
      if (!(mask & (1 << i))) return;
      const s = extracts.get(e.id);
      if (s && s.openAt < best) best = s.openAt;
    });
  }
  if (!Number.isFinite(best)) extracts.forEach((e) => (best = Math.min(best, e.openAt)));
  return Number.isFinite(best) ? best : MATCH.EXTRACT_OPEN_AT_MS;
}

export interface TitleCardText {
  kicker: string;
  title: string;
  sub: string;
}

/**
 * Card strings (upper-casing is done here so tests see what the player sees). `enteredAtMs`
 * (WORLD v6, SelfState.enteredAt) decides fresh drop-in vs reconnect; without it the raid clock does.
 */
export function titleCardText(i: {
  mapId: string;
  place: string;
  todMin: number | null;
  weather: WeatherKind | null;
  clockMs?: number;
  enteredAtMs?: number;
}): TitleCardText {
  const mapName = MAPS[i.mapId as keyof typeof MAPS]?.name ?? (i.mapId === "legacy" ? "Proving Grounds" : "Unknown sector");
  const parts = [mapName];
  if (i.todMin !== null && Number.isFinite(i.todMin)) parts.push(formatTod(i.todMin));
  if (i.weather) parts.push(WEATHER_LABEL[i.weather] ?? i.weather);
  // A reconnect mid-raid is not a drop-in.
  const kicker = isFreshEntry(i.clockMs ?? 0, i.enteredAtMs) ? "DEPLOYING" : "BACK IN THE RAID";
  return { kicker, title: i.place, sub: parts.join(" · ").toUpperCase() };
}

/**
 * Card animation at `t` ms after it appeared: alpha and the slide offset (px). `skipT` is when a
 * key / click asked to hide it (null = not skipped). alpha 0 with t > 0 means finished.
 */
export function titleCardPose(
  t: number,
  skipT: number | null,
  out: { alpha: number; slide: number } = { alpha: 0, slide: 0 },
): { alpha: number; slide: number } {
  if (t < 0) {
    out.alpha = 0;
    out.slide = INTRO.SLIDE_PX;
    return out;
  }
  const inK = Math.min(1, t / INTRO.IN_MS);
  const easeIn = 1 - (1 - inK) * (1 - inK) * (1 - inK);
  let alpha = easeIn;
  const outStart = INTRO.IN_MS + INTRO.HOLD_MS;
  if (skipT !== null && skipT < outStart) {
    const k = (t - Math.max(skipT, 0)) / INTRO.SKIP_OUT_MS;
    if (k > 0) alpha = Math.min(alpha, Math.max(0, 1 - k));
  }
  if (t > outStart) alpha = Math.min(alpha, Math.max(0, 1 - (t - outStart) / INTRO.OUT_MS));
  out.alpha = alpha;
  out.slide = (1 - easeIn) * INTRO.SLIDE_PX;
  return out;
}

// ---------------------------------------------------------------- the system

class IntroSystem implements GameSystem {
  readonly id = "intro";
  private root: Container | null = null;
  private panel: Graphics | null = null;
  private kicker: Text | null = null;
  private title: Text | null = null;
  private sub: Text | null = null;
  private extracts: Text | null = null;
  private wipe: Text | null = null;
  /** Cycle clock of the wipe (state.durationMs) on a world map, 0 on a legacy match (no line). */
  private wipeAt = 0;
  private wipeS = -1;
  private shown = false;
  private done = false;
  private shownAt = 0;
  private skipAt: number | null = null;
  private openAt = 0;
  private countdownS = -1;
  private panelW = 0;
  private panelH = 0;
  private accent = 0xc6f432;
  private listening = false;
  private readonly pose = { alpha: 0, slide: 0 };

  private readonly onSkip = () => {
    if (!this.shown || this.done || this.skipAt !== null) return;
    const t = performance.now() - this.shownAt;
    if (t >= INTRO.SKIP_GRACE_MS) this.skipAt = t;
  };

  init(ctx: GameContext): void {
    const root = new Container();
    root.label = "intro-card";
    root.eventMode = "none";
    root.visible = false;
    const text = (size: number, weight: "800" | "900", fill: number, spacing: number) =>
      new Text({ text: "", style: { fontFamily: FONT, fontSize: size, fontWeight: weight, fill, stroke: { color: 0x101010, width: Math.max(3, size / 8) }, letterSpacing: spacing } });
    this.panel = new Graphics();
    this.kicker = text(13, "900", this.accent, 5);
    this.title = text(38, "900", 0xffffff, 1);
    this.sub = text(15, "800", 0xe8ecf2, 2);
    this.extracts = text(15, "900", 0xffd43b, 2);
    this.wipe = text(13, "900", 0xff8787, 2);
    for (const t of [this.kicker, this.title, this.sub, this.extracts, this.wipe]) t.anchor.set(0.5, 0);
    this.kicker.y = 0;
    this.title.y = 18;
    this.sub.y = 66;
    this.extracts.y = 98;
    this.wipe.y = 120;
    this.wipe.visible = false;
    root.addChild(this.panel, this.kicker, this.title, this.sub, this.extracts, this.wipe);
    ctx.layers.screen.addChild(root);
    this.root = root;
  }

  frame(_dtMs: number, ctx: GameContext): void {
    const root = this.root;
    if (!root || this.done) return;
    if (!this.shown) {
      if (!this.tryShow(ctx)) return;
    }
    const now = performance.now();
    const t = now - this.shownAt;
    const pose = titleCardPose(t, this.skipAt, this.pose);
    if (pose.alpha <= 0 && t > INTRO.IN_MS) {
      this.finish();
      return;
    }
    const cam = ctx.camera();
    root.visible = true;
    root.alpha = pose.alpha;
    root.position.set(Math.round(cam.width / 2), Math.round(cam.height * INTRO.Y_FRAC - 60 + pose.slide));
    // Live countdown: the string changes once per second at most.
    const left = this.openAt - ctx.clockMs();
    const s = left > 0 ? Math.ceil(left / 1000) : 0;
    if (s !== this.countdownS) {
      this.countdownS = s;
      this.extracts!.text = extractsLine(left).toUpperCase();
      this.extracts!.style.fill = left > 0 ? 0xffd43b : 0x8ce99a;
      this.layoutPanel();
    }
    if (this.wipeAt > 0) {
      const wl = this.wipeAt - ctx.clockMs();
      const ws = wl > 0 ? Math.ceil(wl / 1000) : 0;
      if (ws !== this.wipeS) {
        this.wipeS = ws;
        this.wipe!.text = wipeLine(wl).toUpperCase();
        this.layoutPanel();
      }
    }
  }

  /** First frame with a map, our own state and a live body: fill the card and start it. */
  private tryShow(ctx: GameContext): boolean {
    const state = ctx.state();
    const map = ctx.map();
    const self = ctx.self();
    const me = ctx.me();
    if (!state || !map || !self || !me) return false;
    if (!me.alive || self.extractedAt > 0 || state.phase === "ended") {
      // Joined dead / already out (reconnect after the fact): no intro this raid.
      this.finish();
      return false;
    }
    const clock = ctx.clockMs();
    const place = spawnPlace(map, me.x, me.y, self.side);
    let todMin: number | null = null;
    let weather: WeatherKind | null = null;
    try {
      const env = sampleEnv(envConfigOf(envSourceOf(state), map), clock);
      todMin = env.todMin;
      weather = env.kind;
    } catch {
      /* no environment: the card just omits time and weather */
    }
    // World maps (entryCloseMs > 0): fresh vs rejoin by the entry's own start, plus the wipe line.
    const world = state.entryCloseMs > 0;
    const card = titleCardText({ mapId: state.mapId, place: place.name, todMin, weather, clockMs: clock, enteredAtMs: world ? self.enteredAt : undefined });
    const fresh = isFreshEntry(clock, world ? self.enteredAt : undefined);
    this.kicker!.text = card.kicker;
    this.title!.text = card.title;
    this.sub!.text = card.sub;
    this.accent = place.zone ? TIER_COLORS[place.zone.tier] : 0xc6f432;
    this.kicker!.style.fill = this.accent;
    this.openAt = firstExtractOpenAt(map, state.extracts, self.extractMask, self.extractArmAt);
    this.countdownS = -1;
    this.wipeAt = world ? state.durationMs : 0;
    this.wipeS = -1;
    this.wipe!.visible = world;
    this.shown = true;
    this.shownAt = performance.now();
    this.listen(true);

    const rig = getCameraRig();
    if (rig && (world ? fresh : clock < INTRO.ZOOM_MAX_CLOCK_MS) && !reducedMotion()) {
      rig.snapZoom(INTRO.ZOOM_FROM);
      rig.zoomTo(1, INTRO.ZOOM_TAU_MS);
    }
    return true;
  }

  private layoutPanel(): void {
    const p = this.panel!;
    const wipe = this.wipe!.visible;
    const w = Math.ceil(Math.max(this.title!.width, this.sub!.width, this.extracts!.width, wipe ? this.wipe!.width : 0, 220) + 56);
    const h = wipe ? 160 : 140;
    if (Math.abs(w - this.panelW) < 6 && h === this.panelH) return;
    this.panelW = w;
    this.panelH = h;
    p.clear();
    p.roundRect(-w / 2, -14, w, h, 14).fill({ color: 0x0c120a, alpha: 0.62 });
    p.rect(-w / 2 + 18, 90, w - 36, 2).fill({ color: this.accent, alpha: 0.85 });
  }

  private listen(on: boolean): void {
    if (typeof window === "undefined" || on === this.listening) return;
    this.listening = on;
    if (on) {
      window.addEventListener("keydown", this.onSkip);
      window.addEventListener("pointerdown", this.onSkip);
    } else {
      window.removeEventListener("keydown", this.onSkip);
      window.removeEventListener("pointerdown", this.onSkip);
    }
  }

  private finish(): void {
    this.done = true;
    this.listen(false);
    if (this.root) this.root.visible = false;
  }

  dispose(): void {
    this.listen(false);
    this.root?.destroy({ children: true });
    this.root = null;
    this.panel = this.kicker = this.title = this.sub = this.extracts = this.wipe = null;
    this.done = true;
  }
}

function envSourceOf(s: BattleState) {
  return { envSeed: s.envSeed, todStartMin: s.todStartMin, durationMs: s.durationMs || MATCH.DURATION_MS, weatherOverride: s.weatherOverride };
}

/** GameSystem factory for the renderer registry (systems-registry.ts). */
export function createIntroSystem(): GameSystem {
  return new IntroSystem();
}
