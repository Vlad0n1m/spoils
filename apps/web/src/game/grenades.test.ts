/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/grenades.test.ts
 * Weapons v2 hand grenades on the client: the wire guard, the flight replayed from the server's
 * polyline (same deceleration as shared grenadePath), the throw range from the cursor, the
 * explosion frames and the warning pulse.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Container } from "pixi.js";
import { GRENADE, SOLID, buildCollisionIndex, grenadePath, grenadeThrowPx } from "@extract/shared";
import { EXPLOSION_FRAMES, EXPLOSION_FRAME_MS } from "./assets";
import {
  GRENADE_TAP_FRAC,
  LINGER_MS,
  createGrenadeSystem,
  explosionFrame,
  grenadeDecel,
  grenadeFracFor,
  grenadePoseAt,
  parseBoomMsg,
  parseGrenadeMsg,
  warnStrength,
} from "./grenades";
import type { GameContext } from "./systems";

/** The wire form the server sends (grenade.ts grenadeMsg: x / y to 0.1 px, t to 1 ms). */
function wire(path: ReturnType<typeof grenadePath>): number[] {
  const p: number[] = [];
  for (const q of path) p.push(Math.round(q.x * 10) / 10, Math.round(q.y * 10) / 10, Math.round(q.t));
  return p;
}

const OPEN = buildCollisionIndex({ rects: [], circles: [] }, 4000, 4000);
const WALLED = buildCollisionIndex({ rects: [{ x: 1200, y: 1000, w: 24, h: 1000, f: SOLID.ALL }], circles: [] }, 4000, 4000);

describe("parseGrenadeMsg / parseBoomMsg", () => {
  it("accepts the server's messages and rejects malformed ones", () => {
    const ok = { id: 3, s: "abc", p: [1000, 1500, 0, 1400, 1500, 600], fuse: 2500, at: 0 };
    assert.deepEqual(parseGrenadeMsg(ok), ok);
    assert.deepEqual(parseGrenadeMsg({ id: 4, s: "", p: [1, 2, 600], fuse: 2500, at: 700 })?.p, [1, 2, 600]);
    for (const bad of [
      null,
      "x",
      { ...ok, id: "3" },
      { ...ok, s: 1 },
      { ...ok, p: [1, 2] },
      { ...ok, p: [1, 2, 0, 3, NaN, 5] },
      { ...ok, p: [1, 2, 600, 3, 4, 100] }, // time runs backwards
      { ...ok, p: new Array(3 * 40).fill(0) },
      { ...ok, fuse: 0 },
      { ...ok, fuse: 60_000 },
      { ...ok, at: -1 },
    ]) {
      assert.equal(parseGrenadeMsg(bad), null, JSON.stringify(bad));
    }
    assert.deepEqual(parseBoomMsg({ id: 1, x: 2, y: 3 }), { id: 1, x: 2, y: 3 });
    assert.equal(parseBoomMsg({ id: 1, x: "2", y: 3 }), null);
  });
});

describe("flight replay", () => {
  it("recovers the server's deceleration and follows the open throw exactly", () => {
    const d = grenadeThrowPx(0.7);
    const path = grenadePath(OPEN, 1000, 1500, 0, d);
    const p = wire(path);
    const a = grenadeDecel(p);
    const F = GRENADE.FLIGHT_MS;
    // Server: v0 = 2d/F (px/ms), a = v0/F.
    assert.ok(Math.abs(a - (2 * d) / (F * F)) < 1e-6, `a ${a}`);
    for (const t of [0, 50, 150, 300, 450, 599]) {
      const v0 = (2 * d) / F;
      const want = 1000 + v0 * t - (a * t * t) / 2;
      const pose = grenadePoseAt(p, a, t);
      assert.ok(Math.abs(pose.x - want) < 0.2, `t ${t}: ${pose.x} vs ${want}`);
      assert.equal(pose.y, 1500);
    }
    const rest = grenadePoseAt(p, a, 5000);
    assert.equal(rest.x, 1000 + d);
    assert.equal(rest.moving, false);
    assert.equal(rest.hop, 0);
    // The hop peaks half way through the first segment (in time).
    assert.ok(grenadePoseAt(p, a, 300).hop > 0.99);
  });

  it("bounces where the server bounced and rests where it rests", () => {
    const path = grenadePath(WALLED, 1000, 1500, 0, grenadeThrowPx(1));
    assert.ok(path.length >= 3 && path[1]!.bounce);
    const p = wire(path);
    const a = grenadeDecel(p);
    const b = grenadePoseAt(p, a, Math.round(path[1]!.t));
    assert.ok(Math.abs(b.x - path[1]!.x) < 0.2, `bounce ${b.x} vs ${path[1]!.x}`);
    // After the bounce it moves back west, slower, and never runs backwards in time.
    let prev = b.x;
    for (let t = Math.round(path[1]!.t) + 10; t <= path[path.length - 1]!.t; t += 10) {
      const x = grenadePoseAt(p, a, t).x;
      assert.ok(x <= prev + 1e-9, `t ${t}: ${x} after ${prev}`);
      prev = x;
    }
    const end = grenadePoseAt(p, a, 3000);
    assert.ok(Math.abs(end.x - path[path.length - 1]!.x) < 0.2);
    assert.equal(grenadePoseAt(p, a, Math.round(path[1]!.t) + 20).hop, 0, "no hop after the first wall");
  });

  it("a landing copy (one point) just rests there", () => {
    const pose = grenadePoseAt([700, 800, 650], 0, 1000);
    assert.deepEqual([pose.x, pose.y, pose.moving], [700, 800, false]);
  });
});

describe("throw range, explosion frames, warning", () => {
  it("grenadeFracFor inverts grenadeThrowPx and clamps", () => {
    for (const f of [0, 0.25, 0.5, 1]) assert.ok(Math.abs(grenadeFracFor(grenadeThrowPx(f)) - f) < 1e-9);
    assert.equal(grenadeFracFor(10), 0);
    assert.equal(grenadeFracFor(5000), 1);
    assert.equal(grenadeFracFor(NaN), 1);
    assert.ok(grenadeThrowPx(GRENADE_TAP_FRAC) > GRENADE.MIN_PX && grenadeThrowPx(GRENADE_TAP_FRAC) < GRENADE.MAX_PX);
  });

  it("8 explosion frames of EXPLOSION_FRAME_MS, then done", () => {
    assert.equal(explosionFrame(0), 0);
    assert.equal(explosionFrame(EXPLOSION_FRAME_MS - 1), 0);
    assert.equal(explosionFrame(EXPLOSION_FRAME_MS), 1);
    assert.equal(explosionFrame(EXPLOSION_FRAMES * EXPLOSION_FRAME_MS - 1), EXPLOSION_FRAMES - 1);
    assert.equal(explosionFrame(EXPLOSION_FRAMES * EXPLOSION_FRAME_MS), -1);
  });

  it("the warning shows only over the last WARN_MS and never fades out right before the blast", () => {
    assert.equal(warnStrength(GRENADE.WARN_MS + 1), 0);
    assert.equal(warnStrength(-1), 0);
    for (let left = 0; left < 250; left += 10) assert.ok(warnStrength(left) >= 0.6 * 0.45, `left ${left}`);
    for (let left = 0; left <= GRENADE.WARN_MS; left += 25) {
      const w = warnStrength(left);
      assert.ok(w > 0 && w <= 1, `left ${left}: ${w}`);
    }
  });
});

describe("grenade system", () => {
  it("adds a thrown grenade, replaces a landing copy by the full flight, removes it on its blast, drops a silent one after the fuse", () => {
    const worldFx = new Container();
    const worldTop = new Container();
    let aim: { angle: number; frac: number } | null = null;
    const ctx = {
      layers: { worldFx, worldTop, ground: new Container(), screen: new Container() },
      map: () => null,
      selfPos: () => ({ x: 1000, y: 1500 }),
      grenadeAim: () => aim,
    } as unknown as GameContext;
    const sys = createGrenadeSystem();
    sys.init!(ctx);
    const root = worldFx.children[0] as Container;
    const nades = root.children[2] as Container;
    const count = () => nades.children.length / 2; // body + shadow per grenade
    sys.onEvents!({ nades: [{ id: 1, s: "", p: [1400, 1500, 600], fuse: 2500, at: 700 }] }, ctx);
    assert.equal(count(), 1);
    sys.onEvents!({ nades: [{ id: 1, s: "a", p: [1000, 1500, 0, 1400, 1500, 600], fuse: 2500, at: 0 }] }, ctx);
    assert.equal(count(), 1, "the full flight replaced the landing copy");
    sys.onEvents!({ nades: [{ id: 1, s: "", p: [1400, 1500, 600], fuse: 2500, at: 700 }] }, ctx);
    assert.equal(count(), 1, "a late landing copy is a duplicate");
    sys.onEvents!({ nades: [{ id: 2, s: "", p: [1, 2, 3], fuse: 2500, at: 0 }, { id: 3, bad: true }] as never }, ctx);
    assert.equal(count(), 2, "malformed messages are ignored");
    sys.frame!(16, ctx);
    sys.onEvents!({ booms: [{ id: 1, x: 1400, y: 1500 }] }, ctx);
    assert.equal(count(), 1, "the blast removed grenade 1");
    // Grenade 2 never gets its BoomMsg: gone LINGER_MS after the fuse.
    const realNow = performance.now;
    const t0 = realNow.call(performance);
    try {
      performance.now = () => t0 + 2500 + LINGER_MS + 50;
      sys.frame!(16, ctx);
    } finally {
      performance.now = realNow;
    }
    assert.equal(count(), 0);
    aim = { angle: 0, frac: 0.5 };
    sys.frame!(16, ctx); // no map yet: the preview waits, nothing throws
    sys.dispose();
    sys.dispose();
  });
});
