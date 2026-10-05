import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BattleState,
  CACHE_NOTE_DEF,
  CONTAINER_STATE,
  LOCK_STATE,
  crackSafes,
  encodeClueRef,
  gateCentre,
  generateMap,
  getCollisionIndex,
  itemDef,
  lockedRooms,
  setGateOpen,
  setLocksEnabled,
} from "@extract/shared";
import { interactHint } from "./hud";
import { cluesOf, objToast } from "./objectives";

const map = generateMap("steppe");

test("objectives: toasts name the missing key and the results", () => {
  const l = lockedRooms(map)[0]!;
  assert.equal(objToast({ e: "locked", i: l.id }, map)?.sub, `Requires: ${itemDef(l.key)!.name}`);
  assert.equal(objToast({ e: "unlocked", i: l.id }, map)?.title, "ROOM UNLOCKED");
  assert.equal(objToast({ e: "found", i: 1 }, map)?.title, "HIDDEN CACHE FOUND");
  assert.equal(objToast({ e: "unlock", i: l.id, at: 1 }, map), null, "a channel start is a progress bar, not a toast");
});

test("objectives: clue circles come only from the player's own notes, one per cache", () => {
  const notes = [
    { def: CACHE_NOTE_DEF, ref: encodeClueRef(2, 1000, 2000, 700), label: "By the silo, Grain Elevator" },
    { def: CACHE_NOTE_DEF, ref: encodeClueRef(2, 1000, 2000, 700), label: "By the silo, Grain Elevator" },
    { def: "junk_apple", ref: "", label: "" },
    { def: CACHE_NOTE_DEF, ref: "garbage", label: "x" },
  ];
  assert.deepEqual(cluesOf(notes), [{ n: 2, x: 1000, y: 2000, r: 700, text: "By the silo, Grain Elevator" }]);
});

test("objectives: the F hint shows a locked gate's key and a crack safe, only while objectives run", () => {
  const idx = getCollisionIndex(map);
  const state = new BattleState();
  for (let i = 0; i < map.containers.length; i++) state.containerState.push(CONTAINER_STATE.UNTOUCHED);
  const l = lockedRooms(map)[0]!;
  const d = l.doors[0]!;
  const vert = d.w < d.h;
  const rc = { x: l.room.x + l.room.w / 2, y: l.room.y + l.room.h / 2 };
  const g = gateCentre(l);
  const at = vert ? { x: g.x - Math.sign(rc.x - g.x) * 60, y: g.y } : { x: g.x, y: g.y - Math.sign(rc.y - g.y) * 60 };
  const off = interactHint({ state, map, x: at.x, y: at.y, idx, objectives: null });
  assert.ok(!off?.startsWith("Locked"), "objectives off: no gate");
  setLocksEnabled(idx, map, true);
  try {
    for (let i = 0; i < lockedRooms(map).length; i++) state.lockState.push(LOCK_STATE.LOCKED);
    const name = itemDef(l.key)!.name;
    assert.equal(interactHint({ state, map, x: at.x, y: at.y, idx, objectives: { map, carries: () => false } }), `Locked — needs ${name}`);
    assert.equal(interactHint({ state, map, x: at.x, y: at.y, idx, objectives: { map, carries: (k) => k === l.key } }), `F — unlock with ${name}`);
    setGateOpen(idx, map, l.id, true);
    assert.ok(!interactHint({ state, map, x: at.x, y: at.y, idx, objectives: { map, carries: () => false } })?.startsWith("Locked"), "open gate: no prompt");
    const s = [...crackSafes(map)][0]!;
    const spot = map.containers[s]!;
    assert.match(interactHint({ state, map, x: spot.x + 1, y: spot.y + 1, idx: null, objectives: { map, carries: () => false } }) ?? "", /crack safe/);
    state.containerState[s] = CONTAINER_STATE.OPENED;
    assert.match(interactHint({ state, map, x: spot.x + 1, y: spot.y + 1, idx: null, objectives: { map, carries: () => false } }) ?? "", /search Safe/i);
  } finally {
    setLocksEnabled(idx, map, false);
  }
});
