/**
 * Search sessions through a real @colyseus/schema Encoder / Decoder / StateView (driven like
 * Colyseus 0.16's SchemaSerializer, same harness as views.test.ts). Checks after every patch, per
 * client: the decoded `loot` map holds exactly the entries of the targets this client is a READY
 * searcher of, with the server's revealed items; no other ContainerLoot / InvItem ever reaches the
 * decoder (no ESP of container contents). Also the regression for the measured decoder crash
 * ("refId not found"): entries leave and re-enter a view while they keep being mutated.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Decoder, Encoder, StateView } from "@colyseus/schema";
import { BattleState, ContainerLoot, InvItem, NET, SERVER_TICK_MS, mulberry32, type ContainerSpot } from "@extract/shared";
import { takeAll, takeFromLoot } from "./containers.js";
import { killPlayer } from "./death.js";
import { makeItem } from "./items.js";
import { Match } from "./match.js";
import { counterUid, testMap } from "./test-utils.js";
import { ViewSync } from "./views.js";

Encoder.BUFFER_SIZE = NET.ENCODER_BUFFER_BYTES;

interface Conn {
  roster: number;
  sid: string;
  view: StateView;
  dec: Decoder<BattleState>;
}

class Room {
  readonly enc: Encoder<BattleState>;
  readonly views: ViewSync;
  conns: Conn[] = [];
  constructor(readonly m: Match) {
    this.enc = new Encoder(m.state);
    this.views = new ViewSync(m);
  }
  join(userId: string, sid: string): Conn {
    const rt = this.m.attachHuman(userId, sid)!;
    const view = new StateView();
    this.views.attach(rt.rosterIndex, view);
    const c: Conn = { roster: rt.rosterIndex, sid, view, dec: new Decoder(new BattleState()) };
    const it = { offset: 0 };
    this.enc.encodeAll(it);
    c.dec.decode(this.enc.encodeAllView(view, it.offset, { ...it }));
    this.conns = [...this.conns.filter((x) => x.roster !== c.roster), c];
    return c;
  }
  tick(n = 1): void {
    for (let i = 0; i < n; i++) {
      this.m.step(SERVER_TICK_MS);
      this.flush();
    }
  }
  /** Room order: drained view events → syncViews → encode per view. */
  flush(): void {
    for (const ev of this.m.drainEvents()) if (ev.type === "view") this.views.applyLoot(ev.to, ev.op, ev.key);
    this.views.sync();
    const it = { offset: 0 };
    this.enc.encode(it);
    const shared = it.offset;
    for (const c of this.conns) c.dec.decode(this.enc.encodeView(c.view, shared, it));
    this.enc.discardChanges();
    for (const c of this.conns) verify(this, c);
  }
}

const sig = (slots: Map<string, InvItem>) => [...slots.entries()].map(([k, i]) => `${k}:${i.def}:${i.qty}:${i.uid}:${i.mag}`).sort().join(",");

function verify(r: Room, c: Conn): void {
  const m = r.m;
  const rt = m.rosterRuntime(c.roster)!;
  const ds = c.dec.state;
  const mine = [...m.containers.targets.values()].filter((t) => t.ready.has(rt)).map((t) => t.key).sort();
  assert.deepEqual([...ds.loot.keys()].sort(), mine, `p${c.roster}: decoded loot keys = targets it is a ready searcher of`);
  const allowed = new Set<InvItem>(ds.self.get(rt.selfKey)?.slots.values() ?? []);
  const allowedLoot = new Set<ContainerLoot>();
  for (const key of mine) {
    const got = ds.loot.get(key)!;
    const want = m.state.loot.get(key)!;
    allowedLoot.add(got);
    assert.equal(got.revealed, want.revealed, `${key}: revealed`);
    assert.equal(got.total, want.total, `${key}: total`);
    assert.equal(sig(got.slots as never), sig(want.slots as never), `${key}: revealed slots`);
    for (const it of got.slots.values()) allowed.add(it);
  }
  for (const ref of c.dec.root.refs.values()) {
    if (ref instanceof ContainerLoot) assert.ok(allowedLoot.has(ref), `p${c.roster}: a foreign ContainerLoot was decoded`);
    if (ref instanceof InvItem) assert.ok(allowed.has(ref), `p${c.roster}: a foreign InvItem was decoded (${ref.def})`);
  }
}

const CRATE: ContainerSpot = { x: 1200, y: 1100, kind: "weapon_box", tier: 4, zone: null };

test("loot entries reach only ready searchers; leave / re-enter / mutate never breaks a decoder", () => {
  const warns: string[] = [];
  const w = console.warn;
  console.warn = (...a: unknown[]) => void warns.push(a.map(String).join(" "));
  try {
    const m = new Match({
      roster: [
        { userId: "u0", nickname: "A", isBot: false },
        { userId: "u1", nickname: "B", isBot: false },
        { userId: "u2", nickname: "C", isBot: false },
      ],
      rng: mulberry32(8), map: testMap({ containers: [CRATE] }), newUid: counterUid, now: () => 1_700_000_000_000,
      emptyWorld: true, strictLedger: true, npcBrains: false, envSeed: 1, weatherOverride: "clear",
    });
    m.containers.roll = () => {
      const out = [
        makeItem("rifle", { uid: m.newUid(), rarity: 2, mag: 9 }),
        makeItem("ammo_heavy", { qty: 20 }),
        makeItem("junk_gpu"),
        makeItem("junk_apple", { qty: 4 }),
        makeItem("armor_2", { uid: m.newUid() }),
      ];
      for (const it of out) if (it.uid) m.ledger.register(it, "minted");
      return out;
    };
    const r = new Room(m);
    const a = r.join("u0", "sA");
    r.join("u1", "sB");
    const c = r.join("u2", "sC");
    const [A, B, C] = m.allRuntimes();
    A!.pub.x = 1150; A!.pub.y = 1100;
    B!.pub.x = 1250; B!.pub.y = 1100;
    C!.pub.x = 1200; C!.pub.y = 1160;
    r.flush();

    assert.ok(m.interact("sA"));
    r.tick(10);
    assert.equal(a.dec.state.loot.size, 0, "not before the open delay");
    r.tick(40);
    assert.ok(a.dec.state.loot.has("c0"));
    r.tick(20);
    assert.ok(a.dec.state.loot.get("c0")!.revealed >= 1);

    // B joins the search; A takes while B is still waiting for its delay.
    assert.ok(m.interact("sB"));
    const first = m.state.loot.get("c0")!.slots.get("0")!;
    assert.equal(takeFromLoot(m, A!, { from: "loot", key: "0", uid: first.uid, def: first.def }), null);
    r.flush();
    // A closes (leaves its view), B keeps the reveal going: the entry mutates while A cannot see it.
    m.searchClose("sA");
    r.tick(60);
    assert.equal(a.dec.state.loot.size, 0);
    assert.ok(m.state.loot.get("c0")!.revealed >= 3);
    // A re-opens: delay, then the current state again (no stale or crashing refs).
    assert.ok(m.interact("sA"));
    r.tick(40);
    assert.ok(a.dec.state.loot.has("c0"));
    assert.ok(takeAll(m, B!).taken >= 1, "B takes what fits");
    r.flush();
    r.tick(40);
    r.flush();
    // The crate is emptied by now or soon; both close, A re-opens once more and leaves by walking.
    m.searchClose("sB");
    A!.pub.x = 1600;
    r.tick(2);
    assert.equal(a.dec.state.loot.size, 0, "walked out of range");

    // A dies next to C: C searches the body; B (not searching) never sees its contents.
    A!.pub.x = 1200; A!.pub.y = 1200;
    killPlayer(m, A!, B!, "rifle");
    r.tick();
    assert.equal(c.dec.state.corpses.size, 1);
    assert.ok(m.interact("sC"));
    r.tick(120);
    const key = `k${A!.rosterIndex}`;
    assert.ok(c.dec.state.loot.has(key));
    assert.ok(c.dec.state.loot.get(key)!.slots.size >= 1, "dog tag at least");
    assert.equal(takeAll(m, C!).code, null);
    r.tick(2);
    assert.equal(m.containers.corpseOf(A!.rosterIndex)!.emptied, true);
    assert.equal(c.dec.state.corpses.get(String(A!.rosterIndex))!.empty, false, "public only once the searcher left (disclosure.ts)");
    assert.ok([...c.dec.state.self.get(C!.selfKey)!.slots.values()].some((i) => i.def === "junk_dogtag"));
    // Reconnect of C: fresh view and decoder, search closed by the detach.
    r.views.detach(C!.rosterIndex, c.view);
    m.detach("sC");
    r.conns = r.conns.filter((x) => x !== c);
    const c2 = r.join("u2", "sC2");
    r.tick(5);
    assert.equal(c2.dec.state.loot.size, 0);
  } finally {
    console.warn = w;
  }
  assert.deepEqual(warns.filter((x) => /overflow|refId/i.test(x)), []);
});

test("a reconnect while the old socket is still open keeps the ready search's loot entry in the new view", () => {
  const m = new Match({
    roster: [{ userId: "u0", nickname: "A", isBot: false }],
    rng: mulberry32(3), map: testMap({ containers: [CRATE] }), newUid: counterUid, now: () => 1_700_000_000_000,
    emptyWorld: true, strictLedger: true, npcBrains: false, envSeed: 1, weatherOverride: "clear",
  });
  m.containers.roll = () => [makeItem("junk_gpu"), makeItem("junk_apple", { qty: 2 })];
  const r = new Room(m);
  const a = r.join("u0", "s1");
  const [A] = m.allRuntimes();
  A!.pub.x = CRATE.x - 50; A!.pub.y = CRATE.y;
  assert.ok(m.interact("s1"));
  r.tick(60);
  assert.ok(a.dec.state.loot.has("c0"), "ready: the entry is in the first view");
  // Colyseus order on a reconnect from a new tab: the new join first; the old socket's leave then
  // returns early (it no longer owns the seat), so no detach / closeSearch ever runs.
  const b = r.join("u0", "s2");
  r.tick(2);
  assert.equal(A!.search?.key, "c0", "the session survived");
  assert.ok(b.dec.state.loot.has("c0"), "the new view got the loot entry back");
  assert.ok(m.interact("s2"), "F again stays a no-op on the same target");
  r.tick(2);
  assert.ok(b.dec.state.loot.has("c0"));
});
