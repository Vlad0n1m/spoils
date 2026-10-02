import { setTimeout as delay } from "node:timers/promises";
import { createHmac } from "node:crypto";
import { HEADERS, type MatchSettlementPayload } from "@extract/shared";
import { getWebApiBaseUrl } from "./web-api-base.js";

const SETTLE_ATTEMPTS = 5;
const SETTLE_BACKOFF_MS = 400;

/** Persists match payouts to the web API (HMAC). Retries: settlement must land or balances stay wrong while clients still get Colyseus `settled`. */
export async function postSettlement(payload: MatchSettlementPayload) {
  const url = `${getWebApiBaseUrl()}/api/matches/settle`;
  const secret = process.env.GAME_SERVER_HMAC_SECRET;
  if (!secret) throw new Error("GAME_SERVER_HMAC_SECRET unset");

  let lastErr: Error | undefined;
  for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await delay(SETTLE_BACKOFF_MS * 2 ** (attempt - 1));
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
      lastErr = new Error(`settle status=${res.status} body=${errText.slice(0, 500)}`);
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
    }
  }
  const hint = ` (target ${getWebApiBaseUrl()})`;
  throw lastErr
    ? new Error(lastErr.message + hint, { cause: lastErr })
    : new Error("postSettlement failed" + hint);
}
