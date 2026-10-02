import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { HEADERS, type RaidStartRequest } from "@extract/shared";
import { onExitSettled, parseExitSettled, postSigned, reportEnd, reportExit, startRaid } from "./web-api.js";

const payload = { matchId: "m-1", userId: "u1", exit: "extract", extracted: [{ uid: "w-1", def: "rifle", qty: 1, rarity: 1, dur: 100 }] };

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

async function serve(status: (n: number) => number, reply = "{}") {
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
      res.statusCode = status(seen.length);
      res.end(reply);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { seen, port: (server.address() as AddressInfo).port, close: () => server.close() };
}

test("postSigned is skipped (not thrown) when the web API is not configured", async () => {
  await withEnv({ WEB_API_BASE_URL: undefined, GAME_SERVER_HMAC_SECRET: "s" }, async () => {
    assert.deepEqual(await postSigned("/api/raids/exit", payload), { status: "skipped" });
  });
  await withEnv({ WEB_API_BASE_URL: "http://127.0.0.1:1", GAME_SERVER_HMAC_SECRET: undefined }, async () => {
    assert.deepEqual(await postSigned("/api/raids/exit", payload), { status: "skipped" });
  });
});

test("postSigned signs `${ts}.${body}`, retries a server error and returns the parsed reply", async () => {
  const secret = "web-api-secret";
  const srv = await serve((n) => (n === 1 ? 503 : 200), '{"ok":true}');
  try {
    await withEnv({ WEB_API_BASE_URL: `http://localhost:${srv.port}/`, GAME_SERVER_HMAC_SECRET: secret }, async () => {
      const r = await postSigned("/api/raids/exit", payload, { backoffMs: 5 });
      assert.deepEqual(r, { status: "ok", body: { ok: true } });
    });
  } finally {
    srv.close();
  }
  assert.equal(srv.seen.length, 2);
  for (const s of srv.seen) {
    assert.equal(s.path, "/api/raids/exit");
    assert.deepEqual(JSON.parse(s.body), payload);
    assert.equal(s.sig, createHmac("sha256", secret).update(`${s.ts}.${s.body}`).digest("hex"));
  }
});

test("postSigned stops on a 4xx (409 = voided raid) and gives up after the attempts", async () => {
  const srv = await serve(() => 409, "voided");
  try {
    await withEnv({ WEB_API_BASE_URL: `http://127.0.0.1:${srv.port}`, GAME_SERVER_HMAC_SECRET: "s" }, async () => {
      assert.deepEqual(await postSigned("/api/raids/end", payload, { backoffMs: 5 }), { status: "rejected", code: 409, body: "voided" });
    });
  } finally {
    srv.close();
  }
  assert.equal(srv.seen.length, 1);

  const down = await serve(() => 500);
  try {
    await withEnv({ WEB_API_BASE_URL: `http://127.0.0.1:${down.port}`, GAME_SERVER_HMAC_SECRET: "s" }, async () => {
      const prevErr = console.error;
      console.error = () => {};
      try {
        const r = await postSigned("/api/raids/end", payload, { attempts: 3, backoffMs: 5 });
        assert.equal(r.status, "failed");
      } finally {
        console.error = prevErr;
      }
    });
  } finally {
    down.close();
  }
  assert.equal(down.seen.length, 3);
});

test("startRaid: retries a 5xx, returns the response; unreachable / refused → null (demo fallback)", async () => {
  const reply = { accepted: [], rejected: [{ userId: "u", reason: "expired" }], containerLoot: { "3": [] }, autosellMult: 0.9 };
  const srv = await serve((n) => (n === 1 ? 502 : 200), JSON.stringify(reply));
  const req: RaidStartRequest = { matchId: "m", mode: "live", mapId: "steppe", matchSeed: 1, players: [], containers: [], bossSlots: 0 };
  try {
    await withEnv({ WEB_API_BASE_URL: `http://127.0.0.1:${srv.port}`, GAME_SERVER_HMAC_SECRET: "s" }, async () => {
      assert.deepEqual(await startRaid(req, { backoffMs: 5 }), reply);
    });
  } finally {
    srv.close();
  }
  assert.equal(srv.seen.length, 2);
  assert.equal(srv.seen[0]!.path, "/api/raids/start");

  const refused = await serve(() => 400, "bad_body");
  const prevErr = console.error;
  console.error = () => {};
  try {
    await withEnv({ WEB_API_BASE_URL: `http://127.0.0.1:${refused.port}`, GAME_SERVER_HMAC_SECRET: "s" }, async () => {
      assert.equal(await startRaid(req, { backoffMs: 5 }), null);
    });
    await withEnv({ WEB_API_BASE_URL: undefined, GAME_SERVER_HMAC_SECRET: "s" }, async () => {
      assert.equal(await startRaid(req), null, "not configured");
    });
    const down = await serve(() => 503);
    await withEnv({ WEB_API_BASE_URL: `http://127.0.0.1:${down.port}`, GAME_SERVER_HMAC_SECRET: "s" }, async () => {
      assert.equal(await startRaid(req, { backoffMs: 1 }), null);
    });
    down.close();
    assert.equal(down.seen.length, 4, "1 attempt + 3 retries");
  } finally {
    console.error = prevErr;
    refused.close();
  }
});

test("reportExit hands the web's receipt to the room listener; reportEnd waits for exits in flight", async () => {
  const order: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const path = req.url ?? "";
      // The exit answers slowly: the end report must still arrive after it.
      const delayMs = path.endsWith("/exit") ? 80 : 0;
      setTimeout(() => {
        order.push(path);
        res.statusCode = 200;
        res.end(path.endsWith("/exit") ? JSON.stringify({ ok: true, status: "applied", credits: 42, sold: [{ def: "junk_gpu", qty: 1, cr: 42 }], guest: false }) : "{}");
      }, delayMs);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const got: Array<[string, unknown]> = [];
  try {
    await withEnv({ WEB_API_BASE_URL: `http://127.0.0.1:${port}`, GAME_SERVER_HMAC_SECRET: "s" }, async () => {
      onExitSettled("m-2", (userId, r) => got.push([userId, r]));
      const exit = reportExit({ ...payload, matchId: "m-2", atMs: 1, kills: 0, level: 1, lost: [], destroyed: [], stats: { shotsFired: 0, dmgDealt: 0, containersSearched: 0, corpsesSearched: 0, bossKills: 0 } } as never);
      const end = reportEnd({ matchId: "m-2" } as never);
      await Promise.all([exit, end]);
    });
  } finally {
    server.close();
  }
  assert.deepEqual(order, ["/api/raids/exit", "/api/raids/end"]);
  assert.deepEqual(got, [["u1", { credits: 42, sold: [{ def: "junk_gpu", qty: 1, cr: 42 }], guest: false }]]);
  assert.equal(parseExitSettled({ credits: "x", sold: [] }), null);
});
