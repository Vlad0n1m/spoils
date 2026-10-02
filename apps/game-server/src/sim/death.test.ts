import { test } from "node:test";
import assert from "node:assert/strict";
import { ITEM_FLAG, SEARCH, dogTagCr, mulberry32 } from "@extract/shared";
import { takeAll } from "./containers.js";
import { deathSplit, killPlayer } from "./death.js";
import { extractPlayer } from "./extraction.js";
import { makeItem } from "./items.js";
import { Match } from "./match.js";
import { clearDef, counterUid, giveItem, giveStack, giveWeapon, ids, pl, place, rtOf, run, testMap, testMatch } from "./test-utils.js";

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
  assert.equal(m.state.corpses.get(String(rtOf(m, b!).rosterIndex))!.opened, true);
  assert.equal(takeAll(m, rt).code, "not_ready");
  run(m, 6_000);
  const r = takeAll(m, rt);
  assert.equal(r.code, null);
  assert.ok(r.taken >= 2);
  const s = rt.self.slots;
  assert.equal(s.get("armor")!.uid, vest, "vest equipped from the body");
  assert.ok([...s.values()].some((i) => i.def === "junk_dogtag"));
  assert.equal(m.state.corpses.get(String(rtOf(m, b!).rosterIndex))!.empty, true);
  assert.equal(rt.stats.corpsesSearched, 1);

  extractPlayer(m, rt);
  const rep = rt.exitReport!;
  const tag = rep.extracted.find((i) => i.def === "junk_dogtag")!;
  assert.deepEqual([tag.label, tag.lvl, tag.victim], ["P1", 3, victimUser]);
  assert.ok(rep.extracted.some((i) => i.uid === vest));
  assert.equal(m.ledger.resolved.get(vest), "extract");
  const out = rt.outcome!;
  assert.ok(out.sold.some((l) => l.def === "junk_dogtag" && l.cr === dogTagCr(3) && l.label === "P1"));
  assert.equal(out.credits, out.sold.reduce((x, l) => x + l.cr, 0));
});

test("bots leave no dog tag; an empty body becomes `empty` once searched", () => {
  const m = new Match({
    roster: [{ userId: "u0", nickname: "H", isBot: false }, { userId: null, nickname: "Bot", isBot: true }],
    rng: mulberry32(1), map: testMap(), newUid: counterUid, now: () => 0, emptyWorld: true, strictLedger: true,
    botBrains: false, envSeed: 1, weatherOverride: "clear",
  });
  const [h, bot] = ids(m);
  place(m, h!, 1500, 1500);
  place(m, bot!, 1550, 1500);
  kill(m, bot!);
  const t = m.containers.corpseOf(rtOf(m, bot!).rosterIndex)!;
  assert.equal(t.items.length, 0, "FREE kit only: nothing inside, no dog tag");
  assert.ok(m.interact(h!));
  run(m, SEARCH.OPEN_MS.corpse + 50);
  assert.equal(t.corpse!.empty, true);
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
