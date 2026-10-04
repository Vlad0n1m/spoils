import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONTAINER,
  CONTAINER_STATE,
  FLOOR_LOOT,
  ITEM_FLAG,
  SEARCH,
  containerOpenMs,
  countOf,
  generateMap,
  itemDef,
  mulberry32,
  revealMs,
  rollContainerFungibles,
  type ContainerSpot,
  type ItemLike,
} from "@extract/shared";
import { damagePlayer } from "./combat.js";
import { closeSearch, invTakeAllOp, invTakeOp, takeAll, takeFromLoot } from "./containers.js";
import { extractPlayer } from "./extraction.js";
import { makeItem } from "./items.js";
import { Match } from "./match.js";
import type { MatchEvent } from "./types.js";
import { advance, counterUid, enter, giveItem, giveStack, giveWeapon, humans, ids, jump, pl, place, rtOf, run, selfOf, testMap, testMatch, worldMatch, type Timed } from "./test-utils.js";
import { killPlayer } from "./death.js";

const CRATE: ContainerSpot = { x: 1100, y: 1500, kind: "crate", tier: 1, zone: null };
const OPEN_MS = containerOpenMs(CRATE);

/** A 2-player match with one crate whose contents are `items` (uniques get registered as minted). */
function crateMatch(items: () => ItemLike[], n = 2): Match {
  const m = testMatch(n, { map: testMap({ containers: [CRATE] }) });
  m.containers.roll = () => {
    const out = items();
    for (const it of out) if (it.uid) m.ledger.register(it, "minted");
    return out;
  };
  return m;
}

const contents = (m: Match) => () => [
  makeItem("rifle", { uid: m.newUid(), rarity: 1, mag: 7, dur: 80 }),
  makeItem("ammo_heavy", { qty: 20 }),
  makeItem("junk_gpu"),
];

const views = (ev: Timed[]) => ev.filter((e) => e.type === "view").map((e) => (e.type === "view" ? `${e.to}:${e.op}:${e.key}` : ""));
const errs = (m: Match) => m.drainEvents().flatMap((e) => (e.type === "invErr" ? [e.msg.code] : []));

test("open delay, then items reveal one by one; the loot entry reaches the view only once ready", () => {
  let m!: Match;
  m = crateMatch(() => contents(m)());
  const [a] = ids(m);
  place(m, a!, 1040, 1500);
  const rt = rtOf(m, a!);
  assert.ok(m.interact(a!));
  const ev0 = m.drainEvents();
  assert.ok(ev0.some((e) => e.type === "chest" && e.idx === 0), "lid event on first open");
  assert.equal(m.containers.stateOf(0), CONTAINER_STATE.OPENED);
  assert.equal(m.state.containerState[0], CONTAINER_STATE.UNTOUCHED, "public once the opener left (disclosure.ts)");
  assert.equal(selfOf(m, a!).searching, "c0");
  assert.equal(selfOf(m, a!).searchReadyAt, OPEN_MS);
  assert.ok(pl(m, a!).act & 16, "ACT.LOOT is public");
  const loot = m.state.loot.get("c0")!;
  assert.equal(loot.total, 3);
  assert.equal(loot.slots.size, 0, "nothing revealed before the delay");

  // Taking before the delay is refused; F again on the same target is a no-op.
  assert.equal(takeFromLoot(m, rt, { from: "loot", key: "0", uid: "", def: "rifle" }), "not_ready");
  assert.ok(m.interact(a!));
  assert.equal(rt.search!.readyAt, OPEN_MS);

  const early = run(m, OPEN_MS - 50);
  assert.deepEqual(views(early), []);
  const atReady = run(m, 50);
  assert.deepEqual(views(atReady), [`${rt.rosterIndex}:add:c0`]);
  assert.equal(loot.revealed, 0);
  const items = m.containers.targets.get("c0")!.items;
  const t0 = OPEN_MS + revealMs(items[0]!);
  const t1 = t0 + revealMs(items[1]!);
  const t2 = t1 + revealMs(items[2]!);
  assert.equal(loot.nextRevealAt, t0);
  run(m, t0 - m.clock - 50);
  assert.equal(loot.revealed, 0);
  assert.equal(takeFromLoot(m, rt, { from: "loot", key: "1", uid: "", def: "ammo_heavy" }), "not_revealed");
  run(m, 50);
  assert.equal(loot.revealed, 1);
  assert.equal(loot.slots.get("0")!.def, "rifle");
  assert.equal(loot.slots.get("0")!.mag, 7);
  run(m, t1 - m.clock);
  assert.equal(loot.revealed, 2);
  run(m, t2 - m.clock);
  assert.equal(loot.revealed, 3);
  assert.equal(loot.nextRevealAt, 0, "done");
  assert.deepEqual([...loot.slots.keys()].sort(), ["0", "1", "2"]);
});

test("searchers share one reveal; it pauses (keeping progress) when nobody is past the delay", () => {
  let m!: Match;
  m = crateMatch(() => contents(m)());
  const [a, b] = ids(m);
  place(m, a!, 1040, 1500);
  place(m, b!, 1160, 1500);
  assert.ok(m.interact(a!));
  run(m, OPEN_MS);
  const loot = m.state.loot.get("c0")!;
  const items = m.containers.targets.get("c0")!.items;
  run(m, revealMs(items[0]!));
  assert.equal(loot.revealed, 1);
  // B joins: B has its own open delay, the reveal goes no faster with two.
  assert.ok(m.interact(b!));
  assert.equal(rtOf(m, b!).search!.readyAt, m.clock + OPEN_MS);
  const next = loot.nextRevealAt;
  run(m, next - m.clock);
  assert.equal(loot.revealed, 2);
  // Both leave: paused, progress kept.
  m.searchClose(a!);
  m.searchClose(b!);
  run(m, 50);
  assert.equal(loot.nextRevealAt, 0);
  run(m, 5_000);
  assert.equal(loot.revealed, 2);
  // Re-open: the delay again, then the last item.
  const ev = run(m, 0);
  assert.deepEqual(views(ev), []);
  assert.ok(m.interact(b!));
  run(m, OPEN_MS + revealMs(items[2]!));
  assert.equal(loot.revealed, 3);
});

test("cancel rules: SEARCH_CLOSE, distance > CANCEL_RANGE, roll, fire, death, extract; moving within range is fine", () => {
  const scenarios: Array<[string, (m: Match, id: string) => void]> = [
    ["close", (m, id) => m.searchClose(id)],
    ["range", (m, id) => { place(m, id, CRATE.x - SEARCH.CANCEL_RANGE - 5, CRATE.y); run(m, 50); }],
    ["roll", (m, id) => { run(m, 100, { [id]: { roll: true, mx: -1 } }); }],
    ["fire", (m, id) => { run(m, 100, { [id]: { fire: true } }); }],
    ["death", (m, id) => { pl(m, id).hp = 1; damagePlayer(m, rtOf(m, id), 50, null, "", 0, 0); }],
    ["extract", (m, id) => extractPlayer(m, rtOf(m, id))],
  ];
  for (const [name, cancel] of scenarios) {
    let m!: Match;
    m = crateMatch(() => contents(m)());
    const [a] = ids(m);
    place(m, a!, 1040, 1500);
    assert.ok(m.interact(a!));
    run(m, OPEN_MS + 50);
    // Walking around inside the cancel range keeps the session.
    place(m, a!, CRATE.x, CRATE.y + SEARCH.CANCEL_RANGE - 10);
    run(m, 50);
    assert.equal(selfOf(m, a!).searching, "c0", `${name}: still searching`);
    const ev: MatchEvent[] = [];
    const emit = m.emit.bind(m);
    m.emit = (e) => { ev.push(e); emit(e); };
    cancel(m, a!);
    run(m, 50);
    const rt = rtOf(m, a!);
    assert.equal(rt.search, null, `${name}: session closed`);
    assert.equal(selfOf(m, a!).searching, "", name);
    assert.ok(ev.some((e) => e.type === "view" && e.op === "remove" && e.key === "c0"), `${name}: loot entry leaves the view`);
    assert.equal(m.containers.targets.get("c0")!.searchers.size, 0, name);
  }
});

test("take races: the first take wins, the second gets INV_ERR gone; stale clicks are refused", () => {
  let m!: Match;
  m = crateMatch(() => contents(m)());
  const [a, b] = ids(m);
  place(m, a!, 1040, 1500);
  place(m, b!, 1160, 1500);
  assert.ok(m.interact(a!));
  assert.ok(m.interact(b!));
  run(m, 4_000);
  const loot = m.state.loot.get("c0")!;
  assert.equal(loot.revealed, 3);
  const rifle = loot.slots.get("0")!;
  const uid = rifle.uid;
  m.drainEvents();
  assert.equal(invTakeOp(m, a!, { from: "loot", key: "0", uid, def: "rifle" }), null);
  assert.equal(invTakeOp(m, b!, { from: "loot", key: "0", uid, def: "rifle" }), "gone");
  assert.deepEqual(errs(m), ["gone"]);
  const sa = selfOf(m, a!).slots;
  assert.equal(sa.get("w2")!.uid, uid, "rifle into the empty weapon slot");
  assert.equal(sa.get("w2")!.mag, 7);
  assert.equal(sa.get("w2")!.dur, 80);
  assert.ok(!loot.slots.has("0"));
  // Wrong def / uid for a slot = stale click.
  assert.equal(invTakeOp(m, b!, { from: "loot", key: "2", uid: "", def: "junk_hdd" }), "gone");
  assert.equal(invTakeOp(m, b!, { from: "loot", key: "9", uid: "", def: "junk_gpu" }), "gone");
  // Not searching at all.
  m.searchClose(b!);
  assert.equal(invTakeOp(m, b!, { from: "loot", key: "2", uid: "", def: "junk_gpu" }), "not_searching");
});

test("partial stacks: qty splits keep the total; a full inventory takes what fits and reports full", () => {
  const m = crateMatch(() => [makeItem("ammo_heavy", { qty: 20 }), makeItem("junk_bolts", { qty: 5 }), makeItem("junk_coldwallet")]);
  const [a] = ids(m);
  place(m, a!, 1040, 1500);
  assert.ok(m.interact(a!));
  run(m, 5_000);
  const rt = rtOf(m, a!);
  const loot = m.state.loot.get("c0")!;
  assert.equal(takeFromLoot(m, rt, { from: "loot", key: "0", uid: "", def: "ammo_heavy", qty: 7 }), null);
  assert.equal(loot.slots.get("0")!.qty, 13);
  assert.equal(countOf(rt.self.slots, "ammo_heavy"), 7);
  assert.equal(takeFromLoot(m, rt, { from: "loot", key: "0", uid: "", def: "ammo_heavy", qty: 14 }), "bad_slot");

  // Fill storage except one pocket that already holds 15 heavy rounds (room for 5 more).
  const s = rt.self.slots;
  for (const k of ["p0", "p1", "p2", "p3"]) s.delete(k);
  giveItem(m, a!, "ammo_heavy", "p0", { qty: 15 });
  giveItem(m, a!, "junk_gpu", "p1");
  giveItem(m, a!, "junk_gpu", "p2");
  giveItem(m, a!, "junk_gpu", "p3");
  const r = takeAll(m, rt);
  assert.equal(r.code, "full");
  assert.equal(r.taken, 1, "only the heavy rounds fit (5 of 13)");
  assert.equal(s.get("p0")!.qty, 20);
  assert.equal(loot.slots.get("0")!.qty, 8);
  assert.equal(loot.slots.get("1")!.qty, 5);
  assert.ok(loot.slots.get("2"));
  assert.equal(m.containers.stateOf(0), CONTAINER_STATE.OPENED);

  // Room again: take-all empties the crate → EMPTIED for everyone.
  s.delete("p1");
  s.delete("p2");
  s.delete("p3");
  m.drainEvents();
  assert.equal(invTakeAllOp(m, a!), null);
  assert.equal(loot.slots.size, 0);
  assert.equal(m.containers.stateOf(0), CONTAINER_STATE.EMPTIED);
  assert.equal(countOf(s, "ammo_heavy"), 28, "15 given + 5 + the last 8");
  assert.equal(countOf(s, "junk_bolts"), 5);
  assert.equal(countOf(s, "junk_coldwallet"), 1);
  // An emptied container is not offered by F any more.
  assert.equal(m.containers.nearestOpenable(rt), -1);
});

test("targeted take onto an occupied slot: the displaced item is auto-placed, or dropped at the feet", () => {
  let m!: Match;
  m = crateMatch(() => [makeItem("sniper", { uid: m.newUid(), rarity: 2 }), makeItem("armor_2", { uid: m.newUid() })]);
  const [a] = ids(m);
  place(m, a!, 1040, 1500);
  const rt = rtOf(m, a!);
  const s = rt.self.slots;
  const rifle = giveWeapon(m, a!, "w1", "rifle", 1);
  giveWeapon(m, a!, "w2", "shotgun");
  assert.ok(m.interact(a!));
  run(m, 5_000);
  const loot = m.state.loot.get("c0")!;
  const sniper = loot.slots.get("0")!;
  // Start a reload on w1 (the active slot): replacing that weapon cancels it.
  s.get("w1")!.mag = 0;
  m.reload(a!);
  assert.ok(rt.self.reloadUntil > 0);
  assert.equal(takeFromLoot(m, rt, { from: "loot", key: "0", uid: sniper.uid, def: "sniper", to: "w1" }), null);
  assert.equal(s.get("w1")!.def, "sniper");
  assert.equal(rt.self.reloadUntil, 0, "reload of the replaced weapon cancelled");
  assert.equal(pl(m, a!).weapon, "sniper");
  const stored = [...s.entries()].find(([, it]) => it.uid === rifle);
  assert.ok(stored && /^p\d$/.test(stored[0]), "old rifle went to a pocket");

  // Storage full: the displaced vest lands on the ground next to the player.
  giveItem(m, a!, "armor_1", "armor");
  const vest1 = s.get("armor")!.uid;
  for (const k of ["p0", "p1", "p2", "p3"]) if (!s.get(k)) giveItem(m, a!, "junk_gpu", k as "p0");
  const armor = loot.slots.get("1")!;
  assert.equal(takeFromLoot(m, rt, { from: "loot", key: "1", uid: armor.uid, def: "armor_2" }), "full", "auto-place: no room");
  assert.equal(takeFromLoot(m, rt, { from: "loot", key: "1", uid: armor.uid, def: "armor_2", to: "armor" }), null);
  assert.equal(s.get("armor")!.def, "armor_2");
  assert.equal(pl(m, a!).armor, 2);
  const onGround = [...m.ground.all()].map((g) => g.item);
  assert.deepEqual(onGround.map((i) => i.uid), [vest1]);
});

test("INV_* ops are rate limited per player (token bucket)", () => {
  let m!: Match;
  m = crateMatch(() => contents(m)());
  const [a] = ids(m);
  place(m, a!, 1040, 1500);
  assert.ok(m.interact(a!));
  run(m, 5_000);
  m.drainEvents();
  let rate = 0;
  for (let i = 0; i < SEARCH.OPS_BURST + 10; i++) {
    if (invTakeOp(m, a!, { from: "loot", key: "9", uid: "", def: "x" }) === "rate") rate++;
  }
  assert.ok(rate >= 9, `rate limited ${rate}`);
  run(m, 2_000);
  assert.notEqual(invTakeOp(m, a!, { from: "loot", key: "9", uid: "", def: "x" }), "rate");
});

test("FREE items displaced by a take vanish; broken items can never be taken", () => {
  let m!: Match;
  m = crateMatch(() => [makeItem("rifle", { uid: m.newUid() }), makeItem("ammo_light", { qty: 5, flags: ITEM_FLAG.BROKEN })]);
  const [a] = ids(m);
  place(m, a!, 1040, 1500);
  const rt = rtOf(m, a!);
  const s = rt.self.slots;
  giveWeapon(m, a!, "w2", "shotgun");
  assert.equal(s.get("w1")!.flags & ITEM_FLAG.FREE, ITEM_FLAG.FREE);
  assert.ok(m.interact(a!));
  run(m, 5_000);
  const loot = m.state.loot.get("c0")!;
  const r = loot.slots.get("0")!;
  assert.equal(takeFromLoot(m, rt, { from: "loot", key: "0", uid: r.uid, def: "rifle", to: "w1" }), null);
  assert.equal(s.get("w1")!.def, "rifle");
  assert.equal([...s.values()].filter((i) => i.def === "pistol").length, 0, "FREE pistol vanished");
  assert.equal(m.ground.byId.size, 0);
  assert.equal(takeFromLoot(m, rt, { from: "loot", key: "1", uid: "", def: "ammo_light" }), "broken");
  assert.equal(takeAll(m, rt).taken, 0);
});

test("a search survives taking damage; closing twice is harmless", () => {
  let m!: Match;
  m = crateMatch(() => contents(m)());
  const [a] = ids(m);
  place(m, a!, 1040, 1500);
  assert.ok(m.interact(a!));
  damagePlayer(m, rtOf(m, a!), 10, null, "", 0, 0);
  run(m, 100);
  assert.equal(selfOf(m, a!).searching, "c0");
  closeSearch(m, rtOf(m, a!), "close");
  closeSearch(m, rtOf(m, a!), "close");
  assert.equal(selfOf(m, a!).searching, "");
  assert.equal(giveStack(m, a!, "bandage", 1), 1);
});

// ---------------------------------------------------------------- loot economy v4 zoning

test("v4 zoning: demo uniques only in containers of tier >= DEMO_UNIQUE_MIN_TIER; fungibles stay the deterministic roll", () => {
  const map = generateMap("steppe");
  const m = new Match({ roster: humans(1), rng: mulberry32(1), mapSeed: 1234, mapId: "steppe", newUid: counterUid, npcBrains: false, emptyWorld: true, mode: "demo" });
  const byTier = [0, 0, 0, 0, 0];
  map.containers.forEach((spot, idx) => {
    const items = m.containers.roll(idx);
    const uniques = items.filter((i) => i.uid);
    if (spot.tier < CONTAINER.DEMO_UNIQUE_MIN_TIER) assert.equal(uniques.length, 0, `T${spot.tier} container ${idx} minted ${uniques.map((u) => u.def)}`);
    byTier[spot.tier] += uniques.length;
    const fung = items.filter((i) => !i.uid).map((i) => [i.def, i.qty]);
    assert.deepEqual(fung.slice(fung.length - rollContainerFungibles(1234, idx, spot).length), rollContainerFungibles(1234, idx, spot).map((f) => [f.def, f.qty]));
  });
  assert.ok(byTier[3]! + byTier[4]! > 0, `T3/T4 still mint in demo: ${byTier}`);
  for (const it of m.ledger.minted) assert.ok(itemDef(it.def)?.unique);
});

test("v4 zoning: floor loot spawns by spot tier (FLOOR_LOOT.SPAWN_CHANCE), medkits only on T3/T4 spots; the zoneless legacy map keeps v1", () => {
  const map = generateMap("steppe");
  const spots = [0, 0, 0, 0, 0];
  for (const s of map.lootSpots) spots[s.tier]!++;
  const items = [0, 0, 0, 0, 0];
  const seeds = 12;
  for (let seed = 1; seed <= seeds; seed++) {
    const m = new Match({ roster: humans(1), rng: mulberry32(seed), mapSeed: seed, mapId: "steppe", newUid: counterUid, npcBrains: false, mode: "live", bosses: false });
    const tierAt = new Map(map.lootSpots.map((s) => [`${s.x},${s.y}`, s.tier]));
    for (const g of m.ground.all()) {
      const t = tierAt.get(`${g.schema.x},${g.schema.y}`);
      assert.ok(t !== undefined, "floor items sit on loot spots");
      items[t]!++;
      if (g.item.def === "medkit") assert.ok(t >= 3, `medkit on a T${t} spot`);
      if (g.item.def === "ammo_heavy") assert.ok(t >= 2, `heavy ammo on a T${t} spot`);
      assert.equal(g.item.uid, "", "live floor loot never holds a unique");
    }
  }
  for (let t = 0; t <= 4; t++) {
    if (spots[t]! < 10) continue;
    const rate = items[t]! / (spots[t]! * seeds);
    const want = FLOOR_LOOT.SPAWN_CHANCE[t]!;
    assert.ok(Math.abs(rate - want) < Math.max(0.03, want * 0.3), `T${t}: ${rate.toFixed(3)} vs ${want}`);
  }
  // Wilds: almost nothing (≈ 5 % of spots).
  assert.ok(items[0]! / seeds < spots[0]! * 0.1, `wild floor items ${items[0]! / seeds}/${spots[0]}`);
  // Legacy (no zones): every spot spawns as in v1.
  const legacy = new Match({ roster: humans(1), rng: mulberry32(3), mapSeed: 3, mapId: "legacy", newUid: counterUid, npcBrains: false, mode: "live" });
  assert.equal([...legacy.ground.all()].length, legacy.map.lootSpots.length);
});

test("T14 own-corpse lock (WORLD v6 D11): a user cannot search the body of their own earlier entry (own_body); someone else can", () => {
  const { m, wall } = worldMatch();
  jump(m, wall, 1000);
  const a1 = enter(m, "ua");
  place(m, a1.id, 1500, 1500);
  killPlayer(m, a1, null, "rifle");
  const a2 = enter(m, "ua");
  const b = enter(m, "ub");
  place(m, a2.id, 1540, 1500);
  place(m, b.id, 1500, 1540);
  const key = `k${a1.rosterIndex}`;
  m.drainEvents();
  assert.equal(m.containers.nearestOpenable(a2), -1, "F skips the own body");
  assert.equal(m.interact(a2.id), false);
  assert.equal(m.openSearch(a2.id, key), false);
  const errs = m.drainEvents().filter((e): e is Extract<MatchEvent, { type: "invErr" }> => e.type === "invErr" && e.to === a2.rosterIndex);
  assert.deepEqual(errs.map((e) => e.msg.code), ["own_body", "own_body"]);
  assert.equal(a2.search, null);
  assert.ok(m.openSearch(b.id, key), "another user may search it");
  // Legacy roster matches: one runtime per user, the lock never triggers.
  const lm = testMatch(2);
  const [x, y] = ids(lm);
  place(lm, x!, 1500, 1500);
  place(lm, y!, 1540, 1500);
  killPlayer(lm, rtOf(lm, x!), null, "rifle");
  assert.ok(lm.openSearch(y!, `k${rtOf(lm, x!).rosterIndex}`));
});

test("containersSearched (XP containers line): counts after the open delay, once per user per container; an F tap cancelled at once and a re-entry count nothing", () => {
  const spots: ContainerSpot[] = Array.from({ length: 6 }, (_, i) => ({ x: 1000 + i * 120, y: 1500, kind: "crate" as const, tier: 0, zone: null }));
  const { m, wall } = worldMatch({ map: testMap({ containers: spots }) });
  jump(m, wall, 60_000);
  const openOne = (rt: ReturnType<typeof enter>, i: number, hold: boolean) => {
    const c = spots[i]!;
    place(m, rt.id, c.x, c.y + 30);
    assert.ok(m.containers.openKey(rt, `c${i}`), `opened c${i}`);
    if (hold) advance(m, wall, containerOpenMs(c) + 100);
    closeSearch(m, rt, hold ? "switch" : "roll");
  };
  const a = enter(m, "ua");
  for (let i = 0; i < spots.length; i++) openOne(a, i, false);
  assert.equal(a.stats.containersSearched, 0, "F taps cancelled before the open delay are no search");
  for (let i = 0; i < 3; i++) openOne(a, i, true);
  openOne(a, 0, true);
  assert.equal(a.stats.containersSearched, 3, "each container once");
  extractPlayer(m, a);
  // The same user's next entry: the three already searched count nothing, the others do.
  const a2 = enter(m, "ua");
  for (let i = 0; i < spots.length; i++) openOne(a2, i, true);
  assert.equal(a2.stats.containersSearched, 3);
  // Another user counts every container they search.
  const b = enter(m, "ub");
  for (let i = 0; i < spots.length; i++) openOne(b, i, true);
  assert.equal(b.stats.containersSearched, spots.length);
});
