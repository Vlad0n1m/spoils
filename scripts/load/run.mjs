#!/usr/bin/env node
/**
 * Local load run of the world shard (block D/E, docs/SCALING.md): one game server with the probe
 * (server-probe.mts, BATTLE_PERF_LOG=1), the web stub (web-stub.mjs: replay recording and every web
 * post stay on, no Postgres) and a swarm of load clients (clients.mjs) going through a schedule of
 * phases, e.g. 0 → 1 → 4 → 8 clients. ps samples the server and this process every 5 s.
 *
 *   node scripts/load/run.mjs --out <dir> [--port 2669] [--schedule 0:30,1:60,4:75,8:90] [--seed 1] [--no-replay]
 *
 * - A fresh random HMAC secret per run, shared in memory with the server (env) and the clients; it is
 *   never printed or written to disk. The owner's .env secret is not used (env vars beat dotenv).
 * - WORLD_DEV_CLOCK_OFFSET_MS puts the server one minute into a fresh cycle, so entry is open and no
 *   wipe can fall into the run (dev only; the production server ignores the variable).
 * - The total schedule is capped at 300 s (pass --allow-long for a longer run on a VPS).
 * - The server is killed by PID at the end (and on Ctrl-C), then analyze.mjs writes summary.md.
 */

import { spawn, execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { analyzeRun, renderMarkdown } from "./analyze.mjs";
import { createSwarm, recordSwarm } from "./clients.mjs";
import { REPO, loadShared, parseArgs, parsePsTime, parseSchedule, pct, sleep } from "./lib.mjs";
import { startWebStub } from "./web-stub.mjs";

const execFileP = promisify(execFile);
const args = parseArgs(process.argv.slice(2));
const port = Number(args.port ?? 2669);
const schedule = parseSchedule(args.schedule ?? "0:30,1:60,4:75,8:90");
const totalS = schedule.reduce((a, s) => a + s.seconds, 0);
if (totalS > 300 && !args["allow-long"]) throw new Error(`schedule is ${totalS} s; the local cap is 300 s (--allow-long to override)`);
const maxClients = Math.max(...schedule.map((s) => s.clients));
if (maxClients > 8 && !args["allow-many"]) throw new Error(`schedule asks for ${maxClients} clients; the local cap is 8 (--allow-many to override)`);
const out = path.resolve(String(args.out ?? path.join(os.tmpdir(), "spoils-load", new Date().toISOString().replace(/[:.]/g, "-"))));
mkdirSync(out, { recursive: true });
const log = (m) => console.log(`[run ${new Date().toISOString().slice(11, 19)}] ${m}`);

// Weak laptop rule: wait while the 1-minute load is above 16.
for (let i = 0; i < 5 && os.loadavg()[0] > 16; i++) {
  log(`load ${os.loadavg()[0].toFixed(1)} > 16: waiting 60 s`);
  await sleep(60_000);
}

const shared = await loadShared();
const secret = randomBytes(32).toString("hex");
const stub = await startWebStub({ secret });
log(`web stub on ${stub.url}`);

// One minute into the next cycle: entry open, 44 minutes to the wipe.
const nextCycle = shared.worldCycleAt(Date.now()).cycle + 1;
const target = shared.worldCycleOf(nextCycle).startAt + 60_000;
const offsetMs = target - Date.now();

const serverLog = createWriteStream(path.join(out, "server.log"));
const server = spawn(process.execPath, ["--import", "tsx", path.join(REPO, "scripts/load/server-probe.mts")], {
  cwd: path.join(REPO, "apps/game-server"),
  env: {
    ...process.env,
    NODE_ENV: "development",
    GAME_SERVER_PORT: String(port),
    GAME_SERVER_ID: "loadtest",
    GAME_SERVER_HMAC_SECRET: secret,
    WEB_API_BASE_URL: stub.url,
    BATTLE_PERF_LOG: "1",
    REPLAY_RECORD: args.replay === false ? "0" : "1",
    WORLD_DEV_CLOCK_OFFSET_MS: String(offsetMs),
    LOAD_PROBE_DIR: out,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
log(`game server pid ${server.pid} on :${port}`);
let serverExited = false;
server.on("exit", (code, sig) => {
  serverExited = true;
  log(`game server exited (${code ?? sig})`);
});
const killServer = () => {
  if (!serverExited) {
    try {
      process.kill(server.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
};
process.on("exit", killServer);
process.on("SIGINT", () => {
  killServer();
  process.exit(130);
});

// Parse the boot lines: the map hash and the shard's room / match.
let mapHash = "";
let shard = null;
let buf = "";
const onData = (d) => {
  serverLog.write(d);
  buf += d.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    const mh = line.match(/\[game-server\] map (\S+) ([0-9a-f]+) ready/);
    if (mh) mapHash = mh[2];
    const ms = line.match(/\[world\] cycle (\d+) shard \d+ open: room (\S+), match ([0-9a-f-]{36})/);
    if (ms) shard = { cycle: Number(ms[1]), roomId: ms[2].replace(/,$/, ""), matchId: ms[3] };
  }
};
server.stdout.on("data", onData);
server.stderr.on("data", onData);

const bootT0 = Date.now();
while (!shard && !serverExited && Date.now() - bootT0 < 120_000) await sleep(250);
if (!shard) {
  killServer();
  await stub.close();
  throw new Error("the shard did not open (see server.log)");
}
log(`shard open: cycle ${shard.cycle}, room ${shard.roomId}, map ${mapHash} (boot ${((Date.now() - bootT0) / 1000).toFixed(1)} s)`);

// ps sampler: the server and this process (the clients), every 5 s.
const psFile = createWriteStream(path.join(out, "ps.csv"));
psFile.write("t,role,pid,pcpu,rssKB,cpuSec\n");
const sampleOnce = async () => {
  try {
    const { stdout } = await execFileP("ps", ["-o", "pid=,%cpu=,rss=,time=", "-p", `${server.pid},${process.pid}`]);
    const t = Date.now();
    for (const l of stdout.trim().split("\n")) {
      const [pid, pcpu, rss, time] = l.trim().split(/\s+/);
      const role = Number(pid) === server.pid ? "server" : "clients";
      psFile.write(`${t},${role},${pid},${pcpu},${rss},${parsePsTime(time)}\n`);
    }
  } catch {
    // the server may be gone at the very end
  }
};
await sampleOnce();
const psTimer = setInterval(() => void sampleOnce(), 5000);

const swarm = await createSwarm({
  server: `ws://127.0.0.1:${port}`,
  roomId: shard.roomId,
  matchId: shard.matchId,
  secret,
  seed: args.seed ?? 1,
  log: (m) => log(m),
});
if (mapHash && swarm.mapHash !== mapHash) log(`WARNING: client map hash ${swarm.mapHash} != server ${mapHash}`);
log(`clients ready (hot zone: ${swarm.hotZone})`);
const stopRec = recordSwarm(swarm, out);

const meta = {
  startedAt: new Date().toISOString(),
  host: { cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, memGB: +(os.totalmem() / 2 ** 30).toFixed(1), loadAvgStart: os.loadavg().map((v) => +v.toFixed(2)) },
  node: process.version,
  port,
  schedule,
  replay: args.replay !== false,
  mapHash,
  cycle: shard.cycle,
  hotZone: swarm.hotZone,
};
const phases = [];
try {
  for (const step of schedule) {
    const startMs = Date.now();
    log(`phase: ${step.clients} client(s) for ${step.seconds} s`);
    await swarm.setCount(step.clients);
    await sleep(Math.max(0, step.seconds * 1000 - (Date.now() - startMs)));
    phases.push({ name: `${step.clients} clients`, clients: step.clients, startMs, endMs: Date.now() });
  }
} finally {
  log("stopping clients");
  await swarm.stop();
  stopRec();
  await sleep(1500);
  await sampleOnce();
  clearInterval(psTimer);
  meta.loadAvgEnd = os.loadavg().map((v) => +v.toFixed(2));
  if (!serverExited) server.kill("SIGTERM");
  for (let i = 0; i < 20 && !serverExited; i++) await sleep(250);
  killServer();
  psFile.end();
  const stubOut = {};
  for (const [p, s] of stub.stats) stubOut[p] = { n: s.n, bytes: s.bytes, maxBytes: s.maxBytes, badSig: s.badSig, p50Ms: pct(s.ms, 0.5), p95Ms: pct(s.ms, 0.95) };
  await stub.close();
  writeFileSync(path.join(out, "stub.json"), JSON.stringify(stubOut, null, 1));
  writeFileSync(path.join(out, "phases.json"), JSON.stringify(phases, null, 1));
  writeFileSync(path.join(out, "meta.json"), JSON.stringify(meta, null, 1));
  serverLog.end();
}

await sleep(300);
const r = analyzeRun(out);
writeFileSync(path.join(out, "summary.json"), JSON.stringify(r, null, 1));
const md = renderMarkdown(r);
writeFileSync(path.join(out, "summary.md"), md);
process.stdout.write(md);
log(`results in ${out}`);
process.exit(0);
