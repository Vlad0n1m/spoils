/**
 * Breakage on show (death.ts): uniques that broke on death stay in the body as BROKEN copies in slot
 * order, so a searcher sees what was lost. They reach only the searchers' loot view, can never be
 * taken, and are not part of what is left inside (emptied / leftInside / expiry).
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/game-server/src/sim/broken-loot.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ITEM_FLAG, SEARCH } from "@extract/shared";
import { takeAll, takeFromLoot } from "./containers.js";
import { deathSplit, killPlayer } from "./death.js";
import { makeItem } from "./items.js";
import { giveItem, giveStack, giveWeapon, ids, place, rtOf, run, testMatch } from "./test-utils.js";

test("deathSplit: `shown` = the carried list in order with broken uniques as BROKEN copies", () => {
  const rifle = makeItem("rifle", { uid: "r1", rarity: 1 });
  const vest = makeItem("armor_2", { uid: "v1" });
  const bolts = makeItem("junk_bolts", { qty: 2 });
  const rolls = [0.1, 0.9];
  const r = deathSplit([rifle, vest, bolts], () => rolls.shift() ?? 0.99);
  assert.deepEqual(r.lost.map((i) => i.uid), ["r1"]);
  assert.deepEqual(r.remains.map((i) => i.def), ["armor_2", "junk_bolts"]);
  assert.deepEqual(r.shown.map((i) => [i.def, (i.flags & ITEM_FLAG.BROKEN) !== 0]), [["rifle", true], ["armor_2", false], ["junk_bolts", false]]);
  assert.equal(rifle.flags & ITEM_FLAG.BROKEN, 0, "the carried item itself is not mutated");
  // NPC bags never break: nothing to show.
  const npc = deathSplit([rifle, vest], () => 0, true);
  assert.ok(npc.shown.every((i) => !(i.flags & ITEM_FLAG.BROKEN)));
});

test("a searcher sees the broken items reveal in slot order but cannot take them; the body empties without them", () => {
  const m = testMatch(3);
  const [a, b, c] = ids(m);
  place(m, a!, 1500, 1500);
  place(m, b!, 1560, 1500);
  place(m, c!, 3800, 3800);
  const rifle = giveWeapon(m, b!, "w2", "rifle", 2, 17);
  giveItem(m, b!, "armor_2", "armor", { dur: 60 });
  giveStack(m, b!, "junk_gpu", 1);
  const rolls = [0.1, 0.9]; // rifle breaks, vest survives
  m.rng = () => rolls.shift() ?? 0.99;
  killPlayer(m, rtOf(m, b!), rtOf(m, a!), "rifle");
  const victim = rtOf(m, b!);
  const t = m.containers.corpseOf(victim.rosterIndex)!;
  assert.deepEqual(t.items.map((i) => [i.def, (i.flags & ITEM_FLAG.BROKEN) !== 0]),
    [["rifle", true], ["armor_2", false], ["junk_gpu", false], ["junk_dogtag", false]]);
  assert.deepEqual(victim.exitReport!.lost.map((i) => i.uid), [rifle], "still reported lost exactly once");
  assert.ok(!m.containers.remaining(t).some((i) => i.uid === rifle), "not left inside");
  assert.ok(!m.containers.leftInside().some((i) => i.uid === rifle));

  const rt = rtOf(m, a!);
  assert.ok(m.interact(a!));
  run(m, SEARCH.OPEN_MS.corpse + 8_000);
  const loot = m.state.loot.get(t.key)!;
  assert.equal(loot.revealed, loot.total);
  const shown = loot.slots.get("0")!;
  assert.equal(shown.def, "rifle");
  assert.ok(shown.flags & ITEM_FLAG.BROKEN, "the broken rifle is on show");
  assert.equal(takeFromLoot(m, rt, { from: "loot", key: "0", uid: shown.uid, def: "rifle" }), "broken");
  const r = takeAll(m, rt);
  assert.equal(r.code, null);
  assert.equal(r.taken, 3, "vest, gpu and dog tag; the broken rifle stays");
  assert.ok(loot.slots.get("0"), "the broken copy stays on show");
  assert.equal(t.emptied, true, "only broken copies left: the body is empty");
  assert.equal(m.containers.nearestOpenable(rt), -1, "and no longer offered by F");
  assert.equal(m.ledger.resolved.get(rifle), "lost");
});

test("a body that holds only broken items is empty once revealed", () => {
  const m = testMatch(2);
  const [a, b] = ids(m);
  place(m, a!, 1500, 1500);
  place(m, b!, 1560, 1500);
  rtOf(m, b!).guest = true; // guests drop no dog tag
  giveWeapon(m, b!, "w2", "rifle", 2, 17);
  m.rng = () => 0;
  killPlayer(m, rtOf(m, b!), rtOf(m, a!), "rifle");
  const t = m.containers.corpseOf(rtOf(m, b!).rosterIndex)!;
  assert.equal(t.items.length, 1);
  assert.ok(m.interact(a!));
  run(m, SEARCH.OPEN_MS.corpse + 5_000);
  assert.equal(t.emptied, true);
  assert.equal(m.state.loot.get(t.key)!.slots.size, 1, "the broken rifle is still on show");
});
