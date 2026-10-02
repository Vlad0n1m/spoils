import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import type { Config } from "drizzle-kit";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

// drizzle-kit does not load monorepo root .env — same keys as Next
loadEnv({ path: path.join(repoRoot, ".env") });
loadEnv({ path: path.join(repoRoot, ".env.local") });
loadEnv({ path: path.join(here, ".env") });
loadEnv({ path: path.join(here, ".env.local") });

const url = process.env.DATABASE_URL?.trim() ?? "";

if (!url) {
  console.error(
    "[drizzle] DATABASE_URL is empty. Put it in extract/.env (repo root) or apps/web/.env, then run: pnpm db:push",
  );
  if (process.env.DRIZZLE_REQUIRE_DB === "1") {
    throw new Error(
      "[drizzle] DATABASE_URL is empty but DRIZZLE_REQUIRE_DB=1 (e.g. Docker migrate). Set DATABASE_URL for the migrate service.",
    );
  }
}

// drizzle-kit push: diffSchemasOrTables → JSON.stringify(snapshot) throws on BigInt (introspection / defaults)
const origStringify = JSON.stringify;
JSON.stringify = (value: unknown, replacer?: unknown, space?: string | number) => {
  const bridge = (key: string, val: unknown) => {
    let v = val;
    if (typeof replacer === "function")
      v = (replacer as (k: string, x: unknown) => unknown)(key, val);
    return typeof v === "bigint" ? v.toString() : v;
  };
  if (replacer === undefined || typeof replacer === "function")
    return origStringify(value, bridge, space);
  return origStringify(value, replacer as never, space);
};

export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url,
  },
  strict: true,
  verbose: true,
} satisfies Config;
