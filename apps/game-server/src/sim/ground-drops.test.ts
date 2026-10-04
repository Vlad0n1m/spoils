/**
 * Security audit: player drops are bounded. Single-round INV_DROP spam used to create one ground
 * entity per round (thousands per player), which overflowed state patches and grew the tick cost.
 * Now a fungible drop joins the dropper's own pile nearby (up to one full stack), and a user may
 * have at most GROUND_DROPS_PER_USER separate items on the ground.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ITEM_FLAG, itemDef } from "@extract/shared";
import { GROUND_DROPS_PER_USER, GROUND_MERGE_PX } from "./inventory.js";
import type { Match } from "./match.js";
import { giveItem, ids, place, rtOf, selfOf, testMatch } from "./test-utils.js";

/** Drop, bypassing the op bucket (this is about the ground, not the rate limit). */
function drop(m: Match, id: string, msg: Parameters<Match["invDrop"]>[1]) {
  rtOf(m, id).opsBucket.tokens = 20;
  return m.invDrop(id, msg);
}

function piles(m: Match, def: string): number[] {
  return [...m.ground.all()].filter((g) => g.item.def === def).map((g) => g.item.qty).sort((x, y) => y - x);
}

test("single-round drops join the dropper's pile up to one stack; the next stack starts a new pile", () => {
  const m = testMatch(1);
  const [a] = ids(m) as [string];
  place(m, a, 1000, 1500);
  const stack = itemDef("ammo_light")!.stack;
  giveItem(m, a, "ammo_light", "p0", { qty: stack });
  giveItem(m, a, "ammo_light", "p1", { qty: 30 });
  for (let i = 0; i < stack; i++) assert.equal(drop(m, a, { key: "p0", uid: "", def: "ammo_light", qty: 1 }), null);
  assert.deepEqual(piles(m, "ammo_light"), [stack], "one entity for a whole stack of single rounds");
  for (let i = 0; i < 30; i++) assert.equal(drop(m, a, { key: "p1", uid: "", def: "ammo_light", qty: 1 }), null);
  assert.deepEqual(piles(m, "ammo_light"), [stack, 30]);
  assert.equal(m.ground.dropsOf(rtOf(m, a)), 2);
  // Far from both piles: a new pile.
  giveItem(m, a, "ammo_light", "p2", { qty: 5 });
  place(m, a, 1000 + GROUND_MERGE_PX * 3, 1500);
  assert.equal(drop(m, a, { key: "p2", uid: "", def: "ammo_light", qty: 5 }), null);
  assert.deepEqual(piles(m, "ammo_light"), [stack, 30, 5]);
});

test("another player's pile is never merged into", () => {
  const m = testMatch(2);
  const [a, b] = ids(m) as [string, string];
  place(m, a, 1000, 1500);
  place(m, b, 1010, 1500);
  giveItem(m, a, "ammo_light", "p0", { qty: 3 });
  giveItem(m, b, "ammo_light", "p0", { qty: 3 });
  assert.equal(drop(m, a, { key: "p0", uid: "", def: "ammo_light", qty: 3 }), null);
  assert.equal(drop(m, b, { key: "p0", uid: "", def: "ammo_light", qty: 3 }), null);
  assert.deepEqual(piles(m, "ammo_light"), [3, 3]);
});

test("past GROUND_DROPS_PER_USER separate items a drop is refused (ground_full) unless it merges; a pickup frees room", () => {
  const m = testMatch(1);
  const [a] = ids(m) as [string];
  place(m, a, 2000, 2000);
  giveItem(m, a, "ammo_light", "p0", { qty: 10 });
  assert.equal(drop(m, a, { key: "p0", uid: "", def: "ammo_light", qty: 1 }), null);
  for (let i = 1; i < GROUND_DROPS_PER_USER; i++) {
    const uid = giveItem(m, a, "rifle", "w1");
    assert.equal(drop(m, a, { key: "w1", uid, def: "rifle" }), null, `rifle ${i}`);
  }
  assert.equal(m.ground.dropsOf(rtOf(m, a)), GROUND_DROPS_PER_USER);
  const uid = giveItem(m, a, "rifle", "w1");
  assert.equal(drop(m, a, { key: "w1", uid, def: "rifle" }), "ground_full");
  assert.equal(selfOf(m, a).slots.get("w1")?.uid, uid, "a refused drop keeps the item");
  assert.equal(drop(m, a, { key: "p0", uid: "", def: "ammo_light", qty: 1 }), null, "joins the ammo pile");
  assert.deepEqual(piles(m, "ammo_light"), [2]);
  // FREE items just vanish: never refused. A normal one that cannot merge is.
  giveItem(m, a, "bandage", "p3", { flags: ITEM_FLAG.FREE });
  assert.equal(drop(m, a, { key: "p3", uid: "", def: "bandage" }), null);
  giveItem(m, a, "bandage", "p3");
  assert.equal(drop(m, a, { key: "p3", uid: "", def: "bandage" }), "ground_full");
  // Picking one of them up frees a slot on the ground.
  const g = [...m.ground.all()].find((x) => x.item.def === "rifle")!;
  place(m, a, g.schema.x, g.schema.y);
  selfOf(m, a).slots.delete("w2");
  assert.ok(m.pickupItem(rtOf(m, a).id, g.schema.id));
  assert.equal(m.ground.dropsOf(rtOf(m, a)), GROUND_DROPS_PER_USER - 1);
  const w = selfOf(m, a).slots.get("w1")!;
  assert.equal(drop(m, a, { key: "w1", uid: w.uid, def: w.def }), null);
});
