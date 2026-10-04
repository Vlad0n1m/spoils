/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/tutorial.test.ts
 * First-raid tutorial step machine (tutorial.ts): each step completes only on its real event.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  TUTORIAL_AIM_RAD,
  TUTORIAL_MOVE_PX,
  TUTORIAL_UNHURT_MS,
  advanceTutorial,
  initialTutorial,
  tutorialHint,
  type TutorialSignals,
  type TutorialState,
} from "./tutorial";

const sig = (o: Partial<TutorialSignals> = {}): TutorialSignals => ({
  now: 0,
  pose: { x: 1000, y: 1000, aim: 0 },
  alive: true,
  searching: false,
  npcKills: 0,
  hp: 100,
  maxHp: 100,
  healing: false,
  meds: 1,
  extracting: false,
  ...o,
});

function run(s: TutorialState, ...xs: Array<Partial<TutorialSignals>>): TutorialState {
  for (const x of xs) s = advanceTutorial(s, sig(x));
  return s;
}

describe("tutorial step machine", () => {
  it("walks move → aim → search → kill → heal → extract → done on real events only", () => {
    let s = initialTutorial();
    assert.equal(s.step, "move");
    s = run(s, {}, { pose: { x: 1000 + TUTORIAL_MOVE_PX - 1, y: 1000, aim: 0 } });
    assert.equal(s.step, "move", "not far enough");
    s = run(s, { pose: { x: 1000 + TUTORIAL_MOVE_PX, y: 1000, aim: 0.1 } });
    assert.equal(s.step, "aim");
    s = run(s, { pose: { x: 1200, y: 1000, aim: 0.1 + TUTORIAL_AIM_RAD - 0.05 } });
    assert.equal(s.step, "aim", "turned too little");
    s = run(s, { pose: { x: 1200, y: 1000, aim: 0.1 - TUTORIAL_AIM_RAD } });
    assert.equal(s.step, "search");
    s = run(s, { npcKills: 1 });
    assert.equal(s.step, "search", "steps go in order");
    s = run(s, { searching: true });
    assert.equal(s.step, "kill");
    s = run(s, { npcKills: 1 }, { hp: 60 });
    assert.equal(s.step, "heal");
    s = run(s, { hp: 60 });
    assert.equal(s.step, "heal", "hurt: waits for a heal");
    s = run(s, { hp: 60, healing: true });
    assert.equal(s.step, "extract");
    assert.equal(s.healSkipped, false);
    s = run(s, { extracting: true });
    assert.equal(s.step, "done");
    assert.equal(run(s, { alive: false }).step, "done");
  });

  it("aim wraps around ±π", () => {
    const s = run({ ...initialTutorial(), step: "aim", aim0: Math.PI - 0.1 }, { pose: { x: 0, y: 0, aim: -Math.PI + 0.2 } });
    assert.equal(s.step, "aim", "0.3 rad across the seam");
    const t = run({ ...initialTutorial(), step: "aim", aim0: Math.PI - 0.1 }, { pose: { x: 0, y: 0, aim: -Math.PI + 0.75 } });
    assert.equal(t.step, "search");
  });

  it("heal passes when there is nothing to heal for a while, and a wound resets that wait", () => {
    let s: TutorialState = { ...initialTutorial(), step: "heal" };
    s = run(s, { now: 1000 }, { now: 1000 + TUTORIAL_UNHURT_MS - 1 });
    assert.equal(s.step, "heal");
    s = run(s, { now: 1000 + TUTORIAL_UNHURT_MS - 1, hp: 80 });
    assert.equal(s.unhurtSince, null, "hurt again: the wait starts over");
    s = run(s, { now: 20_000 }, { now: 20_000 + TUTORIAL_UNHURT_MS });
    assert.equal(s.step, "extract");
    assert.equal(s.healSkipped, true);
    const noMeds = run({ ...initialTutorial(), step: "heal" }, { now: 0, hp: 50, meds: 0 }, { now: TUTORIAL_UNHURT_MS, hp: 50, meds: 0 });
    assert.equal(noMeds.step, "extract", "no bandage to use");
  });

  it("a dead raider does not advance", () => {
    const s = run({ ...initialTutorial(), step: "search" }, { alive: false, searching: true });
    assert.equal(s.step, "search");
  });

  it("hints: touch wording mentions sticks and auto-fire, desktop the keys", () => {
    assert.match(tutorialHint("move", true).text, /left stick/);
    assert.match(tutorialHint("move", false).text, /W A S D/);
    assert.match(tutorialHint("aim", true).text, /fires by itself/);
    assert.match(tutorialHint("kill", true).text, /auto-fire/);
    assert.match(tutorialHint("search", true).text, /USE/);
    assert.match(tutorialHint("search", false).text, /press F/);
    assert.match(tutorialHint("heal", false).text, /Press 3/);
    assert.match(tutorialHint("heal", true, true).text, /Not hurt/);
  });
});
