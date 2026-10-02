import { test } from "node:test";
import assert from "node:assert/strict";
import { ACT, MATCH } from "@extract/shared";
import { damagePlayer } from "./combat.js";
import { spawnGroundItem } from "./inventory.js";
import { makeItem } from "./items.js";
import { addExtract, giveItem, giveStack, giveWeapon, ids, pl, place, rtOf, run, selfOf, testMatch } from "./test-utils.js";

const CH = MATCH.EXTRACT_CHANNEL_MS;

test("standing in an open extract for the channel time extracts with everything non-FREE", () => {
  const m = testMatch(2);
  const [a] = ids(m);
  const e = addExtract(m, 1500, 1500);
  place(m, a!, 1500, 1500);
  const uid = giveWeapon(m, a!, "w2", "rifle", 3);
  const arm = giveItem(m, a!, "armor_2", "armor", { dur: 40 });
  giveStack(m, a!, "junk_goldchain", 1);
  const s = selfOf(m, a!);

  run(m, 100);
  assert.equal(s.extractId, e.id);
  assert.equal(pl(m, a!).act & ACT.EXTRACT, ACT.EXTRACT);
  const startedAt = s.extractStartedAt;
  assert.ok(startedAt > 0);
  run(m, CH - 200);
  assert.equal(pl(m, a!).alive, true);
  const ev = run(m, 200);
  assert.equal(pl(m, a!).alive, false);
  assert.ok(s.extractedAt > 0);
  assert.equal(s.extractedAt - startedAt, CH);
  assert.equal(s.slots.size, 0);

  const out = ev.find((x) => x.type === "outcome");
  assert.ok(out && out.type === "outcome");
  assert.equal(out.msg.exit, "extract");
  assert.deepEqual(out.msg.extracted.filter((r) => r.uid).map((r) => r.uid).sort(), [arm, uid].sort());
  assert.deepEqual(out.msg.extracted.find((r) => r.uid === arm), { uid: arm, def: "armor_2", qty: 1, rarity: 1, dur: 40 });
  // FREE kit never leaves; junk does and is priced in the receipt.
  assert.ok(out.msg.extracted.every((r) => r.def !== "pistol" && r.def !== "bandage"));
  assert.equal(out.msg.credits, 1000);
  assert.deepEqual(out.msg.sold, [{ def: "junk_goldchain", qty: 1, cr: 1000 }]);
  assert.equal(out.msg.lost.length, 0);
  assert.equal(rtOf(m, a!).exitReport?.exit, "extract");
  assert.equal(m.ledger.resolved.get(uid), "extract");
  // Sounds: the extract channel repeats every 2.5 s.
  assert.ok(ev.some((x) => x.type === "exit"));
});

test("leaving the circle resets the channel", () => {
  const m = testMatch(2);
  const [a] = ids(m);
  addExtract(m, 1500, 1500, 0, 0, 110);
  place(m, a!, 1500, 1500);
  const s = selfOf(m, a!);
  run(m, CH - 1000);
  place(m, a!, 1800, 1500);
  run(m, 100);
  assert.equal(s.extractId, "");
  assert.equal(s.extractStartedAt, 0);
  place(m, a!, 1500, 1500);
  run(m, CH - 500);
  assert.equal(pl(m, a!).alive, true, "timer restarted from zero");
  run(m, 600);
  assert.equal(pl(m, a!).alive, false);
});

test("taking damage restarts the channel", () => {
  const m = testMatch(2);
  const [a, b] = ids(m);
  addExtract(m, 1500, 1500);
  place(m, a!, 1500, 1500);
  run(m, CH - 1000);
  damagePlayer(m, rtOf(m, a!), 5, rtOf(m, b!), "pistol", 0, 0);
  assert.equal(selfOf(m, a!).extractStartedAt, m.clock);
  run(m, CH - 500);
  assert.equal(pl(m, a!).alive, true);
  run(m, 600);
  assert.equal(pl(m, a!).alive, false);
  assert.equal(rtOf(m, a!).exitReport?.exit, "extract");
});

test("closed, not-yet-open or not-allowed extracts do nothing", () => {
  const m = testMatch(2);
  const [a, b] = ids(m);
  addExtract(m, 1500, 1500, 0, 1000); // closes at 1 s
  addExtract(m, 2500, 1500, 60_000, 0); // opens at 60 s
  place(m, a!, 1500, 1500);
  place(m, b!, 2500, 1500);
  run(m, 900);
  assert.equal(selfOf(m, a!).extractId, "e0");
  run(m, CH + 500);
  assert.equal(pl(m, a!).alive, true, "extract closed mid-channel");
  assert.equal(selfOf(m, a!).extractId, "");
  assert.equal(pl(m, b!).alive, true);
  assert.equal(selfOf(m, b!).extractId, "");

  // An extract of the map whose bit is not in the player's extractMask.
  const e = addExtract(m, 3500, 1500);
  m.extractBit.set(e.id, 3);
  selfOf(m, a!).extractMask = 0b0111;
  place(m, a!, 3500, 1500);
  run(m, 200);
  assert.equal(selfOf(m, a!).extractId, "");
  selfOf(m, a!).extractMask = 0b1000;
  run(m, 200);
  assert.equal(selfOf(m, a!).extractId, e.id);
});

test("the phase opens at EXTRACT_OPEN_AT_MS (3:00); at DURATION_MS (30:00) everyone left loses everything", () => {
  assert.equal(MATCH.DURATION_MS, 30 * 60_000);
  assert.equal(MATCH.EXTRACT_OPEN_AT_MS, 3 * 60_000);
  const m = testMatch(2);
  const [a, b] = ids(m);
  const uid = giveWeapon(m, a!, "w2", "sniper", 1);
  giveStack(m, a!, "junk_gpu", 1);
  assert.equal(m.state.phase, "drop");
  run(m, MATCH.EXTRACT_OPEN_AT_MS);
  assert.equal(m.state.phase, "open");
  const ev = run(m, MATCH.DURATION_MS - MATCH.EXTRACT_OPEN_AT_MS + 100);
  assert.equal(m.state.phase, "ended");
  assert.ok(m.ended);
  const r = m.report!;
  assert.equal(r.participants.length, 2);
  assert.ok(r.participants.every((x) => x.exitType === "timeout"));
  const lostA = rtOf(m, a!).exitReport!.lost;
  assert.deepEqual(lostA.filter((x) => x.uid).map((x) => x.uid), [uid]);
  assert.ok(lostA.some((x) => x.def === "junk_gpu"), "timeout loses junk too");
  assert.equal(m.ledger.resolved.get(uid), "lost");
  assert.equal(ev.filter((x) => x.type === "outcome").length, 2);
  assert.equal(ev.filter((x) => x.type === "exit").length, 2);
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
  const r = m.report!;
  assert.equal(r.participants[0]!.exitType, "extract");
  assert.equal(r.participants[1]!.exitType, "timeout");
  assert.equal(r.participants[1]!.userId, null);
  assert.equal(r.participants[1]!.isBot, true);
});

test("end report lists uniques left on the map (ground, armor with its points) and demo mints", () => {
  const m = testMatch(1);
  const [a] = ids(m);
  const ground = makeItem("shotgun", { uid: m.newUid(), rarity: 2 });
  m.ledger.register(ground, "minted");
  spawnGroundItem(m, ground, 1200, 1200);
  const worn = makeItem("armor_2", { uid: m.newUid(), dur: 33.5 });
  m.ledger.register(worn, "minted");
  spawnGroundItem(m, worn, 1250, 1200);
  spawnGroundItem(m, makeItem("ammo_light", { qty: 30 }), 1300, 1200);
  const carried = giveWeapon(m, a!, "w2", "rifle", 1);

  pl(m, a!).hp = 1;
  damagePlayer(m, rtOf(m, a!), 50, null, "", 0, 0);
  m.step(50);
  assert.ok(m.ended);
  const r = m.report!;
  const left = [...r.leftOnMap].sort((x, y) => x.uid.localeCompare(y.uid));
  const expected = [
    { uid: ground.uid, def: "shotgun", qty: 1, rarity: 2, dur: 100 },
    { uid: worn.uid, def: "armor_2", qty: 1, rarity: 1, dur: 33.5 },
  ];
  // The dead player's rifle either broke (lost) or lies next to the body (left on the map).
  if (rtOf(m, a!).dropped.some((x) => x.uid === carried)) expected.push({ uid: carried, def: "rifle", qty: 1, rarity: 1, dur: 100 });
  else assert.deepEqual(rtOf(m, a!).exitReport!.lost.map((x) => x.uid), [carried]);
  assert.deepEqual(left, expected.sort((x, y) => x.uid.localeCompare(y.uid)));
  assert.deepEqual(r.minted.map((x) => x.uid).sort(), [ground.uid, worn.uid].sort());
  assert.deepEqual(m.ledgerGaps(), []);
});
