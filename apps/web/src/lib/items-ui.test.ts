/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/items-ui.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ITEM_FLAG, ITEM_IDS, XP_LINE_LABEL, dogTagCr, type ItemLike } from "@extract/shared";
import {
  INV_ERR_TEXT,
  buildReceipt,
  describeItem,
  durInfo,
  fmtCr,
  isKillWeapon,
  itemIcon,
  killWeaponIcon,
  killWeaponName,
  itemValueCr,
  quickTarget,
  recordStore,
  slotLabel,
  xpLineText,
} from "./items-ui";

const item = (def: string, extra: Partial<ItemLike> = {}): ItemLike => ({
  uid: "", def, qty: 1, rarity: 0, dur: 0, mag: 0, flags: 0, label: "", ...extra,
});

describe("describeItem", () => {
  it("names and icons every def from ITEM_DEFS", () => {
    for (const id of ITEM_IDS) {
      const d = describeItem({ def: id });
      assert.ok(d.name.length > 0, id);
      assert.match(d.icon, /^\/sprites\/[a-z0-9_]+\.png$/, id);
      assert.notEqual(d.cat, "unknown", id);
    }
  });
  it("uses instance rarity and labels dog tags", () => {
    assert.equal(describeItem({ def: "rifle", rarity: 3 }).rarityName, "legendary");
    assert.equal(describeItem({ def: "junk_dogtag", label: "Nick" }).name, "Dog tag · Nick");
    assert.equal(describeItem({ def: "nope" }).cat, "unknown");
    assert.equal(itemIcon("nope"), "/sprites/backpack.png");
    // Weapons v2: one icon per ammo type, square icon_<id> art for guns in tiles.
    assert.equal(itemIcon("ammo_shell"), "/sprites/ammo_shell.png");
    assert.equal(itemIcon("ammo_bolt"), "/sprites/ammo_bolt.png");
    assert.equal(itemIcon("rifle"), "/sprites/icon_rifle.png");
    assert.equal(describeItem({ def: "crossbow", rarity: 1 }).icon, "/sprites/icon_crossbow.png");
    assert.equal(describeItem({ def: "grenade" }).cat, "throwable");
    assert.equal(itemIcon("grenade"), "/sprites/grenade.png");
  });
  it("kill feed: guns by their side sprite, the grenade by its icon", () => {
    assert.equal(killWeaponIcon("lmg"), "/sprites/lmg.png");
    assert.equal(killWeaponIcon("grenade"), "/sprites/grenade.png");
    assert.equal(killWeaponName("grenade"), "Grenade");
    assert.equal(killWeaponName("revolver"), "Revolver");
    assert.equal(isKillWeapon("grenade"), true);
    assert.equal(isKillWeapon("smg"), true);
    assert.equal(isKillWeapon("rocket"), false);
  });
});

describe("durInfo", () => {
  it("weapon % and armor points against the level max", () => {
    assert.deepEqual(durInfo({ def: "rifle", dur: 50 }), { frac: 0.5, text: "Durability 50%", tone: "mid" });
    const a = durInfo({ def: "armor_2", dur: 13 })!;
    assert.equal(a.text, "Armor 13/130");
    assert.equal(a.tone, "low");
    assert.equal(durInfo({ def: "bandage", dur: 0 }), null);
    assert.equal(durInfo({ def: "rifle", dur: 150 })!.frac, 1);
  });
});

describe("values", () => {
  it("junk CR × qty, dog tags by victim level, gear 0", () => {
    assert.equal(itemValueCr({ def: "junk_bolts", qty: 4 }), 120);
    assert.equal(itemValueCr({ def: "junk_dogtag", qty: 1, lvl: 4 }), dogTagCr(4));
    assert.equal(itemValueCr({ def: "rifle", qty: 1 }), 0);
    assert.equal(fmtCr(1234567), "1 234 567 CR");
    assert.equal(fmtCr(-5), "−5 CR");
  });
  it("has a toast text for every error code", () => {
    for (const v of Object.values(INV_ERR_TEXT)) assert.ok(v.length > 3);
  });
  it("labels slots", () => {
    assert.equal(slotLabel("w1"), "Primary");
    assert.equal(slotLabel("p2"), "Pocket 3");
    assert.equal(slotLabel("b9"), "Bag 10");
  });
});

describe("quickTarget", () => {
  const base = () => ({
    w1: item("rifle", { uid: "r" }),
    w2: item("pistol", { uid: "", flags: ITEM_FLAG.FREE }),
    bp: item("backpack_1", { uid: "b" }),
    p0: item("ammo_light", { qty: 30 }),
    p1: item("shotgun", { uid: "s" }),
    b0: item("junk_gpu"),
  });
  it("equips a stored weapon into the active slot (swap) or an empty weapon slot", () => {
    assert.equal(quickTarget(recordStore(base()), "p1", "w2"), "w2");
    const { w2: _w2, ...noW2 } = base();
    assert.equal(quickTarget(recordStore(noW2), "p1", "w1"), "w2");
  });
  it("moves stacks pocket ↔ bag", () => {
    assert.equal(quickTarget(recordStore(base()), "p0"), "b1");
    assert.equal(quickTarget(recordStore(base()), "b0"), "p2");
  });
  it("unequips into storage, but never a non-empty backpack", () => {
    assert.equal(quickTarget(recordStore(base()), "w1"), "p2");
    assert.equal(quickTarget(recordStore(base()), "bp"), null);
    const { b0: _b0, ...emptyBag } = base();
    assert.equal(quickTarget(recordStore(emptyBag), "bp"), "p2");
  });
  it("ignores broken and empty", () => {
    assert.equal(quickTarget(recordStore({ p0: item("rifle", { flags: ITEM_FLAG.BROKEN }) }), "p0"), null);
    assert.equal(quickTarget(recordStore({}), "p0"), null);
  });
});

describe("buildReceipt", () => {
  const extracted = [
    { uid: "r", def: "rifle", qty: 1, rarity: 1, dur: 80 },
    { uid: "", def: "junk_bolts", qty: 4, rarity: 0, dur: 0 },
    { uid: "", def: "junk_dogtag", qty: 1, rarity: 1, dur: 0, label: "Nick", lvl: 2 },
  ];
  it("splits kept gear from sold junk and sums lines (estimate from extracted)", () => {
    const r = buildReceipt(extracted, []);
    assert.deepEqual(r.kept.map((i) => i.def), ["rifle"]);
    assert.equal(r.lines.length, 2);
    assert.equal(r.total, 120 + dogTagCr(2));
    assert.deepEqual(r.dogTags, ["Nick"]);
    assert.equal(r.final, false);
  });
  it("prefers the server's sold lines", () => {
    const r = buildReceipt(extracted, [{ def: "junk_bolts", qty: 4, cr: 99 }]);
    assert.equal(r.total, 99);
  });
  it("final credits re-total with an adjustment line so the receipt still sums", () => {
    const r = buildReceipt(extracted, [], { credits: 200, mult: 0.9 });
    assert.equal(r.total, 200);
    assert.equal(r.lines.reduce((a, l) => a + l.cr, 0), 200);
    assert.equal(r.lines.at(-1)!.name, "Adjustment");
    assert.equal(r.mult, 0.9);
  });
});

describe("xpLineText", () => {
  it("extract shows minutes on the map, haul the CR, counts a multiplier", () => {
    assert.deepEqual(xpLineText({ key: "extract", qty: 12, xp: 220 }), { label: XP_LINE_LABEL.extract, detail: "12 min on the map", xp: "+220 XP" });
    assert.deepEqual(xpLineText({ key: "haul", qty: 640, xp: 64 }), { label: XP_LINE_LABEL.haul, detail: "640 CR", xp: "+64 XP" });
    assert.equal(xpLineText({ key: "npc", qty: 3, xp: 60 }).detail, "×3");
    assert.equal(xpLineText({ key: "first_extract", qty: 1, xp: 300 }).detail, "");
  });
  it("the daily cap line is negative and has no detail", () => {
    assert.deepEqual(xpLineText({ key: "daily_cap", qty: 1, xp: -75 }), { label: XP_LINE_LABEL.daily_cap, detail: "", xp: "−75 XP" });
  });
});
