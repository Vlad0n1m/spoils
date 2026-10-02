/** Pure tests: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/lobby/loadout-model.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { LoadoutEntry } from "@extract/shared";
import {
  bagCapacity,
  draftFromLocked,
  freeStacks,
  freeUniques,
  placeStack,
  placeUnique,
  pruneDraft,
  removeAt,
  sameLoadout,
  setStackQty,
  validateDraft,
  type StashView,
} from "./loadout-model";

const u = (id: string, def: string, over: Partial<{ rarity: number; dur: number; state: string }> = {}) => ({
  id,
  def,
  rarity: over.rarity ?? 0,
  dur: over.dur ?? 100,
  state: over.state ?? "in_stash",
});

const STASH: StashView = {
  uniques: [
    u("w-rifle", "rifle", { rarity: 2 }),
    u("w-shot", "shotgun"),
    u("w-sniper", "sniper", { rarity: 3 }),
    u("a1", "armor_1"),
    u("a2", "armor_2"),
    u("bp1", "backpack_1"),
    u("bp3", "backpack_3"),
    u("listed", "rifle", { state: "listed" }),
    u("worn", "shotgun", { dur: 0 }),
  ],
  stacks: { ammo_light: 150, bandage: 7, medkit: 1 },
};

function must(r: ReturnType<typeof placeUnique>): LoadoutEntry[] {
  assert.ok(r.ok, `expected ok, got ${JSON.stringify(r)}`);
  return r.entries;
}

test("weapons fill w1, w2, then a pocket; each unique only once", () => {
  let e: LoadoutEntry[] = [];
  e = must(placeUnique(e, STASH.uniques[0]!));
  e = must(placeUnique(e, STASH.uniques[1]!));
  e = must(placeUnique(e, STASH.uniques[2]!));
  assert.deepEqual(
    e.map((x) => [x.key, x.def]),
    [
      ["w1", "rifle"],
      ["w2", "shotgun"],
      ["p0", "sniper"],
    ],
  );
  const again = placeUnique(e, STASH.uniques[0]!);
  assert.equal(again.ok, false);
  assert.ok(validateDraft(e, STASH).ok);
});

test("listed and worn-out items are not placeable and not offered", () => {
  assert.equal(placeUnique([], u("listed", "rifle", { state: "listed" })).ok, false);
  assert.equal(placeUnique([], u("worn", "shotgun", { dur: 0 })).ok, false);
  const offered = freeUniques(STASH, []).map((x) => x.id);
  assert.ok(!offered.includes("listed") && !offered.includes("worn"));
});

test("armor replaces the equipped armor instead of going into a pocket", () => {
  let e = must(placeUnique([], STASH.uniques[3]!));
  e = must(placeUnique(e, STASH.uniques[4]!));
  assert.deepEqual(e, [{ key: "armor", itemId: "a2", def: "armor_2", qty: 1 }]);
});

test("stacks merge first, then fill empty slots; bag slots need a backpack", () => {
  let r = placeStack([], "ammo_light", 150);
  assert.ok(r.ok);
  assert.deepEqual(r.entries, [{ key: "p0", def: "ammo_light", qty: 60 }]);
  // 4 pockets of 60 would need 240; the stash has 150 so the third click takes the last 30.
  r = placeStack(r.entries, "ammo_light", freeStacks(STASH, r.entries).ammo_light!);
  assert.ok(r.ok);
  r = placeStack(r.entries, "ammo_light", freeStacks(STASH, r.entries).ammo_light!);
  assert.ok(r.ok);
  assert.deepEqual(
    r.entries.map((x) => [x.key, x.qty]),
    [
      ["p0", 60],
      ["p1", 60],
      ["p2", 30],
    ],
  );
  assert.equal(freeStacks(STASH, r.entries).ammo_light, 0);
  assert.equal(placeStack(r.entries, "ammo_light", 0).ok, false);
  // Partial stack gets topped up before a new slot is used.
  let b = placeStack([], "bandage", 7, 2);
  assert.ok(b.ok);
  b = placeStack(b.entries, "bandage", 5, 4);
  assert.ok(b.ok);
  assert.deepEqual(
    b.entries.map((x) => [x.key, x.qty]),
    [
      ["p0", 5],
      ["p1", 1],
    ],
  );
  assert.ok(validateDraft(b.entries, STASH).ok);
});

test("pockets full → bag slots once a backpack is equipped", () => {
  let e: LoadoutEntry[] = [
    { key: "p0", def: "bandage", qty: 5 },
    { key: "p1", def: "medkit", qty: 1 },
    { key: "p2", def: "ammo_light", qty: 60 },
    { key: "p3", def: "ammo_light", qty: 60 },
  ];
  assert.equal(placeStack(e, "ammo_light", 30).ok, false, "no backpack, no room");
  e = must(placeUnique(e, STASH.uniques[5]!));
  const r = placeStack(e, "ammo_light", 30);
  assert.ok(r.ok);
  assert.ok(r.entries.some((x) => x.key === "b0" && x.qty === 30));
  assert.equal(bagCapacity(r.entries), 6);
  assert.ok(validateDraft(r.entries, STASH).ok);
});

test("removing the backpack returns its contents; a smaller backpack keeps what fits", () => {
  let e = must(placeUnique([], STASH.uniques[6]!)); // backpack_3: 16 slots
  e = [...e, ...Array.from({ length: 8 }, (_, i) => ({ key: `b${i}` as const, def: "bandage", qty: 1 }))];
  assert.equal(bagCapacity(e), 16);
  const smaller = must(placeUnique(e, STASH.uniques[5]!)); // backpack_1: 6 slots
  assert.equal(smaller.filter((x) => x.key.startsWith("b") && x.key !== "bp").length, 6);
  assert.deepEqual(removeAt(e, "bp"), []);
});

test("stack stepper clamps to the slot size and to the stash", () => {
  const e: LoadoutEntry[] = [
    { key: "p0", def: "bandage", qty: 5 },
    { key: "p1", def: "bandage", qty: 1 },
  ];
  assert.equal(setStackQty(e, "p1", 9, STASH).find((x) => x.key === "p1")!.qty, 2, "7 in stash − 5 elsewhere");
  assert.deepEqual(setStackQty(e, "p1", 0, STASH), [{ key: "p0", def: "bandage", qty: 5 }]);
  assert.equal(setStackQty(e, "p0", 99, STASH).find((x) => x.key === "p0")!.qty, 5);
});

test("pruneDraft drops gone uniques, trims stacks and orphaned bag slots", () => {
  const stale: LoadoutEntry[] = [
    { key: "w1", itemId: "listed", def: "rifle", qty: 1 },
    { key: "w2", itemId: "w-shot", def: "shotgun", qty: 1 },
    { key: "p0", def: "medkit", qty: 2 },
    { key: "b0", def: "bandage", qty: 3 },
    { key: "p1", def: "junk_gpu", qty: 1 },
  ];
  const p = pruneDraft(stale, STASH);
  assert.deepEqual(p, [
    { key: "w2", itemId: "w-shot", def: "shotgun", qty: 1 },
    { key: "p0", def: "medkit", qty: 1 },
  ]);
  assert.ok(validateDraft(p, STASH).ok);
});

test("validateDraft catches what the API would reject", () => {
  const v = validateDraft([{ key: "p0", def: "medkit", qty: 3 }], STASH);
  assert.equal(v.ok, false);
  assert.equal(!v.ok && v.code, "bad_qty");
  const v2 = validateDraft(
    [
      { key: "p0", def: "bandage", qty: 5 },
      { key: "p1", def: "bandage", qty: 5 },
    ],
    STASH,
  );
  assert.equal(!v2.ok && v2.code, "not_enough");
});

test("sameLoadout / draftFromLocked round trip", () => {
  const locked = [
    { key: "w1", uid: "w-rifle", def: "rifle", qty: 1 },
    { key: "p0", uid: "", def: "bandage", qty: 3 },
  ];
  const d = draftFromLocked(locked);
  assert.ok(sameLoadout(d, locked));
  assert.ok(!sameLoadout([...d.slice(0, 1), { key: "p0", def: "bandage", qty: 2 }], locked));
  assert.ok(!sameLoadout(d.slice(0, 1), locked));
});
