#!/usr/bin/env node
// Generate every sprite from art/sprites.json in the reference style, then cut the background.
//
//   node scripts/gen-sprites.mjs            # only missing sprites
//   node scripts/gen-sprites.mjs rifle boss # regenerate these ids
//
// Raw generations land in art/raw/, game-ready PNGs in art/sprites/.

import { readFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const REF = "art/style-test/1-cartoon.png";
const CONCURRENCY = 4;

const manifest = JSON.parse(readFileSync("art/sprites.json", "utf8"));
const only = process.argv.slice(2);
mkdirSync("art/raw", { recursive: true });
mkdirSync("art/sprites", { recursive: true });

const todo = manifest.sprites.filter((s) =>
  only.length ? only.includes(s.id) : !existsSync(`art/sprites/${s.id}.png`),
);
console.log(`sprites to generate: ${todo.map((s) => s.id).join(", ") || "none"}`);

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
      console.log(`ok ${s.id}`);
    } catch (e) {
      failed.push(s.id);
      console.error(`fail ${s.id}: ${e.stderr || e.message}`);
    }
  }
}

async function make(s) {
  const raw = `art/raw/${s.id}.png`;
  const out = `art/sprites/${s.id}.png`;
  const prompt = s.tile
    ? [manifest.style, manifest.tile, s.prompt].join(" ")
    : [manifest.style, s.view ?? manifest.view, s.prompt, manifest.isolate].join(" ");
  await run("node", ["scripts/gen-image.mjs", "--ref", REF, "--size", "1024x1024", "--out", raw, "--prompt", prompt], {
    maxBuffer: 1 << 24,
  });
  if (s.tile) {
    await run("uv", ["run", "--with", "pillow", "python", "-c",
      `from PIL import Image; Image.open(${JSON.stringify(raw)}).resize((${s.size},${s.size}), Image.LANCZOS).save(${JSON.stringify(out)})`]);
  } else {
    await run("uv", ["run", "--with", "pillow", "scripts/key-bg.py", raw, out, "--size", String(s.size)]);
  }
}
