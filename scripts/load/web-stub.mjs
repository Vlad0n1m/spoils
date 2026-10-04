#!/usr/bin/env node
/**
 * Web API stub for load tests of the game server alone (no Next.js, no Postgres). It answers the
 * game server's HMAC-signed calls (net/web-api.ts, world/replay-upload.ts) the way the real web
 * does for free-kit entries, so the server runs its normal "web configured" path: raids/open,
 * raids/enter (accepted, snapshot null = free kit), raids/exit, world/event, raids/end and the
 * admin replay ingest (so the replay recorder is ON, as in production). Every request is checked
 * against the HMAC secret and counted per path (bytes in, latency), so a run also shows how much
 * the server would post to the web (replay chunks per minute, exits per death).
 *
 * Used by run.mjs; standalone (e.g. next to a game server on a VPS):
 *   LOAD_HMAC_SECRET=<the server's GAME_SERVER_HMAC_SECRET for that run> node scripts/load/web-stub.mjs --port 3999
 * The secret is read from the environment only and never printed.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { parseArgs } from "./lib.mjs";

const SIG = "x-game-server-signature";
const TS = "x-game-server-timestamp";
const MAX_SKEW_MS = 5 * 60_000;

/** The reply the real web gives (shapes from packages/shared types.ts); null = 404. */
function reply(path, body) {
  switch (path) {
    case "/api/raids/void-orphans":
      return { voided: [] };
    case "/api/raids/open":
      return { status: "opened", autosellMult: 1 };
    case "/api/raids/enter":
      return { status: "accepted", snapshot: null, level: 1, guest: true, pool: [], bossFill: [], autosellMult: 1 };
    case "/api/raids/exit":
      return { credits: 0, sold: [], guest: true };
    case "/api/world/event":
    case "/api/raids/end":
    case "/api/admin/replays/ingest":
      return { ok: true, matchId: typeof body?.matchId === "string" ? body.matchId : "" };
    default:
      return null;
  }
}

/**
 * Start the stub. `secret` must equal the game server's GAME_SERVER_HMAC_SECRET. `delayMs` adds an
 * artificial answer delay (to see how a slow web behaves).
 */
export function startWebStub({ secret, port = 0, host = "127.0.0.1", delayMs = 0 }) {
  if (!secret || secret.length < 16) throw new Error("web stub: a 16+ character secret is required");
  const key = Buffer.from(secret, "utf8");
  /** path → { n, bytes, badSig, ms[] } */
  const stats = new Map();
  const stat = (p) => {
    let s = stats.get(p);
    if (!s) stats.set(p, (s = { n: 0, bytes: 0, badSig: 0, maxBytes: 0, ms: [] }));
    return s;
  };

  const server = createServer((req, res) => {
    const t0 = performance.now();
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const path = (req.url ?? "").split("?")[0];
      const s = stat(path);
      s.n++;
      s.bytes += raw.length;
      s.maxBytes = Math.max(s.maxBytes, raw.length);
      const ts = String(req.headers[TS] ?? "");
      const sig = String(req.headers[SIG] ?? "");
      const expected = createHmac("sha256", key).update(`${ts}.${raw.toString("utf8")}`).digest();
      const given = Buffer.from(/^[0-9a-f]{64}$/i.test(sig) ? sig : "", "hex");
      const fresh = Math.abs(Date.now() - Number(ts)) < MAX_SKEW_MS;
      if (req.method !== "POST" || !fresh || given.length !== expected.length || !timingSafeEqual(given, expected)) {
        s.badSig++;
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":"bad_signature"}');
        return;
      }
      let body = null;
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        // a malformed body still gets the generic reply
      }
      const out = reply(path, body);
      const send = () => {
        if (!out) res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not_found"}');
        else res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
        s.ms.push(performance.now() - t0);
      };
      if (delayMs > 0) setTimeout(send, delayMs);
      else send();
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      resolve({
        url: `http://${host}:${addr.port}`,
        /** Per-path counters (ms arrays are reset by the caller when it wants windows). */
        stats,
        snapshot() {
          const out = {};
          for (const [p, s] of stats) out[p] = { n: s.n, bytes: s.bytes, maxBytes: s.maxBytes, badSig: s.badSig };
          return out;
        },
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = parseArgs(process.argv.slice(2));
  const secret = process.env.LOAD_HMAC_SECRET ?? "";
  const stub = await startWebStub({ secret, port: Number(args.port ?? 3999), host: String(args.host ?? "127.0.0.1"), delayMs: Number(args.delay ?? 0) });
  console.log(`[web-stub] listening on ${stub.url}`);
  setInterval(() => console.log(`[web-stub] ${JSON.stringify(stub.snapshot())}`), 30_000).unref();
  process.on("SIGINT", () => void stub.close().then(() => process.exit(0)));
  process.on("SIGTERM", () => void stub.close().then(() => process.exit(0)));
}
