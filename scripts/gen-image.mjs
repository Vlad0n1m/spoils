#!/usr/bin/env node
// Generate or edit game art with the OpenAI Images API. No dependencies (Node 20+).
//
//   node scripts/gen-image.mjs --prompt "..." --out art/raw/pistol.png [--size 1024x1024]
//        [--transparent] [--quality high] [--n 1] [--ref art/style/ref.png ...]
//   node scripts/gen-image.mjs --list-models
//
// --ref switches to the edits endpoint so new art follows reference images (style consistency).
// Reads OPENAI_API_KEY / OPENAI_IMAGE_MODEL from the environment or ./.env.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, basename, extname } from "node:path";

loadDotEnv(".env");

const args = parseArgs(process.argv.slice(2));
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) fail("OPENAI_API_KEY is not set (put it in .env)");
const model = args.model ?? process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-2";
const auth = { Authorization: `Bearer ${apiKey}` };

if (args["list-models"]) {
  const res = await fetch("https://api.openai.com/v1/models", { headers: auth });
  const body = await res.json();
  if (!res.ok) fail(JSON.stringify(body));
  const ids = body.data.map((m) => m.id).filter((id) => /image|dall/i.test(id)).sort();
  console.log(ids.join("\n") || "(no image models visible for this key)");
  process.exit(0);
}

if (!args.prompt) fail("--prompt is required");
if (!args.out) fail("--out is required");

const refs = [].concat(args.ref ?? []);
const params = {
  model,
  prompt: args.prompt,
  size: args.size ?? "1024x1024",
  quality: args.quality ?? "high",
  n: Number(args.n ?? 1),
  ...(args.transparent ? { background: "transparent", output_format: "png" } : {}),
};

let res;
if (refs.length) {
  const form = new FormData();
  for (const [k, v] of Object.entries(params)) form.append(k, String(v));
  for (const path of refs) {
    if (!existsSync(path)) fail(`reference not found: ${path}`);
    form.append("image[]", new Blob([readFileSync(path)], { type: "image/png" }), basename(path));
  }
  res = await fetch("https://api.openai.com/v1/images/edits", { method: "POST", headers: auth, body: form });
} else {
  res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
}

const body = await res.json();
if (!res.ok) fail(`${res.status} ${JSON.stringify(body.error ?? body)}`);

mkdirSync(dirname(args.out), { recursive: true });
const ext = extname(args.out) || ".png";
const stem = args.out.slice(0, args.out.length - ext.length);
body.data.forEach((img, i) => {
  const path = body.data.length > 1 ? `${stem}_${i + 1}${ext}` : args.out;
  writeFileSync(path, Buffer.from(img.b64_json, "base64"));
  console.log(path);
});
if (body.usage) console.error(`usage: ${JSON.stringify(body.usage)}`);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, "");
    const next = argv[i + 1];
    const value = next === undefined || next.startsWith("--") ? true : (i++, next);
    out[key] = key in out ? [].concat(out[key], value) : value;
  }
  return out;
}

function loadDotEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

function fail(msg) {
  console.error(`gen-image: ${msg}`);
  process.exit(1);
}
