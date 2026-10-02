/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/hud.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BattleState, buildCollisionIndex, GroundItem } from "@extract/shared";
import { interactHint, stickyCounts } from "./hud";

describe("stickyCounts", () => {
  it("follows the live count while the raid runs", () => {
    let c = stickyCounts(null, { phase: "drop", aliveCount: 16, totalPlayers: 16 });
    assert.deepEqual(c, { alive: 16, total: 16 });
    c = stickyCounts(c, { phase: "open", aliveCount: 5, totalPlayers: 16 });
    assert.deepEqual(c, { alive: 5, total: 16 });
  });

  it("keeps the last running count after the end-of-raid timeout empties the map", () => {
    const c = stickyCounts({ alive: 3, total: 16 }, { phase: "ended", aliveCount: 0, totalPlayers: 16 });
    assert.deepEqual(c, { alive: 3, total: 16 });
  });

  it("survives a cleared state", () => {
    const c = stickyCounts({ alive: 4, total: 16 }, { phase: "open", aliveCount: 0, totalPlayers: 0 });
    assert.deepEqual(c, { alive: 4, total: 16 });
  });
});

describe("interactHint", () => {
  function setup(items: Array<Partial<GroundItem>>) {
    const state = new BattleState();
    items.forEach((fields, i) => {
      const it = Object.assign(new GroundItem(), { id: `i${i}` }, fields);
      state.items.set(it.id, it);
    });
    return state;
  }
  const armorItem = (armor: number, armorDur: number, x: number) => ({ kind: "armor", armor, armorDur, x, y: 500 });

  it("does not offer armor the server would refuse (the old armor dropped after an upgrade)", () => {
    const state = setup([armorItem(1, 80, 1030)]);
    assert.equal(interactHint(state, 1000, 500, { armor: 2, armorDur: 130 }), null);
    assert.equal(interactHint(state, 1000, 500, { armor: 1, armorDur: 80 }), null, "same level, no better");
    assert.match(interactHint(state, 1000, 500, { armor: 1, armorDur: 40 }) ?? "", /Armor L1/);
    assert.match(interactHint(state, 1000, 500, { armor: 0, armorDur: 0 }) ?? "", /Armor L1/);
  });

  it("names the weapon F picks up when nearer armor is not an upgrade", () => {
    const state = setup([armorItem(1, 80, 1030), { kind: "weapon", weapon: "shotgun", rarity: 1, x: 1070, y: 500 }]);
    assert.match(interactHint(state, 1000, 500, { armor: 2, armorDur: 999 }) ?? "", /Shotgun/);
  });

  it("breaks distance ties like the server (the later item wins)", () => {
    const state = setup([
      { kind: "weapon", weapon: "rifle", x: 1040, y: 500 },
      { kind: "weapon", weapon: "sniper", x: 960, y: 500 },
    ]);
    assert.match(interactHint(state, 1000, 500, { armor: 0, armorDur: 0 }) ?? "", /Sniper/);
  });

  it("ignores items behind a wall when the collision index is known", () => {
    const idx = buildCollisionIndex({ rects: [{ x: 1020, y: 0, w: 24, h: 1000 }], circles: [] }, 2000, 1000);
    const state = setup([{ kind: "weapon", weapon: "rifle", x: 1070, y: 500 }]);
    assert.match(interactHint(state, 1000, 500, { armor: 0, armorDur: 0 }) ?? "", /rifle/i);
    assert.equal(interactHint(state, 1000, 500, { armor: 0, armorDur: 0 }, idx), null);
  });
});
