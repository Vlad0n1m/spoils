import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCollisionIndex, SOLID } from "../geometry.js";
import { mulberry32 } from "../rng.js";
import { ARCH, archSize, doorOrder, makeBuilding } from "./buildings.js";
import { buildWalkGrid, floodWalk } from "./query.js";
import type { BuildingArch, MapSide } from "./types.js";
import { overlaps } from "./util.js";

const ARCHS = Object.keys(ARCH) as BuildingArch[];

/**
 * Property test over 150 random buildings per archetype: rooms tile the interior without overlap,
 * every room is reachable from outside through the doors (the BSP + DOOR_CLEAR guarantee), no wall
 * covers a door gap, and windows are SOLID.WINDOW (MOVE|VAULT: no SHOT, no SIGHT).
 */
test("BSP buildings: every room reachable from outside, rooms disjoint, doors open", () => {
  for (const arch of ARCHS) {
    for (let seed = 1; seed <= 150; seed++) {
      const rng = mulberry32(seed * 7919 + arch.length);
      const { w, h } = archSize(rng, arch);
      const floor = { x: 256, y: 256, w, h };
      const side = (seed % 4) as MapSide;
      const b = makeBuilding(rng, arch, "z", floor, doorOrder(rng, side));
      const where = `${arch} seed ${seed}`;
      const t = ARCH[arch].thick;

      assert.ok(b.building.rooms.length >= 1, where);
      assert.ok(b.building.rooms.length <= 2 ** ARCH[arch].depth, where);
      const ext = b.building.doors.filter((d) => d.x === floor.x || d.y === floor.y || d.x + d.w === floor.x + floor.w || d.y + d.h === floor.y + floor.h);
      assert.ok(ext.length >= ARCH[arch].doors[0], `${where}: exterior doors`);
      for (const [i, r] of b.building.rooms.entries()) {
        assert.ok(r.x >= floor.x + t && r.y >= floor.y + t && r.x + r.w <= floor.x + floor.w - t && r.y + r.h <= floor.y + floor.h - t, `${where}: room inside`);
        assert.ok(r.w >= 150 && r.h >= 150, `${where}: room too small ${r.w}x${r.h}`);
        for (const q of b.building.rooms.slice(i + 1)) assert.ok(!overlaps(r, q), `${where}: rooms overlap`);
      }
      for (const wl of b.walls) {
        for (const d of b.building.doors) assert.ok(!overlaps(wl, d), `${where}: wall covers a door`);
        if (wl.k === "window") assert.equal(wl.f, SOLID.WINDOW, where);
        else assert.equal(wl.f, SOLID.ALL, where);
        assert.ok(Number.isInteger(wl.x) && Number.isInteger(wl.y) && Number.isInteger(wl.w) && Number.isInteger(wl.h), where);
      }

      const idx = buildCollisionIndex({ rects: [...b.walls, ...b.furniture], circles: [] }, 2560, 2560);
      const g = buildWalkGrid({ width: 2560, height: 2560 }, idx);
      // Start outside the first exterior door, 64 px beyond the wall.
      const d = ext[0]!;
      const sx = d.x === floor.x ? d.x - 64 : d.x + d.w === floor.x + floor.w ? d.x + d.w + 64 : d.x + d.w / 2;
      const sy = d.y === floor.y ? d.y - 64 : d.y + d.h === floor.y + floor.h ? d.y + d.h + 64 : d.y + d.h / 2;
      const reached = floodWalk(g, sx, sy);
      for (const r of b.building.rooms) {
        let ok = false;
        for (let cy = Math.ceil(r.y / g.cell); cy * g.cell + g.cell / 2 < r.y + r.h && !ok; cy++) {
          for (let cx = Math.ceil(r.x / g.cell); cx * g.cell + g.cell / 2 < r.x + r.w; cx++) {
            if (reached[cy * g.cols + cx]) { ok = true; break; }
          }
        }
        assert.ok(ok, `${where}: room ${JSON.stringify(r)} unreachable`);
        // Map v2 furniture never walls off a pocket: every walkable cell of the room is reached.
        for (let cy = Math.ceil(r.y / g.cell); cy * g.cell + g.cell / 2 < r.y + r.h; cy++) {
          for (let cx = Math.ceil(r.x / g.cell); cx * g.cell + g.cell / 2 < r.x + r.w; cx++) {
            const i = cy * g.cols + cx;
            assert.ok(g.blocked[i] || reached[i], `${where}: pocket at cell ${cx},${cy} in room ${JSON.stringify(r)}`);
          }
        }
      }
      // Furniture: inside a room, clear of doors and windows, flags by kind.
      const wins = b.walls.filter((wl) => wl.k === "window");
      for (const f of b.furniture) {
        assert.ok(b.building.rooms.some((r) => f.x >= r.x && f.y >= r.y && f.x + f.w <= r.x + r.w && f.y + f.h <= r.y + r.h), `${where}: ${f.k} outside the rooms`);
        for (const d of b.building.doors) assert.ok(!overlaps(f, d, f.k === "shelf" && arch === "warehouse" ? 0 : 80), `${where}: ${f.k} blocks a door`);
        for (const wn of wins) assert.ok(!overlaps(f, wn, 40), `${where}: ${f.k} in front of a window`);
        const low = SOLID.MOVE | SOLID.SHOT;
        assert.equal(f.f, f.k === "shelf" || f.k === "lockers" ? SOLID.ALL : low, `${where}: ${f.k} flags`);
      }
      if (ARCH[arch].winEvery > 0 && ARCH[arch].winEvery <= 320 && w >= 512 && h >= 512) assert.ok(wins.length >= 2, `${where}: windows ${wins.length}`);
    }
  }
});

test("makeBuilding is deterministic for a given rng seed", () => {
  const a = makeBuilding(mulberry32(42), "office", "z", { x: 0, y: 0, w: 768, h: 608 }, [2, 0, 1, 3]);
  const b = makeBuilding(mulberry32(42), "office", "z", { x: 0, y: 0, w: 768, h: 608 }, [2, 0, 1, 3]);
  assert.deepEqual(a, b);
});
