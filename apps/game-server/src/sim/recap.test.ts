/**
 * Death recap (recap.ts): the ring buffer, the per-source aggregation, the recap in the personal
 * OutcomeMsg and the exit report, the party / guest / NPC / own-grenade cases and the fog rules
 * (distance only for a killer the victim saw, the killer's HP only after a trade, other humans never
 * named, a snapshot that never follows anyone after the death).
 *
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/game-server/src/sim/recap.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DEATH_RECAP, NPC_ROLE } from "@extract/shared";
import { damagePlayer } from "./combat.js";
import { HitRing, aggregateSources, type HitRecord } from "./recap.js";
import type { PlayerRuntime } from "./types.js";
import { ids, npcOpts, npcsOf, pl, place, rtOf, run, testMatch, testPost } from "./test-utils.js";

const fakeRt = (n: number) => ({ rosterIndex: n }) as unknown as PlayerRuntime;

test("recap: the hit ring keeps only the last MAX_HITS hits, oldest first", () => {
  const r = new HitRing(4);
  for (let i = 0; i < 10; i++) r.push({ at: i * 100, src: null, weapon: "rifle", rarity: 0, dmg: i });
  assert.equal(r.size, 4, "bounded");
  assert.deepEqual(r.since(0).map((h) => h.dmg), [6, 7, 8, 9], "oldest overwritten first, order kept");
  assert.deepEqual(r.since(750).map((h) => h.dmg), [8, 9], "window filter");
  assert.equal(new HitRing().cap, DEATH_RECAP.MAX_HITS);
});

test("recap: hits aggregate per source and weapon, biggest first; past MAX_SOURCES the rest folds into one line", () => {
  const a = fakeRt(1), b = fakeRt(2), c = fakeRt(3), d = fakeRt(4);
  const hits: HitRecord[] = [
    { at: 0, src: a, weapon: "rifle", rarity: 2, dmg: 21.4 },
    { at: 1, src: b, weapon: "grenade", rarity: -1, dmg: 40 },
    { at: 2, src: a, weapon: "rifle", rarity: 2, dmg: 21.4 },
    { at: 3, src: a, weapon: "pistol", rarity: 0, dmg: 9 },
    { at: 4, src: c, weapon: "smg", rarity: 1, dmg: 5 },
    { at: 5, src: d, weapon: "smg", rarity: 1, dmg: 4 },
    { at: 6, src: a, weapon: "rifle", rarity: 2, dmg: 21.4 },
  ];
  const label = (s: PlayerRuntime | null) => ({ who: s === a ? ("killer" as const) : ("raider" as const), name: s === a ? "Viper" : "", role: 0 });
  const out = aggregateSources(hits, label, 4);
  assert.deepEqual(out, [
    { who: "killer", name: "Viper", role: 0, weapon: "rifle", rarity: 2, dmg: 64, hits: 3 },
    { who: "raider", name: "", role: 0, weapon: "grenade", rarity: -1, dmg: 40, hits: 1 },
    { who: "killer", name: "Viper", role: 0, weapon: "pistol", rarity: 0, dmg: 9, hits: 1 },
    { who: "other", name: "", role: 0, weapon: "", rarity: -1, dmg: 9, hits: 2 },
  ]);
  assert.equal(aggregateSources(hits.slice(0, 3), label, 4).length, 2, "no fold when it fits");
});

/** Two humans 160 px apart facing each other, a few ticks so the vision rows hold them. */
function duel(n = 3) {
  const m = testMatch(n);
  const [a, b, c] = ids(m);
  place(m, a!, 1500, 1500);
  place(m, b!, 1660, 1500);
  if (c) place(m, c, 1500, 1900);
  pl(m, a!).aim = 0;
  pl(m, b!).aim = Math.PI;
  run(m, 200);
  return { m, a: rtOf(m, a!), b: rtOf(m, b!), c: c ? rtOf(m, c) : null };
}

test("recap: a human killer seen at the death — name, weapon + rarity, distance, damage by source, HP after a trade", () => {
  const { m, a, b, c } = duel();
  assert.ok(m.vision.sees(b.rosterIndex, a.rosterIndex), "precondition: B sees A");
  damagePlayer(m, b, 20, c, "shotgun", b.pub.x, b.pub.y, undefined, 0);
  damagePlayer(m, a, 30, b, "smg", a.pub.x, a.pub.y, undefined, 1); // B trades with A
  for (let i = 0; i < 5 && b.pub.alive; i++) damagePlayer(m, b, 25, a, "rifle", b.pub.x, b.pub.y, undefined, 2);
  assert.equal(b.pub.alive, false);
  const r = b.outcome!.recap!;
  assert.ok(r, "the personal outcome carries the recap");
  assert.equal(r.killer.kind, "human");
  assert.equal(r.killer.name, a.nickname);
  assert.equal(r.killer.role, NPC_ROLE.NONE);
  assert.deepEqual([r.killer.weapon, r.killer.rarity], ["rifle", 2]);
  assert.equal(r.killer.distM, 4, "160 px = 4 m");
  assert.deepEqual([r.killer.hp, r.killer.hpMax], [70, 100], "the killer's HP: B hit A in the window");
  assert.equal(r.killer.party, false);
  assert.equal(r.killer.guest, undefined);
  assert.deepEqual(r.sources.map((s) => [s.who, s.name, s.weapon, s.hits]), [["killer", a.nickname, "rifle", 4], ["raider", "", "shotgun", 1]]);
  assert.equal(r.sources[0]!.dmg + r.sources[1]!.dmg, r.total);
  assert.equal(r.total, 100);
  assert.equal(r.windowMs, DEATH_RECAP.WINDOW_MS);
  // The web report names the killer for the after-raid card.
  assert.deepEqual([b.exitReport!.killedBy, b.exitReport!.killedByRole], [a.nickname, 0]);
  // The killer and the bystander get no recap (alive); an extract never carries one.
  assert.equal(a.recap, null);
});

test("recap fog: an unseen killer has no distance, no HP without a trade, other humans are never named, the snapshot never moves", () => {
  const { m, a, b, c } = duel();
  // A shoots from far outside B's sight (vision range 1000 px).
  place(m, a.id, 4000, 4000);
  run(m, 100);
  assert.equal(m.vision.sees(b.rosterIndex, a.rosterIndex), false, "precondition: B does not see A");
  damagePlayer(m, b, 30, c, "pistol", b.pub.x, b.pub.y, undefined, 3);
  for (let i = 0; i < 5 && b.pub.alive; i++) damagePlayer(m, b, 40, a, "sniper", b.pub.x, b.pub.y, undefined, 1);
  const r = b.outcome!.recap!;
  assert.equal(r.killer.distM, undefined, "no distance to an unseen killer");
  assert.equal(r.killer.hp, undefined, "no HP: B never hit A");
  assert.equal(r.killer.hpMax, undefined);
  const other = r.sources.find((s) => s.weapon === "pistol")!;
  assert.deepEqual([other.who, other.name], ["raider", ""], "a non-killer human is never named");
  const json = JSON.stringify(r);
  assert.ok(!json.includes(c!.nickname), "the bystander's nickname is nowhere in the recap");
  const before = structuredClone(r);
  // The killer moves on and gets hurt after the death: the recap is a snapshot of the death tick.
  place(m, a.id, 2000, 2000);
  damagePlayer(m, a, 50, c, "pistol", a.pub.x, a.pub.y, undefined, 0);
  run(m, 500);
  assert.deepEqual(b.outcome!.recap, before);
  // Old hits (outside the window) never show up.
  const { m: m2, a: a2, b: b2 } = duel(2);
  damagePlayer(m2, b2, 30, a2, "pistol", b2.pub.x, b2.pub.y, undefined, 0);
  run(m2, DEATH_RECAP.WINDOW_MS + 500);
  for (let i = 0; i < 5 && b2.pub.alive; i++) damagePlayer(m2, b2, 40, a2, "rifle", b2.pub.x, b2.pub.y, undefined, 0);
  const r2 = b2.outcome!.recap!;
  assert.deepEqual(r2.sources.map((s) => s.weapon), ["rifle"], "the pistol hit is older than the window");
});

test("recap: a party killer — the party flag, the mate's damage labelled 'party' (unnamed), a guest killer flagged", () => {
  const { m, a, b, c } = duel();
  a.partyId = "p1";
  c!.partyId = "p1";
  a.guest = true;
  damagePlayer(m, b, 35, c, "rifle", b.pub.x, b.pub.y, undefined, 1);
  for (let i = 0; i < 5 && b.pub.alive; i++) damagePlayer(m, b, 40, a, "shotgun", b.pub.x, b.pub.y, undefined, 3);
  const r = b.outcome!.recap!;
  assert.equal(r.killer.party, true);
  assert.equal(r.killer.guest, true);
  assert.deepEqual([r.killer.weapon, r.killer.rarity], ["shotgun", 3]);
  const mate = r.sources.find((s) => s.who === "party")!;
  assert.deepEqual([mate.name, mate.weapon, mate.rarity, mate.hits], ["", "rifle", 1, 1]);
});

test("recap: an NPC killer by role name, a grenade line, and an own grenade with nobody to credit", () => {
  const m = testMatch(1, npcOpts([testPost(0, 1500, 1500)]));
  const [h] = ids(m);
  const victim = rtOf(m, h!);
  const npc = npcsOf(m)[0]!;
  place(m, h!, 1600, 1500);
  damagePlayer(m, victim, 40, npc, "grenade", victim.pub.x, victim.pub.y, { x: 1590, y: 1500 });
  for (let i = 0; i < 5 && victim.pub.alive; i++) damagePlayer(m, victim, 30, npc, "rifle", victim.pub.x, victim.pub.y, undefined, 0);
  const r = victim.outcome!.recap!;
  assert.equal(r.killer.kind, "npc");
  assert.equal(r.killer.role, NPC_ROLE.MARAUDER);
  assert.equal(r.killer.name, npc.nickname);
  assert.equal(r.killer.party, false, "NPCs are never a party");
  const g = r.sources.find((s) => s.weapon === "grenade")!;
  assert.deepEqual([g.who, g.rarity, g.dmg], ["killer", -1, 40]);
  assert.deepEqual([victim.exitReport!.killedBy, victim.exitReport!.killedByRole], [npc.nickname, NPC_ROLE.MARAUDER]);

  const m2 = testMatch(1);
  const [h2] = ids(m2);
  const v2 = rtOf(m2, h2!);
  place(m2, h2!, 1500, 1500);
  damagePlayer(m2, v2, 500, null, "grenade", 1500, 1500, { x: 1500, y: 1500 });
  const r2 = v2.outcome!.recap!;
  assert.deepEqual([r2.killer.kind, r2.killer.name, r2.killer.weapon], ["self", "", "grenade"]);
  assert.deepEqual(r2.sources.map((s) => s.who), ["self"]);
  assert.equal(v2.exitReport!.killedBy, undefined, "no killer to name");
});
