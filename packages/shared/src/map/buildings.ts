/**
 * BSP buildings (map memo §4.6). A building is an outer wall ring with door gaps and windows
 * (SOLID.WINDOW = MOVE|VAULT: no walking through, a dodge roll vaults it, bullets and sight pass),
 * split recursively into rooms; every split wall gets exactly one door, so the BSP tree
 * itself guarantees every room is reachable. Doors are plain gaps — openable doors would break the
 * static collision index and client prediction (critique cut list).
 *
 * MAP_GEN_VERSION 4 (map v2): windows are spread evenly along every exterior side (ArchSpec
 * winEvery), and rooms are furnished (furnish()): items stand flush against a wall, never in front
 * of a door (DOOR_KEEP) or a window (so a vault always lands on open floor), ≥ ITEM_GAP apart so a
 * player passes between them, and leave ≥ ROOM_PASS of free depth across the room; only houses and
 * diners get a centre table. Low furniture (tables, desks, sofas, beds, counters) is MOVE|SHOT
 * cover you see over; shelves and lockers are ALL. Rugs and paper litter are decals.
 *
 * The one subtle rule: a later split wall must never butt into an earlier door gap (it would cut a
 * 96 px door into two slits narrower than a player). Every candidate wall is rejected if it comes
 * within DOOR_CLEAR px of any existing door; buildings.test.ts flood-fills hundreds of random
 * buildings to prove it.
 */

import { SOLID, type Rect } from "../geometry.js";
import { mulberry32, type Rng } from "../rng.js";
import { TERRAIN, type Building, type BuildingArch, type Decal, type MapRect, type MapSide, type PropKind, type Terrain } from "./types.js";
import { chance, overlaps, pick, ri, rs, shuffle } from "./util.js";

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
  /** One window per this many px of exterior side (minus one per door on that side); 0 = none. */
  winEvery: number;
}

export const ARCH: Record<BuildingArch, ArchSpec> = {
  houseS: { w: [448, 576], h: [384, 480], depth: 1, minRoom: 208, doors: [1, 2], doorW: 96, thick: 24, floor: TERRAIN.WOOD, winEvery: 300 },
  houseM: { w: [640, 800], h: [512, 640], depth: 3, minRoom: 224, doors: [2, 2], doorW: 96, thick: 24, floor: TERRAIN.WOOD, winEvery: 300 },
  barn: { w: [704, 1024], h: [448, 640], depth: 2, minRoom: 288, doors: [2, 2], doorW: 192, thick: 24, floor: TERRAIN.WOOD, winEvery: 560 },
  shed: { w: [384, 512], h: [320, 416], depth: 1, minRoom: 192, doors: [1, 2], doorW: 96, thick: 24, floor: TERRAIN.WOOD, winEvery: 380 },
  warehouse: { w: [1152, 1600], h: [640, 1024], depth: 2, minRoom: 448, doors: [2, 2], doorW: 192, thick: 24, floor: TERRAIN.CONCRETE, winEvery: 440 },
  office: { w: [640, 832], h: [512, 640], depth: 3, minRoom: 224, doors: [2, 2], doorW: 96, thick: 24, floor: TERRAIN.CONCRETE, winEvery: 260 },
  shop: { w: [512, 640], h: [384, 448], depth: 1, minRoom: 224, doors: [2, 2], doorW: 96, thick: 24, floor: TERRAIN.CONCRETE, winEvery: 260 },
  barracks: { w: [1024, 1216], h: [416, 512], depth: 3, minRoom: 224, doors: [2, 2], doorW: 96, thick: 24, floor: TERRAIN.WOOD, winEvery: 300 },
  bunker: { w: [640, 768], h: [640, 768], depth: 2, minRoom: 256, doors: [1, 1], doorW: 128, thick: 48, floor: TERRAIN.CONCRETE, winEvery: 0 },
  clinic: { w: [640, 832], h: [512, 640], depth: 3, minRoom: 208, doors: [2, 2], doorW: 96, thick: 24, floor: TERRAIN.CONCRETE, winEvery: 280 },
  garage: { w: [576, 768], h: [448, 576], depth: 1, minRoom: 256, doors: [1, 2], doorW: 192, thick: 24, floor: TERRAIN.CONCRETE, winEvery: 420 },
  diner: { w: [576, 704], h: [384, 480], depth: 1, minRoom: 208, doors: [2, 2], doorW: 96, thick: 24, floor: TERRAIN.WOOD, winEvery: 240 },
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
  /** Interior solids (shelves, tables, beds …). Containers avoid them. */
  furniture: MapRect[];
  /** Interior decor decals (rugs, paper litter, rubble): no collision. */
  decor: Decal[];
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

  // 3. Windows on the outer ring, away from doors and interior wall junctions: winEvery px per
  //    window, spread evenly (slot centre first, then random inside the slot). Windows and
  //    furniture draw from their own stream (seeded by the footprint), so dressing a building never
  //    shifts the POI's later buildings.
  const drng = mulberry32((Math.imul(x | 0, 0x9e3779b1) ^ Math.imul(y | 0, 0x85ebca77) ^ Math.imul(w * 4096 + h, 0xc2b2ae3d) ^ arch.length) >>> 0);
  const windows: Array<{ side: MapSide; r: Rect }> = [];
  if (a.winEvery > 0) {
    for (const side of [0, 1, 2, 3] as MapSide[]) {
      const horiz = side === 0 || side === 2;
      const len = horiz ? inner.w : inner.h;
      if (len < 300) continue;
      const doorsHere = extDoors.filter((d) => d.side === side).length;
      const n = Math.max(0, Math.min(5, Math.floor(len / a.winEvery) - doorsHere));
      if (n === 0) continue;
      const lo0 = (horiz ? inner.x : inner.y) + 40;
      const hi0 = (horiz ? inner.x + inner.w : inner.y + inner.h) - 40 - WINDOW_W;
      if (hi0 <= lo0) continue;
      const slot = (hi0 - lo0) / n;
      for (let k = 0; k < n; k++) {
        const s0 = lo0 + slot * k, s1 = lo0 + slot * (k + 1);
        for (let attempt = 0; attempt < 6; attempt++) {
          const at = attempt === 0 ? Math.round((s0 + s1) / 2 / 8) * 8 : rs(drng, s0, s1, 8);
          const r: Rect = side === 0 ? { x: at, y, w: WINDOW_W, h: t }
            : side === 2 ? { x: at, y: y + h - t, w: WINDOW_W, h: t }
            : side === 3 ? { x, y: at, w: t, h: WINDOW_W }
            : { x: x + w - t, y: at, w: t, h: WINDOW_W };
          if (doors.some((d) => overlaps(r, d, 40))) continue;
          if (splits.some((sp) => overlaps(r, sp.wall, 40))) continue;
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
  // 6. Room furnishing and decor (map v2).
  const decor: Decal[] = [];
  furnish(drng, arch, rooms, doors, windows.map((q) => q.r), furniture, decor);

  return {
    building: { arch, zone, floor: { ...floor }, rooms, doors, floorTerrain: a.floor },
    walls,
    furniture,
    decor,
  };
}

// ───────────────────────── furnishing (map v2)

const LOW = SOLID.MOVE | SOLID.SHOT;

/**
 * One furniture item: `len` along the wall it stands against, `dep` into the room (`perp`: the long
 * side points into the room, like a bed's headboard against the wall). `center` items stand in the
 * middle of the room instead.
 */
interface Item {
  k: PropKind;
  len: number;
  dep: number;
  f: number;
  /** Style variant (PROP_VARIANTS) for kinds whose `v` is a style; facing kinds store the wall side. */
  v?: number;
  perp?: boolean;
  center?: boolean;
}

const TABLE: Item = { k: "table", len: 96, dep: 64, f: LOW, v: 0, center: true };
const TABLE_ROUND: Item = { k: "table", len: 80, dep: 80, f: LOW, v: 1, center: true };
const DESK: Item = { k: "desk", len: 112, dep: 56, f: LOW };
const SOFA: Item = { k: "sofa", len: 144, dep: 64, f: LOW };
const ARMCHAIR: Item = { k: "armchair", len: 64, dep: 64, f: LOW };
const BED: Item = { k: "bed", len: 128, dep: 72, f: LOW, perp: true };
const COUNTER: Item = { k: "counter", len: 160, dep: 56, f: LOW };
const LOCKERS: Item = { k: "lockers", len: 128, dep: 40, f: SOLID.ALL };
const SHELF_METAL: Item = { k: "shelf", len: 128, dep: 40, f: SOLID.ALL, v: 1 };
const SHELF_WOOD: Item = { k: "shelf", len: 128, dep: 40, f: SOLID.ALL, v: 2 };
const CAR_INSIDE: Item = { k: "car", len: 224, dep: 112, f: LOW, v: 0, center: true };

/** Kinds whose MapRect.v is the wall side the item's back touches (client rotates the art). */
export const FACING_KINDS: ReadonlySet<PropKind> = new Set<PropKind>(["desk", "sofa", "armchair", "bed", "counter", "lockers"]);

/** Clear floor kept around door gaps (an item never narrows a doorway or its approach). */
const DOOR_KEEP = 88;
/** Clear floor kept beside a window on the inside (a vault always lands on open floor). */
const WINDOW_KEEP = 48;
/** Gap between two items: two walk cells, so a player always passes between them. */
const ITEM_GAP = 96;
/** Free depth an item must leave across its room (≥ 3 walk cells: a player always passes). */
const ROOM_PASS = 128;

/** Room plans per archetype: item lists for the rooms sorted by area, largest first (the last plan repeats). */
const PLANS: Record<BuildingArch, ReadonlyArray<readonly Item[]>> = {
  houseS: [[SOFA, TABLE], [BED]],
  houseM: [[SOFA, ARMCHAIR, TABLE, SHELF_WOOD], [BED, SHELF_WOOD], [COUNTER, TABLE_ROUND], [BED, ARMCHAIR]],
  barn: [[SHELF_WOOD, SHELF_WOOD]],
  shed: [[SHELF_WOOD, LOCKERS]],
  warehouse: [[SHELF_METAL, LOCKERS]],
  office: [[DESK, DESK, SHELF_METAL], [DESK, LOCKERS], [DESK, SHELF_METAL]],
  shop: [[COUNTER, SHELF_METAL, SHELF_METAL], [SHELF_WOOD, SHELF_METAL]],
  barracks: [[BED, BED, LOCKERS], [BED, BED, LOCKERS], [DESK, LOCKERS]],
  bunker: [[LOCKERS, SHELF_METAL], [DESK, LOCKERS]],
  clinic: [[BED, BED, LOCKERS], [DESK, SHELF_METAL], [BED, LOCKERS]],
  garage: [[CAR_INSIDE, SHELF_METAL, LOCKERS], [SHELF_METAL]],
  diner: [[COUNTER, TABLE_ROUND, SOFA, SOFA], [SHELF_WOOD, COUNTER]],
};

/** Rooms that get a rug (largest room of these archetypes) and paper litter. */
const RUG_ARCHS: ReadonlySet<BuildingArch> = new Set<BuildingArch>(["houseS", "houseM", "office", "diner"]);
const PAPER_ARCHS: ReadonlySet<BuildingArch> = new Set<BuildingArch>(["office", "clinic", "shop", "barracks", "bunker"]);
const RUBBLE_ARCHS: ReadonlySet<BuildingArch> = new Set<BuildingArch>(["houseS", "houseM", "barn", "shed", "garage"]);

function itemRect(room: Rect, it: Item, side: MapSide, at: number): Rect {
  const along = it.perp ? it.dep : it.len;
  const depth = it.perp ? it.len : it.dep;
  return side === 0 ? { x: at, y: room.y, w: along, h: depth }
    : side === 2 ? { x: at, y: room.y + room.h - depth, w: along, h: depth }
    : side === 3 ? { x: room.x, y: at, w: depth, h: along }
    : { x: room.x + room.w - depth, y: at, w: depth, h: along };
}

/**
 * Furnish every room from PLANS (deterministic for the building's rng). Appends solids to
 * `furniture` (after any warehouse racks) and decals to `decor`. Items that do not fit are skipped:
 * a missing chair never breaks a room, an extra one could.
 */
function furnish(
  rng: Rng,
  arch: BuildingArch,
  rooms: readonly Rect[],
  doors: readonly Rect[],
  windows: readonly Rect[],
  furniture: MapRect[],
  decor: Decal[],
): void {
  const plans = PLANS[arch];
  const order = rooms.map((r, i) => ({ r, i, a: r.w * r.h })).sort((p, q) => q.a - p.a || p.i - q.i);
  order.forEach(({ r: room }, rank) => {
    const plan = plans[Math.min(rank, plans.length - 1)]!;
    const free = (q: Rect, gap: number) => !furniture.some((f) => overlaps(q, f, gap));
    let centre: Rect | null = null;
    for (const it of plan) {
      if (it.center) {
        if (room.w < it.len + 2 * 128 || room.h < it.dep + 2 * 128) continue;
        const vert = it.k === "car" && room.h > room.w;
        const w = vert ? it.dep : it.len, h = vert ? it.len : it.dep;
        const q: Rect = {
          x: Math.round((room.x + (room.w - w) / 2 + ri(rng, -24, 24)) / 8) * 8,
          y: Math.round((room.y + (room.h - h) / 2 + ri(rng, -24, 24)) / 8) * 8,
          w, h,
        };
        if (doors.some((d) => overlaps(q, d, 128)) || !free(q, 112)) continue;
        furniture.push({ ...q, f: it.f, k: it.k, o: w >= h ? 0 : 1, ...(it.v !== undefined ? { v: it.v } : {}) });
        centre = q;
        continue;
      }
      for (let attempt = 0; attempt < 24; attempt++) {
        const side = ri(rng, 0, 3) as MapSide;
        const horizWall = side === 0 || side === 2;
        const along = it.perp ? it.dep : it.len;
        const depth = it.perp ? it.len : it.dep;
        const span = horizWall ? room.w : room.h;
        const across = horizWall ? room.h : room.w;
        if (span < along + 32 || across - depth < ROOM_PASS) continue;
        const at = Math.round(((horizWall ? room.x : room.y) + 16 + rng() * (span - along - 32)) / 8) * 8;
        const q = itemRect(room, it, side, at);
        if (doors.some((d) => overlaps(q, d, DOOR_KEEP))) continue;
        if (windows.some((wn) => overlaps(q, wn, WINDOW_KEEP))) continue;
        if (!free(q, ITEM_GAP)) continue;
        const v = FACING_KINDS.has(it.k) ? side : it.v;
        furniture.push({ ...q, f: it.f, k: it.k, o: q.w >= q.h ? 0 : 1, ...(v !== undefined ? { v } : {}) });
        break;
      }
    }
    // Decor (decals, no collision): a rug under the centre table of the main room, paper litter in
    // offices, some rubble in the old wooden buildings.
    const cx = room.x + room.w / 2, cy = room.y + room.h / 2;
    if (rank === 0 && RUG_ARCHS.has(arch) && room.w >= 288 && room.h >= 288) {
      const at = centre ?? { x: cx, y: cy, w: 0, h: 0 };
      const r = Math.min(120, Math.floor(Math.min(room.w, room.h) * 0.3));
      decor.push({ x: Math.round(at.x + at.w / 2), y: Math.round(at.y + at.h / 2), r, k: chance(rng, 0.35) ? "rug_round" : "rug", a: room.w >= room.h ? 0 : 1 });
    }
    if (PAPER_ARCHS.has(arch) && chance(rng, 0.5)) {
      decor.push({ x: Math.round(room.x + 48 + rng() * Math.max(1, room.w - 96)), y: Math.round(room.y + 48 + rng() * Math.max(1, room.h - 96)), r: ri(rng, 36, 56), k: "papers" });
    }
    if (RUBBLE_ARCHS.has(arch) && chance(rng, 0.18)) {
      decor.push({ x: Math.round(room.x + 48 + rng() * Math.max(1, room.w - 96)), y: Math.round(room.y + 48 + rng() * Math.max(1, room.h - 96)), r: ri(rng, 48, 72), k: pick(rng, ["bricks", "planks"] as const) });
    }
  });
}

function seg(horiz: boolean, fixed: number, at: number, len: number, t: number, f: number, k: MapRect["k"]): MapRect {
  return horiz ? { x: at, y: fixed, w: len, h: t, f, k, o: 0 } : { x: fixed, y: at, w: t, h: len, f, k, o: 1 };
}

/** Door side order: preferred first, then its opposite (walk-through), then the rest shuffled. */
export function doorOrder(rng: Rng, preferred: MapSide): MapSide[] {
  const rest = shuffle(rng, [((preferred + 1) % 4) as MapSide, ((preferred + 3) % 4) as MapSide]);
  return [preferred, ((preferred + 2) % 4) as MapSide, ...rest];
}
