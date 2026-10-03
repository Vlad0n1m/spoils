import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MATCH,
  S2C,
  bossGroupNpcCount,
  bossSlotCount,
  containerGuarded,
  mulberry32,
  npcPostsOf,
  raidBossSlots,
  raidNpcCarriers,
  rollBossSpawns,
  rollNpcSpawns,
  type LoadoutSnapshot,
  type RaidStartRequest,
  type RaidStartResponse,
} from "@extract/shared";
import { Match, matchMap } from "../sim/match.js";
import { counterUid, testMap } from "../sim/test-utils.js";
import type { RosterEntry } from "../sim/types.js";
import { applyExitSettled, parseInvMove, raidOptions } from "./inventory-handlers.js";
import { economyMode, planLaunch, queueDecision, queueWindowMs } from "./matchmaking-room.js";

const L1 = "11111111-1111-4111-8111-111111111111";
const L2 = "22222222-2222-4222-8222-222222222222";

const roster: RosterEntry[] = [
  { userId: "u1", nickname: "A", isBot: false, loadoutId: L1 },
  { userId: "u2", nickname: "B", isBot: false, loadoutId: "" },
];

const snap = (over: Partial<LoadoutSnapshot> = {}): LoadoutSnapshot => ({
  loadoutId: L1, userId: "u1", level: 5,
  entries: [
    { key: "w1", uid: "it-rifle", def: "rifle", qty: 1, rarity: 2, dur: 88 },
    { key: "p0", uid: "", def: "ammo_heavy", qty: 20, rarity: 0, dur: 0 },
  ],
  ...over,
});

test("raidOptions: demo by default; live keeps only the seat's own loadout, valid entries and unique uids", () => {
  assert.deepEqual(raidOptions({}, roster), { mode: "demo" });
  assert.deepEqual(raidOptions({ mode: "demo", loadouts: [snap()], containerLoot: { 1: [] } }, roster), { mode: "demo" });
  const o = raidOptions(
    {
      matchId: "0a901b8f-fa5d-4c07-943a-2d1f11da5555",
      mapSeed: 77,
      mode: "live",
      loadouts: [
        snap({
          entries: [
            { key: "w1", uid: "it-rifle", def: "rifle", qty: 1, rarity: 2, dur: 88 },
            { key: "w1", uid: "it-other", def: "sniper", qty: 1, rarity: 0, dur: 50 }, // slot twice
            { key: "p0", uid: "", def: "ammo_heavy", qty: 99, rarity: 0, dur: 0 }, // over stack
            { key: "p1", uid: "", def: "nope", qty: 1, rarity: 0, dur: 0 }, // unknown def
            { key: "zz" as "p2", uid: "", def: "bandage", qty: 1, rarity: 0, dur: 0 }, // bad key
            { key: "armor", uid: "", def: "armor_1", qty: 1, rarity: 0, dur: 80 }, // unique without uid
            { key: "p2", uid: "", def: "bandage", qty: 3, rarity: 0, dur: 0 },
          ],
        }),
        snap({ userId: "u2", loadoutId: L2 }), // u2's ticket locked no loadout
        snap({ userId: "u1" }), // second snapshot for the same user
      ],
      containerLoot: {
        "4": [{ uid: "pool-1", def: "shotgun", qty: 1, rarity: 1, dur: 70 }, { uid: "it-rifle", def: "rifle", qty: 1, rarity: 0, dur: 1 }],
        "5": [{ uid: "", def: "junk_gpu", qty: 1, rarity: 3, dur: 0 }],
        "boss:foreman": [{ uid: "pool-2", def: "rifle", qty: 1, rarity: 0, dur: 1 }],
        "npc:3.1": [{ uid: "pool-3", def: "armor_2", qty: 1, rarity: 2, dur: 50 }],
        "npc:x.1": [{ uid: "pool-4", def: "rifle", qty: 1, rarity: 0, dur: 1 }],
        "../etc": [{ uid: "pool-5", def: "rifle", qty: 1, rarity: 0, dur: 1 }],
      },
    },
    roster,
  );
  assert.equal(o.matchId, "0a901b8f-fa5d-4c07-943a-2d1f11da5555");
  assert.equal(o.mapSeed, 77);
  assert.equal(o.mode, "live");
  const l = o.loadouts as LoadoutSnapshot[];
  assert.equal(l.length, 1);
  assert.deepEqual(l[0]!.entries.map((e) => `${e.key}:${e.def}:${e.qty}`), ["w1:rifle:1", "p2:bandage:3"]);
  assert.deepEqual(o.containerLoot, {
    "4": [{ uid: "pool-1", def: "shotgun", qty: 1, rarity: 1, dur: 70 }],
    "boss:foreman": [{ uid: "pool-2", def: "rifle", qty: 1, rarity: 0, dur: 1 }],
    "npc:3.1": [{ uid: "pool-3", def: "armor_2", qty: 1, rarity: 2, dur: 50 }],
  }, "duplicate uid, fungible pool item and malformed keys dropped; boss bags and carriers kept");
  // Garbage never throws.
  assert.deepEqual(raidOptions({ mode: "live", loadouts: "x", containerLoot: 3 }, roster), { mode: "live", loadouts: [], containerLoot: {} });
  assert.deepEqual(raidOptions(null, roster), { mode: "demo" });
});

test("a live Match built from raidOptions spawns the snapshot and tracks pool items", () => {
  const opts = raidOptions({ mode: "live", mapSeed: 3, loadouts: [snap()], containerLoot: { "0": [{ uid: "pool-9", def: "sniper", qty: 1, rarity: 3, dur: 60 }] } }, roster);
  const m = new Match({
    roster, rng: mulberry32(1), map: testMap({ containers: [{ x: 2000, y: 2000, kind: "crate", tier: 2, zone: null }] }),
    newUid: counterUid, now: () => 0, emptyWorld: true, strictLedger: true, npcBrains: false, envSeed: 1, weatherOverride: "clear", ...opts,
  });
  const rt = m.allRuntimes()[0]!;
  assert.equal(rt.self.slots.get("w1")!.uid, "it-rifle");
  assert.equal(rt.self.slots.get("w1")!.dur, 88);
  assert.equal(rt.level, 5);
  assert.equal(m.ledger.known.get("pool-9")?.origin, "pool");
  assert.equal(m.mode, "live");
});

test("planLaunch: live → raids/start request; rejected seats are dropped; accepted snapshots go to the battle", async () => {
  const humans: RosterEntry[] = [
    { userId: "u1", nickname: "A", isBot: false, loadoutId: L1 },
    { userId: "u2", nickname: "B", isBot: false, loadoutId: L2 },
    { userId: "u3", nickname: "C", isBot: false, loadoutId: "" },
    { userId: "u4", nickname: "D", isBot: false, loadoutId: "not-a-uuid" },
  ];
  let sent: RaidStartRequest | null = null;
  const res: RaidStartResponse = {
    accepted: [snap()],
    rejected: [{ userId: "u2", reason: "expired" }],
    containerLoot: { "2": [{ uid: "pool-1", def: "rifle", qty: 1, rarity: 0, dur: 70 }] },
    autosellMult: 0.8,
  };
  const plan = await planLaunch(humans, {
    mode: "live", matchId: "0a901b8f-fa5d-4c07-943a-2d1f11da5555", matchSeed: 9, lootSeed: 31337,
    startRaid: async (req) => { sent = req; return res; },
  });
  const req = sent as RaidStartRequest | null;
  assert.ok(req);
  assert.equal(req.mode, "live");
  assert.equal(req.matchSeed, 9);
  assert.deepEqual(req.players, [{ userId: "u1", loadoutId: L1 }, { userId: "u2", loadoutId: L2 }, { userId: "u3", loadoutId: "" }]);
  assert.ok(req.containers.length > 0 && req.containers.every((c, i) => c.idx === i));
  assert.deepEqual(plan.rejected.sort(), ["u2", "u4"]);
  assert.deepEqual(plan.roster.map((r) => `${r.userId}:${r.loadoutId}`), [`u1:${L1}`, "u3:"], "humans only, never a bot fill");
  // v5 wiring: the same NPC rolls the match will make (bosses, guarded containers, carriers), from
  // the server-secret loot seed (never the public match seed); the web allocates with it too.
  assert.equal(req.allocSeed, 31337);
  assert.equal(plan.options.lootSeed, 31337);
  assert.equal(plan.options.mapSeed, 9);
  const map = matchMap(9);
  const spawned = rollBossSpawns(31337, map.bosses);
  assert.deepEqual(req.bosses, raidBossSlots(spawned));
  assert.equal(req.bossSlots, bossSlotCount(req.bosses!));
  const posts = npcPostsOf(map);
  assert.deepEqual(req.carriers, raidNpcCarriers(rollNpcSpawns(31337, posts, bossGroupNpcCount(spawned)), posts));
  assert.ok(req.carriers!.every((c) => c.tier >= 3 && /^npc:\d+\.\d+$/.test(c.key)));
  assert.deepEqual(req.containers.map((c) => !!c.guarded), map.containers.map((c) => containerGuarded(c, map.bosses)));
  assert.ok(req.containers.some((c) => c.guarded), "containers near a BossSpot are flagged");
  assert.equal(plan.options.mode, "live");
  assert.deepEqual(plan.options.loadouts.map((l) => l.userId), ["u1"]);
  assert.equal(plan.options.autosellMult, 0.8);
  // What the battle room will actually use.
  const o = raidOptions({ ...plan.options }, plan.roster);
  assert.equal(o.lootSeed, 31337, "the battle room gets the loot seed (server-side create options, never synced)");
  assert.equal((o.loadouts as LoadoutSnapshot[]).length, 1);
  assert.deepEqual(Object.keys(o.containerLoot!), ["2"]);
});

test("planLaunch: raids/start unavailable → demo with free kits; ECONOMY_MODE=demo never calls it", async () => {
  const humans: RosterEntry[] = [{ userId: "u1", nickname: "A", isBot: false, loadoutId: L1 }];
  const prevErr = console.error;
  console.error = () => {};
  try {
    const plan = await planLaunch(humans, { mode: "live", startRaid: async () => null });
    assert.equal(plan.options.mode, "demo");
    assert.deepEqual(plan.rejected, []);
    assert.equal(plan.roster[0]!.loadoutId, "", "plays the free kit; the web expires the lock");
    assert.deepEqual(plan.options.loadouts, []);
  } finally {
    console.error = prevErr;
  }
  let called = false;
  const demo = await planLaunch(humans, { mode: "demo", startRaid: async () => { called = true; return null; } });
  assert.equal(called, false);
  assert.equal(demo.options.mode, "demo");
  const prev = process.env.ECONOMY_MODE;
  process.env.ECONOMY_MODE = "demo";
  assert.equal(economyMode(), "demo");
  process.env.ECONOMY_MODE = "live";
  assert.equal(economyMode(), "live");
  if (prev === undefined) delete process.env.ECONOMY_MODE;
  else process.env.ECONOMY_MODE = prev;
});

test("the web's exit receipt refreshes the player's OUTCOME (and is what a reconnect gets)", () => {
  const m = new Match({
    roster, rng: mulberry32(1), map: testMap(), newUid: counterUid, now: () => 0, emptyWorld: true,
    strictLedger: true, npcBrains: false, envSeed: 1, weatherOverride: "clear",
  });
  const rt = m.allRuntimes()[0]!;
  m.attachHuman("u1", "s1");
  const sent: Array<[string, unknown]> = [];
  const room = { clients: [{ sessionId: "s1", send: (t: string, msg: unknown) => sent.push([t, msg]) }] } as never;
  assert.equal(applyExitSettled(room, m, "u1", { credits: 10, sold: [], guest: false }), null, "no outcome yet");
  rt.outcome = { matchId: "m", exit: "extract", extracted: [], lost: [], dropped: [], kills: 2, killedBy: "", atMs: 1, credits: 25, sold: [], guest: false };
  const out = applyExitSettled(room, m, "u1", { credits: 20, sold: [{ def: "junk_hdd", qty: 1, cr: 20 }], guest: true })!;
  assert.equal(out.credits, 20);
  assert.equal(out.guest, true);
  assert.equal(out.kills, 2);
  assert.deepEqual(sent, [[S2C.OUTCOME, out]]);
  assert.equal(rt.outcome, out);
});

test("parseInvMove keeps loot moves (slot index keys) and refuses junk", () => {
  assert.deepEqual(parseInvMove({ from: "loot", key: "12", uid: "", def: "junk_gpu", to: "p1", qty: 1 }), { from: "loot", key: "12", uid: "", def: "junk_gpu", to: "p1", qty: 1 });
  assert.equal(parseInvMove({ from: "loot", key: "1", uid: "", def: "x", to: "p9x" }), null);
  assert.equal(parseInvMove({ from: "ground", key: "1", uid: "", def: "x" }), null);
  assert.equal(parseInvMove({ from: "loot", key: "1", uid: "", def: "x", qty: 0 }), null);
});

test("planLaunch: a lost raids/start reply → the demo fallback runs under a fresh matchId (the committed raid is never settled)", async () => {
  const humans: RosterEntry[] = [{ userId: "u1", nickname: "A", isBot: false, loadoutId: L1 }];
  const M = "8b16b697-0000-4000-8000-000000000001";
  let sentId = "";
  const prevErr = console.error;
  console.error = () => {};
  try {
    // The web committed (loadouts in_raid under M) but the reply never arrived.
    const plan = await planLaunch(humans, { mode: "live", matchId: M, startRaid: async (req) => { sentId = req.matchId; return null; } });
    assert.equal(sentId, M);
    assert.equal(plan.options.mode, "demo");
    assert.notEqual(plan.options.matchId, M, "demo exit/end reports must not settle the committed raid");
    assert.match(plan.options.matchId!, /^[0-9a-f-]{36}$/);
  } finally {
    console.error = prevErr;
  }
});

test("queue rules (humans only): 24 → at once; 12 after MIN_WAIT_MS; the window end with 1; never an empty launch", () => {
  const W = MATCH.QUEUE_WINDOW_MS;
  assert.deepEqual(queueDecision(MATCH.MAX_HUMANS, 0, W), { launch: true, recheckInMs: null }, "24 → instant");
  assert.deepEqual(queueDecision(MATCH.MIN_HUMANS, 2_000, W), { launch: false, recheckInMs: MATCH.MIN_WAIT_MS - 2_000 }, "12 wait for the friend group");
  assert.equal(queueDecision(MATCH.MIN_HUMANS, MATCH.MIN_WAIT_MS, W).launch, true, "12 after 10 s");
  assert.equal(queueDecision(MATCH.MIN_HUMANS - 1, MATCH.MIN_WAIT_MS, W).launch, false, "11 keep waiting");
  assert.deepEqual(queueDecision(1, 5_000, W), { launch: false, recheckInMs: W - 5_000 });
  assert.equal(queueDecision(1, W, W).launch, true, "the window ends with a solo human: a solo raid vs NPCs");
  assert.deepEqual(queueDecision(0, W + 1, W), { launch: false, recheckInMs: null }, "never an empty launch");
  const prev = process.env.MM_QUEUE_WINDOW_MS;
  process.env.MM_QUEUE_WINDOW_MS = "250";
  assert.equal(queueWindowMs(), 250);
  process.env.MM_QUEUE_WINDOW_MS = "nope";
  assert.equal(queueWindowMs(), MATCH.QUEUE_WINDOW_MS);
  if (prev === undefined) delete process.env.MM_QUEUE_WINDOW_MS;
  else process.env.MM_QUEUE_WINDOW_MS = prev;
});

test("planLaunch: a pre-v5 bot entry never reaches the roster or raids/start", async () => {
  let sent: RaidStartRequest | null = null;
  const plan = await planLaunch([{ userId: "u1", nickname: "A", loadoutId: "" }, { userId: null, nickname: "Bot", isBot: true }], {
    mode: "live", matchSeed: 5,
    startRaid: async (req) => { sent = req; return { accepted: [], rejected: [], containerLoot: {}, autosellMult: 1 }; },
  });
  assert.deepEqual(plan.roster.map((r) => r.userId), ["u1"]);
  assert.deepEqual((sent as RaidStartRequest | null)!.players.map((p) => p.userId), ["u1"]);
});
