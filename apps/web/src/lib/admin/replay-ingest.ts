import { HEADERS, REPLAY } from "@extract/shared";
import { checkGameServerSignature, readCappedText } from "../game-server-hmac";
import type { Db } from "../inventory/db";
import { checkReplayData, replayChunkUploadSchema, storeReplayChunk } from "./replay";

/**
 * POST /api/admin/replays/ingest: game server → web, HMAC-signed like every raids/* call (not an
 * admin session: the route sits under /api/admin only because replays are an admin feature; it is
 * the one handler there that admin.test.ts lets skip adminRoute, and only with this signature
 * check). Order: body size (413, before and while reading) → signature (401) → JSON (400 bad_json)
 * → strict schema (400 bad_body) → compressed data (400 bad_data) → store (200 stored / exists,
 * 409 conflict). A body stream that breaks mid-read is 400 body_aborted, and any other failure a
 * JSON 500 {error: "internal"}: nothing ever escapes to Next's HTML error page. Idempotent by (matchId, seq): the game server may retry any chunk.
 * Kept free of next/* and the app pool so tests call it with the test DB and a test secret.
 */

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export async function handleReplayIngest(req: Request, db: Db, secret: string, now: number = Date.now()): Promise<Response> {
  try {
    return await ingest(req, db, secret, now);
  } catch (e) {
    // Never let an error escape to Next: in dev that is an HTML error page the game server can
    // only log as an opaque "status=500 <!DOCTYPE html>…" (the replay-ingest 500 report).
    console.error("[replays/ingest] failed", e);
    return json({ error: "internal" }, 500);
  }
}

async function ingest(req: Request, db: Db, secret: string, now: number): Promise<Response> {
  let text: string | null;
  try {
    text = await readCappedText(req, REPLAY.MAX_BODY_BYTES);
  } catch {
    // The body stream broke mid-read (the game server gave up on a slow web and aborted): nothing to
    // store; the uploader retries the chunk. Used to throw out of the handler (Next's HTML 500).
    return json({ error: "body_aborted" }, 400);
  }
  if (text === null) return json({ error: "too_large", max: REPLAY.MAX_BODY_BYTES }, 413);
  const sig = checkGameServerSignature(secret, req.headers.get(HEADERS.GAME_SERVER_TS), req.headers.get(HEADERS.GAME_SERVER_SIG), text, now);
  if (sig !== "ok") return json({ error: sig }, 401);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return json({ error: "bad_json" }, 400);
  }
  const parsed = replayChunkUploadSchema.safeParse(raw);
  if (!parsed.success) return json({ error: "bad_body", details: parsed.error.flatten() }, 400);
  const checked = checkReplayData(parsed.data);
  if (typeof checked === "string") return json({ error: "bad_data", reason: checked }, 400);
  const r = await storeReplayChunk(db, parsed.data, checked.data);
  return json(r, r.status === "conflict" ? 409 : 200);
}
