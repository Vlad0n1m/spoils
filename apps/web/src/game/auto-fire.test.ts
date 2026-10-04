/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/auto-fire.test.ts
 * Phone auto-fire: which aim lines count as "on an enemy" (auto-fire.ts).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PLAYER, SOLID, buildCollisionIndex } from "@extract/shared";
import { AUTO_FIRE_MATE_NEAR_PX, AUTO_FIRE_SLACK_PX, autoFireTarget, isPartyMate, type AutoFireCandidate } from "./auto-fire";

const R = PLAYER.RADIUS;
const RANGE = 700;
const enemy = (x: number, y: number, o: Partial<AutoFireCandidate> = {}): AutoFireCandidate => ({
  id: "e",
  x,
  y,
  alive: true,
  visible: true,
  mate: false,
  ...o,
});
const open = buildCollisionIndex({ rects: [], circles: [] }, 2000, 2000);
// A wall (SHOT) at x 300..320 and a window (MOVE|VAULT: bullets pass) at x 600..610, both y 0..400.
const walls = buildCollisionIndex(
  {
    rects: [
      { x: 300, y: 0, w: 20, h: 400, f: SOLID.ALL },
      { x: 600, y: 600, w: 10, h: 400, f: SOLID.WINDOW },
    ],
    circles: [],
  },
  2000,
  2000,
);

describe("auto-fire target", () => {
  it("fires when the aim ray is on a visible enemy in range", () => {
    assert.equal(autoFireTarget(open, 100, 100, 0, RANGE, [enemy(400, 100)])?.id, "e");
    // Diagonal, a bit off the centre but inside the body.
    assert.ok(autoFireTarget(open, 100, 100, Math.PI / 4 + 0.02, RANGE, [enemy(400, 400)]));
  });

  it("does not fire off target: beside the body (past the slack), or behind the player", () => {
    const off = R + AUTO_FIRE_SLACK_PX + 2;
    assert.equal(autoFireTarget(open, 100, 100, 0, RANGE, [enemy(400, 100 + off)]), null);
    assert.ok(autoFireTarget(open, 100, 100, 0, RANGE, [enemy(400, 100 + R + AUTO_FIRE_SLACK_PX - 1)]), "inside the slack");
    assert.equal(autoFireTarget(open, 100, 100, Math.PI, RANGE, [enemy(400, 100)]), null, "aiming away");
    assert.equal(autoFireTarget(open, 100, 100, Math.PI / 2, RANGE, [enemy(400, 100)]), null, "aiming 90° off");
  });

  it("never fires at a party mate, a dead or an invisible target", () => {
    assert.equal(autoFireTarget(open, 100, 100, 0, RANGE, [enemy(400, 100, { mate: true })]), null, "ally");
    assert.equal(autoFireTarget(open, 100, 100, 0, RANGE, [enemy(400, 100, { alive: false })]), null, "dead");
    assert.equal(autoFireTarget(open, 100, 100, 0, RANGE, [enemy(400, 100, { visible: false })]), null, "fogged");
    // A mate in front of an enemy: the enemy behind is the target (bullets pass through mates).
    const t = autoFireTarget(open, 100, 100, 0, RANGE, [enemy(250, 100, { id: "m", mate: true }), enemy(400, 100, { id: "x" })]);
    assert.equal(t?.id, "x");
  });

  it("does not fire out of the weapon's range", () => {
    assert.equal(autoFireTarget(open, 100, 100, 0, 250, [enemy(400, 100)]), null);
    assert.ok(autoFireTarget(open, 100, 100, 0, 300, [enemy(400, 100)]));
    assert.equal(autoFireTarget(open, 100, 100, 0, 0, [enemy(400, 100)]), null, "no weapon range");
  });

  it("a wall blocks the line, a window does not", () => {
    assert.equal(autoFireTarget(walls, 100, 100, 0, RANGE, [enemy(450, 100)]), null, "behind the wall");
    assert.ok(autoFireTarget(walls, 100, 100, 0, RANGE, [enemy(280, 100)]), "in front of the wall");
    assert.ok(autoFireTarget(walls, 400, 800, 0, RANGE, [enemy(800, 800)]), "through the window");
  });

  it("picks the nearest enemy on the line", () => {
    const t = autoFireTarget(open, 0, 0, 0, RANGE, [enemy(500, 0, { id: "far" }), enemy(200, 10, { id: "near" })]);
    assert.equal(t?.id, "near");
  });

  it("party mates: by players-map id, or a human at a mate marker whose id is unknown; NPCs never", () => {
    const ids = new Set(["s1"]);
    assert.equal(isPartyMate("s1", 0, 0, 0, ids, []), true);
    assert.equal(isPartyMate("s2", 0, 0, 0, ids, []), false);
    const marker = [{ id: "", x: 500, y: 500 }];
    assert.equal(isPartyMate("s2", 500 + AUTO_FIRE_MATE_NEAR_PX - 1, 500, 0, ids, marker), true);
    assert.equal(isPartyMate("s2", 500 + AUTO_FIRE_MATE_NEAR_PX + 5, 500, 0, ids, marker), false);
    assert.equal(isPartyMate("s1", 0, 0, 3, ids, marker), false, "an NPC (marauder) is never a mate");
  });
});
