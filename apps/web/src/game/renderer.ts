/**
 * Pixi 8 renderer + input + netcode for the battle room.
 *
 * - The server is authoritative; the client sends an InputSample every INPUT_DT_MS plus
 *   discrete intents (interact / reload / switch / heal).
 * - The local player is predicted with the shared applyMovement() and reconciled against
 *   Player.lastSeq on every state patch; remote players are interpolated ~100 ms in the past.
 * - The static map is rebuilt locally from state.mapSeed with generateMap().
 *
 * Used by battle-screen.tsx: `new GameRenderer({ mountEl, room, onHud }); await r.start(); … r.stop()`.
 */

import { Application, Container } from "pixi.js";
import { getStateCallbacks } from "colyseus.js";
import {
  applyMovement,
  ARMOR,
  C2S,
  generateMap,
  getCollisionIndex,
  INPUT_DT_MS,
  MATCH,
  PLAYER,
  RARITY_COLORS,
  S2C,
  WEAPONS,
  WORLD,
  type BattleState,
  type ChestOpenedMsg,
  type CollisionIndex,
  type Extract,
  type GroundItem,
  type Chest,
  type HitMsg,
  type InputSample,
  type KillMsg,
  type MapData,
  type Player,
  type ShotMsg,
  type WeaponId,
} from "@extract/shared";
import { COLORS, destroyTextures, loadTextures, type Textures } from "./assets";
import { Effects } from "./effects";
import { ChestView, ExtractView, ItemView, PlayerView } from "./entities";
import { buildHud, extractStatus } from "./hud";
import { InputController } from "./input";
import { Minimap } from "./minimap";
import { decayFactor, Predictor } from "./prediction";
import type { GameRendererApi, HudSnapshot, KillFeedEntry, RendererOptions } from "./types";
import { WorldView, type ViewRect } from "./world";

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

interface Tracked<T, V> {
  state: T;
  view: V;
}

export class GameRenderer implements GameRendererApi {
  private app: Application | null = null;
  private tex: Textures | null = null;
  private started = false;
  private stopped = false;

  private readonly world = new Container();
  private readonly groundSlot = new Container();
  private readonly shadowSlot = new Container();
  private readonly extractLayer = new Container();
  private readonly chestLayer = new Container();
  private readonly itemLayer = new Container();
  private readonly obstacleSlot = new Container();
  private readonly wallSlot = new Container();
  private readonly playerLayer = new Container();
  private readonly effectsSlot = new Container();
  private readonly canopySlot = new Container();
  private readonly floatSlot = new Container();

  private worldView: WorldView | null = null;
  private map: MapData | null = null;
  private idx: CollisionIndex | null = null;
  private minimap: Minimap | null = null;
  private effects: Effects | null = null;
  private input: InputController | null = null;

  private players = new Map<string, Tracked<Player, PlayerView>>();
  private chests = new Map<string, Tracked<Chest, ChestView>>();
  private items = new Map<string, Tracked<GroundItem, ItemView>>();
  private extracts = new Map<string, Tracked<Extract, ExtractView>>();

  private disposers: Array<() => void> = [];
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  // Netcode
  private readonly predictor = new Predictor((x, y, input, mult) =>
    this.idx ? applyMovement(this.idx, x, y, input, mult) : { x, y },
  );
  /** Predicted position before the latest input, for smoothing between 30 Hz input steps. */
  private prevPredX = 0;
  private prevPredY = 0;
  /** Visual offset left over from reconciliation, decays to 0. */
  private corrX = 0;
  private corrY = 0;
  private inputAcc = 0;
  private aim = 0;
  /** Local player's rendered position (what the camera follows and aim is measured from). */
  private selfRender: { x: number; y: number } | null = null;
  private camX = WORLD.WIDTH / 2;
  private camY = WORLD.HEIGHT / 2;
  private zoom = 1;

  // Clock estimate between 20 Hz patches.
  private clockBase = 0;
  private clockBaseAt = 0;

  private lastFrameAt = 0;
  private lastHudAt = 0;
  private pingMs: number | null = null;
  private killFeed: Array<KillFeedEntry & { receivedAt: number }> = [];
  private killSeq = 0;

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

  async start(): Promise<void> {
    if (this.started || this.stopped) return;
    this.started = true;

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

    this.opts.mountEl.appendChild(app.canvas);
    app.canvas.style.display = "block";
    app.canvas.style.touchAction = "none";

    this.effects = new Effects();
    this.effectsSlot.addChild(this.effects.layer);
    this.floatSlot.addChild(this.effects.floatLayer);
    this.world.addChild(
      this.groundSlot,
      this.shadowSlot,
      this.extractLayer,
      this.chestLayer,
      this.itemLayer,
      this.obstacleSlot,
      this.wallSlot,
      this.playerLayer,
      this.effectsSlot,
      this.canopySlot,
      this.floatSlot,
    );
    app.stage.addChild(this.world, this.effects.vignette);

    this.input = new InputController(app.canvas, {
      interact: () => this.sendIntent(C2S.INTERACT, {}),
      reload: () => this.sendIntent(C2S.RELOAD, {}),
      selectSlot: (slot) => this.sendIntent(C2S.SWITCH, { slot }),
      toggleSlot: () => {
        const me = this.state?.players.get(this.selfId);
        if (me) this.sendIntent(C2S.SWITCH, { slot: me.active === 1 ? 0 : 1 });
      },
      heal: (kind) => this.sendIntent(C2S.HEAL, { kind }),
    });
    this.input.attach();

    this.attachMessages();
    this.attachState();

    this.sendPing();
    this.pingTimer = setInterval(() => this.sendPing(), PING_INTERVAL_MS);

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
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.input?.detach();
    this.input = null;

    for (const m of [this.players, this.chests, this.items, this.extracts] as Array<
      Map<string, Tracked<unknown, { destroy(): void }>>
    >) {
      for (const t of m.values()) t.view.destroy();
      m.clear();
    }
    this.worldView?.destroy();
    this.worldView = null;
    this.minimap?.destroy();
    this.minimap = null;
    this.effects?.destroy();
    this.effects = null;

    if (this.app) {
      this.app.ticker.remove(this.tick);
      this.app.destroy(true, { children: true });
      this.app = null;
    }
    if (this.tex) {
      destroyTextures(this.tex);
      this.tex = null;
    }
    this.map = null;
    this.idx = null;
  }

  private sendIntent(type: string, payload: object) {
    if (this.stopped) return;
    const me = this.state?.players.get(this.selfId);
    if (!me || !me.alive || me.extractedAt > 0) return;
    try {
      this.opts.room.send(type, payload);
    } catch {
      /* socket closing */
    }
  }

  private sendPing() {
    try {
      this.opts.room.send(C2S.PING, { t: performance.now() });
    } catch {
      /* socket closing */
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

    on<ShotMsg>(S2C.SHOT, (m) => this.onShot(m));
    on<HitMsg>(S2C.HIT, (m) => this.onHit(m));
    on<KillMsg>(S2C.KILL, (m) => this.onKill(m));
    on<ChestOpenedMsg>(S2C.CHEST, (m) => {
      const c = this.chests.get(m.id)?.state;
      if (!c || !this.effects) return;
      const color = RARITY_COLORS[c.rarity as 0 | 1 | 2 | 3] ?? RARITY_COLORS[0];
      const now = performance.now();
      this.effects.ring(c.x, c.y, color, 80, 450, now);
      this.effects.burst(c.x, c.y, color, 16, 320, now);
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
      chests: CollectionProxy<Chest>;
      items: CollectionProxy<GroundItem>;
      extracts: CollectionProxy<Extract>;
    };

    this.disposers.push(
      s$.players.onAdd((p, id) => this.addPlayer(id, p)),
      s$.players.onRemove((_p, id) => this.removeTracked(this.players, id)),
      s$.chests.onAdd((c, id) => this.addChest(id, c)),
      s$.chests.onRemove((_c, id) => this.removeTracked(this.chests, id)),
      s$.items.onAdd((it, id) => this.addItem(id, it)),
      s$.items.onRemove((_it, id) => this.removeTracked(this.items, id)),
      s$.extracts.onAdd((e, id) => this.addExtract(id, e)),
      s$.extracts.onRemove((_e, id) => this.removeTracked(this.extracts, id)),
    );

    const onPatch = () => this.onStatePatch();
    room.onStateChange(onPatch);
    this.disposers.push(() => room.onStateChange.remove(onPatch));
    // The first full state may already be decoded: take it as the first snapshot.
    this.onStatePatch();
  }

  private addPlayer(id: string, p: Player) {
    if (!this.tex) return;
    this.removeTracked(this.players, id);
    const view = new PlayerView(this.tex, id, id === this.selfId, p.nickname);
    view.buffer.push({ t: performance.now(), x: p.x, y: p.y, aim: p.aim });
    view.place(p.x, p.y, p.aim);
    this.playerLayer.addChild(view.root);
    this.players.set(id, { state: p, view });
    if (id === this.selfId) this.aim = p.aim;
  }

  private addChest(id: string, c: Chest) {
    if (!this.tex) return;
    this.removeTracked(this.chests, id);
    const view = new ChestView(this.tex, c.rarity);
    this.chestLayer.addChild(view.root);
    this.chests.set(id, { state: c, view });
  }

  private addItem(id: string, it: GroundItem) {
    if (!this.tex) return;
    this.removeTracked(this.items, id);
    const view = new ItemView(this.tex);
    view.sync(it);
    this.itemLayer.addChild(view.root);
    this.items.set(id, { state: it, view });
  }

  private addExtract(id: string, e: Extract) {
    this.removeTracked(this.extracts, id);
    const view = new ExtractView();
    this.extractLayer.addChild(view.root);
    this.extracts.set(id, { state: e, view });
  }

  private removeTracked<T, V extends { destroy(): void }>(m: Map<string, Tracked<T, V>>, id: string) {
    const t = m.get(id);
    if (!t) return;
    t.view.destroy();
    m.delete(id);
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

    const me = state.players.get(this.selfId);
    if (!me) return;
    if (!me.alive || me.extractedAt > 0 || !this.idx) {
      // Not controllable (or the map is not built yet): follow the server directly.
      this.predictor.reset(me.x, me.y);
      this.prevPredX = me.x;
      this.prevPredY = me.y;
      this.corrX = 0;
      this.corrY = 0;
      return;
    }
    if (!this.predictor.isInitialized) {
      this.predictor.reset(me.x, me.y);
      this.prevPredX = me.x;
      this.prevPredY = me.y;
      return;
    }
    const { dx, dy } = this.predictor.reconcile(me.x, me.y, me.lastSeq);
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

  private onShot(m: ShotMsg) {
    if (!this.effects || !Array.isArray(m.a) || !(m.w in WEAPONS)) return;
    const now = performance.now();
    let x = m.x;
    let y = m.y;
    const isSelf = m.s === this.selfId;
    if (isSelf && this.selfRender && m.a.length) {
      // Our own shots start at the gun we see (the predicted position), not where the
      // server had us one round trip ago.
      const a = m.a.reduce((s, v) => s + v, 0) / m.a.length;
      const muzzle = WEAPONS[m.w as WeaponId].muzzle;
      x = this.selfRender.x + Math.cos(a) * muzzle;
      y = this.selfRender.y + Math.sin(a) * muzzle;
    }
    this.effects.shot(this.idx, m.s, m.w, x, y, m.a, isSelf, now);
  }

  private onHit(m: HitMsg) {
    if (!this.effects) return;
    const now = performance.now();
    this.effects.hit(m.s, m.x, m.y, !!m.ar, now);
    if (m.t === this.selfId) {
      if (m.d > 0) this.effects.damageNumber(m.x, m.y, m.d, COLORS.damageTaken, now);
      this.effects.hurtFlash(m.d);
    } else if (m.s === this.selfId && m.d > 0) {
      this.effects.damageNumber(m.x, m.y, m.d, m.ar ? COLORS.hitArmor : COLORS.damageDealt, now);
    }
  }

  private onKill(m: KillMsg) {
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
    const v = this.players.get(m.victimId)?.view;
    if (v && this.effects) {
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
    this.zoom = Math.sqrt((w * h) / (VIEW_W * VIEW_H)) || 1;

    if (!this.worldView && state.mapSeed) this.buildMap(state.mapSeed);

    const clock = this.clockNow(now);
    const me = state.players.get(this.selfId) ?? null;
    const controllable = !!me && me.alive && me.extractedAt === 0 && state.phase !== "ended" && !!this.idx;

    // Fixed-rate input loop. Bursts are capped so a hidden tab does not dump a backlog.
    this.inputAcc = Math.min(this.inputAcc + dt, INPUT_DT_MS * 3);
    while (this.inputAcc >= INPUT_DT_MS) {
      this.inputAcc -= INPUT_DT_MS;
      if (controllable && me) this.sendInput(me, clock);
      else this.input?.sampleFire();
    }

    // Local player: predicted position, smoothed between input steps, plus decaying correction.
    if (me && controllable) {
      const k = this.inputAcc / INPUT_DT_MS;
      const decay = decayFactor(dt, CORRECTION_TAU_MS);
      this.corrX *= decay;
      this.corrY *= decay;
      if (Math.abs(this.corrX) < 0.05) this.corrX = 0;
      if (Math.abs(this.corrY) < 0.05) this.corrY = 0;
      const x = this.prevPredX + (this.predictor.x - this.prevPredX) * k + this.corrX;
      const y = this.prevPredY + (this.predictor.y - this.prevPredY) * k + this.corrY;
      this.selfRender = { x, y };
      this.updateAim(w, h);
    } else if (me && me.alive && me.extractedAt === 0) {
      // Map not built yet or the match is over: show the server position as is.
      this.selfRender = { x: me.x, y: me.y };
    }
    // After death / extraction selfRender keeps the last position: the camera stays there.

    if (this.selfRender) {
      this.camX = this.selfRender.x;
      this.camY = this.selfRender.y;
    }
    const shake = this.effects?.update(now, dt, w, h) ?? { x: 0, y: 0 };
    this.world.scale.set(this.zoom);
    this.world.position.set(w / 2 - this.camX * this.zoom + shake.x, h / 2 - this.camY * this.zoom + shake.y);

    const halfW = w / 2 / this.zoom + CULL_MARGIN;
    const halfH = h / 2 / this.zoom + CULL_MARGIN;
    const view: ViewRect = { x0: this.camX - halfW, y0: this.camY - halfH, x1: this.camX + halfW, y1: this.camY + halfH };
    const inView = (x: number, y: number) => x >= view.x0 && x <= view.x1 && y >= view.y0 && y <= view.y1;

    const selfOnMap = controllable ? this.selfRender : null;
    this.worldView?.update(view, selfOnMap);
    const selfBush = selfOnMap && this.worldView ? this.worldView.bushAt(selfOnMap.x, selfOnMap.y) : null;

    // Players
    const renderT = now - INTERP_DELAY_MS;
    for (const [id, { state: p, view: v }] of this.players) {
      const onMap = p.alive && p.extractedAt === 0;
      if (id === this.selfId) {
        const pos = this.selfRender ?? { x: p.x, y: p.y };
        v.place(pos.x, pos.y, controllable ? this.aim : p.aim);
      } else {
        const s = v.buffer.sample(renderT) ?? { x: p.x, y: p.y, aim: p.aim };
        v.place(s.x, s.y, s.aim);
      }
      v.root.visible = onMap && inView(v.x, v.y);
      if (!v.root.visible) continue;
      v.setColor(p.color);
      v.setNickname(p.nickname);
      v.setWeapon(p.slots.at(p.active)?.weapon ?? "");
      if (id !== this.selfId) {
        const armorMax = p.armor >= 1 && p.armor <= 3 ? ARMOR[p.armor as 1 | 2 | 3].durability : 0;
        v.setBars(p.hp, p.armor, p.armorDur, armorMax);
        const bush = this.worldView?.bushAt(v.x, v.y) ?? null;
        v.setLabelVisible(!bush || bush === selfBush);
      }
    }

    for (const { state: c, view: v } of this.chests.values()) {
      v.root.visible = inView(c.x, c.y);
      if (v.root.visible) v.update(c, now);
    }
    for (const { state: it, view: v } of this.items.values()) {
      v.root.visible = inView(it.x, it.y);
      if (!v.root.visible) continue;
      v.sync(it);
      v.update(it.x, it.y, now);
    }

    const extractInfo: Array<{ x: number; y: number; r: number; status: ReturnType<typeof extractStatus> }> = [];
    for (const [id, { state: e, view: v }] of this.extracts) {
      const status = extractStatus(e, clock);
      extractInfo.push({ x: e.x, y: e.y, r: e.r, status });
      v.root.visible = Math.abs(e.x - this.camX) < halfW + e.r && Math.abs(e.y - this.camY) < halfH + e.r;
      if (!v.root.visible) continue;
      let progress: number | null = null;
      if (me && controllable && me.extractStartedAt > 0) {
        const inside = this.selfRender && Math.hypot(this.selfRender.x - e.x, this.selfRender.y - e.y) <= e.r;
        if (me.extractId === id || (!me.extractId && inside)) {
          progress = (clock - me.extractStartedAt) / MATCH.EXTRACT_CHANNEL_MS;
        }
      }
      v.update(e.x, e.y, e.r, status, extractCaption(status, e, clock), progress, now);
    }

    if (this.minimap) {
      this.minimap.layout(w, h);
      this.minimap.update(
        extractInfo,
        this.selfRender && me?.alive && me.extractedAt === 0
          ? { x: this.selfRender.x, y: this.selfRender.y, aim: controllable ? this.aim : me.aim }
          : null,
        now,
      );
    }

    if (now - this.lastHudAt >= HUD_INTERVAL_MS) {
      this.lastHudAt = now;
      this.emitHud(state, clock, now);
    }
  };

  private buildMap(seed: number) {
    if (!this.tex || !this.app) return;
    const map = generateMap(seed);
    this.map = map;
    this.idx = getCollisionIndex(map);
    const wv = new WorldView(map, this.tex);
    this.worldView = wv;
    this.groundSlot.addChild(wv.ground);
    this.shadowSlot.addChild(wv.shadows);
    this.obstacleSlot.addChild(wv.obstacles);
    this.wallSlot.addChild(wv.walls);
    this.canopySlot.addChild(wv.canopy);
    this.minimap = new Minimap(map);
    this.app.stage.addChild(this.minimap.root);
    // Prediction was waiting for the collision index: start it from the server position.
    const me = this.state?.players.get(this.selfId);
    if (me) {
      this.predictor.reset(me.x, me.y);
      this.prevPredX = me.x;
      this.prevPredY = me.y;
    }
  }

  private sendInput(me: Player, clock: number) {
    const input = this.input;
    if (!input) return;
    const { mx, my } = input.movement();
    const fire = input.sampleFire();
    const seq = this.predictor.nextSeq();
    const sample: InputSample = { seq, mx, my, aim: this.aim, fire };
    try {
      this.opts.room.send(C2S.INPUT, sample);
    } catch {
      return;
    }
    const healing = me.healUntil > clock && me.healKind !== "";
    this.prevPredX = this.predictor.x;
    this.prevPredY = this.predictor.y;
    this.predictor.apply({ seq, mx, my, speedMult: healing ? PLAYER.HEAL_SPEED_MULT : 1 });
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
    const snapshot: HudSnapshot = buildHud({
      state,
      selfId: this.selfId,
      selfPos: this.selfRender,
      clockMs: clock,
      killFeed: this.killFeed.map(({ receivedAt: _r, ...e }) => e),
      pingMs: this.pingMs,
    });
    try {
      this.opts.onHud(snapshot);
    } catch (err) {
      console.error("[game] onHud failed", err);
    }
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
