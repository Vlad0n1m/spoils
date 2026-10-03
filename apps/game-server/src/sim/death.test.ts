import { test } from "node:test";
import assert from "node:assert/strict";
import { ITEM_FLAG, NPC_ROLE, SEARCH, dogTagCr, mulberry32 } from "@extract/shared";
import { takeAll } from "./containers.js";
import { deathSplit, killPlayer } from "./death.js";
import { DISCLOSE } from "./disclosure.js";
import { extractPlayer } from "./extraction.js";
import { makeItem, withNpcSettlement } from "./items.js";
import { carriedItems } from "./bag.js";
import { damagePlayer } from "./combat.js";
import { Match } from "./match.js";
import type { PlayerRuntime } from "./types.js";
import { advance, clearDef, counterUid, enter, giveItem, giveStack, giveWeapon, ids, jump, npcOpts, npcsOf, pl, place, rtOf, run, send, testMap, testMatch, testPost, worldMatch } from "./test-utils.js";

/** Kill outright (no armor absorb, so durabilities stay as given). */
function kill(m: Match, id: string, by: string | null = null) {
  killPlayer(m, rtOf(m, id), by ? rtOf(m, by) : null, "rifle");
  assert.equal(pl(m, id).alive, false);
}

test("a human dies: a searchable corpse (no ground items), broken uniques reported lost, a dog tag inside", () => {
  const m = testMatch(2);
  const [a, b] = ids(m);
  place(m, a!, 1500, 1500);
  place(m, b!, 1560, 1500);
  pl(m, b!).aim = 1.25;
  const victim = rtOf(m, b!);
  victim.level = 7;
  const rifle = giveWeapon(m, b!, "w2", "rifle", 2, 17);
  const vest = giveItem(m, b!, "armor_2", "armor", { dur: 60 });
  const pack = giveItem(m, b!, "backpack_1", "bp");
  giveStack(m, b!, "junk_gpu", 1);
  giveStack(m, b!, "medkit", 2);
  // Break rolls: rifle breaks, vest survives, backpack breaks (one draw per unique, slot order).
  const rolls = [0.2, 0.9, 0.1];
  m.rng = () => rolls.shift() ?? 0.99;
  kill(m, b!, a!);

  assert.equal(m.state.items.size, 0, "nothing explodes on the floor");
  const c = m.state.corpses.get(String(victim.rosterIndex))!;
  assert.ok(c);
  assert.deepEqual([c.x, c.y, c.label, c.color, c.opened, c.empty], [1560, 1500, "P1", pl(m, b!).color, false, false]);
  assert.ok(Math.abs(c.rot - 1.25) < 1e-6);
  const t = m.containers.corpseOf(victim.rosterIndex)!;
  assert.equal(t.key, `k${c.id}`);
  const inside = m.containers.remaining(t);
  assert.deepEqual(inside.map((i) => i.def), ["armor_2", "junk_gpu", "medkit", "junk_dogtag"],
    "fixed order; FREE kit gone; broken rifle and pack not inside");
  assert.equal(inside.find((i) => i.def === "armor_2")!.dur, 60, "survivors keep durability");
  const tag = inside.find((i) => i.def === "junk_dogtag")!;
  assert.deepEqual([tag.label, tag.lvl, tag.ref], ["P1", 7, victim.selfKey]);

  const rep = victim.exitReport!;
  assert.deepEqual(rep.lost.map((i) => i.uid).sort(), [rifle, pack].sort());
  assert.equal(m.ledger.resolved.get(rifle), "lost");
  assert.equal(m.ledger.resolved.has(vest), false, "the vest is still on the map");
  assert.deepEqual(victim.dropped.map((i) => i.uid), [vest]);
  assert.ok(victim.dropped.every((i) => !(i.flags & ITEM_FLAG.BROKEN)));
  assert.ok(inside.every((i) => !(i.flags & ITEM_FLAG.BROKEN)));
});

test("another player searches the corpse, carries the dog tag out, and the report names the victim", () => {
  const m = testMatch(3);
  const [a, b, c] = ids(m);
  place(m, a!, 1500, 1500);
  place(m, b!, 1560, 1500);
  place(m, c!, 3000, 2000);
  rtOf(m, b!).level = 3;
  const vest = giveItem(m, b!, "armor_3", "armor");
  m.rng = () => 0.99;
  kill(m, b!, a!);
  const victimUser = rtOf(m, b!).userId;

  assert.ok(m.interact(a!), "F on the body");
  const rt = rtOf(m, a!);
  assert.equal(rt.self.searching, `k${rtOf(m, b!).rosterIndex}`);
  assert.equal(rt.search!.readyAt, m.clock + SEARCH.OPEN_MS.corpse);
  const body = m.state.corpses.get(String(rtOf(m, b!).rosterIndex))!;
  assert.equal(body.opened, false, "public once the searcher left (disclosure.ts)");
  assert.equal(takeAll(m, rt).code, "not_ready");
  run(m, 6_000);
  const r = takeAll(m, rt);
  assert.equal(r.code, null);
  assert.ok(r.taken >= 2);
  const s = rt.self.slots;
  assert.equal(s.get("armor")!.uid, vest, "vest equipped from the body");
  assert.ok([...s.values()].some((i) => i.def === "junk_dogtag"));
  assert.equal(m.containers.corpseOf(rtOf(m, b!).rosterIndex)!.emptied, true);
  assert.equal(body.empty, false);
  assert.equal(rt.stats.corpsesSearched, 1);

  extractPlayer(m, rt);
  run(m, DISCLOSE.QUIET_MS + 100);
  assert.deepEqual([body.opened, body.empty], [true, true], "published once the searcher was gone");
  const rep = rt.exitReport!;
  const tag = rep.extracted.find((i) => i.def === "junk_dogtag")!;
  assert.deepEqual([tag.label, tag.lvl, tag.victim], ["P1", 3, victimUser]);
  assert.equal(tag.by, rt.userId, "D22: the killer is named on the tag (full price for them only)");
  assert.ok(rep.extracted.some((i) => i.uid === vest));
  assert.equal(m.ledger.resolved.get(vest), "extract");
  const out = rt.outcome!;
  assert.ok(out.sold.some((l) => l.def === "junk_dogtag" && l.cr === dogTagCr(3) && l.label === "P1"));
  assert.equal(out.credits, out.sold.reduce((x, l) => x + l.cr, 0));
});

test("NPCs leave no dog tag: a marauder corpse holds its non-FREE bag only (FREE gear vanishes); an empty body becomes `empty` once searched", () => {
  const m = new Match({
    roster: [{ userId: "u0", nickname: "H" }],
    rng: mulberry32(1), map: testMap(), newUid: counterUid, now: () => 0, emptyWorld: true, strictLedger: true,
    npcBrains: false, envSeed: 1, weatherOverride: "clear", mapSeed: 77,
    ...npcOpts([testPost(0, 1550, 1500), testPost(1, 2550, 1500)]),
  });
  const [h] = ids(m);
  const [bagged, empty] = npcsOf(m);
  place(m, h!, 1500, 1500);
  // The first carries a known bag (on top of whatever rollNpcLoot gave it); the second carries nothing non-FREE.
  giveStack(m, bagged!.id, "junk_bolts", 1);
  const bag = carriedItems(bagged!).map((c) => c.item).filter((it) => !(it.flags & ITEM_FLAG.FREE));
  assert.ok(carriedItems(bagged!).some((c) => c.item.flags & ITEM_FLAG.FREE), "its gear is FREE");
  for (const c of carriedItems(empty!)) if (!(c.item.flags & ITEM_FLAG.FREE)) empty!.self.slots.delete(c.key);
  kill(m, bagged!.id, h!);
  const t0 = m.containers.corpseOf(bagged!.rosterIndex)!;
  assert.deepEqual(t0.items.map((i) => `${i.def}x${i.qty}`).sort(), bag.map((i) => `${i.def}x${i.qty}`).sort(), "the bag, nothing FREE");
  assert.ok(t0.items.every((i) => !(i.flags & ITEM_FLAG.FREE) && i.def !== "junk_dogtag"));
  // Kill credit: a marauder is an NPC kill (XP_NPC), never a player kill (XP_KILL).
  assert.equal(rtOf(m, h!).self.kills, 0);
  assert.equal(rtOf(m, h!).stats.npcKills, 1);
  kill(m, empty!.id);
  const t = m.containers.corpseOf(empty!.rosterIndex)!;
  assert.equal(t.items.length, 0, "FREE kit only: nothing inside, no dog tag");
  place(m, h!, 2500, 1500);
  assert.ok(m.interact(h!));
  run(m, SEARCH.OPEN_MS.corpse + 50);
  assert.equal(t.emptied, true);
  // An empty body is no longer offered by F.
  assert.equal(m.containers.nearestOpenable(rtOf(m, h!)), -1);
});

test("match end: uniques still in corpses and opened containers are left on the map, broken ones never", () => {
  const m = testMatch(2, { map: testMap({ containers: [{ x: 2000, y: 2000, kind: "crate", tier: 1, zone: null }] }) });
  m.containers.roll = () => {
    const it = makeItem("shotgun", { uid: m.newUid() });
    m.ledger.register(it, "minted");
    return [it, makeItem("junk_apple", { qty: 3 })];
  };
  const [a, b] = ids(m);
  place(m, a!, 1960, 2000);
  assert.ok(m.interact(a!));
  run(m, 300);
  const kept = giveWeapon(m, b!, "w2", "sniper");
  const broke = giveItem(m, b!, "armor_1", "armor");
  const rolls = [0.9, 0.1];
  m.rng = () => rolls.shift() ?? 0.5;
  kill(m, b!);
  kill(m, a!);
  m.step(50);
  assert.ok(m.ended);
  const left = m.report!.leftOnMap.map((i) => i.uid).sort();
  const shotgun = m.containers.targets.get("c0")!.initial[0]!.uid;
  const aCorpse = m.containers.corpseOf(rtOf(m, a!).rosterIndex)!;
  const aUniques = m.containers.remaining(aCorpse).filter((i) => i.uid).map((i) => i.uid);
  assert.deepEqual(left, [kept, shotgun, ...aUniques].sort());
  assert.ok(!left.includes(broke));
  assert.deepEqual(m.ledgerGaps(), []);
});

test("the break roll is BREAK_CHANCE_ON_DEATH per unique; fungibles never break; FREE vanishes", () => {
  const rng = mulberry32(2024);
  let broken = 0;
  let n = 0;
  for (let i = 0; i < 2000; i++) {
    const r = deathSplit(
      [
        makeItem("rifle", { uid: `r${i}` }),
        makeItem("pistol", { flags: ITEM_FLAG.FREE }),
        makeItem("ammo_light", { qty: 30 }),
        makeItem("junk_gpu"),
      ],
      rng,
    );
    n++;
    broken += r.lost.length;
    assert.equal(r.lost.length + r.dropped.length, 1);
    assert.deepEqual(r.remains.filter((x) => !x.uid).map((x) => x.def), ["ammo_light", "junk_gpu"]);
    for (const l of r.lost) assert.equal(l.flags & ITEM_FLAG.BROKEN, ITEM_FLAG.BROKEN);
  }
  assert.ok(Math.abs(broken / n - 0.5) < 0.05, `break rate ${broken / n}`);
});

test("dead players cannot search; a body is searchable only within reach and sight", () => {
  const m = testMatch(2, { map: testMap({ walls: [{ x: 1600, y: 1300, w: 24, h: 400 }] }) });
  const [a, b] = ids(m);
  place(m, a!, 1560, 1500);
  place(m, b!, 1650, 1500);
  kill(m, b!);
  assert.equal(m.containers.nearestOpenable(rtOf(m, a!)), -1, "behind a wall");
  place(m, a!, 1650, 1730);
  assert.equal(m.containers.nearestOpenable(rtOf(m, a!)), -1, "out of reach");
  place(m, a!, 1680, 1560);
  assert.ok(m.containers.nearestOpenable(rtOf(m, a!)) >= 0);
  clearDef(m, a!, "bandage");
  kill(m, a!);
  assert.equal(m.interact(a!), false);
});

test("NPC pool uniques: never break, a living NPC's go leftOnMap at the end (never lost), a dead one's stay in the corpse; no botLost / botDestroyed", () => {
  const m = testMatch(1, { ...npcOpts([testPost(0, 1500, 1500), testPost(1, 2000, 2000), testPost(2, 2500, 2500)]), npcBrains: false });
  const [h] = ids(m);
  const [n0, n1, n2] = npcsOf(m) as [PlayerRuntime, PlayerRuntime, PlayerRuntime];
  place(m, h!, 1000, 1000);
  // Uniques NPCs carry (boss bags / carriers), registered like pool items.
  const onDead = giveWeapon(m, n0.id, "w2", "rifle", 1);
  const onLiving = giveWeapon(m, n1.id, "w2", "shotgun", 2);
  const hVest = giveItem(m, h!, "armor_1", "armor", { dur: 1 });
  // Every break roll would break: NPCs skip it.
  m.rng = () => 0;
  kill(m, n0.id, h!);
  assert.ok(m.containers.corpseOf(n0.rosterIndex)!.items.some((i) => i.uid === onDead), "the unique reached the corpse");
  damagePlayer(m, rtOf(m, h!), 30, null, "", 1000, 1000);
  assert.deepEqual(rtOf(m, h!).destroyed.map((i) => i.uid), [hVest]);
  kill(m, h!);
  assert.deepEqual(rtOf(m, h!).outcome!.destroyed!.map((i) => i.uid), [hVest], "OutcomeMsg.destroyed");
  m.step(50);
  assert.ok(m.ended, "NPCs never keep a match alive");
  const r = m.report!;
  assert.equal(r.botLost, undefined);
  assert.equal(r.botDestroyed, undefined);
  const left = r.leftOnMap.map((i) => i.uid);
  for (const u of [onDead, onLiving]) assert.ok(left.includes(u), `${u} left on map`);
  assert.equal(m.ledger.resolved.get(onLiving), "left", "a living NPC's unique is never lost");
  assert.deepEqual(r.participants.map((p) => p.userId), ["user0"], "participants are humans only");
  assert.deepEqual(r.npcSummary, { spawned: { boss: 0, guard: 0, marauder: 3 }, killedByHumans: { boss: 0, guard: 0, marauder: 1 } });
  // The settlement safety net adds nothing and never invents deprecated fields.
  assert.deepEqual(withNpcSettlement(r, m.allRuntimes()), r, "nothing left to settle");
  // Every tracked uid appears exactly once across the web-bound reports.
  const humanReports = m.exitReports.filter((x) => x.userId);
  const reported = [...humanReports.flatMap((x) => [...x.extracted, ...x.lost, ...x.destroyed]), ...r.leftOnMap].map((i) => i.uid).filter(Boolean);
  assert.deepEqual(reported.sort(), [...m.ledger.known.keys()].sort());
  assert.equal(n2.pub.role, NPC_ROLE.MARAUDER);
});

test("a kill by a bullet still in flight after its shooter died reaches the shooter's exit report (posted after the bullet)", () => {
  const m = testMatch(3, { envSeed: 2 });
  const [a, b, c] = ids(m);
  place(m, a!, 1000, 3000);
  place(m, b!, 1000, 2000);
  place(m, c!, 2400, 2000);
  pl(m, c!).hp = 5;
  giveWeapon(m, b!, "w2", "sniper", 0, 5);
  m.switchSlot(b!, "w2");
  m.step(50);
  m.drainEvents();
  send(m, b!, { aim: 0, fire: true });
  m.step(50);
  const B = rtOf(m, b!);
  assert.ok(m.bullets.some((x) => x.owner === B), "B's bullet is in flight");
  killPlayer(m, B, rtOf(m, a!), "rifle");
  const exits: Array<{ at: number; kills: number }> = [];
  const take = () => {
    for (const e of m.drainEvents()) if (e.type === "exit" && e.report.userId === B.userId) exits.push({ at: m.clock, kills: e.report.kills });
  };
  take();
  assert.equal(exits.length, 0, "held while the bullet flies");
  for (let k = 0; k < 40 && pl(m, c!).alive; k++) {
    m.step(50);
    take();
  }
  assert.equal(pl(m, c!).alive, false, "the in-flight bullet killed C");
  for (let k = 0; k < 40 && exits.length === 0; k++) {
    m.step(50);
    take();
  }
  assert.equal(exits.length, 1, "exactly one exit report");
  assert.equal(exits[0]!.kills, 1, "the posted report carries the late kill");
  assert.equal(B.outcome!.kills, 1);
});

test("T14 dog tag `by` (D22): a non-killer carrying the tag out still names the killer; no human killer → no `by`", () => {
  const m = testMatch(4);
  const [a, b, c, d] = ids(m);
  place(m, a!, 1500, 1500);
  place(m, b!, 1560, 1500);
  place(m, c!, 1500, 1560);
  place(m, d!, 1440, 1500);
  m.rng = () => 0.99;
  kill(m, b!, a!);
  assert.equal(rtOf(m, b!).killerUserId, rtOf(m, a!).userId);
  assert.deepEqual(rtOf(m, a!).victims, [rtOf(m, b!).userId]);
  const C = rtOf(m, c!);
  assert.ok(m.openSearch(c!, `k${rtOf(m, b!).rosterIndex}`));
  run(m, 6_000);
  assert.equal(takeAll(m, C).code, null);
  extractPlayer(m, C);
  const tag = C.exitReport!.extracted.find((i) => i.def === "junk_dogtag")!;
  assert.equal(tag.victim, rtOf(m, b!).userId);
  assert.equal(tag.by, rtOf(m, a!).userId, "the killer, not the extractor");
  // Died without a human killer: the tag names nobody.
  kill(m, d!);
  assert.equal(rtOf(m, d!).killerUserId, null);
});

test("T14 guests drop no dog tag (DOG_TAG.GUEST_TAG); world exit reports carry entryId, enteredAtMs and victims", () => {
  const { m, wall } = worldMatch();
  jump(m, wall, 1000);
  const k = enter(m, "killer");
  const g = enter(m, "guest-1", { guest: true, level: 0 });
  place(m, k.id, 1500, 1500);
  place(m, g.id, 1560, 1500);
  killPlayer(m, g, k, "rifle");
  const inside = m.containers.corpseOf(g.rosterIndex)!.items;
  assert.ok(!inside.some((i) => i.def === "junk_dogtag"), "no tag on a guest body");
  assert.equal(g.outcome!.guest, true);
  assert.equal(g.exitReport!.entryId, g.entryId);
  assert.equal(g.exitReport!.enteredAtMs, g.enteredAtMs);
  assert.deepEqual(g.exitReport!.victims, []);
  // A registered victim keeps the tag.
  const v = enter(m, "victim");
  place(m, v.id, 1500, 1560);
  killPlayer(m, v, k, "rifle");
  assert.ok(m.containers.corpseOf(v.rosterIndex)!.items.some((i) => i.def === "junk_dogtag"));
  assert.deepEqual(k.victims, ["guest-1", "victim"], "guests included (the web filters)");
});

test("T14 victims on the held-bullet path: a kill by a bullet in flight after its shooter died is in the shooter's posted exit report", () => {
  const { m, wall } = worldMatch({ envSeed: 2 });
  jump(m, wall, 1000);
  const A = enter(m, "ua");
  const B = enter(m, "ub");
  const C = enter(m, "uc");
  place(m, A.id, 1000, 3000);
  place(m, B.id, 1000, 2000);
  place(m, C.id, 2400, 2000);
  C.pub.hp = 5;
  giveWeapon(m, B.id, "w2", "sniper", 0, 5);
  m.switchSlot(B.id, "w2");
  advance(m, wall, 50);
  m.drainEvents();
  send(m, B.id, { aim: 0, fire: true });
  advance(m, wall, 50);
  assert.ok(m.bullets.some((x) => x.owner === B), "B's bullet is in flight");
  killPlayer(m, B, A, "rifle");
  const posted: string[][] = [];
  const take = (ev: ReturnType<typeof advance>) => {
    for (const e of ev) if (e.type === "exit" && e.report.entryId === B.entryId) posted.push(e.report.victims ?? []);
  };
  take(m.drainEvents().map((e) => ({ ...e, at: m.clock })));
  assert.equal(posted.length, 0, "held while the bullet flies");
  for (let k = 0; k < 80 && posted.length === 0; k++) take(advance(m, wall, 50));
  assert.equal(C.pub.alive, false, "the in-flight bullet killed C");
  assert.deepEqual(posted, [["uc"]], "the posted report lists the late victim");
  assert.equal(C.killerUserId, "ub");
});
