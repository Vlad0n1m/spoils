import { test } from "node:test";
import assert from "node:assert/strict";
import { SERVER_TICK_MS, WEAPONS, mulberry32 } from "@extract/shared";
import { BOT_BUSH_SIGHT, BOT_PEACE_MS, BOT_RETALIATE_MS, BOT_VIEW_RANGE, botCanSee } from "./bot.js";
import { Match } from "./match.js";
import { counterUid, ids, pl, place, send, testMap } from "./test-utils.js";
import type { MatchEvent } from "./types.js";

function duel(botBrains = true): { m: Match; human: string; bot: string } {
  const m = new Match({
    roster: [
      { userId: "u0", nickname: "Human", isBot: false },
      { userId: null, nickname: "Bot", isBot: true },
    ],
    rng: mulberry32(5),
    map: { ...testMap(), bushes: [{ x: 1600, y: 1600, r: 70 }] },
    newUid: counterUid,
    now: () => 1_700_000_000_000,
    emptyWorld: true,
    botBrains,
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

test("peace: a bot never starts a fight, but returns fire at a recent attacker and then stops", () => {
  const { m, human, bot } = duel();
  const acc: Aim = { t: 0 };
  const botShots = (evs: Array<MatchEvent & { at: number }>) => evs.filter((e) => e.type === "shot" && e.msg.s === bot);

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
  const h = pl(m, human);
  const b = pl(m, bot);
  place(m, bot, 1000, 1600);

  place(m, human, 1000 + BOT_VIEW_RANGE - 10, 1600);
  assert.ok(botCanSee(m, b, h));
  place(m, human, 1000 + BOT_VIEW_RANGE + 10, 1600);
  assert.ok(!botCanSee(m, b, h), "beyond view range");

  // Bush at (1600, 1600): the human stands still in it, 600 px away.
  place(m, human, 1600, 1600);
  wait(1000);
  assert.ok(!botCanSee(m, b, h), "hidden in the bush");
  m.runtime(human)!.movedAt = m.clock;
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
