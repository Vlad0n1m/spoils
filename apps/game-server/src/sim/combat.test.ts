import { test } from "node:test";
import assert from "node:assert/strict";
import { ACT, ARMOR, PLAYER, RARITY_DAMAGE_MULT, WEAPONS } from "@extract/shared";
import { ammoCount } from "./bag.js";
import { damagePlayer } from "./combat.js";
import {
  addExtract, clearDef, giveItem, giveStack, giveWeapon, ids, pl, place, rtOf, run, selfOf, send, shotsBy, testMatch,
} from "./test-utils.js";

test("armor absorbs its share and wears down by the absorbed amount; public armor mirrors it", () => {
  const m = testMatch(2);
  const [a, b] = ids(m);
  giveItem(m, b!, "armor_2", "armor");
  const target = pl(m, b!);
  assert.equal(target.armor, 2);
  assert.equal(target.armorDur, ARMOR[2].durability);

  const raw = WEAPONS.rifle.damage * RARITY_DAMAGE_MULT[1];
  damagePlayer(m, rtOf(m, b!), raw, rtOf(m, a!), "rifle", 0, 0);
  const absorbed = raw * ARMOR[2].absorb;
  assert.equal(target.hp, Math.round((100 - (raw - absorbed)) * 100) / 100);
  const vest = selfOf(m, b!).slots.get("armor")!;
  assert.equal(vest.dur, Math.round((ARMOR[2].durability - absorbed) * 100) / 100);
  assert.equal(target.armorDur, vest.dur);
  assert.equal(target.armor, 2);

  const hit = m.drainEvents().find((e) => e.type === "hit");
  assert.ok(hit && hit.type === "hit");
  assert.equal(hit.msg.ar, true);
  assert.equal(hit.msg.t, b);
  assert.equal(hit.msg.s, a);
  assert.equal(hit.target, rtOf(m, b!).rosterIndex);
  assert.equal(hit.src, rtOf(m, a!).rosterIndex);
  assert.equal(typeof hit.fa, "number");
});

test("armor that runs out of durability is destroyed (reported, resolved in the ledger)", () => {
  const m = testMatch(2);
  const [a, b] = ids(m);
  const uid = giveItem(m, b!, "armor_1", "armor", { dur: 1 });
  const target = pl(m, b!);
  damagePlayer(m, rtOf(m, b!), 15, rtOf(m, a!), "pistol", 0, 0);
  // Only 1 point could be absorbed; the rest goes to HP.
  assert.equal(target.hp, 86);
  assert.equal(target.armor, 0);
  assert.equal(target.armorDur, 0);
  assert.equal(selfOf(m, b!).slots.get("armor"), undefined);
  assert.deepEqual(rtOf(m, b!).destroyed.map((r) => r.uid), [uid]);
  assert.equal(m.ledger.resolved.get(uid), "destroyed");
});

test("no armor: full damage", () => {
  const m = testMatch(2);
  const [, b] = ids(m);
  damagePlayer(m, rtOf(m, b!), 20, null, "", 0, 0);
  assert.equal(pl(m, b!).hp, 80);
});

test("semi-auto fires once per trigger press, auto fires while held at its rate", () => {
  const m = testMatch(2);
  const [a, b] = ids(m);
  place(m, a!, 1000, 1500);
  place(m, b!, 2000, 2500); // out of the line of fire
  const self = selfOf(m, a!);
  assert.equal(self.active, "w1");
  assert.equal(pl(m, a!).weapon, "pistol");

  // Pistol: holding the trigger for 2 s gives exactly one shot.
  let ev = run(m, 2000, { [a!]: { aim: 0, fire: true } });
  assert.equal(shotsBy(ev, m, a!).length, 1);
  // Release, press again: one more shot.
  run(m, 100, { [a!]: { aim: 0, fire: false } });
  ev = run(m, 500, { [a!]: { aim: 0, fire: true } });
  assert.equal(shotsBy(ev, m, a!).length, 1);
  assert.equal(self.slots.get("w1")!.mag, WEAPONS.pistol.magSize - 2);

  // Rapid clicking cannot beat fireIntervalMs.
  ev = [];
  for (let i = 0; i < 20; i++) {
    ev.push(...run(m, 50, { [a!]: { aim: 0, fire: true } }));
    ev.push(...run(m, 50, { [a!]: { aim: 0, fire: false } }));
  }
  const clicks = shotsBy(ev, m, a!);
  for (let i = 1; i < clicks.length; i++) {
    assert.ok(clicks[i]!.at - clicks[i - 1]!.at >= WEAPONS.pistol.fireIntervalMs);
  }

  // The pistol's cooldown carries over a switch; let it run out first.
  run(m, 400, { [a!]: { aim: 0, fire: false } });
  // Rifle (auto): held for 1 s ≈ 1000 / fireIntervalMs shots, never faster than the interval.
  giveWeapon(m, a!, "w2", "rifle");
  assert.ok(m.switchSlot(a!, "w2"));
  assert.equal(pl(m, a!).weapon, "rifle");
  ev = run(m, 1000, { [a!]: { aim: 0, fire: true } });
  const shots = shotsBy(ev, m, a!);
  assert.ok(shots.length >= 9 && shots.length <= 11, `rifle shots: ${shots.length}`);
  for (let i = 1; i < shots.length; i++) {
    assert.ok(shots[i]!.at - shots[i - 1]!.at >= WEAPONS.rifle.fireIntervalMs);
  }
  assert.equal(self.slots.get("w2")!.mag, WEAPONS.rifle.magSize - shots.length);
  assert.equal(rtOf(m, a!).stats.shotsFired, clicks.length + 2 + shots.length);
});

test("shotgun shot carries every pellet; muzzle is offset along the aim; a shot sound is emitted", () => {
  const m = testMatch(1);
  const [a] = ids(m);
  place(m, a!, 1000, 1500);
  giveWeapon(m, a!, "w2", "shotgun");
  m.switchSlot(a!, "w2");
  const ev = run(m, 100, { [a!]: { aim: Math.PI / 2, fire: true } });
  const shot = shotsBy(ev, m, a!)[0];
  assert.ok(shot);
  assert.equal(shot.msg.a.length, WEAPONS.shotgun.pellets);
  for (const ang of shot.msg.a) assert.ok(Math.abs(ang - Math.PI / 2) <= WEAPONS.shotgun.spread + 1e-9);
  assert.ok(Math.abs(shot.msg.y - (1500 + WEAPONS.shotgun.muzzle)) < 1e-6);
  assert.ok(ev.some((e) => e.type === "sound" && e.kind === 3 && e.src === rtOf(m, a!).rosterIndex));
});

test("bullets hit the first player in line and stop at walls", () => {
  const m = testMatch(2);
  const [a, b] = ids(m);
  place(m, a!, 1000, 1500);
  place(m, b!, 1300, 1500);
  const ev = run(m, 400, { [a!]: { aim: 0, fire: true } });
  const hits = ev.filter((e) => e.type === "hit");
  assert.equal(hits.length, 1);
  assert.equal(pl(m, b!).hp, PLAYER.MAX_HP - WEAPONS.pistol.damage);

  // Target hidden behind the crate wall at x 3000..3064, y 3000..3400.
  place(m, a!, 2800, 3200);
  place(m, b!, 3250, 3200);
  run(m, 100, { [a!]: { aim: 0, fire: false } });
  const ev2 = run(m, 600, { [a!]: { aim: 0, fire: true } });
  assert.equal(shotsBy(ev2, m, a!).length, 1);
  assert.equal(ev2.filter((e) => e.type === "hit").length, 0);
});

test("reload fills the magazine from ammo stacks after reloadMs; switching cancels it", () => {
  const m = testMatch(1);
  const [a] = ids(m);
  place(m, a!, 1000, 1500);
  const rt = rtOf(m, a!);
  const self = rt.self;
  giveWeapon(m, a!, "w2", "rifle", 0, 0);
  m.switchSlot(a!, "w2");
  clearDef(m, a!, "ammo_light");
  assert.equal(giveStack(m, a!, "ammo_light", 100), 100);

  assert.ok(m.reload(a!));
  assert.ok(!m.reload(a!), "already reloading");
  run(m, 50);
  assert.equal(pl(m, a!).act & ACT.RELOAD, ACT.RELOAD, "others see the reload");
  run(m, WEAPONS.rifle.reloadMs - 150);
  assert.equal(self.slots.get("w2")!.mag, 0);
  run(m, 150);
  assert.equal(self.slots.get("w2")!.mag, WEAPONS.rifle.magSize);
  assert.equal(ammoCount(rt, "light"), 100 - WEAPONS.rifle.magSize);
  assert.equal(self.reloadUntil, 0);
  assert.ok(!m.reload(a!), "full magazine");

  // Switching away cancels.
  self.slots.get("w2")!.mag = 3;
  assert.ok(m.reload(a!));
  m.switchSlot(a!, "w1");
  assert.equal(self.reloadUntil, 0);
  run(m, WEAPONS.rifle.reloadMs + 100);
  assert.equal(self.slots.get("w2")!.mag, 3);

  // No reserve: nothing to reload.
  clearDef(m, a!, "ammo_light");
  self.slots.get("w1")!.mag = 0;
  assert.ok(!m.reload(a!));
});

test("an empty magazine with reserve reloads automatically, FREE ammo first", () => {
  const m = testMatch(1);
  const [a] = ids(m);
  place(m, a!, 1000, 1500);
  const rt = rtOf(m, a!);
  rt.self.slots.get("w1")!.mag = 1;
  giveStack(m, a!, "ammo_light", 20);
  const free0 = ammoCount(rt, "light") - 20;
  run(m, 100, { [a!]: { aim: 0, fire: true } });
  assert.equal(rt.self.slots.get("w1")!.mag, 0);
  assert.ok(rt.self.reloadUntil > 0);
  run(m, WEAPONS.pistol.reloadMs + 50);
  assert.equal(rt.self.slots.get("w1")!.mag, WEAPONS.pistol.magSize);
  assert.equal(ammoCount(rt, "light"), free0 + 20 - WEAPONS.pistol.magSize);
  // The paid stack is untouched while FREE rounds last.
  const paid = [...rt.self.slots.values()].find((it) => it.def === "ammo_light" && !it.flags);
  assert.equal(paid?.qty, 20);
});

test("a kill credits the killer and finishes the victim", () => {
  const m = testMatch(2);
  const [a, b] = ids(m);
  addExtract(m, 4000, 4000);
  const victim = pl(m, b!);
  victim.hp = 10;
  damagePlayer(m, rtOf(m, b!), 15, rtOf(m, a!), "pistol", 0, 0);
  assert.equal(victim.alive, false);
  assert.equal(selfOf(m, a!).kills, 1);
  const ev = m.drainEvents();
  const kill = ev.find((e) => e.type === "kill");
  assert.ok(kill && kill.type === "kill");
  assert.equal(kill.msg.killerId, a);
  assert.equal(kill.msg.victimId, b);
  const outcome = ev.find((e) => e.type === "outcome");
  assert.ok(outcome && outcome.type === "outcome");
  assert.equal(outcome.to, rtOf(m, b!).rosterIndex);
  assert.equal(outcome.msg.exit, "dead");
  assert.equal(outcome.msg.killedBy, "P0");
  const exit = ev.find((e) => e.type === "exit");
  assert.ok(exit && exit.type === "exit");
  assert.equal(exit.report.userId, "user1");
  assert.equal(exit.report.exit, "dead");
  // Dead players cannot act.
  assert.ok(!send(m, b!, { mx: 1 }));
  assert.ok(!m.interact(b!));
});

test("a kill landing after the shooter already finished updates their result", () => {
  const m = testMatch(2);
  const [a, b] = ids(m);
  const shooter = rtOf(m, a!);
  m.finishPlayer(shooter, "extract");
  const first = m.drainEvents().find((e) => e.type === "outcome");
  assert.ok(first && first.type === "outcome");
  assert.equal(first.msg.kills, 0);

  // Their bullet was still in flight and kills B afterwards.
  const victim = pl(m, b!);
  victim.hp = 5;
  damagePlayer(m, rtOf(m, b!), 15, shooter, "sniper", 0, 0);
  assert.equal(selfOf(m, a!).kills, 1);
  assert.equal(shooter.outcome?.kills, 1);
  assert.equal(shooter.exitReport?.kills, 1);
  assert.equal(shooter.outcome?.exit, "extract");
  const resent = m.drainEvents().find((e) => e.type === "outcome" && e.to === shooter.rosterIndex);
  assert.ok(resent && resent.type === "outcome");
  assert.equal(resent.msg.kills, 1);
  // The copy already sent stays as it was; the resend carries the correction.
  assert.equal(first.msg.kills, 0);
});
