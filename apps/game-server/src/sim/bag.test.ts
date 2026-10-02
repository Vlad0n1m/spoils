import { test } from "node:test";
import assert from "node:assert/strict";
import { ARMOR, CONTAINER_STATE, FREE_KIT, HEAL, ITEM_FLAG, PLAYER, WEAPONS, countOf } from "@extract/shared";
import { ammoCount, medCount } from "./bag.js";
import { damagePlayer } from "./combat.js";
import { dropSpot, spawnGroundItem } from "./inventory.js";
import { makeItem } from "./items.js";
import {
  clearDef, giveItem, giveStack, giveWeapon, ids, pl, place, rtOf, run, selfOf, testMap, testMatch,
} from "./test-utils.js";

const groundDefs = (m: ReturnType<typeof testMatch>) => [...m.state.items.values()].map((g) => g.def).sort();

test("free kit: FREE pistol in w1, FREE light ammo and a FREE bandage in pockets; public fields mirror it", () => {
  const m = testMatch(1);
  const [a] = ids(m);
  const s = selfOf(m, a!).slots;
  const w1 = s.get("w1")!;
  assert.equal(w1.def, FREE_KIT.WEAPON);
  assert.equal(w1.flags & ITEM_FLAG.FREE, ITEM_FLAG.FREE);
  assert.equal(w1.mag, WEAPONS.pistol.magSize);
  assert.equal(w1.uid, "");
  assert.equal(countOf(s, "ammo_light"), FREE_KIT.AMMO_LIGHT);
  assert.equal(countOf(s, "bandage"), FREE_KIT.BANDAGES);
  assert.equal(selfOf(m, a!).active, "w1");
  const p = pl(m, a!);
  assert.equal(p.weapon, "pistol");
  assert.equal(p.armor, 0);
  assert.equal(p.bp, 0);
  // Nothing FREE is tracked by the ledger.
  assert.equal(m.ledger.known.size, 0);
});

test("bandage heals after HEAL.bandage.MS and is consumed only on completion", () => {
  const m = testMatch(1);
  const [a] = ids(m);
  const rt = rtOf(m, a!);
  const p = pl(m, a!);
  p.hp = 50;
  giveStack(m, a!, "bandage", 1);
  assert.equal(medCount(rt, "bandage"), 2);
  assert.ok(m.heal(a!, "bandage"));
  assert.ok(!m.heal(a!, "bandage"), "already healing");
  run(m, HEAL.bandage.MS - 100);
  assert.equal(p.hp, 50);
  assert.equal(medCount(rt, "bandage"), 2);
  run(m, 150);
  assert.equal(p.hp, 50 + HEAL.bandage.HP);
  assert.equal(medCount(rt, "bandage"), 1);
  assert.equal(rt.self.healUntil, 0);
  // The FREE bandage went first (frees the pocket of the free kit).
  assert.ok([...rt.self.slots.values()].every((it) => it.def !== "bandage" || !(it.flags & ITEM_FLAG.FREE)));

  // Medkit caps at MAX_HP.
  giveStack(m, a!, "medkit", 1);
  assert.ok(m.heal(a!, "medkit"));
  run(m, HEAL.medkit.MS + 50);
  assert.equal(p.hp, PLAYER.MAX_HP);
  assert.equal(medCount(rt, "medkit"), 0);
  assert.ok(!m.heal(a!, "bandage"), "full HP");
});

test("a heal whose med was dropped mid-channel heals nothing", () => {
  const m = testMatch(1);
  const [a] = ids(m);
  const rt = rtOf(m, a!);
  rt.pub.hp = 40;
  assert.ok(m.heal(a!, "bandage"));
  const key = [...rt.self.slots.entries()].find(([, it]) => it.def === "bandage")![0];
  assert.equal(m.invDrop(a!, { key: key as "p1", uid: "", def: "bandage" }), null);
  run(m, HEAL.bandage.MS + 100);
  assert.equal(rt.pub.hp, 40);
});

test("firing, switching or rolling cancels a heal without consuming the item", () => {
  const m = testMatch(1);
  const [a] = ids(m);
  place(m, a!, 1000, 1500);
  const rt = rtOf(m, a!);
  rt.pub.hp = 40;

  assert.ok(m.heal(a!, "bandage"));
  run(m, 1000, { [a!]: { aim: 0, fire: false } });
  run(m, 100, { [a!]: { aim: 0, fire: true } });
  assert.equal(rt.self.healUntil, 0);
  assert.equal(medCount(rt, "bandage"), 1);
  assert.equal(rt.pub.hp, 40);

  giveWeapon(m, a!, "w2", "rifle");
  run(m, 100, { [a!]: { aim: 0, fire: false } });
  assert.ok(m.heal(a!, "bandage"));
  assert.ok(m.switchSlot(a!, "w2"));
  assert.equal(rt.self.healUntil, 0);
  run(m, HEAL.bandage.MS + 100);
  assert.equal(medCount(rt, "bandage"), 1);
  assert.equal(rt.pub.hp, 40);

  // Cannot heal while reloading.
  rt.self.slots.get("w2")!.mag = 0;
  assert.ok(m.reload(a!));
  assert.ok(!m.heal(a!, "bandage"));
  assert.ok(!m.heal(a!, "medkit"), "nothing to heal with");
});

test("healing slows movement to HEAL_SPEED_MULT", () => {
  const m = testMatch(1);
  const [a] = ids(m);
  place(m, a!, 1000, 1500);
  const p = pl(m, a!);
  p.hp = 40;
  run(m, 1000, { [a!]: { mx: 1 } });
  const normal = p.x - 1000;
  assert.ok(m.heal(a!, "bandage"));
  const x0 = p.x;
  run(m, 1000, { [a!]: { mx: 1 } });
  const slowed = p.x - x0;
  assert.ok(Math.abs(slowed / normal - PLAYER.HEAL_SPEED_MULT) < 0.05, `ratio ${slowed / normal}`);
});

test("ammo and meds are auto-picked up through the slot engine; the remainder stays", () => {
  const m = testMatch(1);
  const [a] = ids(m);
  place(m, a!, 1000, 1500);
  const rt = rtOf(m, a!);
  // Pockets: p0 FREE ammo, p1 FREE bandage, p2 / p3 empty.
  const ammo = spawnGroundItem(m, makeItem("ammo_light", { qty: 300 }), 1010, 1500);
  const shells = spawnGroundItem(m, makeItem("ammo_shell", { qty: 10 }), 1000, 1510);
  const far = spawnGroundItem(m, makeItem("medkit", { qty: 1 }), 1000, 1500 + PLAYER.AUTO_PICKUP_RADIUS + 20);
  const junk = spawnGroundItem(m, makeItem("junk_gpu"), 995, 1500);
  run(m, 100);
  // Paid ammo never merges into the FREE stack: it fills the two empty pockets (2 × 60), the rest
  // stays on the ground, and the shells find no room at all.
  const s = rt.self.slots;
  assert.equal(ammoCount(rt, "light"), FREE_KIT.AMMO_LIGHT + 120);
  assert.equal(s.get("p2")!.qty + s.get("p3")!.qty, 120);
  assert.equal(m.state.items.get(ammo.id)?.qty, 180);
  assert.equal(m.state.items.get(shells.id)?.qty, 10);
  assert.ok(m.state.items.has(far.id), "out of auto-pickup radius");
  assert.ok(m.state.items.has(junk.id), "junk needs F");
  // With room again (the FREE stack spent, the light ammo gone), the shells come in on the next step.
  m.ground.remove(m, ammo.id);
  s.delete("p0");
  run(m, 100);
  assert.ok(!m.state.items.has(shells.id));
});

test("weapons with F: empty slot, then the FREE pistol, then the active hand (old one to storage)", () => {
  const m = testMatch(1);
  const [a] = ids(m);
  place(m, a!, 1000, 1500);
  const rt = rtOf(m, a!);
  const s = rt.self.slots;

  const rifle = makeItem("rifle", { uid: m.newUid(), rarity: 1 });
  m.ledger.register(rifle, "minted");
  spawnGroundItem(m, rifle, 1040, 1500);
  run(m, 50);
  assert.equal(s.get("w2"), undefined, "weapons are not auto-picked");
  assert.ok(m.interact(a!));
  assert.equal(s.get("w2")!.def, "rifle");
  assert.equal(s.get("w2")!.rarity, 1);
  assert.equal(s.get("w2")!.uid, rifle.uid);
  assert.equal(s.get("w1")!.flags & ITEM_FLAG.FREE, ITEM_FLAG.FREE);

  // Both slots full, w1 = FREE pistol: the pistol just disappears.
  const shotgun = makeItem("shotgun", { uid: m.newUid() });
  m.ledger.register(shotgun, "minted");
  spawnGroundItem(m, shotgun, 1040, 1500);
  assert.ok(m.interact(a!));
  assert.equal(s.get("w1")!.def, "shotgun");
  assert.equal(s.get("w1")!.flags, 0);
  assert.equal(m.state.items.size, 0);

  // Both real: the new one goes into the active hand, the old one into storage.
  const sniper = makeItem("sniper", { uid: m.newUid() });
  m.ledger.register(sniper, "minted");
  spawnGroundItem(m, sniper, 1040, 1500);
  m.switchSlot(a!, "w2");
  assert.ok(m.interact(a!));
  assert.equal(s.get("w2")!.def, "sniper");
  assert.equal(pl(m, a!).weapon, "sniper");
  const stored = [...s.entries()].find(([, it]) => it.uid === rifle.uid);
  assert.ok(stored && /^p\d$/.test(stored[0]), "rifle went to a pocket");

  // Out of reach: nothing happens.
  const far = makeItem("rifle", { uid: m.newUid() });
  m.ledger.register(far, "minted");
  spawnGroundItem(m, far, 1000 + PLAYER.INTERACT_RADIUS + 10, 1500);
  assert.ok(!m.interact(a!));
});

test("armor: equipped when it can absorb more (old one stored), otherwise stored", () => {
  const m = testMatch(1);
  const [a] = ids(m);
  place(m, a!, 1000, 1500);
  const s = selfOf(m, a!).slots;

  const lvl2 = makeItem("armor_2", { uid: m.newUid() });
  m.ledger.register(lvl2, "minted");
  spawnGroundItem(m, lvl2, 1030, 1500);
  assert.ok(m.interact(a!));
  assert.equal(pl(m, a!).armor, 2);
  assert.equal(pl(m, a!).armorDur, ARMOR[2].durability);

  // Worn one at 50 points; a fresh level 2 is an upgrade: swapped, the old vest goes to storage.
  s.get("armor")!.dur = 50;
  const fresh = makeItem("armor_2", { uid: m.newUid() });
  m.ledger.register(fresh, "minted");
  spawnGroundItem(m, fresh, 1030, 1500);
  assert.ok(m.interact(a!));
  assert.equal(s.get("armor")!.uid, fresh.uid);
  const old = [...s.values()].find((it) => it.uid === lvl2.uid);
  assert.equal(old?.dur, 50);

  // A worse vest is just stored (carry it out to sell).
  const lvl1 = makeItem("armor_1", { uid: m.newUid() });
  m.ledger.register(lvl1, "minted");
  spawnGroundItem(m, lvl1, 1030, 1500);
  assert.ok(m.interact(a!));
  assert.equal(s.get("armor")!.uid, fresh.uid);
  assert.ok([...s.values()].some((it) => it.uid === lvl1.uid));
});

test("a bigger backpack is equipped (bag contents keep their slots); a full inventory refuses with INV_ERR full", () => {
  const m = testMatch(1);
  const [a] = ids(m);
  place(m, a!, 1000, 1500);
  const s = selfOf(m, a!).slots;
  giveItem(m, a!, "backpack_1", "bp");
  assert.equal(pl(m, a!).bp, 1);
  giveItem(m, a!, "junk_gpu", "b5");
  const bp2 = makeItem("backpack_2", { uid: m.newUid() });
  m.ledger.register(bp2, "minted");
  spawnGroundItem(m, bp2, 1030, 1500);
  assert.ok(m.interact(a!));
  assert.equal(pl(m, a!).bp, 2);
  assert.equal(s.get("b5")!.def, "junk_gpu");
  assert.ok([...s.values()].some((it) => it.def === "backpack_1"), "old pack stored");

  // Fill everything, then F on junk fails.
  for (const k of ["p0", "p1", "p2", "p3", ...Array.from({ length: 10 }, (_, i) => `b${i}`)]) {
    if (!s.get(k)) giveItem(m, a!, "junk_goldchain", k as "p0");
  }
  m.drainEvents();
  spawnGroundItem(m, makeItem("junk_coldwallet"), 1030, 1500);
  assert.ok(!m.interact(a!));
  const err = m.drainEvents().find((e) => e.type === "invErr");
  assert.ok(err && err.type === "invErr" && err.msg.code === "full");
});

test("F needs line of sight: nothing is opened or picked up through a wall", () => {
  const wall = { x: 1023, y: 1300, w: 24, h: 400 };
  const m = testMatch(1, { map: testMap({ walls: [wall], containers: [{ x: 1070, y: 1500, kind: "weapon_box", tier: 4, zone: null }] }) });
  const [a] = ids(m);
  place(m, a!, 1000, 1500);
  const p = pl(m, a!);
  const rifle = spawnGroundItem(m, makeItem("junk_gpu"), 1070, 1520);
  assert.ok(Math.hypot(rifle.x - p.x, rifle.y - p.y) <= PLAYER.INTERACT_RADIUS);
  assert.ok(!m.interact(a!));
  assert.equal(m.state.containerState[0], CONTAINER_STATE.UNTOUCHED);
  assert.ok(m.state.items.has(rifle.id));

  // Around the wall's end the same container is in sight and works as usual.
  place(m, a!, 1070, 1560);
  assert.ok(m.interact(a!));
  assert.equal(m.state.containerState[0], CONTAINER_STATE.OPENED);
});

test("drops never scatter to the far side of a wall", () => {
  const wall = { x: 1023, y: 1300, w: 24, h: 400 };
  const m = testMatch(1, { map: testMap({ walls: [wall] }) });
  for (let n = 0; n < 24; n++) assert.ok(dropSpot(m, 1000, 1500, n).x < wall.x);
});

test("INV_MOVE: rearrange, split a stack, swap weapons; stale clicks and bad slots are refused", () => {
  const m = testMatch(1);
  const [a] = ids(m);
  const rt = rtOf(m, a!);
  const s = rt.self.slots;
  // p0 = FREE ammo, p1 = FREE bandage.
  assert.equal(m.invMove(a!, { from: "self", key: "p1", uid: "", def: "bandage", to: "p3" }), null);
  assert.equal(s.get("p1"), undefined);
  assert.equal(s.get("p3")!.def, "bandage");
  // Stale click: p1 is empty now.
  assert.equal(m.invMove(a!, { from: "self", key: "p1", uid: "", def: "bandage", to: "p2" }), "gone");
  // Split 10 rounds off the FREE stack into p2.
  assert.equal(m.invMove(a!, { from: "self", key: "p0", uid: "", def: "ammo_light", to: "p2", qty: 10 }), null);
  assert.equal(s.get("p0")!.qty, FREE_KIT.AMMO_LIGHT - 10);
  assert.equal(s.get("p2")!.qty, 10);
  // A weapon into the armor slot: bad slot. No backpack: b0 does not exist.
  const rifleUid = giveWeapon(m, a!, "w2", "rifle");
  assert.equal(m.invMove(a!, { from: "self", key: "w2", uid: rifleUid, def: "rifle", to: "armor" }), "bad_slot");
  assert.equal(m.invMove(a!, { from: "self", key: "w2", uid: rifleUid, def: "rifle", to: "b0" }), "bad_slot");
  // Swap w1 (FREE pistol) and w2 (rifle) by dropping the rifle onto w1: the pistol is replaced?
  // No — a FREE pistol target is replaced by planPlace (it is worth nothing).
  assert.equal(m.invMove(a!, { from: "self", key: "w2", uid: rifleUid, def: "rifle", to: "w1" }), null);
  assert.equal(s.get("w1")!.def, "rifle");
  assert.equal(s.get("w2"), undefined);
  assert.equal(rt.self.active, "w1");
  assert.equal(pl(m, a!).weapon, "rifle");
  // Two real weapons swap places.
  const sgUid = giveWeapon(m, a!, "w2", "shotgun");
  assert.equal(m.invMove(a!, { from: "self", key: "w2", uid: sgUid, def: "shotgun", to: "w1" }), null);
  assert.equal(s.get("w1")!.uid, sgUid);
  assert.equal(s.get("w2")!.uid, rifleUid);
});

test("INV_MOVE: a non-empty backpack cannot be removed or swapped for a smaller one", () => {
  const m = testMatch(1);
  const [a] = ids(m);
  const s = selfOf(m, a!).slots;
  const bp3 = giveItem(m, a!, "backpack_3", "bp");
  giveItem(m, a!, "junk_apple", "b12");
  assert.equal(m.invMove(a!, { from: "self", key: "bp", uid: bp3, def: "backpack_3", to: "p2" }), "bp_not_empty");
  const bp1 = giveItem(m, a!, "backpack_1", "p3");
  assert.equal(m.invMove(a!, { from: "self", key: "p3", uid: bp1, def: "backpack_1", to: "bp" }), "bp_not_empty");
  // Emptying the high slot makes the swap legal (the old pack lands where the new one was).
  s.delete("b12");
  assert.equal(m.invMove(a!, { from: "self", key: "p3", uid: bp1, def: "backpack_1", to: "bp" }), null);
  assert.equal(s.get("bp")!.uid, bp1);
  assert.equal(s.get("p3")!.uid, bp3);
});

test("INV_DROP: own item to the ground (FREE vanishes); token bucket limits spam", () => {
  const m = testMatch(1);
  const [a] = ids(m);
  place(m, a!, 1000, 1500);
  const uid = giveItem(m, a!, "junk_hdd", "p2", { qty: 2 });
  assert.equal(uid, "");
  assert.equal(m.invDrop(a!, { key: "p2", uid: "", def: "junk_hdd", qty: 1 }), null);
  assert.deepEqual(groundDefs(m), ["junk_hdd"]);
  assert.equal(selfOf(m, a!).slots.get("p2")!.qty, 1);
  // FREE bandage: gone for good, nothing on the ground.
  assert.equal(m.invDrop(a!, { key: "p1", uid: "", def: "bandage" }), null);
  assert.deepEqual(groundDefs(m), ["junk_hdd"]);
  // Burst of 20 ops, then "rate" until the bucket refills.
  let rate = 0;
  for (let i = 0; i < 40; i++) {
    if (m.invMove(a!, { from: "self", key: "p0", uid: "", def: "ammo_light", to: i % 2 ? "p0" : "p3" }) === "rate") rate++;
  }
  assert.ok(rate > 0);
  run(m, 2000);
  assert.notEqual(m.invMove(a!, { from: "self", key: "p0", uid: "", def: "ammo_light", to: "p3" }), "rate");
});

test("death with a seeded RNG: every unique breaks or drops; fungibles drop; FREE vanishes; humans leave a dog tag", () => {
  for (const [roll, expectBroken] of [[0.1, true], [0.9, false]] as const) {
    const m = testMatch(2);
    const [a, b] = ids(m);
    place(m, b!, 2000, 2000);
    const rifleUid = giveWeapon(m, b!, "w2", "rifle", 2, 17);
    const armorUid = giveItem(m, b!, "armor_3", "armor", { dur: 99 });
    clearDef(m, b!, "ammo_light");
    giveStack(m, b!, "ammo_light", 50);
    giveStack(m, b!, "ammo_heavy", 4);
    giveStack(m, b!, "medkit", 1);
    m.rng = () => roll;

    pl(m, b!).hp = 1;
    damagePlayer(m, rtOf(m, b!), 10, rtOf(m, a!), "rifle", 0, 0);
    assert.equal(pl(m, b!).alive, false);
    const rt = rtOf(m, b!);
    // v2: the remains are a searchable corpse (containers.ts), nothing lands on the ground.
    assert.equal(m.state.items.size, 0);
    const ground = m.containers.remaining(m.containers.corpseOf(rt.rosterIndex)!);
    const uniques = ground.filter((i) => i.uid);
    const report = rt.exitReport!;
    if (expectBroken) {
      assert.deepEqual(report.lost.map((r) => r.uid).sort(), [armorUid, rifleUid].sort());
      assert.equal(rt.dropped.length, 0);
      assert.equal(uniques.length, 0);
      assert.equal(m.ledger.resolved.get(rifleUid), "lost");
    } else {
      assert.equal(report.lost.length, 0);
      assert.deepEqual(rt.dropped.map((r) => r.uid).sort(), [armorUid, rifleUid].sort());
      const rifle = uniques.find((i) => i.uid === rifleUid)!;
      assert.equal(rifle.mag, 17);
      assert.equal(rifle.rarity, 2);
      const armor = uniques.find((i) => i.uid === armorUid)!;
      assert.equal(armor.dur, 99 - 10 * ARMOR[3].absorb);
      assert.equal(m.ledger.resolved.has(rifleUid), false, "still on the map");
    }
    // FREE pistol and bandage vanish; paid stacks drop whole; a dog tag for the human.
    assert.equal(ground.filter((i) => i.def === "pistol").length, 0);
    assert.equal(ground.find((i) => i.def === "ammo_light")?.qty, 50);
    assert.equal(ground.find((i) => i.def === "ammo_heavy")?.qty, 4);
    assert.equal(ground.find((i) => i.def === "medkit")?.qty, 1);
    assert.equal(ground.filter((i) => i.def === "bandage").length, 0);
    const tag = ground.find((i) => i.def === "junk_dogtag")!;
    assert.equal(tag.label, "P1");
    assert.equal(tag.ref, rt.selfKey);
    assert.equal(selfOf(m, b!).slots.size, 0);

    const outcome = m.drainEvents().find((e) => e.type === "outcome");
    assert.ok(outcome && outcome.type === "outcome");
    assert.equal(outcome.msg.lost.length + outcome.msg.dropped.length, 2);
    const vest = [...outcome.msg.lost, ...outcome.msg.dropped].find((r) => r.uid === armorUid)!;
    assert.equal(vest.dur, 99 - 10 * ARMOR[3].absorb, "armor carries its remaining absorb points");
  }
});
