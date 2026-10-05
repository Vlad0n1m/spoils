/**
 * WORLD v6 map events (world-events.ts): schedule determinism, supply-drop placement, the crate as
 * a lost-pool target (never minted), the damage-interrupted channel, hot-zone refill bounds and XP,
 * fog safety of the combat signals, the replay WEV record, and the late refill for late joiners.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONTAINER_STATE,
  DROP,
  EVENT_BUDGET,
  FIGHT,
  HOT,
  HOT_ZONE_LOOT,
  LATE_REFILL,
  LATE_REFILL_LOOT,
  POOL,
  SUPPLY_DROP_LOOT,
  SoundKind,
  WEV_KIND,
  WEV_STATE,
  WORLD,
  containerGuarded,
  decodeReplayChunk,
  encodeReplayChunk,
  eventJunkCr,
  fightCellCentre,
  fightCellOf,
  isSupplyDropKey,
  lateRefillPlan,
  mulberry32,
  planHotZones,
  planSupplyDrops,
  REPLAY,
  rollEventLoot,
  rollEventLootCapped,
  xpForExit,
  type ContainerSpot,
  type MapData,
  type Zone,
} from "@extract/shared";
import { buildBatches } from "./audience.js";
import { damagePlayer } from "./combat.js";
import { lootItems } from "./containers.js";
import type { Match } from "./match.js";
import { emitSound } from "./sound.js";
import { enter, jump, poolItem, testMap, worldMatch } from "./test-utils.js";
import type { PlayerRuntime } from "./types.js";
import { dropPointValid, fightSignalsFor, pickDropPoint } from "./world-events.js";

const ZONE: Zone = { id: "z1", name: "Test Yard", kind: "industrial", tier: 3, rect: { x: 2600, y: 400, w: 1800, h: 1800 } };

/** The arena with one POI in the north-east, a building inside it and an extract east of it. */
function eventMap(containers: ContainerSpot[] = []): MapData {
  const map = testMap({ containers });
  map.zones = [ZONE];
  map.buildings = [{ floor: { x: 3300, y: 1000, w: 400, h: 400 } } as MapData["buildings"][number]];
  map.extracts = [{ id: "E1", name: "East", x: 4500, y: 2600, r: 150, side: 1 } as MapData["extracts"][number]];
  return map;
}

function put(rt: PlayerRuntime, x: number, y: number): void {
  rt.pub.x = rt.prevX = x;
  rt.pub.y = rt.prevY = y;
}

function crateTarget(m: Match, n = 1) {
  return m.containers.targets.get(`ksd${n}`);
}

// ---------------------------------------------------------------- schedules

test("world events: drop and hot-zone schedules are deterministic in the loot seed and inside the rules", () => {
  for (let seed = 1; seed < 400; seed += 7) {
    const a = planSupplyDrops(seed);
    assert.deepEqual(a, planSupplyDrops(seed), "same seed, same drops");
    assert.ok(a.length >= DROP.COUNT_MIN && a.length <= DROP.COUNT_MAX);
    let prev = -Infinity;
    for (const d of a) {
      assert.ok(d.announceAt >= DROP.FIRST_ANNOUNCE_MS, `seed ${seed}: first announce at ≥ 8:00`);
      assert.equal(d.landAt - d.announceAt, DROP.WARN_MS);
      assert.ok(d.landAt <= WORLD.CYCLE_MS - DROP.NO_LAND_LAST_MS, `seed ${seed}: no landing in the last 6 min`);
      assert.ok(d.landAt - prev >= 60_000 * 3, "drops are minutes apart");
      prev = d.landAt;
    }
    const h = planHotZones(seed);
    assert.deepEqual(h, planHotZones(seed));
    assert.ok(h.length >= 2 && h.length <= 3, `seed ${seed}: one hot zone per ~15 min`);
    for (const z of h) {
      assert.equal(z.endAt - z.startAt, HOT.DURATION_MS);
      assert.ok(z.endAt <= WORLD.CYCLE_MS);
    }
  }
  assert.notDeepEqual(planSupplyDrops(1), planSupplyDrops(2), "the seed matters");
});

test("world events: a world match without zones (or emptyWorld) schedules nothing", () => {
  const { m } = worldMatch();
  assert.equal(m.worldEvents.drops.length, 0);
  assert.equal(m.worldEvents.hots.length, 0);
});

// ---------------------------------------------------------------- placement

test("world events: drop points are outdoors, clear, reachable and away from extracts", () => {
  const { m } = worldMatch({ map: eventMap() });
  for (let s = 1; s <= 60; s++) {
    const p = pickDropPoint(m, mulberry32(s), new Set());
    assert.ok(p, `seed ${s}: a point`);
    assert.equal(p.zone?.id, "z1");
    assert.ok(dropPointValid(m, p.x, p.y));
    const f = m.map.buildings[0]!.floor;
    assert.ok(!(p.x >= f.x && p.x <= f.x + f.w && p.y >= f.y && p.y <= f.y + f.h), "not inside a building");
    assert.ok(Math.hypot(p.x - 4500, p.y - 2600) >= DROP.EXTRACT_MIN_PX, "away from the extract");
    const r = ZONE.rect;
    assert.ok(p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h, "inside the POI");
  }
  assert.equal(pickDropPoint(m, mulberry32(1), new Set(["z1"])), null, "a taken zone is skipped");
  assert.equal(dropPointValid(m, 3500, 1200), false, "a building floor is never a landing point");
  assert.equal(dropPointValid(m, 3032, 3200), false, "inside the crate wall");
});

test("world events: the announced circle holds the landing point; landing makes a public crate", () => {
  const { m, wall } = worldMatch({ map: eventMap(), worldEvents: true, worldEventsOverride: { drops: [{ n: 1, announceAt: 60_000, landAt: 120_000 }], hots: [] } });
  jump(m, wall, 61_000);
  const ev = m.state.wev.get("d1")!;
  assert.equal(ev.kind, WEV_KIND.DROP);
  assert.equal(ev.state, WEV_STATE.ANNOUNCED);
  assert.equal(ev.r, DROP.ZONE_R);
  const d = m.worldEvents.drops[0]!;
  const off = Math.hypot(d.x - ev.x, d.y - ev.y);
  assert.ok(off > 0 && off <= DROP.ZONE_R * DROP.ZONE_OFFSET_MAX + 1, "the point is inside the circle, not its centre");
  assert.equal(crateTarget(m), undefined, "nothing on the map before the landing");
  const evs = jump(m, wall, 60_000);
  assert.equal(ev.state, WEV_STATE.ACTIVE);
  assert.deepEqual([ev.x, ev.y, ev.r], [d.x, d.y, 0], "exact point revealed at landing");
  assert.ok(m.state.corpses.get("sd1"), "the crate is a Corpse sd1");
  assert.ok(evs.some((e) => e.type === "sound" && e.kind === SoundKind.explosion && e.variant === DROP.SOUND_VARIANT), "a loud landing sound");
  assert.ok(evs.some((e) => e.type === "wev" && e.ev === "drop_land"), "recorded for replays");
  const t = crateTarget(m)!;
  for (const it of t.items) assert.ok(SUPPLY_DROP_LOOT.some((e) => e.def === it.def) && !it.uid, `${it.def}: CR-economy fungible`);
  jump(m, wall, DROP.FLARE_MS);
  assert.equal(ev.state, WEV_STATE.DONE, "the flare burns out on a fixed timer");
  assert.ok(m.state.corpses.get("sd1"), "the crate stays until the wipe");
});

// ---------------------------------------------------------------- pool rules

test("world events: an untouched crate is a pool target (one item), never minted; leftovers go back at the wipe", () => {
  const { m, wall } = worldMatch({
    map: eventMap(), mode: "demo", worldEvents: true,
    worldEventsOverride: { drops: [{ n: 1, announceAt: 60_000, landAt: 120_000 }], hots: [] },
  });
  const a = enter(m, "alice", { pool: [poolItem("pool-1"), poolItem("pool-2", "shotgun")] });
  put(a, 400, 4400);
  jump(m, wall, 121_000);
  const t = crateTarget(m)!;
  const before = t.items.length;
  assert.ok(t.items.every((it) => !it.uid), "demo mode mints nothing into a crate");
  jump(m, wall, POOL.APPLY_AFTER_MS);
  jump(m, wall, 1_000);
  const uniques = t.items.filter((it) => it.uid);
  assert.equal(uniques.length, DROP.POOL_MAX, "exactly one pool item (the crate is the only target)");
  assert.ok(["pool-1", "pool-2"].includes(uniques[0]!.uid));
  assert.equal(t.items.length, before + 1);
  assert.equal(m.unplacedPool.length, 1, "the second item waits for another target");
  // A crate somebody opened is no target any more.
  const b = enter(m, "bob");
  put(b, t.x + 40, t.y);
  assert.ok(m.openSearch(b.id, "ksd1"));
  assert.equal(m.worldEvents.dropPoolCandidates().length, 0);
  m.searchClose(b.id);
  put(b, 400, 4300);
  // Wipe: the unlooted pool item is left on the map (back to the pool), the ledger stays clean.
  jump(m, wall, WORLD.CYCLE_MS);
  assert.ok(m.report);
  assert.ok(m.report!.leftOnMap.some((s) => s.uid === uniques[0]!.uid), "unlooted crate unique → leftOnMap");
});

test("world events: damage interrupts the crate's open channel, not an open crate", () => {
  const { m, wall } = worldMatch({ map: eventMap(), worldEvents: true, worldEventsOverride: { drops: [{ n: 1, announceAt: 0, landAt: 1_000 }], hots: [] } });
  const a = enter(m, "alice");
  jump(m, wall, 2_000);
  const t = crateTarget(m)!;
  put(a, t.x + 50, t.y);
  assert.ok(m.openSearch(a.id, "ksd1"));
  assert.ok(isSupplyDropKey(a.search!.key));
  assert.equal(a.search!.readyAt - m.clock, DROP.OPEN_MS, "a 6 s channel");
  damagePlayer(m, a, 5, null, "rifle", a.pub.x, a.pub.y);
  assert.equal(a.search, null, "hit while channelling → interrupted");
  assert.ok(m.openSearch(a.id, "ksd1"));
  jump(m, wall, DROP.OPEN_MS + 50);
  const open = a.search as { readyAt: number } | null;
  assert.ok(open && m.clock >= open.readyAt);
  damagePlayer(m, a, 5, null, "rifle", a.pub.x, a.pub.y);
  assert.ok(a.search, "an open crate stays open (like any container)");
});

// ---------------------------------------------------------------- hot zones

test("world events: a hot zone refills at most MAX_REFILL emptied containers (CR economy only) and pays × 1.5 container XP", () => {
  const spots: ContainerSpot[] = [];
  for (let i = 0; i < 15; i++) spots.push({ x: 2800 + (i % 5) * 300, y: 1700 + Math.floor(i / 5) * 160, kind: "safe", tier: 0, zone: "z1" });
  // A T3 safe: pool-eligible before the refill, never after it.
  spots.push({ x: 2800, y: 2150, kind: "safe", tier: 3, zone: "z1" });
  const { m, wall } = worldMatch({
    map: eventMap(spots), mode: "live", worldEvents: true,
    worldEventsOverride: { drops: [], hots: [{ n: 1, announceAt: 400_000, startAt: 460_000, endAt: 460_000 + HOT.DURATION_MS }] },
  });
  const a = enter(m, "alice");
  spots.forEach((c, i) => {
    put(a, c.x + 40, c.y);
    assert.ok(m.openSearch(a.id, `c${i}`), `open c${i}`);
    jump(m, wall, 3_000);
    jump(m, wall, 3_000);
    m.invTakeAll(a.id);
    jump(m, wall, 50);
    assert.equal(m.containers.stateOf(i), CONTAINER_STATE.EMPTIED, `c${i} emptied`);
  });
  put(a, 400, 4400);
  assert.ok(m.clock < 400_000);
  jump(m, wall, 400_000 - m.clock + 10);
  assert.equal(m.state.wev.get("h1")?.state, WEV_STATE.ANNOUNCED);
  assert.equal(m.state.wev.get("h1")?.zoneId, "z1");
  jump(m, wall, 60_000);
  const h = m.worldEvents.hots[0]!;
  assert.equal(h.state, WEV_STATE.ACTIVE);
  assert.equal(h.refilled.length, HOT.MAX_REFILL, "bounded refill");
  for (const i of h.refilled) {
    assert.equal(m.containers.stateOf(i), CONTAINER_STATE.UNTOUCHED);
    assert.equal(m.state.containerState[i], CONTAINER_STATE.UNTOUCHED, "public at once (the zone is public)");
    assert.equal(m.containers.poolTargetOk(i), false, "a refilled container is never a pool target");
  }
  assert.ok(m.worldEvents.rolled.junkCr <= EVENT_BUDGET.JUNK_CR);
  // Search one refilled container inside the active hot zone: hot XP.
  const i = h.refilled[0]!;
  const c = spots[i]!;
  const b = enter(m, "bob");
  put(b, c.x + 40, c.y);
  assert.ok(m.openSearch(b.id, `c${i}`));
  const evs = [...jump(m, wall, 3_000), ...jump(m, wall, 3_000)];
  const t = m.containers.targets.get(`c${i}`)!;
  for (const { item } of lootItems(t)) assert.ok(HOT_ZONE_LOOT.some((e) => e.def === item.def) && !item.uid, `${item.def} from the hot table`);
  assert.equal(b.stats.hotContainers, 1);
  const xp = evs.find((e) => e.type === "xp" && e.to === b.rosterIndex);
  assert.ok(xp && xp.type === "xp" && xp.msg.xp === 3, "2 XP × 1.5 = 3");
  jump(m, wall, HOT.DURATION_MS);
  assert.equal(h.state, WEV_STATE.DONE);
});

test("world events: hot-zone XP settles at exit (xpForExit) within the container cap", () => {
  const base = { exit: "extract" as const, onMapMs: 0, haulCr: 0, marauders: 0, guards: 0, bosses: 0, rankedPvp: 0, grindToday: 0, firstExtractToday: false };
  assert.equal(xpForExit({ ...base, containers: 10 }).total, 20);
  assert.equal(xpForExit({ ...base, containers: 10, hotContainers: 4 }).total, 24);
  assert.equal(xpForExit({ ...base, containers: 10, hotContainers: 50 }).total, 30, "never more hot than counted");
});

test("world events: event loot respects the junk budget", () => {
  const rng = mulberry32(7);
  const none = rollEventLoot(rng, SUPPLY_DROP_LOOT, 400, { left: 0 });
  assert.ok(none.length > 0 && none.every((f) => eventJunkCr(f.def, f.qty) === 0), "no budget → consumables only");
  const budget = { left: 500 };
  const some = rollEventLoot(mulberry32(9), HOT_ZONE_LOOT, 500, budget);
  const junk = some.reduce((s, f) => s + eventJunkCr(f.def, f.qty), 0);
  assert.ok(junk <= 500 && junk + budget.left === 500, `junk ${junk} within the budget`);
});

// ---------------------------------------------------------------- fight signals (fog)

test("world events: fight signals are cell-quantized — a hidden shooter moving inside a cell sends the same bytes", () => {
  const W = WORLD.WIDTH;
  const listener = { rosterIndex: 0, pub: { x: 10_000, y: 10_000 } } as Pick<PlayerRuntime, "rosterIndex" | "pub">;
  const cellA = fightCellOf(12_300, 10_800, W);
  const cellB = fightCellOf(12_300 + 150, 10_800 + 200, W);
  assert.equal(cellA, cellB, "both shots fall in one cell");
  const one = fightSignalsFor(listener, [{ c: fightCellCentre(cellA, W), srcs: new Set([5]) }]);
  const two = fightSignalsFor(listener, [{ c: fightCellCentre(cellB, W), srcs: new Set([5]) }]);
  assert.deepEqual(one, two);
  assert.equal(one.length, 2, "[sector, band] only");
  assert.ok(one.every((v) => Number.isInteger(v) && v >= 0 && v < 16));
  assert.deepEqual(fightSignalsFor(listener, [{ c: fightCellCentre(cellA, W), srcs: new Set([0]) }]), [], "own shots are not a fight nearby");
  const far = fightCellOf(10_000 + FIGHT.RADIUS + 600, 10_000, W);
  assert.deepEqual(fightSignalsFor(listener, [{ c: fightCellCentre(far, W), srcs: new Set([5]) }]), [], "beyond the radius");
});

test("world events: a gunshot reaches far listeners as `fight` only (their own batch), and the heat after HEAT_MIN shots", () => {
  const { m, wall } = worldMatch({ map: eventMap(), worldEvents: true, worldEventsOverride: { drops: [], hots: [] } });
  const a = enter(m, "alice");
  const b = enter(m, "bob");
  a.connected = b.connected = true;
  put(a, 600, 600);
  put(b, 4200, 4200);
  jump(m, wall, 1_100);
  for (let i = 0; i < FIGHT.HEAT_MIN; i++) emitSound(m, a, SoundKind.shot, a.pub.x, a.pub.y, 1);
  const evs = jump(m, wall, 1_000);
  const fights = evs.filter((e) => e.type === "fight");
  assert.equal(fights.length, 1, "bob only (alice's own shots are no signal)");
  const f = fights[0]!;
  assert.ok(f.type === "fight" && f.to === b.rosterIndex);
  const batches = buildBatches(m, evs, [a.rosterIndex, b.rosterIndex], null);
  assert.ok(batches.get(b.rosterIndex)?.fight?.length === 2);
  assert.equal(batches.get(a.rosterIndex)?.fight, undefined);
  jump(m, wall, FIGHT.HEAT_BUCKET_MS);
  assert.match(m.state.heat, /^\d+:1$/, "one coarse heat cell at level 1");
  jump(m, wall, FIGHT.HEAT_WINDOW_MS + FIGHT.HEAT_BUCKET_MS);
  assert.equal(m.state.heat, "", "the heat fades after a minute");
});

// ---------------------------------------------------------------- replay

test("world events: WEV replay records round-trip", () => {
  const chunk = {
    v: REPLAY.VERSION, seq: 0, startMs: 0, endMs: 1000, final: true, roster: [], frames: [{ t: 0, ents: [] }],
    events: [
      { t: 10, type: "wev" as const, ev: "drop_announce" as const, n: 1, x: 1200, y: 3400, r: 400, zone: "Grain Elevator" },
      { t: 20, type: "wev" as const, ev: "hot_start" as const, n: 2, x: 9000, y: 8000, r: 0, zone: "Depot" },
    ],
  };
  const back = decodeReplayChunk(encodeReplayChunk(chunk));
  assert.deepEqual(back.events, chunk.events);
});

// ---------------------------------------------------------------- late refill (late joiners)

/** Open, reveal and take everything from container `i` standing next to it (then it is EMPTIED). */
function emptyContainer(m: Match, wall: { t: number }, rt: PlayerRuntime, i: number): void {
  const c = m.map.containers[i]!;
  put(rt, c.x + 40, c.y);
  assert.ok(m.openSearch(rt.id, `c${i}`), `open c${i}`);
  jump(m, wall, 3_000);
  jump(m, wall, 3_000);
  m.invTakeAll(rt.id);
  jump(m, wall, 50);
  assert.equal(m.containers.stateOf(i), CONTAINER_STATE.EMPTIED, `c${i} emptied`);
}

/** Step the world in sweep-sized jumps until the cycle clock reaches `ms`. */
function sweepTo(m: Match, wall: { t: number }, ms: number): void {
  while (m.clock < ms) jump(m, wall, Math.min(LATE_REFILL.SWEEP_MS, ms - m.clock));
}

test("late refill: from minute 15 a seeded share of emptied, unguarded T0–T2 containers refills after its cooldown from the cheap table, once, never a pool target", () => {
  const spots: ContainerSpot[] = [];
  for (let i = 0; i < 16; i++) spots.push({ x: 2800 + (i % 8) * 180, y: 700 + Math.floor(i / 8) * 260, kind: "safe", tier: (i % 3) as 0 | 1 | 2, zone: null });
  spots.push({ x: 2800, y: 1300, kind: "safe", tier: 3, zone: null }); // T3: never
  spots.push({ x: 4000, y: 4000, kind: "safe", tier: 1, zone: null }); // next to a boss spot: never
  const map = testMap({ containers: spots });
  map.bosses = [{ kind: "foreman", zone: "", x: 4100, y: 4100, guards: [], chance: 0 }];
  const { m, wall } = worldMatch({ map, mode: "live", worldEvents: true, worldEventsOverride: { drops: [], hots: [] } });
  const a = enter(m, "alice");
  spots.forEach((_, i) => emptyContainer(m, wall, a, i));
  put(a, 500, 4400);
  const eligible = spots
    .map((c, i) => ({ c, i, plan: lateRefillPlan(m.lootSeed, i) }))
    .filter(({ c, plan }) => c.tier <= LATE_REFILL.MAX_TIER && !containerGuarded(c, map.bosses) && plan.refills);
  assert.ok(eligible.length >= 3 && eligible.length < 16, `a share refills (${eligible.length} of 16)`);

  sweepTo(m, wall, LATE_REFILL.START_MS - 1_000);
  assert.equal(m.worldEvents.late.size, 0, "nothing before minute 15, whatever the cooldown");
  sweepTo(m, wall, LATE_REFILL.START_MS + 60_000);
  const late = [...m.worldEvents.late.keys()].sort((x, y) => x - y);
  assert.deepEqual(late, eligible.map((e) => e.i), "exactly the eligible share (all emptied ≥ 12 min ago)");
  for (let i = 0; i < spots.length; i++) {
    const want = late.includes(i) ? CONTAINER_STATE.UNTOUCHED : CONTAINER_STATE.EMPTIED;
    assert.equal(m.containers.stateOf(i), want, `c${i} truth`);
    assert.equal(m.state.containerState[i], want, `c${i} public (refill flips at once, nobody near)`);
  }
  for (const i of late) assert.equal(m.containers.poolTargetOk(i), false, "a refilled container is never a pool target");
  const we = m.worldEvents;
  assert.equal(we.rolled.lateRefills, late.length);
  assert.ok(we.rolled.lateJunkCr <= LATE_REFILL.JUNK_CR_MAX, "late refills stay under their share");
  assert.ok(we.rolled.junkCr <= EVENT_BUDGET.JUNK_CR && we.budget.left >= 0, "inside the shared event budget");
  assert.equal(we.budget.left, EVENT_BUDGET.JUNK_CR - we.rolled.junkCr);

  // Contents: the late table only (no uniques), and a search counts again.
  const i = late[0]!;
  const b = enter(m, "bob");
  put(b, spots[i]!.x + 40, spots[i]!.y);
  assert.ok(m.openSearch(b.id, `c${i}`));
  jump(m, wall, 3_000);
  jump(m, wall, 3_000);
  const t = m.containers.targets.get(`c${i}`)!;
  assert.ok(t.loot.total >= 1);
  for (const { item } of lootItems(t)) assert.ok(LATE_REFILL_LOOT.some((e) => e.def === item.def) && !item.uid, `${item.def} from the late table`);
  // Emptied again: never a second late refill this cycle.
  m.invTakeAll(b.id);
  jump(m, wall, 50);
  assert.equal(m.containers.stateOf(i), CONTAINER_STATE.EMPTIED);
  put(b, 500, 4300);
  sweepTo(m, wall, m.clock + LATE_REFILL.COOLDOWN_MAX_MS + 30_000);
  assert.equal(m.containers.stateOf(i), CONTAINER_STATE.EMPTIED, "once per container per cycle");
});

test("late refill: waits while a living human is within HUMAN_MIN_PX, respects the cooldown and stops before the wipe", () => {
  const spots: ContainerSpot[] = [];
  for (let i = 0; i < 12; i++) spots.push({ x: 2600 + i * 150, y: 800, kind: "safe", tier: 1, zone: null });
  const { m, wall } = worldMatch({ map: testMap({ containers: spots }), worldEvents: true, worldEventsOverride: { drops: [], hots: [] } });
  const idx = spots.findIndex((_, i) => lateRefillPlan(m.lootSeed, i).refills);
  assert.ok(idx >= 0);
  const a = enter(m, "alice");
  // Emptied at minute 8: due at 18–20 min, not at 15.
  sweepTo(m, wall, 8 * 60_000);
  emptyContainer(m, wall, a, idx);
  const due = m.containers.emptiedAt(idx) + lateRefillPlan(m.lootSeed, idx).cooldownMs;
  // A human camps 1 000 px away.
  put(a, spots[idx]!.x, spots[idx]!.y + 1_000);
  sweepTo(m, wall, due - 1_000);
  assert.equal(m.containers.stateOf(idx), CONTAINER_STATE.EMPTIED, "cooldown not over");
  sweepTo(m, wall, due + 60_000);
  assert.equal(m.containers.stateOf(idx), CONTAINER_STATE.EMPTIED, "a human within 1 500 px: no refill");
  put(a, spots[idx]!.x, spots[idx]!.y + 1_600);
  sweepTo(m, wall, m.clock + LATE_REFILL.SWEEP_MS + 50);
  assert.equal(m.containers.stateOf(idx), CONTAINER_STATE.UNTOUCHED, "refilled once nobody is near");

  // Late in the cycle nothing refills any more.
  const { m: m2, wall: w2 } = worldMatch({ map: testMap({ containers: spots }), worldEvents: true, worldEventsOverride: { drops: [], hots: [] } });
  const b = enter(m2, "bob");
  // Emptied so late that its cooldown ends inside the last STOP_BEFORE_END_MS: it stays empty.
  sweepTo(m2, w2, WORLD.CYCLE_MS - LATE_REFILL.STOP_BEFORE_END_MS - LATE_REFILL.COOLDOWN_MIN_MS + 30_000);
  emptyContainer(m2, w2, b, idx);
  put(b, 400, 4400);
  sweepTo(m2, w2, WORLD.CYCLE_MS - 30_000);
  assert.equal(m2.worldEvents.late.has(idx), false, "no refill in the last minutes");
  assert.equal(m2.containers.stateOf(idx), CONTAINER_STATE.EMPTIED);
});

test("late refill: rollEventLootCapped charges the shared budget and its own cap by the same junk CR", () => {
  const budget = { left: 1_000 };
  const cap = { left: 100 };
  const out = rollEventLootCapped(mulberry32(3), LATE_REFILL_LOOT, 200, budget, cap);
  const junk = out.reduce((s, f) => s + eventJunkCr(f.def, f.qty), 0);
  assert.ok(junk <= 100 && junk > 0);
  assert.equal(1_000 - budget.left, junk);
  assert.equal(100 - cap.left, junk);
  const none = rollEventLootCapped(mulberry32(4), LATE_REFILL_LOOT, 50, { left: 0 }, { left: 400 });
  assert.ok(none.every((f) => eventJunkCr(f.def, f.qty) === 0), "no shared budget → consumables only");
  for (const e of LATE_REFILL_LOOT) assert.ok(eventJunkCr(e.def, e.qty) <= 55, `${e.def}: cheap junk only`);
});
