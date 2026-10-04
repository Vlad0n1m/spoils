/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/known-empty.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CONTAINER_STATE, ITEM_FLAG } from "@extract/shared";
import { KnownEmpty, lootLooksEmpty, type LootEntryLike } from "./known-empty";
import { interactHint } from "./hud";

function entry(total: number, revealed: number, flags: number[]): LootEntryLike {
  const m = new Map<string, { flags: number }>(flags.map((f, i) => [String(i), { flags: f }]));
  return { total, revealed, slots: { forEach: (cb) => m.forEach((v, k) => cb(v, k)) } };
}

function lootMap(entries: Record<string, LootEntryLike>) {
  return { forEach: (cb: (v: LootEntryLike, k: string) => void) => Object.entries(entries).forEach(([k, v]) => cb(v, k)) };
}

describe("lootLooksEmpty", () => {
  it("needs every slot revealed and nothing takeable left; BROKEN copies do not count", () => {
    assert.equal(lootLooksEmpty(entry(0, 0, [])), true, "nothing was inside");
    assert.equal(lootLooksEmpty(entry(2, 1, [])), false, "still revealing");
    assert.equal(lootLooksEmpty(entry(2, 2, [0])), false, "an item is left");
    assert.equal(lootLooksEmpty(entry(2, 2, [])), true, "all taken");
    assert.equal(lootLooksEmpty(entry(2, 2, [ITEM_FLAG.BROKEN, ITEM_FLAG.BROKEN])), true, "only broken copies left");
    assert.equal(lootLooksEmpty(entry(2, 2, [ITEM_FLAG.BROKEN, 0])), false);
  });
});

describe("KnownEmpty", () => {
  it("remembers emptied containers and bodies seen in its own loot view, and never forgets them", () => {
    const k = new KnownEmpty();
    k.observe(lootMap({ c7: entry(1, 1, []), c8: entry(1, 1, [0]), k3: entry(2, 2, [ITEM_FLAG.BROKEN]) }));
    assert.equal(k.container(7), true);
    assert.equal(k.container(8), false);
    assert.equal(k.corpse("3"), true);
    assert.equal(k.containerState(7, CONTAINER_STATE.OPENED), CONTAINER_STATE.EMPTIED);
    assert.equal(k.containerState(8, CONTAINER_STATE.OPENED), CONTAINER_STATE.OPENED);
    const v = k.version;
    // The entry leaves the view when the search closes: still known empty.
    k.observe(lootMap({}));
    assert.equal(k.container(7), true);
    assert.equal(k.version, v);
  });

  it("drops the F prompt for a container or body this player emptied before the public flag flips", () => {
    const state = {
      containerState: [CONTAINER_STATE.OPENED, CONTAINER_STATE.OPENED],
      corpses: new Map([["5", { x: 200, y: 0, label: "Rex", empty: false }]]),
      items: new Map(),
    };
    const map = { containers: [{ x: 0, y: 0, kind: "pc" as const, tier: 1 as const, zone: null }, { x: 0, y: 30, kind: "fridge" as const, tier: 1 as const, zone: null }] };
    const st = state as unknown as Parameters<typeof interactHint>[0]["state"];
    assert.equal(interactHint({ state: st, map, x: 0, y: 0 }), "F — search Computer");
    const k = new KnownEmpty();
    k.observe(lootMap({ c0: entry(0, 0, []) }));
    assert.equal(interactHint({ state: st, map, x: 0, y: 0, known: k }), "F — search Fridge");
    k.observe(lootMap({ c1: entry(1, 1, []) }));
    assert.equal(interactHint({ state: st, map, x: 0, y: 0, known: k }), null);
    assert.equal(interactHint({ state: st, map, x: 190, y: 0, known: k }), "F — search Rex's body");
    k.observe(lootMap({ k5: entry(1, 1, []) }));
    assert.equal(interactHint({ state: st, map, x: 190, y: 0, known: k }), null);
  });
});
