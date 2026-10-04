/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/combat-fx.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NPC_ROLE } from "@extract/shared";
import {
  DMG_NUM,
  HIT_FLASH,
  HP_REVEAL,
  KILL_POP,
  RECOIL_ANIM,
  ZOOM_PUNCH,
  chipFraction,
  damageNumberPose,
  damageNumberStyle,
  hitFlashAlpha,
  hpBarAlpha,
  killPopLabel,
  killPopPose,
  nextStreak,
  recoilOffset,
  zoomPunch,
} from "./combat-fx";

describe("recoil", () => {
  it("jumps back fast, then returns to rest", () => {
    assert.equal(recoilOffset(0, 6), 0);
    assert.equal(recoilOffset(RECOIL_ANIM.ATTACK_MS, 6), 6);
    assert.ok(recoilOffset(100, 6) < 2);
    assert.equal(recoilOffset(RECOIL_ANIM.END_MS, 6), 0);
    assert.equal(recoilOffset(-5, 6), 0);
    assert.equal(recoilOffset(10, 0), 0);
  });
});

describe("hit flash", () => {
  it("starts at the peak and is gone after HIT_FLASH.MS", () => {
    assert.equal(hitFlashAlpha(0), HIT_FLASH.PEAK);
    assert.ok(hitFlashAlpha(60) < HIT_FLASH.PEAK && hitFlashAlpha(60) > 0);
    assert.equal(hitFlashAlpha(HIT_FLASH.MS), 0);
    assert.equal(hitFlashAlpha(Number.POSITIVE_INFINITY), 0);
  });
});

describe("HP bar reveal and damage chip", () => {
  it("holds 2 s, then fades; never-hit targets stay hidden", () => {
    assert.equal(hpBarAlpha(0), 1);
    assert.equal(hpBarAlpha(HP_REVEAL.HOLD_MS), 1);
    assert.ok(hpBarAlpha(HP_REVEAL.HOLD_MS + HP_REVEAL.FADE_MS / 2) < 1);
    assert.equal(hpBarAlpha(HP_REVEAL.HOLD_MS + HP_REVEAL.FADE_MS), 0);
    assert.equal(hpBarAlpha(Number.POSITIVE_INFINITY), 0);
  });

  it("chip holds the old HP, then drains to the new one", () => {
    assert.equal(chipFraction(0.8, 0.5, 0), 0.8);
    assert.equal(chipFraction(0.8, 0.5, HP_REVEAL.CHIP_HOLD_MS), 0.8);
    const mid = chipFraction(0.8, 0.5, HP_REVEAL.CHIP_HOLD_MS + HP_REVEAL.CHIP_DRAIN_MS / 2);
    assert.ok(mid < 0.8 && mid > 0.5);
    assert.equal(chipFraction(0.8, 0.5, 10_000), 0.5);
    // Healing: no chip.
    assert.equal(chipFraction(0.4, 0.6, 0), 0.6);
  });
});

describe("damage numbers", () => {
  it("colours armor, big hits and damage taken; grows with damage", () => {
    assert.equal(damageNumberStyle(10, false, false).color, DMG_NUM.COLOR.flesh);
    assert.equal(damageNumberStyle(10, true, false).color, DMG_NUM.COLOR.armor);
    assert.equal(damageNumberStyle(DMG_NUM.BIG, true, false).color, DMG_NUM.COLOR.big);
    assert.equal(damageNumberStyle(80, false, true).color, DMG_NUM.COLOR.taken);
    assert.ok(damageNumberStyle(60, false, false).size > damageNumberStyle(8, false, false).size);
  });

  it("pops big, settles, rises and fades out", () => {
    const o = { dy: 0, scale: 0, alpha: 0 };
    assert.ok(damageNumberPose(0, 0, o));
    assert.ok(o.scale > 1.5 && o.alpha === 1 && o.dy === 0);
    assert.ok(damageNumberPose(400, 400, o));
    assert.ok(Math.abs(o.scale - 1) < 0.02 && o.dy < -20);
    assert.ok(damageNumberPose(DMG_NUM.LIFE_MS - 10, 50, o));
    assert.ok(o.alpha < 0.05 && o.scale > 1.2);
    assert.equal(damageNumberPose(DMG_NUM.LIFE_MS, 0, o), false);
  });
});

describe("zoom punch", () => {
  it("peaks at the amount and settles to 0", () => {
    assert.equal(zoomPunch(0), 0);
    assert.ok(Math.abs(zoomPunch(ZOOM_PUNCH.ATTACK_MS) - ZOOM_PUNCH.AMOUNT) < 1e-9);
    assert.ok(zoomPunch(300) < 0.3 * ZOOM_PUNCH.AMOUNT);
    assert.equal(zoomPunch(ZOOM_PUNCH.END_MS), 0);
    assert.equal(zoomPunch(Number.POSITIVE_INFINITY), 0);
  });
});

describe("kill pop", () => {
  it("names NPCs by role and humans by name", () => {
    assert.equal(killPopLabel("Marauder", NPC_ROLE.MARAUDER).title, "MARAUDER DOWN");
    assert.equal(killPopLabel("Elevator thug", NPC_ROLE.GUARD).title, "GUARD DOWN");
    assert.equal(killPopLabel("Foreman", NPC_ROLE.BOSS).sub, "FOREMAN");
    const h = killPopLabel("Vlad", undefined);
    assert.equal(h.title, "+Vlad");
    assert.equal(h.sub, "ELIMINATED");
    assert.ok(killPopLabel("A".repeat(40), 0).title.length <= KILL_POP.NAME_MAX + 1);
  });

  it("counts streaks inside the window", () => {
    assert.equal(nextStreak(Number.NEGATIVE_INFINITY, 0, 1000), 1);
    assert.equal(nextStreak(1000, 1, 2000), 2);
    assert.equal(nextStreak(1000, 2, 1000 + KILL_POP.STREAK_MS + 1), 1);
  });

  it("pops in, holds and fades", () => {
    const o = { scale: 0, alpha: 0, dy: 0 };
    assert.ok(killPopPose(0, o) && o.scale > 1.5);
    assert.ok(killPopPose(500, o) && o.scale === 1 && o.alpha === 1);
    assert.ok(killPopPose(KILL_POP.HOLD_MS + KILL_POP.FADE_MS - 1, o) && o.alpha < 0.01);
    assert.equal(killPopPose(KILL_POP.HOLD_MS + KILL_POP.FADE_MS, o), false);
  });
});
