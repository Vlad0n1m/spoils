/**
 * Cross-module contract test: the REAL generated Steppe map plugged into every module that
 * consumes MapData (occluders, vision, sound surface, environment, extracts, containers). The
 * per-module tests use hand-built fixtures; this one catches signature or semantic drift between
 * the map generator and its consumers before the server and client WPs build on them.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { SEARCH } from "./constants.js";
import { CONTAINER, CONTAINER_LOOT, rollContainerFungibles } from "./economy.js";
import { envConfigOf, sampleEnv } from "./environment.js";
import { circleIsFree, countOccluders, raycastSolidsDDA, SOLID } from "./geometry.js";
import { itemDef } from "./item-defs.js";
import { containerOpenMs } from "./inventory.js";
import {
  CONTAINER_KINDS,
  STEP_MATERIALS,
  TERRAIN,
  WALL_KINDS,
  extractMask,
  generateMap,
  getCollisionIndex,
  getWallIndex,
  surfaceAt,
  surfaceOf,
  terrainByteAt,
  type MapSide,
} from "./map/index.js";
import { buildOccluderGrid, pointShadowed } from "./occluders.js";
import { mulberry32 } from "./rng.js";
import { BattleState, SelfState } from "./schema.js";
import { SoundKind, baseSoundRadius, effectiveSoundRadius } from "./sound.js";
import { buildBushIndex, bushIndexAt, canSee, visionRangeMult } from "./vision.js";

const m = generateMap("steppe");
const idx = getCollisionIndex(m);

test("occluders: client shadows are a superset of server SIGHT blocks on the real map", () => {
  const g = buildOccluderGrid(m);
  assert.ok(g.count > 1000, `segments ${g.count}`);
  const rng = mulberry32(7);
  let blocked = 0;
  for (let n = 0; n < 3000; n++) {
    const ex = 2000 + rng() * (m.width - 4000), ey = 2000 + rng() * (m.height - 4000);
    const a = rng() * Math.PI * 2, d = 50 + rng() * 900;
    const px = ex + Math.cos(a) * d, py = ey + Math.sin(a) * d;
    // Players never stand inside a solid; the octagon slack is only a superset outside the circle.
    if (!circleIsFree(idx, ex, ey, 1, SOLID.SIGHT) || !circleIsFree(idx, px, py, 1, SOLID.SIGHT)) continue;
    if (raycastSolidsDDA(idx, ex, ey, px, py, SOLID.SIGHT) === Infinity) continue;
    blocked++;
    assert.ok(pointShadowed(g, ex, ey, px, py, 1000), `server hides (${px},${py}) from (${ex},${ey}) but client shows it`);
  }
  assert.ok(blocked > 100, `only ${blocked} blocked samples`);
});

test("vision: canSee and the bush index run on the real map", () => {
  const bi = buildBushIndex(m.bushes, m.width, m.height);
  const b = m.bushes[0]!;
  assert.equal(bushIndexAt(bi, b.x, b.y) >= 0, true);
  const s = m.spawns[0]!;
  const env = { idx, rangeMult: visionRangeMult(1) };
  const viewer = { x: s.x, y: s.y, aim: 0, vx: 0, vy: 0 };
  // Inside the awareness radius with nothing in between: always seen.
  assert.equal(canSee(env, viewer, { x: s.x + 40, y: s.y, inBush: false, stillMs: 0, sinceShotMs: Infinity }), true);
  // Beyond range: never seen.
  assert.equal(canSee(env, viewer, { x: s.x + 5000, y: s.y, inBush: false, stillMs: 0, sinceShotMs: Infinity }), false);
});

test("sound: every terrain cell maps to a step material; radii scale by surface and env", () => {
  const seen = new Set<number>();
  for (let i = 0; i < m.terrain.length; i += 37) {
    const s = surfaceOf(m.terrain[i]!);
    assert.ok(s.variant >= 0 && s.variant < STEP_MATERIALS.length);
    seen.add(s.variant);
  }
  assert.ok(seen.size >= 5, `materials ${[...seen]}`);
  const z = m.spawns[0]!;
  const surf = surfaceAt(m, z.x, z.y);
  assert.deepEqual(surf, surfaceOf(terrainByteAt(m, z.x, z.y)));
  const r = effectiveSoundRadius(baseSoundRadius(SoundKind.step), 0.8, surf.stepRangeMult);
  assert.ok(Math.abs(r - 800 * 0.8 * surf.stepRangeMult) < 1e-9);
  assert.equal(surfaceOf(TERRAIN.SHALLOW).material, "water");
});

test("sound occlusion: the walls-only index holds wall kinds only and blocks through buildings", () => {
  const w = getWallIndex(m);
  assert.equal(getWallIndex(m), w, "cached per MapData");
  const walls = m.rects.filter((r) => WALL_KINDS.includes(r.k));
  assert.equal(w.rects.length, walls.length);
  assert.equal(w.circles.length, 0);
  const b = m.buildings.find((x) => x.rooms.length > 0)!;
  const room = b.rooms[0]!;
  const cx = room.x + room.w / 2, cy = room.y + room.h / 2;
  // From well outside the building to the room centre: at least the outer wall is crossed
  // somewhere along one of the four axis rays (doors may line up with one of them).
  const far = 3000;
  const hits = [[cx - far, cy], [cx + far, cy], [cx, cy - far], [cx, cy + far]]
    .map(([x, y]) => countOccluders(w, x!, y!, cx, cy, 3, SOLID.MOVE));
  assert.ok(Math.max(...hits) >= 1, `hits ${hits}`);
});

test("environment: envConfigOf(BattleState, MapData) drives sampleEnv", () => {
  const st = new BattleState();
  st.envSeed = 1234;
  st.durationMs = 30 * 60_000;
  st.todStartMin = 720;
  const cfg = envConfigOf(st, m);
  assert.equal(cfg.mapW, m.width);
  const e = sampleEnv(cfg, 60_000);
  const mult = visionRangeMult(e.vis);
  assert.ok(mult >= 0.4 && mult <= 1);
  assert.ok(e.hear > 0);
});

test("extracts: masks fit SelfState.extractMask (uint8) and exclude the own side", () => {
  assert.ok(m.extracts.length <= 8);
  const self = new SelfState();
  for (const side of [0, 1, 2, 3] as MapSide[]) {
    const mask = extractMask(m, side);
    self.extractMask = mask;
    assert.equal(self.extractMask, mask);
    m.extracts.forEach((e, i) => {
      if (e.side === side) assert.equal(mask & (1 << i), 0, `side ${side} may use own extract ${e.id}`);
    });
  }
});

test("containers: every kind has a fungible table of real stackable defs", () => {
  for (const k of CONTAINER_KINDS) {
    const t = CONTAINER_LOOT[k];
    assert.ok(t.length > 0, k);
    for (const e of t) {
      const d = itemDef(e.def);
      assert.ok(d, `${k}: ${e.def}`);
      assert.equal(d!.unique, false, `${k}: uniques come from the pool only (${e.def})`);
      assert.notEqual(e.def, "junk_dogtag");
      assert.ok(e.weight > 0 && e.qty >= 1 && e.qty <= d!.stack, `${k}: ${e.def}`);
    }
  }
});

test("containers: rolls are deterministic per (seed, idx), valid, and some come out empty", () => {
  let empty = 0, items = 0;
  m.containers.forEach((spot, i) => {
    const a = rollContainerFungibles(42, i, spot);
    assert.deepEqual(rollContainerFungibles(42, i, spot), a);
    assert.ok(a.length <= CONTAINER.ROLLS[spot.tier]!);
    for (const it of a) {
      const d = itemDef(it.def)!;
      assert.ok(it.qty >= 1 && it.qty <= d.stack);
      assert.ok(CONTAINER_LOOT[spot.kind].some((e) => e.def === it.def));
    }
    if (a.length === 0) empty++;
    items += a.length;
    const ms = containerOpenMs(spot);
    assert.ok(ms >= SEARCH.OPEN_MS.tier[0]! && ms <= SEARCH.OPEN_MS.tier[4]! + SEARCH.OPEN_MS.safeExtra);
  });
  // Tarkov-like: a real share searches empty, most hold something.
  assert.ok(empty > m.containers.length * 0.1 && empty < m.containers.length * 0.6, `empty ${empty}`);
  assert.ok(items > m.containers.length * 0.45, `items ${items}`); // LOOT_TRIM: was 0.5 before the × 0.9 drop cut
  // A different match seed reshuffles contents.
  const diff = m.containers.filter((s, i) =>
    JSON.stringify(rollContainerFungibles(42, i, s)) !== JSON.stringify(rollContainerFungibles(43, i, s))).length;
  assert.ok(diff > m.containers.length * 0.3, `diff ${diff}`);
});

test("containerOpenMs: tier delay, safes take longer", () => {
  assert.equal(containerOpenMs({ kind: "crate", tier: 0 }), SEARCH.OPEN_MS.cache);
  assert.equal(containerOpenMs({ kind: "safe", tier: 3 }), SEARCH.OPEN_MS.tier[3]! + SEARCH.OPEN_MS.safeExtra);
  assert.equal(containerOpenMs({ kind: "pc", tier: 9 }), SEARCH.OPEN_MS.tier[4]);
});
