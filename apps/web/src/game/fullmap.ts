/**
 * Full map overlay (M) and the zone toast (WP-M3, map memo §9 "Minimap and full map", immersion
 * hooks).
 *
 *  - FullMapOverlay: the shared overview texture (minimap.ts) fitted to the screen, POI names in
 *    tier colours, YOUR allowed extracts (SelfState.extractMask) bright with names and closing
 *    times, the others greyed, your spawn side, a compass, your own arrow and your party mates
 *    (S2C.PARTY, party.ts: coloured dot + name, × when down) — never any other player.
 *  - ZoneTracker (pure) + ZoneToast: "Grain Elevator · T3" when you enter a POI, with a short dwell
 *    so walking along a zone edge does not spam, and no repeat for the same zone within 45 s. A boss
 *    POI adds a red skull line ("Foreman's turf"); the full map marks boss spots with named skulls.
 *  - createMapOverlaySystem(): both wrapped as a GameSystem (systems.ts) with the M / Esc keys, so
 *    the renderer only has to list it in its system factories.
 */

import { Container, Graphics, Sprite, Text, type TextStyleOptions } from "pixi.js";
import { BOSSES, MAPS, extractOpenAtFor, zoneAt, type BossKind, type BossSpot, type ExtractSpot, type LootTier, type MapData, type MapSide, type Zone, type ZoneKind } from "@extract/shared";
import { COLORS } from "./assets";
import type { GameContext, GameSystem } from "./systems";
import { acquireOverview, releaseOverview } from "./minimap";
import { shouldUseTouch } from "./touch-mode";
import { BOSS_COLOR, bossSpotShown, liveBossTurf, turfLine, type EventBossState } from "./boss";
import { skullContext } from "./boss-icons";

const FONT = "ui-rounded, 'Trebuchet MS', system-ui, sans-serif";

export const TIER_COLORS: Record<LootTier, number> = {
  0: 0xc9ced6,
  1: 0x8ce99a,
  2: 0xffd43b,
  3: 0xff922b,
  4: 0xff6b6b,
};

export const ZONE_KIND_LABEL: Record<ZoneKind, string> = {
  village: "Village",
  farm: "Farm",
  lumber: "Forestry",
  industrial: "Industrial",
  gas: "Fuel stop",
  rail: "Rail yard",
  military: "Military",
  checkpoint: "Checkpoint",
  quarry: "Quarry",
};

const SIDE_NAME = ["North", "East", "South", "West"] as const;

/** "Grain Elevator · T3" style subtitle. */
export function zoneSubtitle(z: Pick<Zone, "kind" | "tier">): string {
  return `${ZONE_KIND_LABEL[z.kind]} · T${z.tier}`;
}

/** Allowed-extract flags from SelfState.extractMask (bit i = map.extracts[i]). */
export function allowedFromMask(map: Pick<MapData, "extracts">, mask: number): boolean[] {
  return map.extracts.map((_, i) => (mask & (1 << i)) !== 0);
}

/** "25:00" for a ms offset (extract closing times). */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** "3:00" countdown (ceil to whole seconds). */
function formatLeft(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export type FullMapExtractStatus = "waiting" | "open" | "closed";

/**
 * How the full map shows one of YOUR extracts (WORLD v6): open / close times from the synced
 * BattleState extract (`st`: openAt, closeAt — not the map's static closesAtMs) and your personal
 * arm (`armAt` = SelfState.extractArmAt, extractOpenAtFor). Without `st` the map spot's closesAtMs
 * is used. `suffix` follows the name: " · opens in 1:20", " · closes in 4:10", " · closed".
 */
export function fullMapExtractView(
  spot: Pick<ExtractSpot, "closesAtMs">,
  st: { openAt: number; closeAt: number } | undefined,
  armAt: number,
  clockMs: number,
): { status: FullMapExtractStatus; suffix: string } {
  const openAt = extractOpenAtFor({ openAt: st ? st.openAt : 0 }, { extractArmAt: armAt });
  const closeAt = st ? st.closeAt : (spot.closesAtMs ?? 0);
  if (closeAt > 0 && clockMs >= closeAt) return { status: "closed", suffix: " · closed" };
  if (clockMs < openAt) return { status: "waiting", suffix: ` · opens in ${formatLeft(openAt - clockMs)}` };
  return { status: "open", suffix: closeAt > 0 ? ` · closes in ${formatLeft(closeAt - clockMs)}` : "" };
}

/** Live data the full map reads from the synced state (WORLD v6). */
export interface FullMapLive {
  /** BattleState.extracts entry by id (openAt / closeAt), undefined when unknown. */
  extract(id: string): { openAt: number; closeAt: number } | undefined;
  /** SelfState.extractArmAt (0 = legacy). */
  armAt: number;
  /** BattleState boss fields: only the live event boss gets a skull. */
  boss: EventBossState | null;
  /** Party mates (party.ts PartyMateView), absent / empty when solo. */
  mates?: ReadonlyArray<{ key: string; name: string; x: number; y: number; alive: boolean; color: number }>;
}

// ---------------------------------------------------------------------------------------------
// Zone entry detection (pure)
// ---------------------------------------------------------------------------------------------

export interface ZoneTrackerOptions {
  /** The player must stay in a new zone this long before it counts (edge walking). */
  dwellMs?: number;
  /** The same zone never toasts again within this time. */
  repeatMs?: number;
}

/**
 * Emits a zone when the player has entered it (after `dwellMs` inside). Leaving into the
 * wilderness emits nothing. Pure: feed it positions and a clock.
 */
export class ZoneTracker {
  private candidate: string | null = null;
  private since = 0;
  private current: string | null = null;
  private readonly lastShown = new Map<string, number>();
  private readonly dwellMs: number;
  private readonly repeatMs: number;

  constructor(
    readonly map: Pick<MapData, "zones">,
    opts: ZoneTrackerOptions = {},
  ) {
    this.dwellMs = opts.dwellMs ?? 400;
    this.repeatMs = opts.repeatMs ?? 45_000;
  }

  /** The zone the player is confirmed in (after dwell), or null. */
  get zoneId(): string | null {
    return this.current;
  }

  update(x: number, y: number, nowMs: number): Zone | null {
    const z = zoneAt(this.map as MapData, x, y) ?? null;
    const id = z?.id ?? null;
    if (id !== this.candidate) {
      this.candidate = id;
      this.since = nowMs;
    }
    if (this.candidate === this.current || nowMs - this.since < this.dwellMs) return null;
    this.current = this.candidate;
    if (!z) return null;
    const last = this.lastShown.get(z.id);
    if (last !== undefined && nowMs - last < this.repeatMs) return null;
    this.lastShown.set(z.id, nowMs);
    return z;
  }

  /** Forget the current zone (respawn / new match) — keeps the repeat timers. */
  reset(): void {
    this.candidate = null;
    this.current = null;
  }
}

// ---------------------------------------------------------------------------------------------
// Zone toast
// ---------------------------------------------------------------------------------------------

const TOAST = { IN_MS: 250, HOLD_MS: 2200, OUT_MS: 650 } as const;

/** Toast alpha at `t` ms after it was shown (0 when finished). */
export function toastAlpha(t: number, holdMs: number = TOAST.HOLD_MS): number {
  if (t < 0) return 0;
  if (t < TOAST.IN_MS) return t / TOAST.IN_MS;
  if (t < TOAST.IN_MS + holdMs) return 1;
  const o = t - TOAST.IN_MS - holdMs;
  return o < TOAST.OUT_MS ? 1 - o / TOAST.OUT_MS : 0;
}


/**
 * Zone toast top (screen px): 16% of the height, but on a short landscape phone (< 480 px) below
 * the React HUD's timer + compass and the boss bar (bossBarY), which sit higher than 16% there.
 */
export function zoneToastY(screenH: number): number {
  return screenH < 480 ? 116 : Math.round(screenH * 0.16);
}

export class ZoneToast {
  readonly root = new Container();
  private readonly title: Text;
  private readonly sub: Text;
  /** Boss POI line ("FOREMAN'S TURF") with a skull, hidden for ordinary zones. */
  private readonly turf: Text;
  private readonly skull = new Graphics(skullContext(BOSS_COLOR, 10));
  private readonly bar = new Graphics();
  private shownAt = -Infinity;
  private holdMs: number = TOAST.HOLD_MS;

  constructor() {
    this.title = new Text({
      text: "",
      style: { fontFamily: FONT, fontSize: 30, fontWeight: "900", fill: 0xffffff, stroke: { color: 0x101010, width: 5 }, letterSpacing: 1 },
    });
    this.sub = new Text({
      text: "",
      style: { fontFamily: FONT, fontSize: 15, fontWeight: "800", fill: 0xffffff, stroke: { color: 0x101010, width: 4 }, letterSpacing: 2 },
    });
    this.turf = new Text({
      text: "",
      style: { fontFamily: FONT, fontSize: 16, fontWeight: "900", fill: BOSS_COLOR, stroke: { color: 0x101010, width: 4 }, letterSpacing: 3 },
    });
    this.title.anchor.set(0.5, 0);
    this.sub.anchor.set(0.5, 0);
    this.sub.y = 40;
    this.turf.anchor.set(0.5, 0);
    this.turf.y = 80;
    this.turf.visible = false;
    this.skull.visible = false;
    this.root.addChild(this.bar, this.title, this.sub, this.turf, this.skull);
    this.root.visible = false;
    this.root.eventMode = "none";
  }

  /** `boss` = the zone's boss turf to announce (default z.boss); WORLD v6 passes only a live event boss. */
  show(z: Zone, nowMs: number, boss: BossKind | null = z.boss ?? null) {
    this.title.text = z.name;
    this.sub.text = zoneSubtitle(z).toUpperCase();
    this.sub.style.fill = TIER_COLORS[z.tier];
    this.turf.visible = !!boss;
    this.skull.visible = !!boss;
    if (boss) {
      this.turf.text = turfLine(boss).toUpperCase();
      // Skull + text centred together.
      const tw = this.turf.width + 26;
      this.turf.x = 13;
      this.skull.position.set(-tw / 2 + 10, this.turf.y + this.turf.height / 2);
    }
    const w = Math.max(this.title.width, this.sub.width, boss ? this.turf.width + 34 : 0) + 48;
    const h = boss ? 112 : 84;
    this.bar.clear();
    this.bar.roundRect(-w / 2, -8, w, h, 12).fill({ color: boss ? 0x1a0606 : 0x0c120a, alpha: boss ? 0.65 : 0.55 });
    this.bar.rect(-w / 2 + 14, 66, w - 28, 3).fill({ color: TIER_COLORS[z.tier], alpha: 0.9 });
    this.shownAt = nowMs;
    this.holdMs = boss ? TOAST.HOLD_MS + 1200 : TOAST.HOLD_MS;
  }

  layout(screenW: number, screenH: number) {
    this.root.position.set(screenW / 2, zoneToastY(screenH));
    // Short landscape phones: 80 %, like the rest of the compact touch HUD.
    this.root.scale.set(screenH < 480 ? 0.8 : 1);
  }

  frame(nowMs: number) {
    const a = toastAlpha(nowMs - this.shownAt, this.holdMs);
    this.root.visible = a > 0;
    this.root.alpha = a;
  }
}

// ---------------------------------------------------------------------------------------------
// Full map overlay
// ---------------------------------------------------------------------------------------------

/** Extract name placement by map side: [anchorX, anchorY, dx, dy] — always toward the map centre. */
const LABEL_PLACEMENT: Record<MapSide, readonly [number, number, number, number]> = {
  0: [0.5, 0, 0, 14],
  1: [1, 1, -6, -14],
  2: [0.5, 1, 0, -14],
  3: [0, 1, 6, -14],
};

interface ExtractMark {
  e: ExtractSpot;
  g: Graphics;
  label: Text;
  /** Last drawn look ("open" / "waiting" / "closed"), null = not drawn yet. */
  look: string | null;
}

export class FullMapOverlay {
  readonly root = new Container();
  private readonly backdrop = new Graphics();
  private readonly panel = new Container();
  private readonly mapSprite: Sprite;
  private readonly zones = new Graphics();
  private readonly sideBand = new Graphics();
  private readonly labels = new Container();
  private readonly zoneLabels: Array<{ z: Zone; t: Text }> = [];
  private readonly extracts: ExtractMark[] = [];
  /** Boss spots: skull + name ("FOREMAN"); the boss may not have spawned this match. */
  private readonly bossMarks: Array<{ b: BossSpot; g: Graphics; label: Text }> = [];
  /** Party mates: dot (or ×) + name, pooled; redrawn only when colour / alive change. */
  private readonly mateLayer = new Container();
  private readonly mateMarks: Array<{ g: Graphics; label: Text; key: string }> = [];
  private readonly labelStyle: (fill: number, size: number) => TextStyleOptions;
  private fontScale = 1;
  private readonly me = new Graphics();
  private readonly compass = new Container();
  private readonly title: Text;
  private readonly hint: Text;
  private size = 1;
  private screen = { w: 0, h: 0 };
  private side: MapSide | -1 = -1;
  private released = false;

  constructor(readonly map: MapData) {
    const tex = acquireOverview(map);
    this.mapSprite = new Sprite(tex);
    const labelStyle = (fill: number, size: number): TextStyleOptions => ({
      fontFamily: FONT,
      fontSize: size,
      fontWeight: "800",
      fill,
      stroke: { color: 0x0b0b0b, width: 4 },
    });
    this.labelStyle = labelStyle;
    for (const z of map.zones) {
      const t = new Text({ text: `${z.name}\nT${z.tier}`, style: { ...labelStyle(TIER_COLORS[z.tier], 15), align: "center", lineHeight: 17 } });
      t.anchor.set(0.5);
      this.labels.addChild(t);
      this.zoneLabels.push({ z, t });
    }
    for (const e of map.extracts) {
      const g = new Graphics();
      const label = new Text({ text: e.name, style: labelStyle(0xffffff, 13) });
      label.anchor.set(0.5, 0);
      this.labels.addChild(g, label);
      this.extracts.push({ e, g, label, look: null });
    }
    for (const b of map.bosses ?? []) {
      const g = new Graphics(skullContext(BOSS_COLOR, 12));
      const label = new Text({ text: BOSSES[b.kind]?.name.toUpperCase() ?? b.kind.toUpperCase(), style: { ...labelStyle(BOSS_COLOR, 13), letterSpacing: 2 } });
      label.anchor.set(0, 0.5);
      this.labels.addChild(g, label);
      this.bossMarks.push({ b, g, label });
    }
    this.me.circle(0, 0, 12).fill({ color: 0xffffff, alpha: 0.3 });
    this.me.poly([13, 0, -8, -9, -4, 0, -8, 9]).fill({ color: 0xffffff }).stroke({ width: 2.5, color: 0x111111 });

    const n = new Text({ text: "N", style: labelStyle(0xffffff, 18) });
    n.anchor.set(0.5, 1);
    n.y = -16;
    const arrow = new Graphics().poly([0, -16, 9, 8, 0, 3, -9, 8]).fill({ color: 0xffffff }).stroke({ width: 2, color: 0x111111 });
    this.compass.addChild(arrow, n);

    this.title = new Text({ text: "", style: labelStyle(0xffffff, 22) });
    this.title.anchor.set(0.5, 1);
    // Touch has no M key: the MAP button toggles it.
    this.hint = new Text({ text: shouldUseTouch() ? "Tap MAP to close" : "M — close", style: { ...labelStyle(0xc9ced6, 13), fontWeight: "700" } });
    this.hint.anchor.set(0.5, 0);

    this.panel.addChild(this.mapSprite, this.zones, this.sideBand, this.labels, this.mateLayer, this.me, this.compass);
    this.root.addChild(this.backdrop, this.panel, this.title, this.hint);
    this.root.visible = false;
    this.root.eventMode = "none";
    this.root.interactiveChildren = false;
  }

  get isOpen(): boolean {
    return this.root.visible;
  }

  setOpen(open: boolean) {
    this.root.visible = open;
  }

  toggle() {
    this.setOpen(!this.root.visible);
  }

  /** Re-fit to the screen. Cheap; call on resize (and it is called on open). */
  layout(screenW: number, screenH: number) {
    if (screenW === this.screen.w && screenH === this.screen.h) return;
    this.screen = { w: screenW, h: screenH };
    // Short landscape phones (< 480 px): start under the React HUD's timer so the title stays readable.
    const short = screenH < 480;
    const size = Math.max(200, Math.min(screenW * 0.9, screenH - (short ? 160 : 120)));
    this.size = size;
    const k = size / Math.max(this.map.width, this.map.height);
    this.backdrop.clear().rect(0, 0, screenW, screenH).fill({ color: 0x05080a, alpha: 0.72 });
    this.panel.position.set((screenW - size) / 2, short ? 90 : (screenH - size) / 2 + 10);
    this.mapSprite.width = this.map.width * k;
    this.mapSprite.height = this.map.height * k;

    this.zones.clear();
    for (const z of this.map.zones) {
      this.zones.roundRect(z.rect.x * k, z.rect.y * k, z.rect.w * k, z.rect.h * k, 6).stroke({ width: 2, color: TIER_COLORS[z.tier], alpha: 0.75 });
    }
    this.zones.rect(0, 0, this.map.width * k, this.map.height * k).stroke({ width: 3, color: 0xffffff, alpha: 0.6 });
    const fontScale = Math.max(0.7, Math.min(1.2, size / 800));
    this.fontScale = fontScale;
    for (const { z, t } of this.zoneLabels) {
      // A boss POI's skull sits near its centre: its name goes to the bottom edge instead.
      if (z.boss) {
        t.anchor.set(0.5, 1);
        t.position.set((z.rect.x + z.rect.w / 2) * k, (z.rect.y + z.rect.h) * k - 4);
      } else {
        t.position.set((z.rect.x + z.rect.w / 2) * k, (z.rect.y + z.rect.h / 2) * k);
      }
      t.scale.set(fontScale);
    }
    for (const m of this.extracts) {
      m.g.position.set(m.e.x * k, m.e.y * k);
      m.label.scale.set(fontScale);
      // Extracts sit on the map edge: put the name inward, away from the edge it is on.
      const ex = m.e.x * k;
      const ey = m.e.y * k;
      const [ax, ay, dx, dy] = LABEL_PLACEMENT[m.e.side];
      m.label.anchor.set(ax, ay);
      m.label.position.set(ex + dx, ey + dy);
    }
    for (const m of this.bossMarks) {
      m.g.position.set(m.b.x * k, m.b.y * k);
      m.g.scale.set(fontScale);
      m.label.scale.set(fontScale);
      m.label.position.set(m.b.x * k + 15 * fontScale, m.b.y * k);
    }
    this.compass.position.set(size - 28, 34);
    this.title.position.set(screenW / 2, this.panel.y - 6);
    this.hint.position.set(screenW / 2, this.panel.y + size + 6);
    this.side = -1; // force the side band to redraw at the new scale
  }

  /**
   * Per frame while open. `allowed` = per-extract flags (allowedFromMask), `side` = spawn side,
   * `self` = your position/aim (null when dead), `clockMs` = match clock (closing extracts),
   * `live` = synced extract times, your personal arm and the event boss (WORLD v6).
   */
  update(
    self: { x: number; y: number; aim: number } | null,
    allowed: readonly boolean[] | null,
    side: MapSide | null,
    clockMs: number,
    nowMs: number,
    live: FullMapLive | null = null,
  ) {
    if (!this.root.visible) return;
    const k = this.size / Math.max(this.map.width, this.map.height);
    this.title.text = `${MAPS[this.map.id]?.name ?? "Map"}${side !== null ? ` · spawned ${SIDE_NAME[side]}` : ""}`;
    if (side !== null && side !== this.side) {
      this.side = side;
      const W = this.map.width * k;
      const H = this.map.height * k;
      const t = 10;
      const band = [
        [0, 0, W, t],
        [W - t, 0, t, H],
        [0, H - t, W, t],
        [0, 0, t, H],
      ][side]!;
      this.sideBand.clear().rect(band[0]!, band[1]!, band[2]!, band[3]!).fill({ color: 0x4dabf7, alpha: 0.7 });
    }
    this.extracts.forEach((m, i) => {
      const ok = allowed ? !!allowed[i] : true;
      const view = fullMapExtractView(m.e, live?.extract(m.e.id), live?.armAt ?? 0, clockMs);
      const look = ok ? view.status : "closed";
      if (m.look !== look) {
        m.look = look;
        const lit = look !== "closed";
        const color = look === "open" ? COLORS.extractOpen : look === "waiting" ? COLORS.extractWaiting : COLORS.extractClosed;
        m.g.clear();
        m.g.circle(0, 0, 11).fill({ color, alpha: lit ? 0.45 : 0.25 }).stroke({ width: 3, color, alpha: lit ? 1 : 0.6 });
        if (!lit) m.g.moveTo(-6, -6).lineTo(6, 6).moveTo(6, -6).lineTo(-6, 6).stroke({ width: 3, color: 0x1a1a1a, alpha: 0.8 });
        m.label.style.fill = look === "open" ? 0xffffff : look === "waiting" ? 0xffe8a3 : 0x8a9099;
      }
      // Only your own extracts are named (a closed one stays named, greyed, "· closed"); the
      // others are just a grey ×, so their names never crowd the POI labels near the map edge.
      m.label.visible = ok;
      const text = `${m.e.name}${ok ? view.suffix : ""}`;
      if (m.label.text !== text) m.label.text = text;
      m.g.scale.set(look === "open" ? 1 + 0.12 * Math.sin(nowMs / 220) : 1);
    });
    // WORLD v6: only the live event boss's spot keeps its skull.
    const bosses = this.map.bosses ?? [];
    for (let i = 0; i < this.bossMarks.length; i++) {
      const m = this.bossMarks[i]!;
      const shown = bossSpotShown(bosses, i, live?.boss ?? null);
      m.g.visible = shown;
      m.label.visible = shown;
    }
    this.updateMates(live?.mates ?? [], k);
    this.me.visible = !!self;
    if (self) {
      this.me.position.set(self.x * k, self.y * k);
      this.me.rotation = self.aim;
    }
  }

  private updateMates(mates: NonNullable<FullMapLive["mates"]>, k: number) {
    while (this.mateMarks.length < mates.length) {
      const g = new Graphics();
      const label = new Text({ text: "", style: this.labelStyle(0xffffff, 13) });
      label.anchor.set(0, 0.5);
      this.mateLayer.addChild(g, label);
      this.mateMarks.push({ g, label, key: "" });
    }
    for (let i = 0; i < this.mateMarks.length; i++) {
      const mk = this.mateMarks[i]!;
      const m = mates[i];
      mk.g.visible = mk.label.visible = !!m;
      if (!m) continue;
      const key = `${m.color}|${m.alive}`;
      if (mk.key !== key) {
        mk.key = key;
        mk.g.clear();
        if (m.alive) {
          mk.g.circle(0, 0, 12).fill({ color: m.color, alpha: 0.25 });
          mk.g.circle(0, 0, 7).fill({ color: m.color }).stroke({ width: 2.5, color: 0x111111 });
        } else {
          mk.g.moveTo(-7, -7).lineTo(7, 7).moveTo(7, -7).lineTo(-7, 7).stroke({ width: 6, color: 0x111111, alpha: 0.8 });
          mk.g.moveTo(-7, -7).lineTo(7, 7).moveTo(7, -7).lineTo(-7, 7).stroke({ width: 3, color: m.color });
        }
        mk.label.style.fill = m.color;
      }
      const text = m.alive ? m.name : `${m.name} · down`;
      if (mk.label.text !== text) mk.label.text = text;
      mk.g.position.set(m.x * k, m.y * k);
      mk.label.scale.set(this.fontScale);
      mk.label.position.set(m.x * k + 13 * this.fontScale, m.y * k);
      mk.g.alpha = mk.label.alpha = m.alive ? 1 : 0.8;
    }
  }

  destroy() {
    this.root.destroy({ children: true });
    if (!this.released) {
      this.released = true;
      releaseOverview(this.map);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// GameSystem wrapper
// ---------------------------------------------------------------------------------------------

function isTypingTarget(t: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(t instanceof HTMLElement)) return false;
  return t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT";
}

export interface MapOverlaySystemOptions {
  /** KeyboardEvent.code that toggles the full map (default "KeyM"). */
  key?: string;
  /** Show the zone toast (default true). */
  zoneToast?: boolean;
}

/**
 * Full map (M) + zone toast as a GameSystem: draws into ctx.layers.screen, reads ctx.map(),
 * ctx.selfPos(), ctx.self() (extractMask, side), ctx.me() (alive), ctx.clockMs().
 */
export function createMapOverlaySystem(opts: MapOverlaySystemOptions = {}): GameSystem {
  const key = opts.key ?? "KeyM";
  let overlay: FullMapOverlay | null = null;
  let toast: ZoneToast | null = null;
  let tracker: ZoneTracker | null = null;
  let mapRef: MapData | null = null;
  let size = { w: 0, h: 0 };
  let wantOpen = false;
  let disposed = false;

  const onKey = (e: KeyboardEvent) => {
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
    if (e.code === key) {
      wantOpen = !wantOpen;
      overlay?.setOpen(wantOpen);
    } else if (e.code === "Escape" && wantOpen) {
      wantOpen = false;
      overlay?.setOpen(false);
    }
  };

  const build = (ctx: GameContext, map: MapData) => {
    mapRef = map;
    overlay = new FullMapOverlay(map);
    overlay.setOpen(wantOpen);
    tracker = new ZoneTracker(map);
    ctx.layers.screen.addChild(overlay.root);
    if (opts.zoneToast !== false) {
      toast = new ZoneToast();
      ctx.layers.screen.addChild(toast.root);
    }
    const cam = ctx.camera();
    size = { w: cam.width, h: cam.height };
    overlay.layout(size.w, size.h);
    toast?.layout(size.w, size.h);
  };

  return {
    id: "map-overlay",
    init() {
      if (typeof window !== "undefined") window.addEventListener("keydown", onKey);
    },
    frame(_dt, ctx) {
      if (disposed) return;
      const map = ctx.map();
      if (!map) return;
      if (map !== mapRef) {
        overlay?.destroy();
        toast?.root.destroy({ children: true });
        build(ctx, map);
      }
      const now = performance.now();
      const me = ctx.me();
      const self = ctx.self();
      const alive = !!me && me.alive && (!self || self.extractedAt === 0);
      const pos = ctx.selfPos();
      const state = ctx.state();
      if (alive && tracker && toast) {
        const z = tracker.update(pos.x, pos.y, now);
        if (z) toast.show(z, now, liveBossTurf(z.boss ?? null, state));
      }
      toast?.frame(now);
      if (overlay?.isOpen) {
        overlay.update(
          alive ? { x: pos.x, y: pos.y, aim: ctx.aim() } : null,
          self ? allowedFromMask(map, self.extractMask) : null,
          self ? (self.side as MapSide) : null,
          ctx.clockMs(),
          now,
          {
            extract: (id) => state?.extracts.get(id),
            armAt: self?.extractArmAt ?? 0,
            boss: state,
            mates: ctx.partyMates?.() ?? [],
          },
        );
      }
    },
    // The open map owns the mouse (renderer: no fire, aim and look-ahead frozen).
    isInputBlocked: () => wantOpen && !disposed,
    // Touch MAP button: same toggle as the key.
    command(name) {
      if (name !== "toggleMap" || disposed) return false;
      wantOpen = !wantOpen;
      overlay?.setOpen(wantOpen);
      return true;
    },
    resize(w, h) {
      size = { w, h };
      overlay?.layout(w, h);
      toast?.layout(w, h);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (typeof window !== "undefined") window.removeEventListener("keydown", onKey);
      overlay?.destroy();
      toast?.root.destroy({ children: true });
      overlay = null;
      toast = null;
    },
  };
}
