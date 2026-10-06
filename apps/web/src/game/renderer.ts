/**
 * Pixi 8 renderer + input + netcode for the battle room (v2).
 *
 * - The server is authoritative; the client sends an InputSample every INPUT_DT_MS (movement, aim,
 *   trigger, roll, walk) plus discrete intents (interact / reload / switch / heal).
 * - The local player is predicted with the shared stepMovement (Predictor) and reconciled against
 *   SelfState.lastSeq + roll state on every patch; remote players are interpolated two patches (INTERP_DELAY_MS) in the
 *   past.
 * - Self data comes from the owner-only `state.self.get(selfKey)`; `state.players` only holds the
 *   players this client can see (server LOS via StateView), so entries appear and disappear all
 *   the time: views are pooled, fade in / out, and their interpolation buffer is cleared on re-add.
 * - Per-tick events arrive as ONE `S2C.EV` batch (shots / hits / kills / snd / chest), handled here
 *   and forwarded to the plug-in systems (systems.ts / systems-registry.ts).
 * - Fog of war (fog.ts): one half-res RT composited above the world; remote players, items and
 *   corpses get per-entity alpha = coneAlpha × CPU line of sight. No sprite masks anywhere.
 * - The static map is rebuilt locally (generateMap(state.mapId), or the legacy v1 map while the
 *   server still runs it — state.mapId === "legacy").
 *
 * - Phones (coarse pointer, ?touch=1): touch-controls.ts sticks and buttons feed the same
 *   InputController; the move stick steers the facing while the aim stick is idle.
 * - Crosshair (crosshair.ts): a CSS cursor over the canvas on desktop; on phones a reticle on the
 *   aim-stick line at the effective aim distance (screen layer, above the fog).
 * - Party (party.ts): S2C.PARTY feeds a PartyTracker; its smoothed mates go to the minimap, and to
 *   the systems through GameContext.partyMates (world markers, the full map).
 *
 * - Death replay (killcam.ts): every frame the renderer records what it drew (camera, fog eye,
 *   player sprites, effects) into a bounded ring; after the death it can replay the last seconds
 *   from that record alone (startReplay) — no server data, so nothing the client did not see.
 * - Spectating a party mate (C2S / S2C.SPECTATE, server sim/spectate.ts): after the death or the
 *   extraction the server mirrors the mate's view into this client's state; the camera, fog eye,
 *   listener and systems' "self position" follow the mate's sprite (spectate()).
 *
 * Used by battle-screen.tsx: `new GameRenderer({ mountEl, room, onHud, selfKey }); await r.start(); … r.stop()`.
 */

import { Application, Container, Graphics } from "pixi.js";
import { getStateCallbacks } from "colyseus.js";
import {
  ACT,
  ARMOR,
  C2S,
  GRENADE,
  GRENADE_DEF,
  HEAL,
  INPUT_DT_MS,
  MATCH,
  NPC_ROLE,
  S2C,
  SERVER_TICK_MS,
  SOLID,
  WEAPONS,
  XP,
  buildBushIndex,
  bushIndexAt,
  countOf,
  envConfigOf,
  extractOpenAtFor,
  generateMap,
  getCollisionIndex,
  legacyMapData,
  sampleEnv,
  type BattleState,
  type BushIndex,
  type CollisionIndex,
  type Corpse,
  type EnvConfig,
  type EnvSample,
  type EventsMsg,
  type Extract,
  type GroundItem,
  type HitMsg,
  type InputSample,
  type JoinedMsg,
  type KillMsg,
  type MapData,
  type MapId,
  type Player,
  type SelfState,
  type ShotMsg,
  type SpectateEndReason,
  type SpectateMsg,
  type ThrowMsg,
  type WeaponId,
  type XpMsg,
} from "@extract/shared";
import { COLORS, destroyTextures, loadTextures, type Textures } from "./assets";
import { Effects } from "./effects";
import { ContainerLayer, CorpseView, ExtractView, IconCache, ItemView, PlayerView, containerSprite } from "./entities";
import { ANIM } from "./char-anim";
import { FogOfWar, PLAYER_PAD, entityVisibility, fadeToward, fogLook, fogRange, type FogEye, type FogLook } from "./fog";
import { buildHud, extractAllowed, personalExtractStatus, stickyCounts, type PlayerCounts } from "./hud";
import { EXPIRE_FADE_TAU_MS, expiryBlink, expiryFading } from "./expiry";
import { InputController, sampleAim, type GrenadeAim } from "./input";
import { GRENADE_TAP_FRAC, grenadeFracFor } from "./grenades";
import { PerfOverlay, TouchControls, hudReservedRects, shouldUseTouch } from "./touch-controls";
import { TouchCrosshair, releaseCanvasCursor, setCanvasCrosshair, touchAimLean, touchCrosshairDistance } from "./crosshair";
import { Minimap, type MinimapExtract } from "./minimap";
import { PartyTracker, type PartyMateView } from "./party";
import { autoFireTarget, isPartyMate, type AutoFireCandidate } from "./auto-fire";
import { canStartHeal, decayFactor, inputCancelsHeal, moveFnFor, Predictor, readServerMove } from "./prediction";
import { DelayQueue, shotCentre } from "./shots";
import type { CameraView, GameContext, GameLayers, GameSystem, SystemCommand } from "./systems";
import { SYSTEM_FACTORIES } from "./systems-registry";
import { worldEventsView } from "./world-events-marks";
import type { GameRendererApi, HudSnapshot, KillFeedEntry, RendererOptions, XpGain } from "./types";
import { KnownEmpty } from "./known-empty";
import { WorldView, type ViewRect } from "./world";
import { EMPTY_TALLY, bossKindOfLabel, corpseNpcRole, npcDisplayName, npcRoleName, tallyKill, type KillTally, type NpcRoleName } from "./npc-labels";
import { getGameAudio } from "./audio/game-audio";
import { OwnShotPredictor, predictedAngles } from "./own-shot";
import { clearTouchLook, feedAimPointer, getCameraRig, reducedMotion, setTouchLook, setTouchSticksActive } from "./camera";
import { SPRITE_RECOIL_PX } from "./combat-fx";
import { FX, KillcamPlayer, KillcamRecorder, entOf, lerpAngle, type FrameSnap, type FxSnap, type ReplaySample } from "./killcam";

/** A falling body hands over to its corpse when the fall lands (the body then crossfades out). */
const CORPSE_HANDOVER_MS = ANIM.DEATH_MS;

/** About this many world units are visible (by area), whatever the window size. */
const VIEW_W = 1600;
const VIEW_H = 900;
/** Retina at full resolution is expensive for little gain with this art style. */
const MAX_RESOLUTION = 1.5;
/** Remote players are drawn this far in the past (two patches) so there is always a pair to interpolate. */
const INTERP_DELAY_MS = 2 * SERVER_TICK_MS;
/** Corrections larger than this snap instead of gliding (spawn, teleport, long desync). */
const SNAP_DIST = 96;
/** Time constant for gliding away small prediction errors. */
const CORRECTION_TAU_MS = 90;
const HUD_INTERVAL_MS = 33;
const PING_INTERVAL_MS = 2000;
const KILL_FEED_MAX = 5;
const KILL_FEED_TTL_MS = 6000;
/** How long an XP gain stays in the HUD ticker (EventsMsg.xp). */
export const XP_GAIN_SHOW_MS = 2400;
const XP_POP_COLOR = 0xffd54a;
const XP_CAP_COLOR = 0xb8b8b8;
/** Padding around the viewport for culling, so big sprites do not pop at the edges. */
const CULL_MARGIN = 160;
/** Never let the local clock estimate run further than this ahead of the last server clock. */
const CLOCK_LEAD_MAX_MS = 250;
/** Pooled player views kept for re-adds (a player stepping back into view). */
const PLAYER_POOL_MAX = 24;
/** A system that throws this many times is switched off (it must not take the match down). */
const SYSTEM_MAX_ERRORS = 5;

/** state.mapId of the v1 4800 px map while the server migration still runs on it. */
export const LEGACY_MAP_ID = "legacy";

/** The static map a state describes (same function the server's map choice must match). */
export function mapForState(state: Pick<BattleState, "mapId" | "mapSeed">): MapData {
  if (state.mapId === LEGACY_MAP_ID) return legacyMapData(state.mapSeed >>> 0);
  return generateMap((state.mapId || "steppe") as MapId);
}

interface Fading<T, V> {
  state: T;
  view: V;
  /** onRemove fired: fade out, then drop / pool the view. */
  removing: boolean;
}

/** Static world fallback when the chunked world cannot be built (e.g. an unexpected map shape). */
class FallbackWorld {
  readonly ground = new Container();
  readonly canopy = new Container();
  constructor(map: MapData) {
    const g = new Graphics();
    g.rect(0, 0, map.width, map.height).fill(COLORS.background);
    for (const b of map.buildings) g.rect(b.floor.x, b.floor.y, b.floor.w, b.floor.h).fill(COLORS.floorFill);
    for (const r of map.rects) g.rect(r.x, r.y, r.w, r.h).fill(r.f & SOLID.SIGHT ? COLORS.wallFill : 0x6f8a9c);
    for (const c of map.circles) g.circle(c.x, c.y, c.r).fill(0x5b4b3a);
    this.ground.addChild(g);
    const b = new Graphics();
    for (const c of map.bushes) b.circle(c.x, c.y, c.r).fill({ color: 0x2f6b2a, alpha: 0.85 });
    this.canopy.addChild(b);
  }
  update() {}
  destroy() {
    this.ground.destroy({ children: true });
    this.canopy.destroy({ children: true });
  }
}

type StaticWorld = { ground: Container; canopy: Container; update(view: ViewRect, self: { x: number; y: number } | null, dtMs?: number): void; destroy(): void; warmup?(x: number, y: number): void };

const NO_SYSTEMS: readonly GameSystem[] = [];

/**
 * True when a DOM overlay (battle-screen's isInputBlocked) or a canvas system (the full map) owns
 * the mouse. Allocation-free: called every frame.
 */
export function inputBlockedBy(external: (() => boolean) | undefined, systems: readonly GameSystem[]): boolean {
  if (external?.()) return true;
  for (const s of systems) if (s.isInputBlocked?.() === true) return true;
  return false;
}

export class GameRenderer implements GameRendererApi {
  private app: Application | null = null;
  private tex: Textures | null = null;
  private icons: IconCache | null = null;
  private started = false;
  private stopped = false;
  /** room.onLeave fired (or the socket is gone): nothing may be sent any more. */
  private left = false;

  private readonly world = new Container();
  private readonly groundSlot = new Container();
  private readonly extractLayer = new Container();
  private readonly containerSlot = new Container();
  private readonly corpseLayer = new Container();
  private readonly itemLayer = new Container();
  private readonly playerLayer = new Container();
  /** Sprites of the death replay (killcam.ts), shown instead of playerLayer while it plays. */
  private readonly replayLayer = new Container();
  private readonly effectsSlot = new Container();
  private readonly canopySlot = new Container();
  private readonly floatSlot = new Container();
  private readonly layers: GameLayers = {
    ground: new Container(),
    worldFx: new Container(),
    worldTop: new Container(),
    screen: new Container(),
  };

  private worldView: StaticWorld | null = null;
  private mapData: MapData | null = null;
  private idx: CollisionIndex | null = null;
  private bushes: BushIndex | null = null;
  private containers: ContainerLayer | null = null;
  private minimap: Minimap | null = null;
  private fog: FogOfWar | null = null;
  private effects: Effects | null = null;
  /** Other players' shots / hits, waiting to be shown on the interpolated (past) timeline. */
  private readonly remoteFx = new DelayQueue();
  private input: InputController | null = null;
  /** Phones (touch-controls.ts): sticks + buttons, the aim-stick reticle; ?perf=1 overlay. */
  private touch: TouchControls | null = null;
  private touchCrosshair: TouchCrosshair | null = null;
  private perf: PerfOverlay | null = null;
  /** Desktop crosshair cursor currently on the canvas (null = not set yet). */
  private cursorCrosshair: boolean | null = null;

  private players = new Map<string, Fading<Player, PlayerView>>();
  /** Where players that left this client's view were last drawn (GameContext.lastSeen). */
  private readonly goneAt = new Map<string, { x: number; y: number; at: number }>();
  /** An overlay owns the mouse this frame (GameContext.inputBlocked). */
  private inputBlockedNow = false;
  private playerPool: PlayerView[] = [];
  private items = new Map<string, Fading<GroundItem, ItemView>>();
  private corpses = new Map<string, Fading<Corpse, CorpseView>>();
  private extracts = new Map<string, { state: Extract; view: ExtractView }>();

  private systems: GameSystem[] = [];
  private systemErrors = new Map<GameSystem, number>();
  private systemsReady = false;
  private ctx: GameContext | null = null;
  /** Weapons v2: earliest performance.now() of the next grenade throw (GRENADE.COOLDOWN_MS, client side). */
  private nextThrowAt = 0;
  private screenW = 0;
  /** Touch device held upright: the game waits under the rotate overlay (battle-screen.tsx). */
  private portrait = false;
  private screenH = 0;

  private disposers: Array<() => void> = [];
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  /** S2C.JOINED seen by the renderer itself (the screen usually captures it first). */
  private joinedSelfKey: string | null = null;
  /** S2C.PARTY: the local player's party mates (party.ts). */
  private readonly party = new PartyTracker();
  /** This frame's smoothed mates (GameContext.partyMates, minimap). */
  private partyNow: readonly PartyMateView[] = [];
  /** Every players-map id that has been a party mate this raid (phone auto-fire never targets them). */
  private readonly mateIds = new Set<string>();

  // Netcode
  private predictor: Predictor | null = null;
  /** Predicted position before the latest input, for smoothing between 30 Hz input steps. */
  private prevPredX = 0;
  private prevPredY = 0;
  /** Visual offset left over from reconciliation, decays to 0. */
  private corrX = 0;
  private corrY = 0;
  private inputAcc = 0;
  /**
   * A click sent ahead of the fixed cadence borrowed this much of the next step (ms): the following
   * sample waits INPUT_DT_MS + inputLead, so the server still sees exactly INPUT_HZ samples a second.
   * Non-zero until that next regular sample.
   */
  private inputLead = 0;
  private aim = 0;
  /** Fire state of the last input sent (semi-auto weapons fire on a press). */
  private prevFire = false;
  /** Own shots drawn on the input that fires them; their server echo is then skipped (own-shot.ts). */
  private readonly ownShot = new OwnShotPredictor();
  /** Local player's rendered position (what the camera follows and aim is measured from). */
  private selfRender: { x: number; y: number } | null = null;
  private camX = 0;
  private camY = 0;
  private zoom = 1;
  private warmedUp = false;

  // Clock estimate between patches (SERVER_TICK_HZ).
  private clockBase = 0;
  private clockBaseAt = 0;

  // Environment (deterministic from the state: no per-tick sync).
  private envCfg: EnvConfig | null = null;
  private envKey = "";
  private env: EnvSample | null = null;
  private look: FogLook = fogLook(null);
  private eye: FogEye | null = null;

  private lastFrameAt = 0;
  private lastHudAt = 0;
  private pingMs: number | null = null;
  private killFeed: Array<KillFeedEntry & { receivedAt: number }> = [];
  /** EventsMsg.xp of the last XP_GAIN_SHOW_MS (HUD XP ticker). */
  private xpGains: Array<XpGain & { receivedAt: number }> = [];
  private xpSeq = 0;
  /** Containers / bodies this client searched and saw empty (no prompt, no glow, dimmed). */
  private readonly known = new KnownEmpty();
  private killSeq = 0;
  /** The local player's kills this raid by victim kind (outcome screen: players vs NPCs). */
  private killTally: KillTally = { ...EMPTY_TALLY };
  /** NPC display names this client has seen with their role (corpse labels → NPC body look). */
  private readonly npcNames = new Map<string, NpcRoleName>();
  /** Per corpse id: resolved NPC look (recomputed only when the label changes). */
  private readonly corpseNpc = new Map<string, { label: string; npc: NpcRoleName | null; name: string }>();
  /** Last player counts taken while the raid was running (the end of the match clears "alive"). */
  private counts: PlayerCounts | null = null;

  // Death replay (killcam.ts): what this client drew, replayed from that record only.
  private readonly killcam = new KillcamRecorder();
  private replay: KillcamPlayer | null = null;
  private replayProgress = 0;
  private replayPlayed = false;
  private readonly replayViews = new Map<string, PlayerView>();
  private readonly replaySeen = new Set<string>();
  private readonly replayFx: FxSnap[] = [];
  /** When each corpse entered this client's view (the replay hides the ones that came later). */
  private readonly corpseAddedAt = new Map<string, number>();
  /** The local player died (not extracted): the replay is offered. */
  private diedHere = false;

  // Spectating a party mate (S2C.SPECTATE).
  private watch: { key: string; id: string; name: string } | null = null;
  private watchPending: string | null = null;
  private watchEnded: { reason: SpectateEndReason; name: string } | null = null;
  /** Where the camera, fog eye and listener are this frame while replaying / spectating (null = self). */
  private focus: { x: number; y: number } | null = null;
  private readonly focusPt = { x: 0, y: 0 };
  private focusAim = 0;

  constructor(private readonly opts: RendererOptions) {}

  private get selfId(): string {
    return this.opts.room.sessionId;
  }

  private get state(): BattleState | null {
    try {
      return (this.opts.room.state as BattleState | undefined) ?? null;
    } catch {
      return null;
    }
  }

  /** JOINED.selfKey, else the only entry of state.self (each client's view holds just its own). */
  selfKey(): string | null {
    const k = this.opts.selfKey?.() ?? this.joinedSelfKey;
    if (k) return k;
    const self = this.state?.self;
    if (!self) return null;
    let only: string | null = null;
    let n = 0;
    self.forEach((_v, key) => {
      only = key;
      n++;
    });
    return n === 1 ? only : null;
  }

  private selfState(): SelfState | null {
    const k = this.selfKey();
    return k ? (this.state?.self.get(k) ?? null) : null;
  }

  private me(): Player | null {
    return this.state?.players.get(this.selfId) ?? null;
  }

  /** The static map once known (search titles, overlays). */
  map(): MapData | null {
    return this.mapData;
  }

  async start(): Promise<void> {
    if (this.started || this.stopped) return;
    this.started = true;
    this.watchLeave();

    const app = new Application();
    await app.init({
      background: COLORS.background,
      resizeTo: this.opts.mountEl,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(MAX_RESOLUTION, window.devicePixelRatio || 1),
      powerPreference: "high-performance",
      preference: "webgl",
    });
    if (this.stopped) {
      app.destroy(true, { children: true });
      return;
    }
    this.app = app;

    const tex = await loadTextures();
    if (this.stopped) {
      destroyTextures(tex);
      return;
    }
    this.tex = tex;
    this.icons = new IconCache();

    this.opts.mountEl.appendChild(app.canvas);
    app.canvas.style.display = "block";
    app.canvas.style.touchAction = "none";
    // Pixi's event system writes canvas.style.cursor = cursorStyles.default ("inherit") on every
    // pointer move; an inline cursor beats the .game-crosshair class, so the desktop crosshair never
    // showed. "" leaves the inline style empty and the class (crosshair.ts) decides.
    releaseCanvasCursor(app);

    // Weapons v2: crossbow bolts fly as the bolt sprite.
    this.effects = new Effects({ bolt: tex.bolt });
    this.effectsSlot.addChild(this.effects.layer);
    this.floatSlot.addChild(this.effects.floatLayer);
    this.world.addChild(
      this.groundSlot,
      this.layers.ground,
      this.extractLayer,
      this.containerSlot,
      this.corpseLayer,
      this.itemLayer,
      this.playerLayer,
      this.replayLayer,
      this.effectsSlot,
      this.layers.worldFx,
      this.canopySlot,
      this.floatSlot,
      this.layers.worldTop,
    );
    // The fog composite is inserted between the world and the screen layer once the map is known.
    app.stage.addChild(this.world, this.layers.screen, this.effects.vignette);

    this.input = new InputController(app.canvas, {
      interact: () => this.sendIntent(C2S.INTERACT, {}),
      reload: () => this.sendIntent(C2S.RELOAD, {}),
      selectSlot: (slot) => this.switchSlot(slot === 1 ? "w2" : "w1"),
      toggleSlot: () => {
        const self = this.selfState();
        if (self) this.switchSlot(self.active === "w2" ? "w1" : "w2");
      },
      heal: (kind) => {
        const me = this.me();
        const self = this.selfState();
        const p = this.predictor;
        if (!me || !self || !this.sendIntent(C2S.HEAL, { kind }) || !p?.isInitialized) return;
        // Predict the slow-down now instead of one round trip later (the server applies the
        // intent before the next input). Same checks as the server's startHeal().
        if (canStartHeal(me, self, kind) && !p.healingAhead()) p.predictHealStart(HEAL[kind].MS);
      },
      toggleInventory: () => this.opts.panelActions?.toggleInventory?.(),
      takeAll: this.opts.panelActions?.takeAll ? () => this.opts.panelActions?.takeAll?.() : undefined,
      closePanel: () => this.opts.panelActions?.closePanel?.(),
      toggleMap: this.opts.panelActions?.toggleMap ? () => this.opts.panelActions?.toggleMap?.() : undefined,
      toggleFullMap: () => this.systemCommand("toggleMap"),
      throwGrenade: (aim) => this.throwGrenade(aim),
    });
    this.input.attach();

    if (shouldUseTouch()) {
      this.touch = new TouchControls(this.opts.mountEl, this.input);
      this.touch.onPress = (t) => this.perf?.markInput(t);
      this.touch.attach();
      // Fingers now belong to the sticks: finger events on the canvas no longer aim or fire.
      this.input.setTouchSticks(true);
      // The aim stick only aims; the trigger pulls itself while the aim line is on an enemy.
      this.input.setTouchAutoFire((angle) => this.autoFireLock(angle) !== null);
      setTouchSticksActive(true);
      // Screen layer, above the fog; added before the systems so the full map covers it.
      this.touchCrosshair = new TouchCrosshair();
      this.layers.screen.addChild(this.touchCrosshair.root);
      // A turn of the phone: re-measure the canvas once the browser has the new viewport (some
      // Android builds fire the window resize before the layout settles), then the tick sees the
      // new size and resets the sticks (touch.reset).
      const onTurn = () => requestAnimationFrame(() => requestAnimationFrame(() => !this.stopped && this.app?.resize()));
      window.addEventListener("orientationchange", onTurn);
      screen.orientation?.addEventListener?.("change", onTurn);
      this.disposers.push(() => {
        window.removeEventListener("orientationchange", onTurn);
        screen.orientation?.removeEventListener?.("change", onTurn);
      });
    }
    if (new URLSearchParams(window.location.search).get("perf") === "1") {
      this.perf = new PerfOverlay(this.opts.mountEl);
      this.perf.attach();
    }

    this.attachMessages();
    this.attachState();

    this.sendPing();
    this.pingTimer = setInterval(() => this.sendPing(), PING_INTERVAL_MS);
    this.disposers.push(() => this.stopPing());

    this.lastFrameAt = performance.now();
    app.ticker.add(this.tick);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.teardown();
  }

  /** Idempotent cleanup; also called when stop() races an unfinished start(). */
  private teardown() {
    for (const d of this.disposers.splice(0)) {
      try {
        d();
      } catch {
        /* the room may already be gone */
      }
    }
    this.stopPing();
    if (this.touch) {
      setTouchSticksActive(false);
      clearTouchLook();
    }
    this.touch?.detach();
    this.touch = null;
    this.perf?.detach();
    this.perf = null;
    this.touchCrosshair?.destroy();
    this.touchCrosshair = null;
    this.input?.detach();
    this.input = null;

    for (const s of this.systems.splice(0)) {
      try {
        s.dispose();
      } catch (err) {
        console.error(`[game] system ${s.id} dispose failed`, err);
      }
    }
    for (const m of [this.players, this.items, this.corpses, this.extracts] as Array<Map<string, { view: { destroy(): void } }>>) {
      for (const t of m.values()) t.view.destroy();
      m.clear();
    }
    for (const v of this.playerPool.splice(0)) v.destroy();
    for (const v of this.replayViews.values()) v.destroy();
    this.replayViews.clear();
    this.replay = null;
    this.killcam.clear();
    this.goneAt.clear();
    this.worldView?.destroy();
    this.worldView = null;
    this.containers?.destroy();
    this.containers = null;
    this.minimap?.destroy();
    this.minimap = null;
    this.fog?.destroy();
    this.fog = null;
    this.effects?.destroy();
    this.effects = null;
    this.remoteFx.clear();
    this.party.clear();
    this.partyNow = [];
    this.mateIds.clear();

    // Textures first, while the GL renderer still exists: destroying them after app.destroy() threw
    // "Cannot read properties of null (reading 'gc')" from GlTextureSystem on every raid exit.
    if (this.tex) {
      try {
        destroyTextures(this.tex);
      } catch {
        /* GPU side already gone (lost context): nothing left to free */
      }
      this.tex = null;
    }
    if (this.app) {
      this.app.ticker.remove(this.tick);
      this.app.destroy(true, { children: true });
      this.app = null;
    }
    this.icons?.destroy();
    this.icons = null;
    this.mapData = null;
    this.idx = null;
  }

  // ---------------------------------------------------------------------------------------
  // Outgoing messages. Every room.send goes through send(): once the room has closed the
  // browser would log "WebSocket is already in CLOSING or CLOSED state" for each attempt.

  private watchLeave() {
    const room = this.opts.room;
    const onLeave = () => {
      this.left = true;
      this.stopPing();
    };
    room.onLeave(onLeave);
    this.disposers.push(() => room.onLeave.remove(onLeave));
  }

  /** The socket can still carry messages. */
  private canSend(): boolean {
    if (this.stopped || this.left) return false;
    try {
      if (!this.opts.room.connection?.isOpen) return false;
    } catch {
      return false;
    }
    return true;
  }

  /** The local player can still act: room open, raid running, player alive and on the map. */
  private canAct(): boolean {
    if (!this.canSend()) return false;
    const state = this.state;
    if (!state || state.phase === "ended") return false;
    const me = this.me();
    const self = this.selfState();
    return !!me && !!self && me.alive && self.extractedAt === 0;
  }

  private send(type: string, payload: object): boolean {
    if (!this.canSend()) return false;
    try {
      this.opts.room.send(type, payload);
      return true;
    } catch {
      return false;
    }
  }

  private sendIntent(type: string, payload: object): boolean {
    return this.canAct() && this.send(type, payload);
  }

  /**
   * Weapons v2, C2S.THROW: G / 5 throws toward the cursor (its distance sets the range), a tap on
   * the touch button throws ahead along the facing at GRENADE_TAP_FRAC, a drag passes its own aim.
   * The server checks everything (grenade carried, not rolling / reloading, cooldown); the pin
   * sound plays here at once, like an own shot.
   */
  private throwGrenade(aim?: GrenadeAim) {
    const self = this.selfState();
    if (!self || countOf(self.slots, GRENADE_DEF) <= 0) return;
    // The server's rules, checked here too so a refused throw plays no pin sound.
    const now = performance.now();
    if (this.predictor?.rolling || self.reloadUntil > this.clockNow(now) || now < this.nextThrowAt) return;
    let angle = this.aim;
    let frac = GRENADE_TAP_FRAC;
    if (aim) {
      angle = aim.angle;
      frac = aim.frac;
    } else if (!this.touch && this.input?.hasPointer && this.selfRender) {
      const wx = this.camX + (this.input.mouseX - this.screenW / 2) / this.zoom;
      const wy = this.camY + (this.input.mouseY - this.screenH / 2) / this.zoom;
      const dx = wx - this.selfRender.x;
      const dy = wy - this.selfRender.y;
      if (dx * dx + dy * dy > 1) angle = Math.atan2(dy, dx);
      frac = grenadeFracFor(Math.hypot(dx, dy));
    }
    // q: the server throws right after applying our newest input, where the prediction stands now.
    const q = this.predictor?.lastSeq;
    const msg: ThrowMsg = q !== undefined && q > 0 ? { a: angle, d: frac, q } : { a: angle, d: frac };
    if (!Number.isFinite(angle) || !this.sendIntent(C2S.THROW, msg)) return;
    this.nextThrowAt = now + GRENADE.COOLDOWN_MS;
    getGameAudio()?.localThrow();
  }

  /** SWITCH intent; a real switch cancels a running heal on the server, so predict that too. */
  private switchSlot(slot: "w1" | "w2") {
    const self = this.selfState();
    if (!this.sendIntent(C2S.SWITCH, { slot }) || !self) return;
    if (slot !== self.active && self.slots.get(slot)) this.predictor?.predictHealCancel();
  }

  private sendPing() {
    // Pings only matter for the HUD while playing; after death / extraction / the end of the
    // raid the room is about to close, so stop instead of writing into a dying socket.
    if (!this.canAct()) {
      if (!this.canSend() || this.state?.phase === "ended") this.stopPing();
      return;
    }
    this.send(C2S.PING, { t: performance.now() });
  }

  private stopPing() {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  // ---------------------------------------------------------------------------------------
  // Room wiring

  private attachMessages() {
    const room = this.opts.room;
    const on = <T>(type: string, cb: (msg: T) => void) => {
      const off = room.onMessage<T>(type, (msg) => {
        if (!this.stopped) cb(msg);
      });
      if (typeof off === "function") this.disposers.push(off);
    };

    on<EventsMsg>(S2C.EV, (m) => this.onEvents(m));
    on<JoinedMsg>(S2C.JOINED, (m) => {
      if (typeof m?.selfKey === "string" && m.selfKey) this.joinedSelfKey = m.selfKey;
    });
    on<{ t: number }>(S2C.PONG, (m) => {
      if (typeof m?.t === "number") this.pingMs = Math.max(0, Math.round(performance.now() - m.t));
    });
    on<unknown>(S2C.PARTY, (m) => {
      this.party.ingest(m, performance.now());
    });
    on<SpectateMsg>(S2C.SPECTATE, (m) => this.onSpectateMsg(m));
  }

  // ---------------------------------------------------------------------------------------
  // Spectating a party mate and the death replay (battle-screen drives both).

  /**
   * Watch the party mate with this S2C.PARTY key (the server checks everything), or stop (null).
   * A running replay ends first.
   */
  spectate(key: string | null): void {
    if (key === null) {
      if (this.watch || this.watchPending) this.send(C2S.SPECTATE, { key: null });
      this.watch = null;
      this.watchPending = null;
      return;
    }
    if (this.replay) this.endReplay();
    this.watchEnded = null;
    if (this.send(C2S.SPECTATE, { key })) this.watchPending = key;
  }

  private onSpectateMsg(m: SpectateMsg) {
    if (!m || typeof m !== "object") return;
    if (typeof m.key === "string" && typeof m.id === "string" && m.id && m.id.length <= 64) {
      const name = typeof m.name === "string" ? [...m.name].slice(0, 24).join("") : "Mate";
      this.watch = { key: m.key, id: m.id, name };
      this.watchPending = null;
      this.watchEnded = null;
      this.mateIds.add(m.id);
      return;
    }
    const was = this.watch?.name ?? this.partyNow.find((p) => p.key === this.watchPending)?.name ?? "";
    this.watch = null;
    this.watchPending = null;
    const reason = m.reason;
    if (reason === "refused" || reason === "mate_down" || reason === "mate_out" || reason === "wipe") this.watchEnded = { reason, name: was };
  }

  /** Play the death replay (killcam.ts) from the start; false when there is nothing to replay. */
  startReplay(): boolean {
    if (!this.diedHere || this.watch || !this.tex || !this.icons) return false;
    const win = this.killcam.window();
    if (!win) return false;
    this.endReplay();
    this.replay = new KillcamPlayer(this.killcam, performance.now(), win);
    this.replayProgress = 0;
    return true;
  }

  /** Skip / end the replay (the live view comes back). */
  stopReplay(): void {
    this.endReplay();
  }

  private endReplay() {
    if (!this.replay) return;
    this.replay = null;
    this.replayPlayed = true;
    for (const v of this.replayViews.values()) v.destroy();
    this.replayViews.clear();
    this.replayLayer.visible = false;
    this.playerLayer.visible = true;
  }

  /** Subscribe to collections; tolerates a room whose state has not arrived yet. */
  private attachState() {
    const room = this.opts.room;
    const state = this.state;
    const $ = (() => {
      try {
        return getStateCallbacks(room);
      } catch {
        return undefined;
      }
    })();
    if (!state || !$) {
      const retry = () => {
        if (!this.stopped) this.attachState();
      };
      room.onStateChange.once(retry);
      this.disposers.push(() => room.onStateChange.remove(retry));
      return;
    }

    // `$` is typed for the generic room; the decoded instances follow BattleState.
    const s$ = $(state) as unknown as {
      players: CollectionProxy<Player>;
      items: CollectionProxy<GroundItem>;
      corpses: CollectionProxy<Corpse>;
      extracts: CollectionProxy<Extract>;
    };

    this.disposers.push(
      s$.players.onAdd((p, id) => this.addPlayer(id, p)),
      s$.players.onRemove((_p, id) => this.removePlayer(id)),
      s$.items.onAdd((it, id) => this.addItem(id, it)),
      s$.items.onRemove((_it, id) => this.markRemoving(this.items, id)),
      s$.corpses.onAdd((c, id) => this.addCorpse(id, c)),
      s$.corpses.onRemove((_c, id) => this.markRemoving(this.corpses, id)),
      s$.extracts.onAdd((e, id) => this.addExtract(id, e)),
      s$.extracts.onRemove((_e, id) => {
        this.extracts.get(id)?.view.destroy();
        this.extracts.delete(id);
      }),
    );

    const onPatch = () => this.onStatePatch();
    room.onStateChange(onPatch);
    this.disposers.push(() => room.onStateChange.remove(onPatch));
    // The first full state may already be decoded: take it as the first snapshot.
    this.onStatePatch();
  }

  /**
   * A player entered this client's view (or re-entered: the decoded instance is new, and the
   * interpolation buffer must not lerp from where we last saw them). Views are pooled.
   */
  private addPlayer(id: string, p: Player) {
    if (!this.tex || !this.icons) return;
    const isSelf = id === this.selfId;
    let entry = this.players.get(id);
    if (entry) {
      entry.state = p;
      entry.removing = false;
      if (!isSelf) entry.view.buffer.clear();
    } else {
      const pooled = isSelf ? undefined : this.playerPool.pop();
      const view = pooled ?? new PlayerView(this.tex, this.icons, id, isSelf, p.nickname);
      view.reset(id, p.nickname);
      if (!view.root.parent) this.playerLayer.addChild(view.root);
      entry = { state: p, view, removing: false };
      this.players.set(id, entry);
    }
    const v = entry.view;
    v.buffer.push({ t: performance.now(), x: p.x, y: p.y, aim: p.aim });
    v.place(p.x, p.y, p.aim);
    if (isSelf) {
      v.alpha = 1;
      v.root.alpha = 1;
      this.aim = p.aim;
    }
  }

  private removePlayer(id: string) {
    const e = this.players.get(id);
    if (!e) return;
    e.removing = true;
    if (id !== this.selfId) this.goneAt.set(id, { x: e.view.x, y: e.view.y, at: performance.now() });
  }

  private addItem(id: string, it: GroundItem) {
    if (!this.tex || !this.icons) return;
    const e = this.items.get(id);
    if (e) {
      e.state = it;
      e.removing = false;
      return;
    }
    const view = new ItemView(this.tex, this.icons);
    view.sync(it);
    view.update(it.x, it.y, performance.now());
    view.root.alpha = 0;
    this.itemLayer.addChild(view.root);
    this.items.set(id, { state: it, view, removing: false });
  }

  private addCorpse(id: string, c: Corpse) {
    if (!this.icons) return;
    const e = this.corpses.get(id);
    if (e) {
      e.state = c;
      e.removing = false;
      return;
    }
    const view = new CorpseView(this.icons);
    const look = this.corpseLook(id, c.label);
    view.sync(c, look.npc, look.name);
    view.root.alpha = 0;
    // A body we watch fall (char-anim death) hands over to its corpse only when the fall is over.
    const now = performance.now();
    for (const pe of this.players.values()) {
      const pv = pe.view;
      if (pv.dyingAt(now) && Math.abs(pv.x - c.x) < 64 && Math.abs(pv.y - c.y) < 64) {
        view.holdUntil = Math.max(view.holdUntil, pv.deathAt + CORPSE_HANDOVER_MS);
      }
    }
    this.corpseLayer.addChild(view.root);
    this.corpses.set(id, { state: c, view, removing: false });
    this.corpseAddedAt.set(id, now);
  }

  /** NPC look of a corpse (role + display name), cached per id until its label changes. */
  private corpseLook(id: string, label: string): { npc: NpcRoleName | null; name: string } {
    let l = this.corpseNpc.get(id);
    if (!l || l.label !== label) {
      const npc = corpseNpcRole(label, this.npcNames);
      l = { label, npc, name: npc ? npcDisplayName(npc, bossKindOfLabel(label), label) : label };
      this.corpseNpc.set(id, l);
    }
    return l;
  }

  private markRemoving<T, V>(m: Map<string, Fading<T, V>>, id: string) {
    const e = m.get(id);
    if (e) e.removing = true;
  }

  private addExtract(id: string, e: Extract) {
    this.extracts.get(id)?.view.destroy();
    const view = new ExtractView();
    this.extractLayer.addChild(view.root);
    this.extracts.set(id, { state: e, view });
  }

  /** Runs after every decoded patch (SERVER_TICK_HZ): timestamps for interpolation + reconciliation. */
  private onStatePatch() {
    const state = this.state;
    if (!state || this.stopped) return;
    this.known.observe(state.loot, state.containerState);
    const now = performance.now();
    if (state.clockMs !== this.clockBase) {
      this.clockBase = state.clockMs;
      this.clockBaseAt = now;
    }

    state.players.forEach((p, id) => {
      const t = this.players.get(id);
      if (!t || id === this.selfId) return;
      t.view.buffer.push({ t: now, x: p.x, y: p.y, aim: p.aim });
    });

    const p = this.predictor;
    const sm = readServerMove(state, this.selfKey(), this.selfId);
    if (!sm || !p) return;
    if (!this.canAct()) {
      // Not controllable (dead, extracted, raid over): follow the server directly.
      p.setTiming(sm);
      p.reset(sm.x, sm.y, sm.roll);
      this.ownShot.reset();
      this.prevPredX = sm.x;
      this.prevPredY = sm.y;
      this.corrX = 0;
      this.corrY = 0;
      return;
    }
    if (!p.isInitialized) {
      p.reconcile(sm);
      this.prevPredX = sm.x;
      this.prevPredY = sm.y;
      return;
    }
    const { dx, dy, resynced } = p.reconcile(sm);
    if (resynced) {
      // Reconnect: the server restarted the input sequence. Jump to it and keep going.
      this.prevPredX = p.x;
      this.prevPredY = p.y;
      this.corrX = 0;
      this.corrY = 0;
      return;
    }
    if (dx === 0 && dy === 0) return;
    // Shift the current interpolation segment with the correction…
    this.prevPredX += dx;
    this.prevPredY += dy;
    const err = Math.hypot(this.corrX - dx, this.corrY - dy);
    if (err > SNAP_DIST) {
      this.corrX = 0;
      this.corrY = 0;
    } else {
      // …and keep the drawn position where it was, gliding to the corrected one.
      this.corrX -= dx;
      this.corrY -= dy;
    }
  }

  // ---------------------------------------------------------------------------------------
  // Per-tick events (one S2C.EV batch per server tick)

  private onEvents(ev: EventsMsg) {
    if (!ev || typeof ev !== "object") return;
    if (Array.isArray(ev.shots)) for (const m of ev.shots) this.onShot(m);
    if (Array.isArray(ev.hits)) for (const m of ev.hits) this.onHit(m);
    if (Array.isArray(ev.kills)) for (const m of ev.kills) this.onKill(m);
    if (Array.isArray(ev.xp)) for (const m of ev.xp) this.onXp(m);
    if (Array.isArray(ev.chest)) {
      const now = performance.now();
      for (const c of ev.chest) {
        const spot = this.containers?.at(c.idx);
        if (!spot || !this.effects) continue;
        const color = containerSprite(spot).color;
        this.effects.ring(spot.x, spot.y, color, 80, 450, now);
        this.effects.burst(spot.x, spot.y, color, 16, 320, now);
        this.killcam.addFx(now, FX.RING, "", spot.x, spot.y, color, 80, 450, 5);
        this.killcam.addFx(now, FX.SPARK, "", spot.x, spot.y, color, 16, 320, 5);
      }
    }
    const ctx = this.ctx;
    if (!ctx || !this.systemsReady) return;
    for (const s of this.systems) if (s.onEvents) this.runSystem(s, () => s.onEvents!(ev, ctx));
  }

  /** In-raid XP (personal): a "+N XP" pop above the player and a line for the HUD ticker. */
  private onXp(m: XpMsg) {
    if (!m || typeof m.xp !== "number" || typeof m.k !== "string") return;
    const now = performance.now();
    this.xpGains.push({ id: ++this.xpSeq, k: m.k, xp: Math.max(0, m.xp), n: m.n | 0, receivedAt: now });
    if (this.xpGains.length > 8) this.xpGains.shift();
    const at = this.selfRender;
    if (!at || !this.effects) return;
    if (m.xp > 0) this.effects.popText(at.x, at.y - 30, `+${m.xp} XP`, XP_POP_COLOR, now, m.xp >= XP.BOSS ? 26 : 18);
    else if (m.k === "containers") this.effects.popText(at.x, at.y - 30, "XP cap", XP_CAP_COLOR, now, 15);
  }

  /**
   * Our own shot, from the gun we see (the predicted position), not where the server had us one
   * round trip ago: on the input that fires it (predicted) or on an unpredicted server echo.
   */
  private drawOwnShot(w: WeaponId, angles: number[], now: number) {
    if (!this.effects || !this.selfRender || !angles.length) return;
    const muzzle = WEAPONS[w].muzzle;
    const a = angles.reduce((s, v) => s + v, 0) / angles.length;
    const { x: cx, y: cy } = this.selfRender;
    const x = cx + Math.cos(a) * muzzle;
    const y = cy + Math.sin(a) * muzzle;
    this.effects.shot(this.idx, this.selfId, w, cx, cy, x, y, angles, true, now);
    this.players.get(this.selfId)?.view.kick(SPRITE_RECOIL_PX[w], now);
    this.killcam.addFx(now, FX.SHOT, this.selfId, cx, cy, x, y, 0, 4, { w, arr: angles, self: true });
    this.killcam.addFx(now, FX.KICK, this.selfId, SPRITE_RECOIL_PX[w], 0, 0, 0, 0, 1);
  }

  /** Server rules (combat.ts tryFire) on the input just sent: a shot that will leave is shown now. */
  private predictOwnShot(self: SelfState, fire: boolean, rolling: boolean) {
    const me = this.me();
    const w = me?.weapon && me.weapon in WEAPONS ? (me.weapon as WeaponId) : null;
    const now = performance.now();
    const shot = this.ownShot.tryFire({
      now,
      fire,
      prevFire: this.prevFire,
      def: w ? WEAPONS[w] : null,
      mag: self.slots.get(self.active)?.mag ?? 0,
      reloading: self.reloadUntil > this.clockNow(now),
      rolling,
    });
    if (!shot || !w) return;
    this.drawOwnShot(w, predictedAngles(this.aim, WEAPONS[w]), now);
    getGameAudio()?.localShot(w);
  }

  private onShot(m: ShotMsg) {
    if (!this.effects || !m || !Array.isArray(m.a) || !(m.w in WEAPONS)) return;
    const now = performance.now();
    const w = m.w as WeaponId;
    const muzzle = WEAPONS[w].muzzle;
    const isSelf = m.s === this.selfId;
    if (isSelf && this.selfRender && m.a.length) {
      // Already drawn on the input that fired it (predictOwnShot); otherwise draw it now.
      if (!this.ownShot.consumeEcho(now)) this.drawOwnShot(w, m.a, now);
      return;
    }
    // Walls are raycast from the shooter's centre, like the server's bullets. A clipped shot of a
    // hidden shooter (s = "") starts at the view-circle entry: cx/cy equal x/y there.
    const c = shotCentre(m, muzzle);
    const play = (t: number) => {
      this.effects?.shot(this.idx, m.s, w, c.x, c.y, m.x, m.y, m.a, isSelf, t);
      this.killcam.addFx(t, FX.SHOT, m.s, c.x, c.y, m.x, m.y, 0, 4, { w, arr: m.a, self: isSelf });
      // The shooter's gun kicks back (only a shooter we render; hidden ones have s = "").
      if (m.s) {
        this.players.get(m.s)?.view.kick(SPRITE_RECOIL_PX[w], t);
        this.killcam.addFx(t, FX.KICK, m.s, SPRITE_RECOIL_PX[w], 0, 0, 0, 0, 1);
      }
    };
    // Other players are drawn INTERP_DELAY_MS in the past: show their shots on the same timeline.
    if (isSelf) play(now);
    else this.remoteFx.push(now + INTERP_DELAY_MS, play);
  }

  /**
   * Each part of a hit is shown on the timeline of the body it belongs to: the tracer cut on the
   * shooter's (our shots are drawn at once, remote ones INTERP_DELAY_MS late), the burst and the
   * damage number on the target's. The damage-direction arc (HitMsg.fa) is a system.
   */
  private onHit(m: HitMsg) {
    if (!this.effects || !m) return;
    const now = performance.now();
    const at = (remote: boolean, fn: (t: number) => void) => {
      if (remote) this.remoteFx.push(now + INTERP_DELAY_MS, fn);
      else fn(now);
    };
    at(m.s !== this.selfId, (t) => {
      this.effects?.stopTracer(m.s, m.x, m.y);
      this.killcam.addFx(t, FX.STOP, m.s, m.x, m.y, 0, 0, 0, 2);
    });
    // A target we do not see (in a bush, behind a fence, or the position-less "hit confirmed" of a
    // grenade, t = ""): no burst and no damage number on the map, only the hitmarker, the sound and
    // a neutral puff where our own tracer stopped (a point this client already drew).
    if (m.t !== this.selfId && (!m.t || !this.state?.players.has(m.t))) {
      if (m.s === this.selfId && Number.isFinite(m.x) && Number.isFinite(m.y)) {
        this.effects.confirmPuff(m.x, m.y, now);
        this.killcam.addFx(now, FX.PUFF, "", m.x, m.y, 0, 0, 0, 2);
      }
      return;
    }
    at(m.t !== this.selfId, (t) => {
      const fx = this.effects;
      if (!fx) return;
      // Blood / sparks fly along the bullet: from the shooter we draw (s is "" when it is hidden).
      const from = m.s === this.selfId ? this.selfRender : m.s ? this.players.get(m.s)?.view : null;
      let dx = 0;
      let dy = 0;
      if (from) {
        dx = m.x - from.x;
        dy = m.y - from.y;
        const l = Math.hypot(dx, dy);
        if (l > 1) {
          dx /= l;
          dy /= l;
        } else dx = dy = 0;
      }
      fx.hitBurst(m.x, m.y, !!m.ar, t, dx, dy);
      const kc = this.killcam;
      kc.addFx(t, FX.BURST, m.t, m.x, m.y, dx, dy, 0, 4, { flag: !!m.ar });
      const tv = this.players.get(m.t)?.view;
      if (m.d > 0 || m.ar) {
        tv?.flashHit(t, dx, dy);
        kc.addFx(t, FX.FLASH, m.t, dx, dy, 0, 0, 0, 2);
      }
      if (m.t === this.selfId) {
        if (m.d > 0) {
          fx.damageNumber(m.t, m.x, m.y, m.d, false, true, t);
          kc.addFx(t, FX.DMG, m.t, m.x, m.y, m.d, 0, 0, 3, { self: true });
        }
        fx.hurtFlash(m.d);
      } else if (m.s === this.selfId) {
        tv?.revealBars(t);
        if (m.d > 0) {
          fx.damageNumber(m.t, m.x, m.y, m.d, !!m.ar, false, t);
          kc.addFx(t, FX.DMG, m.t, m.x, m.y, m.d, 0, 0, 3, { flag: !!m.ar });
        }
      }
    });
  }

  private onKill(m: KillMsg) {
    if (!m) return;
    const now = performance.now();
    this.killFeed.push({
      id: ++this.killSeq,
      killer: m.killer,
      victim: m.victim,
      weapon: m.weapon,
      killerRole: m.killerRole ?? 0,
      victimRole: m.victimRole ?? 0,
      atMs: this.clockNow(now),
      receivedAt: now,
    });
    this.killTally = tallyKill(this.killTally, m, this.selfId);
    const vr = npcRoleName(m.victimRole);
    if (vr && m.victim) this.npcNames.set(m.victim, vr);
    if (this.killFeed.length > KILL_FEED_MAX) this.killFeed.splice(0, this.killFeed.length - KILL_FEED_MAX);
    // Only bodies this client can see get the burst (KILL is broadcast with names only).
    const v = this.players.get(m.victimId)?.view;
    if (v && v.alpha > 0.05 && this.effects) {
      this.effects.burst(v.x, v.y, 0xff3b3b, 22, 380, now);
      this.effects.ring(v.x, v.y, 0xffffff, 70, 400, now);
      this.killcam.addFx(now, FX.SPARK, "", v.x, v.y, 0xff3b3b, 22, 380, 5);
      this.killcam.addFx(now, FX.RING, "", v.x, v.y, 0xffffff, 70, 400, 5);
    }
  }

  private clockNow(now: number): number {
    const state = this.state;
    if (!state) return 0;
    if (state.phase === "ended" || this.clockBaseAt === 0) return state.clockMs;
    const lead = Math.min(CLOCK_LEAD_MAX_MS, now - this.clockBaseAt);
    const dur = state.durationMs || MATCH.DURATION_MS;
    return Math.min(dur, Math.round(this.clockBase + Math.max(0, lead)));
  }

  // ---------------------------------------------------------------------------------------
  // Systems

  private runSystem(s: GameSystem, fn: () => void) {
    try {
      fn();
    } catch (err) {
      const n = (this.systemErrors.get(s) ?? 0) + 1;
      this.systemErrors.set(s, n);
      console.error(`[game] system ${s.id} failed (${n})`, err);
      if (n >= SYSTEM_MAX_ERRORS) {
        this.systems = this.systems.filter((x) => x !== s);
        try {
          s.dispose();
        } catch {
          /* already broken */
        }
      }
    }
  }

  private makeContext(app: Application): GameContext {
    const cam: CameraView = { x: 0, y: 0, zoom: 1, width: 0, height: 0 };
    return {
      app,
      room: this.opts.room as GameContext["room"],
      layers: this.layers,
      map: () => this.mapData,
      state: () => this.state,
      selfKey: () => this.selfKey(),
      self: () => this.selfState(),
      me: () => this.me(),
      // While replaying / spectating: the replayed self / the watched mate (listener, sound ring…).
      selfPos: () => this.focus ?? this.selfRender ?? { x: this.camX, y: this.camY },
      aim: () => (this.focus ? this.focusAim : this.aim),
      view: () => (this.replay ? "replay" : this.watch ? "spectate" : "live"),
      watchedId: () => this.watch?.id ?? null,
      camera: () => {
        cam.x = this.camX;
        cam.y = this.camY;
        cam.zoom = this.zoom;
        cam.width = this.screenW;
        cam.height = this.screenH;
        return cam;
      },
      clockMs: () => this.clockNow(performance.now()),
      toScreen: (x, y) => ({
        x: this.screenW / 2 + (x - this.camX) * this.zoom,
        y: this.screenH / 2 + (y - this.camY) * this.zoom,
      }),
      inputBlocked: () => this.inputBlockedNow,
      lastSeen: (id) => {
        const e = this.players.get(id);
        if (e && !e.removing) return { x: e.view.x, y: e.view.y, at: performance.now() };
        return this.goneAt.get(id) ?? null;
      },
      partyMates: () => this.partyNow,
      grenadeAim: () => this.input?.grenadeAim ?? null,
    };
  }

  private initSystems(app: Application) {
    this.ctx = this.makeContext(app);
    const ctx = this.ctx;
    for (const factory of SYSTEM_FACTORIES) {
      let s: GameSystem;
      try {
        s = factory();
      } catch (err) {
        console.error("[game] system factory failed", err);
        continue;
      }
      this.systems.push(s);
      if (!s.init) continue;
      this.runSystem(s, () => {
        const r = s.init!(ctx);
        if (r && typeof (r as Promise<void>).catch === "function") {
          (r as Promise<void>).catch((err) => console.error(`[game] system ${s.id} init failed`, err));
        }
      });
    }
    this.systemsReady = true;
  }

  // ---------------------------------------------------------------------------------------
  // Frame

  private tick = () => {
    const app = this.app;
    const state = this.state;
    if (!app || this.stopped || !state) return;
    const now = performance.now();
    const dt = Math.min(100, now - this.lastFrameAt);
    this.lastFrameAt = now;
    const w = app.screen.width;
    const h = app.screen.height;
    const resized = w !== this.screenW || h !== this.screenH;
    // Touch: a turn between portrait and landscape frees the sticks and re-lays the controls, so a
    // finger held through the rotation cannot leave the aim stuck on the old geometry.
    const portrait = !!this.touch && h > w;
    if (resized && this.touch && (portrait !== this.portrait || this.screenW === 0)) this.touch.reset();
    this.portrait = portrait;
    this.screenW = w;
    this.screenH = h;
    const baseZoom = Math.sqrt((w * h) / (VIEW_W * VIEW_H)) || 1;
    this.zoom = baseZoom;
    // Immersion camera (camera.ts): intro / cinematic zoom, look-ahead + focus offset, kick + shake.
    const rig = getCameraRig();
    if (rig) this.zoom *= rig.zoomMul;

    if (!this.mapData && state.mapId && (state.mapId !== LEGACY_MAP_ID || state.mapSeed)) this.buildMap(state);
    const map = this.mapData;

    const clock = this.clockNow(now);
    const me = this.me();
    const self = this.selfState();
    const controllable = !!this.idx && this.canAct();
    const pred = this.predictor;

    // Death replay (killcam.ts): the recorded frames to draw now; it ends by itself.
    let rp: ReplaySample | null = this.replay ? this.replay.at(now) : null;
    if (rp) this.replayProgress = rp.progress;
    if (rp?.done) {
      this.endReplay();
      rp = null;
    }

    // Overlays (inventory / search panel, full map) own the mouse: no fire, aim frozen.
    const blocked = inputBlockedBy(this.opts.isInputBlocked, this.systemsReady ? this.systems : NO_SYSTEMS);
    this.inputBlockedNow = blocked;
    this.input?.setFireBlocked(blocked || this.portrait);
    // Desktop: crosshair cursor over the canvas, the normal one while the full map owns the mouse.
    if (!this.touch && this.cursorCrosshair !== !blocked) this.cursorCrosshair = setCanvasCrosshair(app.canvas, !blocked);
    // A held fire stick re-presses at the fire interval of a semi-auto weapon.
    const weaponDef = me?.weapon && me.weapon in WEAPONS ? WEAPONS[me.weapon as WeaponId] : null;
    if (this.touch) this.input?.setTouchRepeatMs(weaponDef && !weaponDef.auto ? weaponDef.fireIntervalMs : 0);

    // Fixed-rate input loop, only while the player can act. Bursts are capped so a hidden tab
    // does not dump a backlog.
    if (controllable && pred) {
      this.inputAcc = Math.min(this.inputAcc + dt, INPUT_DT_MS * 3);
      // A fresh click does not wait for its sample (up to INPUT_DT_MS): the next sample goes out now
      // and the one after it waits the borrowed time, so the cadence and movement stay exact.
      if (this.inputLead === 0 && this.inputAcc > 0 && this.inputAcc < INPUT_DT_MS && this.input?.hasFreshPress) {
        this.inputLead = INPUT_DT_MS - this.inputAcc;
        this.inputAcc -= INPUT_DT_MS;
        if (!this.sendInput(true)) {
          this.inputAcc += INPUT_DT_MS;
          this.inputLead = 0;
        }
      }
      while (this.inputAcc >= INPUT_DT_MS) {
        this.inputAcc -= INPUT_DT_MS;
        this.inputLead = 0;
        if (!this.sendInput()) break;
      }
    } else {
      this.inputAcc = 0;
      this.inputLead = 0;
      // Drop clicks / roll presses made while out of control so they do not fire later.
      this.input?.dropBuffered();
    }

    // Local player: predicted position, smoothed between input steps, plus decaying correction.
    if (me && controllable && pred) {
      // After a click sent early, two steps are drawn over the two step times from the last regular sample.
      const k = this.inputLead > 0 ? Math.min(1, Math.max(0, (this.inputAcc + INPUT_DT_MS) / (2 * INPUT_DT_MS))) : this.inputAcc / INPUT_DT_MS;
      const decay = decayFactor(dt, CORRECTION_TAU_MS);
      this.corrX *= decay;
      this.corrY *= decay;
      if (Math.abs(this.corrX) < 0.05) this.corrX = 0;
      if (Math.abs(this.corrY) < 0.05) this.corrY = 0;
      const x = this.prevPredX + (pred.x - this.prevPredX) * k + this.corrX;
      const y = this.prevPredY + (pred.y - this.prevPredY) * k + this.corrY;
      this.selfRender = { x, y };
      if (!blocked) this.updateAim(w, h);
    } else if (me && me.alive && (!self || self.extractedAt === 0) && !this.left) {
      // Map not built yet or the match is over: show the server position as is.
      this.selfRender = { x: me.x, y: me.y };
    }
    // After death / extraction selfRender keeps the last position: the camera stays there.

    // Spectating: the watched mate's interpolated sprite (the same sample the players loop draws).
    const renderT = now - INTERP_DELAY_MS;
    const watchedE = !rp && this.watch ? this.players.get(this.watch.id) : undefined;
    const watchedS = watchedE ? (watchedE.view.buffer.sample(renderT) ?? { x: watchedE.state.x, y: watchedE.state.y, aim: watchedE.state.aim }) : null;
    this.focus = null;
    if (rp) {
      // The camera as it was (its zoom multiplier on today's screen size), no live rig on top.
      const { a, b, k } = rp;
      this.camX = a.camX + (b.camX - a.camX) * k;
      this.camY = a.camY + (b.camY - a.camY) * k;
      this.zoom = baseZoom * (a.zoom + (b.zoom - a.zoom) * k);
      const me0 = entOf(a, this.selfId);
      if (me0) {
        const me1 = entOf(b, this.selfId) ?? me0;
        this.focusPt.x = me0.x + (me1.x - me0.x) * k;
        this.focusPt.y = me0.y + (me1.y - me0.y) * k;
        this.focusAim = lerpAngle(me0.aim, me1.aim, k);
        this.focus = this.focusPt;
      }
    } else if (watchedS) {
      this.zoom = baseZoom;
      this.camX = this.focusPt.x = watchedS.x;
      this.camY = this.focusPt.y = watchedS.y;
      this.focusAim = watchedS.aim;
      this.focus = this.focusPt;
    } else if (this.selfRender) {
      this.camX = this.selfRender.x + (rig?.offX ?? 0);
      this.camY = this.selfRender.y + (rig?.offY ?? 0);
    }
    const liveRig = rp || watchedS ? null : rig;
    if (map) {
      // Never show the void past the map edge.
      const hw = w / 2 / this.zoom, hh = h / 2 / this.zoom;
      this.camX = map.width > 2 * hw ? Math.max(hw, Math.min(map.width - hw, this.camX)) : map.width / 2;
      this.camY = map.height > 2 * hh ? Math.max(hh, Math.min(map.height - hh, this.camY)) : map.height / 2;
      if (!this.warmedUp && this.selfRender && this.worldView?.warmup) {
        this.warmedUp = true;
        try {
          this.worldView.warmup(this.selfRender.x, this.selfRender.y);
        } catch (err) {
          console.error("[game] world warmup failed", err);
        }
      }
    }

    if (this.touchCrosshair) this.updateTouchCrosshair(dt, w, h, controllable && !blocked, weaponDef?.range ?? 0);

    this.remoteFx.flush(now);
    const shake = this.effects?.update(now, dt, w, h) ?? { x: 0, y: 0 };
    this.world.scale.set(this.zoom);
    const sx = shake.x * (rig?.shakeScale ?? 1) + (liveRig?.shakeX ?? 0);
    const sy = shake.y * (rig?.shakeScale ?? 1) + (liveRig?.shakeY ?? 0);
    this.world.position.set(w / 2 - this.camX * this.zoom + sx, h / 2 - this.camY * this.zoom + sy);

    const halfW = w / 2 / this.zoom + CULL_MARGIN;
    const halfH = h / 2 / this.zoom + CULL_MARGIN;
    const view: ViewRect = { x0: this.camX - halfW, y0: this.camY - halfH, x1: this.camX + halfW, y1: this.camY + halfH };
    const inView = (x: number, y: number) => x >= view.x0 && x <= view.x1 && y >= view.y0 && y <= view.y1;

    const selfOnMap = controllable ? this.selfRender : this.focus;
    this.worldView?.update(view, selfOnMap, dt);
    this.containers?.update(view.x0, view.y0, view.x1, view.y1, state.containerState as unknown as ArrayLike<number>, now, this.known);

    // Environment → darkness, tint, vision range.
    this.updateEnv(state, clock);
    this.world.tint = this.look.tint;
    const fogOn = !!this.fog && !!this.selfRender;
    if (rp) {
      // The fog as it was drawn: the replay can never reveal more than the live frame did.
      const { a, b, k } = rp;
      this.eye = a.hasEye && this.fog
        ? { x: a.eyeX + (b.eyeX - a.eyeX) * k, y: a.eyeY + (b.eyeY - a.eyeY) * k, aim: lerpAngle(a.eyeAim, b.eyeAim, k), range: a.eyeRange }
        : null;
    } else if (watchedS && this.fog) {
      this.eye = { x: watchedS.x, y: watchedS.y, aim: watchedS.aim, range: fogRange(this.env) };
    } else {
      this.eye = fogOn ? { x: this.selfRender!.x, y: this.selfRender!.y, aim: this.aim, range: fogRange(this.env) } : null;
    }
    const eye = this.eye;
    const vis = (x: number, y: number, pad: number) => (eye ? entityVisibility(this.idx, eye, x, y, pad) : 1);

    const selfBush = selfOnMap && this.bushes ? bushIndexAt(this.bushes, selfOnMap.x, selfOnMap.y) : -1;

    // Players. The replay draws its own sprites instead (replayLayer).
    this.playerLayer.visible = !rp;
    this.replayLayer.visible = !!rp;
    // Ground decals (blood, casings, dust) are live, not recorded: they would show the death early.
    this.layers.ground.visible = !rp;
    if (rp) this.drawReplay(rp, now);
    // Killcam: what this frame draws is recorded (only our own live view, never while replaying / watching).
    const rec = rp || this.watch ? null : this.recordFrame(now, me, self, rig?.zoomMul ?? 1);
    for (const [id, e] of this.players) {
      if (rp) break;
      const p = e.state;
      const v = e.view;
      if (id === this.selfId) {
        const pos = this.selfRender ?? { x: p.x, y: p.y };
        const aimNow = controllable ? this.aim : p.aim;
        // Death: our body tips over before the corpse takes over (char-anim, presentation only).
        if (v.setAlive(p.alive, now, aimNow)) this.holdCorpseNear(v);
        const onMap = (p.alive || v.dyingAt(now)) && (!self || self.extractedAt === 0) && !e.removing;
        const act = this.selfAct(self, clock);
        v.setAct(act, now);
        v.place(pos.x, pos.y, aimNow, now);
        v.root.visible = onMap;
        if (!onMap) continue;
        v.root.alpha = 1;
        v.setColor(p.color);
        v.setSkin(p.skin ?? 0);
        v.setNickname(p.nickname);
        v.setWeapon(p.weapon, now);
        v.setBackpack(p.bp);
        if (rec) this.recEnt(rec, id, p, pos.x, pos.y, aimNow, 1, act, false);
        continue;
      }
      const s = v.buffer.sample(renderT) ?? { x: p.x, y: p.y, aim: p.aim };
      if (v.setAlive(p.alive, now, s.aim)) this.holdCorpseNear(v);
      v.setAct(p.act, now);
      v.place(s.x, s.y, s.aim, now);
      // A body still falling (char-anim death) stays up; the corpse fades in as it finishes.
      const target = (e.removing || !p.alive) && !v.dyingAt(now) ? 0 : vis(v.x, v.y, PLAYER_PAD);
      v.alpha = fadeToward(v.alpha, target, dt);
      if (e.removing && v.alpha <= 0) {
        this.retirePlayer(id, e);
        continue;
      }
      v.root.alpha = v.alpha;
      v.root.visible = v.alpha > 0.01 && inView(v.x, v.y);
      if (!v.root.visible) continue;
      // NPCs (bosses / guards v4, marauders v5): sprite, ring, tag and HP bar against Player.maxHp.
      v.setRole(p.role ?? 0, p.nickname, this.mapData?.bosses, p.x, p.y);
      if (p.role && !this.npcNames.has(p.nickname)) {
        const r = npcRoleName(p.role);
        if (r) this.npcNames.set(p.nickname, r);
      }
      v.setColor(p.color);
      v.setSkin(p.skin ?? 0);
      v.setNickname(p.nickname);
      v.setWeapon(p.weapon, now);
      v.setBackpack(p.bp);
      const armorMax = p.armor >= 1 && p.armor <= 3 ? ARMOR[p.armor as 1 | 2 | 3].durability : 0;
      v.setBars(p.hp, p.armor, p.armorDur, armorMax, p.maxHp || undefined, now);
      // Enemy HP bars show after the local player hits them (combat-fx HP_REVEAL); bosses and
      // party mates always show theirs.
      const barsAlways = p.role === NPC_ROLE.BOSS || this.mateIds.has(id);
      v.updateBarsAlpha(now, barsAlways);
      const bush = this.bushes ? bushIndexAt(this.bushes, v.x, v.y) : -1;
      v.setLabelVisible(bush < 0 || bush === selfBush);
      if (rec) this.recEnt(rec, id, p, v.x, v.y, s.aim, v.alpha, p.act, barsAlways);
    }
    if (rec && me && !me.alive) {
      // The death frame: the record stops here (the effects ring takes FX_TAIL_MS more).
      this.killcam.freeze(now);
      this.diedHere = true;
    }

    // Ground items and corpses: AOI-filtered by the server, faded by the fog here. WORLD v6 (A6):
    // they blink in their last minute before expiry and fade out slower when they expire.
    for (const [id, e] of this.items) {
      const it = e.state;
      const v = e.view;
      const target = e.removing ? 0 : inView(it.x, it.y) ? vis(it.x, it.y, 0) : 0;
      v.alpha = fadeToward(v.alpha, target, dt, e.removing && expiryFading(it.expiresAt, clock) ? EXPIRE_FADE_TAU_MS : undefined);
      if (e.removing && v.alpha <= 0) {
        v.destroy();
        this.items.delete(id);
        continue;
      }
      v.root.alpha = v.alpha * (e.removing ? 1 : expiryBlink(it.expiresAt, clock));
      v.root.visible = v.alpha > 0.01;
      if (!v.root.visible) continue;
      v.sync(it);
      v.update(it.x, it.y, now);
    }
    for (const [id, e] of this.corpses) {
      const c = e.state;
      const v = e.view;
      // The replay hides the bodies that were not there yet (our own included).
      const later = !!rp && (this.corpseAddedAt.get(id) ?? 0) > rp.t;
      if (later) v.alpha = 0;
      const target = later || e.removing || now < v.holdUntil ? 0 : inView(c.x, c.y) ? vis(c.x, c.y, PLAYER_PAD) : 0;
      v.alpha = fadeToward(v.alpha, target, dt, e.removing && expiryFading(c.expiresAt, clock) ? EXPIRE_FADE_TAU_MS : undefined);
      if (e.removing && v.alpha <= 0) {
        v.destroy();
        this.corpses.delete(id);
        this.corpseNpc.delete(id);
        this.corpseAddedAt.delete(id);
        continue;
      }
      v.root.alpha = v.alpha * (e.removing ? 1 : expiryBlink(c.expiresAt, clock));
      v.root.visible = v.alpha > 0.01;
      if (v.root.visible) {
        const look = this.corpseLook(id, c.label);
        v.sync(c, look.npc, look.name, this.known.corpse(id));
      }
    }

    const mask = self?.extractMask ?? 0;
    const extractInfo: MinimapExtract[] = [];
    for (const [id, { state: e, view: v }] of this.extracts) {
      const allowed = extractAllowed(map, mask, id);
      // WORLD v6 (D8): this player's own arm on top of the map-level open / close times.
      const status = allowed ? personalExtractStatus(e, self, clock) : "closed";
      extractInfo.push({ x: e.x, y: e.y, r: e.r, status, allowed });
      v.root.visible = Math.abs(e.x - this.camX) < halfW + e.r && Math.abs(e.y - this.camY) < halfH + e.r;
      if (!v.root.visible) continue;
      let progress: number | null = null;
      if (self && controllable && self.extractStartedAt > 0) {
        const inside = this.selfRender && Math.hypot(this.selfRender.x - e.x, this.selfRender.y - e.y) <= e.r;
        if (self.extractId === id || (!self.extractId && inside)) {
          progress = (clock - self.extractStartedAt) / MATCH.EXTRACT_CHANNEL_MS;
        }
      }
      const caption = allowed ? extractCaption(status, e, clock, extractOpenAtFor(e, self)) : "NOT YOUR EXIT";
      v.update(e.x, e.y, e.r, status, caption, progress, now);
    }

    if (this.fog && eye) {
      this.fog.sprite.visible = true;
      this.fog.update({ eye, camX: this.camX, camY: this.camY, zoom: this.zoom, screenW: w, screenH: h, look: this.look });
    } else if (this.fog) {
      this.fog.sprite.visible = false;
    }

    this.partyNow = this.party.mates(now);
    for (const m of this.partyNow) if (m.id) this.mateIds.add(m.id);
    if (this.minimap) {
      this.minimap.layout(w, h);
      this.minimap.update(
        extractInfo,
        // Replaying / spectating: the minimap follows the replayed self / the watched mate.
        this.focus
          ? { x: this.focus.x, y: this.focus.y, aim: this.focusAim }
          : this.selfRender && me?.alive && (!self || self.extractedAt === 0)
            ? { x: this.selfRender.x, y: this.selfRender.y, aim: controllable ? this.aim : me.aim }
            : null,
        now,
        state,
        this.partyNow,
      );
    }

    if (!this.systemsReady && map && this.selfKey()) this.initSystems(app);
    const ctx = this.ctx;
    if (ctx && this.systemsReady) {
      for (const s of this.systems) {
        if (resized && s.resize) this.runSystem(s, () => s.resize!(w, h, ctx));
        if (s.frame) this.runSystem(s, () => s.frame!(dt, ctx));
      }
    }

    if (now - this.lastHudAt >= HUD_INTERVAL_MS) {
      this.lastHudAt = now;
      this.emitHud(state, clock, now);
    }
  };

  // ---------------------------------------------------------------------------------------
  // Killcam: record what is drawn, replay it after the death (killcam.ts).

  /** Start this frame's record (camera + fog eye), or null (frozen, too soon, not on the map). */
  private recordFrame(now: number, me: Player | null, self: SelfState | null, zoomMul: number): FrameSnap | null {
    const kc = this.killcam;
    if (kc.frozen || !me || !this.mapData) return null;
    if (self && self.extractedAt > 0) {
      // Extracted: nothing to replay, stop recording.
      kc.freeze(now);
      return null;
    }
    // Never seen alive on this client (joined dead): nothing worth keeping.
    if (!me.alive && kc.frames.size === 0) return null;
    const f = kc.beginFrame(now, !me.alive);
    if (!f) return null;
    f.camX = this.camX;
    f.camY = this.camY;
    f.zoom = zoomMul;
    const eye = this.eye;
    if (eye) {
      f.hasEye = true;
      f.eyeX = eye.x;
      f.eyeY = eye.y;
      f.eyeAim = eye.aim;
      f.eyeRange = eye.range;
    }
    return f;
  }

  /** One drawn player sprite into the frame's record (values only; strings by reference). */
  private recEnt(f: FrameSnap, id: string, p: Player, x: number, y: number, aim: number, alpha: number, act: number, bars: boolean) {
    const e = this.killcam.ent(f);
    if (!e) return;
    e.id = id;
    e.self = id === this.selfId;
    e.x = x;
    e.y = y;
    e.aim = aim;
    e.alpha = alpha;
    e.alive = p.alive;
    e.act = act;
    e.weapon = p.weapon;
    e.color = p.color;
    e.skin = p.skin ?? 0;
    e.nick = p.nickname;
    e.role = p.role ?? 0;
    e.bp = p.bp;
    e.hp = p.hp;
    e.maxHp = p.maxHp || 0;
    e.armor = p.armor;
    e.armorDur = p.armorDur;
    e.armorMax = p.armor >= 1 && p.armor <= 3 ? ARMOR[p.armor as 1 | 2 | 3].durability : 0;
    e.bars = bars;
  }

  /** Draw one replay frame: recorded sprites blended between two samples, then the due effects. */
  private drawReplay(rp: ReplaySample, now: number) {
    const tex = this.tex;
    const icons = this.icons;
    if (!tex || !icons) return;
    const { a, b, k } = rp;
    const seen = this.replaySeen;
    seen.clear();
    for (let i = 0; i < a.n; i++) {
      const ea = a.ents[i]!;
      const eb = entOf(b, ea.id) ?? ea;
      let v = this.replayViews.get(ea.id);
      if (!v) {
        v = new PlayerView(tex, icons, ea.id, ea.self, ea.nick);
        v.reset(ea.id, ea.nick);
        this.replayLayer.addChild(v.root);
        this.replayViews.set(ea.id, v);
      }
      seen.add(ea.id);
      const x = ea.x + (eb.x - ea.x) * k;
      const y = ea.y + (eb.y - ea.y) * k;
      const aim = lerpAngle(ea.aim, eb.aim, k);
      v.setAlive(ea.alive, now, aim);
      if (!ea.self) v.setRole(ea.role, ea.nick, this.mapData?.bosses, x, y);
      v.setColor(ea.color);
      v.setSkin(ea.skin);
      v.setNickname(ea.nick);
      v.setWeapon(ea.weapon, now);
      v.setBackpack(ea.bp);
      v.setAct(ea.act, now);
      v.place(x, y, aim, now);
      v.alpha = ea.alpha + (eb.alpha - ea.alpha) * k;
      v.root.alpha = ea.self ? 1 : v.alpha;
      v.root.visible = ea.self || v.alpha > 0.01;
      if (!ea.self) {
        v.setBars(ea.hp, ea.armor, ea.armorDur, ea.armorMax, ea.maxHp || undefined, now);
        v.updateBarsAlpha(now, ea.bars);
      }
    }
    for (const [id, v] of this.replayViews) if (!seen.has(id)) v.root.visible = false;
    const fx = this.effects;
    if (!fx || !this.replay) return;
    for (const e of this.replay.dueFx(rp.t, rp.done, this.replayFx)) {
      const n = e.a;
      switch (e.k) {
        case FX.SHOT:
          if (e.arr && e.w in WEAPONS) fx.shot(this.idx, e.s, e.w as WeaponId, n[0]!, n[1]!, n[2]!, n[3]!, e.arr as number[], e.self, now);
          break;
        case FX.KICK:
          this.replayViews.get(e.s)?.kick(n[0]!, now);
          break;
        case FX.STOP:
          fx.stopTracer(e.s, n[0]!, n[1]!);
          break;
        case FX.BURST:
          fx.hitBurst(n[0]!, n[1]!, e.flag, now, n[2]!, n[3]!);
          break;
        case FX.FLASH:
          this.replayViews.get(e.s)?.flashHit(now, n[0]!, n[1]!);
          break;
        case FX.DMG:
          if (!e.self) this.replayViews.get(e.s)?.revealBars(now);
          fx.damageNumber(e.s, n[0]!, n[1]!, n[2]!, e.flag, e.self, now);
          break;
        case FX.PUFF:
          fx.confirmPuff(n[0]!, n[1]!, now);
          break;
        case FX.RING:
          fx.ring(n[0]!, n[1]!, n[2]!, n[3]!, n[4]!, now);
          break;
        case FX.SPARK:
          fx.burst(n[0]!, n[1]!, n[2]!, n[3]!, n[4]!, now);
          break;
        default:
          break;
      }
    }
  }

  /** ACT flags of the local player, from the prediction and own timers (no round trip). */
  private selfAct(self: SelfState | null, clock: number): number {
    let a = 0;
    if (this.predictor?.rolling) a |= ACT.ROLL;
    if (!self) return a;
    if (self.reloadUntil > clock) a |= ACT.RELOAD;
    if (self.healUntil > clock) a |= ACT.HEAL;
    if (self.searching) a |= ACT.LOOT;
    if (self.extractStartedAt > 0 && self.extractedAt === 0) a |= ACT.EXTRACT;
    return a;
  }

  /** Hide a faded-out remote player and keep its view for the next one that comes into view. */
  /** A body started to fall: its corpse (often decoded first) waits until the fall lands. */
  private holdCorpseNear(v: PlayerView) {
    for (const ce of this.corpses.values()) {
      const cv = ce.view;
      if (cv.alpha < 0.5 && Math.abs(ce.state.x - v.x) < 64 && Math.abs(ce.state.y - v.y) < 64) {
        cv.holdUntil = Math.max(cv.holdUntil, v.deathAt + CORPSE_HANDOVER_MS);
        cv.alpha = 0;
      }
    }
  }

  private retirePlayer(id: string, e: Fading<Player, PlayerView>) {
    this.players.delete(id);
    const v = e.view;
    v.root.visible = false;
    v.buffer.clear();
    if (this.playerPool.length < PLAYER_POOL_MAX) this.playerPool.push(v);
    else v.destroy();
  }

  private updateEnv(state: BattleState, clock: number) {
    const map = this.mapData;
    if (!map) return;
    const key = `${state.envSeed}|${state.todStartMin}|${state.durationMs}|${state.weatherOverride}`;
    if (key !== this.envKey) {
      this.envKey = key;
      this.envCfg = envConfigOf(
        { envSeed: state.envSeed, todStartMin: state.todStartMin, durationMs: state.durationMs || MATCH.DURATION_MS, weatherOverride: state.weatherOverride },
        map,
      );
    }
    if (!this.envCfg) return;
    try {
      this.env = sampleEnv(this.envCfg, clock);
      this.look = fogLook(this.env);
    } catch {
      this.env = null;
      this.look = fogLook(null);
    }
  }

  private buildMap(state: BattleState) {
    if (!this.tex || !this.app) return;
    let map: MapData;
    try {
      map = mapForState(state);
    } catch (err) {
      console.error("[game] map generation failed", err);
      return;
    }
    this.mapData = map;
    this.idx = getCollisionIndex(map);
    this.bushes = buildBushIndex(map.bushes, map.width, map.height);
    this.predictor = new Predictor(moveFnFor(map, this.idx));

    let wv: StaticWorld;
    try {
      wv = new WorldView(map, this.tex, this.app.renderer);
    } catch (err) {
      console.error("[game] chunked world failed, using the fallback", err);
      wv = new FallbackWorld(map);
    }
    this.worldView = wv;
    this.groundSlot.addChild(wv.ground);
    this.canopySlot.addChild(wv.canopy);

    this.containers = new ContainerLayer(map.containers, this.tex, map.width);
    this.containerSlot.addChild(this.containers.root);

    try {
      this.fog = new FogOfWar(this.app.renderer, map, this.app.screen.width, this.app.screen.height);
      // Above the whole world (incl. canopy and weather), below the screen-space layer.
      this.app.stage.addChildAt(this.fog.sprite, this.app.stage.getChildIndex(this.layers.screen));
    } catch (err) {
      console.error("[game] fog of war failed", err);
      this.fog = null;
    }

    try {
      this.minimap = new Minimap(map);
      this.app.stage.addChildAt(this.minimap.root, this.app.stage.getChildIndex(this.layers.screen) + 1);
    } catch (err) {
      console.error("[game] minimap failed", err);
      this.minimap = null;
    }

    // Prediction was waiting for the collision index: start it from the server position.
    const sm = readServerMove(state, this.selfKey(), this.selfId);
    if (sm) {
      this.predictor.setTiming(sm);
      this.predictor.reset(sm.x, sm.y, sm.roll);
      this.prevPredX = sm.x;
      this.prevPredY = sm.y;
    }
  }

  /**
   * Sends one input sample and predicts it. Returns false when nothing could be sent. `early`: a click
   * sent ahead of the cadence keeps the smoothing's start point, so this step and the previous one
   * are drawn over the whole gap to the next sample (no jump).
   */
  private sendInput(early = false): boolean {
    const input = this.input;
    const p = this.predictor;
    if (!input || !p) return false;
    const { mx, my } = input.movement();
    const fire = input.sampleFire();
    const roll = input.sampleRoll();
    const walk = input.walkHeld();
    const seq = p.nextSeq();
    // Phones: the stick's direction as of now, not the facing updateAim() left one frame ago, so a
    // flick's first shot leaves along the stick (sampleAim).
    this.aim = sampleAim(this.aim, input.touchFacing, this.inputBlockedNow);
    const sample: InputSample = { seq, mx, my, aim: this.aim, fire };
    if (roll) sample.roll = true;
    if (walk) sample.walk = true;
    if (!this.send(C2S.INPUT, sample)) return false;
    if (!early) {
      this.prevPredX = p.x;
      this.prevPredY = p.y;
    }
    const r = p.apply(sample);
    // Predicted roll start: play the roll sound now instead of one round trip later.
    if (r.started) getGameAudio()?.localRoll();
    // A shot (or a roll start) cancels the heal on the server right after this input.
    const self = this.selfState();
    if (self && inputCancelsHeal(self, fire, this.prevFire, r.rolling)) p.predictHealCancel();
    if (self) this.predictOwnShot(self, fire, r.rolling);
    this.prevFire = fire;
    return true;
  }

  /**
   * Phones: the reticle on the aim-stick line at the effective aim distance (kept above the HUD's
   * bottom bar), the aim point the hitmarker follows, and the camera: centred on the player while
   * walking, leaning toward the aim while the aim stick is held (crosshair.ts touchAimLean).
   */
  private updateTouchCrosshair(dt: number, w: number, h: number, live: boolean, rangeWorld: number) {
    const ch = this.touchCrosshair;
    const input = this.input;
    if (!ch || !input) return;
    const self = this.selfRender;
    const aiming = live && !!self && input.touchAimAngle !== null;
    const facing = live && !!self && (aiming || input.touchMoveAngle !== null);
    const hud = this.touchHudBands(w, h);
    const sx = self ? w / 2 + (self.x - this.camX) * this.zoom : w / 2;
    const sy = self ? h / 2 + (self.y - this.camY) * this.zoom : h / 2;
    const dist = touchCrosshairDistance(rangeWorld, this.zoom, sx, sy, this.aim, w, h, hud.bottom);
    // Red while the aim line is on an enemy (what auto-fire shoots at).
    ch.update(dt, aiming, sx, sy, this.aim, dist, aiming && this.autoFireLock(this.aim) !== null);
    if (facing) feedAimPointer(sx + Math.cos(this.aim) * dist, sy + Math.sin(this.aim) * dist);
    if (aiming && this.zoom > 0) {
      touchAimLean(rangeWorld, this.zoom, this.aim, w, h, hud.top, hud.bottom, this.leanOut);
      setTouchLook(this.leanOut.x / this.zoom, this.leanOut.y / this.zoom);
    } else setTouchLook(0, 0);
  }

  private readonly leanOut = { x: 0, y: 0 };
  private hudBands = { w: 0, h: 0, top: 0, bottom: 0 };
  /** Heights (px) of the touch HUD's top row and bottom bar, from the layout touch-controls mirrors. */
  private touchHudBands(w: number, h: number): { top: number; bottom: number } {
    const b = this.hudBands;
    if (b.w !== w || b.h !== h) {
      const rects = hudReservedRects(w, h);
      const chips = rects.find((r) => r.id === "chips");
      const bar = rects.find((r) => r.id === "bar");
      this.hudBands = { w, h, top: chips ? chips.y + chips.h : 0, bottom: bar ? h - bar.y : 0 };
    }
    return this.hudBands;
  }

  /**
   * Phones: the enemy the aim line along `angle` is on (auto-fire.ts), from the predicted position
   * (what the next input moves from) with the active weapon's range, over the entities the client
   * draws right now (faded in by the fog). Null = do not fire.
   */
  private autoFireLock(angle: number): AutoFireCandidate | null {
    const me = this.me();
    if (!me?.alive || !(me.weapon in WEAPONS)) return null;
    const range = WEAPONS[me.weapon as WeaponId].range;
    const p = this.predictor;
    const o = p?.isInitialized ? { x: p.x, y: p.y } : this.selfRender;
    if (!o) return null;
    const out: AutoFireCandidate[] = [];
    for (const [id, e] of this.players) {
      if (id === this.selfId) continue;
      const v = e.view;
      const pl = e.state;
      out.push({
        id,
        x: v.x,
        y: v.y,
        alive: pl.alive && !e.removing,
        visible: v.alpha > 0.5,
        mate: isPartyMate(id, v.x, v.y, pl.role ?? 0, this.mateIds, this.partyNow),
      });
    }
    return autoFireTarget(this.idx, o.x, o.y, angle, range, out);
  }

  /** Forward a UI command to the first system that handles it. */
  private systemCommand(name: SystemCommand): void {
    for (const s of this.systems) {
      let handled = false;
      if (s.command) this.runSystem(s, () => (handled = s.command!(name)));
      if (handled) return;
    }
  }

  /** Aim from the rendered player position to the cursor, in world space (shake excluded). */
  private updateAim(w: number, h: number) {
    // Phones: the aim stick, else the facing follows the move stick.
    const touchAim = this.input?.touchFacing ?? null;
    if (touchAim !== null) {
      this.aim = touchAim;
      return;
    }
    if (!this.input?.hasPointer || !this.selfRender) return;
    const wx = this.camX + (this.input.mouseX - w / 2) / this.zoom;
    const wy = this.camY + (this.input.mouseY - h / 2) / this.zoom;
    const dx = wx - this.selfRender.x;
    const dy = wy - this.selfRender.y;
    if (dx * dx + dy * dy > 1) this.aim = Math.atan2(dy, dx);
  }

  private emitHud(state: BattleState, clock: number, now: number) {
    while (this.killFeed.length && now - this.killFeed[0]!.receivedAt > KILL_FEED_TTL_MS) this.killFeed.shift();
    while (this.xpGains.length && now - this.xpGains[0]!.receivedAt > XP_GAIN_SHOW_MS) this.xpGains.shift();
    const p = this.predictor;
    let snapshot: HudSnapshot = buildHud({
      state,
      sessionId: this.selfId,
      selfKey: this.selfKey(),
      selfPos: this.selfRender,
      clockMs: clock,
      killFeed: this.killFeed.map(({ receivedAt: _r, ...e }) => e),
      killTally: this.killTally,
      pingMs: this.pingMs,
      idx: this.idx,
      map: this.mapData,
      move: p ? { rollCooldownMs: p.rollCooldownMs, rolling: p.rolling, walking: p.walking } : null,
      known: this.known,
      channel: worldEventsView.channel,
    });
    this.counts = stickyCounts(this.counts, snapshot);
    snapshot = {
      ...snapshot,
      aliveCount: this.counts.alive,
      totalPlayers: this.counts.total,
      // The full map is the only system that blocks input (fullmap.ts): it is open.
      mapOpen: this.systemsReady && this.systems.some((s) => s.isInputBlocked?.() === true),
      // First-raid tutorial (tutorial.ts): the drawn position and the local aim.
      pose: this.selfRender ? { x: this.selfRender.x, y: this.selfRender.y, aim: this.aim } : null,
      xpGains: this.xpGains.map(({ receivedAt: _r, ...g }) => g),
      spectate: this.spectateHud(state),
      replay: {
        available: this.diedHere && !!this.killcam.window(),
        playing: !!this.replay,
        progress: this.replay ? this.replayProgress : 0,
        played: this.replayPlayed,
        autoPlay: !reducedMotion(),
      },
    };
    if (this.touch) {
      const s = snapshot.self;
      this.touch.sync({
        // Portrait (the rotate overlay of battle-screen covers the game): no controls, no input.
        active: !!s && s.alive && s.extractedAt === 0 && snapshot.phase !== "ended" && !this.portrait,
        mapOpen: snapshot.mapOpen,
        canUse: !!snapshot.interactHint,
        bandages: s?.bandages ?? 0,
        medkits: s?.medkits ?? 0,
        grenades: s?.grenades ?? 0,
        // Cooldowns as the client already enforces them (Predictor roll; nextThrowAt on performance.now()).
        rollCdMs: p ? p.rollCooldownMs : 0,
        grenadeCdMs: Math.max(0, this.nextThrowAt - performance.now()),
      });
    }
    try {
      this.opts.onHud(snapshot);
    } catch (err) {
      console.error("[game] onHud failed", err);
    }
  }

  /** Spectate part of the HUD: the living mates to offer, the watched mate's bars, why it ended. */
  private spectateHud(state: BattleState): NonNullable<HudSnapshot["spectate"]> {
    const mates: Array<{ key: string; name: string }> = [];
    for (const m of this.partyNow) if (m.alive && m.key) mates.push({ key: m.key, name: m.name });
    const w = this.watch;
    const p = w ? state.players.get(w.id) : undefined;
    return {
      mates,
      watching: w
        ? {
            key: w.key,
            name: w.name,
            alive: p?.alive ?? true,
            hp: p ? Math.max(0, Math.round(p.hp)) : 0,
            maxHp: p?.maxHp || 100,
            armor: p?.armor ?? 0,
            armorDur: p?.armorDur ?? 0,
            armorMax: p && p.armor >= 1 && p.armor <= 3 ? ARMOR[p.armor as 1 | 2 | 3].durability : 0,
            weapon: p?.weapon ?? "",
          }
        : null,
      pending: this.watchPending !== null,
      ended: this.watchEnded,
    };
  }

  /** Debug / harness counters (fog cost, entity counts). */
  debugStats() {
    return {
      fogCpuMs: this.fog?.stats.cpuMs ?? 0,
      fogQuads: this.fog?.stats.quads ?? 0,
      players: this.players.size,
      pooledPlayers: this.playerPool.length,
      items: this.items.size,
      corpses: this.corpses.size,
      systems: this.systems.map((s) => s.id),
      world: (this.worldView as { stats?: () => unknown } | null)?.stats?.() ?? null,
      visibleRemote: [...this.players.values()].filter((e) => e.view.alpha > 0.5 && e.view.sessionId !== this.selfId).length,
    };
  }
}

/** Minimal shape of the colyseus collection callback proxy we use. */
interface CollectionProxy<V> {
  onAdd(cb: (item: V, key: string) => void, immediate?: boolean): () => void;
  onRemove(cb: (item: V, key: string) => void): () => void;
}

function fmtClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** `openAt` = when it opens for this player (extractOpenAtFor: map openAt or the personal arm). */
export function extractCaption(status: ReturnType<typeof personalExtractStatus>, e: Pick<Extract, "closeAt">, clock: number, openAt: number): string {
  if (status === "closed") return "CLOSED";
  if (status === "waiting") return `OPENS IN ${fmtClock(openAt - clock)}`;
  if (e.closeAt > 0 && e.closeAt - clock <= 60_000) return `CLOSES IN ${fmtClock(e.closeAt - clock)}`;
  return "EXTRACT";
}
