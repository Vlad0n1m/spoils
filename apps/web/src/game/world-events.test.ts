import { test } from "node:test";
import assert from "node:assert/strict";
import { FIGHT, WEV_KIND, WEV_STATE, bandMid } from "@extract/shared";
import { wevStatusLine, wevToast } from "./world-events";
import { fightPoint, mmss, setHeat, worldEventsView } from "./world-events-marks";

test("world events: toasts for every transition, none for a burnt-out flare", () => {
  assert.equal(wevToast(WEV_KIND.DROP, WEV_STATE.ANNOUNCED, "Fuel Stop", 160_000, 310_000, 100_000)?.title, "SUPPLY DROP INBOUND");
  assert.match(wevToast(WEV_KIND.DROP, WEV_STATE.ANNOUNCED, "Fuel Stop", 160_000, 310_000, 100_000)!.sub, /Fuel Stop · lands in 1:00/);
  assert.equal(wevToast(WEV_KIND.DROP, WEV_STATE.ACTIVE, "Fuel Stop", 0, 0, 0)?.title, "SUPPLY DROP LANDED");
  assert.equal(wevToast(WEV_KIND.DROP, WEV_STATE.DONE, "Fuel Stop", 0, 0, 0), null);
  assert.equal(wevToast(WEV_KIND.HOT, WEV_STATE.ANNOUNCED, "Depot", 60_000, 540_000, 0)?.title, "HOT ZONE SOON");
  assert.equal(wevToast(WEV_KIND.HOT, WEV_STATE.ACTIVE, "Depot", 0, 480_000, 0)?.title, "HOT ZONE ACTIVE");
  assert.equal(wevToast(WEV_KIND.HOT, WEV_STATE.DONE, "Depot", 0, 0, 0, false), null, "an end we never saw active is not announced");
  assert.equal(wevToast(WEV_KIND.HOT, WEV_STATE.DONE, "Depot", 0, 0, 0, true)?.title, "HOT ZONE OVER");
});

test("world events: status lines count down and drop out when done", () => {
  assert.equal(wevStatusLine(WEV_KIND.DROP, WEV_STATE.ANNOUNCED, "Fuel Stop", 90_000, 0, 30_000), "Supply drop · Fuel Stop · 1:00");
  assert.equal(wevStatusLine(WEV_KIND.DROP, WEV_STATE.ACTIVE, "", 0, 0, 0), "Supply drop · open ground · landed");
  assert.equal(wevStatusLine(WEV_KIND.HOT, WEV_STATE.ACTIVE, "Depot", 0, 125_000, 5_000), "Hot zone · Depot · 2:00");
  assert.equal(wevStatusLine(WEV_KIND.HOT, WEV_STATE.DONE, "Depot", 0, 0, 0), null);
  assert.equal(mmss(-5), "0:00");
});

test("world events: a fight marker sits at its band's middle distance along the sector", () => {
  const p = fightPoint({ a: 0, b: 1, fromX: 1000, fromY: 2000 });
  assert.ok(Math.abs(p.x - (1000 + bandMid(1) * FIGHT.RADIUS)) < 1e-6 && Math.abs(p.y - 2000) < 1e-6);
  setHeat("3:1,40:3", 28_672);
  assert.deepEqual(worldEventsView.heat, [{ cell: 3, level: 1 }, { cell: 40, level: 3 }]);
  setHeat("", 28_672);
  assert.deepEqual(worldEventsView.heat, []);
});
