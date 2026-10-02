import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { HEADERS, type MatchSettlementPayload } from "@extract/shared";
import { postSettlement } from "./settle.js";

const payload: MatchSettlementPayload = {
  matchId: "m-1",
  mapSeed: 7,
  startedAt: 1,
  endedAt: 2,
  participants: [
    {
      userId: "u1", nickname: "Neo", isBot: false, exitType: "extract", kills: 2,
      extracted: [{ uid: "w-1", kind: "weapon", type: "rifle", rarity: 1 }],
      lost: [{ uid: "a-1", kind: "armor", type: "armor", rarity: 1, level: 2, dur: 0 }],
    },
  ],
  leftOnMap: [{ uid: "a-2", kind: "armor", type: "armor", rarity: 0, level: 1, dur: 42.5 }],
};

function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

test("settlement is skipped (not thrown) when the web API is not configured", async () => {
  await withEnv({ WEB_API_BASE_URL: undefined, GAME_SERVER_HMAC_SECRET: "s" }, async () => {
    assert.equal(await postSettlement(payload), "skipped");
  });
  await withEnv({ WEB_API_BASE_URL: "http://127.0.0.1:1", GAME_SERVER_HMAC_SECRET: undefined }, async () => {
    assert.equal(await postSettlement(payload), "skipped");
  });
});

test("settlement is HMAC-signed over `${ts}.${body}` and retried after a server error", async () => {
  const secret = "settle-secret";
  const seen: Array<{ ts: string; sig: string; body: string; path: string }> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({
        ts: String(req.headers[HEADERS.GAME_SERVER_TS]),
        sig: String(req.headers[HEADERS.GAME_SERVER_SIG]),
        body,
        path: req.url ?? "",
      });
      res.statusCode = seen.length === 1 ? 503 : 200;
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await withEnv({ WEB_API_BASE_URL: `http://localhost:${port}/`, GAME_SERVER_HMAC_SECRET: secret }, async () => {
      assert.equal(await postSettlement(payload), "ok");
    });
  } finally {
    server.close();
  }
  assert.equal(seen.length, 2);
  for (const s of seen) {
    assert.equal(s.path, "/api/matches/settle");
    assert.deepEqual(JSON.parse(s.body), payload);
    assert.equal(s.sig, createHmac("sha256", secret).update(`${s.ts}.${s.body}`).digest("hex"));
  }
});
