/**
 * Weapons v2 in the authoritative sim (docs/WEAPONS_V2.md): the SMG / LMG / revolver / crossbow
 * stats, the crossbow's quiet shot without a muzzle flash, the hand grenade (throw rules, flight,
 * area damage with wall blocking, windows, armor, self damage, party rule, kill credit) and the
 * NPC side (new guns in marauder kits never drop, NPCs run from a grenade).
 *
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/game-server/src/sim/weapons-v2.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ARMOR,
  GRENADE,
  GRENADE_SOUND,
  ITEM_FLAG,
  RARITY_DAMAGE_MULT,
  SoundKind,
  VISION,
  WEAPONS,
  applyDamage,
  countOf,
  getCollisionIndex,
  grenadeDamageAt,
  grenadePath,
  grenadeThrowPx,
  type HitMsg,
  type WeaponId,
} from "@extract/shared";
import { buildBatches } from "./audience.js";
import { SELF_KILL_CREDIT_MS, damagePlayer } from "./combat.js";
import { spawnGroundItem } from "./inventory.js";
import { makeItem } from "./items.js";
import type { Match } from "./match.js";
import {
  giveItem, giveStack, giveWeapon, ids, npcOpts, npcsOf, pl, place, rtOf, run, selfOf, send, shotsBy, testMap, testMatch, testPost,
  type Timed,
} from "./test-utils.js";

const NO_BRAINS = { npcBrains: false } as const;

const NEW_GUNS: readonly WeaponId[] = ["smg", "lmg", "revolver", "crossbow"];

/** Two humans 300 px apart on open ground (a faces b along +x), b with `hp`. */
function duel(opts: Parameters<typeof testMatch>[1] = {}): { m: Match; a: string; b: string } {
  const m = testMatch(2, opts);
  const [a, b] = ids(m) as [string, string];
  place(m, a, 1000, 1500);
  place(m, b, 1300, 1500);
  return { m, a, b };
}

/** Advance until the bullets of the last shot have landed (no inputs). */
function settle(m: Match, ms = 1500): Timed[] {
  return run(m, ms);
}

test("new guns: one hit deals damage × rarity, the first shot never misses at 300 px with spread", () => {
  for (const w of NEW_GUNS) {
    for (const rarity of [0, 3] as const) {
      const { m, a, b } = duel();
      giveWeapon(m, a, "w1", w, rarity);
      giveStack(m, a, `ammo_${WEAPONS[w].ammo}`, 20);
      run(m, 40, { [a]: { aim: 0, fire: true } });
      run(m, 40, { [a]: { aim: 0, fire: false } });
      settle(m, 1200);
      const want = Math.round((100 - WEAPONS[w].damage * RARITY_DAMAGE_MULT[rarity]) * 100) / 100;
      assert.equal(pl(m, b).hp, want, `${w} r${rarity}`);
    }
  }
});

test("revolver: three hits kill an unarmoured player, a legendary one still needs three", () => {
  for (const rarity of [0, 3] as const) {
    const { m, a, b } = duel();
    giveWeapon(m, a, "w1", "revolver", rarity);
    giveStack(m, a, "ammo_heavy", 20);
    let shots = 0;
    for (let i = 0; i < 6 && pl(m, b).alive; i++) {
      run(m, 40, { [a]: { aim: 0, fire: true } });
      run(m, WEAPONS.revolver.fireIntervalMs, { [a]: { aim: 0, fire: false } });
      shots++;
    }
    settle(m, 600);
    assert.equal(pl(m, b).alive, false, `rarity ${rarity}`);
    assert.equal(shots, 3, `rarity ${rarity}: shots to kill`);
  }
});

test("fire interval and magazine: SMG 75 ms auto, LMG 110 ms with a 60 round box, crossbow one bolt then a reload", () => {
  // Out of the line of fire: count shots only.
  const cases: Array<{ w: WeaponId; ms: number }> = [
    { w: "smg", ms: 1500 },
    { w: "lmg", ms: 2200 },
  ];
  for (const { w, ms } of cases) {
    const m = testMatch(1);
    const [a] = ids(m) as [string];
    place(m, a, 1000, 1500);
    giveWeapon(m, a, "w1", w);
    giveStack(m, a, "ammo_light", 120);
    const ev = run(m, ms, { [a]: { aim: Math.PI, fire: true } });
    const shots = shotsBy(ev, m, a);
    const max = Math.ceil(ms / WEAPONS[w].fireIntervalMs) + 1;
    assert.ok(shots.length <= Math.min(max, WEAPONS[w].magSize), `${w}: ${shots.length} shots in ${ms} ms`);
    assert.ok(shots.length >= Math.min(max, WEAPONS[w].magSize) - 2, `${w}: ${shots.length} shots in ${ms} ms`);
    // Held fire averages the interval (the schedule carries across 50 ms ticks), one shot per tick at most.
    const n = shots.length - 1;
    const avg = (shots[n]!.at - shots[0]!.at) / n;
    assert.ok(avg >= WEAPONS[w].fireIntervalMs - 1e-6 && avg <= WEAPONS[w].fireIntervalMs + 50 / n, `${w}: average interval ${avg.toFixed(1)}`);
    for (let i = 1; i < shots.length; i++) assert.ok(shots[i]!.at - shots[i - 1]!.at >= 50 - 1e-6, `${w}: two shots in one tick`);
  }
  assert.equal(WEAPONS.lmg.magSize, 60);
  // Crossbow: a press fires its one bolt and starts the 2.3 s reload at once.
  const m = testMatch(1);
  const [a] = ids(m) as [string];
  place(m, a, 1000, 1500);
  giveWeapon(m, a, "w1", "crossbow", 1);
  giveStack(m, a, "ammo_bolt", 5);
  const ev = run(m, 100, { [a]: { aim: Math.PI, fire: true } });
  assert.equal(shotsBy(ev, m, a).length, 1);
  const self = selfOf(m, a);
  assert.ok(self.reloadUntil > 0, "reload starts after the only bolt");
  assert.ok(Math.abs(self.reloadUntil - (shotsBy(ev, m, a)[0]!.at + WEAPONS.crossbow.reloadMs)) <= 60);
  run(m, WEAPONS.crossbow.reloadMs + 100, { [a]: { aim: Math.PI, fire: false } });
  assert.equal(self.slots.get("w1")!.mag, 1);
  assert.equal(self.reloadUntil, 0);
});

test("crossbow: shot heard only 450 px away (quieter than a footstep), no muzzle flash, a slow bolt", () => {
  const { m, a, b } = duel();
  giveWeapon(m, a, "w1", "crossbow", 1);
  giveStack(m, a, "ammo_bolt", 5);
  place(m, b, 1000, 2500); // out of the line of fire
  const ev = run(m, 60, { [a]: { aim: 0, fire: true } });
  const shot = shotsBy(ev, m, a)[0]!;
  assert.ok(shot);
  const snd = ev.find((e) => e.type === "sound" && e.kind === SoundKind.shot && e.src === rtOf(m, a).rosterIndex);
  assert.ok(snd && snd.type === "sound");
  assert.equal(snd.radius, 450);
  assert.ok(snd.radius < 800, "quieter than a running footstep");
  // No flash: lastShotAt sits VISION.FLASH_MS back, so the flash rule (sinceShot < FLASH_MS) never applies.
  const rt = rtOf(m, a);
  assert.ok(shot.at - rt.lastShotAt >= VISION.FLASH_MS);
  assert.ok(shot.at - rt.lastShotAt < VISION.SHOT_REVEAL_MS, "bush concealment is still cancelled");
  // A pistol shot does flash.
  const p = duel();
  giveStack(p.m, p.a, "ammo_light", 12);
  place(p.m, p.b, 1000, 2500);
  const pev = run(p.m, 60, { [p.a]: { aim: 0, fire: true } });
  assert.equal(rtOf(p.m, p.a).lastShotAt, shotsBy(pev, p.m, p.a)[0]!.at);
  // Bolt flight: 1100 px/s, so a target 300 px away is hit ≈ 0.27 s after the shot (a rifle bullet ≈ 0.16 s).
  const d = duel();
  giveWeapon(d.m, d.a, "w1", "crossbow", 1);
  giveStack(d.m, d.a, "ammo_bolt", 5);
  const hev = run(d.m, 600, { [d.a]: { aim: 0, fire: true } });
  const fired = shotsBy(hev, d.m, d.a)[0]!.at;
  const hit = hev.find((e) => e.type === "hit" && e.target === rtOf(d.m, d.b).rosterIndex);
  assert.ok(hit);
  const travel = ((300 - 24) / WEAPONS.crossbow.bulletSpeed) * 1000;
  assert.ok(Math.abs(hit.at - fired - travel) <= 60, `bolt landed after ${hit.at - fired} ms, want ≈ ${travel.toFixed(0)}`);
});

test("party: a crossbow bolt passes through a party mate and hits whoever stands behind", () => {
  const m = testMatch(3);
  const [a, b, c] = ids(m) as [string, string, string];
  place(m, a, 1000, 1500);
  place(m, b, 1200, 1500);
  place(m, c, 1400, 1500);
  rtOf(m, a).partyId = "party-1";
  rtOf(m, b).partyId = "party-1";
  giveWeapon(m, a, "w1", "crossbow", 1);
  giveStack(m, a, "ammo_bolt", 5);
  run(m, 60, { [a]: { aim: 0, fire: true } });
  settle(m, 800);
  assert.equal(pl(m, b).hp, 100, "mate untouched");
  assert.equal(pl(m, c).hp, 100 - WEAPONS.crossbow.damage * RARITY_DAMAGE_MULT[1]);
});

// ---------------------------------------------------------------- grenade

test("grenade damage table: 85 within 64 px, linear to 10 at 240 px, nothing beyond; armor absorbs as usual", () => {
  assert.equal(grenadeDamageAt(0), 85);
  assert.equal(grenadeDamageAt(64), 85);
  assert.equal(Math.round(grenadeDamageAt(120)), 61);
  assert.equal(Math.round(grenadeDamageAt(180)), 36);
  assert.equal(grenadeDamageAt(240), 10);
  assert.equal(grenadeDamageAt(241), 0);
  // WEAPONS_V2 §4 table, full-durability armor.
  const lvl = (d: number, a: 1 | 2 | 3) => Math.round(applyDamage(grenadeDamageAt(d), a, ARMOR[a].durability).hpLoss);
  assert.deepEqual([lvl(0, 1), lvl(0, 2), lvl(0, 3)], [68, 55, 43]);
  assert.deepEqual([lvl(240, 1), lvl(240, 2), lvl(240, 3)], [8, 7, 5]);
  // The throw distance follows the fraction.
  assert.equal(grenadeThrowPx(0), GRENADE.MIN_PX);
  assert.equal(grenadeThrowPx(1), GRENADE.MAX_PX);
  assert.equal(grenadeThrowPx(5), GRENADE.MAX_PX);
  assert.equal(grenadeThrowPx(NaN), GRENADE.MAX_PX);
});

test("grenade flight: rests at the aimed point after FLIGHT_MS in the open, bounces off a wall and loses 65 % of its speed", () => {
  const open = getCollisionIndex(testMap());
  const p = grenadePath(open, 1000, 1500, 0, 400);
  assert.equal(p.length, 2);
  assert.ok(Math.abs(p[1]!.x - 1400) < 1e-6 && Math.abs(p[1]!.y - 1500) < 1e-6);
  assert.ok(Math.abs(p[1]!.t - GRENADE.FLIGHT_MS) < 1e-6);
  // A wall at x 1200..1224 in the way: one bounce back west, resting west of the wall.
  const walled = getCollisionIndex(testMap({ walls: [{ x: 1200, y: 1000, w: 24, h: 1000 }] }));
  const q = grenadePath(walled, 1000, 1500, 0, 400);
  assert.ok(q.length >= 3, JSON.stringify(q));
  const bounce = q[1]!;
  assert.equal(bounce.bounce, true);
  assert.ok(Math.abs(bounce.x - (1200 - GRENADE.WALL_GAP_PX)) < 1e-6);
  const rest = q[q.length - 1]!;
  assert.ok(rest.x < 1200 && rest.x > 1000, `rests at ${rest.x}`);
  // After the bounce it rolls back BOUNCE_KEEP² of the remaining travel (speed × 0.35 → distance × 0.1225).
  const s = 200 - GRENADE.WALL_GAP_PX;
  const leftAfterBounce = 400 - s; // distance it would still have gone without the wall
  // v² ∝ remaining distance: the rebound travel = keep² × leftAfterBounce.
  assert.ok(Math.abs(bounce.x - rest.x - GRENADE.BOUNCE_KEEP ** 2 * leftAfterBounce) < 1e-6);
  assert.ok(rest.t > bounce.t && rest.t < GRENADE.FLIGHT_MS);
  // The map edge bounces it back like a wall (never resting off the map).
  const edge = grenadePath(open, 2000, 1500, 0, 400, { width: 2100, height: 3000 });
  assert.equal(edge[1]!.bounce, true);
  assert.ok(Math.abs(edge[1]!.x - (2100 - GRENADE.WALL_GAP_PX)) < 1e-6);
  assert.ok(edge.every((q) => q.x >= 0 && q.x <= 2100), JSON.stringify(edge));
  // Windows do not stop a grenade (SHOT mask, like bullets).
  const win = getCollisionIndex(testMap({ windows: [{ x: 1200, y: 1000, w: 24, h: 1000 }] }));
  const w = grenadePath(win, 1000, 1500, 0, 400);
  assert.equal(w.length, 2);
  assert.ok(Math.abs(w[1]!.x - 1400) < 1e-6);
});

/** Throw a grenade from a toward +x so that it rests exactly `dist` px east of a (no wall). */
function throwAt(m: Match, a: string, dist: number): void {
  const frac = (dist - GRENADE.MIN_PX) / (GRENADE.MAX_PX - GRENADE.MIN_PX);
  const g = m.throwGrenade(a, 0, frac);
  assert.ok(typeof g === "object", `throw refused: ${String(g)}`);
}

test("grenade: area damage by distance from the blast, kill credit 'grenade', the stack goes down by one", () => {
  const m = testMatch(4);
  const [a, b, c, d] = ids(m) as [string, string, string, string];
  place(m, a, 1000, 1500);
  giveStack(m, a, "grenade", 2);
  // Blast at (1400, 1500): b at 40 px, c at 180 px, d at 300 px.
  place(m, b, 1440, 1500);
  place(m, c, 1400, 1680);
  place(m, d, 1700, 1500);
  pl(m, b).hp = 50;
  throwAt(m, a, 400);
  assert.equal(countOf(selfOf(m, a).slots, "grenade"), 1);
  const ev = run(m, GRENADE.FUSE_MS + 100);
  assert.equal(pl(m, b).alive, false);
  assert.ok(Math.abs(pl(m, c).hp - (100 - grenadeDamageAt(180))) < 0.02, `c hp ${pl(m, c).hp}`);
  assert.equal(pl(m, d).hp, 100);
  assert.equal(pl(m, a).hp, 100, "thrower 400 px away is fine");
  const kill = ev.find((e) => e.type === "kill");
  assert.ok(kill && kill.type === "kill");
  assert.equal(kill.msg.weapon, "grenade");
  assert.equal(kill.msg.killerId, a);
  assert.equal(selfOf(m, a).kills, 1);
  // The blast: one explosion world sound at the resting point, 3400 px.
  const boom = ev.find((e) => e.type === "sound" && e.kind === SoundKind.explosion);
  assert.ok(boom && boom.type === "sound");
  assert.equal(boom.src, -1);
  assert.equal(boom.radius, 3400);
  assert.ok(Math.abs(boom.x - 1400) < 0.5 && Math.abs(boom.y - 1500) < 0.5);
  // It went off FUSE_MS after the throw.
  const hit = ev.find((e) => e.type === "hit" && e.target === rtOf(m, c).rosterIndex)!;
  assert.ok(Math.abs(hit.at - GRENADE.FUSE_MS) <= 60);
  assert.equal(m.grenades.length, 0);
});

test("grenade: a wall between the blast and a target stops it, a window does not; the damage arc points at the blast", () => {
  // Blast at (1400, 1500). Wall x 1450..1474 (y 1300..1700) between it and b (1520, 1500);
  // window x 1376..1400 … actually south: window y 1550..1574 (x 1300..1500) between it and c (1400, 1640).
  const map = testMap({
    walls: [{ x: 1450, y: 1300, w: 24, h: 400 }],
    windows: [{ x: 1300, y: 1550, w: 200, h: 24 }],
  });
  const m = testMatch(3, { map });
  const [a, b, c] = ids(m) as [string, string, string];
  place(m, a, 1000, 1500);
  place(m, b, 1520, 1500);
  place(m, c, 1400, 1640);
  giveStack(m, a, "grenade", 1);
  throwAt(m, a, 400);
  const ev = run(m, GRENADE.FUSE_MS + 100);
  assert.equal(pl(m, b).hp, 100, "behind a wall: no damage");
  assert.ok(Math.abs(pl(m, c).hp - (100 - grenadeDamageAt(140))) < 0.02, `through a window: ${pl(m, c).hp}`);
  const hit = ev.find((e) => e.type === "hit" && e.target === rtOf(m, c).rosterIndex);
  assert.ok(hit && hit.type === "hit");
  assert.ok(hit.fa !== undefined && Math.abs(hit.fa - -Math.PI / 2) < 1e-6, `arc ${hit.fa}`);
});

test("grenade: hurts the thrower (no credit, no self hit marker), never a party mate, NPCs yes", () => {
  const m = testMatch(3, { ...npcOpts([testPost(0, 1080, 1600)]), ...NO_BRAINS });
  const [a, b, c] = ids(m) as [string, string, string];
  const npc = npcsOf(m)[0]!;
  place(m, a, 1000, 1500);
  place(m, b, 1050, 1500);
  place(m, c, 3000, 1000);
  npc.pub.x = 1080;
  npc.pub.y = 1560;
  rtOf(m, a).partyId = "p";
  rtOf(m, b).partyId = "p";
  giveStack(m, a, "grenade", 1);
  // Short throw west against nothing: rests 120 px west of a, at (880, 1500).
  const g = m.throwGrenade(a, Math.PI, 0);
  assert.ok(typeof g === "object");
  const ev = run(m, GRENADE.FUSE_MS + 100);
  assert.ok(Math.abs(pl(m, a).hp - (100 - grenadeDamageAt(120))) < 0.02, `thrower ${pl(m, a).hp}`);
  assert.equal(pl(m, b).hp, 100, "party mate untouched");
  const npcLoss = npc.pub.maxHp - npc.pub.hp;
  assert.ok(npcLoss > 0 || !npc.pub.alive, "the NPC takes damage");
  const selfHit = ev.find((e) => e.type === "hit" && e.target === rtOf(m, a).rosterIndex);
  assert.ok(selfHit && selfHit.type === "hit");
  assert.equal(selfHit.src, -1);
  assert.equal(selfHit.msg.s, "");
  assert.equal(rtOf(m, a).lastHitBy, null);
});

test("grenade: the thrower learns nothing about a victim they do not see (no id, no spot, no HP loss)", () => {
  // b sits still in a bush 40 px from the blast centre (1400, 1500); c, out in the open, sees b.
  const map = testMap({ bushes: [{ x: 1440, y: 1500, r: 70 }] });
  const m = testMatch(3, { map });
  const [a, b, c] = ids(m) as [string, string, string];
  for (const id of [a, b, c]) rtOf(m, id).connected = true;
  place(m, a, 1000, 1500);
  place(m, b, 1440, 1500);
  place(m, c, 1440, 1620);
  pl(m, a).aim = 0;
  pl(m, b).aim = Math.PI;
  pl(m, c).aim = -Math.PI / 2;
  run(m, 3000); // b settles in the bush (concealment)
  const ra = rtOf(m, a).rosterIndex, rb = rtOf(m, b).rosterIndex, rc = rtOf(m, c).rosterIndex;
  assert.equal(m.vision.sees(ra, rb), false, "a does not see b in the bush");
  assert.equal(m.vision.sees(rc, rb), true, "c, 120 px away, does");
  giveStack(m, a, "grenade", 1);
  throwAt(m, a, 400);
  m.drainEvents();
  const toA: HitMsg[] = [];
  const toC: HitMsg[] = [];
  for (let i = 0; i < 70; i++) {
    m.step(50);
    const batches = buildBatches(m, m.drainEvents(), [ra, rb, rc], null);
    toA.push(...(batches.get(ra)?.hits ?? []));
    toC.push(...(batches.get(rc)?.hits ?? []));
  }
  assert.ok(pl(m, b).hp < 100, "b was hurt");
  const bId = rtOf(m, b).id;
  assert.equal(toA.some((h) => h.t === bId), false, "the thrower never gets b's id");
  const confirmed = toA.filter((h) => h.t === "");
  assert.equal(confirmed.length, 1, "one 'hit confirmed'");
  assert.deepEqual(confirmed[0], { t: "", s: a, x: 1400, y: 1500, d: 0, ar: false }, "blast centre only, no HP loss");
  const seen = toC.find((h) => h.t === bId);
  assert.ok(seen && Math.abs(seen.x - 1440) < 1e-6 && seen.d > 0, "a viewer who sees b gets the full hit");
});

test("grenade: blowing yourself up never denies the attacker who hurt you the kill", () => {
  const m = testMatch(2);
  const [a, b] = ids(m) as [string, string];
  place(m, a, 1000, 1500);
  place(m, b, 1300, 1500);
  // b shot a down to 10 HP; a throws a grenade at their own feet.
  damagePlayer(m, rtOf(m, a), 90, rtOf(m, b), "rifle", 1000, 1500);
  giveStack(m, a, "grenade", 1);
  assert.ok(typeof m.throwGrenade(a, Math.PI, 0) === "object");
  const ev = run(m, GRENADE.FUSE_MS + 100);
  assert.equal(pl(m, a).alive, false);
  const kill = ev.find((e) => e.type === "kill");
  assert.ok(kill && kill.type === "kill");
  assert.equal(kill.msg.killerId, b, "credited to the last attacker");
  assert.equal(selfOf(m, b).kills, 1);
  assert.deepEqual(rtOf(m, b).victims, [rtOf(m, a).userId]);
  assert.equal(rtOf(m, a).killerUserId, rtOf(m, b).userId, "full dog tag price for b");
  // Long after the last enemy hit (SELF_KILL_CREDIT_MS) a suicide credits nobody.
  const m2 = testMatch(2);
  const [a2, b2] = ids(m2) as [string, string];
  place(m2, a2, 1000, 1500);
  place(m2, b2, 1300, 1500);
  damagePlayer(m2, rtOf(m2, a2), 90, rtOf(m2, b2), "rifle", 1000, 1500);
  run(m2, SELF_KILL_CREDIT_MS + 500);
  giveStack(m2, a2, "grenade", 1);
  assert.ok(typeof m2.throwGrenade(a2, Math.PI, 0) === "object");
  const ev2 = run(m2, GRENADE.FUSE_MS + 100);
  const k2 = ev2.find((e) => e.type === "kill");
  assert.ok(k2 && k2.type === "kill" && k2.msg.killerId === "");
  assert.equal(selfOf(m2, b2).kills, 0);
});

test("C2S.THROW joins the input stream: a throw right after the predicted roll end is never refused as 'rolling'", () => {
  // Client: one input every 33.3 ms (the roll on the first), THROW 1 ms after the 10th (last roll) input.
  // Server: 50 ms ticks at an offset. Before the fix three of the four offsets refused the throw.
  for (const offset of [0, 10, 25, 40]) {
    const m = testMatch(1);
    const [a] = ids(m) as [string];
    place(m, a, 1000, 1500);
    giveStack(m, a, "grenade", 1);
    const evs: Array<{ t: number; kind: "in" | "tick" | "throw"; k?: number }> = [];
    for (let k = 0; k < 14; k++) evs.push({ t: k * (1000 / 30), kind: "in", k });
    evs.push({ t: 9 * (1000 / 30) + 1, kind: "throw" });
    for (let j = 0; j < 16; j++) evs.push({ t: offset + j * 50, kind: "tick" });
    evs.sort((x, y) => x.t - y.t || (x.kind === "tick" ? 1 : -1));
    let result: unknown = null;
    let xAtThrow = NaN;
    for (const e of evs) {
      if (e.kind === "in") m.enqueueInput(a, { seq: e.k! + 1, mx: 1, my: 0, aim: 0, roll: e.k === 0, walk: false, fire: false });
      else if (e.kind === "tick") {
        m.step(50);
        if (Number.isNaN(xAtThrow) && m.grenades.length > 0) xAtThrow = m.grenades[0]!.path[0]!.x;
      } else result = m.requestThrow(a, 0, 0.5, 10);
    }
    assert.ok(result === "queued" || typeof result === "object", `offset ${offset}: ${String(result)}`);
    assert.equal(m.grenades.length, 1, `offset ${offset}: thrown`);
    assert.equal(countOf(selfOf(m, a).slots, "grenade"), 0);
    // Thrown from where input 10 left the player (the client's predicted spot), not a lagged one.
    assert.ok(Number.isFinite(xAtThrow));
  }
  // Nothing queued: thrown at once; a seq the client never sent is clamped to what arrived.
  const m = testMatch(1);
  const [a] = ids(m) as [string];
  place(m, a, 1000, 1500);
  giveStack(m, a, "grenade", 2);
  assert.equal(typeof m.requestThrow(a, 0, 0.5, 999), "object");
  run(m, GRENADE.COOLDOWN_MS + 50);
  send(m, a, { mx: 1 });
  assert.equal(m.requestThrow(a, 0, 0.5, 999), "queued");
  m.step(50);
  assert.equal(rtOf(m, a).pendingThrow, null);
  assert.equal(countOf(selfOf(m, a).slots, "grenade"), 0, "the queued throw went once its input was applied");
});

test("grenade throw rules: needs a grenade, not while rolling or reloading, 1 s between throws, the gun waits 0.6 s", () => {
  const m = testMatch(1);
  const [a] = ids(m) as [string];
  place(m, a, 1000, 1500);
  assert.equal(m.throwGrenade(a, 0, 0.5), "no_grenade");
  giveStack(m, a, "grenade", 2);
  giveStack(m, a, "ammo_light", 30);
  // Reloading: refused.
  selfOf(m, a).slots.get("w1")!.mag = 3;
  m.reload(a);
  assert.ok(selfOf(m, a).reloadUntil > 0);
  assert.equal(m.throwGrenade(a, 0, 0.5), "reloading");
  run(m, 1500);
  assert.equal(selfOf(m, a).reloadUntil, 0);
  // Rolling: refused.
  send(m, a, { mx: 1, roll: true });
  m.step(50);
  assert.ok(selfOf(m, a).rollLeft > 0);
  assert.equal(m.throwGrenade(a, 0, 0.5), "rolling");
  // The roll advances on inputs only.
  run(m, 600, { [a]: {} });
  assert.equal(selfOf(m, a).rollLeft, 0);
  const t0 = m.clock;
  const g = m.throwGrenade(a, 0, 0.5);
  assert.ok(typeof g === "object");
  assert.equal(m.throwGrenade(a, 0, 0.5), "cooldown");
  // The gun stays locked for FIRE_LOCK_MS.
  const ev = run(m, 400, { [a]: { aim: Math.PI, fire: true } });
  assert.equal(shotsBy(ev, m, a).length, 0);
  run(m, 300, { [a]: { aim: Math.PI, fire: false } });
  const ev2 = run(m, 100, { [a]: { aim: Math.PI, fire: true } });
  assert.equal(shotsBy(ev2, m, a).length, 1);
  assert.ok(m.clock - t0 >= GRENADE.FIRE_LOCK_MS);
  // 1 s after the first throw the second one goes; then the stack is empty.
  run(m, GRENADE.COOLDOWN_MS);
  assert.ok(typeof m.throwGrenade(a, 0, 0.5) === "object");
  assert.equal([...selfOf(m, a).slots.values()].some((i) => i.def === "grenade"), false);
  assert.equal(m.throwGrenade(a, 0, 0.5), "cooldown");
  run(m, GRENADE.COOLDOWN_MS);
  assert.equal(m.throwGrenade(a, 0, 0.5), "no_grenade");
});

test("grenade events: the thrower and those who see them get the flight, a hidden thrower's grenade shows up only where it lands", () => {
  const m2 = testMatch(3);
  const [a2, b2, c2] = ids(m2) as [string, string, string];
  for (const id of [a2, b2, c2]) rtOf(m2, id).connected = true;
  place(m2, a2, 1000, 1500);
  place(m2, b2, 1300, 1450);
  place(m2, c2, 2300, 1500);
  pl(m2, b2).aim = Math.PI;
  pl(m2, c2).aim = Math.PI;
  run(m2, 100);
  giveStack(m2, a2, "grenade", 1);
  m2.throwGrenade(a2, 0, 1);
  const thrown = m2.drainEvents();
  const to = (r: string) => thrown.filter((e) => e.type === "nade" && e.to === rtOf(m2, r).rosterIndex);
  assert.equal(to(a2).length, 1);
  assert.equal(to(b2).length, 1, "b sees the thrower");
  assert.equal(to(c2).length, 0, "c does not see the thrower");
  const full = to(a2)[0]!;
  assert.ok(full.type === "nade" && full.msg.s === a2 && full.msg.p.length === 6 && full.msg.fuse === GRENADE.FUSE_MS);
  const later = run(m2, GRENADE.FUSE_MS + 100);
  const land = later.filter((e) => e.type === "nade" && e.to === rtOf(m2, c2).rosterIndex);
  assert.equal(land.length, 1, "c learns about the grenade once it rests in view");
  const lm = land[0]!;
  assert.ok(lm.type === "nade");
  assert.equal(lm.msg.s, "");
  assert.equal(lm.msg.p.length, 3, "only the resting point");
  assert.ok(Math.abs(lm.msg.p[0]! - 1560) < 0.2);
  const booms = later.filter((e) => e.type === "boom");
  assert.deepEqual(new Set(booms.map((e) => (e.type === "boom" ? e.to : -1))), new Set([a2, b2, c2].map((r) => rtOf(m2, r).rosterIndex)));
  // The pin sound went out at the throw; no bounce in the open.
  assert.equal(thrown.filter((e) => e.type === "sound" && e.kind === SoundKind.grenade).length, 1);
  assert.equal(later.filter((e) => e.type === "sound" && e.kind === SoundKind.grenade).length, 0);
});

test("grenade: a bounce off a wall makes a bounce sound; the thrower's exit report waits for the blast", () => {
  const map = testMap({ walls: [{ x: 1200, y: 1000, w: 24, h: 1000 }] });
  const m = testMatch(2, { map });
  const [a, b] = ids(m) as [string, string];
  place(m, a, 1000, 1500);
  place(m, b, 1100, 1560);
  pl(m, b).hp = 20;
  giveStack(m, a, "grenade", 1);
  const g = m.throwGrenade(a, 0, 1);
  assert.ok(typeof g === "object");
  const throwSnd = m.drainEvents().filter((e) => e.type === "sound" && e.kind === SoundKind.grenade);
  assert.equal(throwSnd.length, 1);
  assert.ok(throwSnd[0]!.type === "sound" && throwSnd[0]!.variant === GRENADE_SOUND.THROW && throwSnd[0]!.radius === 300);
  const ev = run(m, 400);
  const bounce = ev.filter((e) => e.type === "sound" && e.kind === SoundKind.grenade && e.variant === GRENADE_SOUND.BOUNCE);
  assert.equal(bounce.length, 1);
  assert.ok(bounce[0]!.type === "sound" && bounce[0]!.radius === 400 && bounce[0]!.src === -1);
  // The thrower dies before the blast (another hit); the blast still credits the kill.
  damagePlayer(m, rtOf(m, a), 200, null, "", 1000, 1500);
  assert.equal(pl(m, a).alive, false);
  const exitsBefore = m.drainEvents().filter((e) => e.type === "exit");
  assert.equal(exitsBefore.length, 0, "exit report held while the grenade is live");
  const after = run(m, GRENADE.FUSE_MS);
  assert.equal(pl(m, b).alive, false);
  const exits = after.filter((e) => e.type === "exit");
  assert.equal(exits.length, 2);
  const ra = exits.find((e) => e.type === "exit" && e.report.userId === rtOf(m, a).userId);
  assert.ok(ra && ra.type === "exit" && ra.report.kills === 1);
});

test("NPCs run from a grenade that lands next to them", () => {
  const m = testMatch(1, npcOpts([testPost(0, 2000, 1500)]));
  const [a] = ids(m) as [string];
  const npc = npcsOf(m)[0]!;
  place(m, a, 1000, 1500);
  giveStack(m, a, "grenade", 1);
  npc.pub.x = 1600;
  npc.pub.y = 1500;
  m.throwGrenade(a, 0, 1); // rests at (1560, 1500), 40 px from the NPC
  run(m, 1800);
  const d = Math.hypot(npc.pub.x - 1560, npc.pub.y - 1500);
  assert.ok(d > GRENADE.EDGE_PX * 0.6, `the NPC stayed ${d.toFixed(0)} px from the grenade`);
});

test("NPC gear stays FREE with a new gun: an SMG kit never reaches the corpse", () => {
  const m = testMatch(1, { ...npcOpts([testPost(0, 2000, 1500)]), ...NO_BRAINS });
  const npc = npcsOf(m)[0]!;
  giveItem(m, npc.id, "smg", "w1", { flags: ITEM_FLAG.FREE });
  damagePlayer(m, npc, 1000, null, "", npc.pub.x, npc.pub.y);
  assert.equal(npc.pub.alive, false);
  const body = m.containers.corpseOf(npc.rosterIndex);
  assert.ok(body);
  assert.equal(body.items.some((i) => i.def === "smg"), false);
  assert.ok(body.items.every((i) => !(i.flags & ITEM_FLAG.FREE)));
});

test("a grenade on the ground is picked up by walking over it, like ammo and meds (stack of 2)", () => {
  const m = testMatch(1);
  const [a] = ids(m) as [string];
  place(m, a, 1000, 1500);
  const g = spawnGroundItem(m, makeItem("grenade", { qty: 3 }), 1010, 1500);
  run(m, 100);
  assert.equal(countOf(selfOf(m, a).slots, "grenade"), 3, "two pocket slots: 2 + 1");
  assert.equal(m.ground.byId.has(g.id), false);
});
