/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/party.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { minimapMatePoint } from "./minimap";
import { MATE_COLORS, MAX_MATES, PARTY_LERP_MS, PARTY_STALE_MS, PartyTracker, arrowInsets, arrowObstacles, edgeAnchor, mateLabel, parsePartyMsg } from "./party";

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;
const mate = (key: string, x: number, y: number, o: Record<string, unknown> = {}) => ({ key, id: `s-${key}`, name: key.toUpperCase(), x, y, alive: true, ...o });

describe("party (client)", () => {
  it("parsePartyMsg keeps well-formed mates only, capped at a party's size", () => {
    assert.equal(parsePartyMsg(null), null);
    assert.equal(parsePartyMsg({}), null);
    assert.equal(parsePartyMsg({ mates: "x" }), null);
    assert.deepEqual(parsePartyMsg({ mates: [] }), []);
    const out = parsePartyMsg({
      mates: [
        mate("p3", 10, 20),
        { key: "p4", x: 1, y: 2, alive: false },
        { key: "evil", x: 1, y: 2 },
        { key: "p5", x: Number.NaN, y: 2 },
        { key: "p6", x: "1", y: 2 },
        mate("p3", 99, 99),
        { key: "p7", x: 5, y: 6, name: "  " + "N".repeat(40), id: "x".repeat(65) },
        mate("p8", 1, 1),
      ],
    })!;
    assert.equal(out.length, MAX_MATES);
    assert.deepEqual(out[0], { key: "p3", id: "s-p3", name: "P3", x: 10, y: 20, alive: true });
    assert.deepEqual(out[1], { key: "p4", id: "", name: "Mate", x: 1, y: 2, alive: false });
    assert.equal(out[2]!.key, "p7");
    assert.equal(out[2]!.name, "N".repeat(24), "trimmed, at most 24 characters");
    assert.equal(out[2]!.id, "", "an oversized id is dropped");
  });

  it("PartyTracker glides to each update over one period, snaps on long jumps and deaths, drops missing mates", () => {
    const t = new PartyTracker();
    assert.deepEqual(t.mates(0), []);
    assert.ok(t.ingest({ mates: [mate("p3", 0, 0), mate("p4", 500, 500)] }, 1_000));
    assert.equal(t.ingest({ nope: 1 }, 1_001), false);
    let m = t.mates(1_000);
    assert.deepEqual(m.map((x) => [x.key, x.x, x.y]), [["p3", 0, 0], ["p4", 500, 500]]);
    t.ingest({ mates: [mate("p3", 100, 0), mate("p4", 500, 500)] }, 1_500);
    m = t.mates(1_500 + PARTY_LERP_MS / 2);
    assert.ok(near(m[0]!.x, 50), "half way after half a period");
    m = t.mates(1_500 + PARTY_LERP_MS * 2);
    assert.ok(near(m[0]!.x, 100), "arrived, then holds");
    // A re-entry far away snaps; a death snaps to the body.
    t.ingest({ mates: [mate("p3", 5_000, 0), mate("p4", 520, 500, { alive: false })] }, 3_000);
    m = t.mates(3_000);
    assert.ok(near(m[0]!.x, 5_000));
    assert.ok(near(m[1]!.x, 520));
    assert.equal(m[1]!.alive, false);
    // p4 left (extracted): gone at once; everything goes stale without messages.
    t.ingest({ mates: [mate("p3", 5_000, 0)] }, 3_500);
    assert.deepEqual(t.mates(3_500).map((x) => x.key), ["p3"]);
    assert.deepEqual(t.mates(3_500 + PARTY_STALE_MS + 1), []);
    t.ingest({ mates: [] }, 10_000);
    assert.deepEqual(t.mates(10_000), []);
  });

  it("PartyTracker colours stay with a mate and never repeat among current mates", () => {
    const t = new PartyTracker();
    t.ingest({ mates: [mate("p3", 0, 0), mate("p4", 0, 0), mate("p5", 0, 0)] }, 0);
    const first = new Map(t.mates(0).map((x) => [x.key, x.color]));
    assert.equal(new Set(first.values()).size, 3);
    for (const c of first.values()) assert.ok((MATE_COLORS as readonly number[]).includes(c));
    // Order changes and a mate drops out: the others keep theirs.
    t.ingest({ mates: [mate("p5", 0, 0), mate("p3", 0, 0)] }, 100);
    for (const x of t.mates(100)) assert.equal(x.color, first.get(x.key));
    // A newcomer takes the free colour.
    t.ingest({ mates: [mate("p5", 0, 0), mate("p3", 0, 0), mate("p9", 0, 0)] }, 200);
    const now = t.mates(200);
    assert.equal(new Set(now.map((x) => x.color)).size, 3);
    assert.equal(now.find((x) => x.key === "p9")!.color, first.get("p4"));
  });

  it("edgeAnchor: on screen → no arrow; off screen → on the inset rect toward the mate, clear of the minimap", () => {
    const ins = { left: 20, right: 20, top: 20, bottom: 40 };
    const on = edgeAnchor(1000, 600, 500, 300, ins);
    assert.equal(on.onScreen, true);
    // Straight right of the inset rect's centre (500, 290).
    const r = edgeAnchor(1000, 600, 3000, 290, ins);
    assert.equal(r.onScreen, false);
    assert.ok(near(r.x, 980) && near(r.y, 290) && near(r.angle, 0));
    // Straight down: the bottom inset.
    const d = edgeAnchor(1000, 600, 500, 5000, ins);
    assert.ok(near(d.x, 500) && near(d.y, 560) && near(d.angle, Math.PI / 2));
    // Up-left diagonal stays on the rect.
    const ul = edgeAnchor(1000, 600, -1000, -1000, ins);
    assert.ok(near(ul.x, 20) || near(ul.y, 20));
    assert.ok(ul.x >= 20 && ul.y >= 20);
    // The minimap corner: a right-edge arrow drops below it, a top-edge arrow moves left of it.
    const avoid = { x0: 760, y0: 0, x1: 1000, y1: 240 };
    const re = edgeAnchor(1000, 600, 3000, -400, ins, avoid);
    assert.ok(near(re.x, 980) && near(re.y, 240), `right edge → below the minimap (${re.x}, ${re.y})`);
    const te = edgeAnchor(1000, 600, 1700, -710, ins, avoid);
    assert.ok(near(te.y, 20) && near(te.x, 760), `top edge → left of the minimap (${te.x}, ${te.y})`);
  });

  it("arrowObstacles: on a landscape phone the arrows slide off the top stack and the bottom bar", () => {
    const w = 844, h = 390;
    const ins = { left: 26, right: 26, top: 74, bottom: 30 };
    assert.equal(arrowObstacles(w, h, false).length, 1, "desktop: the minimap only");
    const avoid = arrowObstacles(w, h, true);
    const top = avoid.find((r) => r.y0 === 0 && r.x0 > 0 && r.x1 < w)!;
    const bar = avoid.find((r) => r.y1 === h)!;
    // Straight up: off the timer / compass stack, still on the top edge.
    const up = edgeAnchor(w, h, w / 2, -3000, ins, avoid);
    assert.ok(near(up.y, 74) && (near(up.x, top.x0) || near(up.x, top.x1)), `up (${up.x}, ${up.y})`);
    // Straight down: beside the bottom bar, still on the bottom edge.
    const down = edgeAnchor(w, h, w / 2 + 10, 3000, ins, avoid);
    assert.ok(near(down.y, h - 30) && (near(down.x, bar.x0) || near(down.x, bar.x1)), `down (${down.x}, ${down.y})`);
    for (const p of [up, down]) for (const r of avoid) assert.ok(!(p.x > r.x0 && p.x < r.x1 && p.y > r.y0 && p.y < r.y1));
    // The side edges are free below the top row.
    const left = edgeAnchor(w, h, -3000, h / 2 + 26, ins, avoid);
    assert.ok(near(left.x, 26), `left (${left.x}, ${left.y})`);
  });

  it("full-bleed canvas: the obstacles and the arrows keep to the safe area of a notched phone", () => {
    const w = 844, h = 390;
    const safe = { left: 47, right: 47, top: 0, bottom: 21 };
    // The safe-area obstacles are the 750 px layout shifted 47 px in.
    const inner = arrowObstacles(w - 94, h, true);
    const shifted = arrowObstacles(w, h, true, safe);
    assert.equal(shifted.length, inner.length);
    for (let i = 1; i < inner.length; i++) assert.ok(near(shifted[i]!.x0, inner[i]!.x0 + 47) && near(shifted[i]!.x1, inner[i]!.x1 + 47));
    assert.ok(near(shifted[0]!.x0, inner[0]!.x0 + 47), "minimap obstacle in the safe area's corner");
    const ins = arrowInsets({ left: 26, right: 26, top: 64, bottom: 30 }, safe);
    const left = edgeAnchor(w, h, -3000, h / 2 + 26, ins, shifted);
    assert.ok(near(left.x, 73), `left arrow clears the cutout (${left.x})`);
    const right = edgeAnchor(w, h, 4000, h / 2 + 26, ins, shifted);
    assert.ok(near(right.x, w - 73), `right arrow clears the cutout (${right.x})`);
  });

  it("mateLabel and minimapMatePoint", () => {
    assert.equal(mateLabel("Ann", 34 * 40, true), "Ann · 34 m");
    assert.equal(mateLabel("Ann", 3, true), "Ann · 1 m");
    assert.equal(mateLabel("Ann", 999, false), "Ann · down");
    const win = { x: 1000, y: 1000, w: 4096, h: 4096 };
    assert.deepEqual(minimapMatePoint(win, 1000 + 2048, 1000 + 1024, 200), { x: 100, y: 50, edge: false });
    assert.deepEqual(minimapMatePoint(win, 0, 1000 + 2048, 200), { x: 5, y: 100, edge: true });
    assert.deepEqual(minimapMatePoint(win, 99_999, 99_999, 200), { x: 195, y: 195, edge: true });
  });
});
