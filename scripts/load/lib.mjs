/**
 * Shared helpers of the load-test scripts (scripts/load/*). Plain Node ESM: the clients do not need
 * tsx, they import the built @extract/shared (packages/shared/dist, the same build the game server
 * runs against) and the ESM build of colyseus.js that apps/web depends on.
 */

import { createHmac } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** @extract/shared from its build (run `pnpm --filter @extract/shared build` when it is stale). */
export function loadShared() {
  return import(pathToFileURL(path.join(REPO, "packages/shared/dist/index.js")).href);
}

/**
 * colyseus.js (the web client's SDK), ESM build: it must share one @colyseus/schema instance with
 * packages/shared's BattleState, and the CJS build would load a second copy.
 */
export function loadColyseus() {
  const req = createRequire(path.join(REPO, "apps/web/package.json"));
  const pkg = req.resolve("colyseus.js/package.json");
  return import(pathToFileURL(path.join(path.dirname(pkg), "build/esm/index.mjs")).href);
}

/** Nearest-rank percentile (same rule as the server's tick-stats.ts). NaN for an empty list. */
export function pct(values, q) {
  if (!values.length) return NaN;
  const s = Float64Array.from(values).sort();
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

export function mean(values) {
  if (!values.length) return NaN;
  let t = 0;
  for (const v of values) t += v;
  return t / values.length;
}

/** A JoinTicket signed like apps/web/src/lib/join-ticket.ts (secret = the game server's HMAC secret). */
export function signTicket(shared, secret, who) {
  const t = { userId: who.userId, nickname: who.nickname, issuedAt: who.issuedAt ?? Date.now(), loadoutId: who.loadoutId ?? "" };
  if (who.matchId) t.matchId = who.matchId;
  if (who.entryId) t.entryId = who.entryId;
  const sig = createHmac("sha256", secret).update(shared.joinTicketPayload(t)).digest("hex");
  return { ...t, sig };
}

/** macOS / Linux `ps -o time=`: "[[dd-]hh:]mm:ss[.cc]" → seconds. */
export function parsePsTime(s) {
  const str = String(s).trim();
  if (!str) return NaN;
  let days = 0;
  let rest = str;
  const dash = str.indexOf("-");
  if (dash > 0) {
    days = Number(str.slice(0, dash));
    rest = str.slice(dash + 1);
  }
  const parts = rest.split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return NaN;
  let sec = 0;
  for (const p of parts) sec = sec * 60 + p;
  return days * 86400 + sec;
}

/** Tiny argv parser: `--key value`, `--flag` (true), `--no-flag` (false). */
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    if (key.startsWith("no-")) {
      out[key.slice(3)] = false;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

/** "1:60,4:75,8:90" → [{ clients: 1, seconds: 60 }, …]. */
export function parseSchedule(s) {
  return String(s)
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const [c, sec] = p.split(":").map(Number);
      if (!Number.isInteger(c) || c < 0 || !Number.isFinite(sec) || sec <= 0) throw new Error(`bad schedule step "${p}" (want clients:seconds)`);
      return { clients: c, seconds: sec };
    });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
