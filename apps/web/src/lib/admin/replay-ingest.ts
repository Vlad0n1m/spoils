import { HEADERS, REPLAY } from "@extract/shared";
import { checkGameServerSignature } from "../game-server-hmac";
import type { Db } from "../inventory/db";
import { checkReplayData, replayChunkUploadSchema, storeReplayChunk } from "./replay";

/**
 * POST /api/admin/replays/ingest: game server → web, HMAC-signed like every raids/* call (not an
 * admin session: the route sits under /api/admin only because replays are an admin feature; it is
 * the one handler there that admin.test.ts lets skip adminRoute, and only with this signature
 * check). Order: body size (413, before and while reading) → signature (401) → JSON (400 bad_json)
 * → strict schema (400 bad_body) → compressed data (400 bad_data) → store (200 stored / exists,
 * 409 conflict). Idempotent by (matchId, seq): the game server may retry any chunk.
 * Kept free of next/* and the app pool so tests call it with the test DB and a test secret.
 */

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

/** The body as text, or null once it grows past `max` bytes (the rest is not read). */
export async function readCappedText(req: Request, max: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString("utf8");
}

export async function handleReplayIngest(req: Request, db: Db, secret: string, now: number = Date.now()): Promise<Response> {
  const text = await readCappedText(req, REPLAY.MAX_BODY_BYTES);
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
  try {
    const r = await storeReplayChunk(db, parsed.data, checked.data);
    return json(r, r.status === "conflict" ? 409 : 200);
  } catch (e) {
    console.error("[replays/ingest] failed", e);
    return json({ error: "internal" }, 500);
  }
}
