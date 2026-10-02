import { setTimeout as delay } from "node:timers/promises";
import { createHmac } from "node:crypto";
import { HEADERS, type MatchExtractInstantPayload } from "@extract/shared";
import { getWebApiBaseUrl } from "./web-api-base.js";

const ATTEMPTS = 5;
const BACKOFF_MS = 400;

/** Credits balance the moment a player successfully extracts. Same HMAC as /api/matches/settle. */
export async function postExtractCredit(
  payload: MatchExtractInstantPayload,
): Promise<void> {
  const url = `${getWebApiBaseUrl()}/api/matches/extract-instant`;
  const secret = process.env.GAME_SERVER_HMAC_SECRET;
  if (!secret) throw new Error("GAME_SERVER_HMAC_SECRET unset");

  let lastErr: Error | undefined;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await delay(BACKOFF_MS * 2 ** (attempt - 1));
    }
    const body = JSON.stringify(payload);
    const ts = Date.now().toString();
    const sig = createHmac("sha256", secret)
      .update(`${ts}.${body}`)
      .digest("hex");
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [HEADERS.GAME_SERVER_TS]: ts,
          [HEADERS.GAME_SERVER_SIG]: sig,
        },
        body,
        signal: AbortSignal.timeout(12_000),
      });
      if (res.ok) return;
      const errText = await res.text();
      lastErr = new Error(
        `extract-instant status=${res.status} body=${errText.slice(0, 500)}`,
      );
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
    }
  }
  const hint = ` (target ${getWebApiBaseUrl()} — set WEB_API_BASE_URL to your Next origin, same port as pnpm --filter web dev)`;
  throw lastErr
    ? new Error(lastErr.message + hint, { cause: lastErr })
    : new Error("postExtractCredit failed" + hint);
}
