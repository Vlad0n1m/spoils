/**
 * BSP buildings (map memo §4.6). A building is an outer wall ring with door gaps and windows
 * (SOLID.WINDOW = MOVE|VAULT: no walking through, a dodge roll vaults it, bullets and sight pass),
 * split recursively into rooms; every split wall gets exactly one door, so the BSP tree
 * itself guarantees every room is reachable. Doors are plain gaps — openable doors would break the
 * static collision index and client prediction (critique cut list).
 *
 * The one subtle rule: a later split wall must never butt into an earlier door gap (it would cut a
 * 96 px door into two slits narrower than a player). Every candidate wall is rejected if it comes
 * within DOOR_CLEAR px of any existing door; buildings.test.ts flood-fills hundreds of random
 * buildings to prove it.
 */

import { SOLID, type Rect } from "../geometry.js";
import type { Rng } from "../rng.js";
import { TERRAIN, type Building, type BuildingArch, type MapRect, type MapSide, type Terrain } from "./types.js";
import { overlaps, ri, rs, shuffle } from "./util.js";

export interface ArchSpec {
  w: readonly [number, number];
  h: readonly [number, number];
  /** Max BSP depth (leaf rooms ≤ 2^depth). */
  depth: number;
  /** Smallest room side (interior px) a split may create. */
  minRoom: number;
  doors: readonly [number, number];
  doorW: number;
  thick: number;
  floor: Terrain;
  windows: boolean;
}

export const ARCH: Record<BuildingArch, ArchSpec> = {
  houseS: { w: [448, 576], h: [384, 480], depth: 1, minRoom: 208, doors: [1, 2], doorW: 96, thick: 24, floor: TERRAIN.WOOD, windows: true },
  houseM: { w: [640, 800], h: [512, 640], depth: 3, minRoom: 224, doors: [2, 2], doorW: 96, thick: 24, floor: TERRAIN.WOOD, windows: true },
  barn: { w: [704, 1024], h: [448, 640], depth: 2, minRoom: 288, doors: [2, 2], doorW: 192, thick: 24, floor: TERRAIN.WOOD, windows: true },
  shed: { w: [384, 512], h: [320, 416], depth: 1, minRoom: 192, doors: [1, 2], doorW: 96, thick: 24, floor: TERRAIN.WOOD, windows: true },
  warehouse: { w: [1152, 1600], h: [640, 1024], depth: 2, minRoom: 448, doors: [2, 2], doorW: 192, thick: 24, floor: TERRAIN.CONCRETE, windows: true },
  office: { w: [640, 832], h: [512, 640], depth: 3, minRoom: 224, doors: [2, 2], doorW: 96, thick: 24, floor: TERRAIN.CONCRETE, windows: true },
  shop: { w: [512, 640], h: [384, 448], depth: 1, minRoom: 224, doors: [2, 2], doorW: 96, thick: 24, floor: TERRAIN.CONCRETE, windows: true },
  barracks: { w: [1024, 1216], h: [416, 512], depth: 3, minRoom: 224, doors: [2, 2], doorW: 96, thick: 24, floor: TERRAIN.WOOD, windows: true },
  bunker: { w: [640, 768], h: [640, 768], depth: 2, minRoom: 256, doors: [1, 1], doorW: 128, thick: 48, floor: TERRAIN.CONCRETE, windows: false },
};

/** Interior door width. 96 px leaves a 40 px band of walkable 32 px cells for a 28 px clearance. */
export const INNER_DOOR = 96;
/** Keep split walls this far from any door so the passage stays a full door wide. */
const DOOR_CLEAR = 56;
const WINDOW_W = 112;

export interface BuiltBuilding {
  building: Building;
  /** Wall segments and windows (append to MapData.rects). */
  walls: MapRect[];
  /** Interior solids (warehouse shelves). Containers avoid them. */
  furniture: MapRect[];
}

/** Random footprint size for an archetype, snapped to 32 px. */
export function archSize(rng: Rng, arch: BuildingArch): { w: number; h: number } {
  const a = ARCH[arch];
  return { w: rs(rng, a.w[0], a.w[1], 32), h: rs(rng, a.h[0], a.h[1], 32) };
}

interface Split {
  wall: Rect;
  door: Rect;
  vert: boolean;
}

/**
 * Build walls, doors, windows and rooms for a footprint. `doorSides` lists exterior sides in
 * preference order (road-facing first); the archetype decides how many get a door.
 */
export function makeBuilding(
  rng: Rng,
  arch: BuildingArch,
  zone: string,
  floor: Rect,
  doorSides: readonly MapSide[],
): BuiltBuilding {
  const a = ARCH[arch];
  const t = a.thick;
  const { x, y, w, h } = floor;
  const inner: Rect = { x: x + t, y: y + t, w: w - 2 * t, h: h - 2 * t };

  // 1. Exterior doors (decided first so BSP walls can keep clear of them).
  const nDoors = Math.min(doorSides.length, ri(rng, a.doors[0], a.doors[1]));
  const extDoors: Array<{ side: MapSide; r: Rect }> = [];
  for (let i = 0; i < nDoors; i++) {
    const side = doorSides[i]!;
    const horiz = side === 0 || side === 2;
    const lo = (horiz ? inner.x : inner.y) + 24;
    const hi = (horiz ? inner.x + inner.w : inner.y + inner.h) - 24 - a.doorW;
    const at = hi > lo ? rs(rng, lo, hi, 8) : Math.round((lo + hi) / 2);
    const r: Rect = side === 0 ? { x: at, y, w: a.doorW, h: t }
      : side === 2 ? { x: at, y: y + h - t, w: a.doorW, h: t }
      : side === 3 ? { x, y: at, w: t, h: a.doorW }
      : { x: x + w - t, y: at, w: t, h: a.doorW };
    extDoors.push({ side, r });
  }
  const doors: Rect[] = extDoors.map((d) => d.r);

  // 2. BSP. Leaves are interior room rects (walls excluded).
  const rooms: Rect[] = [];
  const splits: Split[] = [];
  const blockedByDoor = (r: Rect) => doors.some((d) => overlaps(r, d, DOOR_CLEAR));
  const split = (r: Rect, depth: number): void => {
    const min = a.minRoom;
    const canV = r.w >= 2 * min + t;
    const canH = r.h >= 2 * min + t;
    if (depth <= 0 || (!canV && !canH)) {
      rooms.push(r);
      return;
    }
    const prefV = canV && (!canH || (r.w === r.h ? rng() < 0.5 : r.w > r.h));
    for (const vert of prefV ? [true, false] : [false, true]) {
      if (vert ? !canV : !canH) continue;
      for (let attempt = 0; attempt < 8; attempt++) {
        const pos = vert ? rs(rng, r.x + min, r.x + r.w - min - t, 8) : rs(rng, r.y + min, r.y + r.h - min - t, 8);
        const wall: Rect = vert ? { x: pos, y: r.y, w: t, h: r.h } : { x: r.x, y: pos, w: r.w, h: t };
        if (blockedByDoor(wall)) continue;
        const span = vert ? r.h : r.w;
        const start = vert ? r.y : r.x;
        const at = rs(rng, start + 24, start + span - 24 - INNER_DOOR, 8);
        const door: Rect = vert ? { x: pos, y: at, w: t, h: INNER_DOOR } : { x: at, y: pos, w: INNER_DOOR, h: t };
        doors.push(door);
        splits.push({ wall, door, vert });
        if (vert) {
          split({ x: r.x, y: r.y, w: pos - r.x, h: r.h }, depth - 1);
          split({ x: pos + t, y: r.y, w: r.x + r.w - pos - t, h: r.h }, depth - 1);
        } else {
          split({ x: r.x, y: r.y, w: r.w, h: pos - r.y }, depth - 1);
          split({ x: r.x, y: pos + t, w: r.w, h: r.y + r.h - pos - t }, depth - 1);
        }
        return;
      }
    }
    rooms.push(r);
  };
  split(inner, a.depth);

  // 3. Windows on the outer ring, away from doors and interior wall junctions.
  const windows: Array<{ side: MapSide; r: Rect }> = [];
  if (a.windows) {
    for (const side of [0, 1, 2, 3] as MapSide[]) {
      const horiz = side === 0 || side === 2;
      const len = horiz ? inner.w : inner.h;
      const hasDoor = extDoors.some((d) => d.side === side);
      const n = len < 380 ? 0 : hasDoor ? (len >= 700 && rng() < 0.6 ? 1 : 0) : len >= 900 ? 2 : rng() < 0.8 ? 1 : 0;
      for (let k = 0; k < n; k++) {
        for (let attempt = 0; attempt < 6; attempt++) {
          const lo = (horiz ? inner.x : inner.y) + 40;
          const hi = (horiz ? inner.x + inner.w : inner.y + inner.h) - 40 - WINDOW_W;
          if (hi <= lo) break;
          const at = rs(rng, lo, hi, 8);
          const r: Rect = side === 0 ? { x: at, y, w: WINDOW_W, h: t }
            : side === 2 ? { x: at, y: y + h - t, w: WINDOW_W, h: t }
            : side === 3 ? { x, y: at, w: t, h: WINDOW_W }
            : { x: x + w - t, y: at, w: t, h: WINDOW_W };
          if (doors.some((d) => overlaps(r, d, 40))) continue;
          if (splits.some((s) => overlaps(r, s.wall, 40))) continue;
          if (windows.some((o) => overlaps(r, o.r, 40))) continue;
          windows.push({ side, r });
          break;
        }
      }
    }
  }

  // 4. Emit wall segments around the gaps.
  const walls: MapRect[] = [];
  const wallKind = arch === "bunker" ? "concrete_wall" : "wall";
  const run = (horiz: boolean, fixed: number, a0: number, a1: number, gaps: Array<{ r: Rect; win: boolean }>) => {
    const gs = gaps
      .map((g) => ({ at: horiz ? g.r.x : g.r.y, len: horiz ? g.r.w : g.r.h, win: g.win }))
      .sort((p, q) => p.at - q.at);
    let cur = a0;
    for (const g of gs) {
      if (g.at > cur) walls.push(seg(horiz, fixed, cur, g.at - cur, t, SOLID.ALL, wallKind));
      if (g.win) walls.push(seg(horiz, fixed, g.at, g.len, t, SOLID.WINDOW, "window"));
      cur = Math.max(cur, g.at + g.len);
    }
    if (a1 > cur) walls.push(seg(horiz, fixed, cur, a1 - cur, t, SOLID.ALL, wallKind));
  };
  const gapsOn = (side: MapSide) => [
    ...extDoors.filter((d) => d.side === side).map((d) => ({ r: d.r, win: false })),
    ...windows.filter((d) => d.side === side).map((d) => ({ r: d.r, win: true })),
  ];
  run(true, y, x, x + w, gapsOn(0));
  run(true, y + h - t, x, x + w, gapsOn(2));
  run(false, x, y + t, y + h - t, gapsOn(3));
  run(false, x + w - t, y + t, y + h - t, gapsOn(1));
  for (const s of splits) {
    if (s.vert) run(false, s.wall.x, s.wall.y, s.wall.y + s.wall.h, [{ r: s.door, win: false }]);
    else run(true, s.wall.y, s.wall.x, s.wall.x + s.wall.w, [{ r: s.door, win: false }]);
  }

  // 5. Furniture: warehouse shelf rows, parallel to the room's long side, clear of doors.
  const furniture: MapRect[] = [];
  if (arch === "warehouse") {
    for (const room of rooms) {
      if (room.w < 520 || room.h < 520) continue;
      const along = room.w >= room.h; // shelves run along x
      const across = along ? room.h : room.w;
      const span = along ? room.w : room.h;
      const len = span - 2 * 176;
      if (len < 160) continue;
      for (let off = 160; off + 48 <= across - 160; off += 240) {
        const r: Rect = along
          ? { x: room.x + 176, y: room.y + off, w: len, h: 48 }
          : { x: room.x + off, y: room.y + 176, w: 48, h: len };
        if (doors.some((d) => overlaps(r, d, 96))) continue;
        furniture.push({ ...r, f: SOLID.ALL, k: "shelf", o: along ? 0 : 1 });
      }
    }
  }

  return {
    building: { arch, zone, floor: { ...floor }, rooms, doors, floorTerrain: a.floor },
    walls,
    furniture,
  };
}

function seg(horiz: boolean, fixed: number, at: number, len: number, t: number, f: number, k: MapRect["k"]): MapRect {
  return horiz ? { x: at, y: fixed, w: len, h: t, f, k, o: 0 } : { x: fixed, y: at, w: t, h: len, f, k, o: 1 };
}

/** Door side order: preferred first, then its opposite (walk-through), then the rest shuffled. */
export function doorOrder(rng: Rng, preferred: MapSide): MapSide[] {
  const rest = shuffle(rng, [((preferred + 1) % 4) as MapSide, ((preferred + 3) % 4) as MapSide]);
  return [preferred, ((preferred + 2) % 4) as MapSide, ...rest];
}
