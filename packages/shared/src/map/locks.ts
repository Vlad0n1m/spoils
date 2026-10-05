/**
 * Locked rooms (in-raid objectives, objectives.ts): one room per T2–T4 POI whose door needs that
 * POI's key (ROOM_KEYS). Pure DATA derived from a finished map — rooms, doors and windows are not
 * part of mapHash and nothing here moves geometry, so the golden hash is untouched and the layout
 * stays MAP_GEN_VERSION 4. Deterministic per map (integer maths, index order), so the server and
 * every client derive the same list.
 *
 * Choice per zone (lockedRooms): a leaf room of one of the zone's buildings with at least one
 * container inside, no boss / guard / marauder post / spawn / extract inside, whose removal keeps
 * every other room of the building reachable from an exterior door (so locking it never seals a
 * neighbour). Best score: containers (pool-eligible kinds count extra), then fewer windows.
 *
 * Collision (lockOverlay): the door gaps of a locked room get a "gate" rect and its windows a
 * "bars" rect, appended AFTER MapData.rects in the shared collision index (getCollisionIndex)
 * with flags 0 — inert until a match turns them on. The game server gives every match its own
 * flag copy (matchCollisionIndex) and sets gates + bars when objectives run; a gate drops to 0
 * when its room is unlocked. The client toggles the shared index from BattleState.lockState.
 * Gates and bars are MOVE only: sight and bullets pass (you see the loot through the bars), and
 * without the VAULT bit a dodge roll cannot vault a barred window. The walk grid (nav, spot
 * validation) is built before the overlay and ignores it: NPCs never path into locked rooms.
 */

import { SOLID, type CollisionIndex, type Rect } from "../geometry.js";
import { ROOM_KEYS, roomKeyDef } from "../item-defs.js";
import type { LootTier, MapData, MapRect } from "./types.js";

export const LOCK_GEOM = {
  /** Lowest zone tier with a locked room. */
  MIN_TIER: 2,
  /** Collision flags of a locked gate and of window bars once a match turns them on. */
  GATE_FLAGS: SOLID.MOVE,
  BAR_FLAGS: SOLID.MOVE,
  /** Spawns / extracts / NPC posts this close to a room keep it unlocked. */
  KEEP_CLEAR_PX: 64,
} as const;

export interface LockedRoom {
  /** Index in lockedRooms(map) (BattleState.lockState index, ObjMsg.lock). */
  id: number;
  zone: string;
  zoneName: string;
  tier: LootTier;
  /** Item def id of the key (ROOM_KEYS). */
  key: string;
  /** Interior rect of the room. */
  room: Rect;
  /** Door gaps of the room (the gates). */
  doors: Rect[];
  /** Window gaps of the room (barred for the whole cycle). */
  bars: Rect[];
  /** MapData.containers indexes inside the room (the strongroom set). */
  containers: number[];
  /** Building index (MapData.buildings). */
  building: number;
}

export interface LockOverlay {
  /** Index of the first overlay rect in the collision index (= MapData.rects.length). */
  base: number;
  rects: MapRect[];
  /** Per lock: [start, end) overlay offsets of its gates and of its bars. */
  gates: Array<[number, number]>;
  bars: Array<[number, number]>;
}

const inside = (r: Rect, x: number, y: number, pad = 0) =>
  x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad;
const touches = (a: Rect, b: Rect) =>
  a.x - 1 < b.x + b.w && a.x + a.w + 1 > b.x && a.y - 1 < b.y + b.h && a.y + a.h + 1 > b.y;

/** Container kinds that may hold a pool unique (economy POOL_CONTAINER_KINDS; copied: no import cycle). */
const POOL_KINDS = new Set(["crate", "toolbox", "weapon_box", "safe"]);

const lockCache = new WeakMap<MapData, readonly LockedRoom[]>();

/** The locked rooms of a map (memoized per MapData). Empty for maps without zoned buildings. */
export function lockedRooms(map: MapData): readonly LockedRoom[] {
  const have = lockCache.get(map);
  if (have) return have;
  const out: LockedRoom[] = [];
  const keyOf = new Map(ROOM_KEYS.map((k) => [k.zone, k]));
  const windows = map.rects.filter((r) => r.k === "window");
  const avoid: Array<{ x: number; y: number }> = [
    ...map.spawns, ...map.extracts, ...(map.npcPosts ?? []),
    ...map.bosses.flatMap((b) => [{ x: b.x, y: b.y }, ...b.guards]),
  ];
  for (const zone of map.zones) {
    if (zone.tier < LOCK_GEOM.MIN_TIER || !keyOf.has(zone.id)) continue;
    let best: { score: number; lock: Omit<LockedRoom, "id"> } | null = null;
    map.buildings.forEach((b, bi) => {
      if (b.zone !== zone.id) return;
      const adj = b.rooms.map((room) => b.doors.map((_, di) => di).filter((di) => touches(room, b.doors[di]!)));
      const roomsOf = b.doors.map((d) => b.rooms.map((_, ri) => ri).filter((ri) => touches(b.rooms[ri]!, d)));
      b.rooms.forEach((room, ri) => {
        const doors = adj[ri]!;
        if (doors.length === 0) return;
        if (!othersReachable(b.rooms.length, roomsOf, ri)) return;
        const containers: number[] = [];
        map.containers.forEach((c, ci) => {
          if (inside(room, c.x, c.y)) containers.push(ci);
        });
        if (containers.length === 0) return;
        if (avoid.some((p) => inside(room, p.x, p.y, LOCK_GEOM.KEEP_CLEAR_PX))) return;
        const bars = windows.filter((w) => touches(room, w)).map((w) => ({ x: w.x, y: w.y, w: w.w, h: w.h }));
        const poolKinds = containers.filter((ci) => POOL_KINDS.has(map.containers[ci]!.kind)).length;
        const score = containers.length * 100 + poolKinds * 40 - bars.length * 10 - doors.length * 5;
        if (best && score <= best.score) return;
        best = {
          score,
          lock: {
            zone: zone.id, zoneName: zone.name, tier: zone.tier, key: roomKeyDef(zone.id),
            room: { x: room.x, y: room.y, w: room.w, h: room.h },
            doors: doors.map((di) => ({ ...b.doors[di]! })), bars, containers, building: bi,
          },
        };
      });
    });
    if (best) out.push({ id: out.length, ...(best as { lock: Omit<LockedRoom, "id"> }).lock });
  }
  const frozen = Object.freeze(out);
  lockCache.set(map, frozen);
  return frozen;
}

/** Every room but `skip` still reaches an exterior door (a door touching exactly one room). */
function othersReachable(nRooms: number, roomsOf: number[][], skip: number): boolean {
  const seen = new Uint8Array(nRooms);
  const queue: number[] = [];
  for (const rs of roomsOf) {
    if (rs.length !== 1 || rs[0] === skip) continue;
    if (!seen[rs[0]!]) {
      seen[rs[0]!] = 1;
      queue.push(rs[0]!);
    }
  }
  while (queue.length) {
    const r = queue.pop()!;
    for (const rs of roomsOf) {
      if (rs.length < 2 || !rs.includes(r) || rs.includes(skip)) continue;
      for (const o of rs) {
        if (!seen[o]) {
          seen[o] = 1;
          queue.push(o);
        }
      }
    }
  }
  for (let i = 0; i < nRooms; i++) if (i !== skip && !seen[i]) return false;
  return true;
}

/** The locked room whose interior holds MapData.containers[idx], or null. */
export function lockOfContainer(map: MapData, idx: number): LockedRoom | null {
  for (const l of lockedRooms(map)) if (l.containers.includes(idx)) return l;
  return null;
}

/** Centre of a lock's first gate (the F prompt point). */
export function gateCentre(l: LockedRoom): { x: number; y: number } {
  const d = l.doors[0]!;
  return { x: d.x + d.w / 2, y: d.y + d.h / 2 };
}

const overlayCache = new WeakMap<MapData, LockOverlay>();

/** Gate and bar rects of every locked room, in lock order (appended after MapData.rects). */
export function lockOverlay(map: MapData): LockOverlay {
  let o = overlayCache.get(map);
  if (o) return o;
  const rects: MapRect[] = [];
  const gates: Array<[number, number]> = [];
  const bars: Array<[number, number]> = [];
  for (const l of lockedRooms(map)) {
    const g0 = rects.length;
    for (const d of l.doors) rects.push({ x: d.x, y: d.y, w: d.w, h: d.h, f: 0, k: "wall" });
    gates.push([g0, rects.length]);
    const b0 = rects.length;
    for (const w of l.bars) rects.push({ x: w.x, y: w.y, w: w.w, h: w.h, f: 0, k: "wall" });
    bars.push([b0, rects.length]);
  }
  o = { base: map.rects.length, rects, gates, bars };
  overlayCache.set(map, o);
  return o;
}

/** Does `idx` carry this map's lock overlay (getCollisionIndex / matchCollisionIndex)? */
export function hasLockOverlay(idx: CollisionIndex, map: MapData): boolean {
  const o = lockOverlay(map);
  return o.rects.length > 0 && idx.rects.length === o.base + o.rects.length;
}

/** Turn every gate and bar on (objectives running: everything locked) or off (inert). */
export function setLocksEnabled(idx: CollisionIndex, map: MapData, on: boolean): void {
  if (!hasLockOverlay(idx, map)) return;
  const o = lockOverlay(map);
  o.gates.forEach(([s, e]) => {
    for (let i = s; i < e; i++) idx.rectFlags[o.base + i] = on ? LOCK_GEOM.GATE_FLAGS : 0;
  });
  o.bars.forEach(([s, e]) => {
    for (let i = s; i < e; i++) idx.rectFlags[o.base + i] = on ? LOCK_GEOM.BAR_FLAGS : 0;
  });
}

/** Open (flags 0) or close (GATE_FLAGS) the gates of lock `id`. Bars stay as they are. */
export function setGateOpen(idx: CollisionIndex, map: MapData, id: number, open: boolean): void {
  if (!hasLockOverlay(idx, map)) return;
  const o = lockOverlay(map);
  const r = o.gates[id];
  if (!r) return;
  for (let i = r[0]; i < r[1]; i++) idx.rectFlags[o.base + i] = open ? 0 : LOCK_GEOM.GATE_FLAGS;
}

/** Is any gate of lock `id` solid in `idx`? */
export function gateClosed(idx: CollisionIndex, map: MapData, id: number): boolean {
  if (!hasLockOverlay(idx, map)) return false;
  const o = lockOverlay(map);
  const r = o.gates[id];
  return !!r && r[1] > r[0] && idx.rectFlags[o.base + r[0]] !== 0;
}

/**
 * A per-match copy of a shared index: same rects and cells, its own flags (lock gates) and dedup
 * stamps. Cheap (two typed arrays over the rect / circle counts).
 */
export function matchCollisionIndex(base: CollisionIndex): CollisionIndex {
  return {
    ...base,
    rectFlags: base.rectFlags.slice(),
    rectStamp: new Uint32Array(base.rects.length),
    circleStamp: new Uint32Array(base.circles.length),
    stamp: 0,
  };
}
