/**
 * Seeds the demo economy: ≈700 lost-pool items + 20 NPC market listings (idempotent).
 *   apps/game-server/node_modules/.bin/tsx apps/web/scripts/seed-economy.ts [--force] [--pool=700] [--listings=20] [--seed=1]
 * DATABASE_URL comes from the environment, else the repo-root / apps/web .env files (like drizzle.config.ts).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { mulberry32 } from "@extract/shared";
import * as schema from "../src/db/schema";
import { seedEconomy } from "../src/lib/economy/seed";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..");
const repoRoot = path.resolve(webRoot, "../..");
for (const f of [path.join(repoRoot, ".env"), path.join(repoRoot, ".env.local"), path.join(webRoot, ".env"), path.join(webRoot, ".env.local")]) {
  loadEnv({ path: f });
}

function arg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a?.slice(name.length + 3);
}

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("[seed-economy] DATABASE_URL is empty");
  process.exit(1);
}
const pool = new Pool({ connectionString: url });
try {
  const res = await seedEconomy(drizzle(pool, { schema }), {
    poolItems: Number(arg("pool") ?? 700),
    listings: Number(arg("listings") ?? 20),
    rng: mulberry32(Number(arg("seed") ?? Date.now() % 2 ** 32)),
    force: process.argv.includes("--force"),
  });
  console.log(`[seed-economy] ${new URL(url).pathname.slice(1)}:`, res);
} finally {
  await pool.end();
}
