import { inflateRawSync } from "node:zlib";
import { and, asc, desc, eq, gte, lt, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { REPLAY, REPLAY_REC, WORLD, mapNumber, readReplayHeader } from "@extract/shared";
import { replayChunks, replays } from "../../db/schema";
import type { Db } from "../inventory/db";

/**
 * Admin replays (@extract/shared replay.ts): the game server posts one deflate-raw compressed chunk
 * (about a minute) of every world shard-cycle to /api/admin/replays/ingest, HMAC-signed
 * (replay-ingest.ts). Chunks are stored idempotently by (match_id, seq) in replay_chunks, with one
 * replays index row per shard-cycle (cycle, map, started / ended, entries, bytes). Admins list and
 * read them through /api/admin/replays/** (adminRoute); the replays-retention cron deletes replays
 * older than REPLAY.RETENTION_DAYS. Replays are an admin tool only: no money, CR or items.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
/** Longest base64 text of REPLAY.MAX_CHUNK_BYTES. */
const MAX_B64 = Math.ceil(REPLAY.MAX_CHUNK_BYTES / 3) * 4;
const int = (min: number, max: number) => z.number().int().min(min).max(max);

/** POST /api/admin/replays/ingest body (@extract/shared ReplayChunkUpload), strict: unknown keys are refused. */
export const replayChunkUploadSchema = z
  .object({
    v: z.literal(REPLAY.VERSION),
    matchId: z.string().regex(UUID_RE).transform((s) => s.toLowerCase()),
    cycleId: int(0, 0x7fffffff),
    shard: int(0, 64),
    mapId: z.string().regex(/^[a-z0-9_-]{1,32}$/),
    cycleStartsAt: int(0, Number.MAX_SAFE_INTEGER),
    genVersion: int(1, 32_767).optional(),
    seq: int(0, REPLAY.MAX_SEQ),
    startMs: int(0, WORLD.MAP_MS),
    endMs: int(0, WORLD.MAP_MS),
    frames: int(0, 1_000_000),
    events: int(0, 10_000_000),
    entries: int(0, 1_000_000),
    final: z.boolean(),
    rawBytes: int(13, REPLAY.MAX_RAW_BYTES),
    data: z.string().min(4).max(MAX_B64).regex(B64_RE),
  })
  .strict()
  .refine((b) => b.endMs >= b.startMs, { message: "endMs before startMs", path: ["endMs"] });

export type ReplayChunkUploadParsed = z.infer<typeof replayChunkUploadSchema>;

/**
 * The compressed chunk of a parsed upload, checked without decoding it: base64 → at most
 * MAX_CHUNK_BYTES, inflates within MAX_RAW_BYTES to exactly rawBytes, carries the upload's seq and
 * startMs in its header and ends with an END record. A string = why it was refused.
 */
export function checkReplayData(u: ReplayChunkUploadParsed): { data: Buffer } | string {
  const data = Buffer.from(u.data, "base64");
  if (data.length === 0 || data.length > REPLAY.MAX_CHUNK_BYTES) return "size";
  let raw: Buffer;
  try {
    raw = inflateRawSync(data, { maxOutputLength: REPLAY.MAX_RAW_BYTES });
  } catch {
    return "inflate";
  }
  if (raw.length !== u.rawBytes) return "raw_size";
  try {
    const h = readReplayHeader(raw);
    if (h.seq !== u.seq || h.startMs !== u.startMs) return "header";
  } catch {
    return "header";
  }
  // END record: u8 type, u32 endMs, u8 final.
  if (raw.length < 19 || raw[raw.length - 6] !== REPLAY_REC.END || raw.readUInt32LE(raw.length - 5) !== u.endMs || (raw[raw.length - 1] === 1) !== u.final) {
    return "end";
  }
  return { data };
}

export type ReplayStoreResult = { status: "stored" | "exists"; seq: number } | { status: "conflict"; seq: number };

/**
 * Store one chunk (one transaction): the replays row is created by the shard's first chunk and
 * updated by every new one (chunks, bytes, entries, last_ms, ended_at on the final chunk). A chunk
 * already stored (same match_id, seq) changes nothing ("exists"). A chunk whose cycle / shard / map
 * disagree with the stored row is refused ("conflict").
 */
export async function storeReplayChunk(db: Db, u: ReplayChunkUploadParsed, data: Buffer): Promise<ReplayStoreResult> {
  return db.transaction(async (tx) => {
    await tx
      .insert(replays)
      .values({ matchId: u.matchId, cycleId: u.cycleId, shard: u.shard, mapId: u.mapId, genVersion: u.genVersion ?? null, startedAt: new Date(u.cycleStartsAt) })
      .onConflictDoNothing();
    const [row] = await tx
      .select({ cycleId: replays.cycleId, shard: replays.shard, mapId: replays.mapId })
      .from(replays)
      .where(eq(replays.matchId, u.matchId))
      .for("update");
    if (!row || row.cycleId !== u.cycleId || row.shard !== u.shard || row.mapId !== u.mapId) return { status: "conflict", seq: u.seq };
    const inserted = await tx
      .insert(replayChunks)
      .values({
        matchId: u.matchId,
        seq: u.seq,
        startMs: u.startMs,
        endMs: u.endMs,
        frames: u.frames,
        events: u.events,
        bytes: data.length,
        rawBytes: u.rawBytes,
        final: u.final,
        data,
      })
      .onConflictDoNothing()
      .returning({ seq: replayChunks.seq });
    if (inserted.length === 0) return { status: "exists", seq: u.seq };
    await tx
      .update(replays)
      .set({
        chunks: sql`${replays.chunks} + 1`,
        bytes: sql`${replays.bytes} + ${data.length}`,
        rawBytes: sql`${replays.rawBytes} + ${u.rawBytes}`,
        entries: sql`greatest(${replays.entries}, ${u.entries})`,
        lastMs: sql`greatest(${replays.lastMs}, ${u.endMs})`,
        // A row opened by a chunk without it (older game server) learns the version from a later one.
        ...(u.genVersion !== undefined ? { genVersion: sql`coalesce(${replays.genVersion}, ${u.genVersion})` } : {}),
        ...(u.final ? { endedAt: new Date(u.cycleStartsAt + u.endMs) } : {}),
        updatedAt: new Date(),
      })
      .where(eq(replays.matchId, u.matchId));
    return { status: "stored", seq: u.seq };
  });
}

// ------------------------------------------------------------------------------- admin reads

/** One shard-cycle in the admin replay list. */
export interface AdminReplay {
  matchId: string;
  cycleId: number;
  /** Public map number (mapNumber(cycle)). */
  mapNumber: number;
  shard: number;
  mapId: string;
  /** MAP_GEN_VERSION the map was generated with; null = unknown (recorded before the column). */
  genVersion: number | null;
  startedAt: string;
  /** null while the shard is still running (or it closed without a final chunk). */
  endedAt: string | null;
  /** Cycle clock ms covered so far. */
  lastMs: number;
  entries: number;
  chunks: number;
  bytes: number;
  rawBytes: number;
}

export interface AdminReplayChunkInfo {
  seq: number;
  startMs: number;
  endMs: number;
  frames: number;
  events: number;
  bytes: number;
  rawBytes: number;
  final: boolean;
}

export interface AdminReplayChunk extends AdminReplayChunkInfo {
  /** base64 of the deflate-raw chunk: inflate (DecompressionStream("deflate-raw")) and decodeReplayChunk. */
  data: string;
}

const replayCols = {
  matchId: replays.matchId,
  cycleId: replays.cycleId,
  shard: replays.shard,
  mapId: replays.mapId,
  genVersion: replays.genVersion,
  startedAt: replays.startedAt,
  endedAt: replays.endedAt,
  lastMs: replays.lastMs,
  entries: replays.entries,
  chunks: replays.chunks,
  bytes: replays.bytes,
  rawBytes: replays.rawBytes,
};

function toAdminReplay(r: { matchId: string; cycleId: number; shard: number; mapId: string; genVersion: number | null; startedAt: Date; endedAt: Date | null; lastMs: number; entries: number; chunks: number; bytes: number; rawBytes: number }): AdminReplay {
  return {
    matchId: r.matchId,
    cycleId: r.cycleId,
    mapNumber: mapNumber(r.cycleId),
    shard: r.shard,
    mapId: r.mapId,
    genVersion: r.genVersion,
    startedAt: r.startedAt.toISOString(),
    endedAt: r.endedAt ? r.endedAt.toISOString() : null,
    lastMs: r.lastMs,
    entries: r.entries,
    chunks: r.chunks,
    bytes: Number(r.bytes),
    rawBytes: Number(r.rawBytes),
  };
}

export const LIST_MAX = 100;

/**
 * Newest first (replays_started_at_idx). Paging cursor = the last row of the previous page: `before`
 * its startedAt and `beforeId` its matchId (a restart mid-cycle opens a second shard with the same
 * cycle start, so startedAt alone is not unique).
 */
export async function listReplays(db: Db, opts: { limit?: number; before?: Date | null; beforeId?: string | null } = {}): Promise<AdminReplay[]> {
  const limit = Math.max(1, Math.min(LIST_MAX, Math.floor(opts.limit ?? 50)));
  const before = opts.before ?? null;
  const beforeId = opts.beforeId && UUID_RE.test(opts.beforeId) ? opts.beforeId.toLowerCase() : null;
  const cursor = !before
    ? undefined
    : beforeId
      ? or(lt(replays.startedAt, before), and(eq(replays.startedAt, before), lt(replays.matchId, beforeId)))
      : lt(replays.startedAt, before);
  const rows = await db
    .select(replayCols)
    .from(replays)
    .where(cursor)
    .orderBy(desc(replays.startedAt), desc(replays.matchId))
    .limit(limit);
  return rows.map(toAdminReplay);
}

/** One replay with its chunk index (no data), or null. */
export async function readReplay(db: Db, matchId: string): Promise<{ replay: AdminReplay; chunks: AdminReplayChunkInfo[] } | null> {
  if (!UUID_RE.test(matchId)) return null;
  const id = matchId.toLowerCase();
  const [row] = await db.select(replayCols).from(replays).where(eq(replays.matchId, id));
  if (!row) return null;
  const chunks = await db
    .select({
      seq: replayChunks.seq,
      startMs: replayChunks.startMs,
      endMs: replayChunks.endMs,
      frames: replayChunks.frames,
      events: replayChunks.events,
      bytes: replayChunks.bytes,
      rawBytes: replayChunks.rawBytes,
      final: replayChunks.final,
    })
    .from(replayChunks)
    .where(eq(replayChunks.matchId, id))
    .orderBy(asc(replayChunks.seq));
  return { replay: toAdminReplay(row), chunks };
}

/**
 * Chunks seq ∈ [from, to] with their data, at most REPLAY.READ_MAX_CHUNKS per call; `next` = the
 * seq to ask for next when more of the range is left (null when done).
 */
export async function readReplayChunks(db: Db, matchId: string, from: number, to: number): Promise<{ chunks: AdminReplayChunk[]; next: number | null } | null> {
  if (!UUID_RE.test(matchId)) return null;
  const id = matchId.toLowerCase();
  const lo = Math.max(0, Math.floor(from));
  const hi = Math.min(REPLAY.MAX_SEQ, Math.floor(to));
  if (!(hi >= lo)) return { chunks: [], next: null };
  const rows = await db
    .select({
      seq: replayChunks.seq,
      startMs: replayChunks.startMs,
      endMs: replayChunks.endMs,
      frames: replayChunks.frames,
      events: replayChunks.events,
      bytes: replayChunks.bytes,
      rawBytes: replayChunks.rawBytes,
      final: replayChunks.final,
      data: replayChunks.data,
    })
    .from(replayChunks)
    .where(and(eq(replayChunks.matchId, id), gte(replayChunks.seq, lo), lte(replayChunks.seq, hi)))
    .orderBy(asc(replayChunks.seq))
    .limit(REPLAY.READ_MAX_CHUNKS + 1);
  const more = rows.length > REPLAY.READ_MAX_CHUNKS;
  const page = rows.slice(0, REPLAY.READ_MAX_CHUNKS);
  return {
    chunks: page.map(({ data, ...c }) => ({ ...c, data: Buffer.from(data).toString("base64") })),
    next: more ? rows[REPLAY.READ_MAX_CHUNKS]!.seq : null,
  };
}

// ------------------------------------------------------------------------------- retention

/** Replays deleted per statement and statements per cron call (bounded work per run). */
const PURGE_BATCH = 200;
const PURGE_MAX_BATCHES = 10;

/**
 * Delete replays whose cycle started more than `days` ago (their chunks go with them: FK cascade),
 * oldest first, in batches. Returns how many replays were deleted.
 */
export async function purgeOldReplays(db: Db, now: Date = new Date(), days: number = REPLAY.RETENTION_DAYS): Promise<{ deleted: number; cutoff: string }> {
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  let deleted = 0;
  for (let i = 0; i < PURGE_MAX_BATCHES; i++) {
    const r = await db.execute<{ match_id: string }>(sql`
      delete from replays where match_id in (
        select match_id from replays where started_at < ${cutoff.toISOString()}::timestamptz order by started_at limit ${PURGE_BATCH}
      ) returning match_id`);
    deleted += r.rows.length;
    if (r.rows.length < PURGE_BATCH) break;
  }
  return { deleted, cutoff: cutoff.toISOString() };
}
