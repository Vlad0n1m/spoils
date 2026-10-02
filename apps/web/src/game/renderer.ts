/**
 * Pixi 8 renderer + input + netcode for the battle room (v2).
 *
 * - The server is authoritative; the client sends an InputSample every INPUT_DT_MS (movement, aim,
 *   trigger, roll, walk) plus discrete intents (interact / reload / switch / heal).
 * - The local player is predicted with the shared stepMovement (Predictor) and reconciled against
 *   SelfState.lastSeq + roll state on every patch; remote players are interpolated ~100 ms in the
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
 * Used by battle-screen.tsx: `new GameRenderer({ mountEl, room, onHud, selfKey }); await r.start(); … r.stop()`.
 */

import { Application, Container, Graphics } from "pixi.js";
import { getStateCallbacks } from "colyseus.js";
import {
  ACT,
  ARMOR,
  C2S,
  HEAL,
  INPUT_DT_MS,
  MATCH,
  S2C,
  SOLID,
  WEAPONS,
  buildBushIndex,
  bushIndexAt,
  envConfigOf,
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
  type WeaponId,
} from "@extract/shared";
import { COLORS, destroyTextures, loadTextures, type Textures } from "./assets";
import { Effects } from "./effects";
import { ContainerLayer, CorpseView, ExtractView, IconCache, ItemView, PlayerView, containerSprite } from "./entities";
import { FogOfWar, PLAYER_PAD, entityVisibility, fadeToward, fogLook, fogRange, type FogEye, type FogLook } from "./fog";
import { buildHud, extractAllowed, extractStatus, stickyCounts, type PlayerCounts } from "./hud";
import { InputController } from "./input";
import { Minimap, type MinimapExtract } from "./minimap";
import { canStartHeal, decayFactor, inputCancelsHeal, moveFnFor, Predictor, readServerMove } from "./prediction";
import { DelayQueue, shotCentre } from "./shots";
import type { CameraView, GameContext, GameLayers, GameSystem } from "./systems";
import { SYSTEM_FACTORIES } from "./systems-registry";
import type { GameRendererApi, HudSnapshot, KillFeedEntry, RendererOptions } from "./types";
import { WorldView, type ViewRect } from "./world";
import { getGameAudio } from "./audio/game-audio";

/** About this many world units are visible (by area), whatever the window size. */
const VIEW_W = 1600;
const VIEW_H = 900;
/** Retina at full resolution is expensive for little gain with this art style. */
const MAX_RESOLUTION = 1.5;
/** Remote players are drawn this far in the past (two 20 Hz patches) so there is always a pair to interpolate. */
const INTERP_DELAY_MS = 100;
/** Corrections larger than this snap instead of gliding (spawn, teleport, long desync). */
const SNAP_DIST = 96;
/** Time constant for gliding away small prediction errors. */
const CORRECTION_TAU_MS = 90;
const HUD_INTERVAL_MS = 33;
const PING_INTERVAL_MS = 2000;
const KILL_FEED_MAX = 5;
const KILL_FEED_TTL_MS = 6000;
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

  private players = new Map<string, Fading<Player, PlayerView>>();
  private playerPool: PlayerView[] = [];
  private items = new Map<string, Fading<GroundItem, ItemView>>();
  private corpses = new Map<string, Fading<Corpse, CorpseView>>();
  private extracts = new Map<string, { state: Extract; view: ExtractView }>();

  private systems: GameSystem[] = [];
  private systemErrors = new Map<GameSystem, number>();
  private systemsReady = false;
  private ctx: GameContext | null = null;
  private screenW = 0;
  private screenH = 0;

  private disposers: Array<() => void> = [];
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  /** S2C.JOINED seen by the renderer itself (the screen usually captures it first). */
  private joinedSelfKey: string | null = null;

  // Netcode
  private predictor: Predictor | null = null;
  /** Predicted position before the latest input, for smoothing between 30 Hz input steps. */
  private prevPredX = 0;
  private prevPredY = 0;
  /** Visual offset left over from reconciliation, decays to 0. */
  private corrX = 0;
  private corrY = 0;
  private inputAcc = 0;
  private aim = 0;
  /** Fire state of the last input sent (semi-auto weapons fire on a press). */
  private prevFire = false;
  /** Local player's rendered position (what the camera follows and aim is measured from). */
  private selfRender: { x: number; y: number } | null = null;
  private camX = 0;
  private camY = 0;
  private zoom = 1;
  private warmedUp = false;

  // Clock estimate between 20 Hz patches.
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
  private killSeq = 0;
  /** Last player counts taken while the raid was running (the end of the match clears "alive"). */
  private counts: PlayerCounts | null = null;

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

    this.effects = new Effects();
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
    });
    this.input.attach();

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

    if (this.app) {
      this.app.ticker.remove(this.tick);
      this.app.destroy(true, { children: true });
      this.app = null;
    }
    if (this.tex) {
      destroyTextures(this.tex);
      this.tex = null;
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
    if (e) e.removing = true;
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
    view.sync(c);
    view.root.alpha = 0;
    this.corpseLayer.addChild(view.root);
    this.corpses.set(id, { state: c, view, removing: false });
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

  /** Runs after every decoded patch (20 Hz): timestamps for interpolation + reconciliation. */
  private onStatePatch() {
    const state = this.state;
    if (!state || this.stopped) return;
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
    if (Array.isArray(ev.chest)) {
      const now = performance.now();
      for (const c of ev.chest) {
        const spot = this.containers?.at(c.idx);
        if (!spot || !this.effects) continue;
        const color = containerSprite(spot.tier).color;
        this.effects.ring(spot.x, spot.y, color, 80, 450, now);
        this.effects.burst(spot.x, spot.y, color, 16, 320, now);
      }
    }
    const ctx = this.ctx;
    if (!ctx || !this.systemsReady) return;
    for (const s of this.systems) if (s.onEvents) this.runSystem(s, () => s.onEvents!(ev, ctx));
  }

  private onShot(m: ShotMsg) {
    if (!this.effects || !m || !Array.isArray(m.a) || !(m.w in WEAPONS)) return;
    const now = performance.now();
    const w = m.w as WeaponId;
    const muzzle = WEAPONS[w].muzzle;
    const isSelf = m.s === this.selfId;
    if (isSelf && this.selfRender && m.a.length) {
      // Our own shots start at the gun we see (the predicted position), not where the
      // server had us one round trip ago.
      const a = m.a.reduce((s, v) => s + v, 0) / m.a.length;
      const { x: cx, y: cy } = this.selfRender;
      const x = cx + Math.cos(a) * muzzle;
      const y = cy + Math.sin(a) * muzzle;
      this.effects.shot(this.idx, m.s, w, cx, cy, x, y, m.a, true, now);
      return;
    }
    // Walls are raycast from the shooter's centre, like the server's bullets. A clipped shot of a
    // hidden shooter (s = "") starts at the view-circle entry: cx/cy equal x/y there.
    const c = shotCentre(m, muzzle);
    const play = (t: number) => this.effects?.shot(this.idx, m.s, w, c.x, c.y, m.x, m.y, m.a, isSelf, t);
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
    at(m.s !== this.selfId, () => this.effects?.stopTracer(m.s, m.x, m.y));
    at(m.t !== this.selfId, (t) => {
      const fx = this.effects;
      if (!fx) return;
      fx.hitBurst(m.x, m.y, !!m.ar, t);
      if (m.t === this.selfId) {
        if (m.d > 0) fx.damageNumber(m.x, m.y, m.d, COLORS.damageTaken, t);
        fx.hurtFlash(m.d);
      } else if (m.s === this.selfId && m.d > 0) {
        fx.damageNumber(m.x, m.y, m.d, m.ar ? COLORS.hitArmor : COLORS.damageDealt, t);
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
      atMs: this.clockNow(now),
      receivedAt: now,
    });
    if (this.killFeed.length > KILL_FEED_MAX) this.killFeed.splice(0, this.killFeed.length - KILL_FEED_MAX);
    // Only bodies this client can see get the burst (KILL is broadcast with names only).
    const v = this.players.get(m.victimId)?.view;
    if (v && v.alpha > 0.05 && this.effects) {
      this.effects.burst(v.x, v.y, 0xff3b3b, 22, 380, now);
      this.effects.ring(v.x, v.y, 0xffffff, 70, 400, now);
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
      selfPos: () => this.selfRender ?? { x: this.camX, y: this.camY },
      aim: () => this.aim,
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
    this.screenW = w;
    this.screenH = h;
    this.zoom = Math.sqrt((w * h) / (VIEW_W * VIEW_H)) || 1;

    if (!this.mapData && state.mapId && (state.mapId !== LEGACY_MAP_ID || state.mapSeed)) this.buildMap(state);
    const map = this.mapData;

    const clock = this.clockNow(now);
    const me = this.me();
    const self = this.selfState();
    const controllable = !!this.idx && this.canAct();
    const pred = this.predictor;

    // Overlays (inventory / search panel) own the mouse: no fire, aim frozen.
    const blocked = !!this.opts.isInputBlocked?.();
    this.input?.setFireBlocked(blocked);

    // Fixed-rate input loop, only while the player can act. Bursts are capped so a hidden tab
    // does not dump a backlog.
    if (controllable && pred) {
      this.inputAcc = Math.min(this.inputAcc + dt, INPUT_DT_MS * 3);
      while (this.inputAcc >= INPUT_DT_MS) {
        this.inputAcc -= INPUT_DT_MS;
        if (!this.sendInput()) break;
      }
    } else {
      this.inputAcc = 0;
      // Drop clicks / roll presses made while out of control so they do not fire later.
      this.input?.dropBuffered();
    }

    // Local player: predicted position, smoothed between input steps, plus decaying correction.
    if (me && controllable && pred) {
      const k = this.inputAcc / INPUT_DT_MS;
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

    if (this.selfRender) {
      this.camX = this.selfRender.x;
      this.camY = this.selfRender.y;
    }
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

    this.remoteFx.flush(now);
    const shake = this.effects?.update(now, dt, w, h) ?? { x: 0, y: 0 };
    this.world.scale.set(this.zoom);
    this.world.position.set(w / 2 - this.camX * this.zoom + shake.x, h / 2 - this.camY * this.zoom + shake.y);

    const halfW = w / 2 / this.zoom + CULL_MARGIN;
    const halfH = h / 2 / this.zoom + CULL_MARGIN;
    const view: ViewRect = { x0: this.camX - halfW, y0: this.camY - halfH, x1: this.camX + halfW, y1: this.camY + halfH };
    const inView = (x: number, y: number) => x >= view.x0 && x <= view.x1 && y >= view.y0 && y <= view.y1;

    const selfOnMap = controllable ? this.selfRender : null;
    this.worldView?.update(view, selfOnMap, dt);
    this.containers?.update(view.x0, view.y0, view.x1, view.y1, state.containerState as unknown as ArrayLike<number>, now);

    // Environment → darkness, tint, vision range.
    this.updateEnv(state, clock);
    this.world.tint = this.look.tint;
    const fogOn = !!this.fog && !!this.selfRender;
    this.eye = fogOn ? { x: this.selfRender!.x, y: this.selfRender!.y, aim: this.aim, range: fogRange(this.env) } : null;
    const eye = this.eye;
    const vis = (x: number, y: number, pad: number) => (eye ? entityVisibility(this.idx, eye, x, y, pad) : 1);

    const selfBush = selfOnMap && this.bushes ? bushIndexAt(this.bushes, selfOnMap.x, selfOnMap.y) : -1;

    // Players
    const renderT = now - INTERP_DELAY_MS;
    for (const [id, e] of this.players) {
      const p = e.state;
      const v = e.view;
      if (id === this.selfId) {
        const onMap = p.alive && (!self || self.extractedAt === 0) && !e.removing;
        const pos = this.selfRender ?? { x: p.x, y: p.y };
        v.setAct(this.selfAct(self, clock), now);
        v.place(pos.x, pos.y, controllable ? this.aim : p.aim, now);
        v.root.visible = onMap;
        if (!onMap) continue;
        v.root.alpha = 1;
        v.setColor(p.color);
        v.setNickname(p.nickname);
        v.setWeapon(p.weapon);
        v.setBackpack(p.bp);
        continue;
      }
      const s = v.buffer.sample(renderT) ?? { x: p.x, y: p.y, aim: p.aim };
      v.setAct(p.act, now);
      v.place(s.x, s.y, s.aim, now);
      const target = e.removing || !p.alive ? 0 : vis(v.x, v.y, PLAYER_PAD);
      v.alpha = fadeToward(v.alpha, target, dt);
      if (e.removing && v.alpha <= 0) {
        this.retirePlayer(id, e);
        continue;
      }
      v.root.alpha = v.alpha;
      v.root.visible = v.alpha > 0.01 && inView(v.x, v.y);
      if (!v.root.visible) continue;
      v.setColor(p.color);
      v.setNickname(p.nickname);
      v.setWeapon(p.weapon);
      v.setBackpack(p.bp);
      const armorMax = p.armor >= 1 && p.armor <= 3 ? ARMOR[p.armor as 1 | 2 | 3].durability : 0;
      v.setBars(p.hp, p.armor, p.armorDur, armorMax);
      const bush = this.bushes ? bushIndexAt(this.bushes, v.x, v.y) : -1;
      v.setLabelVisible(bush < 0 || bush === selfBush);
    }

    // Ground items and corpses: AOI-filtered by the server, faded by the fog here.
    for (const [id, e] of this.items) {
      const it = e.state;
      const v = e.view;
      const target = e.removing ? 0 : inView(it.x, it.y) ? vis(it.x, it.y, 0) : 0;
      v.alpha = fadeToward(v.alpha, target, dt);
      if (e.removing && v.alpha <= 0) {
        v.destroy();
        this.items.delete(id);
        continue;
      }
      v.root.alpha = v.alpha;
      v.root.visible = v.alpha > 0.01;
      if (!v.root.visible) continue;
      v.sync(it);
      v.update(it.x, it.y, now);
    }
    for (const [id, e] of this.corpses) {
      const c = e.state;
      const v = e.view;
      const target = e.removing ? 0 : inView(c.x, c.y) ? vis(c.x, c.y, PLAYER_PAD) : 0;
      v.alpha = fadeToward(v.alpha, target, dt);
      if (e.removing && v.alpha <= 0) {
        v.destroy();
        this.corpses.delete(id);
        continue;
      }
      v.root.alpha = v.alpha;
      v.root.visible = v.alpha > 0.01;
      if (v.root.visible) v.sync(c);
    }

    const mask = self?.extractMask ?? 0;
    const extractInfo: MinimapExtract[] = [];
    for (const [id, { state: e, view: v }] of this.extracts) {
      const allowed = extractAllowed(map, mask, id);
      const status = allowed ? extractStatus(e, clock) : "closed";
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
      const caption = allowed ? extractCaption(status, e, clock) : "NOT YOUR EXIT";
      v.update(e.x, e.y, e.r, status, caption, progress, now);
    }

    if (this.fog && eye) {
      this.fog.sprite.visible = true;
      this.fog.update({ eye, camX: this.camX, camY: this.camY, zoom: this.zoom, screenW: w, screenH: h, look: this.look });
    } else if (this.fog) {
      this.fog.sprite.visible = false;
    }

    if (this.minimap) {
      this.minimap.layout(w, h);
      this.minimap.update(
        extractInfo,
        this.selfRender && me?.alive && (!self || self.extractedAt === 0)
          ? { x: this.selfRender.x, y: this.selfRender.y, aim: controllable ? this.aim : me.aim }
          : null,
        now,
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

  /** Sends one input sample and predicts it. Returns false when nothing could be sent. */
  private sendInput(): boolean {
    const input = this.input;
    const p = this.predictor;
    if (!input || !p) return false;
    const { mx, my } = input.movement();
    const fire = input.sampleFire();
    const roll = input.sampleRoll();
    const walk = input.walkHeld();
    const seq = p.nextSeq();
    const sample: InputSample = { seq, mx, my, aim: this.aim, fire };
    if (roll) sample.roll = true;
    if (walk) sample.walk = true;
    if (!this.send(C2S.INPUT, sample)) return false;
    this.prevPredX = p.x;
    this.prevPredY = p.y;
    const r = p.apply(sample);
    // Predicted roll start: play the roll sound now instead of one round trip later.
    if (r.started) getGameAudio()?.localRoll();
    // A shot (or a roll start) cancels the heal on the server right after this input.
    const self = this.selfState();
    if (self && inputCancelsHeal(self, fire, this.prevFire, r.rolling)) p.predictHealCancel();
    this.prevFire = fire;
    return true;
  }

  /** Aim from the rendered player position to the cursor, in world space (shake excluded). */
  private updateAim(w: number, h: number) {
    if (!this.input?.hasPointer || !this.selfRender) return;
    const wx = this.camX + (this.input.mouseX - w / 2) / this.zoom;
    const wy = this.camY + (this.input.mouseY - h / 2) / this.zoom;
    const dx = wx - this.selfRender.x;
    const dy = wy - this.selfRender.y;
    if (dx * dx + dy * dy > 1) this.aim = Math.atan2(dy, dx);
  }

  private emitHud(state: BattleState, clock: number, now: number) {
    while (this.killFeed.length && now - this.killFeed[0]!.receivedAt > KILL_FEED_TTL_MS) this.killFeed.shift();
    const p = this.predictor;
    let snapshot: HudSnapshot = buildHud({
      state,
      sessionId: this.selfId,
      selfKey: this.selfKey(),
      selfPos: this.selfRender,
      clockMs: clock,
      killFeed: this.killFeed.map(({ receivedAt: _r, ...e }) => e),
      pingMs: this.pingMs,
      idx: this.idx,
      map: this.mapData,
      move: p ? { rollCooldownMs: p.rollCooldownMs, rolling: p.rolling, walking: p.walking } : null,
    });
    this.counts = stickyCounts(this.counts, snapshot);
    snapshot = { ...snapshot, aliveCount: this.counts.alive, totalPlayers: this.counts.total };
    try {
      this.opts.onHud(snapshot);
    } catch (err) {
      console.error("[game] onHud failed", err);
    }
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

function extractCaption(status: ReturnType<typeof extractStatus>, e: Extract, clock: number): string {
  if (status === "closed") return "CLOSED";
  if (status === "waiting") return `OPENS IN ${fmtClock(e.openAt - clock)}`;
  if (e.closeAt > 0 && e.closeAt - clock <= 60_000) return `CLOSES IN ${fmtClock(e.closeAt - clock)}`;
  return "EXTRACT";
}
