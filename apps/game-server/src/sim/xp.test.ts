/**
 * In-raid XP (xp.ts): the server credits SelfState.raidXp and sends a personal `xp` event whenever
 * it counts an XP action, mirroring xpForExit's action lines and the per-entry container cap.
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/game-server/src/sim/xp.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NPC_ROLE, XP, containerOpenMs, mulberry32, raidXpGain, type ContainerSpot, type ItemLike } from "@extract/shared";
import { buildBatches } from "./audience.js";
import { closeSearch } from "./containers.js";
import { killPlayer } from "./death.js";
import { makeItem } from "./items.js";
import { Match } from "./match.js";
import type { MatchEvent } from "./types.js";
import { counterUid, ids, npcOpts, npcsOf, place, rtOf, run, testMap, testMatch, testPost } from "./test-utils.js";

const CRATES: ContainerSpot[] = [
  { x: 1100, y: 1500, kind: "crate", tier: 1, zone: null },
  { x: 1100, y: 1700, kind: "pc", tier: 2, zone: null },
];

function crateMatch(n = 2): Match {
  const m = testMatch(n, { map: testMap({ containers: CRATES }) });
  m.containers.roll = (): ItemLike[] => [makeItem("junk_bolts")];
  return m;
}

const xpEvents = (ev: readonly MatchEvent[]) => ev.flatMap((e) => (e.type === "xp" ? [{ to: e.to, ...e.msg }] : []));

test("raidXpGain mirrors the xpForExit action lines and stops paying containers past the per-entry cap", () => {
  assert.equal(raidXpGain("containers", 1), XP.CONTAINER);
  assert.equal(raidXpGain("containers", XP.CONTAINER_MAX), XP.CONTAINER);
  assert.equal(raidXpGain("containers", XP.CONTAINER_MAX + 1), 0);
  assert.equal(raidXpGain("npc", 1), XP.NPC);
  assert.equal(raidXpGain("guard", 3), XP.GUARD);
  assert.equal(raidXpGain("boss", 1), XP.BOSS);
  assert.equal(raidXpGain("pvp", 1), XP.PVP);
});

test("a container counts once its open delay passed: +XP to the searcher only, once per container", () => {
  const m = crateMatch();
  const [a, b] = ids(m);
  place(m, a!, 1040, 1500);
  place(m, b!, 3000, 1000);
  const rt = rtOf(m, a!);
  assert.ok(m.interact(a!));
  const early = run(m, containerOpenMs(CRATES[0]!) - 100);
  assert.deepEqual(xpEvents(early), [], "nothing before the delay");
  const ev = run(m, 300);
  assert.deepEqual(xpEvents(ev), [{ to: rt.rosterIndex, k: "containers", xp: XP.CONTAINER, n: 1 }]);
  assert.equal(rt.self.raidXp, XP.CONTAINER);
  // Close and search the same crate again: no second count.
  closeSearch(m, rt, "test");
  assert.equal(rt.search, null);
  assert.ok(m.interact(a!));
  const again = run(m, containerOpenMs(CRATES[0]!) + 300);
  assert.deepEqual(xpEvents(again), []);
  assert.equal(rt.self.raidXp, XP.CONTAINER);

  // Only the earner gets it in their batch.
  const batches = buildBatches(m, [{ type: "xp", to: rt.rosterIndex, msg: { k: "containers", xp: 2, n: 1 } }], [rt.rosterIndex, rtOf(m, b!).rosterIndex], null);
  assert.deepEqual(batches.get(rt.rosterIndex)?.xp, [{ k: "containers", xp: 2, n: 1 }]);
  assert.equal(batches.has(rtOf(m, b!).rosterIndex), false);
});

test("past XP.CONTAINER_MAX a container still counts but adds 0 (the HUD shows the cap)", () => {
  const m = crateMatch();
  const [a] = ids(m);
  const rt = rtOf(m, a!);
  rt.stats.containersSearched = XP.CONTAINER_MAX;
  place(m, a!, 1040, 1500);
  assert.ok(m.interact(a!));
  const ev = run(m, containerOpenMs(CRATES[0]!) + 200);
  assert.deepEqual(xpEvents(ev), [{ to: rt.rosterIndex, k: "containers", xp: 0, n: XP.CONTAINER_MAX + 1 }]);
  assert.equal(rt.self.raidXp, 0);
});

test("guests earn no XP at all: no event, no estimate", () => {
  const m = crateMatch();
  const [a] = ids(m);
  const rt = rtOf(m, a!);
  rt.guest = true;
  place(m, a!, 1040, 1500);
  assert.ok(m.interact(a!));
  const ev = run(m, containerOpenMs(CRATES[0]!) + 200);
  assert.deepEqual(xpEvents(ev), []);
  assert.equal(rt.stats.containersSearched, 1, "still counted for the report");
  assert.equal(rt.self.raidXp, 0);
});

test("marauder, guard and boss kills credit their XP lines to the human killer", () => {
  const m = new Match({
    roster: [{ userId: "u0", nickname: "H" }],
    rng: mulberry32(1), map: testMap(), newUid: counterUid, now: () => 0, emptyWorld: true, strictLedger: true,
    npcBrains: false, envSeed: 1, weatherOverride: "clear", mapSeed: 77,
    ...npcOpts([testPost(0, 1550, 1500), testPost(1, 2550, 1500), testPost(2, 3550, 1500)]),
  });
  const [h] = ids(m);
  const killer = rtOf(m, h!);
  const [mar, guard, boss] = npcsOf(m);
  guard!.pub.role = NPC_ROLE.GUARD;
  boss!.pub.role = NPC_ROLE.BOSS;
  m.drainEvents();
  killPlayer(m, mar!, killer, "rifle");
  killPlayer(m, guard!, killer, "rifle");
  killPlayer(m, boss!, killer, "rifle");
  const xp = xpEvents(m.drainEvents());
  assert.deepEqual(xp.map((e) => [e.k, e.xp, e.n]), [["npc", XP.NPC, 1], ["guard", XP.GUARD, 1], ["boss", XP.BOSS, 1]]);
  assert.ok(xp.every((e) => e.to === killer.rosterIndex));
  assert.equal(killer.self.raidXp, XP.NPC + XP.GUARD + XP.BOSS);
});

test("PvP: a registered victim of at least PVP_VICTIM_MIN_LEVEL pays the estimate; a low-level or guest victim does not", () => {
  const m = testMatch(4);
  const [a, b, c, d] = ids(m);
  const killer = rtOf(m, a!);
  rtOf(m, b!).level = XP.PVP_VICTIM_MIN_LEVEL;
  rtOf(m, c!).level = 1;
  rtOf(m, d!).level = 9;
  rtOf(m, d!).guest = true;
  m.drainEvents();
  killPlayer(m, rtOf(m, b!), killer, "rifle");
  killPlayer(m, rtOf(m, c!), killer, "rifle");
  killPlayer(m, rtOf(m, d!), killer, "rifle");
  const xp = xpEvents(m.drainEvents());
  assert.deepEqual(xp.map((e) => [e.to, e.k, e.xp]), [[killer.rosterIndex, "pvp", XP.PVP]]);
  assert.equal(killer.self.raidXp, XP.PVP);
  assert.equal(killer.self.kills, 3, "every kill still counts in the kill tally");
});
