#!/usr/bin/env node
// Generate the Weapons v2 art from art/guns-v2.json (docs/WEAPONS_V2.md), same pipeline as
// scripts/gen-sprites.mjs: gpt-image-2 edits with the cartoon style reference (guns also get the
// existing rifle sprite as a second reference), then the magenta key + trim of scripts/key-bg.py.
//
//   node art/raw/guns-v2/gen.mjs              # only missing outputs
//   node art/raw/guns-v2/gen.mjs smg grenade  # regenerate these ids
//   node art/raw/guns-v2/gen.mjs --post-only  # redo the key / trim from the raw files only
//
// Run from the repo root. Raw generations land in art/raw/guns-v2/, game-ready PNGs in
// apps/web/public/sprites/<id>.png. The OpenAI key is read by scripts/gen-image.mjs from .env and
// never printed. Afterwards: uv run --with pillow art/raw/guns-v2/post.py

import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const CONCURRENCY = 3;
const RAW = "art/raw/guns-v2";
const OUT = "apps/web/public/sprites";

const m = JSON.parse(readFileSync("art/guns-v2.json", "utf8"));
const argv = process.argv.slice(2);
const postOnly = argv.includes("--post-only");
const only = argv.filter((a) => !a.startsWith("--"));
const unknown = only.filter((id) => !m.items.some((s) => s.id === id));
if (unknown.length) {
  console.error(`unknown ids: ${unknown.join(", ")}`);
  process.exit(1);
}
mkdirSync(RAW, { recursive: true });
const todo = m.items.filter((s) => (only.length ? only.includes(s.id) : !existsSync(`${OUT}/${s.id}.png`)));
console.log(`to ${postOnly ? "post-process" : "generate"}: ${todo.map((s) => s.id).join(", ") || "none"}`);

const queue = [...todo];
const failed = [];
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
if (failed.length) {
  console.error(`failed: ${failed.join(", ")}`);
  process.exit(1);
}

async function worker() {
  for (let s = queue.shift(); s; s = queue.shift()) {
    try {
      await make(s);
      console.log(`ok ${s.id} → ${OUT}/${s.id}.png`);
    } catch (e) {
      failed.push(s.id);
      console.error(`fail ${s.id}: ${e.stderr || e.message}`);
    }
  }
}

async function make(s) {
  const raw = `${RAW}/${s.id}.png`;
  if (!postOnly) {
    const refs = s.gun ? [m.ref, m.gunRef] : [m.ref];
    for (const r of refs) if (!existsSync(r)) throw new Error(`reference missing: ${r}`);
    const prompt = s.gun
      ? [m.style, m.gunStyle, s.view ?? m.gunView, s.prompt, m.isolate].join(" ")
      : [m.style, s.view ?? m.view, s.prompt, m.isolate].join(" ");
    const args = [
      "scripts/gen-image.mjs", "--size", "1024x1024", "--out", raw, "--prompt", prompt,
    ];
    for (const r of refs) args.push("--ref", r);
    await run("node", args, { maxBuffer: 1 << 24 });
  }
  if (!existsSync(raw)) throw new Error(`raw missing: ${raw}`);
  await run("uv", ["run", "--with", "pillow", "scripts/key-bg.py", raw, `${OUT}/${s.id}.png`, "--size", String(s.size)], {
    maxBuffer: 1 << 24,
  });
}
