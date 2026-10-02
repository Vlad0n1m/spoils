/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/inventory-client.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { C2S, ITEM_FLAG, type InvMoveMsg } from "@extract/shared";
import { FakeInventoryRoom, fakeItem } from "../components/inventory/dev-fake-room";
import { PENDING_TIMEOUT_MS, TOAST_TTL_MS, createInventoryClient, itemSig, makeBucket } from "./inventory-client";

function setup() {
  const room = new FakeInventoryRoom();
  room.latencyMs = 50;
  let wall = 0;
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let seq = 0;
  const client = createInventoryClient({
    room,
    selfKey: () => "p0",
    containers: () => [{ kind: "crate", tier: 1 }],
    clockMs: () => room.state.clockMs,
    now: () => wall,
    setTimer: (fn, ms) => {
      const id = ++seq;
      timers.push({ at: wall + ms, fn, id });
      return id;
    },
    clearTimer: (h) => {
      const i = timers.findIndex((t) => t.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  /** Advance wall + fake server clock together. */
  const advance = (ms: number) => {
    for (let t = 0; t < ms; t += 50) {
      wall += 50;
      room.tick(50);
      for (const tm of timers.filter((x) => x.at <= wall)) {
        timers.splice(timers.indexOf(tm), 1);
        tm.fn();
      }
    }
  };
  return { room, client, advance, sent: () => room.sent };
}

describe("inventory-client snapshot", () => {
  it("publishes only on real changes and copies items (no live objects)", () => {
    const { room, client } = setup();
    room.me.slots.set("p0", fakeItem("ammo_light", { qty: 30 }));
    room.patch();
    const s1 = client.getSnapshot();
    assert.equal(s1.ready, true);
    assert.equal(s1.slots.p0!.qty, 30);
    room.patch(); // nothing changed
    assert.equal(client.getSnapshot(), s1);
    room.me.slots.get("p0")!.qty = 29;
    room.patch();
    const s2 = client.getSnapshot();
    assert.notEqual(s2, s1);
    assert.equal(s1.slots.p0!.qty, 30, "old snapshot is immutable");
    assert.equal(s2.slots.p0!.qty, 29);
    assert.ok(Object.isFrozen(s2));
  });

  it("float32 durability jitter does not re-publish", () => {
    assert.equal(itemSig(fakeItem("rifle", { uid: "x", dur: 50.000001 })), itemSig(fakeItem("rifle", { uid: "x", dur: 50.00002 })));
  });

  it("computes bag capacity, slots used and junk value", () => {
    const { room, client } = setup();
    room.me.slots.set("bp", fakeItem("backpack_2"));
    room.me.slots.set("p0", fakeItem("junk_bolts", { qty: 4 }));
    room.me.slots.set("b3", fakeItem("junk_gpu"));
    room.me.slots.set("b4", fakeItem("junk_gpu", { flags: ITEM_FLAG.BROKEN }));
    room.patch();
    const s = client.getSnapshot();
    assert.equal(s.bpLevel, 2);
    assert.equal(s.bagCap, 10);
    assert.deepEqual(s.carry, { junkCr: 120 + 1500, used: 3, cap: 14 });
  });
});

describe("search view", () => {
  it("open delay, reveal one by one, taken cells, overlay visible while searching", () => {
    const { room, client, advance } = setup();
    room.openSearch("c0", [fakeItem("junk_apple"), fakeItem("rifle"), fakeItem("bandage")], 600);
    let s = client.getSnapshot();
    assert.equal(s.visible, true);
    assert.equal(s.search!.title, "Supply crate");
    assert.equal(s.search!.subtitle, "Common");
    assert.equal(s.search!.readyAt - s.search!.openStartAt, 800, "tier-1 crate open delay");
    assert.deepEqual(s.search!.cells.map((c) => c.kind), ["hidden", "hidden", "hidden"]);
    assert.equal(client.take(0), "not_ready");
    advance(600 + 300 + 50);
    s = client.getSnapshot();
    assert.equal(s.search!.revealed, 1);
    assert.equal(s.search!.cells[0]!.kind, "item");
    room.stealLoot(0);
    s = client.getSnapshot();
    assert.equal(s.search!.cells[0]!.kind, "taken");
    assert.equal(client.take(0), "gone");
    assert.equal(client.take(2), "not_revealed");
  });

  it("corpse titles come from the corpse label", () => {
    const { room, client } = setup();
    room.openSearch("kz1", [fakeItem("junk_dogtag", { label: "Nick" })], 1500, "Nick");
    assert.equal(client.getSnapshot().search!.title, "Nick's body");
    assert.equal(client.getSnapshot().search!.kind, "corpse");
  });

  it("close hides the panel at once and sends SEARCH_CLOSE; Esc closes search before the inventory", () => {
    const { room, client, advance } = setup();
    client.setTabOpen(true);
    room.openSearch("c0", [fakeItem("junk_apple")], 600);
    assert.equal(client.escape(), true);
    assert.equal(client.getSnapshot().search, null);
    assert.equal(client.getSnapshot().visible, true, "Tab overlay stays");
    assert.equal(room.sent.at(-1)!.type, C2S.SEARCH_CLOSE);
    advance(100);
    assert.equal(room.me.searching, "");
    assert.equal(client.escape(), true);
    assert.equal(client.getSnapshot().visible, false);
    assert.equal(client.escape(), false);
  });
});

describe("ops", () => {
  it("take sends the stale guard, marks pending, ignores double clicks, clears on apply", () => {
    const { room, client, advance } = setup();
    const rifle = fakeItem("rifle", { uid: "U1" });
    room.openSearch("c0", [rifle], 0);
    advance(50 + 650 + 50);
    assert.equal(client.getSnapshot().search!.cells[0]!.kind, "item");
    assert.equal(client.take(0), null);
    const msg = room.sent.at(-1)!.msg as InvMoveMsg;
    assert.deepEqual(msg, { from: "loot", key: "0", uid: "U1", def: "rifle" });
    assert.equal(client.getSnapshot().pending["loot:0"], true);
    assert.equal(client.take(0), null);
    assert.equal(room.sent.filter((x) => x.type === C2S.INV_MOVE).length, 1, "double click sends once");
    advance(100);
    const s = client.getSnapshot();
    assert.equal(s.pending["loot:0"], undefined);
    assert.equal(s.slots.w1!.uid, "U1");
    assert.equal(s.search!.cells[0]!.kind, "taken");
  });

  it("refuses locally: wrong slot type, bag beyond capacity, non-empty backpack, expect mismatch", () => {
    const { room, client } = setup();
    room.me.slots.set("bp", fakeItem("backpack_1"));
    room.me.slots.set("b0", fakeItem("junk_apple"));
    room.me.slots.set("p0", fakeItem("rifle", { uid: "R" }));
    room.patch();
    const before = room.sent.length;
    assert.equal(client.move({ from: "self", key: "p0", to: "armor" }), "bad_slot");
    assert.equal(client.move({ from: "self", key: "p0", to: "b7" }), "bad_slot");
    assert.equal(client.move({ from: "self", key: "bp", to: "p1" }), "bp_not_empty");
    assert.equal(client.drop("bp"), "bp_not_empty");
    assert.equal(client.move({ from: "self", key: "p0", to: "w1", expect: { uid: "OTHER", def: "rifle" } }), "gone");
    assert.equal(client.move({ from: "self", key: "p3", to: "w1" }), "gone");
    assert.equal(room.sent.length, before, "nothing sent");
    assert.equal(client.getSnapshot().toast!.code, "gone");
  });

  it("targeted move, drop and the server error path", () => {
    const { room, client, advance } = setup();
    room.me.slots.set("p0", fakeItem("rifle", { uid: "R" }));
    room.me.slots.set("p1", fakeItem("junk_bolts", { qty: 3 }));
    room.patch();
    assert.equal(client.move({ from: "self", key: "p0", to: "w2" }), null);
    assert.equal(client.drop("p1", 1), null);
    assert.deepEqual(room.sent.at(-1), { type: C2S.INV_DROP, msg: { key: "p1", uid: "", def: "junk_bolts", qty: 1 } });
    advance(100);
    const s = client.getSnapshot();
    assert.equal(s.slots.w2!.uid, "R");
    assert.equal(s.slots.p1!.qty, 2);
    assert.deepEqual(s.pending, {});
  });

  it("INV_ERR clears pending and raises a toast that expires", () => {
    const { room, client, advance } = setup();
    room.me.slots.set("p0", fakeItem("junk_apple"));
    room.patch();
    room.latencyMs = 10_000; // the op never applies…
    client.move({ from: "self", key: "p0", to: "p1" });
    assert.equal(client.getSnapshot().pending["self:p0"], true);
    // …the server answers with an error instead.
    (room as unknown as { err: (c: string, x?: object) => void }).err("full", { taken: 2 });
    let s = client.getSnapshot();
    assert.deepEqual(s.pending, {});
    assert.equal(s.toast!.text, "Took 2 — no room for the rest");
    advance(TOAST_TTL_MS + 100);
    s = client.getSnapshot();
    assert.equal(s.toast, null);
  });

  it("pending expires when the server ignores the op", () => {
    const { room, client, advance } = setup();
    room.me.slots.set("p0", fakeItem("junk_apple"));
    room.patch();
    room.latencyMs = 100_000;
    client.move({ from: "self", key: "p0", to: "p1" });
    advance(PENDING_TIMEOUT_MS + 600);
    assert.deepEqual(client.getSnapshot().pending, {});
  });

  it("take all: no-op until something takeable is revealed, then one message", () => {
    const { room, client, advance } = setup();
    room.openSearch("c0", [fakeItem("junk_apple", { qty: 2 }), fakeItem("bandage", { qty: 1 })], 0);
    advance(50);
    const n0 = room.sent.length;
    assert.equal(client.takeAll(), null);
    assert.equal(room.sent.length, n0, "nothing revealed yet");
    advance(800);
    assert.equal(client.takeAll(), null);
    assert.equal(room.sent.at(-1)!.type, C2S.INV_TAKE_ALL);
    assert.equal(client.getSnapshot().pending["loot:*"], true);
    advance(100);
    const s = client.getSnapshot();
    assert.equal(s.search!.takeable, 0);
    assert.ok(Object.values(s.slots).some((i) => i.def === "junk_apple"));
  });

  it("Tab toggle closes the search too; dispose detaches", () => {
    const { room, client } = setup();
    room.openSearch("c0", [fakeItem("junk_apple")], 0);
    assert.equal(client.isBlocking(), true);
    client.toggle();
    assert.equal(client.isBlocking(), false);
    client.toggle();
    assert.equal(client.getSnapshot().tabOpen, true);
    client.dispose();
    const v = client.getSnapshot().version;
    room.me.slots.set("p0", fakeItem("junk_apple"));
    room.patch();
    assert.equal(client.getSnapshot().version, v);
  });
});

describe("makeBucket", () => {
  it("allows a burst then refills at the rate", () => {
    let t = 0;
    const b = makeBucket(15, 20, () => t);
    let ok = 0;
    for (let i = 0; i < 30; i++) if (b()) ok++;
    assert.equal(ok, 20);
    t += 1000;
    ok = 0;
    for (let i = 0; i < 30; i++) if (b()) ok++;
    assert.equal(ok, 15);
  });
});
