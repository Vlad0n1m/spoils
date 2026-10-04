/**
 * Security audit "StateView patch overflow": a pile of thousands of ground items entering one view
 * in a single tick used to overflow the shared encoder buffer, and every client encoded after the
 * attacker lost its patch for good (HP, moves, adds; later "refId not found"). Driven like the room
 * (views.test.ts harness): Match.step → ViewSync.sync → encode + encodeView per client, attacker first.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Decoder, Encoder, StateView } from "@colyseus/schema";
import { BattleState, NET, SERVER_TICK_MS } from "@extract/shared";
import { isolateViewPatches } from "../rooms/view-patches.js";
import { makeItem } from "./items.js";
import type { Match } from "./match.js";
import { ids, place, rtOf, testMatch } from "./test-utils.js";

/** Move a joined client's player (its runtime is re-keyed to the session id on attach). */
function moveTo(m: Match, c: Conn, x: number, y: number): void {
  const p = m.rosterRuntime(c.roster)!.pub;
  p.x = x;
  p.y = y;
}

function hpOf(m: Match, c: Conn): number {
  return m.rosterRuntime(c.roster)!.pub.hp;
}
import { VIEW_ADDS_PER_TICK, ViewSync } from "./views.js";

Encoder.BUFFER_SIZE = NET.ENCODER_BUFFER_BYTES;

const PILE = 3000;

interface Conn {
  roster: number;
  view: StateView;
  dec: Decoder<BattleState>;
}

function setup(): { m: Match; a: string; b: string } {
  const m = testMatch(2);
  const [a, b] = ids(m) as [string, string];
  // A starts far from the pile (another AOI ring), B is in neither ring.
  place(m, a, 400, 400);
  place(m, b, 4400, 400);
  for (let i = 0; i < PILE; i++) m.ground.add(m, makeItem("ammo_light", { qty: 1 }), 4200 + (i % 60) * 6, 4200 + Math.floor(i / 60) * 6);
  return { m, a, b };
}

function join(m: Match, enc: Encoder<BattleState>, views: ViewSync, id: string): Conn {
  const userId = rtOf(m, id).userId!;
  const rt = m.attachHuman(userId, `s-${id}`)!;
  const view = new StateView();
  views.attach(rt.rosterIndex, view);
  const c: Conn = { roster: rt.rosterIndex, view, dec: new Decoder(new BattleState()) };
  const it = { offset: 0 };
  enc.encodeAll(it);
  c.dec.decode(enc.encodeAllView(view, it.offset, { ...it }));
  return c;
}

/** One room tick; returns the patch size of each connection (encoded in the given order). */
function tick(m: Match, enc: Encoder<BattleState>, views: ViewSync, conns: Conn[], decode = true): number[] {
  m.step(SERVER_TICK_MS);
  m.drainEvents();
  views.sync();
  const it = { offset: 0 };
  enc.encode(it);
  const shared = it.offset;
  const sizes = conns.map((c) => {
    const bytes = enc.encodeView(c.view, shared, it);
    if (decode) c.dec.decode(bytes);
    return bytes.length;
  });
  enc.discardChanges();
  return sizes;
}

test("a view gets at most VIEW_ADDS_PER_TICK AOI adds per tick; a huge pile streams in and nobody else's patch is hurt", () => {
  const { m, a, b } = setup();
  const enc = new Encoder(m.state);
  const views = new ViewSync(m);
  const ca = join(m, enc, views, a);
  const cb = join(m, enc, views, b);
  tick(m, enc, views, [ca, cb]);
  assert.equal(ca.dec.state.items.size, 0, "the pile is outside A's ring");

  // A steps into the pile's ring (one cell crossing) while B takes damage in the same tick.
  moveTo(m, ca, 3500, 3900); // in the pile's ring, not on it (no auto-pickup)
  m.rosterRuntime(cb.roster)!.pub.hp = 55;
  const [sa] = tick(m, enc, views, [ca, cb]);
  assert.ok(sa! < 32 * 1024, `A's patch stays small (${sa} B)`);
  assert.equal(ca.dec.state.items.size, VIEW_ADDS_PER_TICK, "only the per-tick budget arrived");
  assert.equal(views.pendingAdds(ca.roster), PILE - VIEW_ADDS_PER_TICK);
  assert.equal(hpOf(m, cb), 55);
  assert.equal(cb.dec.state.players.get(`s-${b}`)?.hp, 55, "B's own patch decoded whole");

  for (let i = 0; i < Math.ceil(PILE / VIEW_ADDS_PER_TICK) && views.pendingAdds(ca.roster) > 0; i++) tick(m, enc, views, [ca, cb]);
  assert.equal(views.pendingAdds(ca.roster), 0);
  assert.equal(ca.dec.state.items.size, PILE, "the whole pile arrived over the next ticks");

  // Walking back out removes everything at once.
  moveTo(m, ca, 400, 400);
  tick(m, enc, views, [ca, cb]);
  assert.equal(ca.dec.state.items.size, 0);
});

test("a pending add is dropped when the entity leaves the ring or is picked up before its turn", () => {
  const { m, a, b } = setup();
  const enc = new Encoder(m.state);
  const views = new ViewSync(m);
  const ca = join(m, enc, views, a);
  const cb = join(m, enc, views, b);
  moveTo(m, ca, 3500, 3900); // in the pile's ring, not on it (no auto-pickup)
  tick(m, enc, views, [ca, cb]);
  assert.ok(views.pendingAdds(ca.roster) > 0);
  // Every remaining item vanishes from the server (expiry, pickups) before it was sent.
  for (const g of [...m.ground.all()]) if (!ca.view.has(g.schema)) m.ground.remove(m, g.schema.id);
  tick(m, enc, views, [ca, cb]);
  assert.equal(views.pendingAdds(ca.roster), 0);
  assert.equal(ca.dec.state.items.size, VIEW_ADDS_PER_TICK, "only what was already sent");
});

test("encoder isolation: an oversized view spoils only its own patch, never the clients encoded after it", () => {
  const prev = Encoder.BUFFER_SIZE;
  Encoder.BUFFER_SIZE = 16 * 1024;
  try {
    const { m, a, b } = setup();
    const enc = new Encoder(m.state);
    const overflowed: StateView[] = [];
    assert.equal(isolateViewPatches(enc, (v) => overflowed.push(v)), true);
    const views = new ViewSync(m);
    const ca = join(m, enc, views, a);
    const cb = join(m, enc, views, b);
    tick(m, enc, views, [ca, cb]);
    // Bypass the ViewSync budget: the whole pile lands in A's view at once (about 170 KB of adds).
    for (const g of m.ground.all()) ca.view.add(g.schema);
    m.rosterRuntime(cb.roster)!.pub.hp = 40;
    m.step(SERVER_TICK_MS);
    m.drainEvents();
    const it = { offset: 0 };
    enc.encode(it);
    const shared = it.offset;
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      enc.encodeView(ca.view, shared, it); // truncated: A rejoins in the room (RESYNC)
    } finally {
      console.warn = origWarn;
    }
    cb.dec.decode(enc.encodeView(cb.view, shared, it));
    enc.discardChanges();
    assert.deepEqual(overflowed, [ca.view], "the overflow is reported for A's view only");
    assert.equal(cb.dec.state.players.get(`s-${b}`)?.hp, 40, "B's patch is whole although A's overflowed before it");
  } finally {
    Encoder.BUFFER_SIZE = prev;
  }
});
