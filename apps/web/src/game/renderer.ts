import {
  Application,
  Container,
  Graphics,
  Text,
  TextStyle,
  Ticker,
} from "pixi.js";
import { getStateCallbacks, type Room } from "colyseus.js";
import type { HudSnapshot } from "@/components/battle-screen";
import { formatMassUnitsAsUsd } from "@/lib/format-money";

interface PlayerView {
  container: Container;
  bodyG: Graphics;
  headG: Graphics;
  label: Text;
  lineColor: number;
  /** Avoid re-rasterizing Text every frame when mass/nick unchanged. */
  lastLabelKey: string;
  prevX: number;
  prevY: number;
  curX: number;
  curY: number;
  bodyPoints: { px: number; py: number; cx: number; cy: number }[];
}

interface OrbView {
  g: Graphics;
  px: number;
  py: number;
}

interface Opts {
  mountEl: HTMLElement;
  room: Room;
  selfUserId: string;
  onHud: (snap: HudSnapshot) => void;
}

const COLOR_PALETTE = [
  0x9945ff, 0x14f195, 0xff6b6b, 0x4dd0e1, 0xffeb3b, 0xff9800, 0xab47bc,
  0x66bb6a, 0x42a5f5, 0xec407a, 0xffa726, 0x26a69a, 0x7e57c2, 0xd4e157,
  0x29b6f6,
];

function colorFor(sessionId: string): number {
  let h = 0;
  for (let i = 0; i < sessionId.length; i++) h = (h * 31 + sessionId.charCodeAt(i)) | 0;
  return COLOR_PALETTE[Math.abs(h) % COLOR_PALETTE.length]!;
}

/** ~30 Hz — enough for HUD/timer; avoids React reconciling at display refresh rate. */
const HUD_EMIT_INTERVAL_MS = 33;

const ZONE_EPS = 0.25;

/** Fewer segments in the stroke path; long snakes dominate GPU. */
function bodyDrawStep(segmentCount: number): number {
  if (segmentCount > 200) return 4;
  if (segmentCount > 120) return 3;
  if (segmentCount > 60) return 2;
  return 1;
}

export class GameRenderer {
  private app = new Application();
  private world = new Container();
  private orbsLayer = new Container();
  private snakesLayer = new Container();
  private zoneG = new Graphics();
  private gridG = new Graphics();
  private players = new Map<string, PlayerView>();
  private orbs = new Map<string, OrbView>();
  private mounted = false;
  private mouse = { x: 0, y: 0 };
  private boost = false;
  /** Track LMB on game only so HUD clicks do not start boost. */
  private onPointerDownBound = (e: PointerEvent) => this.onPointer(e, true);
  private onPointerUpBound = (e: PointerEvent) => this.onPointer(e, false);
  private onWinBlurBound = () => {
    this.boost = false;
  };
  private inputTickAt = 0;
  private selfSessionId: string | null = null;
  private camera = { x: 0, y: 0 };
  /** Skip redundant zone Graphics clears when state hasn't changed (same between ~20 Hz patches). */
  private zoneSnap = { cx: NaN, cy: NaN, r: NaN };
  private lastHudEmitAt = 0;
  /** Colyseus may fire onChange very often; sync body→view once per frame max. */
  private pendingPlayerSync = new Map<string, any>();
  private playerSyncRaf: number | null = null;
  private resizeBound = () => this.onResize();
  private mouseBound = (e: MouseEvent) => {
    this.mouse.x = e.clientX;
    this.mouse.y = e.clientY;
  };
  private keyDownBound = (e: KeyboardEvent) => this.onKey(e);
  private tickerBound = (t: Ticker) => this.tick(t);

  constructor(private opts: Opts) {}

  async start() {
    const dpr = window.devicePixelRatio || 1;
    await this.app.init({
      background: 0x08070b,
      resizeTo: this.opts.mountEl,
      antialias: false,
      autoDensity: true,
      powerPreference: "high-performance",
      preference: "webgl",
      /** 1× — fewer shaded pixels; main win on Retina. */
      resolution: Math.min(1, dpr),
    });
    this.opts.mountEl.appendChild(this.app.canvas);
    this.app.ticker.maxFPS = 60;
    this.app.stage.addChild(this.world);
    this.world.addChild(this.gridG);
    this.world.addChild(this.zoneG);
    this.world.addChild(this.orbsLayer);
    this.world.addChild(this.snakesLayer);
    this.mounted = true;
    this.drawGrid();
    window.addEventListener("resize", this.resizeBound);
    window.addEventListener("mousemove", this.mouseBound, { passive: true });
    window.addEventListener("keydown", this.keyDownBound);
    // LMB boost only on the game canvas (HUD/leaderboard sit above; no accidental boost on UI)
    this.app.canvas.addEventListener("pointerdown", this.onPointerDownBound);
    window.addEventListener("pointerup", this.onPointerUpBound);
    window.addEventListener("pointercancel", this.onPointerUpBound);
    window.addEventListener("blur", this.onWinBlurBound);
    this.app.ticker.add(this.tickerBound);

    const room = this.opts.room;
    const $ = getStateCallbacks(room);

    room.onMessage("joined", (msg: any) => {
      this.selfSessionId = msg.sessionId ?? room.sessionId;
    });
    this.selfSessionId = room.sessionId;

    $(room.state).players.onAdd((player: any, sessionId: string) => {
      this.addOrUpdatePlayer(sessionId, player, true);
      $(player).onChange(() => {
        this.pendingPlayerSync.set(sessionId, player);
        this.schedulePlayerSyncFlush();
      });
    });
    $(room.state).players.onRemove((_: any, sessionId: string) => {
      const v = this.players.get(sessionId);
      if (v) {
        this.snakesLayer.removeChild(v.container);
        this.players.delete(sessionId);
      }
    });
    $(room.state).orbs.onAdd((orb: any, id: string) => {
      this.addOrb(id, orb);
    });
    $(room.state).orbs.onRemove((_: any, id: string) => {
      const v = this.orbs.get(id);
      if (v) {
        this.orbsLayer.removeChild(v.g);
        this.orbs.delete(id);
      }
    });
  }

  private schedulePlayerSyncFlush() {
    if (this.playerSyncRaf !== null) return;
    this.playerSyncRaf = requestAnimationFrame(() => {
      this.playerSyncRaf = null;
      for (const [sessionId, player] of this.pendingPlayerSync) {
        this.addOrUpdatePlayer(sessionId, player, false);
      }
      this.pendingPlayerSync.clear();
    });
  }

  stop() {
    if (!this.mounted) return;
    this.mounted = false;
    if (this.playerSyncRaf !== null) {
      cancelAnimationFrame(this.playerSyncRaf);
      this.playerSyncRaf = null;
    }
    this.pendingPlayerSync.clear();
    window.removeEventListener("resize", this.resizeBound);
    window.removeEventListener("mousemove", this.mouseBound as EventListener);
    window.removeEventListener("keydown", this.keyDownBound);
    this.app.canvas.removeEventListener("pointerdown", this.onPointerDownBound);
    window.removeEventListener("pointerup", this.onPointerUpBound);
    window.removeEventListener("pointercancel", this.onPointerUpBound);
    window.removeEventListener("blur", this.onWinBlurBound);
    this.app.ticker.remove(this.tickerBound);
    this.app.destroy(true, { children: true });
  }

  private onResize() {
    if (!this.mounted) return;
    this.app.renderer.resize(
      this.opts.mountEl.clientWidth,
      this.opts.mountEl.clientHeight,
    );
  }

  private onPointer(e: PointerEvent, down: boolean) {
    if (e.button !== 0) return;
    this.boost = down;
  }

  private onKey(e: KeyboardEvent) {
    if (e.code === "KeyE" && !e.repeat) {
      this.opts.room.send("extract");
    }
  }

  private drawGrid() {
    this.gridG.clear();
    const size = 200;
    const range = 3000;
    this.gridG.setStrokeStyle({ width: 1, color: 0x1f1d2b, alpha: 0.5 });
    for (let x = -range; x <= range; x += size) {
      this.gridG.moveTo(x, -range);
      this.gridG.lineTo(x, range);
    }
    for (let y = -range; y <= range; y += size) {
      this.gridG.moveTo(-range, y);
      this.gridG.lineTo(range, y);
    }
    this.gridG.stroke();
  }

  private addOrUpdatePlayer(sessionId: string, player: any, isNew: boolean) {
    let view = this.players.get(sessionId);
    if (!view) {
      const container = new Container();
      const bodyG = new Graphics();
      const headG = new Graphics();
      const label = new Text({
        text: "",
        style: new TextStyle({
          fontSize: 12,
          fill: 0xffffff,
          fontFamily: "JetBrains Mono, ui-monospace, monospace",
          align: "center",
          stroke: { color: 0x000000, width: 3 },
        }),
      });
      label.anchor.set(0.5, 1);
      container.addChild(bodyG);
      container.addChild(headG);
      container.addChild(label);
      this.snakesLayer.addChild(container);
      view = {
        container,
        bodyG,
        headG,
        label,
        lineColor: colorFor(sessionId),
        lastLabelKey: "",
        prevX: player.headX,
        prevY: player.headY,
        curX: player.headX,
        curY: player.headY,
        bodyPoints: [],
      };
      this.players.set(sessionId, view);
    }
    view.prevX = view.curX;
    view.prevY = view.curY;
    view.curX = player.headX;
    view.curY = player.headY;
    const segLen = player.body.length;
    while (view.bodyPoints.length < segLen) {
      const i = view.bodyPoints.length;
      const seg = player.body[i];
      // New segments must spawn at the server tail, not the head — avoids a visible snap to the end.
      const x = seg?.x ?? view.bodyPoints[i - 1]?.cx ?? player.headX;
      const y = seg?.y ?? view.bodyPoints[i - 1]?.cy ?? player.headY;
      view.bodyPoints.push({ px: x, py: y, cx: x, cy: y });
    }
    while (view.bodyPoints.length > segLen) view.bodyPoints.pop();
    for (let i = 0; i < segLen; i++) {
      const seg = player.body[i];
      const bp = view.bodyPoints[i]!;
      // Only update network targets; px/py keep interpolating in tick (no per-frame snap).
      bp.cx = seg.x;
      bp.cy = seg.y;
    }
    if (!player.alive) {
      view.container.alpha = 0.15;
    } else {
      view.container.alpha = 1;
    }
    void isNew;
  }

  private addOrb(id: string, orb: any) {
    const g = new Graphics();
    const tier = orb.tier ?? 0;
    const color = tier === 1 ? 0x14f195 : 0xb07bff;
    const size = tier === 1 ? 6 : 4;
    g.circle(0, 0, size).fill({ color });
    const ox = orb.x;
    const oy = orb.y;
    g.position.set(ox, oy);
    this.orbsLayer.addChild(g);
    this.orbs.set(id, { g, px: ox, py: oy });
  }

  /** Frame-rate–independent smoothing (matches old ~0.35 / ~0.15 per 60Hz frame at 60fps). */
  private blendToward(t: Ticker, per60HzFrame: number): number {
    const frames = t.deltaMS / (1000 / 60);
    return 1 - Math.pow(1 - per60HzFrame, frames);
  }

  /** If Colyseus session id and map key ever diverge, recover self via roster userId so HUD/mass sync. */
  private syncSelfSessionFromState(state: any) {
    const uid = this.opts.selfUserId;
    if (!uid) return;
    const cur = this.selfSessionId
      ? state.players.get(this.selfSessionId)
      : undefined;
    if (cur?.userId === uid) return;
    state.players.forEach((p: any, sessionId: string) => {
      if (p.userId === uid && !p.isBot) {
        this.selfSessionId = sessionId;
      }
    });
  }

  private tick(t: Ticker) {
    if (!this.mounted) return;
    const state: any = this.opts.room.state;
    if (!state) return;
    this.syncSelfSessionFromState(state);
    const w = this.app.screen.width;
    const h = this.app.screen.height;
    const margin = 450;
    const camX = this.camera.x;
    const camY = this.camera.y;
    const fx0 = camX - w / 2 - margin;
    const fx1 = camX + w / 2 + margin;
    const fy0 = camY - h / 2 - margin;
    const fy1 = camY + h / 2 + margin;

    // Softer = less jaggy; body slightly slower than head so the rope reads fluid.
    const headBlend = this.blendToward(t, 0.26);
    const segBlend = this.blendToward(t, 0.17);
    const camBlend = this.blendToward(t, 0.15);
    const orbBlend = this.blendToward(t, 0.32);
    for (const [sid, view] of this.players) {
      const player = state.players.get(sid);
      if (!player) continue;
      const x = view.prevX + (view.curX - view.prevX) * headBlend;
      const y = view.prevY + (view.curY - view.prevY) * headBlend;
      view.prevX = x;
      view.prevY = y;

      const r = player.radius;
      const color = view.lineColor;
      const pts = view.bodyPoints;
      const n = pts.length;
      for (let i = 0; i < n; i++) {
        const bp = pts[i]!;
        bp.px = bp.px + (bp.cx - bp.px) * segBlend;
        bp.py = bp.py + (bp.cy - bp.py) * segBlend;
      }

      if (x < fx0 || x > fx1 || y < fy0 || y > fy1) {
        view.container.visible = false;
        continue;
      }
      view.container.visible = true;

      const step = bodyDrawStep(n);
      view.bodyG.clear();
      view.bodyG.setStrokeStyle({ width: r * 1.6, color, alpha: 0.85, cap: "round", join: "round" });
      view.bodyG.moveTo(x, y);
      for (let i = 0; i < n; i += step) {
        const bp = pts[i]!;
        view.bodyG.lineTo(bp.px, bp.py);
      }
      if (n > 0 && (n - 1) % step !== 0) {
        const bp = pts[n - 1]!;
        view.bodyG.lineTo(bp.px, bp.py);
      }
      view.bodyG.stroke();

      view.headG.clear();
      view.headG.circle(x, y, r).fill({ color });
      view.headG.circle(x, y, r * 0.55).fill({ color: 0xffffff, alpha: 0.85 });
      const labelKey = `${player.nickname}\0${player.massUnits}\0${player.alive}`;
      if (view.lastLabelKey !== labelKey) {
        view.lastLabelKey = labelKey;
        const usd = formatMassUnitsAsUsd(player.massUnits);
        view.label.text = `${player.nickname}\n${usd}`;
      }
      view.label.position.set(x, y - r - 4);
    }

    for (const [id, v] of this.orbs) {
      const orb = state.orbs.get(id);
      if (!orb) continue;
      v.px = v.px + (orb.x - v.px) * orbBlend;
      v.py = v.py + (orb.y - v.py) * orbBlend;
      v.g.position.set(v.px, v.py);
      v.g.visible = v.px >= fx0 && v.px <= fx1 && v.py >= fy0 && v.py <= fy1;
    }

    if (state.zone?.radius != null && state.zone.radius > 0) {
      const zx = state.zone.cx;
      const zy = state.zone.cy;
      const zr = state.zone.radius;
      if (
        !Number.isFinite(this.zoneSnap.r) ||
        Math.abs(zx - this.zoneSnap.cx) > ZONE_EPS ||
        Math.abs(zy - this.zoneSnap.cy) > ZONE_EPS ||
        Math.abs(zr - this.zoneSnap.r) > ZONE_EPS
      ) {
        this.zoneSnap = { cx: zx, cy: zy, r: zr };
        this.zoneG.clear();
        this.zoneG.setStrokeStyle({ width: 6, color: 0xff5060, alpha: 0.7 });
        this.zoneG.circle(zx, zy, zr).stroke();
        this.zoneG.setStrokeStyle({ width: 2, color: 0xff5060, alpha: 0.25 });
        this.zoneG.circle(zx, zy, zr + 8).stroke();
      }
    } else if (Number.isFinite(this.zoneSnap.r)) {
      this.zoneSnap = { cx: NaN, cy: NaN, r: NaN };
      this.zoneG.clear();
    }

    // camera follow self
    const self = this.selfSessionId ? this.players.get(this.selfSessionId) : null;
    let cx = 0,
      cy = 0;
    if (self) {
      cx = self.prevX;
      cy = self.prevY;
    }
    this.camera.x += (cx - this.camera.x) * camBlend;
    this.camera.y += (cy - this.camera.y) * camBlend;
    this.world.position.set(w / 2 - this.camera.x, h / 2 - this.camera.y);

    const now = performance.now();
    // Send input ~30Hz. Aim from the visible head, not the screen center:
    // camera smoothing means those differ, which is very noticeable near the head.
    if (now - this.inputTickAt > 33 && self) {
      this.inputTickAt = now;
      const headScreenX = self.prevX + w / 2 - this.camera.x;
      const headScreenY = self.prevY + h / 2 - this.camera.y;
      const angle = Math.atan2(this.mouse.y - headScreenY, this.mouse.x - headScreenX);
      this.opts.room.send("input", { angle, boost: this.boost });
    }

    if (now - this.lastHudEmitAt < HUD_EMIT_INTERVAL_MS) return;
    this.lastHudEmitAt = now;

    const selfPlayer = this.selfSessionId
      ? state.players.get(this.selfSessionId)
      : null;
    const lb: HudSnapshot["leaderboard"] = [];
    state.players.forEach((p: any) => {
      lb.push({
        nickname: p.nickname,
        mass: p.massUnits,
        alive: p.alive,
      });
    });
    lb.sort((a, b) => Number(BigInt(b.mass) - BigInt(a.mass)));
    this.opts.onHud({
      phase: state.phase ?? "lockin",
      clockMs: state.clockMs ?? 0,
      selfMassUnits: selfPlayer?.massUnits ?? "0",
      selfAlive: selfPlayer?.alive ?? false,
      selfDiedAt: selfPlayer?.diedAt ?? 0,
      selfExtractStartedAt: selfPlayer?.extractStartedAt ?? 0,
      selfExtractedAt: selfPlayer?.extractedAt ?? 0,
      selfExitOrder: selfPlayer?.exitOrder ?? 0,
      zoneRadius: state.zone?.radius ?? 0,
      leaderboard: lb,
    });
  }
}
