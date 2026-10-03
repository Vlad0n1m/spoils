/**
 * T15 (WORLD v6 step S3b, spec §3.6 / D14 / D15): NPCs over a 45-minute world map. A fully cleared
 * marauder squad respawns once at its post 15 min after its last member died, only with no human
 * within 3600 px and ≥ 10 min of the cycle left; bosses and guards never respawn; the respawned
 * squad has a FREE kit, no pool item, a deterministic bag with halved consumables. The event boss
 * returns to full HP after 3 min without a hit and with nobody inside its leash.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BOSS_AI,
  BOSS_EVENT,
  ITEM_FLAG,
  NPC,
  NPC_ROLE,
  WORLD,
  itemDef,
  npcClassOfPost,
  rollNpcLoot,
  type BossSpot,
  type MapData,
  type MapSide,
  type NpcPost,
  type Zone,
} from "@extract/shared";
import { carriedItems } from "./bag.js";
import { damagePlayer } from "./combat.js";
import { killPlayer } from "./death.js";
import { isTrackedUnique } from "./items.js";
import type { Match } from "./match.js";
import { respawnBag, respawnSeed, respawnSize, type NpcSquad } from "./npc.js";
import { advance, enter, jump, testMap, testMatch, testPost, worldMatch, type WallClock } from "./test-utils.js";
import type { PlayerRuntime } from "./types.js";

/** Open arena with the human spawns in the far south-east corner (≥ 3600 px from the post in the north-west). */
function arena(o: Partial<Pick<MapData, "bosses" | "zones">> = {}): MapData {
  const map = testMap();
  map.spawns = [{ x: 4400, y: 4400, side: 0 as MapSide }];
  if (o.bosses) map.bosses = o.bosses;
  if (o.zones) map.zones = o.zones;
  return map;
}

const POST: NpcPost = testPost(7, 900, 900, { size: [2, 3], tier: 3 });

/** A world map with one marauder post (squad of 3), brains off (the test drives the deaths). */
function squadWorld(lootSeed = 0xc0ffee): { m: Match; wall: WallClock; human: PlayerRuntime; squad: NpcSquad } {
  const { m, wall } = worldMatch({
    map: arena(), npcBrains: false, lootSeed,
    npcPosts: [POST], npcSpawns: [{ postId: POST.id, members: 3 }],
  });
  jump(m, wall, 60_000);
  const human = enter(m, "hunter");
  const squad = m.npcs.squads[0]!;
  assert.equal(squad.members.length, 3);
  return { m, wall, human, squad };
}

function clear(m: Match, sq: NpcSquad, by: PlayerRuntime): void {
  for (const rt of sq.members) killPlayer(m, rt, by, "rifle");
}

const marauderSquads = (m: Match) => m.npcs.squads.filter((s) => s.type === "marauder");
const living = (m: Match) => marauderSquads(m).filter((s) => s.members.some((r) => r.pub.alive));

/** Non-FREE stacks a runtime carries, summed by def. */
function bagOf(rt: PlayerRuntime): Record<string, number> {
  const out: Record<string, number> = {};
  for (const { item } of carriedItems(rt)) if (!(item.flags & ITEM_FLAG.FREE)) out[item.def] = (out[item.def] ?? 0) + item.qty;
  return out;
}

const sumBag = (items: ReadonlyArray<{ def: string; qty: number }>) => {
  const out: Record<string, number> = {};
  for (const it of items) out[it.def] = (out[it.def] ?? 0) + it.qty;
  return out;
};

test("T15 respawn: a cleared squad comes back once, 15 min after its last member died, at its post", () => {
  const { m, wall, human, squad } = squadWorld();
  const before = m.allRuntimes().length;
  human.pub.x = 4400;
  human.pub.y = 4400;
  // The last member dies 30 s after the others: the 15 min count from the last death.
  killPlayer(m, squad.members[0]!, human, "rifle");
  killPlayer(m, squad.members[1]!, human, "rifle");
  jump(m, wall, 30_000);
  killPlayer(m, squad.members[2]!, human, "rifle");
  const wipedAt = m.clock;
  jump(m, wall, NPC.RESPAWN.AFTER_MS - 20_000);
  assert.equal(living(m).length, 0, "not before AFTER_MS");
  assert.equal(m.allRuntimes().length, before);
  jump(m, wall, 30_000);
  assert.ok(m.clock - wipedAt >= NPC.RESPAWN.AFTER_MS);
  const fresh = living(m);
  assert.equal(fresh.length, 1, "respawned");
  const sq = fresh[0]!;
  assert.notEqual(sq, squad);
  assert.equal(sq.post, squad.post);
  assert.equal(sq.gen, 1);
  assert.equal(squad.retired, true);
  const size = respawnSize(respawnSeed(m.lootSeed, 1), POST);
  assert.ok(size >= POST.size[0] && size <= POST.size[1]);
  assert.equal(sq.members.length, size, "size re-rolled from the respawn seed");
  assert.equal(m.allRuntimes().length, before + size, "new runtime indexes, never reused");
  for (const rt of sq.members) {
    assert.equal(rt.isNpc, true);
    assert.equal(rt.pub.alive, true);
    assert.equal(rt.pub.role, NPC_ROLE.MARAUDER);
    assert.equal(rt.pub.hp, rt.pub.maxHp);
    assert.ok(Math.hypot(rt.pub.x - POST.x, rt.pub.y - POST.y) < 200, "at its post");
    assert.equal(m.npcs.info(rt)?.squad, sq);
    assert.equal(m.npcs.info(rt)?.cls, npcClassOfPost(POST));
    assert.equal(m.runtime(rt.id), rt);
    assert.ok(m.state.players.get(rt.id), "a public Player");
  }
  assert.equal(m.npcs.summary().spawned.marauder, 3 + size);

  // Cleared again: never a second time (MAX_PER_POST = 1), even with 15+ min and ≥ 10 min left.
  assert.equal(NPC.RESPAWN.MAX_PER_POST, 1);
  clear(m, sq, human);
  jump(m, wall, NPC.RESPAWN.AFTER_MS + 30_000);
  assert.ok(WORLD.CYCLE_MS - m.clock >= NPC.RESPAWN.MIN_CYCLE_LEFT_MS);
  assert.equal(living(m).length, 0, "once per post per cycle");
  assert.equal(marauderSquads(m).length, 2);
});

test("T15 respawn: never while a living human is within 3600 px of the post; it comes as soon as they leave", () => {
  const { m, wall, human, squad } = squadWorld();
  clear(m, squad, human);
  human.pub.x = POST.x + NPC.RESPAWN.MIN_HUMAN_DIST_PX - 50;
  human.pub.y = POST.y;
  jump(m, wall, NPC.RESPAWN.AFTER_MS + 60_000);
  jump(m, wall, 15_000);
  assert.equal(living(m).length, 0, "a human nearby blocks it");
  // A dead human does not count.
  const other = enter(m, "watcher");
  other.pub.x = POST.x + 100;
  other.pub.y = POST.y;
  killPlayer(m, other, null, "");
  human.pub.x = 4600;
  human.pub.y = 4600;
  assert.ok(Math.hypot(human.pub.x - POST.x, human.pub.y - POST.y) > NPC.RESPAWN.MIN_HUMAN_DIST_PX);
  jump(m, wall, 11_000);
  assert.equal(living(m).length, 1, "respawned at the next check");
});

test("T15 respawn: not when fewer than 10 min of the cycle would remain; never on a legacy match", () => {
  const { m, wall, human, squad } = squadWorld();
  human.pub.x = 4600;
  human.pub.y = 4600;
  // Last death at 21:00 → due at 36:00, when only 9 min remain.
  jump(m, wall, 20 * 60_000 - m.clock + 60_000);
  clear(m, squad, human);
  jump(m, wall, NPC.RESPAWN.AFTER_MS);
  assert.ok(WORLD.CYCLE_MS - m.clock < NPC.RESPAWN.MIN_CYCLE_LEFT_MS);
  advance(m, wall, 25_000);
  jump(m, wall, 4 * 60_000);
  assert.equal(living(m).length, 0);

  // Exactly at the edge (due with 10:00 left) it still comes.
  const b = squadWorld();
  b.human.pub.x = 4600;
  b.human.pub.y = 4600;
  jump(b.m, b.wall, WORLD.CYCLE_MS - NPC.RESPAWN.MIN_CYCLE_LEFT_MS - NPC.RESPAWN.AFTER_MS - b.m.clock - 5_000);
  clear(b.m, b.squad, b.human);
  jump(b.m, b.wall, NPC.RESPAWN.AFTER_MS);
  assert.ok(WORLD.CYCLE_MS - b.m.clock >= NPC.RESPAWN.MIN_CYCLE_LEFT_MS);
  assert.equal(living(b.m).length, 1);

  // Legacy roster match: no respawn at all.
  const legacy = testMatch(1, { npcPosts: [POST], npcSpawns: [{ postId: POST.id, members: 2 }], npcBrains: false, npcOnlyUntilMs: Infinity });
  const lsq = legacy.npcs.squads[0]!;
  clear(legacy, lsq, legacy.allRuntimes()[0]!);
  legacy.state.clockMs = NPC.RESPAWN.AFTER_MS + 60_000;
  assert.deepEqual(legacy.npcs.respawnTick(), []);
});

test("T15 respawn: a respawned squad carries a FREE kit and no pool item; its bag is deterministic with consumables halved", () => {
  const run = (lootSeed: number) => {
    const { m, wall, human, squad } = squadWorld(lootSeed);
    human.pub.x = 4600;
    human.pub.y = 4600;
    clear(m, squad, human);
    jump(m, wall, NPC.RESPAWN.AFTER_MS + 11_000);
    const sq = living(m)[0]!;
    assert.ok(sq, "respawned");
    return { m, sq };
  };
  const a = run(0xc0ffee);
  const b = run(0xc0ffee);
  const cls = npcClassOfPost(POST);
  const seed = respawnSeed(a.m.lootSeed, 1);
  assert.equal(a.sq.members.length, b.sq.members.length);
  a.sq.members.forEach((rt, k) => {
    const s = rt.self.slots;
    for (const key of ["w1", "bp"] as const) assert.ok((s.get(key)!.flags & ITEM_FLAG.FREE) !== 0, `${key} is FREE`);
    if (s.get("armor")) assert.ok((s.get("armor")!.flags & ITEM_FLAG.FREE) !== 0, "armor is FREE");
    assert.equal(carriedItems(rt).filter(({ item }) => isTrackedUnique(item)).length, 0, "no pool unique at spawn");
    assert.deepEqual(bagOf(rt), sumBag(respawnBag(seed, POST.id, k, cls)), "bag from the respawn stream");
    assert.deepEqual(bagOf(rt), bagOf(b.sq.members[k]!), "same seed → same bag");
  });
  // The respawn stream is not the match-start stream (salted by the generation).
  assert.notEqual(seed, a.m.lootSeed);

  // respawnBag = rollNpcLoot on the same seed, consumables × CONSUMABLE_MULT (floored, 0 dropped), junk kept.
  let halved = 0, dropped = 0, junk = 0;
  for (let s = 1; s <= 400; s++) {
    for (const c of ["low", "mid", "high", "top"] as const) {
      const full = rollNpcLoot(s, 3, 0, c);
      const got = respawnBag(s, 3, 0, c);
      const exp: Array<{ def: string; qty: number }> = [];
      for (const it of full) {
        const cat = itemDef(it.def)!.cat;
        if (cat === "ammo" || cat === "med") {
          const q = Math.floor(it.qty * NPC.RESPAWN.CONSUMABLE_MULT);
          if (q > 0) {
            exp.push({ def: it.def, qty: q });
            halved++;
          } else dropped++;
        } else {
          exp.push({ def: it.def, qty: it.qty });
          junk++;
        }
      }
      assert.deepEqual(got.map((i) => ({ def: i.def, qty: i.qty })), exp);
    }
  }
  assert.ok(halved > 0 && dropped > 0 && junk > 0, "every case met");
  assert.equal(NPC.RESPAWN.CONSUMABLE_MULT, 0.5);
});

test("T15 respawn: the runtime capacity and NPC.MAX_PER_RAID hold a respawn back", () => {
  // Runtime capacity (indexes are never reused): dead fillers up to the last index.
  const a = squadWorld();
  a.human.pub.x = 4600;
  a.human.pub.y = 4600;
  clear(a.m, a.squad, a.human);
  while (a.m.allRuntimes().length < a.m.runtimeCapacity) a.m.addNpc({ nickname: "filler", x: 4700, y: 100 }).pub.alive = false;
  assert.equal(a.m.runtimeCapacity, WORLD.MAX_RUNTIMES_PER_SHARD);
  assert.throws(() => a.m.addNpc({ nickname: "one too many", x: 4700, y: 100 }), /capacity/);
  jump(a.m, a.wall, NPC.RESPAWN.AFTER_MS + 11_000);
  assert.equal(living(a.m).length, 0, "no room for the runtimes");

  // NPC.MAX_PER_RAID: the living NPCs plus the respawn may not exceed it.
  const b = squadWorld();
  b.human.pub.x = 4600;
  b.human.pub.y = 4600;
  clear(b.m, b.squad, b.human);
  for (let i = 0; i < NPC.MAX_PER_RAID - 1; i++) b.m.addNpc({ nickname: "filler", x: 4700, y: 100 });
  jump(b.m, b.wall, NPC.RESPAWN.AFTER_MS + 11_000);
  assert.equal(living(b.m).length, 0, "over the NPC cap");
  let n = 0;
  for (const rt of b.m.allRuntimes()) if (rt.isNpc && rt.pub.alive && rt.pub.nickname === "filler" && n++ < NPC.MAX_PER_RAID) rt.pub.alive = false;
  jump(b.m, b.wall, 11_000);
  assert.equal(living(b.m).length, 1, "room again: it comes");
});

test("T15 respawn: with brains on, the respawned marauders get brains and wake for a human who comes close", () => {
  const { m, wall } = worldMatch({ map: arena(), npcPosts: [POST], npcSpawns: [{ postId: POST.id, members: 2 }] });
  jump(m, wall, 60_000);
  const human = enter(m, "hunter");
  human.pub.x = 4600;
  human.pub.y = 4600;
  clear(m, m.npcs.squads[0]!, human);
  jump(m, wall, NPC.RESPAWN.AFTER_MS + 11_000);
  const sq = living(m)[0]!;
  assert.ok(sq, "respawned");
  const brains = sq.members.map((rt) => m.npcs.brain(rt));
  assert.ok(brains.every((b) => b !== undefined), "every respawned member has a brain");
  human.pub.x = POST.x + 900;
  human.pub.y = POST.y;
  const s0 = brains.map((b) => b!.samples);
  advance(m, wall, 2_000);
  assert.ok(brains.every((b, i) => b!.samples > s0[i]!), "awake: they send inputs like any NPC");
});

// ---------------------------------------------------------------- bosses and guards (D14 / D15)

function bossWorld(): { m: Match; wall: WallClock; human: PlayerRuntime; boss: PlayerRuntime; guards: PlayerRuntime[]; spot: BossSpot } {
  const zone: Zone = { id: "z", name: "Grain Elevator", kind: "elevator" as Zone["kind"], tier: 3, rect: { x: 1800, y: 1800, w: 1400, h: 1400 } };
  const spot: BossSpot = { kind: "foreman", zone: "z", x: 2400, y: 2400, guards: [{ x: 2700, y: 2400 }, { x: 2400, y: 2700 }], chance: 1 };
  const { m, wall } = worldMatch({ map: arena({ bosses: [spot], zones: [zone] }), bossEvent: "foreman", bosses: true, npcBrains: false });
  jump(m, wall, 60_000);
  const human = enter(m, "hunter");
  const boss = m.eventBoss()!;
  const guards = m.npcs.groups[0]!.guards;
  assert.ok(guards.length > 0);
  return { m, wall, human, boss, guards, spot };
}

test("T15 bosses and guards never respawn", () => {
  const { m, wall, human, boss, guards } = bossWorld();
  human.pub.x = 4600;
  human.pub.y = 4600;
  const before = m.allRuntimes().length;
  for (const g of guards) killPlayer(m, g, human, "rifle");
  killPlayer(m, boss, human, "rifle");
  jump(m, wall, NPC.RESPAWN.AFTER_MS + 60_000);
  jump(m, wall, 11_000);
  assert.equal(m.allRuntimes().length, before, "no new runtime");
  assert.equal(m.bossAlive(), false);
  assert.equal(m.state.bossState, 2);
  assert.ok(m.npcs.runtimes().filter((rt) => rt.pub.role !== NPC_ROLE.MARAUDER).every((rt) => !rt.pub.alive));
});

test("T15 boss reset: full HP 3 min after the last hit with nobody inside its leash; guards keep their damage", () => {
  const { m, wall, human, boss, guards, spot } = bossWorld();
  const max = boss.pub.maxHp;
  human.pub.x = spot.x + 300;
  human.pub.y = spot.y;
  damagePlayer(m, boss, 80, human, "rifle", spot.x, spot.y);
  damagePlayer(m, guards[0]!, 30, human, "rifle", spot.x, spot.y);
  const hurt = boss.pub.hp;
  const guardHp = guards[0]!.pub.hp;
  assert.ok(hurt < max);
  assert.equal(boss.lastHitAt, m.clock);
  const hitAt = m.clock;

  // A human inside the leash keeps the damage, however long it has been.
  jump(m, wall, BOSS_EVENT.RESET_AFTER_MS + 30_000);
  assert.equal(boss.pub.hp, hurt, "a human inside the leash");

  // Out of the leash: still nothing before RESET_AFTER_MS since the last hit.
  damagePlayer(m, boss, 40, human, "rifle", spot.x, spot.y);
  const hurt2 = boss.pub.hp;
  human.pub.x = spot.x + BOSS_AI.LEASH_BOSS_PX + 400;
  jump(m, wall, BOSS_EVENT.RESET_AFTER_MS - 5_000);
  assert.equal(boss.pub.hp, hurt2, "hit too recently");
  jump(m, wall, 6_000);
  assert.ok(m.clock - boss.lastHitAt >= BOSS_EVENT.RESET_AFTER_MS);
  assert.ok(m.clock - hitAt >= BOSS_EVENT.RESET_AFTER_MS);
  assert.equal(boss.pub.hp, max, "full HP again");
  assert.equal(guards[0]!.pub.hp, guardHp, "guards never heal back");

  // A dead boss stays dead.
  killPlayer(m, boss, human, "rifle");
  jump(m, wall, BOSS_EVENT.RESET_AFTER_MS + 1_000);
  assert.equal(boss.pub.alive, false);
  assert.equal(boss.pub.hp, 0);
});

test("T15 boss reset: never on a legacy match (no event boss)", () => {
  const zone: Zone = { id: "z", name: "Z", kind: "elevator" as Zone["kind"], tier: 3, rect: { x: 1800, y: 1800, w: 1400, h: 1400 } };
  const map = testMap();
  map.zones = [zone];
  map.bosses = [{ kind: "foreman", zone: "z", x: 2400, y: 2400, guards: [], chance: 1 }];
  const m = testMatch(1, { map, bosses: true, npcBrains: false, mapSeed: 4242 });
  const boss = m.npcs.groups[0]?.boss;
  assert.ok(boss, "the legacy roll spawned it");
  const human = m.allRuntimes()[0]!;
  human.pub.x = 4600;
  human.pub.y = 4600;
  damagePlayer(m, boss, 100, human, "rifle", 2400, 2400);
  const hurt = boss.pub.hp;
  m.state.clockMs += BOSS_EVENT.RESET_AFTER_MS + 10_000;
  m.step(50);
  assert.equal(boss.pub.hp, hurt);
});
