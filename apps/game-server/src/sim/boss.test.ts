/**
 * Bosses and guards (loot economy v4, boss.ts; NPC MODEL v5: a boss group is an NpcSystem squad):
 * spawn from the match seed, kit and pool items, no-break corpses, boss kill credit, heals above
 * PLAYER.MAX_HP, group alert and leash, locals (marauders and the boss group never trade fire),
 * ledger conservation with bosses and carriers on the real Steppe, and a solo free-kit sanity
 * check against the bosses (scripted duel).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BOSSES,
  BOSS_AI,
  CONTAINER_STATE,
  ITEM_FLAG,
  NPC,
  NPC_ROLE,
  PLAYER,
  SERVER_TICK_MS,
  ammoDefOf,
  generateMap,
  bossGroupNpcCount,
  itemDef,
  mulberry32,
  npcPostsOf,
  raidNpcCarriers,
  rollBossJunk,
  rollBossSpawns,
  rollGuardLoot,
  rollNpcSpawns,
  type BossKind,
  type BossSpot,
  type ContainerSpot,
  type ItemLike,
  type LoadoutSnapshot,
  type MapData,
  type Rng,
  type SettledItem,
  type Zone,
} from "@extract/shared";
import { activeWeapon, ammoCount, carriedItems, weaponDefOf } from "./bag.js";
import { placeItem } from "./bag.js";
import { GUARD_FREE_AMMO, BOSS_FREE_AMMO, bossNpcCount, isNpc, startNpcHeal } from "./boss.js";
import { damagePlayer } from "./combat.js";
import { makeItem, withNpcSettlement } from "./items.js";
import { Match, type MatchOptions } from "./match.js";
import { navGridFor, type Pt } from "./nav.js";
import { counterUid, humans, npcOpts, place, run, testMap, testMatch, testPost } from "./test-utils.js";
import type { PlayerRuntime, RosterEntry } from "./types.js";

const steppe = generateMap("steppe");

const settled = (it: { uid: string; def: string; rarity?: number; dur?: number }): SettledItem => ({
  uid: it.uid, def: it.def, qty: 1, rarity: it.rarity ?? 0, dur: it.dur ?? (itemDef(it.def)?.cat === "armor" ? 50 : 80),
});

/** Non-FREE, non-unique stacks of a list, summed by def. */
function fungibles(items: readonly ItemLike[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) if (!it.uid && !(it.flags & ITEM_FLAG.FREE)) out[it.def] = (out[it.def] ?? 0) + it.qty;
  return out;
}

const carried = (rt: PlayerRuntime) => carriedItems(rt).map((c) => c.item);

/** A 4800 px test arena with one zone and the given boss spots (chance 1 = always, 0 = never). */
function bossMap(spots: Array<Partial<BossSpot> & { kind: BossKind }>, o: Parameters<typeof testMap>[0] = {}): MapData {
  const map = testMap(o);
  const zone: Zone = { id: "z", name: "Z", kind: "elevator" as Zone["kind"], tier: 3, rect: { x: 1800, y: 1800, w: 1400, h: 1400 } };
  map.zones = [zone];
  map.bosses = spots.map((s) => ({ zone: "z", x: 2400, y: 2400, guards: [{ x: 2700, y: 2400 }, { x: 2400, y: 2700 }, { x: 2100, y: 2400 }], chance: 1, ...s }));
  return map;
}

function bossMatch(map: MapData, opts: Partial<MatchOptions> = {}): Match {
  return testMatch(1, { map, bosses: true, mapSeed: 4242, ...opts });
}

const npcOf = (m: Match, kind: BossKind, role: "boss" | "guard") =>
  m.bosses.runtimes().filter((rt) => m.bosses.info(rt)!.kind === kind && m.bosses.info(rt)!.role === role);

// ---------------------------------------------------------------- spawn and kit

test("boss spawn: rolled from the match seed only; NPCs after the (humans-only) roster at spot / posts", () => {
  const roster: RosterEntry[] = humans(4);
  const seen = new Set<string>();
  for (let s = 1; s <= 12; s++) {
    const seed = (s * 2654435761) >>> 0;
    const mk = (rngSeed: number) => new Match({ roster, rng: mulberry32(rngSeed), mapSeed: seed, mapId: "steppe", newUid: counterUid, npcBrains: false, emptyWorld: true, bosses: true });
    const m = mk(1);
    const want = rollBossSpawns(seed, steppe.bosses);
    assert.deepEqual(m.bosses.groups.map((g) => g.kind), want.map((b) => b.kind), `seed ${seed}`);
    seen.add(want.map((b) => b.kind).join(","));
    // The match rng plays no part: another rng, same bosses at the same places.
    const m2 = mk(99);
    assert.deepEqual(m2.bosses.runtimes().map((r) => [r.nickname, r.pub.x, r.pub.y]), m.bosses.runtimes().map((r) => [r.nickname, r.pub.x, r.pub.y]));
    assert.equal(m.allRuntimes().length, roster.length + bossNpcCount(want));
    assert.equal(m.state.totalPlayers, roster.length, "HUD counts players only (NPCs neither count nor leak)");
    assert.equal(m.state.aliveCount, roster.length);
    assert.equal(m.npcs.brains.length, 0, "brains off");
    for (const g of m.bosses.groups) {
      const def = BOSSES[g.kind];
      assert.equal(g.guards.length, def.guards.length);
      assert.deepEqual([g.boss.pub.x, g.boss.pub.y], [g.spot.x, g.spot.y]);
      assert.equal(g.boss.pub.role, NPC_ROLE.BOSS);
      assert.equal(g.boss.pub.maxHp, def.hp);
      assert.equal(g.boss.pub.hp, def.hp);
      assert.equal(g.boss.nickname, def.name);
      g.guards.forEach((gr, i) => {
        assert.deepEqual([gr.pub.x, gr.pub.y], [g.spot.guards[i]!.x, g.spot.guards[i]!.y]);
        assert.equal(gr.pub.role, NPC_ROLE.GUARD);
        assert.equal(gr.pub.maxHp, def.guards[i]!.hp);
      });
      for (const rt of [g.boss, ...g.guards]) {
        assert.ok(rt.isNpc && rt.rosterIndex >= roster.length && rt.self.extractMask === 0);
        assert.ok(isNpc(rt));
      }
    }
  }
  assert.ok(seen.size >= 3, `spawn sets vary with the seed: ${[...seen].join(" / ")}`);
  // Off for empty worlds unless asked (rule tests place their own things).
  const off = new Match({ roster, rng: mulberry32(1), mapSeed: 5, mapId: "steppe", newUid: counterUid, npcBrains: false, emptyWorld: true });
  assert.equal(off.bosses.groups.length, 0);
});

test("boss kit without pool items: FREE weapon / armor / backpack, boss junk, non-FREE meds and ammo; guards carry their FREE kit plus rollGuardLoot", () => {
  const m = bossMatch(bossMap([{ kind: "commander" }]), { npcBrains: false });
  const [boss] = npcOf(m, "commander", "boss");
  const def = BOSSES.commander;
  const s = boss!.self.slots;
  assert.equal(s.get("w1")!.def, def.weapon);
  assert.equal(s.get("w1")!.rarity, def.weaponRarity);
  for (const k of ["w1", "armor", "bp"]) assert.ok(s.get(k)!.flags & ITEM_FLAG.FREE, `${k} is FREE`);
  assert.equal(s.get("armor")!.def, `armor_${def.armor}`);
  const ammo = ammoDefOf(def.weapon);
  const want: Record<string, number> = { [ammo]: def.ammo, medkit: def.meds.medkit };
  for (const j of rollBossJunk(m.state.mapSeed, "commander")) want[j.def] = (want[j.def] ?? 0) + j.qty;
  assert.deepEqual(fungibles(carried(boss!)), want);
  assert.equal(carried(boss!).filter((i) => i.def === ammo && i.flags & ITEM_FLAG.FREE).reduce((n, i) => n + i.qty, 0), BOSS_FREE_AMMO);
  npcOf(m, "commander", "guard").forEach((g) => {
    const i = m.bosses.info(g)!.guardIdx;
    const gd = def.guards[i]!;
    assert.equal(g.self.slots.get("w1")!.def, gd.weapon);
    assert.ok(g.self.slots.get("w1")!.flags & ITEM_FLAG.FREE);
    const drop: Record<string, number> = {};
    for (const f of rollGuardLoot(m.state.mapSeed, "commander", i, 3)) drop[f.def] = (drop[f.def] ?? 0) + f.qty;
    assert.deepEqual(fungibles(carried(g)), drop);
    const free = carried(g).filter((x) => x.def === ammoDefOf(gd.weapon) && x.flags & ITEM_FLAG.FREE).reduce((n, x) => n + x.qty, 0);
    assert.equal(free, GUARD_FREE_AMMO);
  });
});

test("boss pool items (live): the best pool weapon is wielded, the rest stowed (never worn); a boss that did not spawn leaves its items on the map", () => {
  const map = bossMap([{ kind: "foreman" }, { kind: "warden", x: 1200, y: 3800, chance: 0 }]);
  const loot: Record<string, SettledItem[]> = {
    "boss:foreman": [
      settled({ uid: "pf-shotgun", def: "shotgun", rarity: 1 }),
      settled({ uid: "pf-rifle", def: "rifle", rarity: 3 }),
      settled({ uid: "pf-armor", def: "armor_3" }),
      settled({ uid: "pf-bp", def: "backpack_2" }),
    ],
    "boss:warden": [settled({ uid: "pw-sniper", def: "sniper", rarity: 2 })],
    boss: [settled({ uid: "legacy-armor", def: "armor_2" })],
  };
  const m = bossMatch(map, { mode: "live", containerLoot: loot, npcBrains: false });
  assert.deepEqual(m.bosses.groups.map((g) => g.kind), ["foreman"]);
  const [boss] = npcOf(m, "foreman", "boss");
  const s = boss!.self.slots;
  assert.equal(s.get("w1")!.uid, "pf-rifle", "legendary rifle wielded");
  assert.equal(s.get("w1")!.flags & ITEM_FLAG.FREE, 0);
  assert.ok(s.get("armor")!.flags & ITEM_FLAG.FREE, "it wears FREE armor, never the pool armor");
  assert.ok(s.get("bp")!.flags & ITEM_FLAG.FREE);
  const uids = carried(boss!).map((i) => i.uid).filter(Boolean).sort();
  assert.deepEqual(uids, ["legacy-armor", "pf-armor", "pf-bp", "pf-rifle", "pf-shotgun"]);
  // Its ammo is for the wielded weapon.
  assert.equal(fungibles(carried(boss!)).ammo_light, BOSSES.foreman.ammo);
  for (const uid of uids) assert.equal(m.ledger.known.get(uid)?.origin, "pool");
  assert.equal(m.ledger.known.get("pw-sniper")?.origin, "pool");

  // End (the human leaves): the living boss times out, the unspawned Warden's item never moved.
  run(m, 1000);
  const human = m.allRuntimes()[0]!;
  damagePlayer(m, human, 10_000, null, "", human.pub.x, human.pub.y);
  run(m, 100);
  assert.ok(m.ended);
  assert.deepEqual(m.ledgerGaps(), []);
  assert.ok(m.report!.leftOnMap.some((i) => i.uid === "pw-sniper"));
  const left = new Set(m.report!.leftOnMap.map((i) => i.uid));
  for (const uid of [...uids, "pw-sniper"]) assert.ok(left.has(uid), `${uid} back to the pool (leftOnMap)`);
  for (const uid of uids) assert.equal(m.ledger.resolved.get(uid), "left", "nothing on a boss is ever lost with wear");
  assert.equal(m.report!.botLost, undefined, "no deprecated bot buckets");
  assert.deepEqual(withNpcSettlement(m.report!, m.allRuntimes()), m.report!);
});

test("boss death: nothing breaks, the corpse holds pool items + boss junk + leftovers, FREE gear vanishes; the killer gets bossKills (guards do not count)", () => {
  const loot: Record<string, SettledItem[]> = {
    "boss:foreman": [settled({ uid: "pf-1", def: "rifle", rarity: 2 }), settled({ uid: "pf-2", def: "armor_2" })],
  };
  const m = bossMatch(bossMap([{ kind: "foreman" }]), { mode: "live", containerLoot: loot, npcBrains: false });
  m.rng = () => 0; // every break roll would succeed for a normal player
  const human = m.allRuntimes()[0]!;
  place(m, human.id, 2400, 2100);
  const [boss] = npcOf(m, "foreman", "boss");
  const before = fungibles(carried(boss!));
  damagePlayer(m, boss!, 100_000, human, "rifle", boss!.pub.x, boss!.pub.y);
  assert.equal(boss!.pub.alive, false);
  assert.equal(human.stats.bossKills, 1);
  assert.equal(human.self.kills, 0, "kills (XP_KILL) count human victims only");
  assert.deepEqual(boss!.exitReport!.lost, [], "no break roll on a boss");
  const corpse = m.containers.corpseOf(boss!.rosterIndex)!;
  assert.deepEqual(corpse.items.map((i) => i.uid).filter(Boolean).sort(), ["pf-1", "pf-2"]);
  assert.ok(corpse.items.every((i) => !(i.flags & (ITEM_FLAG.FREE | ITEM_FLAG.BROKEN))), "no FREE / broken item in the body");
  assert.ok(!corpse.items.some((i) => i.def === "junk_dogtag"));
  assert.deepEqual(fungibles(corpse.items), before, "junk, meds and paid ammo all in the body");

  const [guard] = npcOf(m, "foreman", "guard");
  const gBefore = fungibles(carried(guard!));
  damagePlayer(m, guard!, 100_000, human, "rifle", guard!.pub.x, guard!.pub.y);
  assert.equal(human.stats.bossKills, 1, "a guard is not a boss");
  assert.equal(human.stats.npcKills, 1, "a guard is an NPC kill (XP_NPC)");
  const gc = m.containers.corpseOf(guard!.rosterIndex)!;
  assert.deepEqual(fungibles(gc.items), gBefore);
  assert.ok(gc.items.every((i) => !i.uid && !(i.flags & ITEM_FLAG.FREE)), "guard gear is FREE and vanished");
  // The kill is credited on the exit report the web turns into XP_BOSS.
  damagePlayer(m, human, 10_000, null, "", human.pub.x, human.pub.y);
  assert.equal(human.exitReport!.stats.bossKills, 1);
});

test("boss heal: above PLAYER.MAX_HP, capped at its own maxHp, one medkit per heal, only below HEAL_BELOW_FRAC", () => {
  const m = bossMatch(bossMap([{ kind: "commander" }]));
  const human = m.allRuntimes()[0]!;
  place(m, human.id, 600, 600);
  const [boss] = npcOf(m, "commander", "boss");
  const p = boss!.pub;
  const medkits = () => fungibles(carried(boss!)).medkit ?? 0;
  // Commander: 250 HP (v5 iteration 2 tuning; was 310, 400 in v4), half = 125, 2 medkits (+75 each).
  const max = BOSSES.commander.hp;
  assert.ok(p.maxHp === max && max > PLAYER.MAX_HP + 75 && PLAYER.MAX_HP === 100);
  const half = max * BOSS_AI.HEAL_BELOW_FRAC;
  assert.equal(medkits(), 2);
  p.hp = 30;
  run(m, 6500);
  assert.equal(p.hp, 105, "30 + 75");
  assert.equal(medkits(), 1);
  // Still below half (105 < 125): the second medkit right after, past PLAYER.MAX_HP.
  assert.ok(105 < half);
  run(m, 6500);
  assert.equal(p.hp, 180, "105 + 75: not capped at PLAYER.MAX_HP");
  assert.equal(medkits(), 0);
  p.hp = 50;
  run(m, 8000);
  assert.equal(p.hp, 50, "no medkits left");
  // Above half no heal starts; a heal lands capped at the NPC's own maxHp.
  placeItem(boss!, makeItem("medkit", { qty: 2 }));
  p.hp = Math.ceil(half) + 5;
  run(m, 8000);
  assert.equal(p.hp, Math.ceil(half) + 5);
  p.hp = max - 10;
  assert.ok(startNpcHeal(m, boss!));
  run(m, 6500);
  assert.equal(p.hp, p.maxHp);
});

test("boss heal: never while it is being shot (even by someone it cannot see); it patches up once things calm down", () => {
  const m = bossMatch(bossMap([{ kind: "commander" }]));
  const human = m.allRuntimes()[0]!;
  place(m, human.id, 600, 600);
  human.pub.hp = 1e6;
  const [boss] = npcOf(m, "commander", "boss");
  const p = boss!.pub;
  const medkits = () => fungibles(carried(boss!)).medkit ?? 0;
  run(m, NPC.PEACE_MS + 1000);
  p.hp = 60;
  // Peppered every 2 s from 2400 px away (far beyond any sight): no heal starts.
  for (let t = 0; t < 10_000; t += 2000) {
    damagePlayer(m, boss!, 1, human, "sniper", p.x, p.y);
    run(m, 2000);
    assert.equal(boss!.self.healUntil, 0, `no heal under fire (t ${t})`);
  }
  assert.equal(medkits(), 2);
  run(m, 9000);
  assert.ok(medkits() < 2, "calm again: it heals");
});

test("human spawns keep NPC.SPAWN_CLEAR_PX from every spawned boss group (BossSpot and guard posts) on the Steppe", () => {
  for (let s = 1; s <= 40; s++) {
    const seed = (s * 2654435761) >>> 0;
    const m = new Match({ roster: humans(12), rng: mulberry32(s), mapSeed: seed, mapId: "steppe", newUid: counterUid, npcBrains: false, bosses: true, marauders: false });
    const pts = m.bosses.groups.flatMap((g) => [g.spot, ...g.spot.guards.slice(0, g.guards.length)]);
    for (const rt of m.allRuntimes().filter((r) => !r.isNpc)) {
      for (const q of pts) assert.ok(Math.hypot(q.x - rt.pub.x, q.y - rt.pub.y) >= NPC.SPAWN_CLEAR_PX, `seed ${seed}: spawn ${rt.pub.x},${rt.pub.y} near ${q.x},${q.y}`);
    }
  }
});

// ---------------------------------------------------------------- behaviour

test("alert: a gunshot near the group reaches every member within one think; guards converge inside their leash, the boss holds its room; nobody loots or extracts", () => {
  // A wall between the group and the shooter: they can only hear it.
  const map = bossMap([{ kind: "commander" }], { walls: [{ x: 1500, y: 1750, w: 1800, h: 30 }] });
  const crate: ContainerSpot = { x: 2550, y: 2550, kind: "crate", tier: 3, zone: "z" };
  map.containers = [crate];
  const m = bossMatch(map);
  const human = m.allRuntimes()[0]!;
  place(m, human.id, 2400, 1500);
  const g = m.bosses.groups[0]!;
  run(m, NPC.PEACE_MS + 1000);
  assert.ok(!(g.alertUntil > m.clock), "calm before the shot");
  // One pistol shot (FREE kit) away from the group, behind the wall.
  run(m, 100, { [human.id]: { aim: -Math.PI / 2, fire: true } });
  run(m, 150);
  assert.ok(g.alertUntil > m.clock, "alerted within one think");
  assert.ok(g.alertAt && Math.hypot(g.alertAt.x - 2400, g.alertAt.y - 1500) < 900, `alert near the shot: ${JSON.stringify(g.alertAt)}`);
  const startD = g.guards.map((gr) => Math.hypot(gr.pub.x - g.alertAt!.x, gr.pub.y - g.alertAt!.y));
  let maxOut = 0;
  let bossMax = 0;
  for (let t = 0; t < 15_000; t += 500) {
    run(m, 500);
    for (const gr of g.guards) {
      const info = m.bosses.info(gr)!;
      maxOut = Math.max(maxOut, Math.hypot(gr.pub.x - info.anchor.x, gr.pub.y - info.anchor.y) - info.leash);
    }
    bossMax = Math.max(bossMax, Math.hypot(g.boss.pub.x - g.spot.x, g.boss.pub.y - g.spot.y));
  }
  const endD = g.guards.map((gr) => Math.hypot(gr.pub.x - g.alertAt!.x, gr.pub.y - g.alertAt!.y));
  assert.ok(endD.filter((d, i) => d < startD[i]! - 100).length >= 2, `guards converge: ${startD.map(Math.round)} → ${endD.map(Math.round)}`);
  assert.ok(maxOut <= 200, `guards stay on the leash (out by ${maxOut.toFixed(0)} px)`);
  assert.ok(bossMax <= BOSS_AI.LEASH_BOSS_PX, `boss holds its room (${bossMax.toFixed(0)} px)`);
  for (const rt of m.bosses.runtimes()) {
    assert.equal(rt.stats.containersSearched + rt.stats.corpsesSearched, 0, `${rt.nickname} never loots`);
    assert.equal(rt.exitReport, null, `${rt.nickname} never extracts`);
  }
  assert.equal(m.containers.stateOf(0), CONTAINER_STATE.UNTOUCHED);
});

test("locals: a marauder squad next to the guards never trades fire with them (NPC bullets pass through NPCs); a human in sight is engaged", () => {
  const map = bossMap([{ kind: "foreman" }]);
  const m = new Match({
    roster: humans(1), map, rng: mulberry32(3), mapSeed: 77, newUid: counterUid, strictLedger: true, emptyWorld: true, bosses: true,
    envSeed: 1, weatherOverride: "clear", ...npcOpts([testPost(0, 2550, 2550, { tier: 3, size: [2, 2] })]),
  });
  const human = m.allRuntimes()[0]!;
  place(m, human.id, 600, 600);
  human.pub.hp = 1e6;
  const npcs = new Set(m.npcs.runtimes().map((r) => r.rosterIndex));
  assert.equal(npcs.size, 1 + BOSSES.foreman.guards.length + 2);
  const ev = run(m, NPC.PEACE_MS + 20_000);
  assert.equal(ev.filter((e) => e.type === "shot").length, 0, "nobody shoots without a human in sight");
  // A human walks in among them: the group and the squad fight him; no NPC ever hits an NPC.
  place(m, human.id, 2400, 2250);
  human.pub.aim = Math.PI / 2;
  const ev2 = run(m, 8000);
  const npcShots = ev2.filter((e) => e.type === "shot" && npcs.has(e.src)).length;
  assert.ok(npcShots > 0, "boss / guards / marauders engage the human");
  const friendly = ev2.filter((e) => e.type === "hit" && npcs.has(e.target) && npcs.has(e.src));
  assert.equal(friendly.length, 0, "no NPC damages another NPC");
});

// ---------------------------------------------------------------- ledger with bosses on the Steppe

function poolFor(seed: number): Record<string, SettledItem[]> {
  const defs = ["rifle", "armor_3", "shotgun", "backpack_2", "sniper", "armor_2"];
  const out: Record<string, SettledItem[]> = {};
  let k = 0;
  for (const kind of ["commander", "foreman", "warden"] as BossKind[]) {
    for (const _ of BOSSES[kind].poolSlots) {
      const def = defs[k % defs.length]!;
      (out[`boss:${kind}`] ??= []).push(settled({ uid: `P${seed}-${k}`, def, rarity: k % 4 }));
      k++;
    }
  }
  // A few T3/T4 containers too.
  steppe.containers.forEach((c, idx) => {
    if (c.tier >= 3 && idx % 9 === 0) (out[String(idx)] ??= []).push(settled({ uid: `C${seed}-${idx}`, def: "rifle", rarity: 1 }));
  });
  return out;
}

test("ledger over live Steppe raids with bosses and carriers: every pool uid resolves once; NPC items never break; an unlooted carrier item returns to the pool", () => {
  for (const seed of [11, 12]) {
    const mapSeed = 0x5eed0 + seed;
    const loot = poolFor(seed);
    // One pool unique per spawned T3/T4 marauder (the web's carrier allocation, raidNpcCarriers).
    const spawned = rollBossSpawns(mapSeed, steppe.bosses);
    const posts = npcPostsOf(steppe);
    const carriers = raidNpcCarriers(rollNpcSpawns(mapSeed, posts, bossGroupNpcCount(spawned)), posts);
    carriers.forEach((c, k) => { loot[c.key] = [settled({ uid: `N${seed}-${k}`, def: k % 2 ? "armor_2" : "rifle", rarity: 2 })]; });
    const m = new Match({ roster: humans(1), rng: mulberry32(seed), mapSeed, mapId: "steppe", mode: "live", containerLoot: loot, newUid: counterUid, strictLedger: true, now: () => 1_700_000_000_000 });
    const human = m.allRuntimes()[0]!;
    human.pub.hp = 1e6;
    assert.ok(m.bosses.groups.length > 0, `seed ${seed}: bosses spawned`);
    assert.ok(carriers.length > 0, `seed ${seed}: carriers spawned`);
    // Two minutes in, the human kills the first boss and the first carrier (never looted).
    const first = m.bosses.groups[0]!;
    const carrier = m.npcs.runtimes().find((r) => [...r.self.slots.values()].some((it) => it.uid.startsWith(`N${seed}-`)))!;
    assert.ok(carrier, "a marauder carries its pool unique");
    const carried = [...carrier.self.slots.values()].find((it) => it.uid.startsWith(`N${seed}-`))!.uid;
    assert.ok(![carrier.self.slots.get("w1")?.uid, carrier.self.slots.get("armor")?.uid].includes(carried), "stowed, never wielded or worn");
    while (!m.ended && m.clock < 12 * 60_000) {
      if (m.clock === 120_000) {
        damagePlayer(m, first.boss, 100_000, human, "rifle", first.boss.pub.x, first.boss.pub.y);
        m.rng = () => 0; // every break roll would succeed for a human
        damagePlayer(m, carrier, 100_000, human, "rifle", carrier.pub.x, carrier.pub.y);
        m.rng = mulberry32(seed + 1);
        assert.ok(m.containers.corpseOf(carrier.rosterIndex)!.items.some((i) => i.uid === carried), "the carrier item reached the corpse");
      }
      m.step(SERVER_TICK_MS);
      m.drainEvents();
    }
    assert.equal(human.stats.bossKills, 1);
    assert.equal(human.stats.npcKills, 1);
    damagePlayer(m, human, 1e7, null, "", human.pub.x, human.pub.y);
    m.step(SERVER_TICK_MS);
    assert.ok(m.ended, `seed ${seed}: ended`);
    assert.deepEqual(m.ledgerGaps(), []);
    assert.deepEqual(m.ledger.anomalies, []);
    const r = m.report!;
    assert.equal(r.botLost, undefined);
    // Each known uid in exactly one bucket (human reports + end report).
    const where = new Map<string, string[]>();
    const put = (uid: string, at: string) => where.set(uid, [...(where.get(uid) ?? []), at]);
    for (const rep of m.exitReports.filter((x) => x.userId)) {
      for (const it of rep.extracted) if (it.uid) put(it.uid, "extract");
      for (const it of rep.lost) if (it.uid) put(it.uid, "lost");
      for (const it of rep.destroyed) if (it.uid) put(it.uid, "destroyed");
    }
    for (const it of r.leftOnMap) put(it.uid, "left");
    for (const [uid] of m.ledger.known) assert.equal((where.get(uid) ?? []).length, 1, `seed ${seed}: ${uid} in ${where.get(uid)}`);
    // Boss and carrier items: never broken or worn on an NPC; nobody took them, so all back to the pool.
    const npcUids = Object.entries(loot).filter(([k]) => k.startsWith("boss:") || k.startsWith("npc:")).flatMap(([, v]) => v.map((x) => x.uid));
    for (const uid of npcUids) if (m.ledger.known.has(uid)) assert.equal(m.ledger.resolved.get(uid), "left", `NPC item ${uid}`);
    assert.equal(m.ledger.resolved.get(carried), "left", "the unlooted carrier item returns to the pool");
    for (const rt of m.npcs.runtimes()) {
      if (rt.exitReport?.exit === "dead") assert.deepEqual(rt.exitReport.lost, [], `${rt.nickname}: no break roll on death`);
      else assert.equal(rt.exitReport?.exit, "timeout", `${rt.nickname} never extracts`);
      assert.equal(rt.stats.containersSearched + rt.stats.corpsesSearched, 0, `${rt.nickname} never loots`);
    }
    // No FREE item (NPC gear) in any report.
    for (const it of r.leftOnMap) assert.ok(it.uid);
  }
});

// ---------------------------------------------------------------- solo free kit vs a boss

/**
 * Scripted solo player: waits out the peace window 1700 px from the boss spot (outside every guard's
 * post: an intruder is fought even during the peace window), walks in along a
 * nav path and fights the nearest visible NPC with decent aim (free kit: pistol + 36 FREE rounds),
 * reloading when dry. Returns whether it killed the boss.
 */
function duel(kind: BossKind, seed: number, kit: "free" | "starter"): { bossKills: number; dmg: number } {
  let ms = seed * 1000;
  while (!rollBossSpawns(ms >>> 0, steppe.bosses).some((b) => b.kind === kind)) ms++;
  const loadouts: LoadoutSnapshot[] = kit === "starter" ? [{
    loadoutId: "lo", userId: "h", level: 3,
    entries: [
      { key: "w1", uid: "own-rifle", def: "rifle", qty: 1, rarity: 0, dur: 92 },
      { key: "armor", uid: "own-armor", def: "armor_1", qty: 1, rarity: 0, dur: 76 },
      { key: "bp", uid: "own-bp", def: "backpack_1", qty: 1, rarity: 0, dur: 96 },
      { key: "p0", uid: "", def: "ammo_light", qty: 60, rarity: 0, dur: 0 },
      { key: "p1", uid: "", def: "ammo_light", qty: 30, rarity: 0, dur: 0 },
      { key: "p2", uid: "", def: "bandage", qty: 3, rarity: 0, dur: 0 },
    ],
  }] : [];
  const m = new Match({ roster: humans(1).map((h) => ({ ...h, userId: "h" })), rng: mulberry32(seed), mapSeed: ms >>> 0, mapId: "steppe", mode: "live", loadouts, newUid: counterUid, strictLedger: true });
  const g = m.bosses.groups.find((x) => x.kind === kind)!;
  const h = m.allRuntimes()[0]!;
  const rng: Rng = mulberry32(seed ^ 0x77);
  const grid = navGridFor(m.map);
  for (let k = 0; k < 64; k++) {
    const a = rng() * Math.PI * 2;
    const p = { x: g.spot.x + Math.cos(a) * 1700, y: g.spot.y + Math.sin(a) * 1700 };
    if ((grid.findPath(p, g.spot)?.length ?? 0) > 1) {
      h.pub.x = h.prevX = p.x;
      h.pub.y = h.prevY = p.y;
      break;
    }
  }
  while (!m.ended && m.clock < NPC.PEACE_MS + 1000) {
    m.step(SERVER_TICK_MS);
    m.drainEvents();
  }
  let path: Pt[] = grid.findPath({ x: h.pub.x, y: h.pub.y }, g.spot) ?? [g.spot];
  let seq = 1, acc = 0, toggle = false, strafe = 1, strafeAt = 0;
  const deadline = m.clock + 120_000;
  while (!m.ended && m.clock < deadline && g.boss.pub.alive && h.pub.alive) {
    for (acc += SERVER_TICK_MS; acc >= 1000 / 30; acc -= 1000 / 30) {
      const p = h.pub;
      let target: PlayerRuntime | null = null;
      let bd = Infinity;
      for (const j of m.vision.row(h.rosterIndex)) {
        const o = m.rosterRuntime(j);
        const d = o?.pub.alive ? Math.hypot(o.pub.x - p.x, o.pub.y - p.y) : Infinity;
        if (d < bd) { bd = d; target = o!; }
      }
      const w = activeWeapon(h);
      const def = weaponDefOf(w);
      if (w && def && w.mag === 0 && h.self.reloadUntil === 0 && ammoCount(h, def.ammo) > 0) m.reload(h.id);
      let mx = 0, my = 0, aim = p.aim, fire = false;
      if (target) {
        const a = Math.atan2(target.pub.y - p.y, target.pub.x - p.x);
        aim = a + (rng() * 2 - 1) * 0.05 * (1 + bd / 600);
        toggle = def?.auto ? true : !toggle;
        fire = toggle;
        if (m.clock > strafeAt) { strafe = rng() < 0.5 ? -1 : 1; strafeAt = m.clock + 600 + rng() * 800; }
        mx = Math.cos(a + strafe * Math.PI / 2);
        my = Math.sin(a + strafe * Math.PI / 2);
      } else {
        while (path.length > 1 && Math.hypot(path[0]!.x - p.x, path[0]!.y - p.y) < 30) path.shift();
        const to = path[0] ?? g.spot;
        const d = Math.hypot(to.x - p.x, to.y - p.y) || 1;
        mx = (to.x - p.x) / d;
        my = (to.y - p.y) / d;
        aim = Math.atan2(my, mx);
        if (Math.hypot(g.spot.x - p.x, g.spot.y - p.y) < 60) path = grid.findPath({ x: p.x, y: p.y }, g.boss.pub) ?? [g.boss.pub];
      }
      m.enqueueInput(h.id, { seq: seq++, mx, my, aim, fire, roll: false });
    }
    m.step(SERVER_TICK_MS);
    m.drainEvents();
  }
  return { bossKills: h.stats.bossKills, dmg: h.stats.dmgDealt };
}

test("solo free kit vs a boss: a scripted duel almost never wins (design: ≤ 5 %), the starter kit does damage", () => {
  const n = 8;
  const res: string[] = [];
  let wins = 0;
  let dmg = 0;
  for (const kind of ["foreman", "commander", "warden"] as BossKind[]) {
    for (let s = 1; s <= n; s++) {
      const r = duel(kind, s, "free");
      wins += r.bossKills;
      dmg += r.dmg;
    }
    res.push(`${kind} ${wins}`);
  }
  const starter = Array.from({ length: 4 }, (_, s) => duel("foreman", 100 + s, "starter"));
  console.log(`free-kit duels: cumulative wins ${res.join(", ")} of ${n} each; avg dmg ${(dmg / (3 * n)).toFixed(0)}; starter vs Foreman dmg ${starter.map((r) => r.dmg.toFixed(0)).join(" ")} wins ${starter.reduce((a, r) => a + r.bossKills, 0)}`);
  assert.ok(wins <= 1, `free kit beat a boss ${wins}× in ${3 * n} duels`);
  assert.ok(dmg > 0, "the duels are real fights (damage dealt)");
  assert.ok(starter.some((r) => r.dmg > 100), "a starter kit hurts the Foreman's group");
});
