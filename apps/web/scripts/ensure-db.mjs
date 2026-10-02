/**
 * Load repo root .env, validate DATABASE_URL, connect to maintenance DB `postgres`,
 * CREATE DATABASE <name> if missing (name = last path segment of URL).
 */
import pg from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
// apps/web/scripts -> repo root is three levels up
const repoRoot = path.resolve(here, "../../..");
config({ path: path.join(repoRoot, ".env") });
config({ path: path.join(repoRoot, ".env.local") });

const raw = process.env.DATABASE_URL?.trim();
if (!raw) {
  console.error("[ensure-db] DATABASE_URL is empty");
  process.exit(1);
}

let url;
try {
  url = new URL(raw);
} catch (e) {
  console.error("[ensure-db] Invalid URL:", e.message);
  process.exit(1);
}

const dbName = (url.pathname || "").replace(/^\//, "");
if (!dbName) {
  console.error(
    "[ensure-db] No database name in URL path. Use ...host:5432/mydb",
  );
  process.exit(1);
}

if (!/^[a-zA-Z0-9_]+$/.test(dbName)) {
  console.error(
    "[ensure-db] Database name must be [a-zA-Z0-9_] only for this script:",
    dbName,
  );
  process.exit(1);
}

console.log("[ensure-db] Parsed:", {
  protocol: url.protocol,
  host: url.hostname,
  port: url.port || "5432",
  user: url.username,
  targetDb: dbName,
});

const maint = new URL(raw);
maint.pathname = "/postgres";

const pool = new pg.Pool({
  connectionString: maint.toString(),
  connectionTimeoutMillis: 10_000,
});

try {
  const exists = await pool.query(
    "SELECT 1 FROM pg_database WHERE datname = $1",
    [dbName],
  );
  if (exists.rows.length > 0) {
    console.log("[ensure-db] Database already exists:", dbName);
  } else {
    await pool.query(`CREATE DATABASE ${dbName}`);
    console.log("[ensure-db] Created database:", dbName);
  }
} catch (e) {
  console.error("[ensure-db] Failed:", e.message);
  process.exit(1);
} finally {
  await pool.end();
}

console.log("[ensure-db] OK");
