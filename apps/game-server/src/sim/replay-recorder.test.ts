/**
 * Admin replay recorder on a tiny world match (an NPC post, two raiders in a party, a kill, an
 * extract, the wipe): chunk boundaries, the per-chunk roster and KEY frames, spawn identities,
 * events, the leave rows, error isolation, and a short cost benchmark (< 0.2 ms per tick on
 * average with ~250 moving runtimes and steady fire).
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/game-server/src/sim/replay-recorder.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { SERVER_TICK_MS, decodeReplayChunk, type ReplayChunkData, type ReplayEvent } from "@extract/shared";
import { killPlayer } from "./death.js";
import { extractPlayer } from "./extraction.js";
import type { Match } from "./match.js";
import { MAX_ERRORS, ReplayRecorder, type SealedReplayChunk } from "./replay-recorder.js";
import { WORLD_T0, addExtract, enter, npcOpts, testMap, testPost, worldMatch, type WallClock } from "./test-utils.js";
import type { MatchEvent } from "./types.js";

function tickN(m: Match, wall: WallClock, rec: ReplayRecorder, ms: number, extra: () => MatchEvent[] = () => []): void {
  for (let t = 0; t < ms - 1e-6; t += SERVER_TICK_MS) {
    wall.t += SERVER_TICK_MS;
    m.step(SERVER_TICK_MS);
    rec.tick([...m.drainEvents(), ...extra()]);
    if (rec.done) return;
  }
}

const decodeAll = (chunks: SealedReplayChunk[]): ReplayChunkData[] => chunks.map((c) => decodeReplayChunk(c.raw));
const eventsOf = <K extends ReplayEvent["type"]>(cs: ReplayChunkData[], type: K) =>
  cs.flatMap((c) => c.events.filter((e): e is Extract<ReplayEvent, { type: K }> => e.type === type));

test("a tiny world match records spawns, frames, a kill, an extract and the wipe in self-contained chunks", () => {
  const { m, wall } = worldMatch({ startOffsetMs: -1000, ...npcOpts([testPost(0, 3600, 3600)]), npcBrains: false });
  const chunks: SealedReplayChunk[] = [];
  const rec = new ReplayRecorder(m, { onChunk: (c) => chunks.push(c), chunkMs: 1000 });

  // Prewarmed: nothing is recorded before the cycle starts.
  tickN(m, wall, rec, 900);
  assert.equal(rec.stats.ticks, 0);
  assert.equal(chunks.length, 0);
  tickN(m, wall, rec, 200);
  assert.ok(rec.stats.ticks > 0);

  const party = "2eaf4b20-7d8c-4f9f-9e30-4c5d6e7f8091";
  const a = enter(m, "ua", { nickname: "Alpha", partyId: party, dropId: "d1", level: 7 });
  const b = enter(m, "ub", { nickname: "Bravo", guest: true });
  a.pub.x = a.prevX = 1234;
  a.pub.y = a.prevY = 2346;
  tickN(m, wall, rec, 2500);

  // Synthetic sim events the arena cannot produce: a container opened, a corpse and a crate searched.
  let once = true;
  const extra = () => (once ? ((once = false), [
    { type: "chest", src: a.rosterIndex, idx: 9 },
    { type: "view", to: a.rosterIndex, op: "add", key: "k5" },
    { type: "view", to: a.rosterIndex, op: "add", key: "c9" },
    { type: "view", to: a.rosterIndex, op: "remove", key: "c9" },
  ] as MatchEvent[]) : []);
  tickN(m, wall, rec, 100, extra);

  killPlayer(m, b, a, "rifle");
  tickN(m, wall, rec, 400);
  const e = addExtract(m, a.pub.x, a.pub.y);
  extractPlayer(m, a);
  tickN(m, wall, rec, 400);
  m.wipe();
  tickN(m, wall, rec, 100);
  assert.equal(rec.done, true);
  rec.close(); // after the final chunk: no-op
  const n = chunks.length;
  rec.tick([]);
  assert.equal(chunks.length, n);

  const cs = decodeAll(chunks);
  // seq 0..n-1, contiguous clock windows, only the last one final
  assert.deepEqual(cs.map((c) => c.seq), cs.map((_, i) => i));
  for (let i = 1; i < cs.length; i++) assert.equal(cs[i]!.startMs, cs[i - 1]!.endMs, `chunk ${i} starts where ${i - 1} ended`);
  assert.deepEqual(cs.map((c) => c.final), cs.map((_, i) => i === cs.length - 1));
  assert.ok(cs.length >= 4, `${cs.length} chunks of ≤ 1 s`);
  for (const c of cs.slice(0, -1)) assert.ok(c.endMs - c.startMs >= 1000 && c.endMs - c.startMs < 1000 + 200, "sealed on the first frame after chunkMs");
  // sealed metadata mirrors the bytes
  chunks.forEach((c, i) => {
    assert.equal(c.frames, cs[i]!.frames.length);
    assert.equal(c.events, cs[i]!.events.length);
    assert.equal(c.startMs, cs[i]!.startMs);
  });
  assert.equal(chunks.at(-1)!.entries, 2);

  // frames every 200 ms of cycle clock
  const times = cs.flatMap((c) => c.frames.map((f) => f.t));
  for (let i = 1; i < times.length - 1; i++) assert.equal(times[i]! - times[i - 1]!, 200, `frame gap at ${times[i]}`);

  // spawns: the NPC at the first tick, then both raiders with their identity
  const spawns = eventsOf(cs, "spawn").map((s) => s.spawn);
  assert.equal(spawns.length, 3);
  assert.equal(spawns[0]!.kind, "marauder");
  assert.equal(spawns[0]!.userId, "");
  const sa = spawns.find((s) => s.userId === "ua")!;
  assert.deepEqual(
    { r: sa.r, kind: sa.kind, nickname: sa.nickname, entryId: sa.entryId, partyId: sa.partyId, level: sa.level, guest: sa.guest, maxHp: sa.maxHp },
    { r: a.rosterIndex, kind: "human", nickname: "Alpha", entryId: a.entryId, partyId: party, level: 7, guest: false, maxHp: 100 },
  );
  assert.equal(spawns.find((s) => s.userId === "ub")!.guest, true);
  // later chunks carry everyone spawned before them in their roster
  assert.deepEqual(cs.at(-1)!.roster.map((s) => s.r).sort((x, y) => x - y), [0, a.rosterIndex, b.rosterIndex]);

  // every chunk opens with a KEY frame that lists every runtime on the map
  for (const c of cs.slice(1, -1)) {
    const first = c.frames[0]!;
    const living = first.ents.filter((x) => x.alive).map((x) => x.r);
    assert.ok(living.includes(0), `chunk ${c.seq}: the NPC is in the key frame`);
  }
  const npcRow = cs[0]!.frames.at(-1)!.ents.find((x) => x.r === 0)!;
  const npc = m.allRuntimes()[0]!;
  assert.equal(npcRow.kind, "marauder");
  assert.deepEqual([npcRow.x, npcRow.y], [Math.round(npc.pub.x / 2) * 2, Math.round(npc.pub.y / 2) * 2]);
  const aRow = cs.flatMap((c) => c.frames).flatMap((f) => f.ents).find((x) => x.r === a.rosterIndex && x.alive)!;
  assert.deepEqual([aRow.x, aRow.y, aRow.hp, aRow.kind, aRow.connected], [1234, 2346, 255, "human", false]);

  // the kill, the leave rows, the extract
  assert.deepEqual(eventsOf(cs, "kill").map((k) => [k.victim, k.killer, k.weapon]), [[b.rosterIndex, a.rosterIndex, "rifle"]]);
  const frames = cs.flatMap((c) => c.frames);
  const bLeft = frames.findIndex((f) => f.ents.some((x) => x.r === b.rosterIndex && !x.alive));
  assert.ok(bLeft > 0, "B is listed once with alive = false");
  assert.ok(frames.slice(bLeft + 1).every((f) => f.ents.every((x) => x.r !== b.rosterIndex)), "then gone");
  const exits = eventsOf(cs, "exit");
  assert.deepEqual(exits.map((x) => [x.r, x.exit, x.extractId]), [[b.rosterIndex, "dead", ""], [a.rosterIndex, "extract", e.id]]);
  assert.ok(frames.some((f) => f.ents.some((x) => x.r === a.rosterIndex && !x.alive && x.extracted)), "A leaves with EXTRACTED");
  assert.deepEqual(eventsOf(cs, "chest").map((x) => [x.r, x.idx]), [[a.rosterIndex, 9]]);
  assert.deepEqual(eventsOf(cs, "loot").map((x) => [x.target, x.id]), [["corpse", 5], ["container", 9]]);

  // the wipe: WIPE in the final chunk, everyone left on the map leaves in its last frame
  const last = cs.at(-1)!;
  assert.equal(eventsOf([last], "wipe").length, 1);
  assert.ok(last.frames.at(-1)!.ents.some((x) => x.r === 0 && !x.alive), "the NPC leaves at the wipe");
});

test("the event boss: spawned as a boss, its brain state is recorded on change, its death as a kill", () => {
  const spot = { kind: "foreman" as const, zone: "z-elevator", x: 3500, y: 3800, guards: [], chance: 1 };
  const map = testMap();
  map.bosses = [spot];
  const { m, wall } = worldMatch({ map, bossEvent: "foreman", bosses: true });
  const chunks: SealedReplayChunk[] = [];
  const rec = new ReplayRecorder(m, { onChunk: (c) => chunks.push(c) });
  const boss = m.eventBoss()!;
  const brain = m.npcs.brain(boss)!;
  tickN(m, wall, rec, 400);
  const before = brain.state;
  const forced = before === "combat" ? "search" : "combat";
  brain.state = forced;
  tickN(m, wall, rec, 400);
  killPlayer(m, boss, null, "");
  tickN(m, wall, rec, 400);
  rec.close();
  const cs = decodeAll(chunks);
  const spawn = eventsOf(cs, "spawn").find((e) => e.spawn.r === boss.rosterIndex)!.spawn;
  assert.equal(spawn.kind, "boss");
  assert.equal(spawn.maxHp, boss.pub.maxHp);
  const states = eventsOf(cs, "boss");
  assert.ok(states.every((e) => e.r === boss.rosterIndex));
  assert.deepEqual(states.slice(0, 2).map((e) => e.state), [before, forced], "the first frame, then the change");
  for (let i = 1; i < states.length; i++) assert.notEqual(states[i]!.state, states[i - 1]!.state, "recorded on change only");
  assert.deepEqual(eventsOf(cs, "kill").map((k) => [k.victim, k.killer, k.weapon]), [[boss.rosterIndex, -1, ""]]);
  const rows = cs.flatMap((c) => c.frames).flatMap((f) => f.ents).filter((x) => x.r === boss.rosterIndex);
  assert.equal(rows[0]!.kind, "boss");
  assert.equal(rows.at(-1)!.alive, false);
});

test("a recorder error drops its chunk and never reaches the tick; repeated errors stop recording", () => {
  const { m, wall } = worldMatch({ startOffsetMs: 0 });
  const chunks: SealedReplayChunk[] = [];
  const logs: string[] = [];
  const rec = new ReplayRecorder(m, { onChunk: (c) => chunks.push(c), chunkMs: 1000, log: (msg) => logs.push(msg) });
  const a = enter(m, "ua");
  tickN(m, wall, rec, 1100);
  assert.equal(chunks.length, 1);
  // a kill event whose victim lookup throws
  const runtime = m.runtime.bind(m);
  let broken = true;
  m.runtime = (id: string) => {
    if (broken) throw new Error("boom");
    return runtime(id);
  };
  const killEv = { type: "kill", src: -1, msg: { victim: "A", victimId: a.id, killer: "", killerId: "", weapon: "" } } as MatchEvent;
  assert.doesNotThrow(() => rec.tick([killEv]));
  assert.equal(rec.stats.errors, 1);
  assert.equal(rec.stats.droppedChunks, 1);
  assert.match(logs[0]!, /chunk dropped/);
  broken = false;
  tickN(m, wall, rec, 1200);
  const cs = decodeAll(chunks);
  assert.deepEqual(cs.map((c) => c.seq), [0, 2], "seq 1 was dropped, the gap shows");
  assert.equal(cs[1]!.frames[0]!.ents.length, 1, "the fresh chunk opens with a key frame");

  broken = true;
  for (let i = 0; i < MAX_ERRORS + 2; i++) rec.tick([killEv]);
  assert.equal(rec.stats.errors, MAX_ERRORS);
  assert.equal(rec.done, true);
  assert.match(logs.at(-1)!, /recording stopped/);
});

test("closing the room seals what was recorded as the final chunk", () => {
  const { m, wall } = worldMatch({ startOffsetMs: 0 });
  const chunks: SealedReplayChunk[] = [];
  const rec = new ReplayRecorder(m, { onChunk: (c) => chunks.push(c) });
  enter(m, "ua");
  tickN(m, wall, rec, 1000);
  rec.close();
  const cs = decodeAll(chunks);
  assert.equal(cs.length, 1);
  assert.equal(cs[0]!.final, true);
  assert.equal(cs[0]!.frames.length, 5);
  // a never-started recorder seals nothing
  const pre = worldMatch({ startOffsetMs: -5000 });
  const none: SealedReplayChunk[] = [];
  const r2 = new ReplayRecorder(pre.m, { onChunk: (c) => none.push(c) });
  r2.tick([]);
  r2.close();
  assert.equal(none.length, 0);
});

test("cost: < 0.2 ms per tick on average with ~250 moving runtimes and steady fire", () => {
  // 50 posts × 4 marauders + 50 raiders = 250 runtimes; nobody steps (only the recorder is timed).
  const posts = Array.from({ length: 50 }, (_, i) => testPost(i, 400 + (i % 10) * 400, 400 + Math.floor(i / 10) * 800, { size: [4, 4] }));
  const { m, wall } = worldMatch({ startOffsetMs: 0, ...npcOpts(posts), npcBrains: false });
  for (let i = 0; i < 50; i++) enter(m, `u${i}`, { nickname: `raider-${i}` });
  const rts = m.allRuntimes();
  assert.ok(rts.length >= 240, `${rts.length} runtimes`);
  // Compression runs off the tick in production (replay-upload.ts): only collect here, measure after.
  const sealed: Uint8Array[] = [];
  const rec = new ReplayRecorder(m, { onChunk: (c) => sealed.push(c.raw) });
  const minutes = 10;
  const ticks = (minutes * 60_000) / SERVER_TICK_MS;
  const shooters = rts.filter((rt) => !rt.isNpc);
  let spent = 0;
  let worst = 0;
  for (let k = 0; k < ticks; k++) {
    wall.t += SERVER_TICK_MS;
    m.state.clockMs = wall.t - WORLD_T0;
    for (const rt of rts) {
      rt.pub.x += Math.cos(k * 0.05 + rt.rosterIndex) * 9;
      rt.pub.y += Math.sin(k * 0.05 + rt.rosterIndex) * 9;
      rt.pub.aim = (k * 0.03 + rt.rosterIndex) % 6.28;
    }
    const events: MatchEvent[] = [];
    for (let s = 0; s < 4; s++) {
      const sh = shooters[(k * 4 + s) % shooters.length]!;
      events.push({ type: "shot", src: sh.rosterIndex, msg: { s: sh.id, w: "rifle", x: sh.pub.x, y: sh.pub.y, cx: sh.pub.x, cy: sh.pub.y, a: [sh.pub.aim] } });
    }
    events.push({ type: "hit", src: shooters[k % shooters.length]!.rosterIndex, target: (k * 7) % rts.length, msg: { t: "", s: "", x: 0, y: 0, d: 11.5, ar: false }, fa: undefined });
    events.push({ type: "sound", src: 0, kind: 0, x: 0, y: 0, radius: 100, variant: 0 } as MatchEvent);
    const t0 = performance.now();
    rec.tick(events);
    const dt = performance.now() - t0;
    spent += dt;
    if (dt > worst) worst = dt;
  }
  rec.close();
  const avg = spent / ticks;
  const sizes = sealed.map((raw) => ({ raw: raw.length, packed: deflateRawSync(raw).length }));
  const perMin = sizes.slice(0, -1);
  const packed = perMin.reduce((s, x) => s + x.packed, 0) / Math.max(1, perMin.length);
  const raw = perMin.reduce((s, x) => s + x.raw, 0) / Math.max(1, perMin.length);
  console.log(
    `[replay bench] ${rts.length} runtimes, ${ticks} ticks: avg ${(avg * 1000).toFixed(1)} µs/tick, worst ${worst.toFixed(2)} ms; ` +
      `per minute ${(raw / 1024).toFixed(0)} KiB raw, ${(packed / 1024).toFixed(0)} KiB deflated (${minutes} chunks)`,
  );
  assert.equal(rec.stats.errors, 0);
  assert.equal(sizes.length, minutes, "one chunk per minute, the last one sealed by close()");
  assert.ok(avg < 0.2, `recorder costs ${avg.toFixed(3)} ms per tick on average`);
  // a sealed chunk still decodes after compression
  const c = decodeReplayChunk(inflateRawSync(deflateRawSync(sealed.at(-1)!)));
  assert.ok(c.final);
  assert.equal(c.roster.length, rts.length);
});
