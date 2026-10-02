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

/**
 * Reads and verifies a game-server → web request (raids/start|exit|end). Returns the parsed JSON,
 * or a ready 401/400 Response the route returns as is.
 */
export async function readSignedJson(req: Request): Promise<{ ok: true; json: unknown } | { ok: false; res: Response }> {
  const text = await req.text();
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
