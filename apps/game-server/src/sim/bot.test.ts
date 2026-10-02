import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONTAINER_STATE,
  INPUT_HZ,
  ROLL,
  SERVER_TICK_MS,
  SoundKind,
  VISION,
  WEAPONS,
  generateMap,
  mulberry32,
  visionRangeMult,
  type ItemLike,
} from "@extract/shared";
import { carriedItems } from "./bag.js";
import { spawnGroundItem } from "./inventory.js";
import { makeItem } from "./items.js";
import {
  BOT_LOD_RANGE,
  BOT_PEACE_MS,
  BOT_RETALIATE_MS,
  BOT_VIEW_RANGE,
  EXTRACT_AFTER_BIG_MAX_MS,
  EXTRACT_AFTER_BIG_MIN_MS,
  type BotBrain,
} from "./bot.js";
import { envNow } from "./environment.js";
import { Match, MATCH_PLAYERS } from "./match.js";
import { counterUid, giveItem, giveWeapon, ids, pl, place, rtOf, send, testMap, type TestMapOpts } from "./test-utils.js";
import type { MatchEvent } from "./types.js";

/** A human and one bot on the open test arena. envSeed 2 = midday clear (seed 1 is a night raid). */
function duel(botBrains = true, envSeed = 1, map: TestMapOpts = { bushes: [{ x: 1600, y: 1600, r: 70 }] }): { m: Match; human: string; bot: string } {
  const m = new Match({
    roster: [
      { userId: "u0", nickname: "Human", isBot: false },
      { userId: null, nickname: "Bot", isBot: true },
    ],
    rng: mulberry32(5),
    map: testMap(map),
    newUid: counterUid,
    now: () => 1_700_000_000_000,
    emptyWorld: true,
    botBrains,
    strictLedger: true,
    envSeed,
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

function brainOf(m: Match, id: string): BotBrain {
  const rt = rtOf(m, id);
  const b = m.bots.find((x) => x.rt === rt);
  assert.ok(b, `no brain for ${id}`);
  return b;
}

/** Skip the peace window without simulating it (rule tests on the empty arena). */
function skipPeace(m: Match, extraMs = 1000): void {
  m.state.clockMs = BOT_PEACE_MS + extraMs;
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
  brainOf(m, bot).tune({ rollChance: 0 });
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

  // Stop shooting; the bot turns to the damage direction and answers within its reaction time.
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

test("bot sight is the server vision matrix: range cap, cone, walls and a still human in a bush", () => {
  const { m, human, bot } = duel(false, 2, { bushes: [{ x: 1600, y: 1600, r: 70 }] });
  const range = BOT_VIEW_RANGE * visionRangeMult(envNow(m).vis);
  const h = rtOf(m, human);
  const b = rtOf(m, bot);
  const sees = () => {
    m.step(SERVER_TICK_MS);
    return m.vision.sees(b.rosterIndex, h.rosterIndex);
  };
  assert.equal(BOT_VIEW_RANGE, VISION.BOT_RANGE_CAP);
  place(m, bot, 1000, 1600);
  b.pub.aim = 0;
  place(m, human, 1000 + range - 20, 1600);
  assert.ok(sees(), "in front, inside the bot range cap");
  place(m, human, 1000 + range + 40, 1600);
  for (let i = 0; i < 8; i++) m.step(SERVER_TICK_MS); // past the 300 ms hysteresis
  assert.ok(!sees(), "beyond the bot range cap (a human would see this far)");

  // Behind the bot (outside the cone and the awareness radius): unseen until it turns.
  place(m, human, 600, 1600);
  for (let i = 0; i < 8; i++) m.step(SERVER_TICK_MS);
  assert.ok(!sees(), "behind its back");
  b.pub.aim = Math.PI;
  assert.ok(sees(), "turned around");

  // A human standing still in the bush at (1600, 1600), 600 px in front of the bot: hidden.
  b.pub.aim = 0;
  place(m, human, 1600, 1600);
  for (let i = 0; i < 12; i++) m.step(SERVER_TICK_MS);
  assert.ok(!sees(), "hidden in the bush");
  h.lastShotAt = m.clock;
  assert.ok(sees(), "a shot gives the bush away");

  // Line of sight: the crate wall at x 3000..3064, y 3000..3400 blocks.
  h.lastShotAt = -Infinity;
  place(m, bot, 2800, 3200);
  place(m, human, 3300, 3200);
  for (let i = 0; i < 8; i++) m.step(SERVER_TICK_MS);
  assert.ok(!sees(), "wall blocks sight");
});

test("a hit from behind: the bot turns to the damage direction; rolls obey the player cooldown", () => {
  const { m, human, bot } = duel(true, 2);
  const brain = brainOf(m, bot);
  brain.tune({ rollChance: 1 });
  const acc: Aim = { t: 0 };
  const b = rtOf(m, bot);
  const rolls: number[] = [];
  let firstHit = -1;
  let turned = false;
  // Peace window: the bot only answers. The human keeps shooting it from 300 px for 7 s.
  while (m.clock < 9000) {
    for (const e of tick(m, human, bot, true, acc)) {
      if (e.type === "sound" && e.kind === SoundKind.roll && e.src === b.rosterIndex) rolls.push(e.at);
      if (e.type === "hit" && e.msg.t === bot && firstHit < 0) firstHit = e.at;
    }
    if (firstHit > 0 && !turned && m.clock <= firstHit + 300) {
      const want = Math.atan2(pl(m, human).y - b.pub.y, pl(m, human).x - b.pub.x);
      const diff = Math.abs(Math.atan2(Math.sin(b.pub.aim - want), Math.cos(b.pub.aim - want)));
      if (diff < 0.35) turned = true;
    }
    if (!b.pub.alive) break;
    // Keep the duel at pistol range whatever the bot does.
    if (Math.hypot(b.pub.x - pl(m, human).x, b.pub.y - pl(m, human).y) > 450) {
      place(m, bot, pl(m, human).x + 300, pl(m, human).y);
      acc.bx = acc.by = undefined;
    }
  }
  assert.ok(firstHit > 0, "the human hit the bot");
  assert.ok(turned, "the bot faced its attacker within 300 ms of the first hit");
  assert.ok(rolls.length >= 1, "rolled when hit (chance pinned to 1)");
  const cdMs = ROLL.COOLDOWN_TICKS * (1000 / INPUT_HZ);
  for (let i = 1; i < rolls.length; i++) {
    assert.ok(rolls[i]! - rolls[i - 1]! >= cdMs - SERVER_TICK_MS, `rolls ${rolls[i - 1]} → ${rolls[i]} closer than the cooldown`);
  }
  assert.ok(rolls.length <= Math.ceil((m.clock - firstHit) / cdMs) + 1, `${rolls.length} rolls`);
});

test("hearing: a hidden gunshot turns the bot and sends it to the sector, sneaking the last stretch", () => {
  const { m, human, bot } = duel(true, 2);
  const brain = brainOf(m, bot);
  brain.tune({ curiosity: 1, pickFightRange: 700 });
  skipPeace(m);
  const b = rtOf(m, bot);
  // The shooter is 1100 px east of the bot (beyond its sight cap), firing north.
  place(m, bot, 1000, 2000);
  place(m, human, 2100, 2000);
  const spot = { x: 2100, y: 2000 };
  const d0 = Math.hypot(spot.x - b.pub.x, spot.y - b.pub.y);
  let acc = 0;
  for (let i = 0; i < 12; i++) {
    acc += SERVER_TICK_MS;
    while (acc >= 1000 / 30 - 1e-6) {
      acc -= 1000 / 30;
      send(m, human, { aim: -Math.PI / 2, fire: Math.floor(m.clock / 150) % 2 === 0 });
    }
    m.step(SERVER_TICK_MS);
    m.drainEvents();
  }
  // The shooter slips away; the bot only has what it heard.
  place(m, human, 4400, 4400);
  const t0 = m.clock;
  let inv: { x: number; y: number } | null = null;
  let walked = false;
  let closest = d0;
  let checked = false;
  while (m.clock < t0 + 9000) {
    m.step(SERVER_TICK_MS);
    m.drainEvents();
    inv ??= brain.investigating;
    if (b.self.walking) walked = true;
    closest = Math.min(closest, Math.hypot(spot.x - b.pub.x, spot.y - b.pub.y));
    if (!checked && m.clock >= t0 + 2000) {
      checked = true;
      assert.ok(inv, "investigating within 2 s");
      assert.ok(Math.hypot(spot.x - b.pub.x, spot.y - b.pub.y) < d0 - 150, "moving toward the sound within 2 s");
    }
  }
  assert.ok(checked && inv);
  // Sector (22.5°) and band estimate: roughly where the shots came from, never the exact spot.
  const a = Math.atan2(inv.y - 2000, inv.x - 1000);
  assert.ok(Math.abs(a) < Math.PI / 8 + 0.2, `sector angle ${a}`);
  assert.ok(Math.abs(Math.hypot(inv.x - 1000, inv.y - 2000) - 1100) < 700, "band distance");
  assert.ok(walked, "walked (Shift) on the last stretch");
  assert.ok(closest < 450, `reached the area (closest ${closest.toFixed(0)} px)`);
});

/** One bot next to a container whose contents the test decides. */
function lootMatch(contents: () => ItemLike[]): { m: Match; bot: string } {
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
  m.containers.roll = () => contents().map((it) => {
    if (it.uid) m.ledger.register(it, "minted");
    return it;
  });
  const [human, bot] = ids(m) as [string, string];
  place(m, human, 4000, 4000);
  place(m, bot, 1100, 1000);
  return { m, bot };
}

function runUntil(m: Match, ms: number, done: () => boolean): void {
  for (let t = 0; t < ms && !done(); t += SERVER_TICK_MS) {
    m.step(SERVER_TICK_MS);
    m.drainEvents();
  }
}

test("bot loots a container through a search session: waits for the reveal, takes all, closes", () => {
  const { m, bot } = lootMatch(() => [makeItem("junk_gpu"), makeItem("ammo_light", { qty: 12 })]);
  let sawSearch = false;
  let takenBeforeReady = false;
  for (let t = 0; t < 25_000 && m.containers.stateOf(0) !== CONTAINER_STATE.EMPTIED; t += SERVER_TICK_MS) {
    m.step(SERVER_TICK_MS);
    m.drainEvents();
    const rt = rtOf(m, bot);
    if (rt.search) {
      sawSearch = true;
      if (m.clock < rt.search.readyAt && carriedItems(rt).some((c) => c.item.def === "junk_gpu")) takenBeforeReady = true;
    }
  }
  assert.ok(sawSearch, "the bot opened a search session");
  assert.ok(!takenBeforeReady, "nothing taken before the open delay");
  assert.equal(m.containers.stateOf(0), CONTAINER_STATE.EMPTIED, "the bot emptied the crate");
  assert.equal(rtOf(m, bot).search, null, "and closed the session");
  assert.ok(carriedItems(rtOf(m, bot)).some((c) => c.item.def === "junk_gpu"), "the junk is in the bot's bag");
});

test("a full bag: the bot drops its cheapest junk for better loot (slot engine, no overfill)", () => {
  const { m, bot } = lootMatch(() => [makeItem("junk_gpu")]);
  // Pockets: FREE ammo, FREE bandage, two apples. No backpack: storage is full.
  giveItem(m, bot, "junk_apple", "p2");
  giveItem(m, bot, "junk_apple", "p3");
  const rt = rtOf(m, bot);
  runUntil(m, 25_000, () => m.containers.stateOf(0) === CONTAINER_STATE.EMPTIED && !rt.search);
  const carried = carriedItems(rt).map((c) => c.item.def);
  assert.ok(carried.includes("junk_gpu"), `gpu taken (${carried.join(",")})`);
  assert.equal(carried.filter((d) => d === "junk_apple").length, 1, "one apple made room");
  assert.ok([...m.ground.all()].some((g) => g.item.def === "junk_apple"), "the apple lies on the ground");
  assert.ok(carried.length <= 4 + 2, "never more than pockets + equipment");
});

test("the bot equips better gear it finds: weapon over the worse slot, armor, backpack", () => {
  const { m, bot } = lootMatch(() => [
    makeItem("rifle", { uid: m.newUid(), rarity: 1 }),
    makeItem("armor_3", { uid: m.newUid() }),
    makeItem("backpack_2", { uid: m.newUid() }),
  ]);
  // Two real pistols and a worn level-1 vest: the finds land in storage first, then get equipped.
  giveWeapon(m, bot, "w1", "pistol");
  giveWeapon(m, bot, "w2", "pistol");
  giveItem(m, bot, "armor_1", "armor");
  giveItem(m, bot, "backpack_1", "bp");
  const s = rtOf(m, bot).self.slots;
  runUntil(m, 40_000, () =>
    s.get("bp")?.def === "backpack_2" && s.get("armor")?.def === "armor_3" &&
    (s.get("w1")?.def === "rifle" || s.get("w2")?.def === "rifle"));
  assert.ok(s.get("w1")?.def === "rifle" || s.get("w2")?.def === "rifle", "rifle in a weapon slot");
  assert.equal(s.get("armor")?.def, "armor_3");
  assert.equal(s.get("bp")?.def, "backpack_2");
  // The replaced gear went to storage (nothing vanished: the ledger is strict).
  const defs = carriedItems(rtOf(m, bot)).map((c) => c.item.def);
  assert.ok(defs.includes("armor_1") && defs.includes("backpack_1") && defs.includes("pistol"), defs.join(","));
});

test("LOD: far from every human a bot decides at 2 Hz, near one at 10 Hz (and still moves)", () => {
  const { m, human, bot } = duel(true, 2);
  const brain = brainOf(m, bot);
  place(m, human, 4400, 4400);
  place(m, bot, 600, 600);
  const b = rtOf(m, bot);
  const run = (ms: number) => {
    const t0 = brain.thinks;
    for (let t = 0; t < ms; t += SERVER_TICK_MS) {
      if (Math.hypot(b.pub.x - 4400, b.pub.y - 4400) < BOT_LOD_RANGE + 200) place(m, bot, 600, 600);
      m.step(SERVER_TICK_MS);
      m.drainEvents();
    }
    return brain.thinks - t0;
  };
  run(1000);
  let path = 0;
  let last = { x: b.pub.x, y: b.pub.y };
  const t0 = brain.thinks;
  for (let t = 0; t < 10_000; t += SERVER_TICK_MS) {
    if (Math.hypot(b.pub.x - 4400, b.pub.y - 4400) < BOT_LOD_RANGE + 200) place(m, bot, 600, 600);
    m.step(SERVER_TICK_MS);
    m.drainEvents();
    path += Math.hypot(b.pub.x - last.x, b.pub.y - last.y);
    last = { x: b.pub.x, y: b.pub.y };
  }
  const far = brain.thinks - t0;
  assert.ok(brain.lod, "deciding at the LOD rate");
  assert.ok(far <= 30, `far: ${far} decisions in 10 s`);
  assert.ok(path > 1000, `keeps walking between decisions (${path.toFixed(0)} px in 10 s)`);
  place(m, human, 900, 900);
  const near = run(5000);
  assert.ok(near >= 40, `near: ${near} decisions in 5 s`);
});

test("Steppe roster: ~1/3 scavs with a home POI, personal extract times between 8 and 26 minutes", () => {
  const map = generateMap("steppe");
  const m = new Match({
    roster: [{ userId: "h", nickname: "H", isBot: false }, ...Array.from({ length: MATCH_PLAYERS - 1 }, (_, i) => ({ userId: null, nickname: `Bot${i}`, isBot: true }))],
    rng: mulberry32(3), map, newUid: counterUid, strictLedger: true,
  });
  const scavs = m.bots.filter((b) => b.role === "scav");
  assert.equal(scavs.length, Math.floor(m.bots.length / 3));
  for (const s of scavs) assert.ok(s.home && map.zones.some((z) => z.id === s.home!.id && z.tier >= 1));
  for (const b of m.bots.filter((x) => x.role === "pmc")) assert.equal(b.home, null);
  const times = m.bots.map((b) => b.extractAt).sort((a, b) => a - b);
  assert.ok(times[0]! >= EXTRACT_AFTER_BIG_MIN_MS && times[times.length - 1]! <= EXTRACT_AFTER_BIG_MAX_MS);
  // Spread over the raid, not bunched.
  assert.ok(times[times.length - 1]! - times[0]! > 10 * 60_000, "spread over at least 10 minutes");
});

test("a bot picks up a wanted weapon lying next to a partly looted container (targeted pickup, not the generic F)", () => {
  // The crate keeps worthless heavy rounds (two pistols, no heavy weapon): it never becomes EMPTIED.
  const { m, bot } = lootMatch(() => [makeItem("ammo_heavy", { qty: 10 })]);
  giveWeapon(m, bot, "w1", "pistol");
  giveWeapon(m, bot, "w2", "pistol");
  const rifle = makeItem("rifle", { uid: m.newUid(), rarity: 1 });
  m.ledger.register(rifle, "minted");
  const g = spawnGroundItem(m, rifle, 1545, 1000);
  const rt = rtOf(m, bot);
  let sessions = 0;
  let wasSearching = false;
  runUntil(m, 60_000, () => {
    if (rt.search && !wasSearching) sessions++;
    wasSearching = !!rt.search;
    return !m.ground.byId.has(g.id);
  });
  assert.ok(!m.ground.byId.has(g.id), `the rifle was picked up (container sessions: ${sessions})`);
  assert.ok(carriedItems(rt).some((c) => c.item.uid === rifle.uid), "and is carried");
  assert.ok(sessions <= 1, `F on the rifle never opened the crate again (${sessions} sessions)`);
});

test("a bot whose search goal is out of sight never grabs the nearest floor weapon instead", () => {
  const m = new Match({
    roster: [{ userId: "u0", nickname: "Human", isBot: false }, { userId: null, nickname: "Bot", isBot: true }],
    rng: mulberry32(9),
    map: testMap({ containers: [{ x: 1480, y: 1000, kind: "crate", tier: 1, zone: null }], walls: [{ x: 1450, y: 900, w: 16, h: 200 }] }),
    newUid: counterUid, now: () => 1_700_000_000_000, emptyWorld: true, botBrains: false, strictLedger: true,
    envSeed: 1, weatherOverride: "clear",
  });
  const [human, bot] = ids(m) as [string, string];
  place(m, human, 4000, 4000);
  place(m, bot, 1420, 1000); // 60 px from the crate, but behind the wall
  giveWeapon(m, bot, "w1", "rifle");
  giveWeapon(m, bot, "w2", "rifle");
  const rt = rtOf(m, bot);
  const shotgun = makeItem("shotgun", { uid: m.newUid() });
  m.ledger.register(shotgun, "minted");
  const g = spawnGroundItem(m, shotgun, 1400, 1010);
  assert.equal(m.openSearch(bot, "c0"), false, "no line of sight to the goal: nothing happens");
  assert.equal(rt.search, null);
  assert.ok(m.ground.byId.has(g.id), "the floor shotgun is untouched (the generic F would swap it in)");
  assert.equal(rt.self.slots.get(rt.self.active)?.def, "rifle");
  assert.equal(m.openSearch(bot, "k9"), false, "unknown corpse key");
  assert.equal(m.pickupItem(bot, "nope"), false);
  place(m, bot, 1480, 1060); // around the wall's end
  assert.equal(m.openSearch(bot, "c0"), true, "in reach and sight: opens exactly its goal");
  assert.equal(rtOf(m, bot).search?.key, "c0");
});
