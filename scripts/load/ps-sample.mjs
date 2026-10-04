#!/usr/bin/env node
/**
 * ps sampler for a load run on a VPS (run.mjs has its own): every --every ms (default 5000) one
 * ps.csv row per pid with the cumulative CPU time, so analyze.mjs can derive CPU % per phase.
 *
 *   node scripts/load/ps-sample.mjs --pid <game server pid> [--role server] [--out ps.csv] [--every 5000]
 *
 * Stops by itself when the process is gone (or on Ctrl-C).
 */

import { execFile } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { promisify } from "node:util";
import { parseArgs, parsePsTime } from "./lib.mjs";

const execFileP = promisify(execFile);
const args = parseArgs(process.argv.slice(2));
const pid = Number(args.pid);
if (!Number.isInteger(pid) || pid <= 0) throw new Error("--pid <pid> is required");
const role = String(args.role ?? "server");
const outPath = String(args.out ?? "ps.csv");
const fresh = !existsSync(outPath);
const out = createWriteStream(outPath, { flags: "a" });
if (fresh) out.write("t,role,pid,pcpu,rssKB,cpuSec\n");

const timer = setInterval(async () => {
  try {
    const { stdout } = await execFileP("ps", ["-o", "pid=,%cpu=,rss=,time=", "-p", String(pid)]);
    const [p, pcpu, rss, time] = stdout.trim().split(/\s+/);
    out.write(`${Date.now()},${role},${p},${pcpu},${rss},${parsePsTime(time)}\n`);
  } catch {
    clearInterval(timer);
    out.end();
  }
}, Number(args.every ?? 5000));
process.on("SIGINT", () => {
  clearInterval(timer);
  out.end(() => process.exit(0));
});
