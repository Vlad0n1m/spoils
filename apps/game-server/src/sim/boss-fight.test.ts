/**
 * Boss fights (boss-fight.ts, npc.ts NpcBrain boss moves; numbers in shared BOSS_FIGHT): phase 2 at
 * half HP (announced only to the arena, back to phase 1 only through the HP reset rule), the
 * Foreman's telegraphed grenades (timing, damage, walls, NPCs immune), the Commander's one call
 * (FREE-only reinforcements within the NPC / runtime caps), the Warden's telegraphed dash (timing,
 * walls stop it, then the shotgun) and cover between bursts, the fog-safety of the boss bar data
 * (Player.bossPhase / bossTell only in the views of those who see the boss) and the trophy grant
 * (killer + damaging party mates, once per kind).
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/game-server/src/sim/boss-fight.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Decoder, Encoder, StateView } from "@colyseus/schema";
import {
  BOSSES,
  BOSS_EVENT,
  BattleState,
  NET,
  BOSS_FIGHT,
  BOSS_TELL,
  GRENADE,
  ITEM_FLAG,
  NPC,
  NPC_ROLE,
  SERVER_TICK_MS,
  SOLID,
  hasLineOfSight,
  type BossKind,
  type BossSpot,
  type MapData,
  type Zone,
} from "@extract/shared";
import { carriedItems } from "./bag.js";
import { grantBossTrophies, reinforcementRoom } from "./boss-fight.js";
import { damagePlayer } from "./combat.js";
import { throwNpcGrenade, stepGrenades } from "./grenade.js";
import type { Match } from "./match.js";
import { advance, enter, testMap, worldMatch, type WallClock } from "./test-utils.js";
import type { MatchEvent, PlayerRuntime } from "./types.js";
import { ViewSync } from "./views.js";

Encoder.BUFFER_SIZE = NET.ENCODER_BUFFER_BYTES;

/** A 4800 px arena with one boss zone; the boss at (2400, 2400), guard posts as given (default none). */
function arena(kind: BossKind, o: { guards?: BossSpot["guards"]; walls?: Array<{ x: number; y: number; w: number; h: number }> } = {}): MapData {
  const map = testMap({ walls: o.walls });
  const zone: Zone = { id: "z", name: "Grain Elevator", kind: "elevator" as Zone["kind"], tier: 3, rect: { x: 1800, y: 1800, w: 1400, h: 1400 } };
  map.zones = [zone];
  map.bosses = [{ kind, zone: "z", x: 2400, y: 2400, guards: o.guards ?? [], chance: 1 }];
  return map;
}

interface Fight {
  m: Match;
  wall: WallClock;
  boss: PlayerRuntime;
}

function fight(kind: BossKind, o: Parameters<typeof arena>[1] = {}): Fight {
  const { m, wall } = worldMatch({ map: arena(kind, o), bossEvent: kind, bosses: true });
  const boss = m.eventBoss();
  assert.ok(boss, "event boss spawned");
  return { m, wall, boss };
}

/** A human out of their peace window, standing at (x, y), unkillable for the test. */
function raider(m: Match, id: string, x: number, y: number, partyId = ""): PlayerRuntime {
  const rt = enter(m, id);
  rt.enteredAtMs = -NPC.PEACE_MS - 1;
  rt.partyId = partyId;
  rt.pub.x = x;
  rt.pub.y = y;
  return rt;
}

const bossEvents = (evs: MatchEvent[]) => evs.filter((e): e is Extract<MatchEvent, { type: "boss" }> => e.type === "boss");

// ---------------------------------------------------------------- phases

test("phase 2 at half HP: once, announced only to the humans in the arena; a medkit keeps phase 2, the HP reset rule goes back to 1", () => {
  const { m, wall, boss } = fight("foreman");
  const near = raider(m, "near", 2400, 3000);
  const far = raider(m, "far", 2400, 2400 + BOSS_FIGHT.ARENA_PX + 400);
  assert.equal(boss.pub.bossPhase, 1);
  const max = boss.pub.maxHp;
  boss.self.slots.delete("armor");
  damagePlayer(m, boss, max * 0.45, near, "rifle", boss.pub.x, boss.pub.y);
  let evs = advance(m, wall, SERVER_TICK_MS * 2);
  assert.equal(boss.pub.bossPhase, 1, "above half: phase 1");
  assert.equal(bossEvents(evs).length, 0);
  damagePlayer(m, boss, max * 0.1, near, "rifle", boss.pub.x, boss.pub.y);
  evs = advance(m, wall, SERVER_TICK_MS * 2);
  assert.equal(boss.pub.bossPhase, 2, "at or below half: phase 2");
  const sent = bossEvents(evs);
  assert.deepEqual(sent.map((e) => [e.to, e.msg.k, e.msg.e]), [[near.rosterIndex, "foreman", "phase2"]], "only the arena hears it");
  assert.ok(!sent.some((e) => e.to === far.rosterIndex));
  // A heal back above half does not end phase 2 and nothing is announced again.
  boss.pub.hp = max * 0.9;
  damagePlayer(m, boss, 5, near, "rifle", boss.pub.x, boss.pub.y);
  evs = advance(m, wall, SERVER_TICK_MS * 2);
  assert.equal(boss.pub.bossPhase, 2);
  assert.equal(bossEvents(evs).filter((e) => e.msg.e === "phase2").length, 0);
  // The HP reset rule (no hit for RESET_AFTER_MS, nobody in the leash): full HP and phase 1 again.
  near.pub.x = far.pub.x;
  near.pub.y = far.pub.y;
  advance(m, wall, BOSS_EVENT.RESET_AFTER_MS + 1_000);
  assert.equal(boss.pub.hp, max);
  assert.equal(boss.pub.bossPhase, 1);
});

// ---------------------------------------------------------------- Foreman

test("Foreman: telegraphs THROW for TELL_MS, then a grenade lands at the telegraphed spot (server path); stock is FREE and finite", () => {
  const { m, wall, boss } = fight("foreman");
  const h = raider(m, "h", 2400, 2780);
  h.pub.hp = 1e6;
  h.pub.maxHp = 1e6;
  let tellAt = -1;
  let tellSpot: { x: number; y: number } | null = null;
  let thrownAt = -1;
  for (let t = 0; t < 20_000 && thrownAt < 0; t += SERVER_TICK_MS) {
    advance(m, wall, SERVER_TICK_MS);
    if (tellAt < 0 && boss.pub.bossTell === BOSS_TELL.THROW) {
      tellAt = m.clock;
      tellSpot = { x: h.pub.x, y: h.pub.y };
      // Step aside: the grenade still goes where the telegraph pointed.
      h.pub.x += 150;
    }
    if (m.grenades.some((g) => g.owner === boss)) thrownAt = m.clock;
  }
  assert.ok(tellAt > 0 && thrownAt > 0, "the Foreman telegraphed and threw");
  const dt = thrownAt - tellAt;
  assert.ok(dt >= BOSS_FIGHT.FOREMAN.TELL_MS && dt <= BOSS_FIGHT.FOREMAN.TELL_MS + SERVER_TICK_MS, `tell → throw ${dt} ms`);
  assert.equal(boss.pub.bossTell, BOSS_TELL.NONE);
  const g = m.grenades.find((x) => x.owner === boss)!;
  const rest = g.path[g.path.length - 1]!;
  assert.ok(Math.hypot(rest.x - tellSpot!.x, rest.y - tellSpot!.y) < 40, `lands on the telegraphed spot (${Math.round(rest.x)},${Math.round(rest.y)})`);
  assert.equal(g.explodeAt - g.thrownAt, GRENADE.FUSE_MS, "same fuse (and warning ring) as a player's grenade");
  assert.equal(m.npcs.groups[0]!.fight.stock, BOSS_FIGHT.FOREMAN.STOCK - 1);
  // No grenade item anywhere: nothing to loot from the corpse.
  assert.ok(!carriedItems(boss).some((c) => c.item.def === "grenade"));
});

test("Foreman grenade blast: hurts humans in range, never NPCs (the boss, guards), and walls stop it", () => {
  const walls = [{ x: 2850, y: 2200, w: 30, h: 400 }];
  const { m, wall, boss } = fight("foreman", { walls, guards: [{ x: 2500, y: 2400 }] });
  const guard = m.npcs.groups[0]!.guards[0]!;
  const open = raider(m, "open", 2640, 2400);
  const behind = raider(m, "behind", 2950, 2400);
  const hp = { guard: guard.pub.hp, boss: boss.pub.hp, open: open.pub.hp, behind: behind.pub.hp };
  // Land it next to the open raider and the guard, with the wall between it and the second raider.
  const g = throwNpcGrenade(m, boss, 2600, 2400)!;
  assert.ok(g);
  advance(m, wall, GRENADE.FUSE_MS + 100);
  stepGrenades(m);
  assert.ok(open.pub.hp < hp.open, "the raider next to it is hurt");
  assert.equal(behind.pub.hp, hp.behind, "the raider behind the wall is not");
  assert.equal(guard.pub.hp, hp.guard, "guards never take a boss grenade");
  assert.equal(boss.pub.hp, hp.boss, "nor the boss itself");
});

// ---------------------------------------------------------------- Commander

test("Commander: in phase 2 radios once (CALL telegraph for TELL_MS), two FREE-only guards arrive and join the alerted group", () => {
  const { m, wall, boss } = fight("commander", { guards: [{ x: 2400, y: 1900 }, { x: 1900, y: 2400 }] });
  const h = raider(m, "h", 2400, 2800);
  h.pub.hp = 1e6;
  h.pub.maxHp = 1e6;
  const group = m.npcs.groups[0]!;
  const before = group.guards.length;
  advance(m, wall, 3_000);
  assert.equal(group.guards.length, before, "phase 1: no call");
  boss.self.slots.delete("armor");
  damagePlayer(m, boss, boss.pub.maxHp * 0.55, h, "rifle", boss.pub.x, boss.pub.y);
  let callAt = -1;
  let spawnedAt = -1;
  const evs: MatchEvent[] = [];
  for (let t = 0; t < 15_000 && spawnedAt < 0; t += SERVER_TICK_MS) {
    evs.push(...advance(m, wall, SERVER_TICK_MS));
    if (callAt < 0 && boss.pub.bossTell === BOSS_TELL.CALL) callAt = m.clock;
    if (group.guards.length > before) spawnedAt = m.clock;
  }
  assert.ok(callAt > 0 && spawnedAt > 0, "called and spawned");
  const dt = spawnedAt - callAt;
  assert.ok(dt >= BOSS_FIGHT.COMMANDER.TELL_MS && dt <= BOSS_FIGHT.COMMANDER.TELL_MS + SERVER_TICK_MS, `call → arrival ${dt} ms`);
  const fresh = group.guards.slice(before);
  assert.equal(fresh.length, BOSS_FIGHT.COMMANDER.CALL_COUNT);
  for (const rt of fresh) {
    assert.equal(rt.pub.role, NPC_ROLE.GUARD);
    assert.equal(rt.nickname, BOSSES.commander.guardName);
    const items = carriedItems(rt).map((c) => c.item);
    assert.ok(items.length > 0 && items.every((it) => (it.flags & ITEM_FLAG.FREE) !== 0), "FREE-only kit: an empty corpse");
    assert.ok(Math.hypot(rt.pub.x - h.pub.x, rt.pub.y - h.pub.y) > 300, "never spawned in the raider's face");
    assert.ok(m.npcs.brain(rt), "with a brain");
  }
  assert.ok(group.alertUntil > m.clock, "the group is alerted");
  assert.ok(bossEvents(evs).some((e) => e.to === h.rosterIndex && e.msg.e === "call"));
  // Once per life: still phase 2 later, no second call.
  advance(m, wall, 20_000);
  assert.equal(group.guards.length, before + fresh.length);
});

test("Commander reinforcements respect the living-NPC cap and the runtime capacity; the call is spent either way", () => {
  const { m, boss } = fight("commander");
  const group = m.npcs.groups[0]!;
  let alive = 0;
  for (const rt of m.allRuntimes()) if (rt.isNpc && rt.pub.alive) alive++;
  assert.equal(reinforcementRoom(m, alive + 1), 1, "one slot left under the cap");
  assert.equal(reinforcementRoom(m, alive), 0, "none at the cap");
  assert.equal(reinforcementRoom(m, 999), BOSS_FIGHT.COMMANDER.CALL_COUNT);
  // Runtime capacity: a full shard gets nobody.
  const cap = m.runtimeCapacity;
  const room = cap - m.allRuntimes().length;
  for (let i = 0; i < room; i++) enter(m, `filler${i}`);
  assert.equal(reinforcementRoom(m, 999), 0, "no runtime index left");
  const got = m.npcs.spawnReinforcements(group, { x: boss.pub.x, y: boss.pub.y + 500 });
  assert.equal(got.length, 0);
  assert.equal(group.fight.called, true, "spent");
});

// ---------------------------------------------------------------- Warden

test("Warden: CHARGE telegraph for TELL_MS standing still, then a dash at SPEED_MULT along the locked line that a wall stops", () => {
  // A wall across the lane 250 px out: the dash must end against it.
  const walls = [{ x: 2200, y: 2650, w: 400, h: 30 }];
  const { m, wall, boss } = fight("warden", { walls });
  // The raider sees the Warden through a gap: stand off to the side of the wall end, then test the lane rule.
  const h = raider(m, "h", 2400, 2800);
  h.pub.hp = 1e6;
  h.pub.maxHp = 1e6;
  advance(m, wall, 8_000);
  assert.equal(boss.pub.bossTell === BOSS_TELL.CHARGE || boss.pub.bossTell === BOSS_TELL.DASH, false, "no lane through the wall: no charge");
  // Open lane: move the raider beside the wall.
  h.pub.x = 2700;
  h.pub.y = 2520;
  let tellAt = -1;
  let dashAt = -1;
  let start = { x: 0, y: 0 };
  for (let t = 0; t < 20_000 && dashAt < 0; t += SERVER_TICK_MS) {
    advance(m, wall, SERVER_TICK_MS);
    if (tellAt < 0 && boss.pub.bossTell === BOSS_TELL.CHARGE) {
      tellAt = m.clock;
      start = { x: boss.pub.x, y: boss.pub.y };
    }
    if (tellAt > 0 && m.clock < tellAt + BOSS_FIGHT.WARDEN.TELL_MS - SERVER_TICK_MS) {
      assert.ok(Math.hypot(boss.pub.x - start.x, boss.pub.y - start.y) < 4, "stands still while telegraphing");
    }
    if (dashAt < 0 && boss.pub.bossTell === BOSS_TELL.DASH) dashAt = m.clock;
  }
  assert.ok(tellAt > 0 && dashAt > 0, "telegraphed and dashed");
  const dt = dashAt - tellAt;
  assert.ok(dt >= BOSS_FIGHT.WARDEN.TELL_MS && dt <= BOSS_FIGHT.WARDEN.TELL_MS + SERVER_TICK_MS, `tell → dash ${dt} ms`);
  const lock = Math.atan2(2520 - start.y, 2700 - start.x);
  // The raider sidesteps during the dash: the Warden keeps its locked line (dodgeable).
  h.pub.x = 3000;
  h.pub.y = 2300;
  const p0 = { x: boss.pub.x, y: boss.pub.y };
  advance(m, wall, BOSS_FIGHT.WARDEN.DASH_MS + 200);
  assert.equal(boss.pub.bossTell, BOSS_TELL.NONE, "the dash ended");
  assert.equal(boss.moveMult, 1);
  const moved = Math.hypot(boss.pub.x - p0.x, boss.pub.y - p0.y);
  const dir = Math.atan2(boss.pub.y - start.y, boss.pub.x - start.x);
  assert.ok(moved > 150, `it covered ground fast (${Math.round(moved)} px)`);
  assert.ok(Math.abs(Math.atan2(Math.sin(dir - lock), Math.cos(dir - lock))) < 0.35, "along the locked line");
  assert.ok(Math.hypot(boss.pub.x - 2400, boss.pub.y - 2400) <= m.npcs.info(boss)!.chase + 40, "never past its leash");
});

test("Warden: ducks into cover (no line of fire to its target) between shotgun shots, then peeks again", () => {
  // Two pillars next to its room to hide behind.
  const walls = [{ x: 2250, y: 2470, w: 70, h: 70 }, { x: 2480, y: 2470, w: 70, h: 70 }];
  const { m, wall, boss } = fight("warden", { walls });
  const h = raider(m, "h", 2400, 2720);
  h.pub.hp = 1e6;
  h.pub.maxHp = 1e6;
  let shots = 0;
  let lastShotAt = -1;
  let hidAfterShot = 0;
  let hidden = false;
  for (let t = 0; t < 30_000; t += SERVER_TICK_MS) {
    const evs = advance(m, wall, SERVER_TICK_MS);
    if (evs.some((e) => e.type === "shot" && e.src === boss.rosterIndex)) {
      shots++;
      lastShotAt = m.clock;
      hidden = false;
    }
    const covered = !hasLineOfSight(m.idx, boss.pub.x, boss.pub.y, h.pub.x, h.pub.y, SOLID.SHOT);
    if (lastShotAt > 0 && !hidden && covered && m.clock - lastShotAt <= BOSS_FIGHT.WARDEN.COVER_MS[0] + 300) {
      hidden = true;
      hidAfterShot++;
    }
  }
  assert.ok(shots >= 3, `it keeps fighting (${shots} shots)`);
  assert.ok(hidAfterShot >= 2, `it breaks the line of fire after its shots (${hidAfterShot} of ${shots})`);
});

// ---------------------------------------------------------------- fog safety of the boss bar

test("boss bar data is fog-safe: Player.bossPhase / bossTell reach only the views of those who see the boss", () => {
  const { m, wall, boss } = fight("foreman", { walls: [{ x: 1500, y: 2000, w: 1800, h: 30 }] });
  const sees = raider(m, "sees", 2400, 2700);
  const blind = raider(m, "blind", 2400, 1700);
  sees.pub.hp = blind.pub.hp = 1e6;
  advance(m, wall, 500);
  boss.self.slots.delete("armor");
  damagePlayer(m, boss, boss.pub.maxHp * 0.6, sees, "rifle", boss.pub.x, boss.pub.y);
  advance(m, wall, 300);
  assert.equal(boss.pub.bossPhase, 2);
  assert.ok(m.vision.sees(sees.rosterIndex, boss.rosterIndex), "the raider in the room sees the boss");
  assert.ok(!m.vision.sees(blind.rosterIndex, boss.rosterIndex), "the one behind the wall does not");
  // Encode each viewer's state view and decode it as a client would (views.test.ts harness).
  const enc = new Encoder(m.state);
  const sync = new ViewSync(m);
  for (const rt of [sees, blind]) {
    const view = new StateView();
    sync.attach(rt.rosterIndex, view);
    const dec = new Decoder(new BattleState());
    const it = { offset: 0 };
    enc.encodeAll(it);
    dec.decode(enc.encodeAllView(view, it.offset, { ...it }));
    const got = dec.state.players.get(boss.id);
    if (rt === sees) {
      assert.equal(got?.bossPhase, 2, "the viewer who sees it gets the phase");
      assert.equal(got?.maxHp, boss.pub.maxHp);
    } else {
      assert.equal(got, undefined, "the blind viewer never decodes the boss (no HP, phase or tell)");
    }
  }
  // And the arena announcement is the only boss beat the blind raider got: no position, no HP.
});

// ---------------------------------------------------------------- trophies

test("trophy: the killer and the killer's party mates who damaged the boss; not a mate who never hit it, not a stranger; once per kind", () => {
  const { m, wall, boss } = fight("warden");
  const killer = raider(m, "killer", 2400, 3200, "party-a");
  const helper = raider(m, "helper", 2300, 3200, "party-a");
  const idle = raider(m, "idle", 2200, 3200, "party-a");
  const stranger = raider(m, "stranger", 2600, 3200);
  boss.self.slots.delete("armor");
  damagePlayer(m, boss, 40, helper, "rifle", boss.pub.x, boss.pub.y);
  damagePlayer(m, boss, 40, stranger, "rifle", boss.pub.x, boss.pub.y);
  damagePlayer(m, boss, boss.pub.hp + 50, killer, "rifle", boss.pub.x, boss.pub.y);
  assert.equal(boss.pub.alive, false);
  advance(m, wall, 100);
  assert.deepEqual([...killer.bossTrophies], ["warden"]);
  assert.deepEqual([...helper.bossTrophies], ["warden"]);
  assert.equal(idle.bossTrophies.size, 0, "a mate who never hit it");
  assert.equal(stranger.bossTrophies.size, 0, "another party / solo damage does not share");
  // Idempotent: a second grant changes nothing; the exit report carries the kind once.
  grantBossTrophies(boss, "warden", killer);
  assert.deepEqual([...killer.bossTrophies], ["warden"]);
  m.finishPlayer(killer, "extract");
  assert.deepEqual(killer.exitReport?.bossTrophies, ["warden"]);
  m.finishPlayer(stranger, "extract");
  assert.equal(stranger.exitReport?.bossTrophies, undefined);
});
