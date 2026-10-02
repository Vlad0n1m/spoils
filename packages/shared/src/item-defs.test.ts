import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ITEM_DEFS, JUNK_IDS, dogTagCr, itemDef, junkCredits } from "./item-defs.js";

const SPRITES = join(dirname(fileURLToPath(import.meta.url)), "../../../apps/web/public/sprites");

test("every item icon exists in apps/web/public/sprites", () => {
  for (const d of Object.values(ITEM_DEFS)) {
    assert.ok(existsSync(join(SPRITES, `${d.icon}.png`)), `${d.id}: missing sprite ${d.icon}.png`);
  }
});

test("16 junk entries following the stack-by-price rule", () => {
  assert.equal(JUNK_IDS.length, 16);
  for (const id of JUNK_IDS) {
    const d = itemDef(id)!;
    assert.equal(d.cat, "junk");
    assert.equal(d.unique, false);
    if (id === "junk_dogtag") continue;
    const v = d.value!;
    const want = v < 100 ? [5] : v <= 450 ? [2, 3] : [1];
    assert.ok(want.includes(d.stack), `${id}: value ${v} stack ${d.stack}`);
  }
});

test("itemDef ignores prototype keys; junkCredits prices dog tags by level", () => {
  assert.equal(itemDef("constructor"), undefined);
  assert.equal(junkCredits([{ def: "junk_apple", qty: 3 }, { def: "rifle", qty: 1 }]), 60);
  assert.equal(junkCredits([{ def: "junk_dogtag", qty: 1, lvl: 4 }]), dogTagCr(4));
  assert.equal(dogTagCr(100), 650);
});
