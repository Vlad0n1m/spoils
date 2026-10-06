/**
 * Full map overlay (M) and the zone toast (WP-M3, map memo §9 "Minimap and full map", immersion
 * hooks).
 *
 *  - FullMapOverlay (v2): the cartographic map art (map-art.ts, shared with the minimap) in a framed
 *    panel laid out around the HUD (fullmap-layout.ts), POI name pills with T1–T4 chips placed
 *    without overlaps, YOUR allowed extracts (SelfState.extractMask) as exit icons with a status
 *    line, the others a grey ×, your spawn side, the live event boss, hot zones / drops with
 *    timers, your own arrow and your party mates (S2C.PARTY, party.ts: coloured dot + name, × when
 *    down) — never any other player — plus title (map number, wipe), legend, compass, scale bar
 *    and grid ruler. Static layers are built on layout; per frame only markers move and texts
 *    change when their string does.
 *  - ZoneTracker (pure) + ZoneToast: "Grain Elevator · T3" when you enter a POI, with a short dwell
 *    so walking along a zone edge does not spam, and no repeat for the same zone within 45 s. A boss
 *    POI adds a red skull line ("Foreman's turf"); the full map marks boss spots with named skulls.
 *  - createMapOverlaySystem(): both wrapped as a GameSystem (systems.ts) with the M / Esc keys, so
 *    the renderer only has to list it in its system factories.
 */

import { Container, Graphics, Sprite, Text, type TextStyleOptions } from "pixi.js";
import { BOSSES, MAPS, WEV_STATE, extractOpenAtFor, zoneAt, type BossKind, type BossSpot, type ExtractSpot, type LootTier, type MapData, type MapSide, type Zone, type ZoneKind } from "@extract/shared";
import { COLORS } from "./assets";
import type { GameContext, GameSystem } from "./systems";
import { MAP_GRID_PX, MAP_PALETTE, acquireMapArt, releaseMapArt } from "./map-art";
import {
  SIDE_COLUMN_W,
  extractLabelCandidates,
  extractStatusText,
  fullMapLayout,
  fullMapMeta,
  fullMapSubtitle,
  gridRuler,
  legendItems,
  legendKey,
  mapScale,
  pickLegendCorner,
  placeLabels,
  scaleBar,
  zoneLabelCandidates,
  type Box,
  type FullMapLayout,
  type LabelRequest,
  type LegendKey,
  type LegendState,
} from "./fullmap-layout";
import { shouldUseTouch } from "./touch-mode";
import { uiFonts, whenUiFontsReady } from "./ui-fonts";
import { BOSS_COLOR, bossSpotShown, liveBossTurf, turfLine, type EventBossState } from "./boss";
import { skullContext } from "./boss-icons";
import { CLUE_COLOR, DROP_COLOR, FullmapWorldMarks, HOT_COLOR, worldEventsView } from "./world-events-marks";

/** HUD distance convention (hud.tsx / cinematics.ts PX_PER_METER): the scale bar's metres. */
const PX_PER_METER_MAP = 40;

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
  /** BattleState.cycleId (world cycle, 0 = legacy match): the title's "MAP #N". */
  cycle?: number;
  /** Map clock of the wipe (BattleState.durationMs on world maps), 0 / absent = unknown. */
  wipeAt?: number;
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
 * Zone toast top (screen px): 16% of the height (at least 176 px: under the boss bar and its beat
 * toast), and on a short landscape phone (< 480 px) below the React HUD's timer + compass and the
 * boss bar (bossBarY).
 */
export function zoneToastY(screenH: number): number {
  // Never over the boss bar (boss-hud.ts bossBarY 136 on taller screens, beat toast under it).
  return screenH < 480 ? 128 : Math.max(Math.round(screenH * 0.16), 176);
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
// Full map overlay (v2: cartographic art, label pills, legend, compass, scale bar)
// ---------------------------------------------------------------------------------------------

/** How one extract looks on the full map: your open / opening / closed ones, or someone else's. */
export type ExtractLook = FullMapExtractStatus | "foreign";

/** Extract look from the allowed flag and the live view (a foreign extract never shows its state). */
export function extractLook(allowed: boolean, status: FullMapExtractStatus): ExtractLook {
  return allowed ? status : "foreign";
}

const EXTRACT_WAITING = 0xffc94a;
const INK = 0x0b0e0c;
const PILL = 0x0d1210;
const ACCENT = 0xc6f432;
const SPAWN_COLOR = 0x4dabf7;

const extractColor = (look: ExtractLook) =>
  look === "open" ? COLORS.extractOpen : look === "waiting" ? EXTRACT_WAITING : COLORS.extractClosed;

/** Extract icon: a disk with an exit arrow pointing off the map (rotate the Graphics by side), × when closed / foreign. */
function drawExtractIcon(g: Graphics, look: ExtractLook, r: number): Graphics {
  const color = extractColor(look);
  g.clear();
  if (look === "foreign") {
    const q = r * 0.72;
    g.circle(0, 0, q).fill({ color: 0x2a2e33, alpha: 0.85 }).stroke({ width: 1.5, color: 0x8a9099, alpha: 0.8 });
    const d = q * 0.45;
    g.moveTo(-d, -d).lineTo(d, d).moveTo(d, -d).lineTo(-d, d).stroke({ width: 1.8, color: 0x9aa1aa, cap: "round" });
    return g;
  }
  g.circle(0, 0, r + 1.5).fill({ color: INK, alpha: 0.9 });
  if (look === "open") g.circle(0, 0, r).fill({ color });
  else g.circle(0, 0, r).fill({ color: 0x1b1f1a }).stroke({ width: Math.max(2, r * 0.22), color });
  if (look === "closed") {
    const d = r * 0.42;
    g.moveTo(-d, -d).lineTo(d, d).moveTo(d, -d).lineTo(-d, d).stroke({ width: Math.max(2, r * 0.24), color: 0xb7bdc4, cap: "round" });
    return g;
  }
  // Exit arrow (pointing "up" = off the map edge once rotated by side).
  const glyph = look === "open" ? 0x0c2414 : color;
  const s = r / 9;
  g.poly([0, -6.5 * s, 5.2 * s, -0.8 * s, 2 * s, -0.8 * s, 2 * s, 5.5 * s, -2 * s, 5.5 * s, -2 * s, -0.8 * s, -5.2 * s, -0.8 * s]).fill({ color: glyph });
  return g;
}

/** Your marker: a soft halo and a white arrow with a dark outline, pointing along +x (rotate by aim). */
function drawMe(g: Graphics, r: number): Graphics {
  g.clear();
  g.circle(0, 0, r * 1.25).fill({ color: 0xffffff, alpha: 0.18 });
  const s = r / 11;
  g.poly([13 * s, 0, -8 * s, -9 * s, -4 * s, 0, -8 * s, 9 * s]).fill({ color: 0xffffff }).stroke({ width: 2.5, color: 0x111111, join: "round" });
  return g;
}

function drawMate(g: Graphics, color: number, alive: boolean, r: number): Graphics {
  g.clear();
  if (alive) {
    g.circle(0, 0, r * 1.6).fill({ color, alpha: 0.22 });
    g.circle(0, 0, r).fill({ color }).stroke({ width: 2.5, color: 0x111111 });
  } else {
    const d = r;
    g.moveTo(-d, -d).lineTo(d, d).moveTo(d, -d).lineTo(-d, d).stroke({ width: 6, color: 0x111111, alpha: 0.8, cap: "round" });
    g.moveTo(-d, -d).lineTo(d, d).moveTo(d, -d).lineTo(-d, d).stroke({ width: 3, color, cap: "round" });
  }
  return g;
}

/** Small legend glyphs for the world-event marks (same colours as world-events-marks.ts). */
function drawLegendGlyph(g: Graphics, key: LegendKey, r: number): Graphics {
  switch (key) {
    case "you":
      return drawMe(g, r * 0.95);
    case "party":
      return drawMate(g, 0x74c0fc, true, r * 0.6);
    case "extract-open":
      return drawExtractIcon(g, "open", r * 0.85);
    case "extract-waiting":
      return drawExtractIcon(g, "waiting", r * 0.85);
    case "extract-closed":
      return drawExtractIcon(g, "foreign", r * 1.05);
    case "spawn":
      g.clear().roundRect(-r, -r * 0.35, r * 2, r * 0.7, 2).fill({ color: SPAWN_COLOR, alpha: 0.9 });
      return g;
    case "boss":
      g.clear();
      g.context = skullContext(BOSS_COLOR, r);
      return g;
    case "hot":
      g.clear().roundRect(-r, -r * 0.75, r * 2, r * 1.5, 3).fill({ color: HOT_COLOR, alpha: 0.35 }).stroke({ width: 2, color: HOT_COLOR });
      return g;
    case "drop":
      g.clear().circle(0, 0, r).stroke({ width: 2, color: DROP_COLOR });
      g.rect(-r * 0.45, -r * 0.45, r * 0.9, r * 0.9).fill({ color: DROP_COLOR }).stroke({ width: 1.2, color: 0x111111 });
      return g;
    case "clue":
      g.clear().circle(0, 0, r).fill({ color: CLUE_COLOR, alpha: 0.2 }).stroke({ width: 2, color: CLUE_COLOR });
      return g;
  }
}

interface ExtractMark {
  e: ExtractSpot;
  /** Pulse ring (open + yours). */
  ring: Graphics;
  icon: Graphics;
  label: Container;
  pill: Graphics;
  name: Text;
  status: Text;
  /** Last drawn look, null = not drawn yet. */
  look: ExtractLook | null;
}

interface ZoneLabel {
  z: Zone;
  root: Container;
  pill: Graphics;
  name: Text;
  chip: Graphics;
  chipText: Text;
}

/** Text helper: a Text whose size is set from the layout (no scaling of rendered text = crisp). */
function text(fontFamily: string, size: number, fill: number, weight: TextStyleOptions["fontWeight"], extra: Partial<TextStyleOptions> = {}): Text {
  return new Text({ text: "", style: { fontFamily, fontSize: size, fontWeight: weight, fill, ...extra } });
}

function setSize(t: Text, px: number) {
  const v = Math.max(7, Math.round(px * 2) / 2);
  if (t.style.fontSize !== v) t.style.fontSize = v;
}

export class FullMapOverlay {
  readonly root = new Container();
  private readonly fonts = uiFonts();
  private readonly backdrop = new Graphics();
  private readonly chrome = new Graphics();
  private readonly rulerLayer = new Container();
  private readonly rulerTexts: Array<{ t: Text; col: boolean; i: number }> = [];
  private readonly panel = new Container();
  private readonly mapSprite: Sprite;
  private readonly zones = new Graphics();
  private readonly bossZone = new Graphics();
  private readonly sideBand = new Graphics();
  private readonly extractLayer = new Container();
  private readonly labels = new Container();
  private readonly zoneLabels: ZoneLabel[] = [];
  private readonly extracts: ExtractMark[] = [];
  /** Boss spots: skull + name ("FOREMAN"); shown only for the live event boss. */
  private readonly bossMarks: Array<{ b: BossSpot; g: Graphics; pill: Graphics; label: Text; zone: Zone | null }> = [];
  /** Party mates: dot (or ×) + name, pooled; redrawn only when colour / alive change. */
  private readonly mateLayer = new Container();
  private readonly mateMarks: Array<{ g: Graphics; label: Text; key: string }> = [];
  private readonly me = new Graphics();
  private readonly meRing = new Graphics();
  /** WORLD v6 fight heat, hot zones and supply drops (world-events-marks.ts). */
  private readonly worldMarks: FullmapWorldMarks;
  private readonly compass = new Container();
  private readonly compassG = new Graphics();
  private readonly compassN: Text;
  private readonly scale = new Container();
  private readonly scaleG = new Graphics();
  private readonly scaleText: Text;
  private readonly legend = new Container();
  private legendKeyStr = "";
  /** Side / below legends start under the title block (set by layoutTitle). */
  private legendTop = 0;
  private legendBox: Box = { x: 0, y: 0, w: 0, h: 0 };
  private readonly title: Text;
  private readonly meta: Text;
  private readonly sub: Text;
  private readonly hint: Text;
  private lay: FullMapLayout | null = null;
  private size = 1;
  private fontScale = 1;
  private screen = { w: 0, h: 0 };
  private side: MapSide | -1 = -1;
  /** Allowed-extract key of the last label placement ("" = never placed). */
  private placedKey = "";
  private bossShownKey = "";
  private lastMeta = "";
  private lastSub = "";
  private released = false;

  constructor(readonly map: MapData) {
    const { display, body } = this.fonts;
    this.mapSprite = new Sprite(acquireMapArt(map));
    this.worldMarks = new FullmapWorldMarks(body);
    for (const z of map.zones) {
      const root = new Container();
      const pill = new Graphics();
      const name = text(display, 13, 0xffffff, "400", { letterSpacing: 0.5 });
      name.text = z.name.toUpperCase();
      const chip = new Graphics();
      const chipText = text(body, 10, 0x101010, "900");
      chipText.text = `T${z.tier}`;
      root.addChild(pill, name, chip, chipText);
      this.labels.addChild(root);
      this.zoneLabels.push({ z, root, pill, name, chip, chipText });
    }
    for (const e of map.extracts) {
      const ring = new Graphics();
      const icon = new Graphics();
      const label = new Container();
      const pill = new Graphics();
      const name = text(display, 11, 0xffffff, "400", { letterSpacing: 0.5 });
      name.text = e.name.toUpperCase();
      const status = text(body, 10, 0xffffff, "900", { letterSpacing: 0.3 });
      status.text = "OPEN";
      label.addChild(pill, name, status);
      icon.rotation = (e.side * Math.PI) / 2;
      this.extractLayer.addChild(ring, icon);
      this.labels.addChild(label);
      this.extracts.push({ e, ring, icon, label, pill, name, status, look: null });
    }
    for (const b of map.bosses ?? []) {
      const g = new Graphics(skullContext(BOSS_COLOR, 12));
      const pill = new Graphics();
      const label = text(display, 12, BOSS_COLOR, "400", { letterSpacing: 1.5 });
      label.text = BOSSES[b.kind]?.name.toUpperCase() ?? b.kind.toUpperCase();
      label.anchor.set(0, 0.5);
      this.labels.addChild(pill, g, label);
      this.bossMarks.push({ b, g, pill, label, zone: map.zones.find((z) => z.id === b.zone) ?? null });
    }

    this.compassN = text(display, 12, 0xffffff, "400");
    this.compassN.text = "N";
    this.compassN.anchor.set(0.5, 0.5);
    this.compass.addChild(this.compassG, this.compassN);
    this.scaleText = text(body, 10, 0xffffff, "800");
    this.scaleText.anchor.set(0.5, 1);
    this.scale.addChild(this.scaleG, this.scaleText);

    const ruler = gridRuler(map.width, map.height, MAP_GRID_PX);
    ruler.cols.forEach((s, i) => this.addRuler(s, true, i));
    ruler.rows.forEach((s, i) => this.addRuler(s, false, i));

    this.title = text(display, 24, 0xffffff, "400", { letterSpacing: 1, stroke: { color: INK, width: 4 } });
    this.meta = text(body, 14, 0xffd76a, "900", { letterSpacing: 0.5, stroke: { color: INK, width: 3 } });
    this.sub = text(body, 12, 0xc9ced6, "700", { stroke: { color: INK, width: 3 }, wordWrap: true, wordWrapWidth: SIDE_COLUMN_W });
    // Touch has no M key: a tap anywhere (or the × button, touch-controls.ts) closes it.
    this.hint = text(body, 12, 0x9aa3ad, "800", { stroke: { color: INK, width: 3 } });
    this.hint.text = shouldUseTouch() ? "Tap anywhere to close" : "M — close map";

    this.meRing.circle(0, 0, 14).stroke({ width: 2, color: 0xffffff, alpha: 0.9 });
    this.panel.addChild(
      this.mapSprite,
      this.zones,
      this.bossZone,
      this.sideBand,
      this.worldMarks.root,
      this.extractLayer,
      this.labels,
      // Event timers (hot zone, supply drop, clues) stay readable over the static names.
      this.worldMarks.labelLayer,
      this.mateLayer,
      this.meRing,
      this.me,
      this.compass,
      this.scale,
    );
    this.root.addChild(this.backdrop, this.chrome, this.rulerLayer, this.panel, this.legend, this.title, this.meta, this.sub, this.hint);
    this.root.visible = false;
    this.root.eventMode = "none";
    this.root.interactiveChildren = false;
    // Labels drawn before the web fonts load keep the fallback face: re-render them once loaded.
    whenUiFontsReady(() => {
      if (this.root.destroyed) return;
      for (const t of this.allTexts()) t.style.update();
      this.relayout();
    });
  }

  private addRuler(s: string, col: boolean, i: number) {
    const t = text(this.fonts.body, 10, 0x9aa3ad, "800");
    t.text = s;
    t.anchor.set(0.5);
    this.rulerLayer.addChild(t);
    this.rulerTexts.push({ t, col, i });
  }

  private allTexts(): Text[] {
    const out: Text[] = [this.title, this.meta, this.sub, this.hint, this.compassN, this.scaleText];
    for (const z of this.zoneLabels) out.push(z.name, z.chipText);
    for (const m of this.extracts) out.push(m.name, m.status);
    for (const b of this.bossMarks) out.push(b.label);
    for (const r of this.rulerTexts) out.push(r.t);
    for (const m of this.mateMarks) out.push(m.label);
    return out;
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
    this.relayout();
  }

  private relayout() {
    const { w: screenW, h: screenH } = this.screen;
    if (screenW <= 0 || screenH <= 0) return;
    const lay = fullMapLayout(screenW, screenH, shouldUseTouch());
    this.lay = lay;
    const size = lay.panel.size;
    this.size = size;
    const fs = lay.fontScale;
    this.fontScale = fs;
    const k = mapScale(size, this.map);
    this.backdrop.clear().rect(0, 0, screenW, screenH).fill({ color: 0x05080a, alpha: 0.8 });
    this.panel.position.set(lay.panel.x, lay.panel.y);
    this.mapSprite.width = this.map.width * k;
    this.mapSprite.height = this.map.height * k;

    // Frame: shadow, dark border, a hairline, accent corner brackets.
    const { x: px, y: py } = lay.panel;
    const W = this.map.width * k;
    const H = this.map.height * k;
    const c = this.chrome.clear();
    for (let i = 4; i >= 1; i--) c.roundRect(px - i * 2, py - i * 2 + 4, W + i * 4, H + i * 4, 6 + i * 2).fill({ color: 0x000000, alpha: 0.12 });
    if (lay.ruler > 0) {
      c.roundRect(px - lay.ruler - 4, py - lay.ruler - 4, W + lay.ruler + 8, H + lay.ruler + 8, 6).fill({ color: MAP_PALETTE.frame, alpha: 0.92 });
    }
    c.rect(px - 3, py - 3, W + 6, H + 6).fill({ color: MAP_PALETTE.frame });
    c.rect(px - 0.5, py - 0.5, W + 1, H + 1).stroke({ width: 1, color: 0xffffff, alpha: 0.35 });
    const L = Math.max(14, 22 * fs);
    const corner = (x: number, y: number, dx: number, dy: number) =>
      c.moveTo(x + dx * L, y).lineTo(x, y).lineTo(x, y + dy * L).stroke({ width: 3, color: ACCENT, alpha: 0.9, cap: "square" });
    corner(px - 4, py - 4, 1, 1);
    corner(px + W + 4, py - 4, -1, 1);
    corner(px - 4, py + H + 4, 1, -1);
    corner(px + W + 4, py + H + 4, -1, -1);

    // Grid ruler (letters above, numbers left), only on roomy layouts.
    this.rulerLayer.visible = lay.ruler > 0;
    for (const r of this.rulerTexts) {
      setSize(r.t, 10 * fs);
      const mid = (r.i + 0.5) * MAP_GRID_PX * k;
      if (r.col) r.t.position.set(px + Math.min(mid, W - 4), py - lay.ruler / 2 - 2);
      else r.t.position.set(px - lay.ruler / 2 - 2, py + Math.min(mid, H - 4));
      r.t.visible = r.col ? r.i * MAP_GRID_PX < this.map.width : r.i * MAP_GRID_PX < this.map.height;
    }

    // POI areas: a faint tier tint and a tier-coloured outline.
    this.zones.clear();
    for (const z of this.map.zones) {
      const col = TIER_COLORS[z.tier];
      this.zones.roundRect(z.rect.x * k, z.rect.y * k, z.rect.w * k, z.rect.h * k, 5).fill({ color: col, alpha: 0.08 }).stroke({ width: 1.5, color: col, alpha: 0.75 });
    }

    // Labels (sizes depend on the scale), icons, compass, scale bar.
    for (const zl of this.zoneLabels) this.drawZoneLabel(zl, fs);
    const r = this.iconR();
    for (const m of this.extracts) {
      m.icon.position.set(m.e.x * k, m.e.y * k);
      m.ring.position.set(m.e.x * k, m.e.y * k);
      m.look = null; // redraw at the new size
      this.drawExtractLabel(m, fs);
    }
    for (const b of this.bossMarks) {
      b.g.position.set(b.b.x * k, b.b.y * k);
      b.g.scale.set(Math.max(0.8, fs));
      setSize(b.label, 12 * fs);
      b.label.position.set(b.b.x * k + 15 * Math.max(0.8, fs), b.b.y * k);
      b.pill.clear().roundRect(b.label.x - 4, b.label.y - b.label.height / 2 - 2, b.label.width + 8, b.label.height + 4, 6).fill({ color: 0x1a0606, alpha: 0.85 });
    }
    this.meRing.clear().circle(0, 0, r * 1.5).stroke({ width: 2, color: 0xffffff, alpha: 0.9 });
    drawMe(this.me, r * 1.1);
    this.drawCompass(fs, W);
    this.drawScaleBar(k, fs, W, H);

    // Title block.
    setSize(this.title, (lay.title.align === "left" ? 28 : lay.compact ? 15 : 20) * (lay.compact ? 1 : fs));
    setSize(this.meta, (lay.compact ? 12 : 14) * (lay.compact ? 1 : fs));
    setSize(this.sub, 12 * (lay.compact ? 1 : fs));
    setSize(this.hint, 12 * (lay.compact ? 1 : fs));
    this.title.style.wordWrap = lay.title.align === "left";
    this.title.style.wordWrapWidth = lay.title.w;
    this.sub.style.wordWrapWidth = lay.title.w;
    this.lastMeta = "";
    this.lastSub = "";
    this.side = -1; // force the side band to redraw at the new scale
    this.legendKeyStr = ""; // rebuild the legend at the new size
    this.placedKey = "";
  }

  private iconR(): number {
    return Math.max(7, 9 * this.fontScale);
  }

  private drawZoneLabel(zl: ZoneLabel, fs: number) {
    const big = zl.z.tier >= 3;
    if (this.lay?.compact) {
      // Small maps: no chip, the name itself takes the tier colour (saves a third of the width).
      setSize(zl.name, (big ? 11 : 10) * Math.max(0.85, fs));
      zl.name.style.fill = TIER_COLORS[zl.z.tier];
      zl.chip.visible = zl.chipText.visible = false;
      const ch = Math.round(zl.name.height + 2);
      zl.pill.clear().roundRect(0, 0, zl.name.width + 8, ch, ch / 2).fill({ color: PILL, alpha: 0.8 });
      zl.name.position.set(4, (ch - zl.name.height) / 2 + 1);
      return;
    }
    zl.name.style.fill = 0xffffff;
    zl.chip.visible = zl.chipText.visible = true;
    setSize(zl.name, (big ? 14 : 12.5) * fs);
    setSize(zl.chipText, 9.5 * fs);
    const padX = 6 * fs;
    const h = Math.round(zl.name.height + 4 * fs);
    const chipW = zl.chipText.width + 7 * fs;
    const chipH = h - 6 * fs;
    const w = padX + zl.name.width + 5 * fs + chipW + 3 * fs;
    const col = TIER_COLORS[zl.z.tier];
    zl.pill.clear().roundRect(0, 0, w, h, h / 2).fill({ color: PILL, alpha: 0.82 }).stroke({ width: 1, color: col, alpha: 0.55 });
    // Luckiest Guy sits high in its line box: nudge it down a touch for optical centring.
    zl.name.position.set(padX, (h - zl.name.height) / 2 + 1.2 * fs);
    const cx = padX + zl.name.width + 5 * fs;
    zl.chip.clear().roundRect(cx, (h - chipH) / 2, chipW, chipH, chipH / 2).fill({ color: col });
    zl.chipText.position.set(cx + (chipW - zl.chipText.width) / 2, (h - zl.chipText.height) / 2);
  }

  private drawExtractLabel(m: ExtractMark, fs: number) {
    if (this.lay?.compact) {
      // Small maps: one line, "PINE TRAIL  OPENS IN 1:38".
      setSize(m.name, 9.5 * Math.max(0.85, fs));
      setSize(m.status, 8.5 * Math.max(0.85, fs));
      const was = m.status.text;
      m.status.text = "CLOSES 00:00";
      const sw = m.status.width;
      m.status.text = was;
      const ch = Math.max(m.name.height, m.status.height) + 3;
      m.pill.clear().roundRect(0, 0, m.name.width + sw + 14, ch, ch / 2).fill({ color: PILL, alpha: 0.84 });
      m.name.position.set(5, (ch - m.name.height) / 2 + 1);
      m.status.position.set(5 + m.name.width + 4, (ch - m.status.height) / 2);
      return;
    }
    setSize(m.name, 11 * fs);
    setSize(m.status, 9.5 * fs);
    // Reserve the widest status so the pill never changes size while the countdown runs.
    const keep = m.status.text;
    m.status.text = "OPEN · CLOSES 00:00";
    const statusW = m.status.width;
    m.status.text = keep;
    const padX = 6 * fs;
    const w = Math.max(m.name.width, statusW) + padX * 2;
    const h = m.name.height + m.status.height + 4 * fs;
    m.pill.clear().roundRect(0, 0, w, h, 6 * fs).fill({ color: PILL, alpha: 0.84 });
    m.name.position.set(padX, 2 * fs + 1.2 * fs);
    m.status.position.set(padX, 2 * fs + m.name.height);
  }

  private drawCompass(fs: number, W: number) {
    const R = Math.max(12, 17 * fs);
    const g = this.compassG.clear();
    g.circle(0, 0, R).fill({ color: PILL, alpha: 0.85 }).stroke({ width: 1.5, color: 0xffffff, alpha: 0.4 });
    g.poly([0, -R * 0.78, R * 0.32, 0, -R * 0.32, 0]).fill({ color: 0xff5a4f });
    g.poly([0, R * 0.78, R * 0.32, 0, -R * 0.32, 0]).fill({ color: 0xe9ecef });
    g.circle(0, 0, R * 0.12).fill({ color: PILL });
    setSize(this.compassN, 12 * Math.max(0.8, fs));
    this.compassN.position.set(0, -R - this.compassN.height / 2 + 2);
    this.compass.position.set(W - R - 10, R + 10 + this.compassN.height * 0.6);
  }

  private drawScaleBar(k: number, fs: number, W: number, H: number) {
    const sb = scaleBar(k, PX_PER_METER_MAP, 56 * Math.max(0.8, fs));
    setSize(this.scaleText, 10 * Math.max(0.85, fs));
    this.scaleText.text = sb.meters >= 1000 ? `${sb.meters / 1000} km` : `${sb.meters} m`;
    const g = this.scaleG.clear();
    const pad = 6;
    const th = this.scaleText.height;
    const boxW = sb.px + pad * 2;
    const boxH = th + 12;
    g.roundRect(-boxW / 2, -boxH, boxW, boxH, 5).fill({ color: PILL, alpha: 0.82 });
    const y = -6;
    const half = sb.px / 2;
    g.rect(-half, y - 3, half, 4).fill({ color: 0xffffff });
    g.rect(0, y - 3, half, 4).fill({ color: 0x5c636b });
    g.rect(-half, y - 3, sb.px, 4).stroke({ width: 1, color: 0xffffff, alpha: 0.8 });
    this.scaleText.position.set(0, y - 5);
    this.scale.position.set(W - boxW / 2 - 8, H - 8);
  }

  /** Legend rows for what the map shows now; rebuilt only when that set changes. */
  private updateLegend(state: LegendState) {
    const lay = this.lay;
    if (!lay) return;
    const key = legendKey(state) + `|${lay.legend.mode}|${this.fontScale}`;
    if (key === this.legendKeyStr) return;
    this.legendKeyStr = key;
    for (const ch of this.legend.removeChildren()) ch.destroy({ children: true });
    const gutter = lay.legend.mode === "gutter";
    const compact = lay.legend.mode === "inside" || gutter;
    const fs = compact ? Math.min(1, this.fontScale) : Math.max(0.9, this.fontScale);
    const fsz = (compact ? 9.5 : 12.5) * fs;
    const rowH = Math.round((compact ? 14 : 21) * fs);
    const glyphR = (compact ? 5.5 : 8) * fs;
    const items = legendItems(state, gutter).filter((r) => !(lay.legend.mode === "inside" && r.key === "spawn"));
    const bg = new Graphics();
    this.legend.addChild(bg);
    let y = compact ? 6 : 0;
    const x0 = compact ? 6 : 0;
    let maxW = 0;
    if (!compact) {
      const head = text(this.fonts.display, 13 * fs, 0x9aa3ad, "400", { letterSpacing: 2 });
      head.text = "LEGEND";
      head.position.set(0, 0);
      this.legend.addChild(head);
      y += head.height + 8;
    }
    for (const row of items) {
      const g = drawLegendGlyph(new Graphics(), row.key, glyphR);
      g.position.set(x0 + glyphR + 2, y + rowH / 2);
      const t = text(this.fonts.body, fsz, 0xe9ecef, "800");
      t.text = row.label;
      t.position.set(x0 + glyphR * 2 + 10 * fs, y + (rowH - t.height) / 2);
      this.legend.addChild(g, t);
      maxW = Math.max(maxW, t.x + t.width);
      y += rowH;
    }
    // Tier chips.
    let cx = x0;
    const chipH = Math.round((compact ? 12 : 17) * fs);
    y += compact ? 2 : 6;
    for (const tier of [1, 2, 3, 4] as const) {
      const t = text(this.fonts.body, (compact ? 8.5 : 10.5) * fs, 0x101010, "900");
      t.text = `T${tier}`;
      const w = t.width + 8 * fs;
      const chip = new Graphics().roundRect(cx, y, w, chipH, chipH / 2).fill({ color: TIER_COLORS[tier] });
      t.position.set(cx + (w - t.width) / 2, y + (chipH - t.height) / 2);
      this.legend.addChild(chip, t);
      cx += w + 4 * fs;
    }
    if (!gutter) {
      const tl = text(this.fonts.body, fsz, 0xc9ced6, "700");
      tl.text = "loot tier";
      tl.position.set(cx + 2 * fs, y + (chipH - tl.height) / 2);
      this.legend.addChild(tl);
      maxW = Math.max(maxW, tl.x + tl.width);
    } else maxW = Math.max(maxW, cx - 4 * fs);
    y += chipH;
    const w = maxW + (compact ? 8 : 0);
    const h = y + (compact ? 6 : 0);
    if (compact) bg.roundRect(0, 0, w, h, 6).fill({ color: PILL, alpha: 0.82 }).stroke({ width: 1, color: 0xffffff, alpha: 0.15 });
    // Position.
    if (lay.legend.mode === "inside") {
      const p = lay.panel;
      const S = this.size;
      const k = mapScale(S, this.map);
      const pts = [
        ...this.map.extracts.map((e) => ({ x: p.x + e.x * k, y: p.y + e.y * k })),
        ...this.map.zones.map((z) => ({ x: p.x + (z.rect.x + z.rect.w / 2) * k, y: p.y + (z.rect.y + z.rect.h / 2) * k })),
      ];
      const corner = pickLegendCorner(
        [
          { x: p.x + 6, y: p.y + S - h - 6 },
          { x: p.x + 6, y: p.y + 6 },
        ],
        w,
        h,
        pts,
      );
      this.legend.position.set(corner.x, corner.y);
      this.legendBox = { x: corner.x - p.x, y: corner.y - p.y, w, h };
    } else if (gutter) {
      this.legend.position.set(Math.round(lay.legend.x - w), lay.legend.y);
      this.legendBox = { x: 0, y: 0, w: 0, h: 0 };
    } else {
      this.legend.position.set(lay.legend.x, this.legendTop || lay.legend.y);
      this.legendBox = { x: 0, y: 0, w: 0, h: 0 };
    }
    this.placedKey = ""; // the legend box is an obstacle for the labels
  }

  /** Places POI and (your) extract labels without overlaps; called when sizes or the allowed set change. */
  private placeLabels(allowedFlags: readonly boolean[]) {
    const k = mapScale(this.size, this.map);
    const S = this.size;
    const fs = this.fontScale;
    const r = this.iconR();
    const obstacles: Box[] = [];
    for (const e of this.map.extracts) obstacles.push({ x: e.x * k - r - 2, y: e.y * k - r - 2, w: 2 * r + 4, h: 2 * r + 4 });
    for (const b of this.bossMarks) {
      if (!b.g.visible) continue;
      obstacles.push({ x: b.b.x * k - 13 * fs, y: b.b.y * k - 13 * fs, w: 30 * fs + b.label.width, h: 26 * fs });
    }
    const cb = this.compass.getLocalBounds();
    obstacles.push({ x: this.compass.x + cb.x - 4, y: this.compass.y + cb.y - 4, w: cb.width + 8, h: cb.height + 8 });
    const sbb = this.scale.getLocalBounds();
    obstacles.push({ x: this.scale.x + sbb.x - 4, y: this.scale.y + sbb.y - 4, w: sbb.width + 8, h: sbb.height + 8 });
    if (this.legendBox.w > 0) obstacles.push(this.legendBox);
    // Event timer labels (hot zone, supply drop, clue) are drawn on top: names step aside.
    for (const b of this.worldMarks.boxes) obstacles.push(b);

    const reqs: LabelRequest[] = [];
    this.extracts.forEach((m, i) => {
      if (!allowedFlags[i]) return;
      const b = m.pill.getLocalBounds();
      reqs.push({ id: `e${i}`, w: b.width, h: b.height, priority: 100, candidates: extractLabelCandidates(m.e.x * k, m.e.y * k, m.e.side, b.width, b.height, r) });
    });
    this.zoneLabels.forEach((zl, i) => {
      const b = zl.pill.getLocalBounds();
      const rect = { x: zl.z.rect.x * k, y: zl.z.rect.y * k, w: zl.z.rect.w * k, h: zl.z.rect.h * k };
      reqs.push({ id: `z${i}`, w: b.width, h: b.height, priority: zl.z.tier * 10, candidates: zoneLabelCandidates(rect, b.width, b.height) });
    });
    const placed = placeLabels(reqs, { x: 2, y: 2, w: S - 4, h: S - 4 }, obstacles, 2);
    this.extracts.forEach((m, i) => {
      const p = placed.get(`e${i}`);
      m.label.visible = !!p;
      if (p) m.label.position.set(Math.round(p.x), Math.round(p.y));
    });
    this.zoneLabels.forEach((zl, i) => {
      const p = placed.get(`z${i}`);
      if (!p) return;
      zl.root.position.set(Math.round(p.x), Math.round(p.y));
      zl.root.alpha = p.overlap ? 0.85 : 1;
    });
  }

  /**
   * Per frame while open. `allowed` = per-extract flags (allowedFromMask), `side` = spawn side,
   * `self` = your position/aim (null when dead), `clockMs` = match clock (closing extracts),
   * `live` = synced extract times, your personal arm, the event boss, party, cycle and wipe.
   */
  update(
    self: { x: number; y: number; aim: number } | null,
    allowed: readonly boolean[] | null,
    side: MapSide | null,
    clockMs: number,
    nowMs: number,
    live: FullMapLive | null = null,
  ) {
    if (!this.root.visible || !this.lay) return;
    const lay = this.lay;
    const k = mapScale(this.size, this.map);
    const fs = this.fontScale;
    const flags = this.map.extracts.map((_, i) => (allowed ? !!allowed[i] : true));

    // Title block: name, map number + wipe countdown, spawn side + your extracts (text only on change).
    const mapName = MAPS[this.map.id]?.name ?? "Map";
    const wipeIn = live?.wipeAt && live.wipeAt > 0 ? live.wipeAt - clockMs : null;
    const metaText = fullMapMeta(live?.cycle ?? 0, wipeIn);
    const yours = allowed ? flags.filter(Boolean).length : null;
    const subText = fullMapSubtitle(side, yours);
    if (metaText !== this.lastMeta || subText !== this.lastSub) {
      this.lastMeta = metaText;
      this.lastSub = subText;
      this.layoutTitle(mapName, metaText, subText);
    }

    if (side !== null && side !== this.side) {
      this.side = side;
      const W = this.map.width * k;
      const H = this.map.height * k;
      const t = Math.max(5, 7 * fs);
      const band = [
        [0, 0, W, t],
        [W - t, 0, t, H],
        [0, H - t, W, t],
        [0, 0, t, H],
      ][side]!;
      this.sideBand.clear().rect(band[0]!, band[1]!, band[2]!, band[3]!).fill({ color: SPAWN_COLOR, alpha: 0.75 });
    }

    // Boss: only the live event boss's spot keeps its skull, and its POI gets a pulsing red ring.
    const bosses = this.map.bosses ?? [];
    let bossKey = "";
    for (let i = 0; i < this.bossMarks.length; i++) {
      const m = this.bossMarks[i]!;
      const shown = bossSpotShown(bosses, i, live?.boss ?? null);
      m.g.visible = m.label.visible = m.pill.visible = shown;
      if (shown) bossKey += `${i},`;
    }
    if (bossKey !== this.bossShownKey) {
      this.bossShownKey = bossKey;
      this.bossZone.clear();
      for (const m of this.bossMarks) {
        if (!m.g.visible || !m.zone) continue;
        const z = m.zone.rect;
        this.bossZone.roundRect(z.x * k - 3, z.y * k - 3, z.w * k + 6, z.h * k + 6, 7).fill({ color: BOSS_COLOR, alpha: 0.14 }).stroke({ width: 3, color: BOSS_COLOR, alpha: 1 });
      }
      this.placedKey = "";
    }
    this.bossZone.alpha = 0.55 + 0.45 * Math.sin(nowMs / 300);

    // Legend for what is on the map now (rebuilt only when the set changes).
    const v = worldEventsView;
    this.updateLegend({
      mates: live?.mates?.length ?? 0,
      boss: bossKey !== "",
      hot: v.hots.some((h) => h.state !== WEV_STATE.DONE && !!h.rect),
      drop: v.drops.some((d) => d.state !== WEV_STATE.DONE),
      clue: v.clues.length > 0,
      spawn: side !== null,
    });

    // Extracts: icon by look, pulse ring on your open ones, status line with the countdown.
    const r = this.iconR();
    this.extracts.forEach((m, i) => {
      const ok = flags[i]!;
      const view = fullMapExtractView(m.e, live?.extract(m.e.id), live?.armAt ?? 0, clockMs);
      const look = extractLook(ok, view.status);
      if (m.look !== look) {
        m.look = look;
        drawExtractIcon(m.icon, look, r);
        m.icon.rotation = look === "foreign" || look === "closed" ? 0 : (m.e.side * Math.PI) / 2;
        m.ring.clear();
        if (look === "open") m.ring.circle(0, 0, r + 3).stroke({ width: 2.5, color: COLORS.extractOpen, alpha: 1 });
        m.status.style.fill = look === "open" ? COLORS.extractOpen : look === "waiting" ? EXTRACT_WAITING : 0x9aa1aa;
        m.name.style.fill = look === "closed" ? 0xaab0b8 : 0xffffff;
      }
      if (ok) {
        const full = extractStatusText(view.status, view.suffix);
        const st = this.lay?.compact ? full.replace("OPEN · CLOSES", "CLOSES").replace("OPENS IN", "OPENS") : full;
        if (m.status.text !== st) m.status.text = st;
      }
      if (look === "open") {
        const t = (nowMs % 1600) / 1600;
        m.ring.scale.set(1 + t * 0.9);
        m.ring.alpha = 1 - t;
      }
    });
    this.worldMarks.update(this.map, k, nowMs, fs);
    const placeKey = flags.map((f) => (f ? 1 : 0)).join("") + `|${this.legendKeyStr}|${this.bossShownKey}|${this.worldMarks.boxKey}`;
    if (placeKey !== this.placedKey) {
      this.placedKey = placeKey;
      this.placeLabels(flags);
    }

    this.updateMates(live?.mates ?? [], k);
    this.me.visible = this.meRing.visible = !!self;
    if (self) {
      this.me.position.set(self.x * k, self.y * k);
      this.me.rotation = self.aim;
      this.meRing.position.copyFrom(this.me.position);
      const t = (nowMs % 1400) / 1400;
      this.meRing.scale.set(0.8 + t * 1.2);
      this.meRing.alpha = 0.9 * (1 - t);
    }
  }

  private layoutTitle(mapName: string, metaText: string, subText: string) {
    const lay = this.lay!;
    const side = lay.title.align === "left";
    if (side) {
      this.title.text = mapName.toUpperCase();
      this.meta.text = metaText;
      this.sub.text = subText;
      this.title.anchor.set(0, 0);
      this.meta.anchor.set(0, 0);
      this.sub.anchor.set(0, 0);
      this.title.position.set(lay.title.x, lay.title.y - 4);
      this.meta.position.set(lay.title.x, this.title.y + this.title.height + 2);
      this.sub.position.set(lay.title.x, this.meta.y + this.meta.height + 4);
      this.meta.visible = !!metaText;
      this.sub.visible = !!subText;
      // The legend starts under the title block.
      this.legendTop = Math.round(this.sub.y + (subText ? this.sub.height : 0) + 22);
      if (lay.legend.mode === "side") this.legend.y = this.legendTop;
      this.hint.anchor.set(0, 1);
      this.hint.position.set(lay.title.x, lay.panel.y + lay.panel.size);
    } else {
      // One line above the map; the sub line shares it when there is room.
      this.title.text = metaText ? `${mapName.toUpperCase()} · ${metaText}` : mapName.toUpperCase();
      this.title.anchor.set(0.5, 1);
      this.title.position.set(lay.title.x + lay.title.w / 2, lay.panel.y - (lay.compact ? 6 : 8));
      this.meta.visible = false;
      this.sub.text = subText;
      this.sub.anchor.set(0.5, 0);
      this.sub.visible = lay.legend.mode === "below" && !!subText;
      this.sub.position.set(lay.panel.x + lay.panel.size / 2, lay.panel.y + lay.panel.size + 6);
      if (lay.legend.mode === "below") {
        this.legendTop = Math.round(lay.legend.y + (this.sub.visible ? this.sub.height + 8 : 0));
        this.legend.y = this.legendTop;
      }
      this.hint.anchor.set(0.5, 0);
      this.hint.position.set(lay.hint.x, lay.hint.y);
    }
    this.hint.visible = lay.hint.visible;
  }

  private updateMates(mates: NonNullable<FullMapLive["mates"]>, k: number) {
    const fs = this.fontScale;
    while (this.mateMarks.length < mates.length) {
      const g = new Graphics();
      const label = text(this.fonts.body, 12 * fs, 0xffffff, "900", { stroke: { color: INK, width: 4 } });
      label.anchor.set(0, 0.5);
      this.mateLayer.addChild(g, label);
      this.mateMarks.push({ g, label, key: "" });
    }
    for (let i = 0; i < this.mateMarks.length; i++) {
      const mk = this.mateMarks[i]!;
      const m = mates[i];
      mk.g.visible = mk.label.visible = !!m;
      if (!m) continue;
      const key = `${m.color}|${m.alive}|${fs}`;
      if (mk.key !== key) {
        mk.key = key;
        drawMate(mk.g, m.color, m.alive, 6.5 * Math.max(0.85, fs));
        mk.label.style.fill = m.color;
        setSize(mk.label, 12 * fs);
      }
      const t = m.alive ? m.name : `${m.name} · down`;
      if (mk.label.text !== t) mk.label.text = t;
      mk.g.position.set(m.x * k, m.y * k);
      mk.label.position.set(m.x * k + 12 * fs, m.y * k);
      mk.g.alpha = mk.label.alpha = m.alive ? 1 : 0.8;
    }
  }

  destroy() {
    this.root.destroy({ children: true });
    if (!this.released) {
      this.released = true;
      releaseMapArt(this.map);
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
            cycle: state?.cycleId ?? 0,
            // World maps (entryCloseMs > 0) wipe at the end of the match clock (intro.ts wipeLine).
            wipeAt: state && state.entryCloseMs > 0 ? state.durationMs : 0,
          },
        );
      }
    },
    // The open map owns the mouse (renderer: no fire, aim and look-ahead frozen).
    isInputBlocked: () => wantOpen && !disposed,
    // Touch: a tap on the minimap, same toggle as the key.
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
