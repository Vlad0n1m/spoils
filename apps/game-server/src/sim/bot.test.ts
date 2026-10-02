import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTAINER_STATE, INPUT_HZ, SERVER_TICK_MS, WEAPONS, mulberry32 } from "@extract/shared";
import { carriedItems } from "./bag.js";
import { makeItem } from "./items.js";
import { BOT_BUSH_SIGHT, BOT_PEACE_MS, BOT_RETALIATE_MS, BOT_VIEW_RANGE, botCanSee } from "./bot.js";
import { Match } from "./match.js";
import { counterUid, ids, pl, place, rtOf, send, testMap } from "./test-utils.js";
import type { MatchEvent } from "./types.js";

function duel(botBrains = true): { m: Match; human: string; bot: string } {
  const m = new Match({
    roster: [
      { userId: "u0", nickname: "Human", isBot: false },
      { userId: null, nickname: "Bot", isBot: true },
    ],
    rng: mulberry32(5),
    map: testMap({ bushes: [{ x: 1600, y: 1600, r: 70 }] }),
    newUid: counterUid,
    now: () => 1_700_000_000_000,
    emptyWorld: true,
    botBrains,
    strictLedger: true,
    envSeed: 1,
    weatherOverride: "clear",
  });
  const [human, bot] = ids(m) as [string, string];
  place(m, human, 1000, 1000);
  place(m, bot, 1300, 1000);
  return { m, human, bot };
}

interface Aim { t: number; bx?: number; by?: number }

/**
 * Steps one tick; the human sends 30 Hz inputs aimed at the bot (leading its movement, the bot
 * strafes), firing when `fire` says so.
 */
function tick(m: Match, human: string, bot: string, fire: boolean, acc: Aim): Array<MatchEvent & { at: number }> {
  const h = pl(m, human);
  const b = pl(m, bot);
  const vx = acc.bx === undefined ? 0 : (b.x - acc.bx) / (SERVER_TICK_MS / 1000);
  const vy = acc.by === undefined ? 0 : (b.y - acc.by) / (SERVER_TICK_MS / 1000);
  acc.bx = b.x;
  acc.by = b.y;
  const flight = Math.hypot(b.x - h.x, b.y - h.y) / WEAPONS.pistol.bulletSpeed;
  const aim = Math.atan2(b.y + vy * flight - h.y, b.x + vx * flight - h.x);
  acc.t += SERVER_TICK_MS;
  while (acc.t >= 1000 / 30 - 1e-6) {
    acc.t -= 1000 / 30;
    // Alternate the trigger so a semi-auto pistol gets fresh presses.
    const press = fire && Math.floor(m.clock / 150) % 2 === 0;
    send(m, human, { aim, fire: press });
  }
  m.step(SERVER_TICK_MS);
  return m.drainEvents().map((e) => ({ ...e, at: m.clock }));
}

test("bot input accumulator: exactly INPUT_HZ samples per second, all applied", () => {
  const { m, bot } = duel();
  const brain = m.bots[0]!;
  const rt = rtOf(m, bot);
  for (let i = 0; i < 20 * 10; i++) m.step(SERVER_TICK_MS); // 10 s
  assert.equal(brain.samples, INPUT_HZ * 10);
  // The server applied every one of them (lastSeq echoes the last).
  assert.ok(rt.self.lastSeq >= INPUT_HZ * 10 - 2, `applied up to ${rt.self.lastSeq}`);
  // Uneven step lengths still average out.
  const before = brain.samples;
  for (const dt of [17, 83, 50, 33.3333, 66.6667, 250]) m.step(dt);
  assert.equal(brain.samples - before, Math.floor((17 + 83 + 50 + 33.3333 + 66.6667 + 250) / (1000 / INPUT_HZ) + 1e-6));
});

test("peace: a bot never starts a fight, but returns fire at a recent attacker and then stops", () => {
  const { m, human, bot } = duel();
  const acc: Aim = { t: 0 };
  const botIdx = rtOf(m, bot).rosterIndex;
  const botShots = (evs: Array<MatchEvent & { at: number }>) => evs.filter((e) => e.type === "shot" && e.src === botIdx);

  // 3 s side by side in plain view: no shots.
  let evs: Array<MatchEvent & { at: number }> = [];
  while (m.clock < 3000) evs.push(...tick(m, human, bot, false, acc));
  assert.equal(botShots(evs).length, 0, "bot opened fire unprovoked");

  // The bot wandered off meanwhile: bring it back in pistol range, then shoot until a bullet lands.
  place(m, bot, pl(m, human).x + 300, pl(m, human).y);
  acc.bx = acc.by = undefined;
  let hitAt = -1;
  while (hitAt < 0 && m.clock < 8000) {
    for (const e of tick(m, human, bot, true, acc)) if (e.type === "hit" && e.msg.t === bot) hitAt = e.at;
  }
  assert.ok(hitAt > 0, "the human hit the bot");
  assert.equal(m.runtime(bot)!.lastHitBy?.id, human);

  // Stop shooting; the bot answers within its reaction time.
  evs = [];
  while (m.clock < hitAt + 2500) evs.push(...tick(m, human, bot, false, acc));
  assert.ok(botShots(evs).length > 0, "bot returns fire");
  assert.ok(pl(m, human).alive);

  // Nothing new since: once the retaliation window is over the bot goes quiet again.
  const quietFrom = m.runtime(bot)!.lastHitAt + BOT_RETALIATE_MS + 200;
  assert.ok(quietFrom < BOT_PEACE_MS);
  evs = [];
  while (m.clock < BOT_PEACE_MS - 100) evs.push(...tick(m, human, bot, false, acc));
  assert.equal(botShots(evs.filter((e) => e.at > quietFrom)).length, 0, "bot kept shooting after the window");
});

test("bot sight: view range, walls, and a human standing still in a bush", () => {
  const { m, human, bot } = duel(false);
  const wait = (ms: number) => { for (let t = 0; t < ms; t += SERVER_TICK_MS) m.step(SERVER_TICK_MS); };
  const h = rtOf(m, human);
  const b = rtOf(m, bot);
  place(m, bot, 1000, 1600);

  place(m, human, 1000 + BOT_VIEW_RANGE - 10, 1600);
  assert.ok(botCanSee(m, b, h));
  place(m, human, 1000 + BOT_VIEW_RANGE + 10, 1600);
  assert.ok(!botCanSee(m, b, h), "beyond view range");

  // Bush at (1600, 1600): the human stands still in it, 600 px away.
  place(m, human, 1600, 1600);
  wait(1000);
  assert.ok(!botCanSee(m, b, h), "hidden in the bush");
  h.movedAt = m.clock;
  assert.ok(botCanSee(m, b, h), "moving in a bush gives you away");
  wait(1000);
  place(m, bot, 1600 - BOT_BUSH_SIGHT + 20, 1600);
  assert.ok(botCanSee(m, b, h), "too close to hide");

  // A bot in a bush is always visible (to another viewer).
  place(m, bot, 1600, 1600);
  place(m, human, 1000, 1600);
  assert.ok(botCanSee(m, h, b));

  // Line of sight: the crate wall at x 3000..3064, y 3000..3400 blocks.
  place(m, bot, 2800, 3200);
  place(m, human, 3300, 3200);
  assert.ok(!botCanSee(m, b, h), "wall blocks sight");
});

test("bot loots a container through a search session: waits for the reveal, takes all, closes", () => {
  const m = new Match({
    roster: [
      { userId: "u0", nickname: "Human", isBot: false },
      { userId: null, nickname: "Bot", isBot: true },
    ],
    rng: mulberry32(9),
    map: testMap({ containers: [{ x: 1500, y: 1000, kind: "crate", tier: 1, zone: null }] }),
    newUid: counterUid,
    now: () => 1_700_000_000_000,
    emptyWorld: true,
    botBrains: true,
    strictLedger: true,
    envSeed: 1,
    weatherOverride: "clear",
  });
  m.containers.roll = () => [makeItem("junk_gpu"), makeItem("ammo_light", { qty: 12 })];
  const [human, bot] = ids(m) as [string, string];
  place(m, human, 4000, 4000);
  place(m, bot, 1100, 1000);
  let sawSearch = false;
  for (let t = 0; t < 25_000 && m.state.containerState[0] !== CONTAINER_STATE.EMPTIED; t += SERVER_TICK_MS) {
    m.step(SERVER_TICK_MS);
    m.drainEvents();
    if (rtOf(m, bot).search) sawSearch = true;
  }
  assert.ok(sawSearch, "the bot opened a search session");
  assert.equal(m.state.containerState[0], CONTAINER_STATE.EMPTIED, "the bot emptied the crate");
  assert.equal(rtOf(m, bot).search, null, "and closed the session");
  assert.ok(carriedItems(rtOf(m, bot)).some((c) => c.item.def === "junk_gpu"), "the junk is in the bot's bag");
});
