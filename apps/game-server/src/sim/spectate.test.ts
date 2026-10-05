/**
 * Spectating a party mate (spectate.ts, ViewSync.mirror in views.ts): who may watch whom, the
 * spectator's decoded state = exactly the mate's view (players = the mate's published row, ring
 * entities the mate may know), its `ev` batch = the mate's world events, and the cleanup when the
 * mate goes down / out or the spectator stops. Real @colyseus/schema Encoder / Decoder per client,
 * tick order as in battle-room.ts (step → views.sync → patch).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Decoder, Encoder, StateView } from "@colyseus/schema";
import { BattleState, NET, SERVER_TICK_MS, SelfState, Player, type EventsMsg } from "@extract/shared";
import { killPlayer } from "./death.js";
import { extractPlayer } from "./extraction.js";
import type { Match } from "./match.js";
import { spectateEnd, spectateTarget, spectatorBatch } from "./spectate.js";
import type { PlayerRuntime } from "./types.js";
import { enter, jump, worldMatch, type WallClock } from "./test-utils.js";
import { ViewSync } from "./views.js";

Encoder.BUFFER_SIZE = NET.ENCODER_BUFFER_BYTES;

const P = "11111111-1111-4111-8111-111111111111";
const Q = "22222222-2222-4222-8222-222222222222";

interface Conn {
  rt: PlayerRuntime;
  view: StateView;
  dec: Decoder<BattleState>;
}

class Room {
  readonly enc: Encoder<BattleState>;
  readonly views: ViewSync;
  readonly conns = new Map<PlayerRuntime, Conn>();
  constructor(
    readonly m: Match,
    readonly wall: WallClock,
  ) {
    this.enc = new Encoder(m.state);
    this.views = new ViewSync(m);
  }
  join(rt: PlayerRuntime): Conn {
    const sid = `sid-${rt.selfKey}`;
    assert.ok(this.m.attachHuman(rt.userId!, sid), "attach");
    const view = new StateView();
    this.views.attach(rt.rosterIndex, view);
    const c: Conn = { rt, view, dec: new Decoder(new BattleState()) };
    const it = { offset: 0 };
    this.enc.encodeAll(it);
    c.dec.decode(this.enc.encodeAllView(view, it.offset, { ...it }));
    this.conns.set(rt, c);
    return c;
  }
  tick(n = 1): void {
    for (let k = 0; k < n; k++) {
      this.wall.t += SERVER_TICK_MS;
      this.m.step(SERVER_TICK_MS);
      for (const ev of this.m.drainEvents()) if (ev.type === "view") this.views.applyLoot(ev.to, ev.op, ev.key);
      this.views.sync();
      this.patch();
    }
  }
  /** Encode + decode one patch for every connection (also after a view change between ticks). */
  patch(): void {
    const it = { offset: 0 };
    this.enc.encode(it);
    const shared = it.offset;
    for (const c of this.conns.values()) c.dec.decode(this.enc.encodeView(c.view, shared, it));
    this.enc.discardChanges();
  }
}

const keys = (c: Conn, what: "players" | "corpses" | "items" | "self") => [...c.dec.state[what].keys()].sort();

/** No SelfState but its own, no Player outside its players map, in the decoder. */
function noForeignRefs(c: Conn, where: string) {
  const own = c.dec.state.self.get(c.rt.selfKey);
  const players = new Set<unknown>([...c.dec.state.players.values()]);
  for (const ref of c.dec.root.refs.values()) {
    if (ref instanceof SelfState) assert.equal(ref, own, `${where}: a foreign SelfState was decoded`);
    if (ref instanceof Player) assert.ok(players.has(ref), `${where}: an invisible Player is alive in the decoder`);
  }
}

/**
 * A (party P) dies far west; B (party P) stands east facing east with C (solo) in front of it and D
 * (solo) behind it; E is in another party. Everyone connected.
 */
function setup() {
  const { m, wall } = worldMatch();
  jump(m, wall, 1_000);
  const A = enter(m, "a", { partyId: P });
  const B = enter(m, "b", { partyId: P });
  const C = enter(m, "c");
  const D = enter(m, "d");
  const E = enter(m, "e", { partyId: Q });
  const put = (rt: PlayerRuntime, x: number, y: number, aim = 0) => {
    rt.pub.x = x;
    rt.pub.y = y;
    rt.pub.aim = aim;
  };
  put(A, 800, 800);
  put(B, 3600, 3600, 0);
  put(C, 3900, 3600, Math.PI);
  put(D, 3200, 3600);
  put(E, 700, 3600);
  const r = new Room(m, wall);
  for (const rt of [A, B, C, D, E]) r.join(rt);
  r.tick(4);
  return { m, r, A, B, C, D, E };
}

test("spectate: only a dead / extracted member may watch a living mate of the same party", () => {
  const { m, r, A, B, C, D, E } = setup();
  // Alive members are refused, whoever they ask for.
  assert.deepEqual(spectateTarget(m, A.rosterIndex, B.selfKey), { ok: false, reason: "not_out" });
  assert.deepEqual(spectateTarget(m, B.rosterIndex, A.selfKey), { ok: false, reason: "not_out" });

  killPlayer(m, A, null, "");
  killPlayer(m, D, null, "");
  killPlayer(m, E, null, "");
  r.tick(2);
  const ok = spectateTarget(m, A.rosterIndex, B.selfKey);
  assert.ok(ok.ok && ok.target === B, "dead A may watch living mate B");
  // Not a mate: a solo raider, another party, yourself, garbage keys.
  assert.deepEqual(spectateTarget(m, A.rosterIndex, C.selfKey), { ok: false, reason: "not_mate" });
  assert.deepEqual(spectateTarget(m, A.rosterIndex, A.selfKey), { ok: false, reason: "not_mate" });
  assert.deepEqual(spectateTarget(m, A.rosterIndex, { key: B.selfKey }), { ok: false, reason: "not_mate" });
  assert.deepEqual(spectateTarget(m, A.rosterIndex, "p999"), { ok: false, reason: "not_mate" });
  assert.deepEqual(spectateTarget(m, E.rosterIndex, B.selfKey), { ok: false, reason: "not_mate" });
  // Without a party there is nobody to watch.
  assert.deepEqual(spectateTarget(m, D.rosterIndex, B.selfKey), { ok: false, reason: "no_party" });
  // A dead mate cannot be watched.
  const A2 = enter(m, "a2", { partyId: P });
  r.join(A2);
  killPlayer(m, A2, null, "");
  r.tick(1);
  assert.deepEqual(spectateTarget(m, A.rosterIndex, A2.selfKey), { ok: false, reason: "mate_gone" });
  // An older entry of a user who came back in is not "out of the run" any more.
  const A3 = enter(m, "a", { partyId: P });
  assert.equal(m.currentOf("a"), A3);
  assert.deepEqual(spectateTarget(m, A.rosterIndex, B.selfKey), { ok: false, reason: "not_out" });
});

test("spectate: the spectator's decoded view mirrors the mate's visible set, never more, and is released on stop", () => {
  const { m, r, A, B, C, D } = setup();
  const a = r.conns.get(A)!;
  const b = r.conns.get(B)!;
  killPlayer(m, A, null, "");
  r.tick(2);
  assert.deepEqual(keys(a, "players"), [A.id], "dead: nobody else in view");
  const before = new Set([...keys(a, "corpses"), ...keys(a, "items")]);

  // F dies in front of B (a corpse in B's ring, far outside A's frozen ring).
  const F = enter(m, "f");
  F.pub.x = 4100;
  F.pub.y = 3800;
  r.join(F);
  r.tick(3);
  killPlayer(m, F, null, "");
  r.tick(2);
  const fCorpse = keys(b, "corpses").filter((k) => !before.has(k));
  assert.equal(fCorpse.length, 1, "B decodes F's corpse");
  assert.ok(!keys(a, "corpses").includes(fCorpse[0]!), "A does not, yet");

  assert.equal(r.views.mirror(A.rosterIndex, B.rosterIndex), true);
  r.patch();
  r.tick(2);
  const check = (where: string) => {
    const want = new Set([A.id, ...keys(b, "players")]);
    assert.deepEqual(keys(a, "players"), [...want].sort(), `${where}: A's players = B's players + A`);
    assert.deepEqual(keys(b, "players"), [B.id, ...m.vision.row(B.rosterIndex).map((j) => m.rosterRuntime(j)!.id)].sort(), `${where}: B = its row`);
    assert.deepEqual(keys(a, "self"), [A.selfKey], `${where}: A decodes only its own self entry`);
    noForeignRefs(a, where);
    // Ring entities: everything A gained is something B decodes.
    const bAll = new Set([...keys(b, "corpses"), ...keys(b, "items")]);
    for (const k of [...keys(a, "corpses"), ...keys(a, "items")]) assert.ok(before.has(k) || bAll.has(k), `${where}: A decodes ${k} that B does not`);
  };
  check("mirror");
  assert.ok(keys(a, "players").includes(C.id), "C stands in front of B: A sees C through B");
  assert.ok(!keys(a, "players").includes(D.id), "D stands behind B: hidden from B and A");
  assert.ok(keys(a, "corpses").includes(fCorpse[0]!), "F's corpse reaches A through B's ring");

  // C walks out of B's sight: it leaves A's view with B's (vision hysteresis included).
  C.pub.x = 3600;
  C.pub.y = 4500;
  r.tick(12);
  assert.ok(!keys(b, "players").includes(C.id));
  check("after C left");

  // Stop: back to the dead view, the mirrored ring entities leave too.
  r.views.unmirror(A.rosterIndex);
  r.patch();
  assert.equal(r.views.mirrorOf(A.rosterIndex), undefined);
  assert.deepEqual(keys(a, "players"), [A.id]);
  assert.ok(!keys(a, "corpses").includes(fCorpse[0]!), "mirrored corpse removed");
  r.tick(2);
  assert.deepEqual(keys(a, "players"), [A.id]);
  noForeignRefs(a, "after stop");
});

test("spectate: ends one tick after the mate dies (final patch first), on extraction, and when the spectator leaves", () => {
  {
    const { m, r, A, B } = setup();
    killPlayer(m, A, null, "");
    r.tick(2);
    r.views.mirror(A.rosterIndex, B.rosterIndex);
    r.tick(1);
    assert.equal(spectateEnd(m, A.rosterIndex, B.rosterIndex), null);
    killPlayer(m, B, null, "");
    assert.equal(spectateEnd(m, A.rosterIndex, B.rosterIndex), null, "the death tick still shows the mate");
    r.views.sync();
    r.patch();
    const a = r.conns.get(A)!;
    assert.equal(a.dec.state.players.get(B.id)?.alive, false, "A decodes B's fall");
    r.tick(1);
    assert.equal(spectateEnd(m, A.rosterIndex, B.rosterIndex), "mate_down");
    r.views.unmirror(A.rosterIndex);
    r.patch();
    assert.deepEqual(keys(a, "players"), [A.id]);
  }
  {
    const { m, r, A, B } = setup();
    extractPlayer(m, A);
    r.tick(2);
    const ok = spectateTarget(m, A.rosterIndex, B.selfKey);
    assert.ok(ok.ok, "an extracted member may watch too");
    r.views.mirror(A.rosterIndex, B.rosterIndex);
    extractPlayer(m, B);
    r.tick(2);
    assert.equal(spectateEnd(m, A.rosterIndex, B.rosterIndex), "mate_out");
    // The spectator's connection goes away: the mirror is dropped with its view.
    r.views.detach(A.rosterIndex, r.conns.get(A)!.view);
    assert.equal(r.views.mirrorOf(A.rosterIndex), undefined);
  }
  {
    const { m, r, A, B } = setup();
    killPlayer(m, A, null, "");
    r.tick(2);
    m.wipe();
    r.tick(1);
    assert.equal(spectateEnd(m, A.rosterIndex, B.rosterIndex), "wipe");
    assert.deepEqual(spectateTarget(m, A.rosterIndex, B.selfKey), { ok: false, reason: "ended" });
  }
});

test("spectatorBatch: the mate's world events, the spectator's own kill feed and XP", () => {
  const own: EventsMsg = {
    kills: [{ killer: "X", killerId: "x", victim: "A", victimId: "a", weapon: "rifle" } as never],
    xp: [{ k: "kill", xp: 10, n: 1 } as never],
    snd: { h: [1, 2, 3, 0] },
  };
  const mate: EventsMsg = {
    shots: [{ s: "b", w: "rifle", x: 1, y: 2, cx: 1, cy: 2, a: [0] }],
    hits: [{ t: "c", s: "b", x: 1, y: 1, d: 10, ar: false }],
    snd: { v: [1, 0, 0] as never },
    kills: [{ killer: "B", killerId: "b", victim: "M", victimId: "m", weapon: "rifle", victimRole: 2 } as never],
    xp: [{ k: "npc", xp: 20, n: 1 } as never],
    fight: [3, 1],
  };
  const out = spectatorBatch(own, mate)!;
  assert.equal(out.shots, mate.shots);
  assert.equal(out.hits, mate.hits);
  assert.equal(out.snd, mate.snd, "sounds as heard by the mate");
  assert.equal(out.fight, mate.fight);
  assert.equal(out.kills, own.kills, "the mate's personal NPC kill rows stay the mate's");
  assert.equal(out.xp, own.xp, "XP is never mirrored");
  assert.equal(spectatorBatch(undefined, undefined), undefined);
  assert.deepEqual(spectatorBatch({ snd: { h: [1] } }, undefined), undefined, "the spectator's own world events are gone");
});
