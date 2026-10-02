import assert from "node:assert/strict";
import { test } from "node:test";
import { SEARCH } from "./constants.js";
import { BACKPACK_SLOTS, ITEM_IDS, POCKET_SLOTS, itemDef } from "./item-defs.js";
import {
  ITEM_FLAG,
  accepts,
  allKeys,
  bagKeys,
  bpLevelOf,
  canMerge,
  canRemoveBackpack,
  consumeKey,
  countOf,
  isBagKey,
  isSlotKey,
  planPlace,
  revealMs,
  storageKeys,
  validateLoadout,
  type ItemLike,
  type PlacePlan,
  type StashUnique,
} from "./inventory.js";
import { mulberry32 } from "./rng.js";

const it = (def: string, qty = 1, flags = 0, extra: Partial<ItemLike> = {}): ItemLike => ({
  uid: itemDef(def)?.unique ? `u-${def}-${Math.random()}` : "", def, qty, rarity: 0, dur: 100, mag: 0, flags, label: "", ...extra,
});
const ok = (p: PlacePlan) => {
  assert.ok(p.ok, JSON.stringify(p));
  return p as Extract<PlacePlan, { ok: true }>;
};

/** Applies a plan to a JS Map store the way the server's bag helpers do. */
function apply(s: Map<string, ItemLike>, item: ItemLike, p: PlacePlan): number {
  if (!p.ok) return 0;
  for (const st of p.steps) {
    const cur = s.get(st.key);
    if (st.merge) cur!.qty += st.qty;
    else s.set(st.key, { ...item, qty: st.qty });
  }
  return p.placed;
}

// Port of the scratchpad prototype test (inv-engine.test.ts), with v2 stack sizes.
test("planPlace: equipment, free pistol, stacks, pockets, backpack", () => {
  const s = new Map<string, ItemLike>();
  s.set("w2", it("pistol", 1, ITEM_FLAG.FREE));
  s.set("p0", it("ammo_light", 36, ITEM_FLAG.FREE));
  let p = ok(planPlace(s, it("rifle")));
  assert.equal(p.steps[0]!.key, "w1");
  s.set("w1", it("rifle"));
  p = ok(planPlace(s, it("rifle")));
  assert.deepEqual(p.steps[0], { key: "w2", qty: 1, merge: false, replacesFree: true }, "second weapon replaces the FREE pistol");
  // Paid ammo never merges with the FREE stack.
  p = ok(planPlace(s, it("ammo_light", 100)));
  assert.deepEqual(p.steps.map((x) => [x.key, x.qty, x.merge]), [["p1", 60, false], ["p2", 40, false]]);
  s.set("p1", it("ammo_light", 50));
  s.set("p2", it("bandage", 5));
  s.set("p3", it("junk_gpu"));
  p = ok(planPlace(s, it("ammo_light", 30)));
  assert.equal(p.placed, 10, "partial stack: the rest stays in the source");
  assert.deepEqual(planPlace(s, it("junk_gpu")), { ok: false, code: "full" });
  p = ok(planPlace(s, it("backpack_1")));
  assert.equal(p.steps[0]!.key, "bp");
  s.set("bp", it("backpack_1"));
  assert.equal(bpLevelOf(s), 1);
  p = ok(planPlace(s, it("junk_gpu")));
  assert.equal(p.steps[0]!.key, "b0");
  s.set("b0", it("junk_gpu"));
  assert.equal(canRemoveBackpack(s), false);
  assert.deepEqual(planPlace(s, it("junk_bolts", 3), 3, "b7"), { ok: false, code: "bad_slot" }, "outside a 6-slot bag");
  assert.deepEqual(planPlace(s, it("rifle", 1, ITEM_FLAG.BROKEN)), { ok: false, code: "broken" });
  assert.equal(countOf(s, "ammo_light"), 86);
});

test("planPlace: merge order is pockets first, labels and FREE bits never mix", () => {
  const s = new Map<string, ItemLike>();
  s.set("bp", it("backpack_2"));
  s.set("b3", it("junk_apple", 2));
  s.set("p2", it("junk_apple", 4));
  let p = ok(planPlace(s, it("junk_apple", 5)));
  assert.deepEqual(p.steps.map((x) => [x.key, x.qty, x.merge]), [["p2", 1, true], ["b3", 3, true], ["p0", 1, false]]);
  // Dog tags have different labels and stack 1: never merged.
  s.set("p0", it("junk_dogtag", 1, 0, { label: "bob", lvl: 3 }));
  p = ok(planPlace(s, it("junk_dogtag", 1, 0, { label: "bob", lvl: 3 })));
  assert.equal(p.steps[0]!.merge, false);
  assert.equal(canMerge(it("bandage", 1, 0, { label: "a" }), it("bandage", 1, 0, { label: "b" })), false);
  assert.equal(canMerge(it("bandage", 1, ITEM_FLAG.FREE), it("bandage")), false);
  assert.equal(canMerge(it("bandage", 1, ITEM_FLAG.FREE), it("bandage", 2, ITEM_FLAG.FREE)), true);
  assert.equal(canMerge(it("bandage"), it("bandage", 1, ITEM_FLAG.BROKEN)), false);
  assert.equal(canMerge(it("rifle"), it("rifle")), false, "uniques never merge");
  assert.equal(canMerge(it("bandage"), it("medkit")), false);
});

test("planPlace with a preferred slot (drag target)", () => {
  const s = new Map<string, ItemLike>();
  s.set("w1", it("pistol", 1, ITEM_FLAG.FREE));
  s.set("w2", it("shotgun"));
  s.set("p0", it("bandage", 4));
  s.set("p1", it("bandage", 5));
  assert.deepEqual(ok(planPlace(s, it("rifle"), 1, "w1")).steps, [{ key: "w1", qty: 1, merge: false, replacesFree: true }]);
  assert.deepEqual(planPlace(s, it("rifle"), 1, "w2"), { ok: false, code: "full" }, "occupied by a paid weapon: caller swaps");
  assert.deepEqual(planPlace(s, it("rifle"), 1, "armor"), { ok: false, code: "bad_slot" });
  assert.deepEqual(planPlace(s, it("bandage", 3), 3, "w1"), { ok: false, code: "bad_slot" });
  assert.deepEqual(ok(planPlace(s, it("bandage", 3), 3, "p0")).steps, [{ key: "p0", qty: 1, merge: true }]);
  assert.deepEqual(planPlace(s, it("bandage", 3), 3, "p1"), { ok: false, code: "full" }, "full stack");
  assert.deepEqual(ok(planPlace(s, it("ammo_light", 90), 90, "p3")).steps, [{ key: "p3", qty: 60, merge: false }]);
  assert.deepEqual(planPlace(s, it("junk_apple"), 1, "b0"), { ok: false, code: "bad_slot" }, "no backpack");
  assert.deepEqual(planPlace(s, it("junk_apple"), 1, "x9" as never), { ok: false, code: "bad_slot" });
});

test("planPlace never mutates and rejects unknown defs and empty quantities", () => {
  const s = new Map<string, ItemLike>([["p0", it("bandage", 2)]]);
  const before = JSON.stringify([...s]);
  planPlace(s, it("bandage", 3));
  planPlace(s, it("rifle"));
  assert.equal(JSON.stringify([...s]), before);
  assert.deepEqual(planPlace(s, it("nope")), { ok: false, code: "bad_slot" });
  assert.deepEqual(planPlace(s, it("bandage"), 0), { ok: false, code: "bad_slot" });
  assert.deepEqual(planPlace(s, it("bandage"), NaN), { ok: false, code: "bad_slot" });
});

test("planPlace fuzz: applying plans never overfills a stack, uses only valid slots, conserves qty", () => {
  const rng = mulberry32(17);
  const defs = ITEM_IDS.filter((d) => itemDef(d)!.cat !== "backpack");
  for (let round = 0; round < 200; round++) {
    const s = new Map<string, ItemLike>();
    if (rng() < 0.8) s.set("bp", it(`backpack_${1 + Math.floor(rng() * 3)}`));
    let carried = 0;
    for (let k = 0; k < 40; k++) {
      const def = defs[Math.floor(rng() * defs.length)]!;
      const d = itemDef(def)!;
      const qty = d.unique ? 1 : 1 + Math.floor(rng() * d.stack * 1.5);
      const flags = rng() < 0.15 ? ITEM_FLAG.FREE : 0;
      const item = it(def, qty, flags);
      const p = planPlace(s, item, qty);
      if (p.ok) {
        assert.ok(p.placed <= qty);
        assert.equal(p.steps.reduce((a, x) => a + x.qty, 0), p.placed);
        if (p.steps.some((x) => x.replacesFree)) continue; // the pistol vanishes: not a plain add
      }
      carried += apply(s, item, p);
    }
    const valid = new Set(allKeys(s));
    let sum = 0;
    for (const [k, v] of s) {
      if (k === "bp") continue;
      assert.ok(valid.has(k as never), `slot ${k} outside the current layout`);
      assert.ok(accepts(k, itemDef(v.def)!), `${v.def} in ${k}`);
      assert.ok(v.qty >= 1 && v.qty <= itemDef(v.def)!.stack, `${v.def} ×${v.qty}`);
      sum += v.qty;
    }
    assert.equal(sum, carried);
  }
});

test("slot keys: pockets, bag slots by level, 'bp' is not a bag slot", () => {
  assert.equal(POCKET_SLOTS, 4);
  assert.deepEqual([...BACKPACK_SLOTS], [0, 6, 10, 16]);
  assert.deepEqual(bagKeys(0), []);
  assert.equal(bagKeys(1).length, 6);
  assert.equal(bagKeys(3).at(-1), "b15");
  assert.deepEqual(bagKeys(7), []);
  assert.equal(isBagKey("bp"), false);
  assert.equal(isBagKey("b0") && isBagKey("b15"), true);
  for (const k of ["w1", "w2", "armor", "bp", "p0", "p3", "b0", "b9", "b10", "b15"]) assert.ok(isSlotKey(k), k);
  for (const k of ["p4", "b16", "b", "w3", "", "constructor", 5]) assert.ok(!isSlotKey(k), String(k));
  const s = new Map<string, ItemLike>([["bp", it("backpack_2")]]);
  assert.deepEqual(storageKeys(s), ["p0", "p1", "p2", "p3", "b0", "b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8", "b9"]);
  assert.deepEqual(allKeys(s).slice(0, 4), ["w1", "w2", "armor", "bp"]);
  assert.equal(canRemoveBackpack(s), true, "an empty backpack can be unequipped");
  assert.equal(canRemoveBackpack(new Map()), true);
});

test("accepts: equipment slots take their category; pockets and bag take anything", () => {
  assert.ok(accepts("w1", itemDef("sniper")!) && !accepts("w1", itemDef("armor_1")!));
  assert.ok(accepts("armor", itemDef("armor_3")!) && !accepts("armor", itemDef("backpack_1")!));
  assert.ok(accepts("bp", itemDef("backpack_3")!) && !accepts("bp", itemDef("junk_gpu")!));
  assert.ok(accepts("p2", itemDef("rifle")!) && accepts("b12", itemDef("backpack_1")!));
  assert.ok(!accepts("b16", itemDef("bandage")!));
});

test("countOf skips broken items; consumeKey prefers FREE stacks, then the smallest", () => {
  const s = new Map<string, ItemLike>();
  s.set("p0", it("ammo_light", 10));
  s.set("p1", it("ammo_light", 3));
  assert.equal(consumeKey(s, "ammo_light"), "p1");
  s.set("p2", it("ammo_light", 30, ITEM_FLAG.FREE));
  assert.equal(consumeKey(s, "ammo_light"), "p2");
  assert.equal(consumeKey(s, "bandage"), undefined);
  s.set("p3", it("ammo_light", 20, ITEM_FLAG.BROKEN));
  assert.equal(countOf(s, "ammo_light"), 43);
  s.set("p1", it("ammo_light", 0));
  s.delete("p2");
  assert.equal(consumeKey(s, "ammo_light"), "p0", "empty and broken stacks are skipped");
});

test("revealMs: uniques by rarity, junk by def rarity, broken fastest", () => {
  assert.equal(revealMs(it("rifle", 1, 0, { rarity: 2 })), SEARCH.REVEAL_UNIQUE_MS + 2 * SEARCH.REVEAL_PER_RARITY_MS);
  assert.equal(revealMs(it("junk_gpu")), SEARCH.REVEAL_JUNK_MS + 3 * SEARCH.REVEAL_JUNK_PER_RARITY_MS);
  assert.equal(revealMs(it("ammo_light", 30)), SEARCH.REVEAL_STACK_MS);
  assert.equal(revealMs(it("rifle", 1, ITEM_FLAG.BROKEN, { rarity: 3 })), SEARCH.REVEAL_BROKEN_MS);
  assert.equal(revealMs(it("mystery")), SEARCH.REVEAL_STACK_MS);
});

test("validateLoadout: authoritative lock checks", () => {
  const uniques = new Map<string, StashUnique>([
    ["u1", { id: "u1", def: "rifle", state: "in_stash", dur: 80 }],
    ["u2", { id: "u2", def: "backpack_1", state: "in_stash", dur: 100 }],
    ["u3", { id: "u3", def: "armor_2", state: "listed", dur: 100 }],
    ["u4", { id: "u4", def: "sniper", state: "in_stash", dur: 0 }],
  ]);
  const good = [
    { key: "b5" as const, def: "bandage", qty: 2 }, // listed before its backpack: order does not matter
    { key: "w1" as const, itemId: "u1", def: "rifle", qty: 1 },
    { key: "bp" as const, itemId: "u2", def: "backpack_1", qty: 1 },
    { key: "p0" as const, def: "bandage", qty: 3 },
  ];
  assert.deepEqual(validateLoadout(good, uniques, { bandage: 5 }), { ok: true });
  assert.deepEqual(validateLoadout(good, uniques, { bandage: 4 }), { ok: false, code: "not_enough", key: "bandage" }, "summed across slots");
  const err = (entries: Parameters<typeof validateLoadout>[0], stacks: Record<string, number> = {}) => {
    const r = validateLoadout(entries, uniques, stacks);
    return r.ok ? "ok" : r.code;
  };
  assert.equal(err([{ key: "b0", def: "bandage", qty: 1 }], { bandage: 5 }), "no_backpack_room");
  assert.equal(err([{ key: "bp", itemId: "u2", def: "backpack_1", qty: 1 }, { key: "b6", def: "bandage", qty: 1 }], { bandage: 5 }), "no_backpack_room");
  assert.equal(err([{ key: "p0", def: "junk_gpu", qty: 1 }]), "bad_item", "junk cannot be brought in");
  assert.equal(err([{ key: "p0", def: "nope", qty: 1 }]), "bad_item");
  assert.equal(err([{ key: "w1", itemId: "u1", def: "rifle", qty: 1 }, { key: "w2", itemId: "u1", def: "rifle", qty: 1 }]), "item_unavailable", "same unique twice");
  assert.equal(err([{ key: "p0", def: "bandage", qty: 1 }, { key: "p0", def: "bandage", qty: 1 }], { bandage: 5 }), "dup_slot");
  assert.equal(err([{ key: "armor", itemId: "u1", def: "rifle", qty: 1 }]), "bad_slot");
  assert.equal(err([{ key: "p9" as never, def: "bandage", qty: 1 }], { bandage: 5 }), "bad_slot");
  assert.equal(err([{ key: "armor", itemId: "u3", def: "armor_2", qty: 1 }]), "item_unavailable", "listed on the market");
  assert.equal(err([{ key: "w1", itemId: "u4", def: "sniper", qty: 1 }]), "item_unavailable", "broken (dur 0)");
  assert.equal(err([{ key: "w1", itemId: "u2", def: "rifle", qty: 1 }]), "item_unavailable", "def mismatch");
  assert.equal(err([{ key: "w1", def: "rifle", qty: 1 }]), "item_unavailable", "no item id");
  assert.equal(err([{ key: "p0", def: "bandage", qty: 0 }], { bandage: 5 }), "bad_qty");
  assert.equal(err([{ key: "p0", def: "bandage", qty: 6 }], { bandage: 9 }), "bad_qty", "over the stack size");
  assert.equal(err([{ key: "p0", def: "bandage", qty: 1.5 }], { bandage: 9 }), "bad_qty");
  assert.equal(err([]), "ok", "an empty loadout is a free-kit raid");
});
