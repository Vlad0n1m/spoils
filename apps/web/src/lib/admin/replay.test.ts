/**
 * Admin replays against the isolated `extract_test` database (see lib/inventory/test-db.ts): the
 * ingest route's guard (size → HMAC → strict schema → data checks), idempotent storage by
 * (matchId, seq) with the replays index row, the admin reads (list with cursor, chunk index, chunk
 * pages that decode back) and the 14-day retention.
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/admin/replay.test.ts
 */
process.env.DATABASE_URL ??= "postgresql://localhost:5432/extract_test";

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { sql } from "drizzle-orm";
import { HEADERS, REPLAY, REPLAY_INGEST_PATH, decodeReplayChunk, encodeReplayChunk, type ReplayChunkUpload } from "@extract/shared";
import { signGameServerBody } from "../game-server-hmac";
import { closeTestDb, lockTestDb, openTestDb } from "../inventory/test-db";
import { checkApiMutation } from "../request-guard";
import { listReplays, purgeOldReplays, readReplay, readReplayChunks } from "./replay";
import { handleReplayIngest } from "./replay-ingest";

const { db, pool } = openTestDb();
const SECRET = "test-replay-secret-0123456789";
const URL_ = `http://web:3000${REPLAY_INGEST_PATH}`;
const T0 = Date.UTC(2026, 9, 4, 6, 0, 0);

before(async () => {
  await lockTestDb(pool);
});
after(async () => {
  await closeTestDb(pool);
});
beforeEach(async () => {
  await db.execute(sql`truncate table replays, replay_chunks restart identity cascade`);
});

function rawChunk(seq: number, final = false, startMs = seq * 60_000, endMs = startMs + 60_000): Uint8Array {
  return encodeReplayChunk({
    v: REPLAY.VERSION,
    seq,
    startMs,
    endMs,
    final,
    roster: [],
    frames: [{ t: startMs, ents: [{ r: 0, kind: "human", x: 100, y: 200, aim: 0, hp: 255, alive: true, extracted: false, connected: true, dormant: false, extracting: false, act: 0 }] }],
    events: [{ t: startMs, type: "kill", victim: 1, killer: 0, weapon: "rifle" }],
  });
}

function upload(matchId: string, seq: number, o: Partial<ReplayChunkUpload> & { raw?: Uint8Array } = {}): ReplayChunkUpload {
  const final = o.final ?? false;
  const startMs = o.startMs ?? seq * 60_000;
  const endMs = o.endMs ?? startMs + 60_000;
  const raw = o.raw ?? rawChunk(seq, final, startMs, endMs);
  const { raw: _raw, ...rest } = o;
  return {
    v: REPLAY.VERSION,
    matchId,
    cycleId: 900_000,
    shard: 0,
    mapId: "steppe",
    cycleStartsAt: T0,
    seq,
    startMs,
    endMs,
    frames: 1,
    events: 1,
    entries: seq + 1,
    final,
    rawBytes: raw.length,
    data: deflateRawSync(raw).toString("base64"),
    ...rest,
  };
}

function signed(body: string, o: { ts?: number; secret?: string; headers?: Record<string, string> } = {}): Request {
  const ts = String(o.ts ?? Date.now());
  return new Request(URL_, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [HEADERS.GAME_SERVER_TS]: ts,
      [HEADERS.GAME_SERVER_SIG]: signGameServerBody(o.secret ?? SECRET, ts, body),
      ...o.headers,
    },
    body,
  });
}

const post = (u: unknown, o?: Parameters<typeof signed>[1]) => handleReplayIngest(signed(JSON.stringify(u), o), db, SECRET);
const count = async (table: "replays" | "replay_chunks") => Number((await db.execute<{ n: string }>(sql`select count(*)::text as n from ${sql.raw(table)}`)).rows[0]!.n);

describe("replay ingest", () => {
  test("auth: unsigned, wrongly signed and stale requests are 401 and store nothing", async () => {
    const id = randomUUID();
    const body = JSON.stringify(upload(id, 0));
    const bare = await handleReplayIngest(new Request(URL_, { method: "POST", headers: { "content-type": "application/json" }, body }), db, SECRET);
    assert.equal(bare.status, 401);
    assert.deepEqual(await bare.json(), { error: "missing_signature" });
    const wrong = await handleReplayIngest(signed(body, { secret: "another-secret" }), db, SECRET);
    assert.equal(wrong.status, 401);
    assert.deepEqual(await wrong.json(), { error: "bad_signature" });
    const stale = await handleReplayIngest(signed(body, { ts: Date.now() - 5 * 60_000 }), db, SECRET);
    assert.equal(stale.status, 401);
    assert.deepEqual(await stale.json(), { error: "stale_timestamp" });
    // a body changed after signing
    const ts = String(Date.now());
    const tampered = new Request(URL_, {
      method: "POST",
      headers: { [HEADERS.GAME_SERVER_TS]: ts, [HEADERS.GAME_SERVER_SIG]: signGameServerBody(SECRET, ts, body) },
      body: body.replace('"seq":0', '"seq":1'),
    });
    assert.equal((await handleReplayIngest(tampered, db, SECRET)).status, 401);
    assert.equal(await count("replays"), 0);
    assert.equal(await count("replay_chunks"), 0);
  });

  test("the CSRF middleware lets the game server's request through (no Origin, JSON body)", () => {
    const req = new Request(URL_, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(checkApiMutation(req), null);
  });

  test("size: a declared or streamed body over MAX_BODY_BYTES is 413 before the signature is checked", async () => {
    const big = await handleReplayIngest(
      new Request(URL_, { method: "POST", headers: { "content-length": String(REPLAY.MAX_BODY_BYTES + 1) }, body: "x" }),
      db,
      SECRET,
    );
    assert.equal(big.status, 413);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 3; i++) c.enqueue(new Uint8Array(REPLAY.MAX_BODY_BYTES / 2));
        c.close();
      },
    });
    const streamed = await handleReplayIngest(new Request(URL_, { method: "POST", body: stream, duplex: "half" } as RequestInit), db, SECRET);
    assert.equal(streamed.status, 413);
  });

  test("schema and data: unknown keys, bad fields and broken chunks are 400", async () => {
    const id = randomUUID();
    const bad = async (u: unknown, error: string, reason?: string) => {
      const r = await post(u);
      assert.equal(r.status, 400, JSON.stringify(u).slice(0, 80));
      const b = (await r.json()) as { error: string; reason?: string };
      assert.equal(b.error, error);
      if (reason) assert.equal(b.reason, reason);
    };
    const good = upload(id, 0);
    await bad({ ...good, extra: 1 }, "bad_body");
    await bad({ ...good, v: REPLAY.VERSION + 1 }, "bad_body");
    await bad({ ...good, genVersion: 1.5 }, "bad_body");
    await bad({ ...good, matchId: "not-a-uuid" }, "bad_body");
    await bad({ ...good, seq: REPLAY.MAX_SEQ + 1 }, "bad_body");
    await bad({ ...good, endMs: good.startMs - 1 }, "bad_body");
    await bad({ ...good, mapId: "Steppe Outskirts" }, "bad_body");
    await bad({ ...good, data: "!!notbase64!!" }, "bad_body");
    await bad({ ...good, data: Buffer.from("not deflate at all").toString("base64") }, "bad_data", "inflate");
    await bad({ ...good, rawBytes: good.rawBytes + 1 }, "bad_data", "raw_size");
    await bad({ ...upload(id, 0), seq: 1 }, "bad_data", "header");
    await bad({ ...good, endMs: good.endMs + 5 }, "bad_data", "end");
    await bad({ ...good, final: true }, "bad_data", "end");
    const r = await handleReplayIngest(signed("{nope"), db, SECRET);
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: "bad_json" });
    assert.equal(await count("replay_chunks"), 0);
  });

  test("idempotent by (matchId, seq): a retry answers exists and changes nothing; the final chunk closes the replay", async () => {
    const id = randomUUID();
    const c0 = upload(id, 0);
    const r0 = await post(c0);
    assert.equal(r0.status, 200);
    assert.deepEqual(await r0.json(), { status: "stored", seq: 0 });
    const again = await post(c0);
    assert.equal(again.status, 200);
    assert.deepEqual(await again.json(), { status: "exists", seq: 0 });
    // a retry with other bytes for the same seq is still "exists": the first copy wins
    const other = upload(id, 0, { entries: 50 });
    assert.deepEqual(await (await post(other)).json(), { status: "exists", seq: 0 });

    let [row] = (await db.execute<{ chunks: number; bytes: string; entries: number; last_ms: number; ended_at: Date | null }>(sql`select chunks, bytes::text, entries, last_ms, ended_at from replays where match_id = ${id}`)).rows;
    assert.equal(row!.chunks, 1);
    assert.equal(Number(row!.bytes), Buffer.from(c0.data, "base64").length);
    assert.equal(row!.entries, 1);
    assert.equal(row!.last_ms, 60_000);
    assert.equal(row!.ended_at, null);

    // chunks may land out of order (a buffered one after a newer one)
    const c2 = upload(id, 2, { final: true, startMs: 120_000, endMs: 150_000 });
    assert.deepEqual(await (await post(c2)).json(), { status: "stored", seq: 2 });
    assert.deepEqual(await (await post(upload(id, 1))).json(), { status: "stored", seq: 1 });
    [row] = (await db.execute<{ chunks: number; bytes: string; entries: number; last_ms: number; ended_at: Date | null }>(sql`select chunks, bytes::text, entries, last_ms, ended_at from replays where match_id = ${id}`)).rows;
    assert.equal(row!.chunks, 3);
    assert.equal(row!.entries, 3);
    assert.equal(row!.last_ms, 150_000);
    assert.equal(new Date(row!.ended_at!).getTime(), T0 + 150_000, "ended_at = cycle start + the final chunk's end");
    assert.equal(await count("replay_chunks"), 3);

    // the same matchId under another cycle / shard / map is a conflict
    const clash = await post(upload(id, 3, { cycleId: 900_001 }));
    assert.equal(clash.status, 409);
    assert.equal(await count("replay_chunks"), 3);
  });
});

describe("replay map generator version", () => {
  test("genVersion is stored from the first chunk that carries it and shows in the reads; an older game server leaves it null", async () => {
    const id = randomUUID();
    assert.deepEqual(await (await post(upload(id, 0, { genVersion: 3 }))).json(), { status: "stored", seq: 0 });
    // A later chunk never rewrites it.
    await post(upload(id, 1, { genVersion: 4 }));
    let [row] = (await db.execute<{ gen_version: number | null }>(sql`select gen_version from replays where match_id = ${id}`)).rows;
    assert.equal(row!.gen_version, 3);
    assert.equal((await readReplay(db, id))?.replay.genVersion, 3);
    assert.equal((await listReplays(db)).find((r) => r.matchId === id)?.genVersion, 3);
    // An older game server sends none: null until a chunk with it arrives.
    const old = randomUUID();
    const { genVersion: _g, ...noVersion } = upload(old, 0);
    await post(noVersion as ReplayChunkUpload);
    [row] = (await db.execute<{ gen_version: number | null }>(sql`select gen_version from replays where match_id = ${old}`)).rows;
    assert.equal(row!.gen_version, null);
    await post(upload(old, 1, { genVersion: 4 }));
    [row] = (await db.execute<{ gen_version: number | null }>(sql`select gen_version from replays where match_id = ${old}`)).rows;
    assert.equal(row!.gen_version, 4);
    // Out of range is refused.
    assert.equal((await post(upload(randomUUID(), 0, { genVersion: 0 }))).status, 400);
  });
});

describe("replay reads and retention", () => {
  test("list newest first with a cursor; the chunk index; chunk pages decode back", async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    // two shards of the same cycle start (a restart mid-cycle) and an older cycle
    await post(upload(ids[0]!, 0, { cycleStartsAt: T0 - 45 * 60_000, cycleId: 899_999 }));
    await post(upload(ids[1]!, 0));
    await post(upload(ids[2]!, 0));
    const all = await listReplays(db, { limit: 10 });
    assert.equal(all.length, 3);
    assert.equal(all.at(-1)!.matchId, ids[0]);
    assert.ok(all[0]!.startedAt >= all[1]!.startedAt);
    assert.equal(all[0]!.mapId, "steppe");
    assert.equal(typeof all[0]!.mapNumber, "number");
    const page1 = await listReplays(db, { limit: 1 });
    const page2 = await listReplays(db, { limit: 1, before: new Date(page1[0]!.startedAt), beforeId: page1[0]!.matchId });
    const page3 = await listReplays(db, { limit: 5, before: new Date(page2[0]!.startedAt), beforeId: page2[0]!.matchId });
    assert.deepEqual([...page1, ...page2, ...page3].map((r) => r.matchId), all.map((r) => r.matchId), "no row skipped at a same-start boundary");

    const id = ids[1]!;
    for (let s = 1; s < REPLAY.READ_MAX_CHUNKS + 3; s++) await post(upload(id, s));
    const r = await readReplay(db, id);
    assert.ok(r);
    assert.equal(r.replay.chunks, REPLAY.READ_MAX_CHUNKS + 3);
    assert.deepEqual(r.chunks.map((c) => c.seq), Array.from({ length: REPLAY.READ_MAX_CHUNKS + 3 }, (_, i) => i));
    assert.equal(await readReplay(db, randomUUID()), null);
    assert.equal(await readReplay(db, "nope"), null);

    const p1 = await readReplayChunks(db, id, 0, REPLAY.MAX_SEQ);
    assert.ok(p1);
    assert.equal(p1.chunks.length, REPLAY.READ_MAX_CHUNKS);
    assert.equal(p1.next, REPLAY.READ_MAX_CHUNKS);
    const p2 = await readReplayChunks(db, id, p1.next!, REPLAY.MAX_SEQ);
    assert.deepEqual(p2!.chunks.map((c) => c.seq), [REPLAY.READ_MAX_CHUNKS, REPLAY.READ_MAX_CHUNKS + 1, REPLAY.READ_MAX_CHUNKS + 2]);
    assert.equal(p2!.next, null);
    const one = await readReplayChunks(db, id.toUpperCase(), 4, 4);
    assert.equal(one!.chunks.length, 1);
    const decoded = decodeReplayChunk(inflateRawSync(Buffer.from(one!.chunks[0]!.data, "base64")));
    assert.equal(decoded.seq, 4);
    assert.deepEqual(decoded.events, [{ t: 240_000, type: "kill", victim: 1, killer: 0, weapon: "rifle" }]);
    assert.deepEqual((await readReplayChunks(db, id, 50, 60))!.chunks, []);
  });

  test("retention deletes replays (and their chunks) whose cycle started more than 14 days ago", async () => {
    const now = new Date(T0);
    const old = randomUUID();
    const edge = randomUUID();
    const fresh = randomUUID();
    await post(upload(old, 0, { cycleStartsAt: T0 - 15 * 86_400_000 }));
    await post(upload(old, 1, { cycleStartsAt: T0 - 15 * 86_400_000 }));
    await post(upload(edge, 0, { cycleStartsAt: T0 - 14 * 86_400_000 + 60_000 }));
    await post(upload(fresh, 0));
    const r = await purgeOldReplays(db, now);
    assert.equal(r.deleted, 1);
    assert.equal(r.cutoff, new Date(T0 - 14 * 86_400_000).toISOString());
    assert.deepEqual((await listReplays(db)).map((x) => x.matchId).sort(), [edge, fresh].sort());
    assert.equal(await count("replay_chunks"), 2);
    assert.equal((await purgeOldReplays(db, now)).deleted, 0);
  });
});
