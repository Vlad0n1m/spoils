import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
// `here` = apps/game-server/src → monorepo root is three levels up
const repoRoot = path.resolve(here, "../../..");
// Monorepo root .env (same as apps/web + drizzle) — `tsx` does not auto-load it
loadEnv({ path: path.join(repoRoot, ".env") });
loadEnv({ path: path.join(repoRoot, ".env.local") });
loadEnv({ path: path.join(here, ".env") });
loadEnv({ path: path.join(here, ".env.local") });

/**
 * Production boot checks; every problem is listed at once (names only, never values).
 * - GAME_SERVER_ID (WORLD v6, D29) names this deployment so the web can void the shards of a crashed
 *   previous process of the same server (void-orphans). Without it every restart would orphan gear
 *   until the stale-raid void.
 * - WEB_API_BASE_URL and GAME_SERVER_HMAC_SECRET: without them the server runs in the offline dev mode
 *   (free kits, nothing settled) and rejects every signed join ticket — never what production wants.
 */
export function productionEnvProblems(env: Record<string, string | undefined> = process.env): string[] {
  if (env.NODE_ENV !== "production") return [];
  const problems: string[] = [];
  if (!env.GAME_SERVER_ID?.trim()) {
    problems.push("GAME_SERVER_ID is required in production (WORLD v6: void-orphans identifies this server by it)");
  }
  if (!env.WEB_API_BASE_URL?.trim()) {
    problems.push("WEB_API_BASE_URL is required in production (entries, exits and the wipe are settled by the web)");
  }
  const hmac = env.GAME_SERVER_HMAC_SECRET?.trim() ?? "";
  if (hmac.length < 16) {
    problems.push("GAME_SERVER_HMAC_SECRET (16+ characters, same as the web) is required in production");
  }
  return problems;
}

export function assertProductionEnv(env: Record<string, string | undefined> = process.env): void {
  const problems = productionEnvProblems(env);
  if (problems.length > 0) throw new Error(problems.join("; "));
}
assertProductionEnv();
