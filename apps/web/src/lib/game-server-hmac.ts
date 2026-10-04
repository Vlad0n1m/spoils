import { createHmac, timingSafeEqual } from "node:crypto";
import { HEADERS } from "@extract/shared";
import { coreEnv } from "./env";

/** Signatures older/newer than this are refused (replay window; server clocks are NTP-synced). */
export const MAX_TIMESTAMP_SKEW_MS = 60_000;

export type SignatureCheck = "ok" | "missing_signature" | "stale_timestamp" | "bad_signature";

/** Hex HMAC-SHA256 over `${ts}.${body}` — the game server's net/web-api signs the same string. */
export function signGameServerBody(secret: string, ts: string, body: string): string {
  return createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
}

/** Pure check (testable without a request or env). Constant-time compare. */
export function checkGameServerSignature(
  secret: string,
  ts: string | null,
  sig: string | null,
  body: string,
  now = Date.now(),
): SignatureCheck {
  if (!ts || !sig) return "missing_signature";
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(now - tsNum) > MAX_TIMESTAMP_SKEW_MS) return "stale_timestamp";
  const a = Buffer.from(sig);
  const b = Buffer.from(signGameServerBody(secret, ts, body));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return "bad_signature";
  return "ok";
}

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

/**
 * Most a signed game-server body may hold (security audit: the body was read whole before the
 * signature check). The largest legit one is raids/end of a full shard (entries, participants,
 * expired items, NPC leftovers): far below this; the game server posts to web:3000 directly, so
 * nginx's client_max_body_size is not in that path.
 */
export const SIGNED_BODY_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Reads and verifies a game-server → web request (raids/open|enter|exit|end, world/event). Returns the parsed JSON,
 * or a ready 413/401/400 Response the route returns as is.
 */
export async function readSignedJson(req: Request): Promise<{ ok: true; json: unknown } | { ok: false; res: Response }> {
  const text = await readCappedText(req, SIGNED_BODY_MAX_BYTES);
  if (text === null) return { ok: false, res: Response.json({ error: "body_too_large" }, { status: 413 }) };
  const check = checkGameServerSignature(
    coreEnv().GAME_SERVER_HMAC_SECRET,
    req.headers.get(HEADERS.GAME_SERVER_TS),
    req.headers.get(HEADERS.GAME_SERVER_SIG),
    text,
  );
  if (check !== "ok") return { ok: false, res: Response.json({ error: check }, { status: 401 }) };
  try {
    return { ok: true, json: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, res: Response.json({ error: "bad_json" }, { status: 400 }) };
  }
}
