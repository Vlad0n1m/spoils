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
  SelfState,
  buildCollisionIndex,
  junkCredits,
  type ContainerSpot,
  type MapData,
} from "@extract/shared";
import { buildHud, buildHudSelf, extractAllowed, interactHint, searchOpenMs, stickyCounts } from "./hud";

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
    assert.deepEqual(h.ammo, { light: 60, shell: 12, heavy: 0 });
    assert.equal(h.bandages, 3);
    assert.equal(h.medkits, 0);
    assert.equal(h.armor, 2);
    assert.equal(h.armorDur, 90);
    assert.equal(h.armorMax, 130);
    assert.equal(h.storageUsed, 4);
    assert.equal(h.storageCap, 4, "pockets only without a backpack");
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
