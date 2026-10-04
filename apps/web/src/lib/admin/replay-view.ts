import {
  REPLAY,
  REPLAY_FLAG,
  REPLAY_KINDS,
  WEAPONS,
  type ReplayBossState,
  type ReplayChunkData,
  type ReplayEvent,
  type ReplayKind,
  type ReplaySpawn,
  type KillWeapon,
} from "@extract/shared";

/**
 * Admin replay viewer, the pure part (components/admin/replay-viewer.tsx draws with it; tests in
 * replay-view.test.ts). A decoded chunk (@extract/shared decodeReplayChunk) is packed into typed
 * columns (FrameStore: one row per runtime per 200 ms frame), the notable events of every loaded
 * chunk are merged into one ReplayModel, and the viewer asks for:
 *   - the chunk and frame at a cycle-clock time (binary search), the runtimes at that time with
 *     positions and aim interpolated between two frames (entsAt),
 *   - the events of one subject (a player's runtimes, or one NPC) and of the chosen categories,
 *   - camera math (fit, zoom around the cursor, clamp), playback clock, and which chunk range to
 *     fetch next (planFetch: the playhead first, then the rest so the events list fills in).
 * No DOM, no fetch: everything here runs under node:test.
 */

// ------------------------------------------------------------------------------- frames

/** A chunk index row (lib/admin/replay.ts AdminReplayChunkInfo, structurally). */
export interface ChunkMeta {
  seq: number;
  startMs: number;
  endMs: number;
  bytes: number;
  final?: boolean;
}

export type ShotEvent = Extract<ReplayEvent, { type: "shot" }>;
export type HitEvent = Extract<ReplayEvent, { type: "hit" }>;

/** Bits 5–6 of a row's flags byte hold the kind index (as on the wire). */
const KIND_SHIFT = 5;
const KIND_MASK = 0b11;

/**
 * One decoded chunk packed into columns: frame i owns rows off[i] .. off[i+1] − 1, sorted by roster
 * index. flags = REPLAY_FLAG bits | kind index << 5. Shots and hits (drawn, never listed) stay here
 * in time order; the notable events go to ReplayModel.
 */
export interface FrameStore {
  seq: number;
  startMs: number;
  endMs: number;
  final: boolean;
  t: Float64Array;
  off: Int32Array;
  r: Uint16Array;
  x: Float32Array;
  y: Float32Array;
  /** u8 aim (2π/256). */
  aim: Uint8Array;
  /** Share of maxHp × 255. */
  hp: Uint8Array;
  flags: Uint8Array;
  act: Uint8Array;
  shots: ShotEvent[];
  hits: HitEvent[];
  /** Rows in all frames (memory gauge). */
  rows: number;
}

export function compactChunk(c: ReplayChunkData): FrameStore {
  let rows = 0;
  for (const f of c.frames) rows += f.ents.length;
  const s: FrameStore = {
    seq: c.seq,
    startMs: c.startMs,
    endMs: c.endMs,
    final: c.final,
    t: new Float64Array(c.frames.length),
    off: new Int32Array(c.frames.length + 1),
    r: new Uint16Array(rows),
    x: new Float32Array(rows),
    y: new Float32Array(rows),
    aim: new Uint8Array(rows),
    hp: new Uint8Array(rows),
    flags: new Uint8Array(rows),
    act: new Uint8Array(rows),
    shots: [],
    hits: [],
    rows,
  };
  let j = 0;
  c.frames.forEach((f, i) => {
    s.t[i] = f.t;
    s.off[i] = j;
    for (const e of f.ents) {
      s.r[j] = e.r;
      s.x[j] = e.x;
      s.y[j] = e.y;
      s.aim[j] = Math.round((e.aim * 256) / (Math.PI * 2)) & 0xff;
      s.hp[j] = e.hp;
      s.flags[j] =
        (e.alive ? REPLAY_FLAG.ALIVE : 0) |
        (e.extracted ? REPLAY_FLAG.EXTRACTED : 0) |
        (e.connected ? REPLAY_FLAG.CONNECTED : 0) |
        (e.dormant ? REPLAY_FLAG.DORMANT : 0) |
        (e.extracting ? REPLAY_FLAG.EXTRACTING : 0) |
        ((Math.max(0, REPLAY_KINDS.indexOf(e.kind)) & KIND_MASK) << KIND_SHIFT);
      s.act[j] = e.act;
      j++;
    }
  });
  s.off[c.frames.length] = j;
  for (const e of c.events) {
    if (e.type === "shot") s.shots.push(e);
    else if (e.type === "hit") s.hits.push(e);
  }
  return s;
}

/** Largest i with a[i] ≤ t (−1 when t is before a[0]). `a` ascending. */
export function lastAtOrBefore(a: ArrayLike<number>, t: number): number {
  let lo = 0;
  let hi = a.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid]! <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** The frame of `s` shown at time t (the last one at or before t), −1 before its first frame. */
export function frameAt(s: Pick<FrameStore, "t">, t: number): number {
  return lastAtOrBefore(s.t, t);
}

/**
 * Position in `index` (sorted by startMs) of the chunk that covers t: startMs ≤ t < endMs, the last
 * chunk also at t = endMs. −1 in a gap (a dropped chunk), before the first or after the last.
 */
export function chunkPos(index: readonly Pick<ChunkMeta, "startMs" | "endMs">[], t: number): number {
  let lo = 0;
  let hi = index.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (index[mid]!.startMs <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (ans < 0) return -1;
  const c = index[ans]!;
  if (t < c.endMs || (ans === index.length - 1 && t === c.endMs)) return ans;
  return -1;
}

/** Cycle-clock ranges no stored chunk covers between the first chunk start and `end` (dropped chunks, a crashed tail). */
export function timelineGaps(index: readonly Pick<ChunkMeta, "startMs" | "endMs">[], end: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 1; i < index.length; i++) {
    const a = index[i - 1]!.endMs;
    const b = index[i]!.startMs;
    if (b > a) out.push([a, b]);
  }
  const last = index.at(-1);
  if (last && end > last.endMs) out.push([last.endMs, end]);
  return out;
}

/** One runtime at a time t (positions interpolated). */
export interface EntView {
  r: number;
  kind: ReplayKind;
  x: number;
  y: number;
  /** Radians. */
  aim: number;
  /** HP share 0..1. */
  hp: number;
  connected: boolean;
  dormant: boolean;
  extracting: boolean;
  act: number;
}

/** Two frames further apart than this are not interpolated (a dropped chunk between them). */
export const MAX_LERP_GAP_MS = REPLAY.FRAME_MS * 2 + 50;
/** A move longer than this between two frames is a teleport (spawn fix-up, respawn): snap, no glide. */
export const SNAP_PX = 400;

const TAU = Math.PI * 2;

/** a → b by k along the shorter arc, in [0, 2π). */
export function lerpAngle(a: number, b: number, k: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  else if (d < -Math.PI) d += TAU;
  const v = (a + d * k) % TAU;
  return v < 0 ? v + TAU : v;
}

export const kindOf = (flags: number): ReplayKind => REPLAY_KINDS[(flags >> KIND_SHIFT) & KIND_MASK]!;
const isOnMap = (flags: number): boolean => (flags & REPLAY_FLAG.ALIVE) !== 0 && (flags & REPLAY_FLAG.EXTRACTED) === 0;

/**
 * The runtimes on the map at t: frame A = the last frame at or before t in `cur`, frame B = the next
 * one (in `cur`, or the first frame of `next` when that chunk is loaded and follows within
 * MAX_LERP_GAP_MS). Rows on the map in A glide toward B (aim along the shorter arc); a runtime that
 * leaves in B (its leave row) or is missing there holds A's row, a jump over SNAP_PX holds too. Leave
 * rows (died / extracted) are not on the map: ReplayModel.leaves draws them. HP is A's.
 */
export function entsAt(cur: FrameStore, next: FrameStore | null, t: number): EntView[] {
  const i = frameAt(cur, t);
  if (i < 0) return [];
  const aFrom = cur.off[i]!;
  const aTo = cur.off[i + 1]!;
  let bs: FrameStore | null = null;
  let bi = -1;
  if (i + 1 < cur.t.length) {
    bs = cur;
    bi = i + 1;
  } else if (next && next.t.length > 0 && next.t[0]! > cur.t[i]! && next.t[0]! - cur.t[i]! <= MAX_LERP_GAP_MS) {
    bs = next;
    bi = 0;
  }
  const tA = cur.t[i]!;
  let k = 0;
  if (bs && bi >= 0) {
    const tB = bs.t[bi]!;
    k = tB > tA ? Math.max(0, Math.min(1, (t - tA) / (tB - tA))) : 0;
  }
  const out: EntView[] = [];
  let j = bs ? bs.off[bi]! : 0;
  const jTo = bs ? bs.off[bi + 1]! : 0;
  for (let a = aFrom; a < aTo; a++) {
    const f = cur.flags[a]!;
    if (!isOnMap(f)) continue;
    const r = cur.r[a]!;
    let x = cur.x[a]!;
    let y = cur.y[a]!;
    let aim = (cur.aim[a]! * TAU) / 256;
    if (bs && k > 0) {
      while (j < jTo && bs.r[j]! < r) j++;
      if (j < jTo && bs.r[j]! === r && isOnMap(bs.flags[j]!)) {
        const bx = bs.x[j]!;
        const by = bs.y[j]!;
        const dx = bx - x;
        const dy = by - y;
        if (dx * dx + dy * dy <= SNAP_PX * SNAP_PX) {
          x += dx * k;
          y += dy * k;
          aim = lerpAngle(aim, (bs.aim[j]! * TAU) / 256, k);
        }
      }
    }
    out.push({
      r,
      kind: kindOf(f),
      x,
      y,
      aim,
      hp: cur.hp[a]! / 255,
      connected: (f & REPLAY_FLAG.CONNECTED) !== 0,
      dormant: (f & REPLAY_FLAG.DORMANT) !== 0,
      extracting: (f & REPLAY_FLAG.EXTRACTING) !== 0,
      act: cur.act[a]!,
    });
  }
  return out;
}

/** Events of a time-sorted list with t in (from, to]. */
export function eventsBetween<E extends { t: number }>(list: readonly E[], from: number, to: number): E[] {
  if (list.length === 0 || to <= from) return [];
  // First event with t > from (binary search), then walk while t ≤ to.
  let lo = 0;
  let hi = list.length - 1;
  let first = list.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]!.t > from) {
      first = mid;
      hi = mid - 1;
    } else lo = mid + 1;
  }
  const out: E[] = [];
  for (let i = first; i < list.length && list[i]!.t <= to; i++) out.push(list[i]!);
  return out;
}

// ------------------------------------------------------------------------------- model

/** A runtime leaving the map (its leave row): died, extracted, MIA at the wipe. */
export interface Leave {
  r: number;
  t: number;
  x: number;
  y: number;
  extracted: boolean;
}

/** A killed runtime's leave row (drawn as a cross from t on); killer −1 = none. */
export interface Death extends Leave {
  killer: number;
}

/** Events listed in the side panel (shots and hits are only drawn). */
export type NotableEvent = Exclude<ReplayEvent, { type: "shot" } | { type: "hit" }>;

export type EventCat = "kill" | "exit" | "spawn" | "boss" | "loot" | "wipe";
export const EVENT_CATS: readonly EventCat[] = ["kill", "exit", "spawn", "boss", "loot", "wipe"];

/** A human's run on this shard: one runtime (a player who dies and enters again has two). */
export interface PlayerRun {
  r: number;
  spawnT: number | null;
  leaveT: number | null;
  leave: "dead" | "extract" | "mia" | "timeout" | null;
}

/** A human on this shard-cycle, keyed by userId (guests without one by their roster index). */
export interface PlayerInfo {
  key: string;
  name: string;
  color: number;
  level: number;
  guest: boolean;
  partyId: string;
  runs: PlayerRun[];
}

/** Filter subject: one player's runtimes (key "u:<userId>") or one runtime (key "r:<r>"). */
export interface Subject {
  key: string;
  rs: ReadonlySet<number>;
}

export const subjectKeyOf = (s: Pick<ReplaySpawn, "r" | "kind" | "userId">): string =>
  s.kind === "human" && s.userId ? `u:${s.userId}` : `r:${s.r}`;

/**
 * Everything the loaded chunks say about who was there and what happened, merged in seq order
 * whatever order the chunks arrive in. `version` changes on every add (React memo key).
 */
export class ReplayModel {
  readonly spawns = new Map<number, ReplaySpawn>();
  readonly spawnT = new Map<number, number>();
  private readonly bySeq = new Map<number, { events: NotableEvent[]; leaves: Leave[] }>();
  private cache: { version: number; events: NotableEvent[]; leaves: Leave[]; deaths: Death[] } | null = null;
  version = 0;

  has(seq: number): boolean {
    return this.bySeq.has(seq);
  }

  add(c: ReplayChunkData): void {
    if (this.bySeq.has(c.seq)) return;
    for (const s of c.roster) if (!this.spawns.has(s.r)) this.spawns.set(s.r, s);
    const events: NotableEvent[] = [];
    for (const e of c.events) {
      if (e.type === "shot" || e.type === "hit") continue;
      if (e.type === "spawn") {
        this.spawns.set(e.spawn.r, e.spawn);
        this.spawnT.set(e.spawn.r, e.t);
      }
      events.push(e);
    }
    const leaves: Leave[] = [];
    for (const f of c.frames) {
      for (const e of f.ents) if (!e.alive || e.extracted) leaves.push({ r: e.r, t: f.t, x: e.x, y: e.y, extracted: e.extracted });
    }
    this.bySeq.set(c.seq, { events, leaves });
    this.version++;
  }

  private merged(): { events: NotableEvent[]; leaves: Leave[]; deaths: Death[] } {
    if (this.cache?.version === this.version) return this.cache;
    const seqs = [...this.bySeq.keys()].sort((a, b) => a - b);
    const events: NotableEvent[] = [];
    const leaves: Leave[] = [];
    for (const s of seqs) {
      const v = this.bySeq.get(s)!;
      events.push(...v.events);
      leaves.push(...v.leaves);
    }
    // Chunks are contiguous in seq order, so this is already time-sorted; the stable sort is a guard.
    events.sort((a, b) => a.t - b.t);
    leaves.sort((a, b) => a.t - b.t);
    // A leave row is a death only with a kill: the wipe takes everyone off the map (MIA), extracts are no corpse.
    const killers = new Map<number, number>();
    for (const e of events) if (e.type === "kill") killers.set(e.victim, e.killer);
    const deaths: Death[] = [];
    for (const l of leaves) {
      const killer = killers.get(l.r);
      if (!l.extracted && killer !== undefined) deaths.push({ ...l, killer });
    }
    this.cache = { version: this.version, events, leaves, deaths };
    return this.cache;
  }

  /** Notable events of every loaded chunk, time-sorted. */
  get events(): NotableEvent[] {
    return this.merged().events;
  }

  /** Leave rows of every loaded chunk, time-sorted (a runtime leaves once). */
  get leaves(): Leave[] {
    return this.merged().leaves;
  }

  /** Leave rows of killed runtimes (the corpses), time-sorted. */
  get deaths(): Death[] {
    return this.merged().deaths;
  }

  /** Cycle clock of the wipe, if a loaded chunk has it. */
  get wipeAt(): number | null {
    const w = this.events.find((e) => e.type === "wipe");
    return w ? w.t : null;
  }

  name(r: number): string {
    return spawnName(this.spawns.get(r), r);
  }

  /** Humans seen so far, by first spawn. */
  players(): PlayerInfo[] {
    const byKey = new Map<string, PlayerInfo>();
    const exits = new Map<number, { t: number; exit: string }>();
    for (const e of this.events) if (e.type === "exit") exits.set(e.r, { t: e.t, exit: e.exit });
    const leaveT = new Map<number, Leave>();
    for (const l of this.leaves) leaveT.set(l.r, l);
    const humans = [...this.spawns.values()].filter((s) => s.kind === "human").sort((a, b) => a.r - b.r);
    for (const s of humans) {
      const key = subjectKeyOf(s);
      let p = byKey.get(key);
      if (!p) {
        p = { key, name: spawnName(s, s.r), color: s.color, level: s.level, guest: s.guest, partyId: s.partyId, runs: [] };
        byKey.set(key, p);
      }
      const ex = exits.get(s.r);
      const lv = leaveT.get(s.r);
      const leave = ex ? (ex.exit as PlayerRun["leave"]) : lv ? (lv.extracted ? "extract" : "dead") : null;
      p.runs.push({ r: s.r, spawnT: this.spawnT.get(s.r) ?? null, leaveT: ex?.t ?? lv?.t ?? null, leave });
      // The latest run's identity wins (level, colour and party can change between entries).
      p.name = spawnName(s, s.r);
      p.color = s.color;
      p.level = s.level;
      p.partyId = s.partyId;
    }
    return [...byKey.values()];
  }

  /** The subject of a filter key ("u:<userId>" → every runtime of that user, "r:<r>" → that runtime). */
  subject(key: string): Subject | null {
    if (key.startsWith("r:")) {
      const r = Number(key.slice(2));
      return Number.isInteger(r) && r >= 0 ? { key, rs: new Set([r]) } : null;
    }
    if (key.startsWith("u:")) {
      const rs = new Set<number>();
      for (const s of this.spawns.values()) if (subjectKeyOf(s) === key) rs.add(s.r);
      return { key, rs };
    }
    return null;
  }
}

export const KIND_LABEL: Record<ReplayKind, string> = {
  human: "Игрок",
  boss: "Босс",
  guard: "Охранник",
  marauder: "Мародёр",
};

function spawnName(s: ReplaySpawn | undefined, r: number): string {
  if (s?.nickname) return s.nickname;
  return `${KIND_LABEL[s?.kind ?? "marauder"]} #${r}`;
}

// ------------------------------------------------------------------------------- filters

/** The panel category of an event, or null when it is never listed (an exit by death: the kill says it). */
export function eventCat(e: NotableEvent): EventCat | null {
  switch (e.type) {
    case "kill":
      return "kill";
    case "exit":
      return e.exit === "dead" ? null : "exit";
    case "spawn":
      return e.spawn.kind === "human" ? "spawn" : null;
    case "boss":
      return "boss";
    case "chest":
    case "loot":
      return "loot";
    case "wipe":
      return "wipe";
  }
}

/** Does the event concern one of these runtimes? (The wipe concerns everyone.) */
export function eventInvolves(e: ReplayEvent, rs: ReadonlySet<number>): boolean {
  switch (e.type) {
    case "spawn":
      return rs.has(e.spawn.r);
    case "kill":
      return rs.has(e.victim) || rs.has(e.killer);
    case "hit":
      return rs.has(e.src) || rs.has(e.target);
    case "loot":
      return rs.has(e.r) || (e.target === "corpse" && rs.has(e.id));
    case "wipe":
      return true;
    default:
      return rs.has(e.r);
  }
}

/**
 * Events for the side panel and the timeline ticks: the chosen categories, and with a subject only
 * that subject's events. Loot (containers opened, searches) is listed only for a subject: on the
 * whole map it would bury the kills.
 */
export function visibleEvents(events: readonly NotableEvent[], subject: Subject | null, cats: ReadonlySet<EventCat>): NotableEvent[] {
  const out: NotableEvent[] = [];
  for (const e of events) {
    const c = eventCat(e);
    if (!c || !cats.has(c)) continue;
    if (c === "loot" && !subject) continue;
    if (subject && !eventInvolves(e, subject.rs)) continue;
    out.push(e);
  }
  return out;
}

export const BOSS_STATE_LABEL: Record<ReplayBossState, string> = {
  idle: "спокоен",
  suspicious: "насторожился",
  combat: "в бою",
  search: "ищет цель",
  return: "возвращается на пост",
  cover: "в укрытии",
};

const weaponName = (w: KillWeapon | ""): string => (w === "grenade" ? "граната" : w ? (WEAPONS[w]?.name ?? w) : "");

/** One line of the events list. `names(r)` = ReplayModel.name; `extractName(id)` = the map's extract name. */
export function describeEvent(e: NotableEvent, names: (r: number) => string, extractName: (id: string) => string = (id) => id): string {
  switch (e.type) {
    case "spawn": {
      const s = e.spawn;
      const bits = [s.level > 0 ? `ур. ${s.level}` : "", s.guest ? "гость" : "", s.partyId ? "в пати" : ""].filter(Boolean);
      return `${names(s.r)} вошёл на карту${bits.length ? ` · ${bits.join(", ")}` : ""}`;
    }
    case "kill": {
      const w = weaponName(e.weapon);
      return e.killer >= 0 ? `${names(e.killer)} убил ${names(e.victim)}${w ? ` · ${w}` : ""}` : `${names(e.victim)} погиб`;
    }
    case "exit":
      if (e.exit === "extract") return `${names(e.r)} вышел через эвакуацию${e.extractId ? ` · ${extractName(e.extractId)}` : ""}`;
      if (e.exit === "mia") return `${names(e.r)} пропал без вести (MIA)`;
      if (e.exit === "timeout") return `${names(e.r)}: время вышло`;
      return `${names(e.r)} погиб`;
    case "chest":
      return `${names(e.r)} открыл контейнер #${e.idx}`;
    case "loot":
      return e.target === "corpse" ? `${names(e.r)} обыскивает тело: ${names(e.id)}` : `${names(e.r)} обыскивает контейнер #${e.id}`;
    case "boss":
      return `${names(e.r)}: ${BOSS_STATE_LABEL[e.state]}`;
    case "wipe":
      return "Вайп: карта закрылась";
  }
}

/** Where the camera looks for an event (null = no position: spawn / boss / wipe without a known row). */
export function eventFocus(e: NotableEvent, leaves: readonly Leave[]): { x: number; y: number } | null {
  if (e.type === "kill" || e.type === "exit") {
    const r = e.type === "kill" ? e.victim : e.r;
    const l = leaves.find((x) => x.r === r && x.t >= e.t - REPLAY.FRAME_MS && x.t <= e.t + MAX_LERP_GAP_MS);
    return l ? { x: l.x, y: l.y } : null;
  }
  return null;
}

/** Where a subject is at t: its runtime on the map, else where it last left the map, else null. */
export function subjectPos(subject: Subject, ents: readonly EntView[], leaves: readonly Leave[], t: number): { x: number; y: number; onMap: boolean } | null {
  let best: EntView | null = null;
  for (const e of ents) if (subject.rs.has(e.r) && (!best || e.r > best.r)) best = e;
  if (best) return { x: best.x, y: best.y, onMap: true };
  let last: Leave | null = null;
  for (const l of leaves) {
    if (l.t > t) break;
    if (subject.rs.has(l.r)) last = l;
  }
  return last ? { x: last.x, y: last.y, onMap: false } : null;
}

export type PlayerStatus =
  | { kind: "before" }
  | { kind: "on"; since: number | null }
  | { kind: "left"; how: NonNullable<PlayerRun["leave"]>; at: number };

/** A player's state at t: not entered yet, on the map, or how and when they last left. */
export function playerStatus(p: PlayerInfo, t: number): PlayerStatus {
  let cur: PlayerRun | null = null;
  for (const run of p.runs) {
    const from = run.spawnT ?? -Infinity;
    if (from <= t && (!cur || from >= (cur.spawnT ?? -Infinity))) cur = run;
  }
  if (!cur) return { kind: "before" };
  if (cur.leaveT !== null && cur.leaveT <= t && cur.leave) return { kind: "left", how: cur.leave, at: cur.leaveT };
  return { kind: "on", since: cur.spawnT };
}

// ------------------------------------------------------------------------------- camera

/** World point at the canvas centre and screen px per world px. */
export interface View {
  cx: number;
  cy: number;
  scale: number;
}

export const MAX_SCALE = 2;

/** Scale that fits a map of mapW × mapH into a w × h canvas (with a small margin). */
export function fitScale(mapW: number, mapH: number, w: number, h: number): number {
  return Math.max(1e-4, Math.min(w / mapW, h / mapH) * 0.96);
}

export function fitView(mapW: number, mapH: number, w: number, h: number): View {
  return { cx: mapW / 2, cy: mapH / 2, scale: fitScale(mapW, mapH, w, h) };
}

export function worldToScreen(v: View, w: number, h: number, x: number, y: number): { x: number; y: number } {
  return { x: (x - v.cx) * v.scale + w / 2, y: (y - v.cy) * v.scale + h / 2 };
}

export function screenToWorld(v: View, w: number, h: number, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - w / 2) / v.scale + v.cx, y: (sy - h / 2) / v.scale + v.cy };
}

/** Keeps the centre on the map and the scale between "whole map" and MAX_SCALE. */
export function clampView(v: View, mapW: number, mapH: number, w: number, h: number): View {
  const scale = Math.max(fitScale(mapW, mapH, w, h), Math.min(MAX_SCALE, v.scale));
  return { cx: Math.max(0, Math.min(mapW, v.cx)), cy: Math.max(0, Math.min(mapH, v.cy)), scale };
}

/** Zoom by `factor` keeping the world point under (sx, sy) where it is on screen. */
export function zoomAt(v: View, w: number, h: number, sx: number, sy: number, factor: number, mapW: number, mapH: number): View {
  const p = screenToWorld(v, w, h, sx, sy);
  const z = clampView({ ...v, scale: v.scale * factor }, mapW, mapH, w, h);
  return clampView({ cx: p.x - (sx - w / 2) / z.scale, cy: p.y - (sy - h / 2) / z.scale, scale: z.scale }, mapW, mapH, w, h);
}

/** The runtime drawn nearest to a screen point within maxPx (click / hover), or null. */
export function pickEntity<E extends { x: number; y: number }>(ents: readonly E[], v: View, w: number, h: number, sx: number, sy: number, maxPx = 14): E | null {
  let best: E | null = null;
  let bestD = maxPx * maxPx;
  for (const e of ents) {
    const p = worldToScreen(v, w, h, e.x, e.y);
    const d = (p.x - sx) ** 2 + (p.y - sy) ** 2;
    if (d <= bestD) {
      best = e;
      bestD = d;
    }
  }
  return best;
}

// ------------------------------------------------------------------------------- playback

export const SPEEDS = [1, 4, 16] as const;
export type Speed = (typeof SPEEDS)[number];
/** A longer real-time step (a background tab, a debugger pause) is cut to this. */
export const MAX_STEP_MS = 250;

/** The clock after `realDtMs` of playback at `speed`, stopped at `end`. */
export function advanceClock(t: number, realDtMs: number, speed: number, end: number): { t: number; ended: boolean } {
  const dt = Math.max(0, Math.min(MAX_STEP_MS, realDtMs)) * speed;
  const next = t + dt;
  return next >= end ? { t: end, ended: true } : { t: next, ended: false };
}

// ------------------------------------------------------------------------------- fetching

export interface FetchPlan {
  from: number;
  to: number;
  seqs: number[];
}

/**
 * The next chunk range to fetch (GET …/chunks?from&to), or null when nothing is left. `skip(seq)` is
 * true for chunks loaded, in flight or failed. First the chunk under the playhead and the `ahead`
 * ones after it (playback needs them now), then the rest forward from the playhead and wrapping
 * to the start (the events list wants every chunk). A batch is up to `batch` chunks in a row of
 * the index and at most `maxBytes` compressed (always at least one chunk).
 */
export function planFetch(
  index: readonly ChunkMeta[],
  skip: (seq: number) => boolean,
  t: number,
  o: { ahead?: number; batch?: number; maxBytes?: number } = {},
): FetchPlan | null {
  const ahead = o.ahead ?? 1;
  const batch = Math.max(1, o.batch ?? 4);
  const maxBytes = o.maxBytes ?? 1_500_000;
  if (index.length === 0) return null;
  let pos = chunkPos(index, t);
  if (pos < 0) {
    pos = index.findIndex((c) => c.startMs > t);
    if (pos < 0) pos = index.length - 1;
  }
  const take = (start: number, limit: number): FetchPlan => {
    const seqs: number[] = [];
    let bytes = 0;
    for (let i = start; i < index.length && seqs.length < limit; i++) {
      const c = index[i]!;
      if (skip(c.seq)) break;
      if (seqs.length > 0 && bytes + c.bytes > maxBytes) break;
      seqs.push(c.seq);
      bytes += c.bytes;
    }
    return { from: seqs[0]!, to: seqs.at(-1)!, seqs };
  };
  for (let i = pos; i <= Math.min(index.length - 1, pos + ahead); i++) {
    if (!skip(index[i]!.seq)) return take(i, Math.min(batch, pos + ahead - i + 1));
  }
  for (let n = 1; n < index.length; n++) {
    const i = (pos + n) % index.length;
    if (!skip(index[i]!.seq)) return take(i, i < pos ? Math.min(batch, pos - i) : batch);
  }
  return null;
}

// ------------------------------------------------------------------------------- formatting

/** Cycle clock "m:ss" (45:00 at most). */
export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Wall time "hh:mm:ss UTC" of cycle clock t in a cycle that started at startedAtMs. */
export function wallTime(startedAtMs: number, t: number): string {
  return `${new Date(startedAtMs + t).toISOString().slice(11, 19)} UTC`;
}

/** "04.10.2026 06:00 UTC". */
export function fmtUtc(ms: number): string {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)} ${iso.slice(11, 16)} UTC`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0).replace(".", ",")} КБ`;
  return `${(n / 1024 / 1024).toFixed(1).replace(".", ",")} МБ`;
}

/** Human palette (apps/web/src/game/assets.ts PLAYER_PALETTE; copied: that module pulls in Pixi). */
export const PLAYER_PALETTE = [
  0x4dabf7, 0xff6b6b, 0x51cf66, 0xffd43b, 0xcc5de8, 0xff922b, 0x22b8cf, 0xf06595,
  0x94d82d, 0x845ef7, 0x20c997, 0xfab005, 0x339af0, 0xe64980, 0x74c0fc, 0xffa94d,
] as const;

export function playerCss(color: number): string {
  const c = PLAYER_PALETTE[((color % PLAYER_PALETTE.length) + PLAYER_PALETTE.length) % PLAYER_PALETTE.length]!;
  return `#${c.toString(16).padStart(6, "0")}`;
}

/** List status of a replay: finished, still being written, or cut off (no chunk for STALE_MS: the shard died). */
export const STALE_MS = 5 * 60_000;
export type ReplayStatus = "done" | "live" | "cut";

export function replayStatus(r: { startedAt: string; endedAt: string | null; lastMs: number }, now: number): ReplayStatus {
  if (r.endedAt) return "done";
  const last = Date.parse(r.startedAt) + r.lastMs;
  return now - last <= STALE_MS ? "live" : "cut";
}

export const STATUS_LABEL: Record<ReplayStatus, string> = { done: "завершена", live: "идёт запись", cut: "оборвана" };
