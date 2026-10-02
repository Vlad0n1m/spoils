import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { HEADERS, type RaidStartRequest } from "@extract/shared";
import { SERVER_INSTANCE, announceBoot, onExitSettled, parseExitSettled, postSigned, reportEnd, reportExit, startRaid } from "./web-api.js";
import { planLaunch } from "../rooms/matchmaking-room.js";

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

test("announceBoot posts this process' identity to void-orphans, retries, returns the voided ids", async () => {
  assert.equal(SERVER_INSTANCE.serverId, process.env.GAME_SERVER_ID?.trim() || "default");
  assert.match(SERVER_INSTANCE.instanceId, /^[0-9a-f-]{36}$/);
  const srv = await serve((n) => (n === 1 ? 503 : 200), JSON.stringify({ ok: true, status: "applied", voided: ["m-old"] }));
  const prevLog = console.log;
  console.log = () => {};
  try {
    await withEnv({ WEB_API_BASE_URL: `http://127.0.0.1:${srv.port}`, GAME_SERVER_HMAC_SECRET: "s" }, async () => {
      assert.deepEqual(await announceBoot(SERVER_INSTANCE, { backoffMs: 5 }), ["m-old"]);
    });
  } finally {
    console.log = prevLog;
    srv.close();
  }
  assert.equal(srv.seen.length, 2);
  assert.equal(srv.seen[1]!.path, "/api/raids/void-orphans");
  assert.deepEqual(JSON.parse(srv.seen[1]!.body), { ...SERVER_INSTANCE });
  await withEnv({ WEB_API_BASE_URL: undefined, GAME_SERVER_HMAC_SECRET: "s" }, async () => {
    assert.deepEqual(await announceBoot(), [], "not configured: skipped");
  });
});

test("raids/start carries this process' instance id (void-orphans can tell its raids apart)", async () => {
  let seen: RaidStartRequest | null = null;
  await planLaunch([{ userId: "u1", nickname: "U", isBot: false, loadoutId: "" }], {
    mode: "live",
    matchSeed: 7,
    startRaid: async (req) => {
      seen = req;
      return { accepted: [], rejected: [], containerLoot: {}, autosellMult: 1 };
    },
  });
  assert.equal(seen!.instanceId, SERVER_INSTANCE.instanceId);
  assert.equal(seen!.serverId, SERVER_INSTANCE.serverId);
});

const exitReport = (matchId: string) =>
  ({ ...payload, matchId, atMs: 1, kills: 0, level: 1, lost: [], destroyed: [], stats: { shotsFired: 0, dmgDealt: 0, containersSearched: 0, corpsesSearched: 0, bossKills: 0 } }) as never;

test("reportExit outlasts a brief outage (slow re-posts) and the end report still follows it", async () => {
  // Every exit attempt of the first fast round fails (deploy / cold start); the web is back after.
  let exitHits = 0;
  const order: string[] = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const path = req.url ?? "";
      if (path.endsWith("/exit")) exitHits++;
      const down = path.endsWith("/exit") && exitHits <= 3;
      order.push(`${path}${down ? ":500" : ""}`);
      res.statusCode = down ? 500 : 200;
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const prevErr = console.error;
  console.error = () => {};
  try {
    await withEnv({ WEB_API_BASE_URL: `http://127.0.0.1:${port}`, GAME_SERVER_HMAC_SECRET: "s" }, async () => {
      const exit = reportExit(exitReport("m-out"), { attempts: 2, backoffMs: 1, slowBackoffMs: 20, retryWindowMs: 5_000 });
      const end = reportEnd({ matchId: "m-out" } as never, { backoffMs: 1 });
      const [x, e] = await Promise.all([exit, end]);
      assert.equal(x.status, "ok", "the exit got through after the outage");
      assert.equal(e.status, "ok");
    });
  } finally {
    console.error = prevErr;
    server.close();
  }
  assert.deepEqual(order, ["/api/raids/exit:500", "/api/raids/exit:500", "/api/raids/exit:500", "/api/raids/exit", "/api/raids/end"]);
});

test("reportEnd is withheld when an exit never got through (its sweep would pool the extracted loot)", async () => {
  const srv = await serve((n) => (n <= 100 ? 500 : 200));
  const prevErr = console.error;
  console.error = () => {};
  try {
    await withEnv({ WEB_API_BASE_URL: `http://127.0.0.1:${srv.port}`, GAME_SERVER_HMAC_SECRET: "s" }, async () => {
      const exit = reportExit(exitReport("m-down"), { attempts: 2, backoffMs: 1, slowBackoffMs: 10, retryWindowMs: 50 });
      const end = reportEnd({ matchId: "m-down" } as never, { backoffMs: 1 });
      const [x, e] = await Promise.all([exit, end]);
      assert.equal(x.status, "failed");
      assert.deepEqual(e, { status: "failed", error: "exit_unsettled" });
    });
  } finally {
    console.error = prevErr;
    srv.close();
  }
  assert.ok(srv.seen.length >= 4, "fast retries plus slow rounds");
  assert.ok(srv.seen.every((s) => s.path === "/api/raids/exit"), "no /api/raids/end was posted");
});
