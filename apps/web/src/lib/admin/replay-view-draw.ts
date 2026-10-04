import { PLAYER, WEAPONS, type MapData, type ReplaySpawn } from "@extract/shared";
import { drawMapBase, drawMapOverlay, label } from "./replay-view-map";
import { KIND_LABEL, playerCss, type Death, type EntView, type HitEvent, type ShotEvent, type Subject, type View } from "./replay-view";

/**
 * One frame of the admin replay canvas: the static map (replay-view-map.ts), corpses as crosses,
 * shot tracers and hit flashes of the last moments, then the runtimes — NPCs grey (asleep ones
 * dimmer), bosses red, humans in their palette colour with nickname and HP — and the selected
 * subject ringed while everyone else is dimmed. Markers keep a minimum screen size so the whole
 * 24 km map stays readable.
 */

export interface SceneInput {
  map: MapData;
  view: View;
  w: number;
  h: number;
  t: number;
  ents: readonly EntView[];
  /** Deaths up to t. */
  deaths: readonly Death[];
  /** Shots / hits of the last TRACER_MS / HIT_FLASH_MS. */
  shots: readonly ShotEvent[];
  hits: readonly HitEvent[];
  spawns: ReadonlyMap<number, ReplaySpawn>;
  subject: Subject | null;
  hover: number | null;
  /** Shown in the middle of the canvas (loading, gap, wipe), or null. */
  banner: string | null;
}

export const TRACER_MS = 160;
export const HIT_FLASH_MS = 220;

const NPC = "#a3a9b0";
const NPC_ASLEEP = "#5d636b";
const GUARD = "#c4c9cf";
const BOSS = "#ff3b3b";
/** Tracer length by weapon: the gun's real range (shared WEAPONS), 650 px for anything unknown. */
function shotRange(weapon: string): number {
  return (WEAPONS as Record<string, { range: number } | undefined>)[weapon]?.range ?? 650;
}

/** On-screen radius of a runtime: its world radius, never smaller than a readable dot. */
export function markerRadius(kind: EntView["kind"], scale: number): number {
  const world = PLAYER.RADIUS * scale;
  const min = kind === "human" ? 5 : kind === "boss" ? 6 : 3.2;
  return Math.max(min, kind === "boss" ? world * 1.15 : world);
}

function cross(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, color: string, width: number): void {
  ctx.lineCap = "round";
  ctx.strokeStyle = "rgba(8, 10, 14, 0.85)";
  ctx.lineWidth = width + 2.5;
  ctx.beginPath();
  ctx.moveTo(x - s, y - s);
  ctx.lineTo(x + s, y + s);
  ctx.moveTo(x + s, y - s);
  ctx.lineTo(x - s, y + s);
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

function kindColor(e: Pick<EntView, "kind" | "dormant">, spawn: ReplaySpawn | undefined): string {
  if (e.kind === "human") return playerCss(spawn?.color ?? 0);
  if (e.kind === "boss") return BOSS;
  if (e.kind === "guard") return e.dormant ? NPC_ASLEEP : GUARD;
  return e.dormant ? NPC_ASLEEP : NPC;
}

export function drawScene(ctx: CanvasRenderingContext2D, s: SceneInput): void {
  const { map, view: v, w, h, subject } = s;
  drawMapBase(ctx, map, v, w, h);
  drawMapOverlay(ctx, map, v, w, h);
  const sx = (x: number) => (x - v.cx) * v.scale + w / 2;
  const sy = (y: number) => (y - v.cy) * v.scale + h / 2;
  const focus = (r: number) => !subject || subject.rs.has(r);
  const pos = new Map<number, EntView>();
  for (const e of s.ents) pos.set(e.r, e);

  // Corpses.
  const cs = Math.max(3.5, PLAYER.RADIUS * 0.75 * v.scale);
  for (const d of s.deaths) {
    const sp = s.spawns.get(d.r);
    const kind = sp?.kind ?? "marauder";
    const x = sx(d.x);
    const y = sy(d.y);
    if (x < -20 || y < -20 || x > w + 20 || y > h + 20) continue;
    ctx.save();
    ctx.globalAlpha = focus(d.r) || (subject !== null && subject.rs.has(d.killer)) ? 1 : 0.35;
    cross(ctx, x, y, cs, kind === "human" ? playerCss(sp?.color ?? 0) : kind === "boss" ? BOSS : "#8b9097", kind === "human" ? 2.2 : 1.6);
    ctx.restore();
    if (kind !== "marauder" && kind !== "guard" && (v.scale >= 0.06 || (subject && subject.rs.has(d.r)))) {
      label(ctx, sp?.nickname || KIND_LABEL[kind], x, y + cs + 8, "rgba(255,255,255,0.7)", { size: 10, weight: 500, alpha: focus(d.r) ? 1 : 0.4 });
    }
  }

  // Tracers.
  ctx.save();
  ctx.lineCap = "round";
  for (const sh of s.shots) {
    const age = s.t - sh.t;
    if (age < 0 || age > TRACER_MS) continue;
    const shooter = s.spawns.get(sh.r);
    const len = shotRange(sh.weapon) * v.scale;
    const a = 1 - age / TRACER_MS;
    ctx.globalAlpha = (focus(sh.r) ? 0.9 : 0.3) * a;
    ctx.strokeStyle = shooter?.kind === "human" ? "#fff2a8" : shooter?.kind === "boss" ? "#ff7b7b" : "#ffb36b";
    ctx.lineWidth = 1.2;
    const x = sx(sh.x);
    const y = sy(sh.y);
    ctx.beginPath();
    for (const ang of sh.angles) {
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    }
    ctx.stroke();
  }
  ctx.restore();

  // Runtimes: NPCs under bosses under humans; the subject last.
  const order = [...s.ents].sort((a, b) => rank(a, subject) - rank(b, subject));
  const now = s.t;
  const flashed = new Set<number>();
  for (const hit of s.hits) if (now - hit.t >= 0 && now - hit.t <= HIT_FLASH_MS) flashed.add(hit.target);
  for (const e of order) {
    const sp = s.spawns.get(e.r);
    const x = sx(e.x);
    const y = sy(e.y);
    const r = markerRadius(e.kind, v.scale);
    if (x < -60 || y < -40 || x > w + 60 || y > h + 40) continue;
    const color = kindColor(e, sp);
    const dim = !focus(e.r);
    ctx.save();
    ctx.globalAlpha = dim ? (e.kind === "human" ? 0.45 : 0.3) : 1;
    // Aim.
    if (e.kind === "human" || e.kind === "boss" || v.scale >= 0.12) {
      const len = r + Math.max(6, 34 * v.scale);
      ctx.strokeStyle = e.kind === "human" ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.45)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(e.aim) * r * 0.6, y + Math.sin(e.aim) * r * 0.6);
      ctx.lineTo(x + Math.cos(e.aim) * len, y + Math.sin(e.aim) * len);
      ctx.stroke();
    }
    // Body (a disconnected human: hollow, dashed).
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    if (e.kind === "human" && !e.connected) {
      ctx.fillStyle = "rgba(10, 12, 16, 0.6)";
      ctx.fill();
      ctx.setLineDash([3, 2]);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = "rgba(8, 10, 14, 0.9)";
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
    if (e.extracting) {
      ctx.strokeStyle = "#3ee07a";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, r + 3.5, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (flashed.has(e.r)) {
      ctx.strokeStyle = "#ff4d4d";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(x, y, r + 2.5, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (subject && subject.rs.has(e.r)) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, r + 7, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();

    // Labels: humans and bosses always, NPCs close up; HP bar under humans and bosses.
    const named = e.kind === "human" || e.kind === "boss" || v.scale >= 0.35 || e.r === s.hover;
    if (named) {
      const name = sp?.nickname || `${KIND_LABEL[e.kind]} #${e.r}`;
      const text = e.kind === "human" && sp?.level ? `${name} · ${sp.level}` : name;
      label(ctx, text, x, y - r - 9, e.kind === "human" ? color : e.kind === "boss" ? "#ff8a8a" : "#d5d9de", {
        size: e.kind === "human" ? 12 : 11,
        weight: e.kind === "human" ? 700 : 600,
        alpha: dim ? 0.45 : 1,
      });
    }
    if (e.kind === "human" || e.kind === "boss" || v.scale >= 0.35) {
      const bw = Math.max(18, r * 2.2);
      const by = y + r + 4;
      ctx.save();
      ctx.globalAlpha = dim ? 0.4 : 1;
      ctx.fillStyle = "rgba(8, 10, 14, 0.85)";
      ctx.fillRect(x - bw / 2 - 1, by - 1, bw + 2, 5);
      ctx.fillStyle = e.hp > 0.5 ? "#51cf66" : e.hp > 0.25 ? "#fab005" : "#ff6b6b";
      ctx.fillRect(x - bw / 2, by, bw * Math.max(0, Math.min(1, e.hp)), 3);
      ctx.restore();
    }
  }

  // Hover card.
  if (s.hover !== null) {
    const e = pos.get(s.hover);
    if (e) {
      const sp = s.spawns.get(e.r);
      const bits = [
        sp?.nickname || `${KIND_LABEL[e.kind]} #${e.r}`,
        KIND_LABEL[e.kind] + (sp?.guest ? " · гость" : ""),
        `HP ${Math.round(e.hp * 100)}%`,
        e.kind === "human" ? (e.connected ? "онлайн" : "без связи") : e.dormant ? "спит" : "",
      ].filter(Boolean);
      const x = sx(e.x) + markerRadius(e.kind, v.scale) + 10;
      const y = sy(e.y);
      ctx.save();
      ctx.font = "600 12px ui-sans-serif, system-ui, -apple-system, sans-serif";
      const tw = Math.max(...bits.map((b) => ctx.measureText(b).width));
      const bx = Math.min(w - tw - 18, x);
      const byTop = Math.max(4, Math.min(h - bits.length * 16 - 12, y - 10));
      ctx.fillStyle = "rgba(12, 15, 22, 0.92)";
      ctx.strokeStyle = "rgba(255,255,255,0.18)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(bx, byTop, tw + 16, bits.length * 16 + 8, 6);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#e8ebef";
      ctx.textBaseline = "top";
      bits.forEach((b, i) => {
        ctx.globalAlpha = i === 0 ? 1 : 0.7;
        ctx.fillText(b, bx + 8, byTop + 5 + i * 16);
      });
      ctx.restore();
    }
  }

  if (s.banner) {
    ctx.save();
    ctx.font = "700 14px ui-sans-serif, system-ui, -apple-system, sans-serif";
    const tw = ctx.measureText(s.banner).width;
    ctx.fillStyle = "rgba(12, 15, 22, 0.85)";
    ctx.beginPath();
    ctx.roundRect(w / 2 - tw / 2 - 14, 14, tw + 28, 30, 8);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(s.banner, w / 2, 29);
    ctx.restore();
  }
}

function rank(e: EntView, subject: Subject | null): number {
  if (subject?.rs.has(e.r)) return 4;
  return e.kind === "human" ? 3 : e.kind === "boss" ? 2 : e.kind === "guard" ? 1 : 0;
}
