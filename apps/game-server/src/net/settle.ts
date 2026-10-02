import { setTimeout as delay } from "node:timers/promises";
import { createHmac } from "node:crypto";
import { HEADERS, type MatchSettlementPayload } from "@extract/shared";
import { getWebApiBaseUrl } from "./web-api-base.js";

const SETTLE_ATTEMPTS = 5;
const SETTLE_BACKOFF_MS = 400;
const REQUEST_TIMEOUT_MS = 10_000;

export type SettleResult = "ok" | "skipped" | "failed";

/**
 * Posts the match result to the web API, signed with HMAC over `${ts}.${body}`. Retries with
 * exponential backoff because the item ledger must land; never throws — a missing config or a
 * dead API must not keep the match from finishing for the players.
 */
export async function postSettlement(payload: MatchSettlementPayload): Promise<SettleResult> {
  const base = getWebApiBaseUrl();
  const secret = process.env.GAME_SERVER_HMAC_SECRET;
  if (!base || !secret) {
    console.warn(
      `[settle] skipped for match ${payload.matchId}: ${!base ? "WEB_API_BASE_URL" : "GAME_SERVER_HMAC_SECRET"} is not set`,
    );
    return "skipped";
  }
  const url = `${base}/api/matches/settle`;
  const body = JSON.stringify(payload);

  let lastErr = "";
  for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
    if (attempt > 0) await delay(SETTLE_BACKOFF_MS * 2 ** (attempt - 1));
    // Fresh timestamp per attempt: the API rejects stale signatures.
    const ts = Date.now().toString();
    const sig = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [HEADERS.GAME_SERVER_TS]: ts,
          [HEADERS.GAME_SERVER_SIG]: sig,
        },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.ok) return "ok";
      lastErr = `status=${res.status} body=${(await res.text()).slice(0, 500)}`;
      // 4xx other than 408/429 will not get better on retry.
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) break;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  console.error(`[settle] match ${payload.matchId} failed (target ${url}): ${lastErr}`);
  return "failed";
}
