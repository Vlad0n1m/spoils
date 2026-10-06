/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/touch-controls.test.ts
 * Pure parts only: stick maths and the button layout around the touch HUD and the thumb zones.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AIM_FROM,
  BUTTON_DISC,
  GRENADE_DRAG_EDGE_PX,
  GRENADE_DRAG_FROM,
  GRENADE_DRAG_MIN_SPAN,
  GRENADE_DRAG_SPAN,
  dragRoom,
  grenadeDragAim,
  CLUSTER_REACH,
  STICK_KEEP,
  STICK_RADIUS,
  TOUCH_BUTTONS,
  TOUCH_MIN_SIZE,
  aimFromStick,
  hudReservedRects,
  distToRect,
  layoutTouchButtons,
  minimapRect,
  rectsOverlap,
  stickRest,
  stickVector,
  thumbZone,
} from "./touch-controls";
import { bossBarY } from "./boss-hud";
import { zoneToastY } from "./fullmap";

/** Landscape phones / tablets in CSS px (the Seeker is ~915 × 412). */
const SCREENS: Array<[number, number]> = [
  [915, 412],
  [872, 392],
  [851, 393],
  [800, 360],
  [780, 360],
  [740, 360],
  [932, 430],
  [844, 390],
  [1024, 600],
  [1280, 800],
];

describe("touch sticks", () => {
  it("the aim stick aims from AIM_FROM and never fires by itself (auto-fire.ts does)", () => {
    assert.equal(aimFromStick(0, 0), null);
    assert.equal(aimFromStick(AIM_FROM * 0.9, 0), null);
    const a = aimFromStick(0, AIM_FROM + 0.01);
    assert.ok(a !== null && Math.abs(a - Math.PI / 2) < 1e-9);
    assert.ok(Math.abs(aimFromStick(-1, 0)! - Math.PI) < 1e-9, "full deflection only aims");
    assert.equal(aimFromStick(NaN, 0), null);
  });

  it("both sticks rest in their thumb corners, clear of the screen edges and of every button", () => {
    for (const [w, h] of SCREENS) {
      const tz = thumbZone(w, h);
      const buttons = [...layoutTouchButtons(w, h).values()];
      for (const side of ["left", "right"] as const) {
        const r = stickRest(side, w, h);
        const ring = { x: r.x - STICK_RADIUS, y: r.y - STICK_RADIUS, w: 2 * STICK_RADIUS, h: 2 * STICK_RADIUS };
        assert.ok(ring.x >= 0 && ring.y >= 0 && ring.x + ring.w <= w && ring.y + ring.h <= h, `${w}×${h} ${side}: ring on screen`);
        assert.ok(r.y >= h - tz.h, `${w}×${h} ${side}: in the thumb zone's rows`);
        assert.ok(side === "left" ? r.x <= tz.w : r.x >= w - tz.w, `${w}×${h} ${side}: in its corner`);
        for (const b of buttons) assert.ok(distToRect(r.x, r.y, b) >= STICK_RADIUS, `${w}×${h} ${side}: a button covers the resting stick`);
        const bar = hudReservedRects(w, h).find((a) => a.id === "bar")!;
        assert.ok(!rectsOverlap(ring, bar), `${w}×${h} ${side}: the resting stick under the bottom bar`);
      }
    }
  });

  it("clamps the finger offset to the stick radius", () => {
    assert.deepEqual(stickVector(0, 0), { x: 0, y: 0 });
    assert.deepEqual(stickVector(STICK_RADIUS / 2, 0), { x: 0.5, y: 0 });
    const v = stickVector(STICK_RADIUS * 3, STICK_RADIUS * 4);
    assert.ok(Math.abs(v.x - 0.6) < 1e-9 && Math.abs(v.y - 0.8) < 1e-9);
  });
});

describe("touch grenade button (Weapons v2)", () => {
  it("a short drag is a tap, a longer one aims and sets the range", () => {
    assert.equal(grenadeDragAim(0, 0), null);
    assert.equal(grenadeDragAim(GRENADE_DRAG_FROM - 1, 0), null);
    const near = grenadeDragAim(0, GRENADE_DRAG_FROM)!;
    assert.ok(Math.abs(near.angle - Math.PI / 2) < 1e-9);
    assert.equal(near.frac, 0);
    assert.equal(grenadeDragAim(-(GRENADE_DRAG_FROM + GRENADE_DRAG_SPAN / 2), 0)!.frac, 0.5);
    assert.equal(grenadeDragAim(500, 500)!.frac, 1);
    assert.equal(grenadeDragAim(NaN, 3), null);
    // Toward a near edge (button 45 px from the left edge): full range before the finger leaves the screen.
    const room = dragRoom(45, 300, Math.PI, 844, 390);
    assert.equal(room, 45);
    assert.equal(grenadeDragAim(-(room - GRENADE_DRAG_EDGE_PX), 0, room)!.frac, 1);
    assert.ok(grenadeDragAim(-30, 0, room)!.frac > 0.5);
    // Plenty of room: the normal span.
    assert.equal(grenadeDragAim(GRENADE_DRAG_FROM + GRENADE_DRAG_SPAN / 2, 0, dragRoom(45, 300, 0, 844, 390))!.frac, 0.5);
    // Up against the edge: never a zero span.
    assert.equal(grenadeDragAim(-(GRENADE_DRAG_FROM + GRENADE_DRAG_MIN_SPAN), 0, 0)!.frac, 1);
    assert.ok(Math.abs(dragRoom(100, 100, Math.PI / 4, 844, 390) - 290 * Math.SQRT2) < 1e-6);
  });

  it("sits in the combat cluster around the aim stick", () => {
    const g = TOUCH_BUTTONS.find((b) => b.id === "grenade");
    assert.ok(g && g.group === "cluster");
  });
});

describe("touch button layout", () => {
  for (const [w, h] of SCREENS) {
    it(`${w}×${h}: every button placed, on its side, clear of the HUD and of each other`, () => {
      const rects = layoutTouchButtons(w, h);
      const hud = hudReservedRects(w, h);
      assert.equal(rects.size, TOUCH_BUTTONS.length, `placed: ${[...rects.keys()].join(",")}`);
      const placed = [...rects.entries()];
      for (const [id, r] of placed) {
        const spec = TOUCH_BUTTONS.find((b) => b.id === id)!;
        // Hit area ≥ 40 px (44 on Seeker-class screens, below), the visible disc smaller.
        assert.ok(r.w >= TOUCH_MIN_SIZE && TOUCH_MIN_SIZE >= 40 && r.w === r.h, `${id} size ${r.w}`);
        assert.ok(r.w * BUTTON_DISC < r.w && r.w * BUTTON_DISC >= 32, `${id} disc ${r.w * BUTTON_DISC}`);
        assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= w && r.y + r.h <= h, `${id} on screen`);
        assert.ok(r.w >= 44, `${id} hit area ${r.w} ≥ 44 px`);
        if (spec.group === "cluster") {
          assert.ok(r.x >= w / 2, `${id} right half`);
          const c = stickRest("right", w, h);
          assert.ok(Math.hypot(r.x + r.w / 2 - c.x, r.y + r.h / 2 - c.y) <= CLUSTER_REACH, `${id} near the aim stick`);
        } else {
          const mm = minimapRect(w, h);
          assert.ok(r.y > mm.y + mm.h && r.y < mm.y + mm.h + 16, `${id} in the row under the minimap`);
          assert.ok(r.x >= w / 2 && r.x + r.w <= mm.x + mm.w, `${id} right-aligned under the minimap`);
        }
        for (const a of hud) {
          if (a.soft) continue;
          assert.ok(!rectsOverlap(r, a), `${id} covers HUD ${a.id}`);
        }
      }
      for (let i = 0; i < placed.length; i++) {
        for (let j = i + 1; j < placed.length; j++) {
          assert.ok(!rectsOverlap(placed[i]![1], placed[j]![1]), `${placed[i]![0]} overlaps ${placed[j]![0]}`);
        }
      }
    });
  }

  it("Seeker-class screens: full size, and the kill feed, hint and extract ring stay clear too", () => {
    for (const [w, h] of [[915, 412], [872, 392], [851, 393], [1024, 600]] as const) {
      const rects = layoutTouchButtons(w, h);
      const hud = hudReservedRects(w, h);
      for (const spec of TOUCH_BUTTONS) {
        const r = rects.get(spec.id)!;
        if (w === 915) assert.equal(r.w, spec.size, `${spec.id} at its preferred size`);
        assert.ok(r.w >= 44, `${w}×${h}: ${spec.id} hit area ${r.w} ≥ 44 px`);
        for (const a of hud) assert.ok(!rectsOverlap(r, a), `${w}×${h}: ${spec.id} covers ${a.id}`);
      }
    }
  });

  it("the wipe / boss stack at the top centre is never covered", () => {
    for (const [w, h] of SCREENS) {
      const top = hudReservedRects(w, h).find((a) => a.id === "top")!;
      // The touch HUD's top stack is ≤ 21.5 rem wide and ~190 px tall (timer, compass, wipe banner,
      // boss toast), drawn at 80 %; the boss bar (canvas) hangs below it on short screens.
      assert.ok(top.w >= Math.min(w - 24, 344) * 0.8 && top.h >= 190 * 0.8, "reserves the timer, wipe banner and boss toast");
      assert.ok(top.h >= bossBarY(h) + 12, "and the boss bar");
      for (const r of layoutTouchButtons(w, h).values()) assert.ok(!rectsOverlap(r, top));
    }
  });

  it("no button sits where a thumb lands to start a stick (move corner, aim stick ring)", () => {
    for (const [w, h] of SCREENS) {
      const tz = thumbZone(w, h);
      const corner = { x: 0, y: h - tz.h, w: tz.w, h: tz.h };
      const aim = stickRest("right", w, h);
      assert.ok(tz.w >= 136 && tz.h >= 140, `${w}×${h}: thumb zone ${tz.w}×${tz.h}`);
      for (const [id, r] of layoutTouchButtons(w, h)) {
        assert.ok(!rectsOverlap(r, corner), `${w}×${h}: ${id} in the move thumb's corner`);
        assert.ok(distToRect(aim.x, aim.y, r) >= STICK_KEEP, `${w}×${h}: ${id} too close to the aim stick`);
      }
    }
  });

  it("the same arc on every phone: use left of the stick, reload above it, roll between", () => {
    for (const [w, h] of [[740, 360], [800, 360], [844, 390], [915, 412], [932, 430]] as const) {
      const rects = layoutTouchButtons(w, h);
      const c = stickRest("right", w, h);
      const ang = (id: "roll" | "interact" | "reload") => {
        const r = rects.get(id)!;
        return ((Math.atan2(r.y + r.h / 2 - c.y, r.x + r.w / 2 - c.x) * 180) / Math.PI + 360) % 360;
      };
      assert.ok(ang("interact") < ang("roll") && ang("roll") < ang("reload"), `${w}×${h}: arc order`);
      assert.ok(ang("interact") >= 160 && ang("interact") <= 215, `${w}×${h}: use ${ang("interact")}`);
      assert.ok(ang("reload") >= 240 && ang("reload") <= 300, `${w}×${h}: reload ${ang("reload")}`);
      const top = (["bandage", "medkit", "inventory", "map"] as const).map((id) => rects.get(id)!);
      for (let i = 1; i < top.length; i++) assert.ok(top[i]!.x > top[i - 1]!.x && top[i]!.y === top[0]!.y, `${w}×${h}: top row order`);
    }
  });

  it("short screens: boss bar and zone toast sit below the compact timer + compass (≈70 px)", () => {
    for (const h of [360, 390, 412]) {
      // top-1.5 + 80 % of (timer 36 + gap 8 + compass 36) ≈ 70 px; the bar's name label is ~22 px above it.
      assert.ok(bossBarY(h) - 22 >= 6 + 0.8 * 80, `boss bar ${bossBarY(h)}`);
      assert.ok(zoneToastY(h) >= bossBarY(h) + 20, `zone toast ${zoneToastY(h)}`);
    }
  });

  it("an empty or zero-size mount places nothing", () => {
    assert.equal(layoutTouchButtons(0, 400).size, 0);
    assert.equal(layoutTouchButtons(900, NaN).size, 0);
  });
});
