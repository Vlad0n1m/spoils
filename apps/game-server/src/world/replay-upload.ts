/**
 * Admin replays, network side: a ReplayRecorder per world shard (sim/replay-recorder.ts) and one
 * process-wide uploader. A sealed chunk (about one minute) is deflate-raw compressed on the libuv
 * thread pool (never in the tick), base64'd into a ReplayChunkUpload and POSTed HMAC-signed
 * (postSigned) to REPLAY_INGEST_PATH, oldest first. The web stores chunks idempotently by
 * (matchId, seq), so a retried post is harmless.
 *
 * Web down: unsent chunks stay queued, at most REPLAY.MAX_BUFFERED_CHUNKS and none sealed longer
 * than REPLAY.MAX_BUFFER_MS ago; older ones are dropped with a log line. A failed round is retried
 * after RETRY_MS (and whenever a new chunk arrives). A 4xx answer drops that chunk (logged).
 *
 * Recording runs only when the web API is configured (WEB_API_BASE_URL + GAME_SERVER_HMAC_SECRET)
 * and REPLAY_RECORD is not "0" (the switch to turn it off without a deploy of the code).
 */

import { promisify } from "node:util";
import { deflateRaw } from "node:zlib";
import { REPLAY, REPLAY_INGEST_PATH, type ReplayChunkUpload } from "@extract/shared";
import { postSigned, webApiConfigured, type PostResult } from "../net/web-api.js";
import type { Match } from "../sim/match.js";
import { ReplayRecorder, type SealedReplayChunk } from "../sim/replay-recorder.js";

const deflateRawAsync = promisify(deflateRaw);

/** Pause after a failed upload round before the queue is tried again. */
export const RETRY_MS = 30_000;

/** The shard a chunk belongs to (ReplayChunkUpload fields that never change within a shard-cycle). */
export interface ReplayShardMeta {
  matchId: string;
  cycleId: number;
  shard: number;
  mapId: string;
  cycleStartsAt: number;
}

export interface ReplayUploaderDeps {
  post(body: ReplayChunkUpload): Promise<PostResult>;
  compress(raw: Uint8Array): Promise<Uint8Array>;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  log(msg: string): void;
  maxChunks: number;
  maxAgeMs: number;
  retryMs: number;
}

interface Pending {
  body: ReplayChunkUpload;
  sealedAt: number;
}

export function defaultUploaderDeps(): ReplayUploaderDeps {
  return {
    post: (body) => postSigned(REPLAY_INGEST_PATH, body, { attempts: 2, backoffMs: 1_000, timeoutMs: 20_000 }),
    compress: (raw) => deflateRawAsync(raw, { level: 6 }),
    now: Date.now,
    setTimer: (fn, ms) => {
      const h = setTimeout(fn, ms);
      h.unref();
      return h;
    },
    clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
    log: (msg) => console.error(msg),
    maxChunks: REPLAY.MAX_BUFFERED_CHUNKS,
    maxAgeMs: REPLAY.MAX_BUFFER_MS,
    retryMs: RETRY_MS,
  };
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");

export class ReplayUploader {
  private readonly deps: ReplayUploaderDeps;
  private readonly queue: Pending[] = [];
  private pumping = false;
  private retry: unknown = null;
  readonly stats = { queued: 0, sent: 0, dropped: 0, rejected: 0, failedRounds: 0 };

  constructor(deps: Partial<ReplayUploaderDeps> = {}) {
    this.deps = { ...defaultUploaderDeps(), ...deps };
  }

  /** Chunks waiting for the web. */
  get pending(): number {
    return this.queue.length;
  }

  /** Compress, queue and start posting a sealed chunk. Never rejects. */
  async submit(meta: ReplayShardMeta, chunk: SealedReplayChunk): Promise<void> {
    try {
      const data = await this.deps.compress(chunk.raw);
      if (data.length > REPLAY.MAX_CHUNK_BYTES) {
        this.stats.dropped++;
        this.deps.log(`[replay] ${meta.matchId}/${chunk.seq}: ${data.length} compressed bytes exceed ${REPLAY.MAX_CHUNK_BYTES}, dropped`);
        return;
      }
      const body: ReplayChunkUpload = {
        v: REPLAY.VERSION,
        matchId: meta.matchId,
        cycleId: meta.cycleId,
        shard: meta.shard,
        mapId: meta.mapId,
        cycleStartsAt: meta.cycleStartsAt,
        seq: chunk.seq,
        startMs: chunk.startMs,
        endMs: chunk.endMs,
        frames: chunk.frames,
        events: chunk.events,
        entries: chunk.entries,
        final: chunk.final,
        rawBytes: chunk.raw.length,
        data: b64(data),
      };
      this.queue.push({ body, sealedAt: this.deps.now() });
      this.stats.queued++;
      this.trim();
    } catch (e) {
      this.stats.dropped++;
      this.deps.log(`[replay] ${meta.matchId}/${chunk.seq}: compression failed, dropped (${e instanceof Error ? e.message : String(e)})`);
      return;
    }
    await this.pump();
  }

  /** Drop what is over the count / age limits, oldest first (logged). */
  private trim(): void {
    const now = this.deps.now();
    while (this.queue.length > this.deps.maxChunks || (this.queue.length > 0 && now - this.queue[0]!.sealedAt > this.deps.maxAgeMs)) {
      const d = this.queue.shift()!;
      this.stats.dropped++;
      this.deps.log(`[replay] web unreachable: dropped chunk ${d.body.matchId}/${d.body.seq} (${this.queue.length} kept in memory)`);
    }
  }

  private remove(p: Pending): void {
    const i = this.queue.indexOf(p);
    if (i >= 0) this.queue.splice(i, 1);
  }

  /** Post the queue oldest first until it is empty or a round fails (then retry after retryMs). */
  async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        this.trim();
        const head = this.queue[0];
        if (!head) return;
        let r: PostResult;
        try {
          r = await this.deps.post(head.body);
        } catch (e) {
          r = { status: "failed", error: e instanceof Error ? e.message : String(e) };
        }
        if (r.status === "ok") {
          this.stats.sent++;
          this.remove(head);
        } else if (r.status === "rejected" || r.status === "skipped") {
          this.stats.rejected++;
          this.remove(head);
          this.deps.log(`[replay] ${head.body.matchId}/${head.body.seq} refused: ${r.status === "rejected" ? `${r.code} ${r.body}` : "web API not configured"}`);
        } else {
          this.stats.failedRounds++;
          this.scheduleRetry();
          return;
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private scheduleRetry(): void {
    if (this.retry !== null) return;
    this.retry = this.deps.setTimer(() => {
      this.retry = null;
      void this.pump();
    }, this.deps.retryMs);
  }

  /** Clear the retry timer (tests). */
  stop(): void {
    if (this.retry !== null) this.deps.clearTimer(this.retry);
    this.retry = null;
  }
}

/** The process-wide uploader every shard's recorder feeds. */
export const replayUploader = new ReplayUploader();

/** Replays are recorded: the web API is configured and REPLAY_RECORD is not "0". */
export function replayEnabled(): boolean {
  return webApiConfigured() && process.env.REPLAY_RECORD?.trim() !== "0";
}

/**
 * The recorder of one world shard, wired to the uploader (BattleRoom.onCreate), or null: not a
 * world match, or recording is off.
 */
export function startShardReplay(match: Match, uploader: ReplayUploader = replayUploader, enabled = replayEnabled()): ReplayRecorder | null {
  if (!match.world || !enabled) return null;
  const meta: ReplayShardMeta = {
    matchId: match.state.matchId,
    cycleId: match.world.cycleId,
    shard: match.world.shard,
    mapId: match.map.id,
    cycleStartsAt: match.world.cycleStartsAt,
  };
  return new ReplayRecorder(match, { onChunk: (c) => void uploader.submit(meta, c) });
}
