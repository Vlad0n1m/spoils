/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/entities.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Container } from "pixi.js";
import { RARITY_COLORS, type EventsMsg } from "@extract/shared";
import { DAMAGE_ARC, DamageArcSystem, ROLL_ANIM_MS, containerSprite, damageArcAlpha, rollSpin } from "./entities";
import type { GameContext } from "./systems";

describe("rollSpin", () => {
  it("turns once over the roll, easing in and out", () => {
    assert.equal(rollSpin(0), 0);
    assert.ok(Math.abs(rollSpin(ROLL_ANIM_MS / 2) - Math.PI) < 1e-9);
    assert.equal(rollSpin(ROLL_ANIM_MS), 2 * Math.PI);
    assert.equal(rollSpin(ROLL_ANIM_MS * 3), 2 * Math.PI);
    assert.ok(rollSpin(ROLL_ANIM_MS * 0.1) < 2 * Math.PI * 0.1, "slow start");
  });
});

describe("containerSprite", () => {
  it("maps tiers 0..4 to the crate and the four chest rarities", () => {
    assert.equal(containerSprite(0).sprite, "crate");
    assert.equal(containerSprite(1).sprite, "chest_common");
    assert.equal(containerSprite(4).sprite, "chest_legendary");
    assert.equal(containerSprite(4).color, RARITY_COLORS[3]);
    assert.equal(containerSprite(99).sprite, "chest_legendary");
    assert.equal(containerSprite(-3).sprite, "crate");
  });
});

describe("damage arcs", () => {
  it("hold, then fade out over their life; bigger hits are brighter", () => {
    assert.equal(damageArcAlpha(-1, 10), 0);
    assert.equal(damageArcAlpha(DAMAGE_ARC.LIFE_MS, 10), 0);
    assert.ok(damageArcAlpha(100, 30) > damageArcAlpha(100, 5));
    assert.equal(damageArcAlpha(100, 10), damageArcAlpha(300, 10), "flat while fresh");
    assert.ok(damageArcAlpha(DAMAGE_ARC.LIFE_MS * 0.9, 10) < damageArcAlpha(100, 10));
    assert.ok(damageArcAlpha(0, 1000) <= 1);
  });

  function fakeCtx(): GameContext {
    const screen = new Container();
    return {
      room: { sessionId: "me" },
      layers: { ground: new Container(), worldFx: new Container(), worldTop: new Container(), screen },
      selfPos: () => ({ x: 0, y: 0 }),
      toScreen: () => ({ x: 800, y: 450 }),
    } as unknown as GameContext;
  }

  it("adds an arc only for hits on the local player that carry fa, and pools them", () => {
    const sys = new DamageArcSystem();
    const ctx = fakeCtx();
    sys.init(ctx);
    const root = ctx.layers.screen.children[0] as Container;
    const ev = (hits: NonNullable<EventsMsg["hits"]>): EventsMsg => ({ hits });
    sys.onEvents(ev([{ t: "other", s: "me", x: 0, y: 0, d: 10, ar: false, fa: 1 }]), ctx);
    sys.onEvents(ev([{ t: "me", s: "", x: 0, y: 0, d: 10, ar: false }]), ctx);
    assert.equal(root.children.length, 0, "no arc for others' hits or without fa");
    sys.onEvents(ev([{ t: "me", s: "x", x: 0, y: 0, d: 12, ar: false, fa: Math.PI / 2 }]), ctx);
    assert.equal(root.children.length, 1);
    assert.equal(root.children[0]!.rotation, Math.PI / 2);
    sys.frame(16, ctx);
    assert.equal(root.position.x, 800);
    for (let i = 0; i < 20; i++) sys.onEvents(ev([{ t: "me", s: "x", x: 0, y: 0, d: 5, ar: false, fa: i / 10 }]), ctx);
    assert.ok(root.children.filter((c) => c.visible).length <= DAMAGE_ARC.MAX);
    sys.dispose();
    sys.dispose();
  });
});
