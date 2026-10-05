/**
 * In-raid objectives (objectives.ts): lock / key rules and the per-match gate flags, channel
 * interruption (moving, damage), safe cracking, hidden-cache fog safety and clue notes, pool rules
 * for locked-room containers, the objective budget and XP bounds.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CACHE,
  CONTAINER_STATE,
  CRACK,
  LOCK,
  LOCK_STATE,
  OBJ_BUDGET,
  PLAYER,
  POOL,
  ROOM_KEYS,
  SOLID,
  SoundKind,
  XP,
  circleIsFree,
  crackSafes,
  decodeClueRef,
  eventJunkCr,
  gateClosed,
  generateMap,
  hasLineOfSight,
  itemDef,
  lockOverlay,
  lockedRooms,
  poolContainerEligible,
  poolContainerWeight,
  raidXpGain,
  xpForExit,
  type LockedRoom,
} from "@extract/shared";
import { damagePlayer } from "./combat.js";
import type { Match } from "./match.js";
import { poolCandidates } from "./pool-place.js";
import { advance, enter, giveItem, send, worldMatch, type WallClock } from "./test-utils.js";
import type { PlayerRuntime } from "./types.js";

const steppe = generateMap("steppe");

function objMatch(seed = 7, objectives = true): { m: Match; wall: WallClock } {
  return worldMatch({ map: steppe, lootSeed: seed, objectives });
}

function put(rt: PlayerRuntime, x: number, y: number): void {
  rt.pub.x = rt.prevX = x;
  rt.pub.y = rt.prevY = y;
}

/** A free standing point 44–88 px from (x, y) with line of sight on the gate-free base index, outside `avoid`. */
function standNear(m: Match, x: number, y: number, avoid: LockedRoom["room"] | null = null): { x: number; y: number } {
  const base = m.mapRt.idx;
  for (const d of [56, 72, 88, 44]) {
    for (let k = 0; k < 32; k++) {
      const a = (k / 32) * Math.PI * 2;
      const px = Math.round(x + Math.cos(a) * d), py = Math.round(y + Math.sin(a) * d);
      if (avoid && px >= avoid.x - 8 && px <= avoid.x + avoid.w + 8 && py >= avoid.y - 8 && py <= avoid.y + avoid.h + 8) continue;
      // Free with the gates on (never standing in a gate), line of sight without them.
      if (!circleIsFree(m.idx, px, py, PLAYER.RADIUS + 2, SOLID.MOVE)) continue;
      if (!hasLineOfSight(base, px, py, x, y, SOLID.MOVE)) continue;
      return { x: px, y: py };
    }
  }
  throw new Error(`no free point near ${x},${y}`);
}

function gateOf(l: LockedRoom): { x: number; y: number } {
  const d = l.doors[0]!;
  return { x: d.x + d.w / 2, y: d.y + d.h / 2 };
}

function objEvents(evs: ReadonlyArray<{ type: string }>, to: number): Array<{ e: string; i: number; at?: number }> {
  return evs.filter((e) => e.type === "obj" && (e as unknown as { to: number }).to === to).map((e) => (e as unknown as { msg: { e: string; i: number; at?: number } }).msg);
}

// ---------------------------------------------------------------- locks and keys

test("locks: one locked room per T2–T4 POI with a key def, deterministic, mapHash-neutral", () => {
  const locks = lockedRooms(steppe);
  assert.ok(locks.length >= 8 && locks.length <= ROOM_KEYS.length, `locks ${locks.length}`);
  for (const l of locks) {
    const z = steppe.zones.find((q) => q.id === l.zone)!;
    assert.ok(z.tier >= 2, l.zone);
    assert.equal(itemDef(l.key)?.opens, l.zone);
    assert.equal(itemDef(l.key)?.cat, "junk", "keys are CR-economy junk");
    assert.ok(l.containers.length >= 1 && l.doors.length >= 1);
    for (const ci of l.containers) {
      const c = steppe.containers[ci]!;
      assert.ok(c.x >= l.room.x && c.x <= l.room.x + l.room.w && c.y >= l.room.y && c.y <= l.room.y + l.room.h);
    }
  }
  assert.equal(new Set(locks.map((l) => l.zone)).size, locks.length, "one per zone");
});

test("locks: every match has its own gate flags; the shared index stays inert; off without objectives", () => {
  const { m: a } = objMatch(1);
  const { m: b } = objMatch(2);
  const { m: off } = objMatch(3, false);
  const l = a.objectives.locks[0]!;
  assert.ok(gateClosed(a.idx, steppe, l.id) && gateClosed(b.idx, steppe, l.id));
  assert.ok(!gateClosed(a.mapRt.idx, steppe, l.id), "shared index never toggled");
  assert.ok(!gateClosed(off.idx, steppe, l.id), "objectives off: gates inert");
  assert.equal(off.state.lockState.length, 0);
  assert.equal(a.state.lockState.length, a.objectives.locks.length);
  assert.notEqual(a.idx, b.idx);
});

test("locks: F without the key says Requires; with it a 3 s channel opens the gate for everyone, consumes the key, pays XP", () => {
  const { m, wall } = objMatch(11);
  const l = m.objectives.locks.find((q) => q.doors.length === 1) ?? m.objectives.locks[0]!;
  const g = gateOf(l);
  const a = enter(m, "aaaaaaaa-0000-4000-8000-000000000001");
  const at = standNear(m, g.x, g.y, l.room);
  put(a, at.x, at.y);
  advance(m, wall, 50);
  assert.ok(m.objectives.containerLocked(l.containers[0]!));
  assert.ok(m.interact(a.id));
  let evs = advance(m, wall, 50);
  assert.deepEqual(objEvents(evs, a.rosterIndex).map((e) => e.e), ["locked"]);
  assert.equal(m.objectives.channelOf(a), null);

  giveItem(m, a.id, l.key, "p0");
  assert.ok(m.interact(a.id));
  const ch = m.objectives.channelOf(a)!;
  assert.equal(ch.kind, "unlock");
  assert.equal(ch.until - m.clock, LOCK.UNLOCK_MS);
  evs = advance(m, wall, LOCK.UNLOCK_MS + 100);
  const notes = objEvents(evs, a.rosterIndex).map((e) => e.e);
  assert.ok(notes.includes("unlock") && notes.includes("unlocked"), notes.join());
  assert.ok(m.objectives.isOpen(l.id));
  assert.ok(!gateClosed(m.idx, steppe, l.id));
  assert.ok(!m.objectives.containerLocked(l.containers[0]!));
  assert.ok(![...a.self.slots.values()].some((it) => it.def === l.key), "key consumed");
  assert.equal(a.stats.objectives, 1);
  assert.ok(evs.some((e) => e.type === "xp" && (e as { msg: { k: string; xp: number } }).msg.k === "objectives" && (e as { msg: { xp: number } }).msg.xp === XP.OBJECTIVE));
  // Public flag deferred while the unlocker stands there, published once they left (disclosure).
  assert.equal(m.state.lockState[l.id], LOCK_STATE.LOCKED);
  put(a, 400, 400);
  advance(m, wall, 3_500);
  assert.equal(m.state.lockState[l.id], LOCK_STATE.OPEN);
});

test("locks: moving away or taking damage breaks the unlock channel; the key stays", () => {
  const { m, wall } = objMatch(12);
  const l = m.objectives.locks[0]!;
  const g = gateOf(l);
  const a = enter(m, "aaaaaaaa-0000-4000-8000-000000000002");
  const at = standNear(m, g.x, g.y, l.room);
  put(a, at.x, at.y);
  giveItem(m, a.id, l.key, "p0");
  advance(m, wall, 50);
  assert.ok(m.interact(a.id) && m.objectives.channelOf(a));
  put(a, at.x + (LOCK.MOVE_TOL_PX + 6), at.y);
  let evs = advance(m, wall, 100);
  assert.equal(m.objectives.channelOf(a), null);
  assert.ok(objEvents(evs, a.rosterIndex).some((e) => e.e === "stop"));
  put(a, at.x, at.y);
  assert.ok(m.interact(a.id) && m.objectives.channelOf(a));
  damagePlayer(m, a, 5, null, "rifle", a.pub.x, a.pub.y);
  evs = advance(m, wall, LOCK.UNLOCK_MS + 200);
  assert.equal(m.objectives.channelOf(a), null);
  assert.ok(!m.objectives.isOpen(l.id));
  assert.ok([...a.self.slots.values()].some((it) => it.def === l.key), "key kept");
  assert.equal(a.stats.objectives ?? 0, 0);
});

test("locks: the gate really blocks walking in (and barred windows stop a roll vault) until unlocked", () => {
  const { m, wall } = objMatch(13);
  const l = m.objectives.locks.find((q) => q.doors.length === 1 && q.bars.length > 0) ?? m.objectives.locks.find((q) => q.doors.length === 1)!;
  const d = l.doors[0]!;
  const vert = d.w < d.h;
  const g = gateOf(l);
  const rc = { x: l.room.x + l.room.w / 2, y: l.room.y + l.room.h / 2 };
  const nx = vert ? Math.sign(rc.x - g.x) : 0, ny = vert ? 0 : Math.sign(rc.y - g.y);
  const a = enter(m, "aaaaaaaa-0000-4000-8000-000000000009");
  put(a, g.x - nx * 70, g.y - ny * 70);
  const inRoom = () => a.pub.x > l.room.x && a.pub.x < l.room.x + l.room.w && a.pub.y > l.room.y && a.pub.y < l.room.y + l.room.h;
  const walk = (ms: number) => {
    for (let t = 0; t < ms; t += 50) {
      wall.t += 50;
      send(m, a.id, { mx: nx, my: ny });
      m.step(50);
      m.drainEvents();
    }
  };
  walk(1500);
  assert.ok(!inRoom(), "locked: stopped at the gate");
  // Bars: MOVE without the VAULT bit, so the roll (ignore = VAULT) cannot pass them either.
  const o = lockOverlay(steppe);
  const [b0, b1] = o.bars[l.id]!;
  for (let i = b0; i < b1; i++) assert.equal(m.idx.rectFlags[o.base + i], SOLID.MOVE);
  put(a, g.x - nx * 70, g.y - ny * 70);
  giveItem(m, a.id, l.key, "p0");
  walk(50);
  assert.ok(m.interact(a.id));
  advance(m, wall, LOCK.UNLOCK_MS + 100);
  assert.ok(m.objectives.isOpen(l.id));
  walk(1500);
  assert.ok(inRoom(), "open: walked in");
});

test("keys: at most one per lock per cycle, holders seeded by the loot seed, containers outside the room", () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const { m } = objMatch(seed);
    const { m: again } = objMatch(seed);
    assert.deepEqual(m.objectives.keyPlans, again.objectives.keyPlans);
    assert.equal(m.objectives.keyPlans.length, m.objectives.locks.length);
    for (const p of m.objectives.keyPlans) {
      if (p.holder !== "container") continue;
      const idx = Number(p.at);
      assert.equal(steppe.containers[idx]!.zone, m.objectives.locks[p.lock]!.zone);
      assert.ok(!m.objectives.locks.some((l) => l.containers.includes(idx)));
    }
    assert.ok(m.objectives.rolled.keys <= m.objectives.locks.length);
  }
  // emptyWorld has no NPCs, so every key sits in a container: rolling it hands the key out.
  const { m } = objMatch(5);
  const p = m.objectives.keyPlans.find((q) => q.holder === "container")!;
  const items = m.containers.roll(Number(p.at));
  assert.equal(items.filter((it) => it.def === m.objectives.locks[p.lock]!.key).length, 1);
});

// ---------------------------------------------------------------- safe cracking

test("crack: a 12 s channel with loud dial ticks; the safe stays untouched until cracked, then opens; damage resets it", () => {
  const { m, wall } = objMatch(21);
  const idx = [...crackSafes(steppe)][0]!;
  const s = steppe.containers[idx]!;
  const a = enter(m, "aaaaaaaa-0000-4000-8000-000000000003");
  const at = standNear(m, s.x, s.y);
  put(a, at.x, at.y);
  advance(m, wall, 50);
  assert.ok(m.openSearch(a.id, `c${idx}`));
  assert.equal(m.objectives.channelOf(a)?.kind, "crack");
  assert.equal(a.search, null, "no search session while cracking");
  // Damage halfway: progress lost.
  let evs = advance(m, wall, CRACK.MS / 2);
  damagePlayer(m, a, 5, null, "rifle", a.pub.x, a.pub.y);
  evs = evs.concat(advance(m, wall, 200));
  assert.equal(m.objectives.channelOf(a), null);
  assert.equal(m.containers.stateOf(idx), CONTAINER_STATE.UNTOUCHED);
  const ticks = evs.filter((e) => e.type === "sound" && (e as { kind: number }).kind === SoundKind.search && (e as { variant: number }).variant === CRACK.SOUND_VARIANT);
  assert.ok(ticks.length >= 5, `ticks ${ticks.length}`);
  assert.ok((ticks[0] as unknown as { radius: number }).radius > 1_000, "the dial is loud");
  // A full crack.
  assert.ok(m.openSearch(a.id, `c${idx}`));
  evs = advance(m, wall, CRACK.MS + 150);
  assert.ok(m.objectives.cracked.has(idx));
  const sessionKey = (rt: PlayerRuntime): string | undefined => rt.search?.key;
  assert.equal(sessionKey(a), `c${idx}`, "straight into the ordinary search");
  assert.equal(a.stats.objectives, 1);
  assert.ok(objEvents(evs, a.rosterIndex).some((e) => e.e === "cracked" && e.i === idx));
  // Cracked: the next opener searches at once (no second channel).
  const b = enter(m, "aaaaaaaa-0000-4000-8000-000000000004");
  put(b, at.x, at.y);
  assert.ok(m.openSearch(b.id, `c${idx}`));
  assert.equal(m.objectives.channelOf(b), null);
  assert.equal(b.search?.key, `c${idx}`);
});

// ---------------------------------------------------------------- hidden caches

test("caches: never sent to a client before it finds one; notes carry a fuzzy circle around it", () => {
  const { m, wall } = objMatch(31);
  const caches = m.objectives.caches;
  assert.equal(caches.length, CACHE.COUNT);
  const c0 = caches[0]!;
  const far = enter(m, "aaaaaaaa-0000-4000-8000-000000000005");
  const near = enter(m, "aaaaaaaa-0000-4000-8000-000000000006");
  // Inside the far one's AOI ring but well beyond FIND_PX; the near one right next to it.
  const p = standNear(m, c0.x, c0.y);
  put(near, p.x, p.y);
  put(far, c0.x + CACHE.FIND_PX + 400 < steppe.width - 300 ? c0.x + CACHE.FIND_PX + 400 : c0.x - CACHE.FIND_PX - 400, c0.y);
  const corpse = c0.target!.corpse!;
  assert.ok(!m.aoi.allowed(corpse, far.rosterIndex) && !m.aoi.allowed(corpse, near.rosterIndex), "hidden at start");
  assert.ok(!m.aoi.ring(m, far.rosterIndex, far.pub.x, far.pub.y).includes(corpse));
  const evs = advance(m, wall, 600);
  assert.ok(m.aoi.allowed(corpse, near.rosterIndex), "found within FIND_PX");
  assert.ok(!m.aoi.allowed(corpse, far.rosterIndex), "still hidden from the other");
  assert.deepEqual(objEvents(evs, near.rosterIndex).filter((e) => e.e === "found").map((e) => e.i), [c0.n]);
  assert.equal(objEvents(evs, far.rosterIndex).length, 0);
  // Notes: NOTES_PER_CACHE per cache, ref = a circle within CLUE_OFFSET_MAX × R of the cache.
  let notes = 0;
  for (let i = 0; i < steppe.containers.length; i++) {
    for (const it of m.containers.roll(i)) {
      if (it.def !== "note_cache") continue;
      notes++;
      const c = decodeClueRef(it.ref ?? "")!;
      const ch = caches.find((q) => q.n === c.n)!;
      assert.ok(Math.hypot(c.x - ch.x, c.y - ch.y) <= CACHE.CLUE_R * CACHE.CLUE_OFFSET_MAX + 1);
      assert.ok(Math.hypot(c.x - ch.x, c.y - ch.y) > 0, "never centred on the cache");
      assert.ok((it.label ?? "").length > 0 && (it.label ?? "").length <= 64);
    }
  }
  assert.equal(notes, CACHE.COUNT * CACHE.NOTES_PER_CACHE);
});

test("caches: opening one is an objective; points are deterministic in the loot seed", () => {
  const { m, wall } = objMatch(32);
  const { m: again } = objMatch(32);
  assert.deepEqual(m.objectives.caches.map((c) => [c.x, c.y]), again.objectives.caches.map((c) => [c.x, c.y]));
  const c0 = m.objectives.caches[0]!;
  const a = enter(m, "aaaaaaaa-0000-4000-8000-000000000007");
  const p = standNear(m, c0.x, c0.y);
  put(a, p.x, p.y);
  advance(m, wall, 300);
  assert.ok(m.openSearch(a.id, c0.target!.key));
  advance(m, wall, CACHE.OPEN_MS + 200);
  assert.equal(a.stats.objectives, 1);
});

// ---------------------------------------------------------------- pool, budget, XP

test("pool: eligible locked-room containers weigh × POOL_WEIGHT_MULT; T2 locked rooms never take a pool item", () => {
  const { m } = objMatch(41);
  const cands = poolCandidates(m, 0);
  let seen = 0;
  for (const l of m.objectives.locks) {
    for (const idx of l.containers) {
      const spot = steppe.containers[idx]!;
      const c = cands.find((q) => q.container === idx);
      if (!poolContainerEligible(spot)) {
        assert.equal(c, undefined, `T${spot.tier} ${spot.kind} is no pool target`);
        continue;
      }
      seen++;
      assert.ok(c);
      const base = poolContainerWeight({ tier: spot.tier, guarded: false });
      assert.equal(c!.weight, base * LOCK.POOL_WEIGHT_MULT);
    }
  }
  assert.ok(seen > 0, "the radar / relay rooms hold eligible containers");
  assert.ok(POOL.CONTAINER_MIN_TIER >= 3);
});

test("budget: strongroom rolls and caches never add more than OBJ_BUDGET junk CR per cycle", () => {
  for (const seed of [1, 9, 77]) {
    const { m } = objMatch(seed);
    let junk = 0;
    for (const c of m.objectives.caches) for (const it of m.containers.remaining(c.target!)) junk += eventJunkCr(it.def, it.qty);
    for (const l of m.objectives.locks) {
      for (const idx of l.containers) {
        const before = m.objectives.rolled.junkCr;
        m.containers.roll(idx);
        junk += m.objectives.rolled.junkCr - before;
      }
    }
    assert.ok(m.objectives.rolled.junkCr <= OBJ_BUDGET.JUNK_CR, `rolled ${m.objectives.rolled.junkCr}`);
    assert.ok(junk <= OBJ_BUDGET.JUNK_CR);
    assert.ok(m.objectives.budget.left >= 0);
  }
});

test("XP: objectives pay XP.OBJECTIVE each up to OBJECTIVE_MAX per entry, nothing on MIA", () => {
  const base = { exit: "extract" as const, onMapMs: 0, haulCr: 0, containers: 0, marauders: 0, guards: 0, bosses: 0, rankedPvp: 0, grindToday: 0, firstExtractToday: false };
  assert.equal(xpForExit({ ...base, objectives: 2 }).total, 2 * XP.OBJECTIVE);
  assert.equal(xpForExit({ ...base, objectives: 99 }).total, XP.OBJECTIVE_MAX * XP.OBJECTIVE);
  assert.equal(xpForExit({ ...base, exit: "mia", objectives: 3 }).total, 0);
  assert.deepEqual(xpForExit({ ...base, objectives: 1 }).lines, [{ key: "objectives", qty: 1, xp: XP.OBJECTIVE }]);
  assert.equal(raidXpGain("objectives", XP.OBJECTIVE_MAX), XP.OBJECTIVE);
  assert.equal(raidXpGain("objectives", XP.OBJECTIVE_MAX + 1), 0);
  // Inside the daily soft cap like the other activity lines.
  assert.equal(xpForExit({ ...base, objectives: 5, grindToday: XP.DAILY_SOFT_CAP }).total, Math.floor(5 * XP.OBJECTIVE * XP.DAILY_OVER_MULT));
});
