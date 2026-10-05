/**
 * Parties on a shard (shared party.ts, C10b): the drop spawn group (spawn.ts pickDropSpawn /
 * partySpawnNear), no friendly fire (combat.ts / death.ts) and S2C.PARTY positions (party.ts).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { PARTY, PLAYER, WEAPONS, mulberry32, resolveCircle, walkCellOf, type MapData } from "@extract/shared";
import { damagePlayer } from "./combat.js";
import { killPlayer } from "./death.js";
import { extractPlayer } from "./extraction.js";
import type { Match } from "./match.js";
import { mapRuntime } from "./nav.js";
import { MATE_DOWN_MS, partyPositions } from "./party.js";
import { PARTY_SPAWN_GAP_PX, PARTY_SPAWN_MAX_PX, PARTY_SPAWN_MIN_PX, SPAWN_TOP_SHARE, partySpawnNear } from "./spawn.js";
import type { PlayerRuntime } from "./types.js";
import { enter, ids, jump, pl, place, rtOf, run, testMap, testMatch, worldMatch } from "./test-utils.js";

const P = "11111111-1111-4111-8111-111111111111";
const Q = "22222222-2222-4222-8222-222222222222";
const D = "33333333-3333-4333-8333-333333333333";

/** A spot a raider may stand on: a free walk cell, and no solid pushes a player circle there. */
function assertClear(m: Pick<Match, "mapRt" | "idx">, x: number, y: number, what: string) {
  const walk = m.mapRt.walk;
  assert.equal(walk.blocked[walkCellOf(walk, x, y)], 0, `${what}: on a walkable cell`);
  const r = resolveCircle(m.idx, x, y, PLAYER.RADIUS);
  assert.ok(Math.abs(r.x - x) < 1e-6 && Math.abs(r.y - y) < 1e-6, `${what}: not inside a solid`);
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

// ---------------------------------------------------------------- spawn group

test("party drop: the first member anchors; later members land 150–300 px from it on clear cells, apart, on its side", () => {
  const spread = () => {
    const { m, wall } = worldMatch();
    jump(m, wall, 1_000);
    const lead = enter(m, "lead", { partyId: P, dropId: D });
    jump(m, wall, 20_000);
    const mates = ["m1", "m2", "m3"].map((u) => enter(m, u, { partyId: P, dropId: D }));
    return { m, lead, mates };
  };
  const { m, lead, mates } = spread();
  const anchor = { x: lead.pub.x, y: lead.pub.y };
  assert.ok(m.entrySpots().some((s) => s.x === anchor.x && s.y === anchor.y), "the first member takes a normal entry spot");
  assert.equal(m.partyDrops.get(D)?.partyId, P);
  const all = [lead, ...mates];
  for (const rt of mates) {
    const d = dist(rt.pub, anchor);
    assert.ok(d >= PARTY_SPAWN_MIN_PX && d <= PARTY_SPAWN_MAX_PX, `${rt.nickname} ${d.toFixed(0)} px from the anchor`);
    assertClear(m, rt.pub.x, rt.pub.y, rt.nickname);
    assert.equal(rt.self.side, lead.self.side, "same side as the anchor");
    assert.equal(rt.self.extractMask, lead.self.extractMask, "same extracts as the anchor");
    assert.equal(rt.partyId, P);
    assert.equal(rt.dropId, D);
  }
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) assert.ok(dist(all[i]!.pub, all[j]!.pub) >= PARTY_SPAWN_GAP_PX, "members never stack");
  }
  // Deterministic: the same drop spreads the same way on an identical shard.
  const again = spread();
  assert.deepEqual(again.mates.map((r) => [r.pub.x, r.pub.y]), mates.map((r) => [r.pub.x, r.pub.y]));
});

test("party drop: after PARTY.DROP_TTL_MS a member spawns normally (new anchor); another party's ticket never joins the drop", () => {
  const { m, wall } = worldMatch();
  jump(m, wall, 1_000);
  const lead = enter(m, "lead", { partyId: P, dropId: D });
  const at = m.partyDrops.get(D)!.at;
  // Same dropId, other party: a normal entry spot, the drop untouched.
  const stranger = enter(m, "stranger", { partyId: Q, dropId: D });
  assert.ok(m.entrySpots().some((s) => s.x === stranger.pub.x && s.y === stranger.pub.y));
  assert.equal(m.partyDrops.get(D)!.spots.length, 1);
  // A dropId without a partyId is a solo entry.
  const lone = enter(m, "lone", { dropId: D });
  assert.equal(lone.partyId, "");
  assert.equal(lone.dropId, "");
  assert.equal(m.partyDrops.get(D)!.spots.length, 1);

  jump(m, wall, PARTY.DROP_TTL_MS + 1_000);
  const late = enter(m, "late", { partyId: P, dropId: D });
  assert.ok(m.entrySpots().some((s) => s.x === late.pub.x && s.y === late.pub.y), "a normal entry spot");
  assert.ok(m.partyDrops.get(D)!.at > at, "the late member anchors anyone after them");
  assert.equal(late.partyId, P, "still a party member (no friendly fire, positions)");
  assert.ok(lead.pub.alive);
});

test("party drop: a late member lands at the landing zone, even when the first member walked off or died", () => {
  const { m, wall } = worldMatch();
  jump(m, wall, 1_000);
  const lead = enter(m, "lead", { partyId: P, dropId: D });
  const first = { x: lead.pub.x, y: lead.pub.y };
  // The leader walked 2500 px off along the long axis before the member followed (within the window).
  const nx = first.x < m.map.width / 2 ? first.x + 2500 : first.x - 2500;
  place(m, lead.id, nx, first.y);
  jump(m, wall, 50_000);
  const late = enter(m, "m1", { partyId: P, dropId: D });
  const d = dist(late.pub, first);
  assert.ok(d >= PARTY_SPAWN_MIN_PX && d <= PARTY_SPAWN_MAX_PX, `${d.toFixed(0)} px from the landing zone`);
  assertClear(m, late.pub.x, late.pub.y, "late member");
  assert.equal(late.self.side, lead.self.side);
  assert.equal(late.self.extractMask, lead.self.extractMask);
  // Nobody of the drop alive any more: still the landing zone, apart from the spots handed out.
  killPlayer(m, lead, null, "");
  killPlayer(m, late, null, "");
  const third = enter(m, "m2", { partyId: P, dropId: D });
  const d2 = dist(third.pub, first);
  assert.ok(d2 >= PARTY_SPAWN_MIN_PX && d2 <= PARTY_SPAWN_MAX_PX, `${d2.toFixed(0)} px from the landing zone`);
  assert.ok(dist(third.pub, late.pub) >= PARTY_SPAWN_GAP_PX, "apart from the earlier member's spot");
  assert.equal(third.self.side, lead.self.side);
});

test("party drop: strangers near the landing zone never split the drop (same area, same side, every seed)", () => {
  for (let seed = 1; seed <= 24; seed++) {
    const { m, wall } = worldMatch({ rng: mulberry32(seed) });
    jump(m, wall, 1_000);
    // A busy shard: raiders already on the map (the test map's spawns all sit within ~1000 px).
    for (let i = 0; i < 6; i++) enter(m, `s${seed}-${i}`);
    jump(m, wall, 6_000);
    const lead = enter(m, "lead", { partyId: P, dropId: D });
    const zone = { x: lead.pub.x, y: lead.pub.y };
    // One of them walks right up to the landing zone, another member is a few seconds late.
    const killer = enter(m, "killer");
    place(m, killer.id, zone.x + 120, zone.y);
    jump(m, wall, 3_000);
    const mates = ["m1", "m2", "m3"].map((u) => enter(m, u, { partyId: P, dropId: D }));
    for (const rt of mates) {
      const d = dist(rt.pub, zone);
      assert.ok(d >= PARTY_SPAWN_MIN_PX && d <= PARTY_SPAWN_MAX_PX, `seed ${seed} ${rt.nickname}: ${d.toFixed(0)} px from the landing zone`);
      assertClear(m, rt.pub.x, rt.pub.y, `seed ${seed} ${rt.nickname}`);
      assert.equal(rt.self.side, lead.self.side, `seed ${seed}: same side`);
      assert.equal(rt.self.extractMask, lead.self.extractMask, `seed ${seed}: same extracts`);
    }
    assert.equal(m.partyDrops.get(D)!.spots.length, 4);
  }
});

test("party drop: the landing zone avoids the party's own bodies; a member who re-enters within the window spawns normally", () => {
  // A mate died earlier this cycle: the drop's landing zone keeps off that body like off the opener's own.
  {
    const { m, wall } = worldMatch();
    jump(m, wall, 1_000);
    const mate = enter(m, "m1", { partyId: P });
    killPlayer(m, mate, null, "");
    const body = { x: mate.pub.x, y: mate.pub.y };
    jump(m, wall, 10_000);
    const lead = enter(m, "lead", { partyId: P, dropId: D });
    const ds = m.entrySpots().map((s) => dist(s, body)).sort((a, b) => b - a);
    const cut = ds[Math.max(1, Math.ceil(ds.length * SPAWN_TOP_SHARE)) - 1]!;
    assert.ok(dist(lead.pub, body) >= cut, `${dist(lead.pub, body).toFixed(0)} px from the mate's body (top share from ${cut.toFixed(0)})`);
  }
  // The leader died at the drop and re-enters within the window: never next to their own body.
  {
    const { m, wall } = worldMatch();
    jump(m, wall, 1_000);
    const lead = enter(m, "lead", { partyId: P, dropId: D });
    const mate = enter(m, "m1", { partyId: P, dropId: D });
    killPlayer(m, lead, null, "");
    const body = { x: lead.pub.x, y: lead.pub.y };
    jump(m, wall, 10_000);
    const spots = m.partyDrops.get(D)!.spots.length;
    const again = enter(m, "lead", { partyId: P, dropId: D });
    assert.ok(m.entrySpots().some((s) => s.x === again.pub.x && s.y === again.pub.y), "a normal entry spot");
    assert.ok(dist(again.pub, body) > PARTY_SPAWN_MAX_PX, `${dist(again.pub, body).toFixed(0)} px from the own body`);
    assert.equal(m.partyDrops.get(D)!.spots.length, spots, "the drop hands out no spot");
    assert.ok(mate.pub.alive);
  }
});

test("party drop: solo raiders and party members outside the drop keep the normal entry spawn", () => {
  const solo = () => {
    const { m, wall } = worldMatch();
    jump(m, wall, 1_000);
    return { m, wall };
  };
  // The same shard with and without an open drop elsewhere hands a solo raider a normal entry spot.
  const a = solo();
  const plain = enter(a.m, "solo");
  assert.ok(a.m.entrySpots().some((s) => s.x === plain.pub.x && s.y === plain.pub.y && s.side === plain.self.side));
  assert.equal(plain.partyId, "");
  assert.equal(plain.dropId, "");
  const b = solo();
  const lead = enter(b.m, "lead", { partyId: P, dropId: D });
  const s2 = enter(b.m, "solo");
  assert.ok(b.m.entrySpots().some((s) => s.x === s2.pub.x && s.y === s2.pub.y && s.side === s2.self.side), "a normal entry spot");
  assert.ok(dist(s2.pub, lead.pub) >= PARTY_SPAWN_GAP_PX);
  // A party member whose ticket follows no drop (pressed PLAY after it expired) spawns normally too.
  const own = enter(b.m, "m9", { partyId: P });
  assert.ok(b.m.entrySpots().some((s) => s.x === own.pub.x && s.y === own.pub.y), "a normal entry spot");
  assert.equal(own.dropId, "");
  assert.equal(b.m.partyDrops.get(D)!.spots.length, 1, "the drop hands out nothing to entries outside it");
});

/** The open test arena plus a closed 500 × 500 room (32 px walls) at (2000, 2000). */
function roomMap(size = 500): { map: MapData; inner: { x0: number; y0: number; x1: number; y1: number } } {
  const x = 2000, y = 2000, t = 32;
  const map = testMap({
    walls: [
      { x, y, w: size, h: t },
      { x, y: y + size - t, w: size, h: t },
      { x, y, w: t, h: size },
      { x: x + size - t, y, w: t, h: size },
    ],
  });
  return { map, inner: { x0: x + t, y0: y + t, x1: x + size - t, y1: y + size - t } };
}

test("partySpawnNear: never behind a wall it cannot walk around (anchor's walk component), never inside one", () => {
  const { map, inner } = roomMap();
  const rt = mapRuntime(map);
  const sp = { walk: rt.walk, regions: rt.regions, idx: rt.idx, width: map.width, height: map.height };
  // Near the west wall: the ring reaches well outside the room, but only the inside is reachable.
  const anchor = { x: inner.x0 + 60, y: (inner.y0 + inner.y1) / 2 };
  const taken = [anchor];
  for (let slot = 1; slot <= 3; slot++) {
    const p = partySpawnNear(sp, anchor, slot, taken);
    assert.ok(p.x > inner.x0 && p.x < inner.x1 && p.y > inner.y0 && p.y < inner.y1, `slot ${slot} inside the room`);
    const d = dist(p, anchor);
    assert.ok(d >= PARTY_SPAWN_MIN_PX && d <= PARTY_SPAWN_MAX_PX, `slot ${slot}: ${d.toFixed(0)} px`);
    assertClear({ mapRt: rt, idx: rt.idx } as Pick<Match, "mapRt" | "idx">, p.x, p.y, `slot ${slot}`);
    for (const q of taken) assert.ok(dist(p, q) >= PARTY_SPAWN_GAP_PX);
    taken.push(p);
  }
  // A room too small for the ring: the nearest free cell inside it, still apart from the anchor.
  const small = roomMap(220);
  const srt = mapRuntime(small.map);
  const ssp = { walk: srt.walk, regions: srt.regions, idx: srt.idx, width: small.map.width, height: small.map.height };
  const sa = { x: 2110, y: 2110 };
  const p = partySpawnNear(ssp, sa, 1, [sa]);
  assert.ok(p.x > small.inner.x0 && p.x < small.inner.x1 && p.y > small.inner.y0 && p.y < small.inner.y1, "inside the small room");
  assert.ok(dist(p, sa) >= PARTY_SPAWN_GAP_PX);
  assertClear({ mapRt: srt, idx: srt.idx } as Pick<Match, "mapRt" | "idx">, p.x, p.y, "small room");
});

// ---------------------------------------------------------------- friendly fire

function party(m: Match, partyId: string, ...rts: PlayerRuntime[]) {
  for (const rt of rts) rt.partyId = partyId;
}

test("no friendly fire: a bullet passes through party mates to whoever stands behind; outsiders still hit mates", () => {
  const m = testMatch(3);
  const [a, b, c] = ids(m);
  party(m, P, rtOf(m, a!), rtOf(m, b!));
  place(m, a!, 1000, 1500);
  place(m, b!, 1150, 1500);
  place(m, c!, 1300, 1500);
  const ev = run(m, 400, { [a!]: { aim: 0, fire: true } });
  const hits = ev.filter((e) => e.type === "hit");
  assert.equal(hits.length, 1, "one hit, on the outsider behind the mate");
  assert.ok(hits[0]!.type === "hit" && hits[0]!.target === rtOf(m, c!).rosterIndex);
  assert.equal(pl(m, b!).hp, PLAYER.MAX_HP, "the mate in the line of fire is untouched");
  assert.equal(pl(m, c!).hp, PLAYER.MAX_HP - WEAPONS.pistol.damage);
  assert.equal(rtOf(m, a!).stats.dmgDealt, WEAPONS.pistol.damage, "no damage dealt to the mate");

  // The outsider shoots back: the first mate in line is hit as usual.
  const back = run(m, 400, { [c!]: { aim: Math.PI, fire: true } });
  assert.equal(back.filter((e) => e.type === "hit").length, 1);
  assert.equal(pl(m, b!).hp, PLAYER.MAX_HP - WEAPONS.pistol.damage);
});

test("no friendly fire: damagePlayer refuses mate damage (HP, armor); a mate kill credits nothing", () => {
  const { m, wall } = worldMatch();
  jump(m, wall, 1_000);
  const a = enter(m, "a", { partyId: P });
  const b = enter(m, "b", { partyId: P });
  const o = enter(m, "o", { partyId: Q });
  place(m, a.id, 1500, 1500);
  place(m, b.id, 1560, 1500);
  place(m, o.id, 1500, 1560);
  m.drainEvents();
  damagePlayer(m, b, 80, a, "rifle", 0, 0);
  assert.equal(b.pub.hp, PLAYER.MAX_HP);
  assert.equal(b.lastHitBy, null);
  assert.equal(m.drainEvents().filter((e) => e.type === "hit").length, 0, "no hit marker, no damage arc");
  // Another party is not a mate.
  damagePlayer(m, b, 20, o, "rifle", 0, 0);
  assert.equal(b.pub.hp, PLAYER.MAX_HP - 20);
  // Even if a mate ends up as the killer (a future damage path), no kill / victims / dog tag credit.
  killPlayer(m, b, a, "rifle");
  assert.equal(b.pub.alive, false);
  assert.equal(a.self.kills, 0);
  assert.deepEqual(a.victims, []);
  assert.equal(b.killerUserId, null, "the dog tag never pays a mate the killer's price");
  // An outsider's kill still credits.
  killPlayer(m, a, o, "rifle");
  assert.equal(o.self.kills, 1);
  assert.deepEqual(o.victims, ["a"]);
  assert.equal(a.killerUserId, "o");
});

// ---------------------------------------------------------------- S2C.PARTY

test("S2C.PARTY: each member gets only their mates (key, id, name, position, alive); solo players and lone members get nothing", () => {
  const { m, wall } = worldMatch();
  jump(m, wall, 1_000);
  const a = enter(m, "a", { partyId: P });
  const b = enter(m, "b", { partyId: P });
  const c = enter(m, "c", { partyId: Q }); // their mate is not on this shard
  const s = enter(m, "solo");
  place(m, b.id, 1234.6, 2001.2);
  let out = partyPositions(m);
  assert.deepEqual([...out.keys()].sort(), [a.rosterIndex, b.rosterIndex].sort());
  assert.deepEqual(out.get(a.rosterIndex), { mates: [{ key: b.selfKey, id: b.id, name: "B", x: 1235, y: 2001, alive: true }] });
  assert.deepEqual(out.get(b.rosterIndex)!.mates.map((x) => x.key), [a.selfKey]);
  assert.equal(out.has(c.rosterIndex), false);
  assert.equal(out.has(s.rosterIndex), false);

  // A dead mate stays listed (alive: false, at the body) for MATE_DOWN_MS, then drops out.
  killPlayer(m, b, null, "");
  out = partyPositions(m);
  assert.deepEqual(out.get(a.rosterIndex)!.mates.map((x) => [x.key, x.alive]), [[b.selfKey, false]]);
  assert.deepEqual(out.get(b.rosterIndex)!.mates.map((x) => x.key), [a.selfKey], "the dead member still sees the living one");
  jump(m, wall, MATE_DOWN_MS + 1_000);
  out = partyPositions(m);
  assert.equal(out.has(a.rosterIndex), false);
  // The member re-enters (a new runtime of the same party): only the new one is listed.
  const b2 = enter(m, "b", { partyId: P });
  out = partyPositions(m);
  assert.deepEqual(out.get(a.rosterIndex)!.mates.map((x) => x.key), [b2.selfKey]);
  assert.equal(out.has(b.rosterIndex), false, "an older entry of a user is never a recipient");
  // An extracted mate is gone at once.
  extractPlayer(m, a);
  out = partyPositions(m);
  assert.equal(out.has(b2.rosterIndex), false);
});
