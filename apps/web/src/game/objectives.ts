/**
 * In-raid objectives on the client (GameSystem; server: game-server sim/objectives.ts, rules:
 * @extract/shared objectives.ts + map/locks.ts):
 * - locked rooms: steel gates over the room's door gaps and bars over its windows (worldFx layer),
 *   a padlock and "Needs: <key>" tag near a locked gate, the gate swung open once unlocked;
 * - the collision flags of those gates in the shared map index (getCollisionIndex, the predictor
 *   moves against it): on while BattleState.lockState lists the locks, a gate off once it is open
 *   publicly or this client was told so (ObjMsg "unlocked");
 * - crack safes: a dial mark over each untouched one nearby;
 * - channel progress (unlock / crack) over the target, from the server's ObjMsg start / stop;
 * - toasts: "Requires …", room unlocked, safe cracked, hidden cache found;
 * - feeds worldEventsView.clues (the local player's own clue notes → fuzzy circles on the full map)
 *   and .locks (padlocks on the full map).
 * Every position drawn here is public layout, the local player's own inventory, or a personal
 * server notice: nothing reveals a hidden cache or another player.
 */

import { Assets, Container, Graphics, Sprite, Text, Texture } from "pixi.js";
import {
  CONTAINER_STATE,
  CRACK,
  LOCK,
  LOCK_STATE,
  crackSafes,
  decodeClueRef,
  gateCentre,
  getCollisionIndex,
  isClueNote,
  itemDef,
  lockedRooms,
  setGateOpen,
  setLocksEnabled,
  type EventsMsg,
  type LockedRoom,
  type MapData,
  type ObjMsg,
} from "@extract/shared";
import { AudioEngine } from "./audio/engine";
import type { GameContext, GameSystem } from "./systems";
import { EventToast, eventToastY, type ToastMsg } from "./world-events";
import { CLUE_COLOR, LOCK_COLOR, worldEventsView, type ClueMark, type LockMark } from "./world-events-marks";

const FONT = "ui-rounded, 'Trebuchet MS', system-ui, sans-serif";
/** Gate tags show within this distance of the local player (world px). */
const TAG_PX = 320;
const STEEL = 0x3b4148;
const STEEL_HI = 0x8a949e;

/** Toast of an objective notice (null = silent). Pure (tests). */
export function objToast(msg: ObjMsg, map: MapData): ToastMsg | null {
  const lock = lockedRooms(map)[msg.i];
  switch (msg.e) {
    case "locked":
      return lock ? { title: "LOCKED", sub: `Requires: ${itemDef(lock.key)?.name ?? "a key"}`, color: LOCK_COLOR } : null;
    case "unlocked":
      return lock ? { title: "ROOM UNLOCKED", sub: `${lock.zoneName} · strongroom open`, color: LOCK_COLOR } : null;
    case "cracked":
      return { title: "SAFE CRACKED", sub: "+objective", color: 0xffd27a };
    case "found":
      return { title: "HIDDEN CACHE FOUND", sub: "Search it before someone else does", color: CLUE_COLOR };
    default:
      return null;
  }
}

/** The local player's clue circles from their own inventory (one per cache number). Pure (tests). */
export function cluesOf(items: Iterable<{ def: string; ref?: string; label?: string }>): ClueMark[] {
  const out: ClueMark[] = [];
  for (const it of items) {
    if (!isClueNote(it)) continue;
    const c = decodeClueRef(it.ref ?? "");
    if (!c || out.some((o) => o.n === c.n)) continue;
    out.push({ n: c.n, x: c.x, y: c.y, r: c.r, text: it.label ?? "Cache" });
  }
  return out;
}

interface Channel {
  kind: "unlock" | "crack";
  i: number;
  start: number;
  until: number;
}

class ObjectivesSystem implements GameSystem {
  readonly id = "objectives";
  private built = false;
  private disposed = false;
  private mapRef: MapData | null = null;
  private locks: readonly LockedRoom[] = [];
  private crack: ReadonlySet<number> = new Set();
  private readonly gfx = new Graphics();
  private readonly top = new Container();
  private readonly topGfx = new Graphics();
  private readonly tags: Array<{ root: Container; icon: Sprite; text: Text }> = [];
  private readonly toast = new EventToast();
  /** Locks this client knows are open before the public flag (ObjMsg "unlocked"). */
  private readonly knownOpen = new Set<number>();
  /** Gate state applied to the shared index (null = never applied). */
  private applied: boolean[] = [];
  private enabled: boolean | null = null;
  private readonly cracked = new Set<number>();
  private channel: Channel | null = null;
  private nextTickAt = 0;
  private keyTex: Record<number, Texture> = {};
  private eng: AudioEngine | null = null;

  init(ctx: GameContext) {
    try {
      this.eng = AudioEngine.get();
    } catch {
      this.eng = null;
    }
    for (const t of [2, 3, 4]) {
      void Assets.load<Texture>(`/sprites/key_t${t}.png`).then((tex) => {
        if (!this.disposed) this.keyTex[t] = tex;
      }).catch(() => undefined);
    }
    this.top.addChild(this.topGfx);
    this.top.eventMode = "none";
    // worldFx (above building floors and walls, under canopies): the gates sit in wall gaps.
    ctx.layers.worldFx.addChild(this.gfx);
    ctx.layers.worldTop.addChild(this.top);
    ctx.layers.screen.addChild(this.toast.root);
    const cam = ctx.camera();
    this.resize(cam.width, cam.height);
    this.built = true;
  }

  resize(w: number, h: number) {
    this.toast.layout(w, h);
    // Under the world-event toast slot.
    this.toast.root.y = eventToastY(h) + (h < 480 ? 56 : 78);
  }

  onEvents(ev: EventsMsg, ctx: GameContext) {
    const map = ctx.map();
    if (!ev.obj?.length || !map) return;
    const clock = ctx.clockMs();
    for (const msg of ev.obj) {
      if (msg.e === "unlock" || msg.e === "crack") {
        const dur = msg.e === "unlock" ? LOCK.UNLOCK_MS : CRACK.MS;
        const until = msg.at ?? clock + dur;
        this.channel = { kind: msg.e, i: msg.i, start: until - dur, until };
        this.nextTickAt = 0;
      } else if (msg.e === "stop") {
        this.channel = null;
      } else if (msg.e === "unlocked") {
        this.knownOpen.add(msg.i);
        if (this.channel?.kind === "unlock" && this.channel.i === msg.i) this.channel = null;
        this.eng?.play("rack", { bus: "ui" });
      } else if (msg.e === "cracked") {
        this.cracked.add(msg.i);
        if (this.channel?.kind === "crack") this.channel = null;
        this.eng?.play("rack", { bus: "ui" });
      } else if (msg.e === "locked") {
        this.eng?.play("dry_fire", { bus: "ui" });
      }
      const t = objToast(msg, map);
      if (t) this.toast.push(t);
    }
  }

  frame(_dtMs: number, ctx: GameContext) {
    if (!this.built || this.disposed) return;
    const state = ctx.state();
    const map = ctx.map();
    if (!state || !map) return;
    if (map !== this.mapRef) this.reset(map);
    const now = performance.now();
    const clock = ctx.clockMs();
    const on = this.locks.length > 0 && (state.lockState?.length ?? 0) === this.locks.length;
    this.syncFlags(map, on, state.lockState);
    const v = worldEventsView;
    v.locks = on ? this.locks.map((l): LockMark => ({ ...gateCentre(l), open: this.isOpen(l.id, state.lockState) })) : [];
    const self = ctx.self();
    v.clues = self ? cluesOf(self.slots.values()) : [];
    this.draw(ctx, map, on, state.containerState, state.lockState, clock);
    // Own crack: a soft local tick each second (the loud one is what others hear).
    if (this.channel?.kind === "crack" && clock < this.channel.until && now >= this.nextTickAt) {
      this.nextTickAt = now + CRACK.TICK_MS;
      this.eng?.play("dry_fire", { bus: "ui", gain: 0.35 });
    }
    if (this.channel && clock > this.channel.until + 1500) this.channel = null;
    this.toast.frame(now);
  }

  private reset(map: MapData) {
    if (this.mapRef && this.enabled) setLocksEnabled(getCollisionIndex(this.mapRef), this.mapRef, false);
    this.mapRef = map;
    this.locks = lockedRooms(map);
    this.crack = crackSafes(map);
    this.knownOpen.clear();
    this.cracked.clear();
    this.applied = [];
    this.enabled = null;
    this.channel = null;
  }

  private isOpen(id: number, lockState: ArrayLike<number> | undefined): boolean {
    return (lockState?.[id] ?? LOCK_STATE.LOCKED) === LOCK_STATE.OPEN || this.knownOpen.has(id);
  }

  /** Gate flags in the shared index (the predictor's): all on with objectives, an open gate off. */
  private syncFlags(map: MapData, on: boolean, lockState: ArrayLike<number> | undefined) {
    const idx = getCollisionIndex(map);
    if (on !== this.enabled) {
      setLocksEnabled(idx, map, on);
      this.enabled = on;
      this.applied = this.locks.map(() => false);
    }
    if (!on) return;
    for (const l of this.locks) {
      const open = this.isOpen(l.id, lockState);
      if (this.applied[l.id] === open) continue;
      setGateOpen(idx, map, l.id, open);
      this.applied[l.id] = open;
    }
  }

  private draw(ctx: GameContext, map: MapData, on: boolean, containerState: ArrayLike<number>, lockState: ArrayLike<number> | undefined, clock: number) {
    const g = this.gfx;
    const t = this.topGfx;
    g.clear();
    t.clear();
    for (const tag of this.tags) tag.root.visible = false;
    if (!on) return;
    const cam = ctx.camera();
    const halfW = cam.width / (2 * cam.zoom) + 300;
    const halfH = cam.height / (2 * cam.zoom) + 300;
    const near = (x: number, y: number) => Math.abs(x - cam.x) < halfW && Math.abs(y - cam.y) < halfH;
    const me = ctx.selfPos();
    const self = ctx.self();
    const carries = (def: string) => {
      if (!self) return false;
      for (const it of self.slots.values()) if (it.def === def) return true;
      return false;
    };
    let tagN = 0;
    for (const l of this.locks) {
      const open = this.isOpen(l.id, lockState);
      for (const w of l.bars) if (near(w.x, w.y)) drawBars(g, w);
      for (const d of l.doors) {
        if (!near(d.x, d.y)) continue;
        if (open) drawOpenGate(g, d);
        else drawGate(g, d);
      }
      // No tag while this lock's channel bar is up (the bar takes its place).
      if (open || (this.channel?.kind === "unlock" && this.channel.i === l.id && clock < this.channel.until)) continue;
      const c = gateCentre(l);
      if ((c.x - me.x) ** 2 + (c.y - me.y) ** 2 > TAG_PX * TAG_PX) continue;
      const has = carries(l.key);
      const name = itemDef(l.key)?.name ?? "key";
      this.tag(tagN++, c.x, c.y - 70, has ? `F — unlock · ${name}` : `Needs: ${name}`, has ? 0x9dffa8 : LOCK_COLOR, l.tier);
    }
    // Crack safes: a dial over each untouched, uncracked one nearby.
    for (const i of this.crack) {
      const s = map.containers[i];
      if (!s || !near(s.x, s.y) || this.cracked.has(i) || (containerState[i] ?? 0) !== CONTAINER_STATE.UNTOUCHED) continue;
      drawDial(t, s.x, s.y - 44, clock);
    }
    // Channel progress over the target.
    const ch = this.channel;
    if (ch && clock < ch.until) {
      const p = Math.max(0, Math.min(1, (clock - ch.start) / Math.max(1, ch.until - ch.start)));
      const at = ch.kind === "unlock" ? (this.locks[ch.i] ? gateCentre(this.locks[ch.i]!) : null) : map.containers[ch.i] ?? null;
      if (at) {
        const w = 120, x = at.x - w / 2, y = at.y - 92;
        t.roundRect(x - 3, y - 3, w + 6, 16, 6).fill({ color: 0x0c0c0c, alpha: 0.75 });
        t.roundRect(x, y, w * p, 10, 4).fill({ color: ch.kind === "crack" ? 0xffd27a : 0x9dffa8 });
        this.tag(tagN++, at.x, y - 8, ch.kind === "crack" ? "CRACKING — hold still" : "UNLOCKING", ch.kind === "crack" ? 0xffd27a : 0x9dffa8, 0);
      }
    }
  }

  /** A world-space tag (key icon + text), anchored bottom-centre at (x, y). */
  private tag(i: number, x: number, y: number, text: string, color: number, tier: number) {
    while (this.tags.length <= i) {
      const root = new Container();
      const icon = new Sprite(Texture.EMPTY);
      icon.anchor.set(1, 1);
      icon.width = icon.height = 30;
      const t = new Text({ text: "", style: { fontFamily: FONT, fontSize: 18, fontWeight: "900", fill: 0xffffff, stroke: { color: 0x0b0b0b, width: 5 } } });
      t.anchor.set(0, 1);
      root.addChild(icon, t);
      this.top.addChild(root);
      this.tags.push({ root, icon, text: t });
    }
    const tag = this.tags[i]!;
    tag.root.visible = true;
    if (tag.text.text !== text) tag.text.text = text;
    tag.text.style.fill = color;
    const tex = tier ? this.keyTex[tier] : undefined;
    tag.icon.visible = !!tex;
    if (tex && tag.icon.texture !== tex) {
      tag.icon.texture = tex;
      tag.icon.width = tag.icon.height = 30;
    }
    const w = tag.text.width + (tex ? 34 : 0);
    tag.root.position.set(x - w / 2 + (tex ? 34 : 0), y);
    tag.icon.position.set(-4, 2);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.mapRef && this.enabled) setLocksEnabled(getCollisionIndex(this.mapRef), this.mapRef, false);
    this.gfx.destroy();
    this.top.destroy({ children: true });
    this.toast.root.destroy({ children: true });
    worldEventsView.clues = [];
    worldEventsView.locks = [];
  }
}

type R = { x: number; y: number; w: number; h: number };

/** A closed steel gate across a door gap: frame, bars, a padlock in the middle. */
function drawGate(g: Graphics, d: R) {
  const vert = d.h > d.w;
  g.rect(d.x, d.y, d.w, d.h).fill({ color: STEEL, alpha: 0.55 });
  const len = vert ? d.h : d.w;
  const n = Math.max(4, Math.round(len / 18));
  for (let k = 1; k < n; k++) {
    const a = (k / n) * len;
    if (vert) g.rect(d.x + 2, d.y + a - 2, d.w - 4, 4);
    else g.rect(d.x + a - 2, d.y + 2, 4, d.h - 4);
  }
  g.fill({ color: STEEL_HI });
  g.rect(d.x, d.y, d.w, d.h).stroke({ width: 3, color: 0x15181b });
  const cx = d.x + d.w / 2, cy = d.y + d.h / 2;
  g.moveTo(cx - 7, cy - 4).arc(cx, cy - 4, 7, Math.PI, 0).stroke({ width: 4, color: 0x2a2a2a });
  g.roundRect(cx - 11, cy - 5, 22, 18, 4).fill({ color: LOCK_COLOR }).stroke({ width: 2.5, color: 0x1a1406 });
  g.circle(cx, cy + 3, 2.5).fill({ color: 0x1a1406 });
}

/** An unlocked gate swung back along the wall from its hinge end. */
function drawOpenGate(g: Graphics, d: R) {
  const vert = d.h > d.w;
  if (vert) g.rect(d.x - 2, d.y - 6, d.w + 4, 10).fill({ color: STEEL_HI }).stroke({ width: 2, color: 0x15181b });
  else g.rect(d.x - 6, d.y - 2, 10, d.h + 4).fill({ color: STEEL_HI }).stroke({ width: 2, color: 0x15181b });
}

/** Bars across a window gap. */
function drawBars(g: Graphics, w: R) {
  const vert = w.h > w.w;
  const len = vert ? w.h : w.w;
  const n = Math.max(3, Math.round(len / 22));
  for (let k = 1; k < n; k++) {
    const a = (k / n) * len;
    if (vert) g.rect(w.x, w.y + a - 2, w.w, 4);
    else g.rect(w.x + a - 2, w.y, 4, w.h);
  }
  g.fill({ color: STEEL });
}

/** A safe dial (crack target): ring, ticks and a slowly turning pointer. */
function drawDial(g: Graphics, x: number, y: number, clock: number) {
  g.circle(x, y, 15).fill({ color: 0x1b1d20, alpha: 0.85 }).stroke({ width: 3, color: 0xffd27a });
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    g.moveTo(x + Math.cos(a) * 9, y + Math.sin(a) * 9).lineTo(x + Math.cos(a) * 13, y + Math.sin(a) * 13);
  }
  g.stroke({ width: 2, color: 0xffd27a });
  const a = (clock / 900) % (Math.PI * 2);
  g.moveTo(x, y).lineTo(x + Math.cos(a) * 10, y + Math.sin(a) * 10).stroke({ width: 3, color: 0xffffff });
}

export function createObjectivesSystem(): GameSystem {
  return new ObjectivesSystem();
}
