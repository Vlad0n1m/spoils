import { test } from "node:test";
import assert from "node:assert/strict";
import { AMMO, ARMOR, Chest, HEAL, PLAYER } from "@extract/shared";
import { damagePlayer } from "./combat.js";
import { newArmorDrop, newWeaponDrop, spawnGroundItem } from "./inventory.js";
import { giveWeapon, ids, pl, place, run, testMatch } from "./test-utils.js";

test("bandage heals after HEAL.bandage.MS and is consumed only on completion", () => {
  const m = testMatch(1);
  const [a] = ids(m);
  const p = pl(m, a!);
  p.hp = 50;
  p.bandages = 2;
  assert.ok(m.heal(a!, "bandage"));
  assert.ok(!m.heal(a!, "bandage"), "already healing");
  run(m, HEAL.bandage.MS - 100);
  assert.equal(p.hp, 50);
  assert.equal(p.bandages, 2);
  run(m, 150);
  assert.equal(p.hp, 50 + HEAL.bandage.HP);
  assert.equal(p.bandages, 1);
  assert.equal(p.healUntil, 0);

  // Medkit caps at MAX_HP.
  p.medkits = 1;
  assert.ok(m.heal(a!, "medkit"));
  run(m, HEAL.medkit.MS + 50);
  assert.equal(p.hp, PLAYER.MAX_HP);
  assert.equal(p.medkits, 0);
  assert.ok(!m.heal(a!, "bandage"), "full HP");
});

test("firing or switching cancels a heal without consuming the item", () => {
  const m = testMatch(1);
  const [a] = ids(m);
  place(m, a!, 1000, 1500);
  const p = pl(m, a!);
  p.hp = 40;
  p.bandages = 1;

  assert.ok(m.heal(a!, "bandage"));
  run(m, 1000, { [a!]: { aim: 0, fire: false } });
  run(m, 100, { [a!]: { aim: 0, fire: true } });
  assert.equal(p.healUntil, 0);
  assert.equal(p.bandages, 1);
  assert.equal(p.hp, 40);

  giveWeapon(m, a!, 1, "rifle");
  run(m, 100, { [a!]: { aim: 0, fire: false } });
  assert.ok(m.heal(a!, "bandage"));
  assert.ok(m.switchSlot(a!, 1));
  assert.equal(p.healUntil, 0);
  run(m, HEAL.bandage.MS + 100);
  assert.equal(p.bandages, 1);
  assert.equal(p.hp, 40);

  // Cannot heal while reloading; nothing to heal with.
  p.slots[1]!.mag = 0;
  assert.ok(m.reload(a!));
  assert.ok(!m.heal(a!, "bandage"));
  assert.ok(!m.heal(a!, "medkit"));
});

test("healing slows movement to HEAL_SPEED_MULT", () => {
  const m = testMatch(1);
  const [a] = ids(m);
  place(m, a!, 1000, 1500);
  const p = pl(m, a!);
  p.hp = 40;
  p.bandages = 1;
  run(m, 1000, { [a!]: { mx: 1 } });
  const normal = p.x - 1000;
  assert.ok(m.heal(a!, "bandage"));
  const x0 = p.x;
  run(m, 1000, { [a!]: { mx: 1 } });
  const slowed = p.x - x0;
  assert.ok(Math.abs(slowed / normal - PLAYER.HEAL_SPEED_MULT) < 0.05, `ratio ${slowed / normal}`);
});

test("ammo and meds are auto-picked up to the carry cap; the remainder stays", () => {
  const m = testMatch(1);
  const [a] = ids(m);
  place(m, a!, 1000, 1500);
  const p = pl(m, a!);
  const before = p.ammoLight;
  const ammo = spawnGroundItem(m, { kind: "ammo", ammo: "light", qty: 300 }, 1010, 1500);
  const band = spawnGroundItem(m, { kind: "bandage", qty: 15 }, 990, 1500);
  const shells = spawnGroundItem(m, { kind: "ammo", ammo: "shell", qty: 10 }, 1000, 1510);
  const far = spawnGroundItem(m, { kind: "medkit", qty: 1 }, 1000, 1500 + PLAYER.AUTO_PICKUP_RADIUS + 20);
  run(m, 100);
  assert.equal(p.ammoLight, AMMO.light.maxCarry);
  assert.equal(m.state.items.get(ammo.id)?.qty, 300 - (AMMO.light.maxCarry - before));
  assert.equal(p.bandages, HEAL.bandage.MAX_CARRY);
  assert.equal(m.state.items.get(band.id)?.qty, 15 - (HEAL.bandage.MAX_CARRY - 1));
  assert.equal(p.ammoShell, 10);
  assert.ok(!m.state.items.has(shells.id));
  assert.ok(m.state.items.has(far.id), "out of auto-pickup radius");
  assert.equal(p.medkits, 0);
});

test("weapons need F: empty slot first, then the active slot is swapped", () => {
  const m = testMatch(1);
  const [a] = ids(m);
  place(m, a!, 1000, 1500);
  const p = pl(m, a!);

  const rifle = newWeaponDrop(m, "rifle", 1);
  spawnGroundItem(m, rifle, 1040, 1500);
  run(m, 50);
  assert.equal(p.slots[1]!.weapon, "", "weapons are not auto-picked");
  assert.ok(m.interact(a!));
  assert.equal(p.slots[1]!.weapon, "rifle");
  assert.equal(p.slots[1]!.rarity, 1);
  assert.equal(p.slots[0]!.free, true);

  // Both slots full, active = free pistol: the pistol just disappears.
  const shotgun = newWeaponDrop(m, "shotgun", 0);
  spawnGroundItem(m, shotgun, 1040, 1500);
  assert.equal(p.active, 0);
  assert.ok(m.interact(a!));
  assert.equal(p.slots[0]!.weapon, "shotgun");
  assert.equal(p.slots[0]!.free, false);
  assert.equal([...m.state.items.values()].filter((i) => i.kind === "weapon").length, 0);

  // Active is a real weapon: it drops where the new one was.
  const sniper = newWeaponDrop(m, "sniper", 0);
  spawnGroundItem(m, sniper, 1040, 1500);
  m.switchSlot(a!, 1);
  assert.ok(m.interact(a!));
  assert.equal(p.slots[1]!.weapon, "sniper");
  const dropped = [...m.state.items.values()].filter((i) => i.kind === "weapon");
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0]!.uid, (rifle as { uid: string }).uid);
  assert.equal(dropped[0]!.rarity, 1);

  // Out of reach: nothing happens.
  for (const it of [...m.state.items.values()]) m.state.items.delete(it.id);
  spawnGroundItem(m, newWeaponDrop(m, "rifle", 0), 1000 + PLAYER.INTERACT_RADIUS + 10, 1500);
  assert.ok(!m.interact(a!));
});

test("armor is taken only if better (higher level, or same level with more durability)", () => {
  const m = testMatch(1);
  const [a] = ids(m);
  place(m, a!, 1000, 1500);
  const p = pl(m, a!);

  const lvl2 = newArmorDrop(m, 2);
  spawnGroundItem(m, lvl2, 1030, 1500);
  assert.ok(m.interact(a!));
  assert.equal(p.armor, 2);
  assert.equal(p.armorDur, ARMOR[2].durability);

  // Lower level: ignored by F.
  const lvl1 = spawnGroundItem(m, newArmorDrop(m, 1), 1030, 1500);
  assert.ok(!m.interact(a!));
  assert.ok(m.state.items.has(lvl1.id));

  // Same level, more durability: swapped, old one drops.
  p.armorDur = 50;
  const fresh = newArmorDrop(m, 2);
  spawnGroundItem(m, fresh, 1030, 1500);
  assert.ok(m.interact(a!));
  assert.equal(p.armorUid, (fresh as { uid: string }).uid);
  assert.equal(p.armorDur, ARMOR[2].durability);
  const old = [...m.state.items.values()].find((i) => i.uid === (lvl2 as { uid: string }).uid);
  assert.ok(old);
  assert.equal(old.armorDur, 50);
});

test("F prefers the nearest unopened chest; contents spawn around it", () => {
  const m = testMatch(1);
  const [a] = ids(m);
  place(m, a!, 1000, 1500);
  const c = new Chest();
  c.id = "c0";
  c.x = 1060;
  c.y = 1500;
  c.rarity = 2;
  m.state.chests.set(c.id, c);
  const contents = [newWeaponDrop(m, "rifle", 2), newArmorDrop(m, 3)];
  m.chestContents.set(c.id, contents);
  spawnGroundItem(m, newWeaponDrop(m, "shotgun", 0), 1010, 1500); // nearer, but the chest wins

  assert.ok(m.interact(a!));
  assert.equal(c.opened, true);
  assert.ok(!m.chestContents.has(c.id));
  const ev = m.drainEvents().find((e) => e.type === "chest");
  assert.ok(ev && ev.type === "chest");
  assert.equal(ev.msg.id, "c0");
  assert.equal(ev.msg.by, a);
  const spawned = [...m.state.items.values()].filter((i) => i.uid && i.weapon !== "shotgun");
  assert.equal(spawned.length, 2);
  for (const it of spawned) assert.ok(Math.hypot(it.x - c.x, it.y - c.y) < 120);
});

test("death with a seeded RNG: every valuable item breaks or drops; ammo and meds drop", () => {
  for (const [roll, expectBroken] of [[0.1, true], [0.9, false]] as const) {
    const m = testMatch(2);
    const [a, b] = ids(m);
    place(m, b!, 2000, 2000);
    const v = pl(m, b!);
    const rifleUid = giveWeapon(m, b!, 1, "rifle", 2, 17);
    v.armor = 3;
    v.armorDur = 99;
    v.armorUid = "armor-uid";
    v.ammoLight = 50;
    v.ammoHeavy = 4;
    v.bandages = 3;
    v.medkits = 1;
    m.rng = () => roll;

    v.hp = 1;
    damagePlayer(m, v, 10, m.runtime(a!)!, "rifle", 0, 0);
    assert.equal(v.alive, false);
    const rt = m.runtime(b!)!;
    const items = [...m.state.items.values()];
    const valuable = items.filter((i) => i.uid);
    if (expectBroken) {
      assert.deepEqual(rt.lost.map((r) => r.uid).sort(), ["armor-uid", rifleUid].sort());
      assert.equal(rt.dropped.length, 0);
      assert.equal(valuable.length, 0);
    } else {
      assert.deepEqual(rt.dropped.map((r) => r.uid).sort(), ["armor-uid", rifleUid].sort());
      assert.equal(rt.lost.length, 0);
      const rifle = valuable.find((i) => i.uid === rifleUid)!;
      assert.equal(rifle.mag, 17);
      assert.equal(rifle.rarity, 2);
      const armor = valuable.find((i) => i.uid === "armor-uid")!;
      assert.equal(armor.armor, 3);
      assert.equal(armor.armorDur, 99 - 10 * ARMOR[3].absorb);
    }
    // The free pistol never drops.
    assert.equal(items.filter((i) => i.weapon === "pistol").length, 0);
    assert.equal(items.find((i) => i.ammoType === "light")?.qty, 50);
    assert.equal(items.find((i) => i.ammoType === "heavy")?.qty, 4);
    assert.equal(items.find((i) => i.kind === "bandage")?.qty, 3);
    assert.equal(items.find((i) => i.kind === "medkit")?.qty, 1);
    assert.equal(v.ammoLight + v.bandages + v.medkits + v.armor, 0);

    const outcome = m.drainEvents().find((e) => e.type === "outcome");
    assert.ok(outcome && outcome.type === "outcome");
    assert.equal(outcome.msg.lost.length + outcome.msg.dropped.length, 2);
  }
});
