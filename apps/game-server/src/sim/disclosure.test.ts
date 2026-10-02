import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTAINER_STATE, SERVER_TICK_MS, type ContainerSpot } from "@extract/shared";
import type { AoiEntity } from "./aoi.js";
import { buildBatches } from "./audience.js";
import { takeAll } from "./containers.js";
import { DISCLOSE } from "./disclosure.js";
import { spawnGroundItem } from "./inventory.js";
import { makeItem } from "./items.js";
import type { Match } from "./match.js";
import { giveItem, ids, place, rtOf, testMap, testMatch } from "./test-utils.js";

/**
 * What each human's StateView holds of items / corpses, driven by the AOI diffs exactly like
 * ViewSync (views.ts) applies them.
 */
function views(m: Match) {
  const held = new Map<number, Set<AoiEntity>>();
  for (const rt of m.allRuntimes()) held.set(rt.rosterIndex, new Set(m.aoi.ring(m, rt.rosterIndex, rt.pub.x, rt.pub.y)));
  const step = (n = 1) => {
    for (let k = 0; k < n; k++) {
      m.step(SERVER_TICK_MS);
      for (const d of m.aoi.drainDiffs()) {
        const v = held.get(d.viewer)!;
        for (const e of d.remove) v.delete(e);
        for (const e of d.add) if (m.aoi.isLive(m, e)) v.add(e);
      }
      // Deleting an entity from state removes it from every view (Colyseus DELETE).
      for (const v of held.values()) for (const e of [...v]) if (!m.aoi.isLive(m, e)) v.delete(e);
    }
  };
  return { held, step };
}

const CRATE: ContainerSpot = { x: 1100, y: 1500, kind: "crate", tier: 0, zone: null };

test("disclosure: a far client does not see a container flip while the opener is still there", () => {
  const m = testMatch(2, { envSeed: 2, map: testMap({ containers: [CRATE] }) });
  const [a, b] = ids(m);
  place(m, a!, 1040, 1500);
  place(m, b!, 4400, 4400);
  m.step(SERVER_TICK_MS);
  m.drainEvents();
  assert.ok(m.interact(a!), "A opens the crate");
  m.step(SERVER_TICK_MS);
  const ev = m.drainEvents();
  assert.equal(m.containers.stateOf(0), CONTAINER_STATE.OPENED, "truth: opened");
  assert.equal(m.state.containerState[0], CONTAINER_STATE.UNTOUCHED, "public: still untouched");
  const rb = rtOf(m, b!).rosterIndex;
  assert.equal(buildBatches(m, ev, [rtOf(m, a!).rosterIndex, rb]).get(rb)?.chest, undefined, "no chest event for B");

  // A empties it (the search runs its course) and stays: still nothing public.
  for (let t = 0; t < 6000; t += SERVER_TICK_MS) m.step(SERVER_TICK_MS);
  takeAll(m, rtOf(m, a!));
  m.step(SERVER_TICK_MS);
  for (let t = 0; t < DISCLOSE.QUIET_MS * 2; t += SERVER_TICK_MS) m.step(SERVER_TICK_MS);
  assert.equal(m.containers.stateOf(0), CONTAINER_STATE.EMPTIED, "truth: emptied");
  assert.equal(m.state.containerState[0], CONTAINER_STATE.UNTOUCHED, "public: unchanged while A is still next to it");
  m.drainEvents();
});

test("disclosure: the flip goes public only after the opener left the area for QUIET_MS", () => {
  const m = testMatch(2, { envSeed: 2, map: testMap({ containers: [CRATE] }) });
  const [a, b] = ids(m);
  place(m, a!, 1040, 1500);
  place(m, b!, 4400, 4400);
  assert.ok(m.interact(a!));
  for (let t = 0; t < 2000; t += SERVER_TICK_MS) m.step(SERVER_TICK_MS);
  assert.equal(m.state.containerState[0], CONTAINER_STATE.UNTOUCHED, "A is still there");
  m.searchClose(a!);
  place(m, a!, 1040, 2700); // > DISCLOSE.AWAY_PX from the crate
  for (let t = 0; t < DISCLOSE.QUIET_MS - 200; t += SERVER_TICK_MS) m.step(SERVER_TICK_MS);
  assert.equal(m.state.containerState[0], CONTAINER_STATE.UNTOUCHED, "not before QUIET_MS");
  for (let t = 0; t < 400; t += SERVER_TICK_MS) m.step(SERVER_TICK_MS);
  assert.equal(m.state.containerState[0], CONTAINER_STATE.OPENED, "public now");
});

test("disclosure: a hidden player walking over floor ammo does not delete it from a far viewer's view", () => {
  // Reviewer scenario 2: a wall between B and A, ammo inside B's AOI ring but behind the wall.
  const m = testMatch(2, { envSeed: 2, map: testMap({ walls: [{ x: 1800, y: 600, w: 64, h: 2000 }] }) });
  const [a, b] = ids(m);
  place(m, b!, 1300, 1500);
  place(m, a!, 2400, 1500);
  const ammo = spawnGroundItem(m, makeItem("ammo_heavy", { qty: 20 }), 2600, 1500);
  const ra = rtOf(m, a!).rosterIndex, rb = rtOf(m, b!).rosterIndex;
  const { held, step } = views(m);
  step();
  assert.ok(!m.vision.sees(rb, ra), "B does not see A");
  assert.ok(held.get(rb)!.has(ammo) && held.get(ra)!.has(ammo));

  place(m, a!, 2600, 1500); // onto the ammo: auto-pickup
  step();
  assert.ok(!m.ground.byId.has(ammo.id), "truth: picked up");
  assert.ok(held.get(rb)!.has(ammo), "B still sees the ammo lying there");
  assert.ok(!held.get(ra)!.has(ammo), "A sees it gone");

  // A leaves; once QUIET_MS passed the pickup is public.
  place(m, a!, 4200, 4200);
  step(Math.ceil((DISCLOSE.QUIET_MS + 200) / SERVER_TICK_MS));
  assert.ok(!m.state.items.has(ammo.id) && !held.get(rb)!.has(ammo), "published");
});

test("disclosure: an item dropped by a hidden player appears only for those who see the dropper", () => {
  const m = testMatch(3, { envSeed: 2, map: testMap({ walls: [{ x: 1800, y: 600, w: 64, h: 2000 }] }) });
  const [a, b, c] = ids(m);
  place(m, b!, 1300, 1500); // behind the wall: does not see A
  place(m, a!, 2400, 1500);
  place(m, c!, 2700, 1500); // next to A, facing A
  rtOf(m, c!).pub.aim = Math.PI;
  const ra = rtOf(m, a!).rosterIndex, rb = rtOf(m, b!).rosterIndex, rc = rtOf(m, c!).rosterIndex;
  const { held, step } = views(m);
  step();
  assert.ok(m.vision.sees(rc, ra) && !m.vision.sees(rb, ra));
  const uid = giveItem(m, a!, "junk_gpu", "p2");
  assert.equal(m.invDrop(a!, { key: "p2", uid, def: "junk_gpu" }), null);
  step();
  const g = [...m.ground.all()].find((x) => x.item.def === "junk_gpu")!.schema;
  assert.ok(held.get(ra)!.has(g) && held.get(rc)!.has(g), "the dropper and its viewer see the drop");
  assert.ok(!held.get(rb)!.has(g), "B (ring holds the spot, A hidden) does not");
  place(m, a!, 4400, 4400);
  place(m, c!, 4400, 4300);
  step(Math.ceil((DISCLOSE.QUIET_MS + 200) / SERVER_TICK_MS));
  assert.ok(held.get(rb)!.has(g), "published: now B gets it too");
});
