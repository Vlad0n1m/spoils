#!/usr/bin/env node
// Generate the main-menu art from art/lobby.json in the reference style (WORLD v6 step S10).
//
//   node scripts/gen-lobby-art.mjs                  # only missing outputs
//   node scripts/gen-lobby-art.mjs hero_2 menu_shop # regenerate these ids
//   node scripts/gen-lobby-art.mjs --post-only      # redo the cut / resize from art/raw/lobby only
//
// Raw generations land in art/raw/lobby/, game-ready files in apps/web/public/lobby/.
// kind "background": no cut-out, saved as webp under maxBytes. kind "cutout": magenta keyed with
// scripts/key-bg.py and trimmed; a square `box` is padded to w x h, any other box is a fit.
// Items whose `refs` point at another item's raw file (hero_1..3 → hero_0) run after it.
// The OpenAI key is read by scripts/gen-image.mjs from .env and never printed.

import { readFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const CONCURRENCY = 2;
const RAW = "art/raw/lobby";
const OUT = "apps/web/public/lobby";

const manifest = JSON.parse(readFileSync("art/lobby.json", "utf8"));
const argv = process.argv.slice(2);
const postOnly = argv.includes("--post-only");
const only = argv.filter((a) => !a.startsWith("--"));
mkdirSync(RAW, { recursive: true });
mkdirSync(OUT, { recursive: true });

const unknown = only.filter((id) => !manifest.items.some((s) => s.id === id));
if (unknown.length) {
  console.error(`unknown ids: ${unknown.join(", ")}`);
  process.exit(1);
}
const todo = manifest.items.filter((s) => (only.length ? only.includes(s.id) : !existsSync(`${OUT}/${s.out}`)));
console.log(`lobby art to ${postOnly ? "post-process" : "generate"}: ${todo.map((s) => s.id).join(", ") || "none"}`);

// Two waves: items that reference another item's raw output go after everything else.
const dependsOnRaw = (s) => (s.refs ?? []).some((r) => r.startsWith(`${RAW}/`));
const failed = [];
for (const wave of [todo.filter((s) => !dependsOnRaw(s)), todo.filter(dependsOnRaw)]) {
  const queue = [...wave];
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));
}
if (failed.length) {
  console.error(`failed: ${failed.join(", ")}`);
  process.exit(1);
}

async function worker(queue) {
  for (let s = queue.shift(); s; s = queue.shift()) {
    try {
      await make(s);
      console.log(`ok ${s.id} → ${OUT}/${s.out}`);
    } catch (e) {
      failed.push(s.id);
      console.error(`fail ${s.id}: ${e.stderr || e.message}`);
    }
  }
}

async function make(s) {
  const raw = `${RAW}/${s.id}.png`;
  const out = `${OUT}/${s.out}`;
  if (!postOnly) {
    const refs = [manifest.ref, ...(s.refs ?? [])];
    for (const r of refs) if (!existsSync(r)) throw new Error(`reference missing: ${r}`);
    const prompt = s.kind === "cutout" ? [manifest.style, s.prompt, manifest.isolate].join(" ") : [manifest.style, s.prompt].join(" ");
    const args = ["scripts/gen-image.mjs", "--size", s.gen, "--out", raw, "--prompt", prompt];
    for (const r of refs) args.push("--ref", r);
    await run("node", args, { maxBuffer: 1 << 24 });
  }
  if (!existsSync(raw)) throw new Error(`raw missing: ${raw}`);
  if (s.kind === "background") await toWebp(raw, out, s.width, s.maxBytes);
  else await cutout(raw, out, s.box);
}

async function py(code) {
  return run("uv", ["run", "--with", "pillow", "python", "-c", code], { maxBuffer: 1 << 24 });
}

/** Resize to `width` and save as webp, stepping the quality down until the file fits maxBytes. */
async function toWebp(raw, out, width, maxBytes) {
  for (const q of [80, 74, 68, 62, 56]) {
    await py(
      `from PIL import Image
im = Image.open(${JSON.stringify(raw)}).convert("RGB")
w = ${width}
if im.width != w: im = im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)
im.save(${JSON.stringify(out)}, "WEBP", quality=${q}, method=6)`,
    );
    const size = statSync(out).size;
    if (size <= maxBytes) return console.log(`${out} webp q${q} ${Math.round(size / 1024)} KB`);
  }
  throw new Error(`${out} is still over ${maxBytes} bytes at the lowest quality`);
}

/**
 * Magenta key + trim (key-bg.py). A square box is padded to exactly w x h (icons, like the sprites);
 * any other box is a fit keeping the aspect, no padding (the hero stands on its feet in the menu).
 */
async function cutout(raw, out, [bw, bh]) {
  if (bw === bh) return run("uv", ["run", "--with", "pillow", "scripts/key-bg.py", raw, out, "--size", String(bw)]);
  await run("uv", ["run", "--with", "pillow", "scripts/key-bg.py", raw, out]);
  await py(
    `from PIL import Image
im = Image.open(${JSON.stringify(out)})
im.thumbnail((${bw}, ${bh}), Image.LANCZOS)
im.save(${JSON.stringify(out)}, optimize=True)
print(${JSON.stringify(out)}, im.size)`,
  );
}
