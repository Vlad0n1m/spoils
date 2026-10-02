/**
 * Source-grep guard for the generator's determinism rules (map/types.ts header, map memo §4).
 * Trig/hypot/pow/exp/log differ across V8, JavaScriptCore and SpiderMonkey; Math.random/Date make
 * output non-reproducible; sorting with a random comparator depends on the engine's sort. Any of
 * them would give the browser a different map from the server (walls in different places,
 * prediction rubber-banding). legacy.ts is v1 (seeded per match, deleted after WP-M2) and exempt.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL(".", import.meta.url));
const EXEMPT = new Set(["legacy.ts"]);

const FORBIDDEN: ReadonlyArray<[RegExp, string]> = [
  [/\bMath\.(sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|asinh|acosh|atanh|hypot|pow|exp|expm1|log|log2|log10|log1p|cbrt|fround|random)\b/, "non-portable or random Math function"],
  [/\*\*/, "exponent operator (Math.pow semantics)"],
  [/\bDate\b/, "Date"],
  [/\bperformance\b/, "performance clock"],
  [/\bcrypto\b/, "crypto randomness"],
  [/\.sort\(\s*\([^)]*\)\s*=>[^)]*\brng\b/, "random sort comparator"],
  [/\bfor\s*\(\s*(const|let|var)\s+\w+\s+in\b/, "for…in (key order dependence)"],
];

/** Strip comments so prose like "no Math.random" in docs does not trip the grep. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

test("map generator sources use only deterministic math", () => {
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !EXEMPT.has(f));
  assert.ok(files.includes("generate.ts") && files.includes("buildings.ts") && files.includes("query.ts"));
  const hits: string[] = [];
  for (const f of files) {
    const lines = code(readFileSync(dir + f, "utf8")).split("\n");
    lines.forEach((line, i) => {
      for (const [re, why] of FORBIDDEN) if (re.test(line)) hits.push(`${f}:${i + 1}: ${why}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, []);
});

test("the grep itself catches violations (self-check)", () => {
  const bad = ["const a = Math.hypot(1, 2);", "x = 2 ** 3;", "const t = Date.now();", "arr.sort(() => rng() - 0.5);", "for (const k in obj) {}"];
  for (const b of bad) assert.ok(FORBIDDEN.some(([re]) => re.test(code(b))), b);
  assert.ok(!FORBIDDEN.some(([re]) => re.test(code("/** no Math.random here */ const x = Math.sqrt(2);"))));
});
