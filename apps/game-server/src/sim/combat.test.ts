import { test } from "node:test";
import assert from "node:assert/strict";
import { ARMOR, PLAYER, RARITY_DAMAGE_MULT, WEAPONS } from "@extract/shared";
import { damagePlayer } from "./combat.js";
import type { MatchEvent } from "./types.js";
import { addExtract, giveWeapon, ids, pl, place, run, send, testMatch } from "./test-utils.js";

type Ev = MatchEvent & { at: number };
const shotsBy = (events: Ev[], id: string) =>
  events.filter((e): e is Extract<Ev, { type: "shot" }> => e.type === "shot" && e.msg.s === id);

test("armor absorbs its share and wears down by the absorbed amount", () => {
  const m = testMatch(2);
  const [a, b] = ids(m);
  const target = pl(m, b!);
  target.armor = 2;
  target.armorDur = ARMOR[2].durability;
  target.armorUid = "armor-1";

  const raw = WEAPONS.rifle.damage * RARITY_DAMAGE_MULT[1];
  damagePlayer(m, target, raw, m.runtime(a!)!, "rifle", 0, 0);
  const absorbed = raw * ARMOR[2].absorb;
  assert.equal(target.hp, Math.round((100 - (raw - absorbed)) * 100) / 100);
  assert.equal(target.armorDur, Math.round((ARMOR[2].durability - absorbed) * 100) / 100);
  assert.equal(target.armor, 2);

  const hit = m.drainEvents().find((e) => e.type === "hit");
  assert.ok(hit && hit.type === "hit");
  assert.equal(hit.msg.ar, true);
  assert.equal(hit.msg.t, b);
  assert.equal(hit.msg.s, a);
});

test("armor that runs out of durability breaks and counts as lost", () => {
  const m = testMatch(2);
  const [a, b] = ids(m);
  const target = pl(m, b!);
  target.armor = 1;
  target.armorDur = 1;
  target.armorUid = "armor-x";
  damagePlayer(m, target, 15, m.runtime(a!)!, "pistol", 0, 0);
  // Only 1 point could be absorbed; the rest goes to HP.
  assert.equal(target.hp, 86);
  assert.equal(target.armor, 0);
  assert.equal(target.armorDur, 0);
  assert.equal(target.armorUid, "");
  assert.deepEqual(m.runtime(b!)!.lost.map((r) => r.uid), ["armor-x"]);
});

test("no armor: full damage; armor level 0 ignores leftover durability", () => {
  const m = testMatch(2);
  const [, b] = ids(m);
  const target = pl(m, b!);
  damagePlayer(m, target, 20, null, "", 0, 0);
  assert.equal(target.hp, 80);
});

test("semi-auto fires once per trigger press, auto fires while held at its rate", () => {
  const m = testMatch(2);
  const [a, b] = ids(m);
  place(m, a!, 1000, 1500);
  place(m, b!, 2000, 2500); // out of the line of fire

  // Pistol: holding the trigger for 2 s gives exactly one shot.
  let ev = run(m, 2000, { [a!]: { aim: 0, fire: true } });
  assert.equal(shotsBy(ev, a!).length, 1);
  // Release, press again: one more shot.
  run(m, 100, { [a!]: { aim: 0, fire: false } });
  ev = run(m, 500, { [a!]: { aim: 0, fire: true } });
  assert.equal(shotsBy(ev, a!).length, 1);
  assert.equal(pl(m, a!).slots[0]!.mag, WEAPONS.pistol.magSize - 2);

  // Rapid clicking cannot beat fireIntervalMs.
  ev = [];
  for (let i = 0; i < 20; i++) {
    ev.push(...run(m, 50, { [a!]: { aim: 0, fire: true } }));
    ev.push(...run(m, 50, { [a!]: { aim: 0, fire: false } }));
  }
  const clicks = shotsBy(ev, a!);
  for (let i = 1; i < clicks.length; i++) {
    assert.ok(clicks[i]!.at - clicks[i - 1]!.at >= WEAPONS.pistol.fireIntervalMs);
  }

  // The pistol's cooldown carries over a switch; let it run out first.
  run(m, 400, { [a!]: { aim: 0, fire: false } });
  // Rifle (auto): held for 1 s ≈ 1000 / fireIntervalMs shots, never faster than the interval.
  giveWeapon(m, a!, 1, "rifle");
  assert.ok(m.switchSlot(a!, 1));
  ev = run(m, 1000, { [a!]: { aim: 0, fire: true } });
  const shots = shotsBy(ev, a!);
  assert.ok(shots.length >= 9 && shots.length <= 11, `rifle shots: ${shots.length}`);
  for (let i = 1; i < shots.length; i++) {
    assert.ok(shots[i]!.at - shots[i - 1]!.at >= WEAPONS.rifle.fireIntervalMs);
  }
  assert.equal(pl(m, a!).slots[1]!.mag, WEAPONS.rifle.magSize - shots.length);
});

test("shotgun shot carries every pellet; muzzle is offset along the aim", () => {
  const m = testMatch(1);
  const [a] = ids(m);
  place(m, a!, 1000, 1500);
  giveWeapon(m, a!, 1, "shotgun");
  m.switchSlot(a!, 1);
  const ev = run(m, 100, { [a!]: { aim: Math.PI / 2, fire: true } });
  const shot = shotsBy(ev, a!)[0];
  assert.ok(shot && shot.type === "shot");
  assert.equal(shot.msg.a.length, WEAPONS.shotgun.pellets);
  for (const ang of shot.msg.a) assert.ok(Math.abs(ang - Math.PI / 2) <= WEAPONS.shotgun.spread + 1e-9);
  assert.ok(Math.abs(shot.msg.y - (1500 + WEAPONS.shotgun.muzzle)) < 1e-6);
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
  assert.equal(shotsBy(ev2, a!).length, 1);
  assert.equal(ev2.filter((e) => e.type === "hit").length, 0);
});

test("reload fills the magazine from reserve after reloadMs; switching cancels it", () => {
  const m = testMatch(1);
  const [a] = ids(m);
  place(m, a!, 1000, 1500);
  giveWeapon(m, a!, 1, "rifle", 0, 0);
  m.switchSlot(a!, 1);
  const p = pl(m, a!);
  p.ammoLight = 100;

  assert.ok(m.reload(a!));
  assert.ok(!m.reload(a!), "already reloading");
  run(m, WEAPONS.rifle.reloadMs - 100);
  assert.equal(p.slots[1]!.mag, 0);
  run(m, 150);
  assert.equal(p.slots[1]!.mag, WEAPONS.rifle.magSize);
  assert.equal(p.ammoLight, 100 - WEAPONS.rifle.magSize);
  assert.equal(p.reloadUntil, 0);
  assert.ok(!m.reload(a!), "full magazine");

  // Switching away cancels.
  p.slots[1]!.mag = 3;
  assert.ok(m.reload(a!));
  m.switchSlot(a!, 0);
  assert.equal(p.reloadUntil, 0);
  run(m, WEAPONS.rifle.reloadMs + 100);
  assert.equal(p.slots[1]!.mag, 3);

  // No reserve: nothing to reload.
  p.ammoLight = 0;
  p.slots[0]!.mag = 0;
  assert.ok(!m.reload(a!));
});

test("an empty magazine with reserve reloads automatically", () => {
  const m = testMatch(1);
  const [a] = ids(m);
  place(m, a!, 1000, 1500);
  const p = pl(m, a!);
  p.slots[0]!.mag = 1;
  p.ammoLight = 20;
  run(m, 100, { [a!]: { aim: 0, fire: true } });
  assert.equal(p.slots[0]!.mag, 0);
  assert.ok(p.reloadUntil > 0);
  run(m, WEAPONS.pistol.reloadMs + 50);
  assert.equal(p.slots[0]!.mag, WEAPONS.pistol.magSize);
  assert.equal(p.ammoLight, 20 - WEAPONS.pistol.magSize);
});

test("a kill credits the killer and finishes the victim", () => {
  const m = testMatch(2);
  const [a, b] = ids(m);
  addExtract(m, 4000, 4000);
  const victim = pl(m, b!);
  victim.hp = 10;
  damagePlayer(m, victim, 15, m.runtime(a!)!, "pistol", 0, 0);
  assert.equal(victim.alive, false);
  assert.equal(pl(m, a!).kills, 1);
  const ev = m.drainEvents();
  const kill = ev.find((e) => e.type === "kill");
  assert.ok(kill && kill.type === "kill");
  assert.equal(kill.msg.killerId, a);
  assert.equal(kill.msg.victimId, b);
  const outcome = ev.find((e) => e.type === "outcome");
  assert.ok(outcome && outcome.type === "outcome");
  assert.equal(outcome.to, b);
  assert.equal(outcome.msg.exit, "dead");
  assert.equal(outcome.msg.killedBy, "P0");
  // Dead players cannot act.
  assert.ok(!send(m, b!, { mx: 1 }));
  assert.ok(!m.interact(b!));
});

test("a kill landing after the shooter already finished updates their result", () => {
  const m = testMatch(2);
  const [a, b] = ids(m);
  const shooter = m.runtime(a!)!;
  m.finishPlayer(shooter, "extract");
  const first = m.drainEvents().find((e) => e.type === "outcome");
  assert.ok(first && first.type === "outcome");
  assert.equal(first.msg.kills, 0);

  // Their bullet was still in flight and kills B afterwards.
  const victim = pl(m, b!);
  victim.hp = 5;
  damagePlayer(m, victim, 15, shooter, "sniper", 0, 0);
  assert.equal(pl(m, a!).kills, 1);
  assert.equal(shooter.outcome?.kills, 1);
  assert.equal(shooter.outcome?.exit, "extract");
  const resent = m.drainEvents().find((e) => e.type === "outcome" && e.to === a);
  assert.ok(resent && resent.type === "outcome");
  assert.equal(resent.msg.kills, 1);
  // The copy already sent stays as it was; the resend carries the correction.
  assert.equal(first.msg.kills, 0);
});
