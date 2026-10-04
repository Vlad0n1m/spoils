// Cron scheduler of the single-VPS compose deployment (the `cron` service of docker-compose.yml).
// Calls the web cron routes with `Authorization: Bearer $CRON_SECRET`, the header Vercel Cron sends
// and apps/web/src/lib/env.ts isCronAuthorized checks. No dependencies: plain Node 20 (global fetch).
//
//   CRON_SECRET         required; same value as the web
//   CRON_BASE_URL       web origin, default http://web:3000
//   CRON_SCHEDULE_FILE  default ./schedule.json next to this file
//   CRON_RUN_ON_START   comma list of paths to call once at start (e.g. /api/cron/void-raids)
//
// Logs paths and status codes only, never the secret.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const secret = (process.env.CRON_SECRET ?? "").trim();
const baseUrl = (process.env.CRON_BASE_URL || "http://web:3000").replace(/\/+$/, "");
const scheduleFile = process.env.CRON_SCHEDULE_FILE || path.join(here, "schedule.json");

if (!secret) {
  console.error("[cron] CRON_SECRET is not set: refusing to start (the web rejects unauthenticated cron calls in production)");
  process.exit(1);
}

/** @type {{ path: string, everyMinutes?: number, dailyAt?: string, timeoutMs?: number }[]} */
const jobs = JSON.parse(readFileSync(scheduleFile, "utf8")).jobs;
for (const j of jobs) {
  const ok =
    typeof j.path === "string" &&
    j.path.startsWith("/") &&
    ((Number.isInteger(j.everyMinutes) && j.everyMinutes > 0 && j.everyMinutes <= 1440) ||
      (typeof j.dailyAt === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(j.dailyAt)));
  if (!ok) {
    console.error(`[cron] bad job in ${scheduleFile}: ${JSON.stringify(j)}`);
    process.exit(1);
  }
}

/** Paths whose previous call is still running: a slow call is never stacked. */
const running = new Set();

function isDue(job, d) {
  const minuteOfDay = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (job.dailyAt) {
    const [h, m] = job.dailyAt.split(":").map(Number);
    return minuteOfDay === h * 60 + m;
  }
  return minuteOfDay % job.everyMinutes === 0;
}

async function call(job) {
  if (running.has(job.path)) {
    console.warn(`[cron] ${job.path} skipped: previous call still running`);
    return;
  }
  running.add(job.path);
  const started = Date.now();
  try {
    const res = await fetch(baseUrl + job.path, {
      method: "GET",
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(job.timeoutMs ?? 30_000),
    });
    const body = (await res.text()).slice(0, 300).replace(/\s+/g, " ");
    const line = `[cron] ${job.path} ${res.status} ${Date.now() - started}ms ${body}`;
    if (res.ok) console.log(line);
    else console.error(line);
  } catch (err) {
    console.error(`[cron] ${job.path} failed after ${Date.now() - started}ms: ${err?.name ?? "Error"} ${err?.message ?? ""}`);
  } finally {
    running.delete(job.path);
  }
}

let timer;
function scheduleNextTick() {
  // Fire 2 s into each UTC minute so a slightly fast container clock never lands on the previous one.
  const now = Date.now();
  const next = Math.floor(now / 60_000) * 60_000 + 60_000 + 2_000;
  timer = setTimeout(tick, next - now);
}

function tick() {
  const d = new Date();
  for (const job of jobs) if (isDue(job, d)) void call(job);
  scheduleNextTick();
}

function shutdown(sig) {
  console.log(`[cron] ${sig}: stopping`);
  clearTimeout(timer);
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

console.log(
  `[cron] ${jobs.length} jobs against ${baseUrl}: ` +
    jobs.map((j) => `${j.path} ${j.dailyAt ? `daily ${j.dailyAt} UTC` : `every ${j.everyMinutes} min`}`).join(", "),
);
for (const p of (process.env.CRON_RUN_ON_START ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
  const job = jobs.find((j) => j.path === p) ?? { path: p };
  void call(job);
}
scheduleNextTick();
