/**
 * Replay uploader: chunks are compressed off the tick and posted oldest first; with the web down at
 * most REPLAY.MAX_BUFFERED_CHUNKS stay in memory (and none older than MAX_BUFFER_MS), older ones are
 * dropped with a log line; a 4xx drops the chunk; recovery drains the queue. startShardReplay only
 * records world shards with recording on.
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/game-server/src/world/replay-upload.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { REPLAY, decodeReplayChunk, encodeReplayChunk, type ReplayChunkUpload } from "@extract/shared";
import type { PostResult } from "../net/web-api.js";
import type { SealedReplayChunk } from "../sim/replay-recorder.js";
import { testMatch, worldMatch } from "../sim/test-utils.js";
import { ReplayUploader, startShardReplay, type ReplayShardMeta } from "./replay-upload.js";

const meta: ReplayShardMeta = { matchId: "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b", cycleId: 1234, shard: 0, mapId: "steppe", cycleStartsAt: 1_700_000_000_000, genVersion: 4 };

function chunk(seq: number, final = false): SealedReplayChunk {
  const raw = encodeReplayChunk({ v: REPLAY.VERSION, seq, startMs: seq * 60_000, endMs: (seq + 1) * 60_000, final, roster: [], frames: [], events: [{ t: seq * 60_000, type: "wipe" }] });
  return { seq, startMs: seq * 60_000, endMs: (seq + 1) * 60_000, frames: 0, events: 1, entries: 3, final, raw };
}

function harness(results: Array<PostResult["status"]> = []) {
  const posted: ReplayChunkUpload[] = [];
  const logs: string[] = [];
  const timers: Array<() => void> = [];
  const clock = { t: 1_000_000 };
  let mode: PostResult["status"] = "ok";
  const up = new ReplayUploader({
    post: async (body) => {
      posted.push(body);
      const status = results.shift() ?? mode;
      if (status === "ok") return { status, body: { status: "stored" } };
      if (status === "rejected") return { status, code: 400, body: "bad_body" };
      if (status === "skipped") return { status };
      return { status, error: "ECONNREFUSED" };
    },
    now: () => clock.t,
    setTimer: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimer: () => {},
    log: (msg) => logs.push(msg),
  });
  return { up, posted, logs, timers, clock, setMode: (m: PostResult["status"]) => (mode = m) };
}

test("a chunk is compressed, base64'd and posted with the shard's metadata; the body decodes back", async () => {
  const h = harness();
  await h.up.submit(meta, chunk(0, true));
  assert.equal(h.posted.length, 1);
  const b = h.posted[0]!;
  const { data, ...rest } = b;
  assert.deepEqual(rest, { v: REPLAY.VERSION, ...meta, seq: 0, startMs: 0, endMs: 60_000, frames: 0, events: 1, entries: 3, final: true, rawBytes: chunk(0).raw.length });
  const raw = inflateRawSync(Buffer.from(data, "base64"));
  assert.deepEqual(decodeReplayChunk(raw).events, [{ t: 0, type: "wipe" }]);
  assert.equal(h.up.pending, 0);
  assert.equal(h.up.stats.sent, 1);
});

test("web down: at most MAX_BUFFERED_CHUNKS stay queued, older ones are dropped and logged; recovery drains in order", async () => {
  const h = harness();
  h.setMode("failed");
  for (let s = 0; s < REPLAY.MAX_BUFFERED_CHUNKS + 3; s++) {
    h.clock.t += 60_000 - 1_000; // one chunk a minute, still inside the age limit of the oldest kept
    await h.up.submit(meta, chunk(s));
  }
  assert.equal(h.up.pending, REPLAY.MAX_BUFFERED_CHUNKS);
  assert.equal(h.up.stats.dropped, 3);
  assert.equal(h.logs.filter((l) => /web unreachable: dropped chunk/.test(l)).length, 3);
  assert.equal(h.timers.length, 1, "one retry timer, not one per failure");
  // the web is back: the retry drains the queue oldest first
  h.setMode("ok");
  h.posted.length = 0;
  h.timers.shift()!();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(h.up.pending, 0);
  assert.deepEqual(h.posted.map((b) => b.seq), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});

test("chunks sealed longer ago than MAX_BUFFER_MS are dropped", async () => {
  const h = harness();
  h.setMode("failed");
  await h.up.submit(meta, chunk(0));
  await h.up.submit(meta, chunk(1));
  h.clock.t += REPLAY.MAX_BUFFER_MS + 1;
  await h.up.submit(meta, chunk(2));
  assert.equal(h.up.pending, 1);
  assert.equal(h.up.stats.dropped, 2);
});

test("a 4xx drops the chunk without retrying; the next chunk still goes out", async () => {
  const h = harness(["rejected"]);
  await h.up.submit(meta, chunk(0));
  await h.up.submit(meta, chunk(1));
  assert.deepEqual(h.posted.map((b) => b.seq), [0, 1]);
  assert.equal(h.up.pending, 0);
  assert.equal(h.up.stats.rejected, 1);
  assert.match(h.logs[0]!, /refused: 400/);
  assert.equal(h.timers.length, 0);
});

test("an oversized compressed chunk is dropped before posting", async () => {
  const h = harness();
  const up = new ReplayUploader({ post: async (b) => (h.posted.push(b), { status: "ok", body: null }), compress: async () => new Uint8Array(REPLAY.MAX_CHUNK_BYTES + 1), log: (m) => h.logs.push(m) });
  await up.submit(meta, chunk(0));
  assert.equal(h.posted.length, 0);
  assert.equal(up.stats.dropped, 1);
  assert.match(h.logs[0]!, /exceed/);
});

test("startShardReplay records world shards only, and only when enabled", () => {
  const h = harness();
  assert.equal(startShardReplay(testMatch(1), h.up, true), null, "legacy roster match");
  const { m } = worldMatch();
  assert.equal(startShardReplay(m, h.up, false), null, "recording off");
  assert.ok(startShardReplay(m, h.up, true));
});
