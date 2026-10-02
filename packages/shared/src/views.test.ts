/**
 * StateView leak tests for the v2 schema layout (critique: required, "views.test.ts").
 * Real @colyseus/schema Encoder / StateView / Decoder, driven the way Colyseus 0.16's
 * SchemaSerializer does it (encodeAll + encodeAllView on join, encode + encodeView per patch), no
 * sockets. Ported from the scratchpad probes (fuzz2.ts, fow/probe-nested.ts, view-test3.mjs).
 *
 * Invariants checked after EVERY patch, for every client:
 * - the decoded `self` map holds exactly the client's own key, and the decoder never holds a
 *   SelfState (or an InvItem) that does not belong to it or to a loot entry it is searching;
 * - `players` / `items` / `corpses` / `loot` hold exactly the entries in the client's view, with the
 *   server's values (so a Player removed from the view and mutated never reaches it);
 * - no "buffer overflow" warning and no decoder exception (the refId-not-found crash).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Decoder, Encoder, StateView } from "@colyseus/schema";
import { NET } from "./constants.js";
import { mulberry32 } from "./rng.js";
import {
  BattleState,
  ContainerLoot,
  Corpse,
  Extract,
  GroundItem,
  InvItem,
  Player,
  SelfState,
  containerLootKey,
  corpseLootKey,
  selfKeyOf,
} from "./schema.js";

Encoder.BUFFER_SIZE = NET.ENCODER_BUFFER_BYTES;

interface Client {
  roster: number;
  sid: string;
  selfKey: string;
  view: StateView;
  dec: Decoder<BattleState>;
  /** What the server put in this client's view (the expected decoded key sets). */
  visP: Set<string>;
  visI: Set<string>;
  visC: Set<string>;
  visL: Set<string>;
}

/** Captures console.warn/error from the schema library (overflow warnings, decode errors). */
function captureConsole() {
  const msgs: string[] = [];
  const w = console.warn, e = console.error;
  console.warn = (...a: unknown[]) => void msgs.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void msgs.push(a.map(String).join(" "));
  return { msgs, restore: () => { console.warn = w; console.error = e; } };
}

class Harness {
  readonly state = new BattleState();
  readonly enc: Encoder<BattleState>;
  readonly clients: Client[] = [];

  constructor() {
    this.enc = new Encoder(this.state);
  }

  /** Join / reconnect: fresh view with the self entry first, then own player, then `alsoSee`. */
  join(roster: number, alsoSee: { players?: string[]; items?: string[]; corpses?: string[]; loot?: string[] } = {}): Client {
    const sid = `s${roster}`, selfKey = selfKeyOf(roster);
    const view = new StateView();
    const c: Client = {
      roster, sid, selfKey, view, dec: new Decoder(new BattleState()),
      visP: new Set(), visI: new Set(), visC: new Set(), visL: new Set(),
    };
    view.add(this.state.self.get(selfKey)!);
    this.show(c, "players", sid);
    for (const k of alsoSee.players ?? []) this.show(c, "players", k);
    for (const k of alsoSee.items ?? []) this.show(c, "items", k);
    for (const k of alsoSee.corpses ?? []) this.show(c, "corpses", k);
    for (const k of alsoSee.loot ?? []) this.show(c, "loot", k);
    const it = { offset: 0 };
    this.enc.encodeAll(it);
    const shared = it.offset;
    c.dec.decode(this.enc.encodeAllView(view, shared, { ...it }));
    const old = this.clients.findIndex((x) => x.roster === roster);
    if (old >= 0) this.clients.splice(old, 1);
    this.clients.push(c);
    return c;
  }

  show(c: Client, map: "players" | "items" | "corpses" | "loot", key: string): void {
    const ref = (this.state[map] as unknown as Map<string, object>).get(key);
    if (!ref) return;
    c.view.add(ref as never);
    this.vis(c, map).add(key);
  }

  hide(c: Client, map: "players" | "items" | "corpses" | "loot", key: string): void {
    const ref = (this.state[map] as unknown as Map<string, object>).get(key);
    if (ref) c.view.remove(ref as never);
    this.vis(c, map).delete(key);
  }

  vis(c: Client, map: "players" | "items" | "corpses" | "loot"): Set<string> {
    return map === "players" ? c.visP : map === "items" ? c.visI : map === "corpses" ? c.visC : c.visL;
  }

  /** Deleting an entry from the state removes it from every view implicitly. */
  deleteEntry(map: "players" | "items" | "corpses" | "loot", key: string): void {
    (this.state[map] as unknown as Map<string, object>).delete(key);
    for (const c of this.clients) this.vis(c, map).delete(key);
  }

  patch(): void {
    const it = { offset: 0 };
    this.enc.encode(it);
    const shared = it.offset;
    for (const c of this.clients) c.dec.decode(this.enc.encodeView(c.view, shared, it));
    this.enc.discardChanges();
  }

  verify(where: string): void {
    for (const c of this.clients) verifyClient(this.state, c, `${where} ${c.selfKey}`);
  }
}

const itemSig = (i: InvItem | undefined) => (i ? `${i.uid}|${i.def}|${i.qty}|${i.rarity}|${i.dur}|${i.mag}|${i.flags}|${i.label}|${i.lvl}|${i.ref}` : "-");
const slotsSig = (m: Map<string, InvItem>) => [...m.keys()].sort().map((k) => `${k}=${itemSig(m.get(k))}`).join(",");
const keys = (m: { keys(): IterableIterator<string> }) => [...m.keys()].sort().join(",");
const setKeys = (s: Set<string>) => [...s].sort().join(",");

function verifyClient(st: BattleState, c: Client, where: string): void {
  const ds = c.dec.state;
  // --- self: exactly my own entry, with my server values.
  assert.equal(keys(ds.self), c.selfKey, `${where}: self keys`);
  const mine = st.self.get(c.selfKey)!, got = ds.self.get(c.selfKey)!;
  for (const f of ["userId", "lastSeq", "rollLeft", "rollCd", "rollDx", "rollDy", "walking", "searching", "kills", "extractMask"] as const) {
    assert.equal(got[f], mine[f], `${where}: self.${f}`);
  }
  assert.equal(slotsSig(got.slots as never), slotsSig(mine.slots as never), `${where}: own slots`);
  // --- filtered maps: exactly the view, with server values.
  assert.equal(keys(ds.players), setKeys(c.visP), `${where}: players`);
  for (const k of c.visP) {
    const a = st.players.get(k)!, b = ds.players.get(k)!;
    assert.deepEqual([b.x, b.y, b.hp, b.act, b.weapon, b.bp, b.alive], [a.x, a.y, a.hp, a.act, a.weapon, a.bp, a.alive], `${where}: player ${k}`);
  }
  assert.equal(keys(ds.items), setKeys(c.visI), `${where}: items`);
  for (const k of c.visI) assert.equal(ds.items.get(k)!.qty, st.items.get(k)!.qty, `${where}: item ${k}`);
  assert.equal(keys(ds.corpses), setKeys(c.visC), `${where}: corpses`);
  for (const k of c.visC) assert.equal(ds.corpses.get(k)!.opened, st.corpses.get(k)!.opened, `${where}: corpse ${k}`);
  assert.equal(keys(ds.loot), setKeys(c.visL), `${where}: loot`);
  for (const k of c.visL) {
    const a = st.loot.get(k)!, b = ds.loot.get(k)!;
    assert.deepEqual([b.total, b.revealed, b.nextRevealAt], [a.total, a.revealed, a.nextRevealAt], `${where}: loot ${k}`);
    assert.equal(slotsSig(b.slots as never), slotsSig(a.slots as never), `${where}: loot ${k} slots`);
  }
  // --- unfiltered state.
  assert.deepEqual([...ds.containerState], [...st.containerState], `${where}: containerState`);
  assert.equal(keys(ds.extracts), keys(st.extracts), `${where}: extracts`);
  assert.equal(ds.clockMs, st.clockMs);
  // --- nothing private hides in the decoder's reference table either (detached but decoded refs).
  const allowedItems = new Set<unknown>([...got.slots.values()]);
  for (const l of ds.loot.values()) for (const i of l.slots.values()) allowedItems.add(i);
  for (const ref of c.dec.root.refs.values()) {
    if (ref instanceof SelfState) assert.equal(ref, got, `${where}: a foreign SelfState was decoded`);
    if (ref instanceof InvItem) assert.ok(allowedItems.has(ref), `${where}: a foreign InvItem was decoded (${ref.def})`);
  }
}

const inv = (uid: string, def: string, qty = 1, extra: Partial<InvItem> = {}) => Object.assign(new InvItem(), { uid, def, qty, ...extra });

function seedWorld(h: Harness, players: number) {
  const st = h.state;
  st.matchId = "m1";
  for (let i = 0; i < 400; i++) st.containerState.push(0);
  for (let i = 0; i < 8; i++) st.extracts.set(`e${i}`, Object.assign(new Extract(), { id: `e${i}`, x: i * 100, y: 50, r: 110 }));
  for (let r = 0; r < players; r++) {
    st.players.set(`s${r}`, Object.assign(new Player(), { sessionId: `s${r}`, nickname: `n${r}`, x: r * 10, y: 0 }));
    const self = Object.assign(new SelfState(), { userId: `user${r}`, side: r % 4, extractMask: 0b1010 });
    self.slots.set("w1", inv(`rifle-${r}`, "rifle", 1, { mag: 30, dur: 90 }));
    self.slots.set("p0", inv("", "ammo_light", 60));
    self.slots.set("p1", inv("", "bandage", 3));
    st.self.set(selfKeyOf(r), self);
  }
  for (let i = 0; i < 40; i++) st.items.set(`i${i}`, Object.assign(new GroundItem(), { id: `i${i}`, def: "ammo_light", x: i, qty: 30 }));
}

test("fuzz: 2 clients + late joiner + reconnect never decode another player's private state", () => {
  const cap = captureConsole();
  try {
    const h = new Harness();
    const st = h.state;
    const PLAYERS = 6; // rosters 0..5; 2..5 are bots until roster 2 joins late
    seedWorld(h, PLAYERS);
    h.join(0);
    h.join(1, { players: ["s1"] });
    h.verify("join");
    const rng = mulberry32(2026);
    const pick = <T>(a: readonly T[]): T | undefined => a[Math.floor(rng() * a.length)];
    let nextItem = 40, nextCorpse = 0, uid = 0;
    const DEFS = ["junk_apple", "junk_gpu", "bandage", "ammo_light", "armor_1", "backpack_2", "junk_dogtag"];
    for (let tick = 1; tick <= 2500; tick++) {
      st.clockMs = tick * 50;
      // --- public player churn (incl. bots no one controls).
      for (const p of st.players.values()) {
        p.x = Math.round(rng() * 24_576);
        p.y = Math.round(rng() * 24_576);
        if (rng() < 0.2) p.hp = Math.floor(rng() * 100);
        if (rng() < 0.1) p.act = Math.floor(rng() * 64);
        if (rng() < 0.05) p.weapon = pick(["rifle", "pistol", "sniper", ""])!;
        if (rng() < 0.02) p.bp = Math.floor(rng() * 4);
      }
      // --- private churn: every self entry, including ones only the server should know.
      for (const s of st.self.values()) {
        s.lastSeq++;
        if (rng() < 0.3) s.rollCd = Math.floor(rng() * 150);
        if (rng() < 0.1) { s.rollLeft = Math.floor(rng() * 10); s.rollDx = rng(); s.rollDy = -rng(); }
        if (rng() < 0.2) s.walking = !s.walking;
        if (rng() < 0.05) s.kills++;
        const ammo = s.slots.get("p0");
        if (ammo && rng() < 0.4) ammo.qty = Math.max(1, ammo.qty - 1);
        const w = s.slots.get("w1");
        if (w && rng() < 0.3) w.mag = Math.floor(rng() * 30);
        if (rng() < 0.15) {
          const k = pick(["p2", "p3", "b0", "b1", "b2", "armor", "bp"])!;
          if (s.slots.has(k) && rng() < 0.5) s.slots.delete(k);
          else s.slots.set(k, inv(`u${uid++}`, pick(DEFS)!, 1 + Math.floor(rng() * 3), { label: rng() < 0.1 ? "bob" : "" }));
        }
        if (rng() < 0.03) s.slots.set("w1", inv(`u${uid++}`, "sniper", 1, { mag: 5 })); // swap instance in place
      }
      // --- ground items, corpses and searches.
      if (rng() < 0.3) {
        const k = pick([...st.items.keys()]);
        if (k) h.deleteEntry("items", k);
      }
      if (rng() < 0.3) st.items.set(`i${nextItem}`, Object.assign(new GroundItem(), { id: `i${nextItem++}`, def: pick(DEFS)!, qty: 1 }));
      if (rng() < 0.2) {
        const g = pick([...st.items.values()]);
        if (g) g.qty = (g.qty % 60) + 1;
      }
      if (rng() < 0.02) {
        const id = `c${nextCorpse++}`;
        st.corpses.set(id, Object.assign(new Corpse(), { id, label: "bob", x: rng() * 1000 }));
        const loot = new ContainerLoot();
        loot.total = 6;
        st.loot.set(corpseLootKey(id), loot);
      }
      if (rng() < 0.03) {
        const idx = Math.floor(rng() * 400);
        if (!st.loot.has(containerLootKey(idx))) {
          const loot = new ContainerLoot();
          loot.total = 1 + Math.floor(rng() * 8);
          st.loot.set(containerLootKey(idx), loot);
          st.containerState[idx] = 1;
        }
      }
      for (const [k, l] of st.loot) {
        if (l.revealed < l.total && rng() < 0.3) {
          l.slots.set(String(l.revealed), inv(`u${uid++}`, pick(DEFS)!, 1));
          l.revealed++;
          l.nextRevealAt = st.clockMs + 450;
        }
        if (rng() < 0.05) {
          // A take: the item instance moves out of the container into someone's bag.
          const sk = pick([...l.slots.keys()]);
          const taker = st.self.get(selfKeyOf(Math.floor(rng() * PLAYERS)))!;
          if (sk) {
            const item = l.slots.get(sk)!;
            l.slots.delete(sk);
            taker.slots.set(pick(["p2", "p3", "b4"])!, inv(item.uid, item.def, item.qty));
          }
        }
        if (rng() < 0.005) {
          h.deleteEntry("loot", k); // deleted while someone may be viewing it
          if (k.startsWith("c")) st.containerState[Number(k.slice(1))] = 2;
        }
      }
      if (rng() < 0.01) {
        const k = pick([...st.corpses.keys()]);
        if (k) { h.deleteEntry("corpses", k); h.deleteEntry("loot", corpseLootKey(k)); }
      }
      // --- view changes (fog of war, AOI, open/close search).
      for (const c of h.clients) {
        for (const sid of st.players.keys()) {
          if (sid === c.sid || rng() > 0.1) continue;
          if (c.visP.has(sid)) h.hide(c, "players", sid); else h.show(c, "players", sid);
        }
        for (const k of st.items.keys()) {
          if (rng() > 0.03) continue;
          if (c.visI.has(k)) h.hide(c, "items", k); else h.show(c, "items", k);
        }
        for (const k of st.corpses.keys()) {
          if (rng() > 0.05) continue;
          if (c.visC.has(k)) h.hide(c, "corpses", k); else h.show(c, "corpses", k);
        }
        for (const k of st.loot.keys()) {
          if (rng() > 0.04) continue;
          if (c.visL.has(k)) { h.hide(c, "loot", k); st.self.get(c.selfKey)!.searching = ""; }
          else { h.show(c, "loot", k); st.self.get(c.selfKey)!.searching = k; }
        }
      }
      // --- a late joiner (bot slot 2 becomes human), then a reconnect of roster 0.
      if (tick === 700) {
        h.patch();
        h.join(2, { players: [...st.players.keys()].slice(0, 3), items: [...st.items.keys()].slice(0, 5) });
      }
      if (tick === 1500) {
        h.patch();
        const old = h.clients.find((c) => c.roster === 0)!;
        h.join(0, { players: [...old.visP], items: [...old.visI], corpses: [...old.visC], loot: [...old.visL] });
      }
      h.patch();
      h.verify(`tick ${tick}`);
    }
    assert.equal(h.clients.length, 3);
    assert.deepEqual(cap.msgs.filter((m) => /overflow|refId|error/i.test(m)), []);
  } finally {
    cap.restore();
  }
});

test("regression: open → take → close → mutate → reopen, and delete while viewed (refId-not-found crash)", () => {
  const cap = captureConsole();
  try {
    const h = new Harness();
    const st = h.state;
    seedWorld(h, 2);
    const loot = new ContainerLoot();
    loot.total = 4;
    for (let i = 0; i < 4; i++) loot.slots.set(String(i), inv(`k${i}`, "junk_bolts", i + 1));
    loot.revealed = 4;
    st.loot.set("k7", loot);
    const a = h.join(0), b = h.join(1);
    h.show(a, "loot", "k7");
    h.show(b, "loot", "k7");
    h.patch();
    h.verify("both open");
    // A takes the same InvItem instance (moved, not cloned) into their bag.
    const moved = loot.slots.get("2")!;
    loot.slots.delete("2");
    st.self.get("p0")!.slots.set("p3", moved);
    h.patch();
    h.verify("take");
    h.hide(b, "loot", "k7");
    h.patch();
    loot.slots.get("3")!.qty = 99;
    loot.slots.delete("0");
    loot.nextRevealAt = 1234;
    h.patch();
    h.verify("mutate while B is away");
    h.show(b, "loot", "k7");
    h.patch();
    h.verify("B reopens");
    h.deleteEntry("loot", "k7");
    h.patch();
    h.verify("deleted while viewed");
    assert.equal(b.dec.state.loot.size, 0);
    // The fog pattern on the public map: remove from view, mutate, re-add.
    h.show(a, "players", "s1");
    h.patch();
    h.hide(a, "players", "s1");
    st.players.get("s1")!.x = 777;
    st.players.get("s1")!.weapon = "sniper";
    h.patch();
    h.verify("hidden + mutated");
    assert.equal(a.dec.state.players.has("s1"), false);
    h.show(a, "players", "s1");
    h.patch();
    h.verify("re-added");
    assert.equal(a.dec.state.players.get("s1")!.x, 777);
    assert.deepEqual(cap.msgs.filter((m) => /overflow|refId|error/i.test(m)), []);
  } finally {
    cap.restore();
  }
});

test("32 clients that all see each other fit the 128 KB encoder buffer without overflow warnings", () => {
  const cap = captureConsole();
  try {
    const h = new Harness();
    seedWorld(h, 32);
    // Joins are staggered by at least one patch, as in a real room. NOTE for the server: Colyseus
    // re-sends a view's join-time adds on the next patch (view.changes survive encodeAllView), so
    // 32 simultaneous joins that each see everything need ~136 KB once — a warning + slow path,
    // not a correctness problem.
    for (let r = 0; r < 32; r++) {
      h.join(r, { players: [...h.state.players.keys()], items: [...h.state.items.keys()] });
      h.patch();
    }
    for (let t = 0; t < 20; t++) {
      for (const p of h.state.players.values()) { p.x += 1; p.aim += 0.1; }
      for (const s of h.state.self.values()) s.lastSeq++;
      h.patch();
    }
    h.verify("32 players");
    assert.deepEqual(cap.msgs.filter((m) => /overflow/i.test(m)), []);
  } finally {
    cap.restore();
  }
});
