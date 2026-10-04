import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { HEADERS, type EntryRequest, type ShardOpenRequest, type WorldEventReport } from "@extract/shared";
import {
  SERVER_INSTANCE,
  announceBoot,
  enterRaid,
  offExitSettled,
  onExitSettled,
  openShard,
  parseEntryResponse,
  parseExitSettled,
  postSigned,
  reportEnd,
  reportExit,
  reportWorldEvent,
  webApiConfigured,
} from "./web-api.js";

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

test("announceBoot with retryEveryMs keeps announcing in the background until the web takes it, then stops", async () => {
  // The first three rounds fail (web down); the fourth lands. Nothing is posted after that.
  const srv = await serve((n) => (n <= 3 ? 503 : 200), JSON.stringify({ ok: true, status: "applied", voided: ["m-old"] }));
  const prev = { log: console.log, error: console.error };
  console.log = () => {};
  console.error = () => {};
  try {
    await withEnv({ WEB_API_BASE_URL: `http://127.0.0.1:${srv.port}`, GAME_SERVER_HMAC_SECRET: "s" }, async () => {
      assert.deepEqual(await announceBoot(SERVER_INSTANCE, { attempts: 1, backoffMs: 1, retryEveryMs: 15 }), [], "the first round failed: handed to the background");
      for (let i = 0; i < 200 && srv.seen.length < 4; i++) await new Promise((r) => setTimeout(r, 10));
      assert.equal(srv.seen.length, 4, "retried until it landed");
      await new Promise((r) => setTimeout(r, 80));
    });
    assert.equal(srv.seen.length, 4, "no announce after it landed");
    assert.ok(srv.seen.every((s) => s.path === "/api/raids/void-orphans"));
    assert.deepEqual(JSON.parse(srv.seen[3]!.body), { ...SERVER_INSTANCE });
  } finally {
    console.log = prev.log;
    console.error = prev.error;
    srv.close();
  }
  // A refusal (4xx) is final: no background retry.
  const bad = await serve(() => 400, JSON.stringify({ error: "bad_body" }));
  console.error = () => {};
  try {
    await withEnv({ WEB_API_BASE_URL: `http://127.0.0.1:${bad.port}`, GAME_SERVER_HMAC_SECRET: "s" }, async () => {
      assert.deepEqual(await announceBoot(SERVER_INSTANCE, { attempts: 1, backoffMs: 1, retryEveryMs: 15 }), []);
      await new Promise((r) => setTimeout(r, 80));
    });
    assert.equal(bad.seen.length, 1);
  } finally {
    console.error = prev.error;
    bad.close();
  }
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

// ---------------------------------------------------------------- T18: WORLD v6 calls

const sig = (secret: string, ts: string, body: string) => createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");

test("openShard posts a signed ShardOpenRequest to raids/open; 4xx → rejected, 5xx → null after the attempts", async () => {
  const req: ShardOpenRequest = {
    matchId: randomUUID(), cycleId: 663_000, shard: 0, roomId: "abc", mode: "live", mapId: "steppe", matchSeed: 9,
    startsAt: 1, entryClosesAt: 2, endsAt: 3, boss: { kind: "warden", zone: "z1" }, nextBoss: null,
    serverId: SERVER_INSTANCE.serverId, instanceId: SERVER_INSTANCE.instanceId,
  };
  const srv = await serve((n) => (n === 1 ? 503 : 200), JSON.stringify({ status: "exists", autosellMult: 0.9 }));
  try {
    await withEnv({ WEB_API_BASE_URL: `http://127.0.0.1:${srv.port}`, GAME_SERVER_HMAC_SECRET: "s" }, async () => {
      assert.equal(webApiConfigured(), true);
      assert.deepEqual(await openShard(req, { backoffMs: 1 }), { status: "exists", autosellMult: 0.9 });
    });
  } finally {
    srv.close();
  }
  assert.equal(srv.seen.length, 2);
  assert.equal(srv.seen[1]!.path, "/api/raids/open");
  assert.deepEqual(JSON.parse(srv.seen[1]!.body), req);
  assert.equal(srv.seen[1]!.sig, sig("s", srv.seen[1]!.ts, srv.seen[1]!.body));

  const prevErr = console.error;
  console.error = () => {};
  try {
    const bad = await serve(() => 400, '{"error":"bad_body"}');
    await withEnv({ WEB_API_BASE_URL: `http://127.0.0.1:${bad.port}`, GAME_SERVER_HMAC_SECRET: "s" }, async () => {
      assert.equal(await openShard(req, { backoffMs: 1 }), "rejected");
    });
    bad.close();
    const down = await serve(() => 500);
    await withEnv({ WEB_API_BASE_URL: `http://127.0.0.1:${down.port}`, GAME_SERVER_HMAC_SECRET: "s" }, async () => {
      assert.equal(await openShard(req, { attempts: 2, backoffMs: 1 }), null);
    });
    down.close();
    await withEnv({ WEB_API_BASE_URL: undefined, GAME_SERVER_HMAC_SECRET: "s" }, async () => {
      assert.equal(webApiConfigured(), false);
      assert.equal(await openShard(req), null, "not configured");
    });
  } finally {
    console.error = prevErr;
  }
});

test("enterRaid: a busy web (503) is retried with the same entryId; the reply is sanitized against the request", async () => {
  const userId = randomUUID();
  const loadoutId = randomUUID();
  const req: EntryRequest = { matchId: randomUUID(), entryId: randomUUID(), userId, loadoutId, atMs: 61_000, targets: 12, bossAlive: true };
  const pool = [
    { uid: "p-1", def: "rifle", qty: 1, rarity: 2, dur: 90 },
    { uid: "p-1", def: "rifle", qty: 1, rarity: 2, dur: 90 },
    { uid: "", def: "ammo_light", qty: 30, rarity: 0, dur: 0 },
  ];
  const reply = {
    status: "accepted",
    snapshot: { loadoutId, userId, level: 4, entries: [{ key: "w1", uid: "g-1", def: "rifle", qty: 1, rarity: 1, dur: 100 }, { key: "w1", uid: "g-2", def: "rifle", qty: 1, rarity: 1, dur: 100 }] },
    level: 4, guest: false, pool, bossFill: [{ uid: "g-1", def: "rifle", qty: 1, rarity: 1, dur: 1 }, { uid: "b-1", def: "rifle", qty: 1, rarity: 3, dur: 100 }], autosellMult: 1,
  };
  const srv = await serve((n) => (n === 1 ? 503 : 200), JSON.stringify(reply));
  let res;
  try {
    await withEnv({ WEB_API_BASE_URL: `http://127.0.0.1:${srv.port}`, GAME_SERVER_HMAC_SECRET: "s" }, async () => {
      res = await enterRaid(req, { backoffMs: 1 });
    });
  } finally {
    srv.close();
  }
  assert.equal(srv.seen.length, 2, "1 attempt + 1 retry");
  for (const s of srv.seen) {
    assert.equal(s.path, "/api/raids/enter");
    assert.deepEqual(JSON.parse(s.body), req, "the retry carries the same entryId");
    assert.equal(s.sig, sig("s", s.ts, s.body));
  }
  assert.deepEqual(res, {
    status: "accepted",
    snapshot: { loadoutId, userId, level: 4, entries: [{ key: "w1", uid: "g-1", def: "rifle", qty: 1, rarity: 1, dur: 100 }] },
    level: 4,
    guest: false,
    pool: [{ uid: "p-1", def: "rifle", qty: 1, rarity: 2, dur: 90 }],
    bossFill: [{ uid: "b-1", def: "rifle", qty: 1, rarity: 3, dur: 100 }],
    autosellMult: 1,
  }, "duplicate slot keys and uids, fungible pool items and uids already in the snapshot are dropped");

  // A snapshot for another loadout or user is malformed (null → web_unavailable); null snapshot = free kit.
  assert.equal(parseEntryResponse({ ...reply, snapshot: { ...reply.snapshot, loadoutId: randomUUID() } }, req), null);
  assert.equal(parseEntryResponse({ ...reply, snapshot: { ...reply.snapshot, userId: randomUUID() } }, req), null);
  assert.equal(parseEntryResponse({ ...reply, snapshot: null }, req)?.snapshot, null);
  assert.equal(parseEntryResponse({ status: "maybe" }, req), null);
  assert.deepEqual(parseEntryResponse({ status: "rejected", reason: "entry_limit", level: 2 }, req), {
    status: "rejected", reason: "entry_limit", snapshot: null, level: 2, guest: false, pool: [], bossFill: [], autosellMult: 1,
  });
  const many = Array.from({ length: 40 }, (_, i) => ({ uid: `q-${i}`, def: "rifle", qty: 1, rarity: 1, dur: 50 }));
  const capped = parseEntryResponse({ ...reply, snapshot: null, pool: many, bossFill: many.map((x) => ({ ...x, uid: `b${x.uid}` })) }, { userId, loadoutId: "" })!;
  assert.equal(capped.pool.length, 32);
  assert.equal(capped.bossFill.length, 4);

  const prevErr = console.error;
  console.error = () => {};
  try {
    const down = await serve(() => 503, '{"error":"busy"}');
    await withEnv({ WEB_API_BASE_URL: `http://127.0.0.1:${down.port}`, GAME_SERVER_HMAC_SECRET: "s" }, async () => {
      assert.equal(await enterRaid(req, { backoffMs: 1 }), null);
    });
    down.close();
    assert.equal(down.seen.length, 2);
  } finally {
    console.error = prevErr;
  }
});

test("reportWorldEvent: signed post to world/event, 3 attempts, a 404 (unknown match) is dropped", async () => {
  const ev: WorldEventReport = { matchId: randomUUID(), cycleId: 663_000, kind: "boss_killed", boss: "warden", by: "Neo", atMs: 600_000 };
  const srv = await serve((n) => (n < 3 ? 502 : 200), '{"ok":true}');
  try {
    await withEnv({ WEB_API_BASE_URL: `http://127.0.0.1:${srv.port}`, GAME_SERVER_HMAC_SECRET: "s" }, async () => {
      assert.equal(await reportWorldEvent(ev, { backoffMs: 1 }), true);
    });
  } finally {
    srv.close();
  }
  assert.equal(srv.seen.length, 3);
  assert.equal(srv.seen[2]!.path, "/api/world/event");
  assert.deepEqual(JSON.parse(srv.seen[2]!.body), ev);
  assert.equal(srv.seen[2]!.sig, sig("s", srv.seen[2]!.ts, srv.seen[2]!.body));

  const gone = await serve(() => 404, '{"error":"unknown_match"}');
  const prevErr = console.error;
  console.error = () => {};
  try {
    await withEnv({ WEB_API_BASE_URL: `http://127.0.0.1:${gone.port}`, GAME_SERVER_HMAC_SECRET: "s" }, async () => {
      assert.equal(await reportWorldEvent(ev, { backoffMs: 1 }), false);
    });
  } finally {
    console.error = prevErr;
    gone.close();
  }
  assert.equal(gone.seen.length, 1);
});

test("exit receipts are routed by entryId: two entries of one user in one match each get their own XP", async () => {
  const matchId = randomUUID();
  const userId = randomUUID();
  const [e1, e2] = [randomUUID(), randomUUID()];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const r = JSON.parse(body) as { entryId: string };
      res.statusCode = 200;
      res.end(JSON.stringify(r.entryId === e1
        ? { credits: 10, sold: [], guest: false, xp: 40, xpLines: [{ key: "guard", qty: 1, xp: 40 }], level: 3, levelUp: false }
        : { credits: 250, sold: [{ def: "junk_gpu", qty: 1, cr: 250 }], guest: false, xp: 380, xpLines: [{ key: "extract", qty: 18, xp: 280 }, { key: "pvp", qty: 1, xp: 80 }, { key: "nope", qty: 1, xp: 1 }], level: 4, levelUp: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const got = new Map<string, unknown>();
  try {
    await withEnv({ WEB_API_BASE_URL: `http://127.0.0.1:${port}`, GAME_SERVER_HMAC_SECRET: "s" }, async () => {
      onExitSettled(matchId, (key, r) => got.set(key, r));
      const base = { ...(exitReport(matchId) as object), userId };
      await Promise.all([
        reportExit({ ...base, entryId: e1, exit: "dead" } as never),
        reportExit({ ...base, entryId: e2 } as never),
      ]);
      offExitSettled(matchId);
    });
  } finally {
    server.close();
  }
  assert.deepEqual(got.get(e1), { credits: 10, sold: [], guest: false, xp: 40, xpLines: [{ key: "guard", qty: 1, xp: 40 }], level: 3, levelUp: false });
  assert.deepEqual(got.get(e2), {
    credits: 250, sold: [{ def: "junk_gpu", qty: 1, cr: 250 }], guest: false, xp: 380,
    xpLines: [{ key: "extract", qty: 18, xp: 280 }, { key: "pvp", qty: 1, xp: 80 }], level: 4, levelUp: true,
  });
  assert.equal(got.has(userId), false, "never keyed by userId when the report has an entryId");
  // Legacy receipts (no XP fields) still parse.
  assert.deepEqual(parseExitSettled({ credits: 1, sold: [], guest: true }), { credits: 1, sold: [], guest: true });
  // The daily task line (C14b) is kept, so the outcome's lines add up to its xp total.
  const quest = parseExitSettled({ credits: 0, sold: [], guest: false, xp: 160, xpLines: [{ key: "extract", qty: 9, xp: 60 }, { key: "quest", qty: 1, xp: 100 }], level: 2, levelUp: false });
  assert.deepEqual(quest?.xpLines?.map((l) => l.key), ["extract", "quest"]);
});
