/**
 * Inventory v2: dropping your own items on the floor (INV_DROP) and picking them up again, by you or
 * by anyone else; the full-bag refusal carries the item (InvErrMsg.item) and agrees with the shared
 * pickupFits() the HUD prompt uses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PLAYER, pickupFits } from "@extract/shared";
import { spawnGroundItem } from "./inventory.js";
import { makeItem } from "./items.js";
import type { Match } from "./match.js";
import { giveItem, giveWeapon, ids, pl, place, run, selfOf, testMatch } from "./test-utils.js";

const ground = (m: Match) => [...m.ground.all()];
const invErrs = (m: Match) => m.drainEvents().flatMap((e) => (e.type === "invErr" ? [e.msg] : []));

test("a dropped bag item lands next to the dropper and the same player picks it up again", () => {
  const m = testMatch(1);
  const [a] = ids(m);
  place(m, a!, 1000, 1500);
  giveItem(m, a!, "junk_gpu", "p2");
  assert.equal(m.invDrop(a!, { key: "p2", uid: "", def: "junk_gpu" }), null);
  assert.equal(selfOf(m, a!).slots.get("p2"), undefined);
  const g = ground(m);
  assert.equal(g.length, 1);
  assert.equal(g[0]!.item.def, "junk_gpu");
  assert.ok(Math.hypot(g[0]!.schema.x - 1000, g[0]!.schema.y - 1500) <= PLAYER.INTERACT_RADIUS, "within F reach");
  assert.ok(m.interact(a!));
  assert.equal(ground(m).length, 0);
  assert.ok([...selfOf(m, a!).slots.values()].some((it) => it.def === "junk_gpu"));
});

test("an equipped weapon can be dropped and a party mate (anyone) picks it up", () => {
  const m = testMatch(2);
  const [a, b] = ids(m);
  place(m, a!, 1000, 1500);
  place(m, b!, 2000, 1500);
  const uid = giveWeapon(m, a!, "w2", "rifle", 2);
  assert.ok(uid);
  assert.equal(m.invDrop(a!, { key: "w2", uid, def: "rifle" }), null);
  assert.equal(selfOf(m, a!).slots.get("w2"), undefined);
  const g = ground(m)[0]!;
  assert.equal(g.item.uid, uid, "the same unique lies on the ground");
  place(m, b!, g.schema.x + 20, g.schema.y);
  assert.ok(m.interact(b!));
  const got = [...selfOf(m, b!).slots.values()].find((it) => it.uid === uid);
  assert.ok(got, "b carries the rifle now");
  assert.equal(ground(m).length, 0);
});

test("INV_DROP is validated: stale uid/def, bad qty, dead players", () => {
  const m = testMatch(1);
  const [a] = ids(m);
  place(m, a!, 1000, 1500);
  giveItem(m, a!, "junk_hdd", "p2", { qty: 2 });
  assert.equal(m.invDrop(a!, { key: "p2", uid: "", def: "junk_gpu" }), "gone");
  assert.equal(m.invDrop(a!, { key: "p3", uid: "", def: "junk_hdd" }), "gone");
  assert.equal(m.invDrop(a!, { key: "p2", uid: "", def: "junk_hdd", qty: 5 }), "bad_slot");
  assert.equal(ground(m).length, 0);
  pl(m, a!).alive = false;
  assert.equal(m.invDrop(a!, { key: "p2", uid: "", def: "junk_hdd" }), "dead");
  assert.equal(ground(m).length, 0);
});

test("F with a full bag: INV_ERR full names the item; pickupFits agrees; dropping one frees room", () => {
  const m = testMatch(1);
  const [a] = ids(m);
  place(m, a!, 1000, 1500);
  const s = selfOf(m, a!).slots;
  for (const k of ["p0", "p1", "p2", "p3"] as const) giveItem(m, a!, "junk_goldchain", k);
  run(m, 50);
  m.drainEvents();
  spawnGroundItem(m, makeItem("junk_coldwallet"), 1030, 1500);
  assert.equal(pickupFits(s, { def: "junk_coldwallet", qty: 1 }), false);
  assert.ok(!m.interact(a!));
  const errs = invErrs(m);
  assert.equal(errs.length, 1);
  assert.deepEqual(errs[0], { code: "full", item: "junk_coldwallet" });
  // A weapon always fits (swap into the hand), so its prompt never says "Bag full".
  assert.equal(pickupFits(s, { def: "rifle", qty: 1 }), true);

  // Drop one chain: now the wallet fits and F takes it (the nearer wallet, not the dropped chain).
  run(m, 1000);
  assert.equal(m.invDrop(a!, { key: "p0", uid: "", def: "junk_goldchain" }), null);
  assert.equal(pickupFits(s, { def: "junk_coldwallet", qty: 1 }), true);
  const wallet = ground(m).find((g) => g.item.def === "junk_coldwallet")!;
  assert.ok(m.pickupItem(a!, wallet.schema.id));
  assert.ok([...s.values()].some((it) => it.def === "junk_coldwallet"));
});
