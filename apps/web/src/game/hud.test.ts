/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/hud.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BattleState,
  CONTAINER_STATE,
  Corpse,
  Extract,
  GroundItem,
  INPUT_DT_MS,
  ITEM_FLAG,
  InvItem,
  Player,
  ROLL,
  SEARCH,
  WORLD,
  XP,
  SelfState,
  buildCollisionIndex,
  junkCredits,
  type ContainerSpot,
  type MapData,
} from "@extract/shared";
import {
  WIPE_WARN_SHOW_MS,
  bossToastText,
  buildHud,
  buildHudSelf,
  earlyExtract,
  extractAllowed,
  extractXpLeftS,
  hudBoss,
  hudPhase,
  interactHint,
  personalExtractStatus,
  searchOpenMs,
  stickyCounts,
  wipeWarnAt,
  wipeWarnText,
} from "./hud";

describe("stickyCounts", () => {
  it("follows the live count while the raid runs", () => {
    let c = stickyCounts(null, { phase: "drop", aliveCount: 16, totalPlayers: 16 });
    assert.deepEqual(c, { alive: 16, total: 16 });
    c = stickyCounts(c, { phase: "open", aliveCount: 5, totalPlayers: 16 });
    assert.deepEqual(c, { alive: 5, total: 16 });
  });

  it("keeps the last running count after the end-of-raid timeout empties the map", () => {
    const c = stickyCounts({ alive: 3, total: 16 }, { phase: "ended", aliveCount: 0, totalPlayers: 16 });
    assert.deepEqual(c, { alive: 3, total: 16 });
  });

  it("survives a cleared state", () => {
    const c = stickyCounts({ alive: 4, total: 16 }, { phase: "open", aliveCount: 0, totalPlayers: 0 });
    assert.deepEqual(c, { alive: 4, total: 16 });
  });
});

function inv(def: string, fields: Partial<InvItem> = {}): InvItem {
  return Object.assign(new InvItem(), { def, qty: 1 }, fields);
}

function selfWith(items: Record<string, InvItem>, fields: Partial<SelfState> = {}): SelfState {
  const s = Object.assign(new SelfState(), fields);
  for (const [k, it] of Object.entries(items)) s.slots.set(k, it);
  return s;
}

const mapStub = (containers: ContainerSpot[] = [], extracts: MapData["extracts"] = []) =>
  ({ containers, extracts }) as unknown as MapData;

describe("buildHudSelf (slots → summary)", () => {
  const me = { alive: true, hp: 80, diedAt: 0 };

  it("derives weapons, ammo, meds and armor from the slot map", () => {
    const self = selfWith({
      w1: inv("pistol", { mag: 7, flags: ITEM_FLAG.FREE }),
      w2: inv("shotgun", { mag: 3, rarity: 2 }),
      armor: inv("armor_2", { dur: 90 }),
      p0: inv("ammo_light", { qty: 40 }),
      p1: inv("ammo_shell", { qty: 12 }),
      p2: inv("bandage", { qty: 3 }),
      p3: inv("ammo_light", { qty: 20 }),
    }, { active: "w2" });
    const h = buildHudSelf({ me, self, clockMs: 1000 });
    assert.equal(h.active, 1);
    assert.deepEqual(h.slots[0], { weapon: "pistol", rarity: 0, mag: 7, magSize: 12, free: true, broken: false });
    assert.equal(h.slots[1].weapon, "shotgun");
    assert.equal(h.slots[1].rarity, 2);
    assert.deepEqual(h.ammo, { light: 60, shell: 12, heavy: 0, bolt: 0 });
    assert.equal(h.bandages, 3);
    assert.equal(h.medkits, 0);
    assert.equal(h.grenades, 0);
    assert.equal(h.armor, 2);
    assert.equal(h.armorDur, 90);
    assert.equal(h.armorMax, 130);
    assert.equal(h.storageUsed, 4);
    assert.equal(h.storageCap, 4, "pockets only without a backpack");
  });

  it("Weapons v2: crossbow bolts and hand grenades are counted", () => {
    const self = selfWith({
      w1: inv("crossbow", { mag: 1, rarity: 1 }),
      p0: inv("ammo_bolt", { qty: 7 }),
      p1: inv("grenade", { qty: 2 }),
      p2: inv("grenade", { qty: 1 }),
    });
    const h = buildHudSelf({ me, self, clockMs: 0 });
    assert.equal(h.slots[0].weapon, "crossbow");
    assert.equal(h.slots[0].magSize, 1);
    assert.equal(h.ammo.bolt, 7);
    assert.equal(h.grenades, 3);
  });

  it("flags broken weapons and excludes broken ammo stacks", () => {
    const self = selfWith({ w1: inv("rifle", { flags: ITEM_FLAG.BROKEN }), p0: inv("ammo_light", { qty: 30, flags: ITEM_FLAG.BROKEN }) });
    const h = buildHudSelf({ me, self, clockMs: 0 });
    assert.equal(h.slots[0].broken, true);
    assert.equal(h.ammo.light, 0);
  });

  it("counts backpack storage and estimates junk credits (FREE items excluded)", () => {
    const self = selfWith({
      bp: inv("backpack_2"),
      p0: inv("junk_gpu"),
      b3: inv("junk_bolts", { qty: 4 }),
      b4: inv("junk_apple", { qty: 2, flags: ITEM_FLAG.FREE }),
    });
    const h = buildHudSelf({ me, self, clockMs: 0 });
    assert.equal(h.bpLevel, 2);
    assert.equal(h.storageCap, 4 + 10);
    assert.equal(h.storageUsed, 3);
    assert.equal(h.creditsEstimate, junkCredits([{ def: "junk_gpu", qty: 1 }, { def: "junk_bolts", qty: 4 }]));
  });

  it("turns own timers into progress bars", () => {
    const self = selfWith({ w1: inv("rifle") }, { reloadUntil: 3000, healUntil: 5000, healKind: "medkit" });
    const h = buildHudSelf({ me, self, clockMs: 2000 });
    assert.deepEqual(h.reloading, { startMs: 1000, untilMs: 3000 });
    assert.deepEqual(h.healing, { kind: "medkit", startMs: -1000, untilMs: 5000 });
    const later = buildHudSelf({ me, self, clockMs: 6000 });
    assert.equal(later.reloading, null);
    assert.equal(later.healing, null);
  });

  it("shows the roll cooldown as quantised match-clock times", () => {
    const self = selfWith({});
    const cdMs = ROLL.COOLDOWN_TICKS * INPUT_DT_MS;
    const a = buildHudSelf({ me, self, clockMs: 10_003, move: { rollCooldownMs: 4000, rolling: false, walking: true } });
    const b = buildHudSelf({ me, self, clockMs: 10_041, move: { rollCooldownMs: 3962, rolling: false, walking: true } });
    assert.equal(a.roll.readyAtMs, 14_100);
    assert.deepEqual(a.roll, b.roll, "clock jitter within one quantum keeps the slice stable");
    assert.equal(Math.round(a.roll.readyAtMs - a.roll.cdStartMs), Math.round(cdMs));
    assert.equal(a.walking, true);
    const ready = buildHudSelf({ me, self, clockMs: 10_000, move: { rollCooldownMs: 0, rolling: false, walking: false } });
    assert.equal(ready.roll.readyAtMs, 0);
  });

  it("describes the running search with its open-delay window", () => {
    const map = mapStub([{ x: 0, y: 0, kind: "safe", tier: 3, zone: null }]);
    const self = selfWith({}, { searching: "c0", searchReadyAt: 5000 });
    const h = buildHudSelf({ me, self, clockMs: 4000, map });
    assert.equal(h.search?.title, "Safe");
    assert.equal(h.search?.readyAtMs, 5000);
    assert.equal(h.search?.startMs, 5000 - searchOpenMs("c0", map));
    assert.equal(searchOpenMs("c0", map), SEARCH.OPEN_MS.tier[3]! + SEARCH.OPEN_MS.safeExtra);

    const state = new BattleState();
    state.corpses.set("7", Object.assign(new Corpse(), { id: "7", label: "Bob" }));
    const k = buildHudSelf({ me, self: selfWith({}, { searching: "k7", searchReadyAt: 3000 }), clockMs: 0, map, state });
    assert.equal(k.search?.title, "Bob's body");
    assert.equal(k.search?.startMs, 3000 - SEARCH.OPEN_MS.corpse);
  });

  it("is not alive without the public entry", () => {
    assert.equal(buildHudSelf({ me: null, self: selfWith({}), clockMs: 0 }).alive, false);
  });
});

describe("interactHint (v2 containers / corpses / items)", () => {
  function setup(opts: { items?: Array<Partial<GroundItem>>; corpses?: Array<Partial<Corpse>>; containerState?: number[] } = {}) {
    const state = new BattleState();
    (opts.items ?? []).forEach((fields, i) => {
      const it = Object.assign(new GroundItem(), { id: `i${i}`, qty: 1 }, fields);
      state.items.set(it.id, it);
    });
    (opts.corpses ?? []).forEach((fields, i) => {
      const c = Object.assign(new Corpse(), { id: `${i}` }, fields);
      state.corpses.set(c.id, c);
    });
    for (const v of opts.containerState ?? []) state.containerState.push(v);
    return state;
  }
  const crate: ContainerSpot = { x: 1050, y: 500, kind: "crate", tier: 1, zone: null };

  it("prefers a searchable container over a nearer ground item", () => {
    const state = setup({ items: [{ def: "rifle", rarity: 2, x: 1010, y: 500 }], containerState: [CONTAINER_STATE.UNTOUCHED] });
    assert.equal(interactHint({ state, map: mapStub([crate]), x: 1000, y: 500 }), "F — search Supply crate");
  });

  it("still offers an opened container, never an emptied one", () => {
    const opened = setup({ containerState: [CONTAINER_STATE.OPENED] });
    assert.match(interactHint({ state: opened, map: mapStub([crate]), x: 1000, y: 500 }) ?? "", /search/);
    const emptied = setup({ items: [{ def: "rifle", x: 1010, y: 500 }], containerState: [CONTAINER_STATE.EMPTIED] });
    assert.match(interactHint({ state: emptied, map: mapStub([crate]), x: 1000, y: 500 }) ?? "", /pick up Assault rifle/);
  });

  it("names a corpse by its victim and skips empty ones", () => {
    const state = setup({ corpses: [{ x: 1040, y: 500, label: "Ann" }, { x: 1010, y: 500, label: "Old", empty: true }] });
    assert.equal(interactHint({ state, map: mapStub(), x: 1000, y: 500 }), "F — search Ann's body");
  });

  it("names ground items by def (weapons with rarity, stacks with qty)", () => {
    assert.equal(
      interactHint({ state: setup({ items: [{ def: "sniper", rarity: 3, x: 1030, y: 500 }] }), map: null, x: 1000, y: 500 }),
      "F — pick up Sniper rifle (legendary)",
    );
    assert.equal(
      interactHint({ state: setup({ items: [{ def: "junk_bolts", qty: 3, x: 1030, y: 500 }] }), map: null, x: 1000, y: 500 }),
      "F — pick up Nuts & bolts ×3",
    );
  });

  it("breaks distance ties like the server (the later entry wins) and respects the reach", () => {
    const state = setup({ items: [{ def: "rifle", x: 1040, y: 500 }, { def: "sniper", x: 960, y: 500 }, { def: "pistol", x: 1200, y: 500 }] });
    assert.match(interactHint({ state, map: null, x: 1000, y: 500 }) ?? "", /Sniper/);
  });

  it("ignores targets behind a wall when the collision index is known", () => {
    const idx = buildCollisionIndex({ rects: [{ x: 1020, y: 0, w: 24, h: 1000 }], circles: [] }, 2000, 1000);
    const state = setup({ items: [{ def: "rifle", x: 1070, y: 500 }], containerState: [0] });
    assert.match(interactHint({ state, map: mapStub([crate]), x: 1000, y: 500 }) ?? "", /search/);
    assert.equal(interactHint({ state, map: mapStub([crate]), x: 1000, y: 500, idx }), null);
  });
});

describe("buildHud", () => {
  function battle() {
    const state = new BattleState();
    state.phase = "open";
    state.durationMs = 1_800_000;
    state.aliveCount = 9;
    state.totalPlayers = 12;
    const me = Object.assign(new Player(), { sessionId: "me", x: 1000, y: 1000 });
    state.players.set("me", me);
    const self = selfWith({ w1: inv("pistol", { mag: 12 }) }, { extractMask: 0b10 });
    state.self.set("p3", self);
    const ex = (id: string, x: number) => Object.assign(new Extract(), { id, x, y: 1000, r: 100, openAt: 0 });
    state.extracts.set("A", ex("A", 1200));
    state.extracts.set("B", ex("B", 3000));
    const map = mapStub([], [
      { id: "A", name: "Alpha", x: 1200, y: 1000, r: 100, side: 0, kind: "always" },
      { id: "B", name: "Bravo", x: 3000, y: 1000, r: 100, side: 1, kind: "always" },
    ]);
    return { state, map, self };
  }

  it("reads counts from the server, lists only allowed extracts and points at the nearest", () => {
    const { state, map } = battle();
    const h = buildHud({ state, sessionId: "me", selfKey: "p3", selfPos: { x: 1000, y: 1000 }, clockMs: 5000, killFeed: [], pingMs: 20, map });
    assert.equal(h.aliveCount, 9);
    assert.equal(h.totalPlayers, 12);
    assert.deepEqual(h.extracts.map((e) => e.name), ["Bravo"]);
    assert.equal(h.nearestExtract?.dist, 2000);
    assert.equal(h.self?.slots[0].weapon, "pistol");
  });

  it("stays on the loader (self null) until the public entry arrived", () => {
    const { state, map } = battle();
    state.players.delete("me");
    const h = buildHud({ state, sessionId: "me", selfKey: "p3", selfPos: null, clockMs: 0, killFeed: [], pingMs: null, map });
    assert.equal(h.self, null);
    assert.deepEqual(h.extracts, []);
  });

  it("shows no interact hint while a search is open", () => {
    const { state, map, self } = battle();
    state.items.set("x", Object.assign(new GroundItem(), { id: "x", def: "rifle", x: 1010, y: 1000 }));
    const args = { state, sessionId: "me", selfKey: "p3", selfPos: { x: 1000, y: 1000 }, clockMs: 0, killFeed: [], pingMs: null, map };
    assert.match(buildHud(args).interactHint ?? "", /pick up/);
    self.searching = "c0";
    assert.equal(buildHud(args).interactHint, null);
  });

  it("replaces the F hint with the running crack / unlock channel", () => {
    const { state, map } = battle();
    state.items.set("x", Object.assign(new GroundItem(), { id: "x", def: "rifle", x: 1010, y: 1000 }));
    const args = { state, sessionId: "me", selfKey: "p3", selfPos: { x: 1000, y: 1000 }, clockMs: 0, killFeed: [], pingMs: null, map };
    assert.equal(buildHud({ ...args, channel: "crack" }).interactHint, "Cracking… (move or get hit to stop)");
    assert.equal(buildHud({ ...args, channel: "unlock" }).interactHint, "Unlocking… (move or get hit to stop)");
    assert.match(buildHud({ ...args, channel: null }).interactHint ?? "", /pick up/);
  });
});

describe("extractAllowed", () => {
  const map = mapStub([], [
    { id: "A", name: "A", x: 0, y: 0, r: 1, side: 0, kind: "always" },
    { id: "B", name: "B", x: 0, y: 0, r: 1, side: 1, kind: "always" },
  ]);
  it("maps mask bits to MapData.extracts indexes; unknown mask / id = allowed", () => {
    assert.equal(extractAllowed(map, 0b01, "A"), true);
    assert.equal(extractAllowed(map, 0b01, "B"), false);
    assert.equal(extractAllowed(map, 0xff, "B"), true);
    assert.equal(extractAllowed(map, 0, "B"), true);
    assert.equal(extractAllowed(map, 0b01, "Z"), true);
    assert.equal(extractAllowed(null, 0b01, "B"), true);
  });
});

describe("WORLD v6 HUD", () => {
  const CLOSE = WORLD.CYCLE_MS - WORLD.EXTRACT_EARLY_CLOSE_MS;
  /** A world map at minute 20: every extract open since 0, S2-style ones close at 40:00. */
  function world(enteredAt: number) {
    const state = new BattleState();
    state.phase = "open";
    state.durationMs = WORLD.CYCLE_MS;
    state.entryCloseMs = WORLD.CYCLE_MS - WORLD.ENTRY_CLOSE_MS;
    state.cycleId = 123;
    state.aliveCount = 7;
    state.totalPlayers = 15;
    const me = Object.assign(new Player(), { sessionId: "me", x: 1000, y: 1000 });
    state.players.set("me", me);
    const self = selfWith({}, { enteredAt, extractArmAt: enteredAt + WORLD.EXTRACT_ARM_MS });
    state.self.set("p30", self);
    const ex = (id: string, x: number, closeAt: number) => Object.assign(new Extract(), { id, x, y: 1000, r: 100, openAt: 0, closeAt });
    state.extracts.set("A", ex("A", 1200, 0));
    state.extracts.set("B", ex("B", 3000, CLOSE));
    const map = mapStub([], [
      { id: "A", name: "Alpha", x: 1200, y: 1000, r: 100, side: 0, kind: "always" },
      { id: "B", name: "Bravo", x: 3000, y: 1000, r: 100, side: 1, kind: "always" },
    ]);
    const hud = (clockMs: number) =>
      buildHud({ state, sessionId: "me", selfKey: "p30", selfPos: { x: 1000, y: 1000 }, clockMs, killFeed: [], pingMs: null, map });
    return { state, self, hud };
  }

  it("personal arm: a late entrant is in 'drop' with extracts waiting while the map is open", () => {
    const enteredAt = 20 * 60_000;
    const { hud } = world(enteredAt);
    const h = hud(enteredAt + 60_000);
    assert.equal(h.phase, "drop");
    assert.equal(h.extractOpenAtMs, enteredAt + WORLD.EXTRACT_ARM_MS);
    assert.ok(h.extracts.length === 2 && h.extracts.every((e) => !e.open));
    assert.equal(h.nearestExtract?.open, false);
    const armed = hud(enteredAt + WORLD.EXTRACT_ARM_MS);
    assert.equal(armed.phase, "open");
    assert.ok(armed.extracts.every((e) => e.open));
    assert.equal(armed.enteredAtMs, enteredAt);
    assert.equal(armed.durationMs, WORLD.CYCLE_MS);
  });

  it("closeAt comes from the state: B closes at 40:00 and leaves the list", () => {
    const { hud } = world(60_000);
    assert.deepEqual(hud(CLOSE - 1).extracts.map((e) => e.name), ["Alpha", "Bravo"]);
    assert.deepEqual(hud(CLOSE).extracts.map((e) => e.name), ["Alpha"]);
  });

  it("hudPhase / personalExtractStatus edges", () => {
    assert.equal(hudPhase("open", 1000, 0), "open");
    assert.equal(hudPhase("open", 1000, 1001), "drop");
    assert.equal(hudPhase("drop", 9e9, 0), "drop");
    assert.equal(hudPhase("ended", 0, 9e9), "ended");
    const e = { openAt: 0, closeAt: CLOSE };
    assert.equal(personalExtractStatus(e, { extractArmAt: 5000 }, 4999), "waiting");
    assert.equal(personalExtractStatus(e, { extractArmAt: 5000 }, 5000), "open");
    assert.equal(personalExtractStatus(e, null, 0), "open");
    assert.equal(personalExtractStatus(e, { extractArmAt: 5000 }, CLOSE), "closed");
  });

  it("wipe warnings at 10 / 5 / 1 minutes left, each for a few seconds", () => {
    assert.equal(wipeWarnAt(600_001), 0);
    assert.equal(wipeWarnAt(600_000), 600);
    assert.equal(wipeWarnAt(600_000 - WIPE_WARN_SHOW_MS + 1), 600);
    assert.equal(wipeWarnAt(600_000 - WIPE_WARN_SHOW_MS), 0);
    assert.equal(wipeWarnAt(299_000), 300);
    assert.equal(wipeWarnAt(59_500), 60);
    assert.equal(wipeWarnAt(30_000), 0);
    assert.equal(wipeWarnAt(0), 0);
    assert.equal(wipeWarnText(600), "Wipe in 10:00 — head for an extract");
    assert.equal(wipeWarnText(60), "Wipe in 1:00 — head for an extract");
    const { hud, state } = world(60_000);
    assert.equal(hud(WORLD.CYCLE_MS - 300_000 + 2_000).wipeWarn, 300);
    assert.equal(hud(WORLD.CYCLE_MS - 400_000).wipeWarn, 0);
    // Legacy matches have no wipe.
    state.entryCloseMs = 0;
    assert.equal(hud(WORLD.CYCLE_MS - 300_000 + 2_000).wipeWarn, 0);
  });

  it("boss event from the state and its toast text", () => {
    const { hud, state } = world(60_000);
    assert.equal(hud(120_000).boss, null);
    state.bossKind = "foreman";
    state.bossZone = "Grain Elevator";
    state.bossState = 1;
    assert.deepEqual(hud(120_000).boss, { kind: "foreman", zone: "Grain Elevator", state: 1 });
    assert.deepEqual(bossToastText({ kind: "foreman", zone: "Grain Elevator", state: 1 }), {
      title: "BOSS EVENT",
      sub: "Foreman holds the Grain Elevator",
    });
    assert.equal(bossToastText({ kind: "foreman", zone: "Grain Elevator", state: 2 }).title, "Foreman is down");
    assert.equal(bossToastText({ kind: "warden", zone: "The Depot", state: 1 }).sub, "Warden holds The Depot");
    assert.equal(hudBoss({ bossKind: "nobody", bossZone: "", bossState: 1 }), null);
    assert.equal(hudBoss({ bossKind: "foreman", bossZone: "", bossState: 0 }), null);
  });
});

describe("extract XP timer (the 8-minute rule in the raid)", () => {
  it("counts whole seconds down to XP.MIN_ONMAP_MS on the map, then 0", () => {
    assert.equal(extractXpLeftS(10_000, 10_000), XP.MIN_ONMAP_MS / 1000);
    assert.equal(extractXpLeftS(10_000, 10_000 + XP.MIN_ONMAP_MS - 1_500), 2);
    assert.equal(extractXpLeftS(10_000, 10_000 + XP.MIN_ONMAP_MS), 0);
    assert.equal(extractXpLeftS(0, 50_000), 0, "unknown entry time: no timer");
  });

  it("flags an extract that came before the rule (outcome hint), never a death or a late extract", () => {
    assert.equal(earlyExtract({ exit: "extract", atMs: 10_000 + 5 * 60_000 }, 10_000), true);
    assert.equal(earlyExtract({ exit: "extract", atMs: 10_000 + XP.MIN_ONMAP_MS }, 10_000), false);
    assert.equal(earlyExtract({ exit: "dead", atMs: 10_000 + 60_000 }, 10_000), false);
    assert.equal(earlyExtract({ exit: "extract", atMs: 60_000 }, 0), false);
  });
});
