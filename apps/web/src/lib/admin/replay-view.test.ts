/**
 * Admin replay viewer, pure parts: time → chunk / frame lookup, interpolation between frames (and
 * across a chunk boundary), the merged model (deaths, players, subjects), event filters, camera math,
 * playback clock, the chunk fetch planner, and the map culling grid.
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/admin/replay-view.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { REPLAY, decodeReplayChunk, encodeReplayChunk, type ReplayChunkData, type ReplayEnt, type ReplaySpawn } from "@extract/shared";
import {
  EVENT_CATS,
  MAX_LERP_GAP_MS,
  ReplayModel,
  SNAP_PX,
  advanceClock,
  chunkPos,
  clampView,
  compactChunk,
  describeEvent,
  entsAt,
  eventCat,
  eventFocus,
  eventsBetween,
  fitScale,
  fitView,
  fmtBytes,
  fmtClock,
  frameAt,
  lastAtOrBefore,
  lerpAngle,
  pickEntity,
  planFetch,
  playerStatus,
  replayStatus,
  screenToWorld,
  subjectPos,
  timelineGaps,
  visibleEvents,
  worldToScreen,
  zoomAt,
  type ChunkMeta,
  type EventCat,
  type NotableEvent,
} from "./replay-view";
import { buildCullGrid, queryCull, viewBounds } from "./replay-view-map";

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;
const TAU = Math.PI * 2;

function ent(r: number, x: number, y: number, o: Partial<ReplayEnt> = {}): ReplayEnt {
  return { r, kind: "human", x, y, aim: 0, hp: 255, alive: true, extracted: false, connected: true, dormant: false, extracting: false, act: 0, ...o };
}

function spawn(r: number, o: Partial<ReplaySpawn> = {}): ReplaySpawn {
  return { r, kind: "human", maxHp: 100, color: r, level: 3, guest: false, nickname: `P${r}`, userId: `u${r}`, entryId: `e${r}`, partyId: "", ...o };
}

function chunk(seq: number, startMs: number, frames: ReplayChunkData["frames"], o: Partial<ReplayChunkData> = {}): ReplayChunkData {
  return { v: REPLAY.VERSION, seq, startMs, endMs: (frames.at(-1)?.t ?? startMs) + REPLAY.FRAME_MS, final: false, roster: [], frames, events: [], ...o };
}

/** Through the real wire format, so the viewer reads exactly what the decoder returns. */
const roundTrip = (c: ReplayChunkData): ReplayChunkData => decodeReplayChunk(encodeReplayChunk(c));

describe("time → chunk and frame", () => {
  it("lastAtOrBefore / frameAt find the frame shown at t", () => {
    const a = [0, 200, 400, 600];
    assert.equal(lastAtOrBefore(a, -1), -1);
    assert.equal(lastAtOrBefore(a, 0), 0);
    assert.equal(lastAtOrBefore(a, 199), 0);
    assert.equal(lastAtOrBefore(a, 200), 1);
    assert.equal(lastAtOrBefore(a, 10_000), 3);
    assert.equal(lastAtOrBefore([], 5), -1);
    const s = compactChunk(chunk(0, 1000, [{ t: 1000, ents: [] }, { t: 1200, ents: [] }]));
    assert.equal(frameAt(s, 999), -1);
    assert.equal(frameAt(s, 1100), 0);
    assert.equal(frameAt(s, 1250), 1);
  });

  it("chunkPos: start inclusive, end exclusive, the last chunk's end inclusive, gaps are −1", () => {
    const idx = [
      { startMs: 50, endMs: 60_050 },
      { startMs: 60_050, endMs: 120_050 },
      // 120_050..180_050 dropped
      { startMs: 180_050, endMs: 240_000 },
    ];
    assert.equal(chunkPos(idx, 0), -1);
    assert.equal(chunkPos(idx, 50), 0);
    assert.equal(chunkPos(idx, 60_049), 0);
    assert.equal(chunkPos(idx, 60_050), 1);
    assert.equal(chunkPos(idx, 150_000), -1);
    assert.equal(chunkPos(idx, 239_999), 2);
    assert.equal(chunkPos(idx, 240_000), 2);
    assert.equal(chunkPos(idx, 240_001), -1);
    assert.equal(chunkPos([], 5), -1);
    assert.deepEqual(timelineGaps(idx, 240_000), [[120_050, 180_050]]);
    assert.deepEqual(timelineGaps(idx, 300_000), [[120_050, 180_050], [240_000, 300_000]]);
  });
});

describe("interpolation", () => {
  it("glides positions and aim between two frames; HP is the earlier frame's", () => {
    const c = roundTrip(
      chunk(0, 0, [
        { t: 0, ents: [ent(1, 100, 100, { aim: (250 * TAU) / 256, hp: 200 }), ent(2, 500, 500, { kind: "marauder", dormant: true })] },
        { t: 200, ents: [ent(1, 200, 140, { aim: (6 * TAU) / 256, hp: 100 }), ent(2, 500, 500, { kind: "marauder", dormant: true })] },
      ]),
    );
    const s = compactChunk(c);
    const mid = entsAt(s, null, 100);
    assert.equal(mid.length, 2);
    const a = mid.find((e) => e.r === 1)!;
    assert.ok(near(a.x, 150) && near(a.y, 120), `${a.x},${a.y}`);
    // 250/256 → 6/256 turns through 0 (the short way), so halfway is 0.
    assert.ok(near(a.aim, 0, 1e-9) || near(a.aim, TAU, 1e-9), `aim ${a.aim}`);
    assert.ok(near(a.hp, 200 / 255));
    const b = mid.find((e) => e.r === 2)!;
    assert.equal(b.kind, "marauder");
    assert.equal(b.dormant, true);
    // At and after the last frame: that frame as is.
    const end = entsAt(s, null, 500).find((e) => e.r === 1)!;
    assert.deepEqual([end.x, end.y], [200, 140]);
  });

  it("a teleport snaps, a leaver holds its last row and is not on the map afterwards", () => {
    const s = compactChunk(
      roundTrip(
        chunk(0, 0, [
          { t: 0, ents: [ent(1, 100, 100), ent(2, 1000, 1000)] },
          { t: 200, ents: [ent(1, 100 + SNAP_PX + 50, 100), ent(2, 1100, 1000, { alive: false })] },
          { t: 400, ents: [ent(1, 100 + SNAP_PX + 50, 100)] },
        ]),
      ),
    );
    const mid = entsAt(s, null, 100);
    assert.deepEqual(mid.map((e) => [e.r, e.x, e.y]), [[1, 100, 100], [2, 1000, 1000]]);
    assert.deepEqual(entsAt(s, null, 250).map((e) => e.r), [1], "the leave row is not a runtime on the map");
  });

  it("interpolates across a chunk boundary into the next chunk's key frame, not across a gap", () => {
    const a = compactChunk(roundTrip(chunk(0, 0, [{ t: 0, ents: [ent(1, 0, 0)] }, { t: 200, ents: [ent(1, 100, 0)] }], { endMs: 400 })));
    const b = compactChunk(roundTrip(chunk(1, 400, [{ t: 400, ents: [ent(1, 300, 0)] }])));
    assert.ok(near(entsAt(a, b, 300)[0]!.x, 200));
    assert.equal(entsAt(a, null, 300)[0]!.x, 100, "next chunk not loaded: hold");
    const far = compactChunk(roundTrip(chunk(3, 200 + MAX_LERP_GAP_MS + 1, [{ t: 200 + MAX_LERP_GAP_MS + 1, ents: [ent(1, 900, 0)] }])));
    assert.equal(entsAt(a, far, 300)[0]!.x, 100, "a dropped chunk between them: hold");
  });

  it("lerpAngle takes the shorter arc and stays in [0, 2π)", () => {
    assert.ok(near(lerpAngle(0.1, TAU - 0.1, 0.5), 0) || near(lerpAngle(0.1, TAU - 0.1, 0.5), TAU));
    assert.ok(near(lerpAngle(1, 2, 0.25), 1.25));
    const v = lerpAngle(TAU - 0.2, 0.2, 0.75);
    assert.ok(v >= 0 && v < TAU && near(v, 0.1, 1e-9), `${v}`);
  });

  it("eventsBetween returns (from, to] of a time-sorted list", () => {
    const l = [{ t: 0 }, { t: 100 }, { t: 100 }, { t: 250 }, { t: 400 }];
    assert.deepEqual(eventsBetween(l, 0, 250).map((e) => e.t), [100, 100, 250]);
    assert.deepEqual(eventsBetween(l, -1, 0).map((e) => e.t), [0]);
    assert.deepEqual(eventsBetween(l, 400, 900), []);
    assert.deepEqual(eventsBetween([], 0, 9), []);
  });
});

/** A small cycle: P1 (u1) dies to marauder 5, enters again as runtime 7 and extracts; P2 is MIA at the wipe. */
function cycle(): ReplayChunkData[] {
  const party = "2eaf4b20-7d8c-4f9f-9e30-4c5d6e7f8091";
  const s1 = spawn(1, { partyId: party, level: 7 });
  const s2 = spawn(2, { partyId: party, guest: true, nickname: "Guesty", userId: "" });
  const s5 = spawn(5, { kind: "marauder", nickname: "", userId: "", entryId: "", color: 255, level: 0 });
  const s9 = spawn(9, { kind: "boss", nickname: "Foreman", userId: "", entryId: "", color: 255, level: 0 });
  const s7 = spawn(7, { userId: "u1", nickname: "P1", level: 8, entryId: "e7" });
  const c0 = chunk(
    0,
    0,
    [
      { t: 0, ents: [ent(1, 100, 100), ent(2, 300, 300), ent(5, 120, 100, { kind: "marauder" }), ent(9, 5000, 5000, { kind: "boss" })] },
      { t: 200, ents: [ent(1, 110, 100, { alive: false }), ent(2, 300, 300), ent(5, 120, 100, { kind: "marauder" }), ent(9, 5000, 5000, { kind: "boss" })] },
      { t: 400, ents: [ent(2, 300, 300), ent(5, 120, 100, { kind: "marauder" }), ent(9, 5000, 5000, { kind: "boss" })] },
    ],
    {
      endMs: 600,
      events: [
        { t: 0, type: "spawn", spawn: s1 },
        { t: 0, type: "spawn", spawn: s2 },
        { t: 0, type: "spawn", spawn: s5 },
        { t: 0, type: "spawn", spawn: s9 },
        { t: 0, type: "boss", r: 9, state: "idle" },
        { t: 150, type: "shot", r: 5, weapon: "rifle", x: 120, y: 100, angles: [Math.PI] },
        { t: 150, type: "hit", src: 5, target: 1, dmg: 100, armor: false },
        { t: 150, type: "kill", victim: 1, killer: 5, weapon: "rifle" },
        { t: 150, type: "exit", r: 1, exit: "dead", extractId: "" },
        { t: 300, type: "chest", r: 2, idx: 12 },
        { t: 350, type: "loot", r: 2, target: "corpse", id: 1 },
      ],
    },
  );
  const c1 = chunk(
    1,
    600,
    [
      { t: 600, ents: [ent(2, 300, 300), ent(5, 120, 100, { kind: "marauder" }), ent(7, 2000, 2000), ent(9, 5000, 5000, { kind: "boss" })] },
      { t: 800, ents: [ent(2, 300, 300), ent(5, 120, 100, { kind: "marauder" }), ent(7, 2010, 2000, { extracted: true, alive: false }), ent(9, 5000, 5000, { kind: "boss", alive: false })] },
      { t: 1000, ents: [ent(2, 300, 300, { alive: false }), ent(5, 120, 100, { kind: "marauder", alive: false })] },
    ],
    {
      endMs: 1000,
      final: true,
      roster: [s1, s2, s5, s9],
      events: [
        { t: 600, type: "spawn", spawn: s7 },
        { t: 700, type: "boss", r: 9, state: "combat" },
        { t: 750, type: "kill", victim: 9, killer: 2, weapon: "shotgun" },
        { t: 790, type: "exit", r: 7, exit: "extract", extractId: "N1" },
        { t: 1000, type: "exit", r: 2, exit: "mia", extractId: "" },
        { t: 1000, type: "wipe" },
      ],
    },
  );
  return [roundTrip(c0), roundTrip(c1)];
}

describe("model", () => {
  it("merges chunks in seq order whatever order they arrive in; corpses only for kills", () => {
    const [c0, c1] = cycle();
    const m = new ReplayModel();
    m.add(c1!);
    assert.equal(m.name(1), "P1", "a later chunk's roster names earlier runtimes");
    m.add(c0!);
    const v = m.version;
    m.add(c0!);
    assert.equal(m.version, v, "adding a chunk twice changes nothing");
    assert.deepEqual(
      m.events.map((e) => e.t),
      [...m.events.map((e) => e.t)].sort((a, b) => a - b),
    );
    assert.equal(m.events.some((e) => (e as { type: string }).type === "shot" || (e as { type: string }).type === "hit"), false, "shots and hits stay with the frames");
    // Leaves: P1 died, P1 (run 2) extracted, the boss died, at the wipe Guesty and the marauder vanish.
    assert.deepEqual(m.leaves.map((l) => l.r), [1, 7, 9, 2, 5]);
    assert.deepEqual(m.deaths.map((d) => [d.r, d.killer, d.x]), [[1, 5, 110], [9, 2, 5000]], "MIA at the wipe and an extract are no corpse");
    assert.equal(m.wipeAt, 1000);
    assert.equal(m.name(5), "Мародёр #5");
    assert.equal(m.name(9), "Foreman");
  });

  it("groups a user's runs into one player (guests without a userId by runtime) with state at t", () => {
    const m = new ReplayModel();
    for (const c of cycle()) m.add(c);
    const ps = m.players();
    assert.deepEqual(ps.map((p) => p.key), ["u:u1", "r:2"]);
    const p1 = ps[0]!;
    assert.deepEqual(p1.runs.map((r) => [r.r, r.spawnT, r.leaveT, r.leave]), [[1, 0, 150, "dead"], [7, 600, 790, "extract"]]);
    assert.equal(p1.level, 8, "the latest run's identity");
    assert.deepEqual(playerStatus(p1, -5), { kind: "before" });
    assert.deepEqual(playerStatus(p1, 100), { kind: "on", since: 0 });
    assert.deepEqual(playerStatus(p1, 400), { kind: "left", how: "dead", at: 150 });
    assert.deepEqual(playerStatus(p1, 650), { kind: "on", since: 600 });
    assert.deepEqual(playerStatus(p1, 900), { kind: "left", how: "extract", at: 790 });
    assert.deepEqual(playerStatus(ps[1]!, 1000), { kind: "left", how: "mia", at: 1000 });
    assert.deepEqual([...m.subject("u:u1")!.rs].sort(), [1, 7]);
    assert.deepEqual([...m.subject("r:9")!.rs], [9]);
    assert.equal(m.subject("x:1"), null);
  });

  it("subjectPos follows the runtime on the map, then where it left", () => {
    const m = new ReplayModel();
    const cs = cycle();
    for (const c of cs) m.add(c);
    const sub = m.subject("u:u1")!;
    const s0 = compactChunk(cs[0]!);
    const s1 = compactChunk(cs[1]!);
    assert.deepEqual(subjectPos(sub, entsAt(s0, s1, 100), m.leaves, 100), { x: 100, y: 100, onMap: true });
    assert.deepEqual(subjectPos(sub, entsAt(s0, s1, 450), m.leaves, 450), { x: 110, y: 100, onMap: false }, "dead: the corpse");
    assert.equal(subjectPos(m.subject("r:9")!, [], m.leaves, 100), null, "not on the map, never left yet");
  });
});

describe("filters", () => {
  const m = new ReplayModel();
  for (const c of cycle()) m.add(c);
  const all = new Set<EventCat>(EVENT_CATS);
  const names = (r: number) => m.name(r);

  it("lists kills, exits (not by death), human entries, boss states and the wipe; loot only for a subject", () => {
    const v = visibleEvents(m.events, null, all);
    assert.deepEqual(
      v.map((e) => `${e.t}:${e.type}`),
      ["0:spawn", "0:spawn", "0:boss", "150:kill", "600:spawn", "700:boss", "750:kill", "790:exit", "1000:exit", "1000:wipe"],
    );
    assert.equal(eventCat({ t: 0, type: "exit", r: 1, exit: "dead", extractId: "" }), null);
    assert.equal(eventCat({ t: 0, type: "spawn", spawn: spawn(5, { kind: "marauder" }) }), null);
    const kills = visibleEvents(m.events, null, new Set<EventCat>(["kill"]));
    assert.deepEqual(kills.map((e) => e.t), [150, 750]);
  });

  it("one player: every event of their runs (as killer, victim, looter or looted), plus the wipe", () => {
    const p1 = visibleEvents(m.events, m.subject("u:u1"), all);
    assert.deepEqual(p1.map((e) => `${e.t}:${e.type}`), ["0:spawn", "150:kill", "350:loot", "600:spawn", "790:exit", "1000:wipe"]);
    const guest = visibleEvents(m.events, m.subject("r:2"), all);
    assert.deepEqual(guest.map((e) => `${e.t}:${e.type}`), ["0:spawn", "300:chest", "350:loot", "750:kill", "1000:exit", "1000:wipe"]);
    assert.deepEqual(visibleEvents(m.events, m.subject("r:2"), new Set<EventCat>(["kill"])).map((e) => e.t), [750]);
  });

  it("describes events in plain words", () => {
    const by = (type: NotableEvent["type"], t: number) => m.events.find((e) => e.type === type && e.t === t)!;
    assert.equal(describeEvent(by("kill", 150), names), "Мародёр #5 убил P1 · Assault rifle");
    assert.equal(describeEvent(by("spawn", 0), names), "P1 вошёл на карту · ур. 7, в пати");
    assert.equal(describeEvent(by("exit", 790), names, (id) => (id === "N1" ? "Pine Trail" : id)), "P1 вышел через эвакуацию · Pine Trail");
    assert.equal(describeEvent(by("exit", 1000), names), "Guesty пропал без вести (MIA)");
    assert.equal(describeEvent(by("boss", 700), names), "Foreman: в бою");
    assert.equal(describeEvent(by("loot", 350), names), "Guesty обыскивает тело: P1");
    assert.equal(describeEvent(by("wipe", 1000), names), "Вайп: карта закрылась");
    assert.equal(describeEvent({ t: 1, type: "kill", victim: 2, killer: -1, weapon: "" }, names), "Guesty погиб");
  });

  it("eventFocus points at the victim's corpse / the exit spot", () => {
    const kill = m.events.find((e) => e.type === "kill" && e.t === 150)!;
    assert.deepEqual(eventFocus(kill, m.leaves), { x: 110, y: 100 });
    const ex = m.events.find((e) => e.type === "exit" && e.t === 790)!;
    assert.deepEqual(eventFocus(ex, m.leaves), { x: 2010, y: 2000 });
    assert.equal(eventFocus(m.events.find((e) => e.type === "wipe")!, m.leaves), null);
  });
});

describe("camera", () => {
  const W = 24_576;
  it("fits the map, maps screen ↔ world both ways, zooms around the cursor and clamps", () => {
    const v = fitView(W, W, 1000, 600);
    assert.ok(near(v.scale, (600 / W) * 0.96));
    const p = worldToScreen(v, 1000, 600, W / 2, W / 2);
    assert.deepEqual(p, { x: 500, y: 300 });
    const back = screenToWorld(v, 1000, 600, 123, 456);
    const again = worldToScreen(v, 1000, 600, back.x, back.y);
    assert.ok(near(again.x, 123) && near(again.y, 456));

    const z = zoomAt(v, 1000, 600, 700, 200, 8, W, W);
    assert.ok(near(z.scale, v.scale * 8));
    const before = screenToWorld(v, 1000, 600, 700, 200);
    const after = screenToWorld(z, 1000, 600, 700, 200);
    assert.ok(near(before.x, after.x, 1e-6) && near(before.y, after.y, 1e-6), "the point under the cursor stays");

    assert.equal(zoomAt(v, 1000, 600, 500, 300, 0.1, W, W).scale, fitScale(W, W, 1000, 600), "never smaller than the whole map");
    assert.equal(clampView({ cx: -50, cy: W + 50, scale: 99 }, W, W, 1000, 600).scale, 2);
    assert.deepEqual(clampView({ cx: -50, cy: W + 50, scale: 1 }, W, W, 1000, 600), { cx: 0, cy: W, scale: 1 });
  });

  it("picks the nearest runtime within reach of a click", () => {
    const v = { cx: 0, cy: 0, scale: 1 };
    const ents = [{ r: 1, x: 10, y: 0 }, { r: 2, x: 30, y: 0 }];
    assert.equal(pickEntity(ents, v, 200, 200, 112, 100)?.r, 1);
    assert.equal(pickEntity(ents, v, 200, 200, 125, 100)?.r, 2);
    assert.equal(pickEntity(ents, v, 200, 200, 100, 160), null);
  });

  it("viewBounds is the world box on screen", () => {
    assert.deepEqual(viewBounds({ cx: 100, cy: 50, scale: 0.5 }, 200, 100), { x0: -100, y0: -50, x1: 300, y1: 150 });
  });
});

describe("playback and fetching", () => {
  it("advanceClock runs at the chosen speed, caps a long real-time step and stops at the end", () => {
    assert.deepEqual(advanceClock(1000, 16, 4, 10_000), { t: 1064, ended: false });
    assert.deepEqual(advanceClock(1000, 5000, 1, 10_000), { t: 1250, ended: false }, "a background tab does not jump minutes");
    assert.deepEqual(advanceClock(9_990, 100, 16, 10_000), { t: 10_000, ended: true });
    assert.deepEqual(advanceClock(1000, -5, 16, 10_000), { t: 1000, ended: false });
  });

  const idx: ChunkMeta[] = Array.from({ length: 10 }, (_, i) => ({ seq: i, startMs: i * 60_000, endMs: (i + 1) * 60_000, bytes: 100_000 }));

  it("planFetch: the playhead's chunk and the next first, then forward, then wrap to the start", () => {
    const have = new Set<number>();
    const skip = (s: number) => have.has(s);
    assert.deepEqual(planFetch(idx, skip, 5 * 60_000 + 10, { batch: 4 }), { from: 5, to: 6, seqs: [5, 6] });
    [5, 6].forEach((s) => have.add(s));
    assert.deepEqual(planFetch(idx, skip, 5 * 60_000 + 10, { batch: 4 }), { from: 7, to: 9, seqs: [7, 8, 9] });
    [7, 8, 9].forEach((s) => have.add(s));
    assert.deepEqual(planFetch(idx, skip, 5 * 60_000 + 10, { batch: 4 }), { from: 0, to: 3, seqs: [0, 1, 2, 3] });
    [0, 1, 2, 3].forEach((s) => have.add(s));
    assert.deepEqual(planFetch(idx, skip, 5 * 60_000 + 10, { batch: 4 }), { from: 4, to: 4, seqs: [4] });
    have.add(4);
    assert.equal(planFetch(idx, skip, 0), null);
  });

  it("planFetch: a seek re-prioritises; batches stop at a loaded chunk and at the byte cap", () => {
    const have = new Set([3]);
    const skip = (s: number) => have.has(s);
    assert.deepEqual(planFetch(idx, skip, 0, { batch: 8, ahead: 0 }), { from: 0, to: 0, seqs: [0] });
    assert.deepEqual(planFetch(idx, (s) => s === 0, 0, { batch: 8, ahead: 0 })!.seqs, [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(planFetch(idx, skip, 60_000, { batch: 8, ahead: 1 })!.seqs, [1, 2]);
    assert.deepEqual(planFetch(idx, skip, 4 * 60_000, { batch: 8, ahead: 0, maxBytes: 250_000 })!.seqs, [4]);
    assert.deepEqual(planFetch(idx, (s) => s <= 4, 4 * 60_000, { batch: 8, ahead: 0, maxBytes: 250_000 })!.seqs, [5, 6]);
    assert.deepEqual(planFetch(idx, () => false, 99 * 60_000)!.seqs, [9], "past the end: the last chunk");
    assert.equal(planFetch([], () => false, 0), null);
    const huge = [{ seq: 0, startMs: 0, endMs: 60_000, bytes: 9e9 }];
    assert.deepEqual(planFetch(huge, () => false, 0)!.seqs, [0], "one chunk always fits");
  });

  it("formats clock, bytes and the list status", () => {
    assert.equal(fmtClock(0), "0:00");
    assert.equal(fmtClock(61_999), "1:01");
    assert.equal(fmtClock(45 * 60_000), "45:00");
    assert.equal(fmtBytes(512), "512 Б");
    assert.equal(fmtBytes(18_081), "18 КБ");
    assert.equal(fmtBytes(5_138_022), "4,9 МБ");
    const t0 = Date.UTC(2026, 9, 4, 6, 0, 0);
    const r = { startedAt: new Date(t0).toISOString(), endedAt: null, lastMs: 120_000 };
    assert.equal(replayStatus(r, t0 + 150_000), "live");
    assert.equal(replayStatus(r, t0 + 120_000 + 5 * 60_000 + 1), "cut");
    assert.equal(replayStatus({ ...r, endedAt: new Date(t0 + 2_700_000).toISOString() }, t0), "done");
  });
});

describe("map culling grid", () => {
  it("buckets rects and circles by cell and returns each index once, in draw order", () => {
    const map = {
      width: 4096,
      height: 4096,
      rects: [
        { x: 0, y: 0, w: 4096, h: 40, f: 7, k: "border" as const },
        { x: 900, y: 900, w: 300, h: 20, f: 7, k: "wall" as const },
        { x: 3000, y: 3000, w: 10, h: 10, f: 7, k: "crate" as const },
        { x: 100, y: 100, w: 500, h: 500, f: 1, k: "water" as const },
      ],
      circles: [
        { x: 1030, y: 1030, r: 20, f: 7, k: "tree" as const },
        { x: 3500, y: 200, r: 10, f: 7, k: "rock" as const },
      ],
    };
    const g = buildCullGrid(map, 1024);
    assert.equal(g.cols, 4);
    const q = queryCull(g, 800, 800, 1300, 1300);
    assert.deepEqual(q, { rects: [1], circles: [0] }, "border and water are not detail; the wall spans two cells but comes once");
    assert.deepEqual(queryCull(g, 2900, 2900, 3100, 3100), { rects: [2], circles: [] });
    assert.deepEqual(queryCull(g, -500, -500, 99_999, 99_999), { rects: [1, 2], circles: [0, 1] });
  });
});

