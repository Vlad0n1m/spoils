/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/fullmap-layout.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WORLD, generateMap, type MapSide } from "@extract/shared";
import {
  extractLabelCandidates,
  extractStatusText,
  fullMapLayout,
  fullMapMeta,
  fullMapSubtitle,
  fullMapTitle,
  gridRuler,
  legendItems,
  legendKey,
  mapScale,
  pickLegendCorner,
  placeLabels,
  scaleBar,
  worldToPanel,
  zoneLabelCandidates,
  type Box,
  type LabelRequest,
} from "./fullmap-layout";
import { extractLook, fullMapExtractView } from "./fullmap";

const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("fullMapLayout", () => {
  it("desktop 1440×900: a square between the HUD pill and the inventory bar, side column on the left", () => {
    const l = fullMapLayout(1440, 900, false);
    assert.equal(l.legend.mode, "side");
    assert.equal(l.title.align, "left");
    assert.ok(l.panel.y >= 80, "under the top status pill");
    assert.ok(l.panel.y + l.panel.size <= 900 - 128, "above the inventory bar");
    assert.ok(l.title.x + l.title.w <= l.panel.x - 16, "column left of the map");
    assert.ok(l.title.x >= 0);
    assert.ok(Math.abs(l.panel.x + l.panel.size / 2 - 720) <= 1, "centred");
    assert.ok(l.ruler > 0);
    assert.ok(l.panel.size >= 600);
  });

  it("phone landscape 844×390: between the touch control columns, one-line title, legend in the left gutter", () => {
    const l = fullMapLayout(844, 390, true);
    assert.equal(l.compact, true);
    assert.equal(l.legend.mode, "gutter");
    assert.ok(l.legend.x <= l.panel.x - 8 && l.legend.x - l.legend.w >= 160, "clear of the left touch buttons");
    // Too narrow for a gutter: the legend goes into a corner of the map.
    assert.equal(fullMapLayout(640, 360, true).legend.mode, "inside");
    assert.ok(l.panel.x >= 176 && l.panel.x + l.panel.size <= 844 - 176);
    assert.ok(l.panel.y + l.panel.size <= 390);
    assert.ok(l.title.y >= 40, "under the HUD's extraction pill");
    assert.equal(l.ruler, 0);
  });

  it("phone portrait 390×844: under the minimap, legend below the map, all on screen", () => {
    const l = fullMapLayout(390, 844, true);
    assert.equal(l.legend.mode, "below");
    assert.ok(l.panel.x >= 0 && l.panel.x + l.panel.size <= 390);
    assert.ok(l.panel.y >= 120 + 16, "below the minimap");
    assert.ok(l.legend.y > l.panel.y + l.panel.size);
    assert.ok(l.legend.y < 844 - 100, "room for the legend");
  });

  it("narrow desktop 800×600: title row above the map, legend in a corner", () => {
    const l = fullMapLayout(800, 600, false);
    assert.equal(l.legend.mode, "inside");
    assert.equal(l.title.align, "center");
    assert.ok(l.title.y < l.panel.y);
    assert.ok(l.panel.x + l.panel.size <= 800);
  });

  it("never overlaps the minimap corner on desktop", () => {
    for (const [w, h] of [[1024, 768], [1280, 720], [1440, 900], [1920, 1080], [1100, 1000]] as const) {
      const l = fullMapLayout(w, h, false);
      const mm = Math.max(120, Math.min(200, Math.min(w, h) * 0.24)) + 16;
      const mini = { x: w - mm, y: 0, w: mm, h: mm };
      assert.ok(!overlaps({ x: l.panel.x, y: l.panel.y, w: l.panel.size, h: l.panel.size }, mini), `${w}×${h}`);
    }
  });
});

describe("transforms", () => {
  it("maps the world square onto the panel", () => {
    const k = mapScale(700, { width: 28_672, height: 28_672 });
    assert.equal(28_672 * k, 700);
    assert.deepEqual(worldToPanel({ x: 100, y: 50 }, k, 14_336, 0), { x: 450, y: 50 });
    assert.deepEqual(worldToPanel({ x: 100, y: 50 }, k, 28_672, 28_672), { x: 800, y: 750 });
  });

  it("scale bar picks a nice length at least minPx long", () => {
    const k = mapScale(700, { width: 28_672, height: 28_672 });
    const sb = scaleBar(k, 40, 56);
    assert.equal(sb.meters, 100);
    assert.ok(sb.px >= 56 && sb.px < 120);
    const small = scaleBar(mapScale(300, { width: 28_672, height: 28_672 }), 40, 56);
    assert.equal(small.meters, 200);
  });

  it("grid ruler: one letter / number per 2 km square", () => {
    const r = gridRuler(28_672, 28_672, 2048);
    assert.equal(r.cols.length, 14);
    assert.equal(r.cols[0], "A");
    assert.equal(r.cols[13], "N");
    assert.deepEqual(r.rows.slice(0, 3), ["1", "2", "3"]);
  });
});

describe("label placement", () => {
  const bounds = { x: 0, y: 0, w: 400, h: 400 };

  it("moves a lower-priority label off a placed one (Bridge Checkpoint / Truck Stop case)", () => {
    const reqs: LabelRequest[] = [
      { id: "bridge", w: 120, h: 18, priority: 20, candidates: zoneLabelCandidates({ x: 200, y: 200, w: 60, h: 60 }, 120, 18) },
      { id: "truck", w: 90, h: 18, priority: 10, candidates: zoneLabelCandidates({ x: 265, y: 200, w: 60, h: 60 }, 90, 18) },
    ];
    const p = placeLabels(reqs, bounds);
    const a = p.get("bridge")!;
    const b = p.get("truck")!;
    assert.equal(a.overlap, false);
    assert.equal(b.overlap, false);
    assert.ok(!overlaps({ x: a.x, y: a.y, w: 120, h: 18 }, { x: b.x, y: b.y, w: 90, h: 18 }));
    // The higher tier keeps its first choice (centred in its zone).
    assert.equal(a.x, 230 - 60);
  });

  it("avoids obstacles (icons, legend) and stays inside the bounds", () => {
    const obstacle = { x: 0, y: 380 - 40, w: 120, h: 60 };
    const p = placeLabels([{ id: "a", w: 80, h: 16, priority: 1, candidates: [{ x: -20, y: 360 }, { x: 150, y: 360 }] }], bounds, [obstacle]);
    const a = p.get("a")!;
    assert.equal(a.x, 150);
    assert.ok(a.y + 16 <= 400);
  });

  it("takes the least-overlapping candidate when nothing is free, and is deterministic", () => {
    const reqs: LabelRequest[] = [
      { id: "big", w: 400, h: 400, priority: 9, candidates: [{ x: 0, y: 0 }] },
      { id: "x", w: 50, h: 20, priority: 1, candidates: [{ x: 10, y: 10 }, { x: 200, y: 200 }] },
    ];
    const a = placeLabels(reqs, bounds);
    const b = placeLabels(reqs, bounds);
    assert.equal(a.get("x")!.overlap, true);
    assert.deepEqual(a, b);
  });

  it("places every Outskirts POI and extract name on a 700 px map with no overlaps", () => {
    const map = generateMap("steppe");
    const size = 700;
    const k = mapScale(size, map);
    const reqs: LabelRequest[] = [];
    const obstacles: Box[] = map.extracts.map((e) => ({ x: e.x * k - 11, y: e.y * k - 11, w: 22, h: 22 }));
    map.extracts.forEach((e, i) => {
      const w = 8 * e.name.length + 12;
      reqs.push({ id: `e${i}`, w, h: 28, priority: 100, candidates: extractLabelCandidates(e.x * k, e.y * k, e.side, w, 28, 9) });
    });
    map.zones.forEach((z, i) => {
      const w = 8.5 * z.name.length + 30;
      reqs.push({ id: `z${i}`, w, h: 18, priority: z.tier * 10, candidates: zoneLabelCandidates({ x: z.rect.x * k, y: z.rect.y * k, w: z.rect.w * k, h: z.rect.h * k }, w, 18) });
    });
    const p = placeLabels(reqs, { x: 2, y: 2, w: size - 4, h: size - 4 }, obstacles);
    assert.equal(p.size, reqs.length);
    const boxes = reqs.map((r) => ({ ...p.get(r.id)!, w: r.w, h: r.h, id: r.id }));
    let clashes = 0;
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (overlaps(boxes[i]!, boxes[j]!)) clashes++;
    assert.equal(clashes, 0);
    for (const b of boxes) assert.ok(b.x >= 2 && b.y >= 2 && b.x + b.w <= size - 2 && b.y + b.h <= size - 2, b.id);
  });

  it("extract labels go inward from their edge first", () => {
    const sides: Array<[MapSide, (c: { x: number; y: number }) => boolean]> = [
      [0, (c) => c.y > 100],
      [1, (c) => c.x + 60 < 100],
      [2, (c) => c.y + 20 < 100],
      [3, (c) => c.x > 100],
    ];
    for (const [side, inward] of sides) assert.ok(inward(extractLabelCandidates(100, 100, side, 60, 20, 9)[0]!), `side ${side}`);
  });

  it("legend corner: the one covering fewer extracts / POIs", () => {
    const corners = [{ x: 0, y: 300 }, { x: 0, y: 0 }];
    assert.deepEqual(pickLegendCorner(corners, 100, 100, [{ x: 50, y: 350 }]), { x: 0, y: 0 });
    assert.deepEqual(pickLegendCorner(corners, 100, 100, [{ x: 50, y: 50 }]), { x: 0, y: 300 });
    assert.deepEqual(pickLegendCorner(corners, 100, 100, []), { x: 0, y: 300 });
  });
});

describe("legend, title and extract status", () => {
  const none = { mates: 0, boss: false, hot: false, drop: false, clue: false, spawn: false };

  it("always lists you and the three extract looks; event rows only while present", () => {
    assert.deepEqual(legendItems(none).map((r) => r.key), ["you", "extract-open", "extract-waiting", "extract-closed"]);
    const all = legendItems({ mates: 2, boss: true, hot: true, drop: true, clue: true, spawn: true }).map((r) => r.key);
    assert.deepEqual(all, ["you", "party", "extract-open", "extract-waiting", "extract-closed", "spawn", "boss", "hot", "drop", "clue"]);
    assert.equal(legendItems({ ...none, mates: 1 })[1]!.label, "Party mate");
  });

  it("legend key changes only when the rows change", () => {
    assert.equal(legendKey(none), legendKey({ ...none }));
    assert.notEqual(legendKey(none), legendKey({ ...none, drop: true }));
    assert.notEqual(legendKey({ ...none, mates: 1 }), legendKey({ ...none, mates: 2 }));
  });

  it("title: map name, map number and the wipe countdown", () => {
    const cycle = Math.floor(WORLD.NUMBER_EPOCH_MS / WORLD.CYCLE_MS) + 211; // Map #212
    assert.equal(fullMapTitle("The Outskirts", cycle, 31 * 60_000 + 20_000), "THE OUTSKIRTS · MAP #212 · WIPE IN 31:20");
    assert.equal(fullMapTitle("The Outskirts", 0, null), "THE OUTSKIRTS");
    assert.equal(fullMapMeta(cycle - 300, null), "PREVIEW MAP");
    assert.equal(fullMapMeta(0, 0), "WIPING");
    assert.equal(fullMapSubtitle(3, 3), "Spawned west · 3 extracts are yours");
    assert.equal(fullMapSubtitle(null, 1), "1 extract is yours");
    assert.equal(fullMapSubtitle(null, null), "");
  });

  it("extract status lines from the live view", () => {
    const enteredAt = 20 * 60_000;
    const arm = enteredAt + WORLD.EXTRACT_ARM_MS;
    const w = fullMapExtractView({}, { openAt: 0, closeAt: 0 }, arm, enteredAt + 60_000);
    assert.equal(extractStatusText(w.status, w.suffix), "OPENS IN 2:00");
    const o = fullMapExtractView({}, { openAt: 0, closeAt: 40 * 60_000 }, 0, 30 * 60_000);
    assert.equal(extractStatusText(o.status, o.suffix), "OPEN · CLOSES 10:00");
    assert.equal(extractStatusText("open", ""), "OPEN");
    assert.equal(extractStatusText("closed", " · closed"), "CLOSED");
    assert.equal(extractLook(false, "open"), "foreign");
    assert.equal(extractLook(true, "waiting"), "waiting");
  });
});
