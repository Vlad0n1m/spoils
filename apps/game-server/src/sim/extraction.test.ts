import { test } from "node:test";
import assert from "node:assert/strict";
import { Chest, MATCH } from "@extract/shared";
import { damagePlayer } from "./combat.js";
import { newArmorDrop, newWeaponDrop, spawnGroundItem } from "./inventory.js";
import { addExtract, giveWeapon, ids, pl, place, run, testMatch } from "./test-utils.js";

const CH = MATCH.EXTRACT_CHANNEL_MS;

test("standing in an open extract for the channel time extracts with all valuables", () => {
  const m = testMatch(2);
  const [a] = ids(m);
  const e = addExtract(m, 1500, 1500);
  place(m, a!, 1500, 1500);
  const uid = giveWeapon(m, a!, 1, "rifle", 3);
  const p = pl(m, a!);
  p.armor = 2;
  p.armorDur = 40;
  p.armorUid = "arm";

  run(m, 100);
  assert.equal(p.extractId, e.id);
  const startedAt = p.extractStartedAt;
  assert.ok(startedAt > 0);
  run(m, CH - 200);
  assert.equal(p.alive, true);
  const ev = run(m, 200);
  assert.equal(p.alive, false);
  assert.ok(p.extractedAt > 0);
  assert.equal(p.extractedAt - startedAt, CH);

  const out = ev.find((x) => x.type === "outcome");
  assert.ok(out && out.type === "outcome");
  assert.equal(out.msg.exit, "extract");
  assert.deepEqual(out.msg.extracted.map((r) => r.uid).sort(), ["arm", uid].sort());
  assert.deepEqual(out.msg.extracted.find((r) => r.uid === "arm"),
    { uid: "arm", kind: "armor", type: "armor", rarity: 1, level: 2, dur: 40 });
  assert.equal(out.msg.extracted.find((r) => r.uid === uid)!.dur, undefined);
  assert.equal(out.msg.lost.length, 0);
  assert.equal(m.runtime(a!)!.exit, "extract");
});

test("leaving the circle resets the channel", () => {
  const m = testMatch(2);
  const [a] = ids(m);
  addExtract(m, 1500, 1500, 0, 0, 110);
  place(m, a!, 1500, 1500);
  const p = pl(m, a!);
  run(m, CH - 1000);
  place(m, a!, 1800, 1500);
  run(m, 100);
  assert.equal(p.extractId, "");
  assert.equal(p.extractStartedAt, 0);
  place(m, a!, 1500, 1500);
  run(m, CH - 500);
  assert.equal(p.alive, true, "timer restarted from zero");
  run(m, 600);
  assert.equal(p.alive, false);
});

test("taking damage restarts the channel", () => {
  const m = testMatch(2);
  const [a, b] = ids(m);
  addExtract(m, 1500, 1500);
  place(m, a!, 1500, 1500);
  const p = pl(m, a!);
  run(m, CH - 1000);
  damagePlayer(m, p, 5, m.runtime(b!)!, "pistol", 0, 0);
  assert.equal(p.extractStartedAt, m.clock);
  run(m, CH - 500);
  assert.equal(p.alive, true);
  run(m, 600);
  assert.equal(p.alive, false);
  assert.equal(m.runtime(a!)!.exit, "extract");
});

test("closed or not-yet-open extracts do nothing", () => {
  const m = testMatch(2);
  const [a, b] = ids(m);
  addExtract(m, 1500, 1500, 0, 1000); // closes at 1 s
  addExtract(m, 2500, 1500, 60_000, 0); // opens at 60 s
  place(m, a!, 1500, 1500);
  place(m, b!, 2500, 1500);
  run(m, 900);
  assert.equal(pl(m, a!).extractId, "e0");
  run(m, CH + 500);
  assert.equal(pl(m, a!).alive, true, "extract closed mid-channel");
  assert.equal(pl(m, a!).extractId, "");
  assert.equal(pl(m, b!).alive, true);
  assert.equal(pl(m, b!).extractId, "");
});

test("the phase opens at EXTRACT_OPEN_AT_MS; at DURATION_MS everyone left loses everything", () => {
  const m = testMatch(2);
  const [a, b] = ids(m);
  const uid = giveWeapon(m, a!, 1, "sniper", 1);
  assert.equal(m.state.phase, "drop");
  run(m, MATCH.EXTRACT_OPEN_AT_MS);
  assert.equal(m.state.phase, "open");
  const ev = run(m, MATCH.DURATION_MS - MATCH.EXTRACT_OPEN_AT_MS + 100);
  assert.equal(m.state.phase, "ended");
  assert.ok(m.ended);
  const s = m.settlement!;
  assert.equal(s.participants.length, 2);
  assert.ok(s.participants.every((x) => x.exitType === "timeout"));
  assert.deepEqual(s.participants[0]!.lost.map((r) => r.uid), [uid]);
  const outcomes = ev.filter((x) => x.type === "outcome");
  assert.equal(outcomes.length, 2);
  assert.ok(ev.some((x) => x.type === "ended"));
  assert.equal(pl(m, a!).alive || pl(m, b!).alive, false);
  // Nothing happens after the end.
  m.step(50);
  assert.equal(m.drainEvents().length, 0);
});

test("the match ends early once no human is left on the map", () => {
  const m = testMatch(1, {
    roster: [
      { userId: "u1", nickname: "Human", isBot: false },
      { userId: null, nickname: "Bot", isBot: true },
    ],
    botBrains: false,
  });
  const [h, bot] = ids(m);
  addExtract(m, 1500, 1500);
  place(m, h!, 1500, 1500);
  place(m, bot!, 3000, 1500);
  run(m, CH + 100);
  assert.ok(m.ended);
  const s = m.settlement!;
  assert.equal(s.participants[0]!.exitType, "extract");
  assert.equal(s.participants[1]!.exitType, "timeout");
  assert.equal(s.participants[1]!.userId, null);
  assert.equal(s.participants[1]!.isBot, true);
});

test("settlement lists valuables left on the map: ground items and unopened chests, armor with durability", () => {
  const m = testMatch(1);
  const [a] = ids(m);
  const ground = newWeaponDrop(m, "shotgun", 2);
  spawnGroundItem(m, ground, 1200, 1200);
  const worn = newArmorDrop(m, 2);
  if (worn.kind === "armor") worn.dur = 33.5;
  spawnGroundItem(m, worn, 1250, 1200);
  spawnGroundItem(m, { kind: "ammo", ammo: "light", qty: 30 }, 1300, 1200);
  const chest = new Chest();
  chest.id = "c0";
  chest.x = 2500;
  chest.y = 2500;
  m.state.chests.set(chest.id, chest);
  const inChest = newArmorDrop(m, 3);
  m.chestContents.set(chest.id, [inChest, { kind: "medkit", qty: 1 }]);
  const carried = giveWeapon(m, a!, 1, "rifle", 1);

  const p = pl(m, a!);
  p.hp = 1;
  damagePlayer(m, p, 50, null, "", 0, 0);
  m.step(50);
  assert.ok(m.ended);
  const s = m.settlement!;
  const left = [...s.leftOnMap].sort((x, y) => x.uid.localeCompare(y.uid));
  const expected = [
    { uid: (ground as { uid: string }).uid, kind: "weapon", type: "shotgun", rarity: 2 },
    { uid: (worn as { uid: string }).uid, kind: "armor", type: "armor", rarity: 1, level: 2, dur: 33.5 },
    { uid: (inChest as { uid: string }).uid, kind: "armor", type: "armor", rarity: 2, level: 3, dur: 180 },
  ];
  // The dead player's rifle either broke (lost) or lies next to the body (left on the map).
  const rifleDropped = m.runtime(a!)!.dropped.some((r) => r.uid === carried);
  if (rifleDropped) expected.push({ uid: carried, kind: "weapon", type: "rifle", rarity: 1 });
  else assert.deepEqual(s.participants[0]!.lost.map((r) => r.uid), [carried]);
  assert.deepEqual(left, expected.sort((x, y) => x.uid.localeCompare(y.uid)));
});
