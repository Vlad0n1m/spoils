/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/shots.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCollisionIndex, PLAYER, WEAPONS } from "@extract/shared";
import { DelayQueue, shotCentre, tracerLengths } from "./shots";

// A 24 px wall (map WALL_THICKNESS) at x = 1500..1524.
const idx = buildCollisionIndex({ rects: [{ x: 1500, y: 0, w: 24, h: 3000 }], circles: [] }, 3000, 3000);
const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

describe("tracerLengths", () => {
  it("draws nothing when the muzzle pokes through a wall the shooter is pressed against", () => {
    const cx = 1500 - PLAYER.RADIUS;
    for (const w of ["rifle", "shotgun", "sniper"] as const) {
      const def = WEAPONS[w];
      assert.equal(tracerLengths(idx, cx, 500, cx + def.muzzle, 500, [0], def.range), null, w);
    }
  });

  it("stops at the wall counted from the centre, like the server's bullets", () => {
    const def = WEAPONS.pistol;
    const cx = 1500 - PLAYER.RADIUS; // muzzle 44 px ahead ends inside the wall
    const lens = tracerLengths(idx, cx, 500, cx + def.muzzle, 500, [0], def.range);
    assert.equal(lens, null);
    const far = 1000;
    const walls: boolean[] = [];
    const l2 = tracerLengths(idx, far, 500, far + def.muzzle, 500, [0, Math.PI], def.range, walls)!;
    assert.ok(close(l2[0]!, 1500 - far - def.muzzle), `len=${l2[0]}`);
    // The pellet toward the wall stops at a solid (impact puff); the one away from it does not.
    assert.deepEqual(walls, [true, false]);
  });

  it("is the weapon range minus the muzzle offset in the open", () => {
    const def = WEAPONS.rifle;
    const lens = tracerLengths(idx, 200, 500, 200, 500 - def.muzzle, [-Math.PI / 2], def.range)!;
    assert.ok(close(lens[0]!, def.range - def.muzzle), `len=${lens[0]}`);
    assert.ok(close(tracerLengths(null, 0, 0, def.muzzle, 0, [0], def.range)![0]!, def.range - def.muzzle));
  });

  it("measures the muzzle along each pellet's own direction", () => {
    const def = WEAPONS.shotgun;
    const a = [-0.2, 0, 0.2];
    const lens = tracerLengths(null, 0, 0, def.muzzle, 0, a, def.range)!;
    a.forEach((ang, i) => assert.ok(close(lens[i]!, def.range - def.muzzle * Math.cos(ang))));
  });
});

describe("shotCentre", () => {
  it("recovers the centre from the muzzle along the mean pellet angle when it is missing", () => {
    const c = shotCentre({ s: "a", w: "rifle", x: 100 + 58, y: 200, a: [0.01, -0.01], cx: NaN, cy: NaN }, 58);
    assert.ok(close(c.x, 100) && close(c.y, 200), JSON.stringify(c));
  });

  it("prefers an explicit centre when the message carries one", () => {
    const m = { s: "a", w: "rifle" as const, x: 158, y: 200, a: [0.05], cx: 100, cy: 200 };
    assert.deepEqual(shotCentre(m, 58), { x: 100, y: 200 });
  });
});

describe("DelayQueue", () => {
  it("runs entries once they are due, in order, with the flush time", () => {
    const q = new DelayQueue();
    const ran: Array<[string, number]> = [];
    q.push(100, (t) => ran.push(["a", t]));
    q.push(150, (t) => ran.push(["b", t]));
    q.flush(99);
    assert.deepEqual(ran, []);
    q.flush(120);
    assert.deepEqual(ran, [["a", 120]]);
    q.flush(500);
    assert.deepEqual(ran, [["a", 120], ["b", 500]]);
    assert.equal(q.size, 0);
  });

  it("drops the oldest entries past its capacity and clears", () => {
    const q = new DelayQueue(2);
    const ran: number[] = [];
    for (let i = 0; i < 4; i++) q.push(i, () => ran.push(i));
    q.flush(10);
    assert.deepEqual(ran, [2, 3]);
    q.push(0, () => ran.push(9));
    q.clear();
    q.flush(10);
    assert.deepEqual(ran, [2, 3]);
  });
});
