/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/ground-chunks.test.ts
 *
 * Chunk range math, the LRU, deterministic bake keys, per-chunk buckets, and a frame-by-frame
 * simulation of the real cache policy (ChunkCache) walking the 28,672 px map (map v2).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WORLD, generateMap, legacyMapData, mapHash, mulberry32 } from "@extract/shared";
import { PROP_VARIANTS } from "@extract/shared";
import { Texture } from "pixi.js";
import { SPRITE_NAMES } from "./assets";
import {
  BUCKET_MARGIN,
  CAR_ART,
  CRATE_ART,
  FENCE_ART,
  FURNITURE_ART,
  facingSprite,
  ChunkCache,
  ChunkLRU,
  bakeKey,
  buildChunkBuckets,
  chunkGridOf,
  chunkKey,
  chunkSpan,
  chunkXY,
  chunksInRect,
  nextBake,
  propHash,
  type ViewRect,
} from "./ground-chunks";

const map = generateMap("steppe");
const grid = chunkGridOf(map);
/** Chunks per side (28 on map v2). */
const N = grid.cols;
/** The renderer's view: 1600 × 900 world px at zoom 1, padded by CULL_MARGIN 160. */
const HALF_W = 800 + 160;
const HALF_H = 450 + 160;
const viewAt = (x: number, y: number): ViewRect => ({ x0: x - HALF_W, y0: y - HALF_H, x1: x + HALF_W, y1: y + HALF_H });

describe("chunk grid", () => {
  it("is 28 × 28 on the map v2 Steppe and 5 × 5 on the legacy 4800 px map", () => {
    assert.deepEqual(grid, { chunk: WORLD.CHUNK, cols: 28, rows: 28 });
    assert.deepEqual(chunkGridOf(legacyMapData(7)), { chunk: 1024, cols: 5, rows: 5 });
  });

  it("keys round-trip and are dense", () => {
    const seen = new Set<number>();
    for (let cy = 0; cy < grid.rows; cy++) {
      for (let cx = 0; cx < grid.cols; cx++) {
        const k = chunkKey(grid, cx, cy);
        assert.deepEqual(chunkXY(grid, k), { cx, cy });
        seen.add(k);
      }
    }
    assert.equal(seen.size, N * N);
    assert.equal(Math.max(...seen), N * N - 1);
  });

  it("span clamps to the grid and treats chunk edges as half-open", () => {
    assert.deepEqual(chunkSpan(grid, -5000, -5000, 1023, 1023.9), { cx0: 0, cy0: 0, cx1: 0, cy1: 0 });
    assert.deepEqual(chunkSpan(grid, 1024, 1024, 2047, 2048), { cx0: 1, cy0: 1, cx1: 1, cy1: 2 });
    assert.deepEqual(chunkSpan(grid, 0, 0, 1e9, 1e9), { cx0: 0, cy0: 0, cx1: N - 1, cy1: N - 1 });
  });

  it("a padded 1600 × 900 view touches at most 3 × 3 chunks, nearest first", () => {
    const rng = mulberry32(42);
    for (let i = 0; i < 5000; i++) {
      const x = rng() * map.width;
      const y = rng() * map.height;
      const v = viewAt(x, y);
      const keys = chunksInRect(grid, v.x0, v.y0, v.x1, v.y1, x, y);
      assert.ok(keys.length >= 1 && keys.length <= 9, `${keys.length} chunks at ${x},${y}`);
      const d = keys.map((k) => {
        const { cx, cy } = chunkXY(grid, k);
        return ((cx + 0.5) * 1024 - x) ** 2 + ((cy + 0.5) * 1024 - y) ** 2;
      });
      for (let j = 1; j < d.length; j++) assert.ok(d[j - 1]! <= d[j]!);
      const { cx, cy } = chunkXY(grid, keys[0]!);
      assert.equal(cx, Math.min(N - 1, Math.floor(x / 1024)));
      assert.equal(cy, Math.min(N - 1, Math.floor(y / 1024)));
    }
  });

  it("reuses the output array (no per-frame allocation)", () => {
    const out: number[] = [];
    const a = chunksInRect(grid, 0, 0, 3000, 3000, 0, 0, out);
    assert.equal(a, out);
    chunksInRect(grid, 5000, 5000, 5001, 5001, 5000, 5000, out);
    assert.equal(out.length, 1);
  });

  it("visible + prefetch always fit the 16-chunk LRU", () => {
    const rng = mulberry32(7);
    const cache = new ChunkCache<number>(grid, 16, 640);
    for (let i = 0; i < 3000; i++) {
      const x = rng() * map.width;
      const y = rng() * map.height;
      const a = rng() * Math.PI * 2;
      cache.plan(viewAt(x, y), x, y, Math.cos(a), Math.sin(a));
      const union = new Set([...cache.visible, ...cache.prefetch]);
      assert.ok(union.size <= 16, `${union.size} wanted chunks`);
    }
  });
});

describe("bake keys", () => {
  it("are deterministic, unique per chunk and resolution, and pinned to the layout hash", () => {
    const h = mapHash(map);
    const keys = new Set<string>();
    for (let cy = 0; cy < N; cy++) for (let cx = 0; cx < N; cx++) keys.add(bakeKey(map, h, cx, cy, 1));
    assert.equal(keys.size, N * N);
    assert.equal(bakeKey(map, h, 3, 4, 1), bakeKey(generateMap("steppe"), mapHash(generateMap("steppe")), 3, 4, 1));
    assert.notEqual(bakeKey(map, h, 3, 4, 1), bakeKey(map, h, 3, 4, 0.5));
    assert.notEqual(bakeKey(map, h, 3, 4, 1), bakeKey(map, "deadbeef", 3, 4, 1));
    assert.notEqual(bakeKey(map, h, 3, 4, 1), bakeKey({ ...map, genVersion: map.genVersion + 1 }, h, 3, 4, 1));
    assert.match(bakeKey(map, h, 3, 4, 1), /^steppe@\d+#[0-9a-f]{8}\/3,4x1$/);
  });

  it("prop variety hash is deterministic and in [0, 1)", () => {
    for (let i = 0; i < 1000; i++) {
      const v = propHash(i * 37, i * 91, i % 5);
      assert.ok(v >= 0 && v < 1);
      assert.equal(v, propHash(i * 37, i * 91, i % 5));
    }
  });
});

describe("ChunkLRU", () => {
  it("evicts least recently used, skipping pinned keys", () => {
    const lru = new ChunkLRU<string>(3);
    lru.set(1, "a");
    lru.set(2, "b");
    lru.set(3, "c");
    assert.equal(lru.victim(() => false), 1);
    lru.touch(1); // 2 is now the oldest
    assert.equal(lru.victim(() => false), 2);
    assert.equal(lru.victim((k) => k === 2), 3);
    assert.equal(lru.victim(() => true), undefined);
    assert.equal(lru.get(3), "c"); // get() refreshes too
    assert.deepEqual([...lru.keys()], [2, 1, 3]);
    assert.equal(lru.delete(2), "b");
    assert.equal(lru.size, 2);
    assert.equal(lru.peek(1), "a");
    assert.deepEqual([...lru.keys()], [1, 3]); // peek does not refresh
  });
});

describe("nextBake", () => {
  const none = () => undefined;
  it("bakes missing visible chunks first, in the given (nearest-first) order", () => {
    const cached = new Set([5]);
    assert.equal(nextBake([5, 6, 7], [8], (k) => cached.has(k), 1, 16, none), 6);
  });

  it("prefetches only with free capacity or an unwanted victim", () => {
    const cached = new Set([1, 2]);
    const has = (k: number) => cached.has(k);
    assert.equal(nextBake([1, 2], [3], has, 2, 16, none), 3);
    // Full cache whose only entries are wanted: no prefetch (no thrash).
    assert.equal(nextBake([1], [2, 3], has, 2, 2, (pin) => [1, 2].find((k) => !pin(k))), -1);
    // Full cache with an unwanted old chunk: prefetch may replace it.
    assert.equal(nextBake([1], [3], has, 2, 2, (pin) => [2, 1].find((k) => !pin(k))), 3);
    assert.equal(nextBake([1, 2], [], has, 2, 16, none), -1);
  });
});

describe("ChunkCache streaming (1 bake per frame, LRU 16)", () => {
  /** Walk the zone-centre tour at `speed` px/s for `seconds`, 60 fps, the way GroundChunks does. */
  function walk(speed: number, seconds: number) {
    const cache = new ChunkCache<{ key: number }>(grid, 16, 640);
    const route = map.zones.map((z) => ({ x: z.rect.x + z.rect.w / 2, y: z.rect.y + z.rect.h / 2 }));
    let x = route[0]!.x;
    let y = route[0]!.y;
    let ri = 1;
    let bakes = 0;
    let missFrames = 0;
    let evictedVisible = 0;
    const screen: number[] = [];
    const bake = (k: number) => {
      const slot = cache.evict() ?? { key: -1 };
      if (slot.key >= 0 && cache.isVisible(slot.key)) evictedVisible++;
      slot.key = k;
      cache.put(k, slot);
      bakes++;
    };
    // Loading screen: everything visible is baked up front.
    cache.plan(viewAt(x, y), x, y);
    for (const k of [...cache.visible]) bake(k);
    const dt = 1 / 60;
    for (let f = 0; f < seconds * 60; f++) {
      const t = route[ri % route.length]!;
      const dx = t.x - x, dy = t.y - y, d = Math.hypot(dx, dy);
      let vx = 0, vy = 0;
      if (d < 40) ri++;
      else {
        vx = dx / d;
        vy = dy / d;
      }
      x += vx * speed * dt;
      y += vy * speed * dt;
      cache.plan(viewAt(x, y), x, y, vx, vy);
      const k = cache.next();
      if (k >= 0) bake(k);
      // What the player sees: the unpadded 1600 × 900 screen after this frame's bake.
      for (const q of chunksInRect(grid, x - 800, y - 450, x + 800, y + 450, x, y, screen)) {
        if (!cache.lru.has(q)) {
          missFrames++;
          break;
        }
      }
      assert.ok(cache.lru.size <= 16, "LRU over capacity");
    }
    return { bakes, missFrames, evictedVisible };
  }

  it("never shows an unbaked chunk at run speed and never evicts a visible one", () => {
    const r = walk(260, 120);
    assert.equal(r.missFrames, 0);
    assert.equal(r.evictedVisible, 0);
    assert.ok(r.bakes > 20, `only ${r.bakes} bakes in 2 min`);
  });

  it("keeps up at 3× run speed (roll spam / spectator camera)", () => {
    const r = walk(780, 60);
    assert.equal(r.missFrames, 0);
    assert.equal(r.evictedVisible, 0);
  });

  it("does not re-bake while standing still", () => {
    const cache = new ChunkCache<{ key: number }>(grid, 16, 640);
    const x = 9000, y = 9000;
    cache.plan(viewAt(x, y), x, y);
    for (const k of [...cache.visible]) cache.put(k, { key: k });
    for (let f = 0; f < 600; f++) {
      cache.plan(viewAt(x, y), x, y);
      assert.equal(cache.next(), -1);
    }
  });
});

describe("chunk buckets", () => {
  const b = buildChunkBuckets(map, grid);

  it("list every object in every chunk its grown box overlaps (and nowhere else)", () => {
    const check = (list: number[][], n: number, box: (i: number) => { x: number; y: number; w: number; h: number }) => {
      for (let i = 0; i < n; i += 7) {
        const r = box(i);
        const s = chunkSpan(grid, r.x - BUCKET_MARGIN, r.y - BUCKET_MARGIN, r.x + r.w + BUCKET_MARGIN, r.y + r.h + BUCKET_MARGIN);
        for (let cy = 0; cy < N; cy++) {
          for (let cx = 0; cx < N; cx++) {
            const inside = cx >= s.cx0 && cx <= s.cx1 && cy >= s.cy0 && cy <= s.cy1;
            assert.equal(list[chunkKey(grid, cx, cy)]!.includes(i), inside);
          }
        }
      }
    };
    check(b.rects, map.rects.length, (i) => map.rects[i]!);
    check(b.circles, map.circles.length, (i) => {
      const c = map.circles[i]!;
      return { x: c.x - c.r, y: c.y - c.r, w: 2 * c.r, h: 2 * c.r };
    });
    check(b.buildings, map.buildings.length, (i) => map.buildings[i]!.floor);
  });

  it("the map border reaches every edge chunk", () => {
    for (let c = 0; c < N; c++) {
      for (const [cx, cy] of [[c, 0], [c, N - 1], [0, c], [N - 1, c]] as const) {
        assert.ok(b.rects[chunkKey(grid, cx, cy)]!.some((i) => map.rects[i]!.k === "border"), `edge chunk ${cx},${cy}`);
      }
    }
  });

  it("keeps per-chunk work small (props per bake)", () => {
    let max = 0;
    for (let k = 0; k < N * N; k++) max = Math.max(max, b.rects[k]!.length + b.circles[k]!.length + b.decals[k]!.length);
    assert.ok(max < 200, `max ${max} objects in one chunk`);
  });
});

describe("map v2 prop art", () => {
  it("every variant list matches PROP_VARIANTS and names a loaded sprite", () => {
    assert.equal(CRATE_ART.length, PROP_VARIANTS.crate.length);
    assert.equal(CAR_ART.length, PROP_VARIANTS.car.length);
    assert.equal(FENCE_ART.length, PROP_VARIANTS.fence.length);
    for (const n of [...CRATE_ART, ...CAR_ART, ...FENCE_ART, ...Object.values(FURNITURE_ART)]) {
      assert.ok((SPRITE_NAMES as readonly string[]).includes(n!), `${n} is loaded by assets.ts`);
    }
    // Every furniture kind the generator places has art.
    const kinds = new Set(map.rects.map((r) => r.k));
    for (const k of ["desk", "sofa", "armchair", "bed", "counter", "lockers"] as const) {
      assert.ok(kinds.has(k), `${k} on the map`);
      assert.ok(FURNITURE_ART[k], `${k} art`);
    }
  });

  it("facingSprite turns the art's back onto the wall side it stands against", () => {
    const r = { x: 100, y: 200, w: 144, h: 64 };
    const v = { x: 100, y: 200, w: 64, h: 144 };
    const cases = [
      { side: 0, rect: r, at: [172, 198] },
      { side: 1, rect: v, at: [166, 272] },
      { side: 2, rect: r, at: [172, 266] },
      { side: 3, rect: v, at: [98, 272] },
    ] as const;
    for (const c of cases) {
      const s = facingSprite(Texture.EMPTY, "sofa", c.rect, c.side);
      assert.ok(Math.abs(s.rotation - (c.side * Math.PI) / 2) < 1e-9, `side ${c.side} rotation`);
      assert.deepEqual([s.position.x, s.position.y], c.at, `side ${c.side} anchored on its wall`);
      s.destroy();
    }
  });
});
