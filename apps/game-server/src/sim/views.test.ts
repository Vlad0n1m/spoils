/**
 * The room's StateView wiring and event routing on a real match, through a real @colyseus/schema
 * Encoder / Decoder per client (driven like Colyseus 0.16's SchemaSerializer: encodeAll +
 * encodeAllView on join, encode + encodeView per patch; harness ported from packages/shared
 * views.test.ts). Tick order as in battle-room.ts: step → syncViews → patch → `ev` batches.
 *
 * Checked after every patch, per client (critique: "Do not cut — the StateView private self map
 * plus the leak/fuzz tests; per-client event routing"):
 * - its own self entry decodes with the server values; NO other SelfState / InvItem ever reaches
 *   its decoder (loot entries it searches excepted);
 * - `players` holds exactly itself + its published vision row, with the server's values; no other
 *   Player instance is alive in the decoder (an invisible player is never decoded);
 * - `items` / `corpses` hold exactly the AOI ring;
 * - its `ev` batch names only players it decodes: shots with a shooter id, hit ids, chest `by`,
 *   visible sound entries; a clipped shot (s = "") never starts at a hidden shooter;
 * - no "buffer overflow" warning.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Decoder, Encoder, StateView } from "@colyseus/schema";
import {
  BattleState,
  ContainerLoot,
  InvItem,
  NET,
  Player,
  SERVER_TICK_MS,
  SelfState,
  VISION,
  decodeSoundMsg,
  mulberry32,
  type EventsMsg,
  type ShotMsg,
} from "@extract/shared";
import { AoiSystem } from "./aoi.js";
import { CLIP_BLUR, buildBatches } from "./audience.js";
import { Match } from "./match.js";
import { CLIP_MIN_PX } from "./spatial.js";
import { counterUid, giveWeapon, npcOpts, testMap, testPost } from "./test-utils.js";
import { ViewSync } from "./views.js";

Encoder.BUFFER_SIZE = NET.ENCODER_BUFFER_BYTES;

interface Conn {
  roster: number;
  sid: string;
  view: StateView;
  dec: Decoder<BattleState>;
  /** The `ev` batch of the last tick (undefined = nothing sent). */
  ev?: EventsMsg;
}

class Room {
  readonly enc: Encoder<BattleState>;
  readonly views: ViewSync;
  conns: Conn[] = [];
  /** Raw shots of the last tick (to check clipped copies against the real shooters). */
  rawShots: ShotMsg[] = [];
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
  tick(): void {
    this.m.step(SERVER_TICK_MS);
    const events = this.m.drainEvents();
    for (const ev of events) if (ev.type === "view") this.views.applyLoot(ev.to, ev.op, ev.key);
    this.views.sync();
    const it = { offset: 0 };
    this.enc.encode(it);
    const shared = it.offset;
    for (const c of this.conns) c.dec.decode(this.enc.encodeView(c.view, shared, it));
    this.enc.discardChanges();
    const batches = buildBatches(this.m, events, this.conns.map((c) => c.roster));
    for (const c of this.conns) c.ev = batches.get(c.roster);
    this.rawShots = events.flatMap((e) => (e.type === "shot" ? [e.msg] : []));
  }
}

/** Coverage counters: the scenario must actually exercise hiding, revealing and clipping. */
const seen = { hiddenPairs: 0, visiblePairs: 0, clipped: 0, fullShots: 0, hiddenSnd: 0, visibleSnd: 0 };

function verify(r: Room, c: Conn, where: string): void {
  const m = r.m;
  const st = m.state;
  const ds = c.dec.state;
  const me = m.rosterRuntime(c.roster)!;
  assert.deepEqual([...ds.self.keys()], [me.selfKey], `${where}: self keys`);
  const mine = st.self.get(me.selfKey)!, got = ds.self.get(me.selfKey)!;
  for (const f of ["userId", "lastSeq", "rollLeft", "rollCd", "walking", "kills", "active", "reloadUntil"] as const) {
    assert.equal(got[f], mine[f], `${where}: self.${f}`);
  }

  // Players: exactly self + the published row.
  const expectP = new Set([me.id, ...m.vision.row(c.roster).map((j) => m.rosterRuntime(j)!.id)]);
  assert.deepEqual([...ds.players.keys()].sort(), [...expectP].sort(), `${where}: players = self + vision row`);
  for (const rt of m.allRuntimes()) {
    if (rt === me) continue;
    if (expectP.has(rt.id)) seen.visiblePairs++;
    else seen.hiddenPairs++;
  }
  for (const k of expectP) {
    const p = st.players.get(k)!, d = ds.players.get(k)!;
    const hp = (v: number) => Math.round(v * 100) / 100;
    assert.deepEqual([d.x, d.y, hp(d.hp), d.weapon, d.act, d.alive], [p.x, p.y, hp(p.hp), p.weapon, p.act, p.alive], `${where}: player ${k}`);
  }

  // Ground items / corpses: exactly the AOI ring around the viewer.
  const ring = <T extends { x: number; y: number }>(map: Map<string, T>) =>
    [...map.entries()]
      .filter(([, e]) => AoiSystem.ringContains(me.pub.x, me.pub.y, e.x, e.y) && m.aoi.allowed(e as never, c.roster))
      .map(([k]) => k)
      .sort();
  assert.deepEqual([...ds.items.keys()].sort(), ring(st.items as never), `${where}: items = AOI ring`);
  assert.deepEqual([...ds.corpses.keys()].sort(), ring(st.corpses as never), `${where}: corpses = AOI ring`);
  assert.deepEqual([...ds.containerState], [...st.containerState], `${where}: containerState`);

  // Nothing foreign alive in the decoder.
  const lootItems = new Set<unknown>();
  for (const l of ds.loot.values()) for (const it of l.slots.values()) lootItems.add(it);
  const visibleP = new Set<unknown>([...ds.players.values()]);
  for (const ref of c.dec.root.refs.values()) {
    if (ref instanceof SelfState) assert.equal(ref, got, `${where}: a foreign SelfState was decoded`);
    if (ref instanceof InvItem) {
      assert.ok([...got.slots.values()].includes(ref) || lootItems.has(ref), `${where}: a foreign InvItem was decoded (${ref.def})`);
    }
    if (ref instanceof Player) assert.ok(visibleP.has(ref), `${where}: an invisible Player is alive in the decoder (${ref.sessionId})`);
    if (ref instanceof ContainerLoot) assert.ok([...ds.loot.values()].includes(ref), `${where}: stray loot entry`);
  }

  // Events name only players this client decodes.
  const known = (sid: string) => sid === "" || ds.players.has(sid);
  for (const s of c.ev?.shots ?? []) {
    assert.ok(known(s.s), `${where}: shot names a hidden shooter ${s.s}`);
    if (s.s !== "") {
      seen.fullShots++;
      continue;
    }
    seen.clipped++;
    assert.deepEqual([s.cx, s.cy], [s.x, s.y], `${where}: clipped shot carries no centre`);
    // Entry point on the view circle, shifted sideways by the tracer blur (audience.ts CLIP_BLUR).
    const onCircle = Math.abs(Math.hypot(s.x - me.pub.x, s.y - me.pub.y) - VISION.RANGE) <= CLIP_BLUR.MAX_SHIFT_PX + 1e-6;
    const fromShooter = Math.min(...r.rawShots.map((raw) => Math.hypot(raw.cx - s.x, raw.cy - s.y)));
    assert.ok(onCircle || fromShooter >= CLIP_MIN_PX - 1e-6, `${where}: clipped shot starts ${fromShooter.toFixed(1)} px from a hidden shooter`);
  }
  for (const h of c.ev?.hits ?? []) assert.ok(known(h.t) && known(h.s), `${where}: hit names a hidden player`);
  for (const ch of c.ev?.chest ?? []) assert.ok(ch.by === undefined || known(ch.by), `${where}: chest names a hidden opener`);
  for (const s of decodeSoundMsg(c.ev?.snd)) {
    if (s.hidden) seen.hiddenSnd++;
    else {
      seen.visibleSnd++;
      assert.ok(known(s.id), `${where}: visible sound from a player not in view (${s.id})`);
    }
  }
  if (c.ev?.snd?.h) for (const x of c.ev.snd.h) assert.ok(Number.isInteger(x) && x >= 0 && x < 16, `${where}: hidden sound field ${x}`);
}

test("two clients + a hidden third + a reconnect: no client decodes what it may not see", () => {
  const warns: string[] = [];
  const w = console.warn;
  console.warn = (...a: unknown[]) => void warns.push(a.map(String).join(" "));
  try {
    const m = new Match({
      roster: [
        { userId: "u0", nickname: "A", isBot: false },
        { userId: "u1", nickname: "B", isBot: false },
        // C never connects: driven by hand, it must stay invisible unless in a client's vision row.
        { userId: "u2", nickname: "C", isBot: false },
      ],
      // A marauder far away (roster index 3): an NPC, never a client.
      ...npcOpts([testPost(0, 3800, 3800)]),
      rng: mulberry32(8),
      map: testMap({
        walls: [{ x: 1300, y: 600, w: 24, h: 800 }],
        containers: [{ x: 1200, y: 1100, kind: "weapon_box", tier: 4, zone: null }],
      }),
      newUid: counterUid, now: () => 1_700_000_000_000, emptyWorld: true, strictLedger: true, npcBrains: false,
      envSeed: 2, weatherOverride: "clear",
    });
    const rt = (k: number) => m.rosterRuntime(k)!;
    const put = (k: number, x: number, y: number) => {
      rt(k).pub.x = x;
      rt(k).pub.y = y;
    };
    put(0, 1150, 1100);
    put(1, 1650, 1000);
    put(2, 1650, 1800);
    put(3, 3800, 3800);
    const r = new Room(m);
    let a = r.join("u0", "sA");
    r.join("u1", "sB");
    r.tick();
    for (const c of r.conns) verify(r, c, "join");
    giveWeapon(m, "sB", "w2", "rifle", 2);
    giveWeapon(m, "pending2", "w1", "rifle", 0);
    assert.ok(m.interact("sA"), "open the container next to A");

    const rng = mulberry32(3);
    const aimAt = (from: number, to: number) => Math.atan2(rt(to).pub.y - rt(from).pub.y, rt(to).pub.x - rt(from).pub.x);
    let seqA = 0, seqB = 0, seqC = 0;
    let aId = "sA";
    for (let t = 0; t < 400; t++) {
      // A strolls in circles left of the wall, sweeping its aim; it rolls now and then.
      m.enqueueInput(aId, { seq: ++seqA, mx: Math.cos(t / 20), my: Math.sin(t / 20), aim: t / 10, fire: false, roll: t % 90 === 5 });
      // B stands right of the wall and fires at A now and then.
      if (t % 3 === 0) m.enqueueInput("sB", { seq: ++seqB, mx: 0, my: 0, aim: aimAt(1, 0), fire: rng() < 0.5 });
      // C (never connected) paces below the wall's end and shoots at A.
      m.enqueueInput("pending2", { seq: ++seqC, mx: 0, my: Math.sin(t / 15), aim: aimAt(2, 0) + (rng() - 0.5) * 0.3, fire: t % 7 === 0 });
      if (t === 60) m.switchSlot("sB", "w2");
      if (t === 120) m.invDrop(aId, { key: "p1", uid: "", def: "bandage" });
      if (t === 200) {
        // A reconnects: new session, new decoder, fresh view.
        r.conns = r.conns.filter((c) => c !== a);
        r.views.detach(a.roster, a.view);
        m.detach(aId);
        aId = "sA2";
        a = r.join("u0", aId);
        seqA = 0;
        verify(r, a, "reconnect");
        continue;
      }
      r.tick();
      for (const c of r.conns) verify(r, c, `tick ${t}`);
      if (!rt(0).pub.alive) break;
    }
    assert.ok(seen.hiddenPairs > 0 && seen.visiblePairs > 0, `players were both hidden and visible ${JSON.stringify(seen)}`);
    assert.ok(seen.fullShots > 0, `some shots were routed in full ${JSON.stringify(seen)}`);
    assert.ok(seen.hiddenSnd > 0, `hidden sounds were delivered ${JSON.stringify(seen)}`);
    assert.ok(seen.clipped > 0, `C's shots reached A clipped ${JSON.stringify(seen)}`);
  } finally {
    console.warn = w;
  }
  assert.deepEqual(warns.filter((x) => /overflow/i.test(x)), []);
});

test("behind a wall: neither client decodes the other, and footsteps arrive as hidden sounds with a sector", () => {
  const m = new Match({
    roster: [
      { userId: "u0", nickname: "A", isBot: false },
      { userId: "u1", nickname: "B", isBot: false },
    ],
    rng: mulberry32(1),
    map: testMap({ walls: [{ x: 1300, y: 600, w: 24, h: 800 }] }),
    newUid: counterUid, now: () => 0, emptyWorld: true, strictLedger: true, npcBrains: false,
    envSeed: 2, weatherOverride: "clear",
  });
  m.rosterRuntime(0)!.pub.x = 1000;
  m.rosterRuntime(0)!.pub.y = 1000;
  // ≤ 410 px through one wall: × OCCLUSION_MULT ≈ 655 < 680 (run step 800 × grass 0.85) → audible.
  m.rosterRuntime(1)!.pub.x = 1370;
  m.rosterRuntime(1)!.pub.y = 1000;
  const r = new Room(m);
  const a = r.join("u0", "sA");
  const b = r.join("u1", "sB");
  const sectors = new Set<number>();
  let seq = 0, seqB = 0;
  for (let t = 0; t < 100; t++) {
    // Face each other through the wall; A paces up and down.
    m.enqueueInput("sA", { seq: ++seq, mx: 0, my: t % 40 < 20 ? 1 : -1, aim: 0, fire: false });
    m.enqueueInput("sB", { seq: ++seqB, mx: 0, my: 0, aim: Math.PI, fire: false });
    r.tick();
    verify(r, a, `wall ${t}`);
    verify(r, b, `wall ${t}`);
    assert.deepEqual([...a.dec.state.players.keys()], ["sA"]);
    assert.deepEqual([...b.dec.state.players.keys()], ["sB"]);
    for (const s of decodeSoundMsg(b.ev?.snd)) {
      assert.ok(s.hidden, "a hidden source");
      if (s.hidden) {
        sectors.add(s.a);
        assert.ok(s.occluded, "through the wall");
      }
    }
  }
  assert.ok(sectors.size > 0, "B heard A's footsteps");
  for (const s of sectors) assert.ok(s === 8 || s === 7 || s === 9, `west of B: sector ${s}`);
});
