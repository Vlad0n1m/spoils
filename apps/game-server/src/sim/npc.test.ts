/**
 * NPC MODEL v5 brains (npc.ts): marauder FSM (post → alert → engage → chase inside leash + chase
 * extra → search last-known → return), squad alerts that never cross squads, the peace window,
 * no firing at sound-only targets, dormancy, and the hard rules: an NPC never opens a container,
 * picks anything up or extracts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTAINER_STATE, INPUT_HZ, ITEM_FLAG, MARAUDER, NPC, SERVER_TICK_MS, SOLID, hasLineOfSight, mulberry32, rollMarauderKit, type NpcPost } from "@extract/shared";
import { damagePlayer } from "./combat.js";
import { spawnGroundItem } from "./inventory.js";
import { makeItem } from "./items.js";
import type { Match } from "./match.js";
import type { NpcBrain } from "./npc.js";
import { WORLD_T0, addExtract, advance, enter, ids, jump, npcOpts, npcsOf, rtOf, run, testMap, testMatch, testPost, worldMatch, type TestMapOpts, type Timed } from "./test-utils.js";
import type { PlayerRuntime } from "./types.js";

/** One human + the given marauder posts on the open test arena (midday, clear). */
function arena(posts: NpcPost[], map: TestMapOpts = {}, seed = 42): { m: Match; h: string; human: PlayerRuntime; npcs: PlayerRuntime[] } {
  const m = testMatch(1, { map: testMap(map), envSeed: 2, mapSeed: seed, ...npcOpts(posts) });
  const h = ids(m)[0]!;
  return { m, h, human: rtOf(m, h), npcs: npcsOf(m) };
}

function brain(m: Match, rt: PlayerRuntime): NpcBrain {
  const b = m.npcs.brain(rt);
  assert.ok(b, `no brain for ${rt.id}`);
  return b;
}

/** Skip the peace window without simulating it (rule tests on the empty arena). */
function skipPeace(m: Match, extraMs = 1000): void {
  m.state.clockMs = NPC.PEACE_MS + extraMs;
}

const shotsOf = (ev: Timed[], rts: readonly PlayerRuntime[]) => ev.filter((e) => e.type === "shot" && rts.some((r) => r.rosterIndex === e.src));

test("NPC input accumulator: exactly INPUT_HZ samples per second while awake, all applied", () => {
  const { m, human, npcs } = arena([testPost(0, 1500, 1500)]);
  human.pub.x = 1000;
  human.pub.y = 3500;
  const b = brain(m, npcs[0]!);
  run(m, 1000);
  const s0 = b.samples;
  run(m, 3000);
  assert.equal(b.samples - s0, 3 * INPUT_HZ);
  assert.equal(npcs[0]!.queue.length, 0, "every sample was applied");
});

test("peace: an NPC never starts a fight with a human outside its post, but returns fire at a recent attacker", () => {
  const { m, h, human, npcs } = arena([testPost(0, 1500, 1500)]);
  const npc = npcs[0]!;
  // Outside the low leash (500) and beyond NPC.PEACE_CLOSE_PX, inside sight and pistol range.
  human.pub.x = 1500;
  human.pub.y = 2160;
  human.pub.hp = 1e6;
  brain(m, npc).tune({ aim: Math.PI / 2, rollChance: 0 });
  const calm = run(m, 8000);
  assert.ok(m.vision.sees(npc.rosterIndex, human.rosterIndex), "it sees the human");
  assert.equal(shotsOf(calm, [npc]).length, 0, "no fire in the peace window");
  assert.notEqual(brain(m, npc).state, "combat");
  // The human shoots first: the NPC answers at once (still inside the peace window).
  assert.ok(m.clock < NPC.PEACE_MS);
  const ev = run(m, 4000, { [h]: { aim: -Math.PI / 2, fire: true } });
  assert.ok(npc.lastHitAt > 0, "the human hit it");
  assert.ok(shotsOf(ev, [npc]).length > 0, "it returns fire");
});

test("peace: a human walking into the post (inside the leash) is fought even in the peace window", () => {
  const { m, human, npcs } = arena([testPost(0, 1500, 1500)]);
  const npc = npcs[0]!;
  human.pub.x = 1500;
  human.pub.y = 1850;
  human.pub.hp = 1e6;
  brain(m, npc).tune({ aim: Math.PI / 2, rollChance: 0 });
  const ev = run(m, 4000);
  assert.ok(m.clock < NPC.PEACE_MS);
  assert.ok(shotsOf(ev, [npc]).length > 0, "an intruder is shot at");
  assert.equal(brain(m, npc).state, "combat");
});

test("engage: the first shot comes ≥ reactMs[0] after the first sighting; never at a target it cannot see", () => {
  const { m, human, npcs } = arena([testPost(0, 1500, 1500)]);
  const npc = npcs[0]!;
  skipPeace(m);
  human.pub.x = 1500;
  human.pub.y = 1900;
  human.pub.hp = 1e6;
  brain(m, npc).tune({ aim: Math.PI / 2, rollChance: 0 });
  let seenAt = -1;
  let shotAt = -1;
  for (let t = 0; t < 4000 && shotAt < 0; t += SERVER_TICK_MS) {
    m.step(SERVER_TICK_MS);
    if (seenAt < 0 && m.vision.sees(npc.rosterIndex, human.rosterIndex)) seenAt = m.clock;
    for (const e of m.drainEvents()) if (e.type === "shot" && e.src === npc.rosterIndex && shotAt < 0) shotAt = m.clock;
    if (shotAt >= 0) assert.ok(m.vision.sees(npc.rosterIndex, human.rosterIndex), "it fired at a visible target");
  }
  const cls = MARAUDER.low;
  assert.ok(seenAt >= 0 && shotAt >= 0, `seen ${seenAt}, shot ${shotAt}`);
  assert.ok(shotAt - seenAt >= cls.reactMs[0], `reaction ${shotAt - seenAt} ms ≥ ${cls.reactMs[0]}`);
  assert.equal(brain(m, npc).state, "combat");
});

test("sound only: a gunshot behind a long wall alerts the squad and sends it searching, but nobody fires", () => {
  // A long wall between the post and the shooter; going around it would leave the chase radius.
  const { m, h, human, npcs } = arena([testPost(0, 1800, 2000, { size: [2, 2] })], { walls: [{ x: 2100, y: 600, w: 30, h: 2800 }] });
  skipPeace(m);
  human.pub.x = 2400;
  human.pub.y = 2000;
  human.pub.hp = 1e6;
  const ev = run(m, 12_000, { [h]: { aim: 0, fire: true } });
  const sq = m.npcs.info(npcs[0]!)!.squad;
  assert.ok(sq.alertAt, "the shots alerted the squad");
  assert.ok(npcs.some((n) => brain(m, n).state === "search"), `states ${npcs.map((n) => brain(m, n).state)}`);
  assert.equal(shotsOf(ev, npcs).length, 0, "no NPC fires at a sound");
  for (const n of npcs) {
    const inf = m.npcs.info(n)!;
    assert.ok(Math.hypot(n.pub.x - inf.anchor.x, n.pub.y - inf.anchor.y) <= inf.chase + 60, "inside its chase radius");
  }
});

test("chase inside leash + CHASE_EXTRA, search the last-known spot, then return to the post (HP not regenerated)", () => {
  // A T2 ("mid") post: leash 700, chase 1000.
  const { m, h, human, npcs } = arena([testPost(0, 1500, 2000, { tier: 2 })]);
  const npc = npcs[0]!;
  const inf = m.npcs.info(npc)!;
  assert.equal(inf.leash, MARAUDER.mid.leashPx);
  assert.equal(inf.chase, MARAUDER.mid.leashPx + NPC.CHASE_EXTRA_PX);
  skipPeace(m);
  human.pub.x = 2100;
  human.pub.y = 2000;
  human.pub.hp = 1e6;
  brain(m, npc).tune({ aim: 0, rollChance: 0 });
  npc.pub.hp = 60;
  let maxOut = 0;
  let maxD = 0;
  const watch = () => {
    const d = Math.hypot(npc.pub.x - inf.anchor.x, npc.pub.y - inf.anchor.y);
    maxD = Math.max(maxD, d);
    maxOut = Math.max(maxOut, d - inf.chase);
  };
  // Engage, then the human backs off east, out of reach (walking away at full speed).
  for (let t = 0; t < 3000; t += SERVER_TICK_MS) { run(m, SERVER_TICK_MS); watch(); }
  assert.equal(brain(m, npc).state, "combat");
  for (let t = 0; t < 4000; t += SERVER_TICK_MS) { run(m, SERVER_TICK_MS, { [h]: { mx: 1, my: 0, aim: Math.PI } }); watch(); }
  // Gone (teleported far away, still inside the wake radius).
  human.pub.x = 4400;
  human.pub.y = 600;
  let searched = false;
  for (let t = 0; t < 45_000; t += SERVER_TICK_MS) {
    run(m, SERVER_TICK_MS);
    watch();
    if (brain(m, npc).state === "search") searched = true;
  }
  assert.ok(maxD > inf.leash * 0.5, `it went after the human (max ${maxD.toFixed(0)} px)`);
  assert.ok(maxOut <= 60, `never beyond leash + chase extra (out by ${maxOut.toFixed(0)} px)`);
  assert.ok(searched, "it searched the last-known position");
  assert.equal(brain(m, npc).state, "idle", "back to idle");
  assert.ok(Math.hypot(npc.pub.x - inf.anchor.x, npc.pub.y - inf.anchor.y) < 100, "back on its post");
  assert.equal(npc.pub.hp, 60, "no regeneration");
  assert.equal(npc.stats.containersSearched + npc.stats.corpsesSearched, 0);
});

test("alerted sight: an NPC shot at sees to VISION.RANGE (calm cap NPC.VIEW_RANGE_CAP); a muzzle flash beats the calm cap", () => {
  const { m, human, npcs } = arena([testPost(0, 1500, 1500, { tier: 2 })]);
  const npc = npcs[0]!;
  skipPeace(m);
  human.pub.x = 1500 + 900;
  human.pub.y = 1500;
  human.pub.hp = 1e6;
  brain(m, npc).tune({ aim: 0, rollChance: 0 });
  run(m, 1000);
  assert.ok(!m.vision.sees(npc.rosterIndex, human.rosterIndex), "calm: 900 px is beyond the 800 px cap");
  assert.equal(npc.viewCap, NPC.VIEW_RANGE_CAP);
  damagePlayer(m, npc, 5, human, "rifle", npc.pub.x, npc.pub.y);
  run(m, NPC.THINK_MS + 2 * SERVER_TICK_MS);
  assert.equal(npc.viewCap, NPC.VIEW_RANGE_ALERT);
  assert.ok(m.vision.sees(npc.rosterIndex, human.rosterIndex), "alerted: seen at 900 px");
});

test("cover: hit by a human beyond its sight, an NPC leaves the line of fire inside its chase radius, never fires blind, then returns to its post", () => {
  // A wall south-east of the post; the shooter stands 1200 px east (beyond VISION.RANGE).
  const { m, human, npcs } = arena([testPost(0, 1500, 1500)], { walls: [{ x: 1600, y: 1600, w: 50, h: 300 }] });
  const npc = npcs[0]!;
  const inf = m.npcs.info(npc)!;
  skipPeace(m);
  human.pub.x = 2700;
  human.pub.y = 1500;
  human.pub.hp = 1e6;
  brain(m, npc).tune({ aim: Math.PI, rollChance: 0 });
  run(m, 500);
  let shots = 0;
  let maxD = 0;
  for (let t = 0; t < 3000; t += SERVER_TICK_MS) {
    if (t % 1000 === 0) damagePlayer(m, npc, 1, human, "sniper", npc.pub.x, npc.pub.y);
    shots += shotsOf(run(m, SERVER_TICK_MS), [npc]).length;
    maxD = Math.max(maxD, Math.hypot(npc.pub.x - inf.anchor.x, npc.pub.y - inf.anchor.y));
  }
  assert.equal(brain(m, npc).state, "cover");
  assert.ok(!hasLineOfSight(m.idx, human.pub.x, human.pub.y, npc.pub.x, npc.pub.y, SOLID.SHOT), `out of the line of fire at ${npc.pub.x.toFixed(0)},${npc.pub.y.toFixed(0)}`);
  assert.ok(maxD <= inf.chase, `inside its chase radius (${maxD.toFixed(0)} px)`);
  assert.equal(shots, 0, "never fires at a target it cannot see");
  // The shooter leaves (still inside the wake radius): the alert runs out and it walks home.
  human.pub.x = 1500;
  human.pub.y = 4400;
  run(m, NPC.UNDER_FIRE_MS + NPC.SQUAD_ALERT_MS + NPC.SEARCH_MS + 10_000);
  assert.equal(brain(m, npc).state, "idle");
  assert.ok(Math.hypot(npc.pub.x - inf.anchor.x, npc.pub.y - inf.anchor.y) < 100, "back on its post");
});

test("outranged: a shotgun marauder carries a FREE pistol sidearm and switches to it for a target beyond shotgun range", () => {
  let seed = 1;
  while (rollMarauderKit(seed, 0, 1, "low")[0]!.weapon !== "shotgun") seed++;
  const { m, human, npcs } = arena([testPost(0, 1500, 1500)], {}, seed);
  const npc = npcs[0]!;
  const w2 = npc.self.slots.get("w2");
  assert.equal(w2?.def, "pistol");
  assert.ok(w2!.flags & ITEM_FLAG.FREE, "the sidearm is FREE (never in a corpse)");
  skipPeace(m);
  human.pub.x = 1500;
  human.pub.y = 1500 + 620;
  human.pub.hp = 1e6;
  brain(m, npc).tune({ aim: Math.PI / 2, rollChance: 0 });
  damagePlayer(m, npc, 1, human, "pistol", npc.pub.x, npc.pub.y);
  let shots = 0;
  for (let t = 0; t < 6000; t += SERVER_TICK_MS) {
    // The human backs off to keep ~620 px (beyond shotgun range 420).
    const d = Math.hypot(npc.pub.x - human.pub.x, npc.pub.y - human.pub.y);
    shots += shotsOf(run(m, SERVER_TICK_MS, { [ids(m)[0]!]: { mx: 0, my: d < 600 ? 1 : 0, aim: -Math.PI / 2 } }), [npc]).length;
  }
  assert.equal(npc.self.active, "w2", "switched to the pistol");
  assert.ok(shots > 0, "it fires back at 600+ px");
});

test("squad alert: a hit reaches every squadmate within one think, never another squad", () => {
  const { m, human, npcs } = arena([testPost(0, 1500, 1500, { size: [3, 3] }), testPost(1, 3600, 3600, { size: [2, 2] })]);
  skipPeace(m);
  human.pub.x = 400;
  human.pub.y = 4400;
  human.pub.hp = 1e6;
  run(m, 500);
  const a = npcs.filter((n) => m.npcs.info(n)!.squad.post!.id === 0);
  const b = npcs.filter((n) => m.npcs.info(n)!.squad.post!.id === 1);
  assert.equal(a.length, 3);
  assert.equal(b.length, 2);
  const sqA = m.npcs.info(a[0]!)!.squad;
  const sqB = m.npcs.info(b[0]!)!.squad;
  assert.ok(!(sqA.alertUntil > m.clock) && !(sqB.alertUntil > m.clock), "calm");
  // a[1] is hit from far beyond its sight: it takes cover, its squadmates search.
  damagePlayer(m, a[1]!, 5, human, "pistol", a[1]!.pub.x, a[1]!.pub.y);
  run(m, NPC.THINK_MS + SERVER_TICK_MS);
  assert.ok(sqA.alertUntil > m.clock, "squad A alerted");
  assert.equal(brain(m, a[1]!).state, "cover", "the hit member breaks line of sight");
  for (const n of [a[0]!, a[2]!]) assert.ok(["search", "combat"].includes(brain(m, n).state), `squadmate ${n.id}: ${brain(m, n).state}`);
  assert.ok(!(sqB.alertUntil > m.clock), "squad B never hears of it");
  for (const n of b) assert.equal(brain(m, n).state, "idle");
  // In a squad of 2+, the first living member keeps the post while the others search.
  run(m, 4000);
  const holder = a[0]!;
  const hi = m.npcs.info(holder)!;
  assert.ok(Math.hypot(holder.pub.x - hi.anchor.x, holder.pub.y - hi.anchor.y) < 120, "the first member holds the post");
});

test("dormancy: beyond NPC.WAKE_PX a squad does not think, move or see; a human coming close wakes it", () => {
  const { m, human, npcs } = arena([testPost(0, 4300, 4300, { size: [2, 2] })]);
  human.pub.x = 400;
  human.pub.y = 400;
  run(m, 600);
  const b = brain(m, npcs[0]!);
  assert.ok(npcs.every((n) => n.dormant), "asleep");
  const s0 = b.samples;
  const t0 = b.thinks;
  run(m, 3000);
  assert.equal(b.samples, s0, "no inputs while dormant");
  assert.equal(b.thinks, t0, "no thinking while dormant");
  assert.deepEqual(m.vision.row(npcs[0]!.rosterIndex), [], "no vision row");
  human.pub.x = 1800;
  human.pub.y = 1800;
  run(m, 400);
  assert.ok(npcs.every((n) => !n.dormant), "awake");
  run(m, 1000);
  assert.ok(b.samples > s0 && b.thinks > t0);
  // Far from humans (≥ LOD_PX) an awake NPC decides at the LOD rate.
  assert.ok(Math.hypot(human.pub.x - npcs[0]!.pub.x, human.pub.y - npcs[0]!.pub.y) > NPC.LOD_PX);
  run(m, 3000);
  assert.ok(b.lod, "LOD while nothing is going on");
});

test("an NPC never opens a container, picks up an item or extracts (200 seeds, in a fight next to all three)", () => {
  let fights = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const post = testPost(0, 1500 + (seed % 7) * 20, 1500, { tier: (1 + (seed % 3)) as 1 | 2 | 3, size: [1, 3] });
    const { m, h, human, npcs } = arena([post], { containers: [{ x: post.x + 60, y: post.y + 40, kind: "crate", tier: 3, zone: null }] }, seed);
    m.rng = mulberry32(seed);
    // Ammo / meds on the ground at the post (auto-pickup range) and an open extract right on it.
    spawnGroundItem(m, makeItem("ammo_light", { qty: 30 }), post.x, post.y + 10);
    spawnGroundItem(m, makeItem("medkit", { qty: 1 }), post.x + 20, post.y);
    addExtract(m, post.x, post.y, 0, 0, 200);
    skipPeace(m, 0);
    human.pub.x = post.x;
    human.pub.y = post.y + 450;
    human.pub.hp = 1e6;
    const ev = run(m, 8000, { [h]: { aim: -Math.PI / 2, fire: seed % 2 === 0 } });
    if (shotsOf(ev, npcs).length > 0) fights++;
    assert.equal(m.containers.stateOf(0), CONTAINER_STATE.UNTOUCHED, `seed ${seed}: container untouched`);
    assert.equal(ev.filter((e) => e.type === "chest").length, 0);
    assert.equal(m.state.items.size, 2, `seed ${seed}: ground items untouched`);
    for (const n of npcs) {
      assert.equal(n.self.extractStartedAt, 0, `seed ${seed}: no extract channel`);
      assert.equal(n.exitReport, null, `seed ${seed}: still on the map`);
      assert.equal(n.search, null);
    }
  }
  assert.ok(fights > 100, `the NPCs fought in ${fights}/200 seeds`);
});

test("T13 peace per human (WORLD v6): a human entering at minute 20 next to a squad is not shot for 30 s, then is", () => {
  const { m, wall } = worldMatch({ map: testMap(), envSeed: 2, ...npcOpts([testPost(0, 1500, 1500)]) });
  const npc = npcsOf(m)[0]!;
  jump(m, wall, 20 * 60_000);
  assert.equal(m.clock, wall.t - WORLD_T0);
  const h = enter(m, "late");
  // Outside the low leash (500) and beyond NPC.PEACE_CLOSE_PX, inside sight and pistol range.
  h.pub.x = h.prevX = 1500;
  h.pub.y = h.prevY = 2160;
  h.pub.hp = 1e6;
  brain(m, npc).tune({ aim: Math.PI / 2, rollChance: 0 });
  const calm = advance(m, wall, NPC.PEACE_MS - 1000);
  assert.ok(m.vision.sees(npc.rosterIndex, h.rosterIndex), "it sees the human");
  assert.equal(shotsOf(calm, [npc]).length, 0, "no fire inside the entrant's own peace window");
  const ev = advance(m, wall, 6000);
  assert.ok(m.clock - h.enteredAtMs > NPC.PEACE_MS);
  assert.ok(shotsOf(ev, [npc]).length > 0, "fired at once the window is over");
});
