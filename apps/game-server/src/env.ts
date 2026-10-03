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
 * WORLD v6 (D29): GAME_SERVER_ID names this deployment so the web can void the shards of a crashed
 * previous process of the same server (void-orphans). Without it every restart would orphan gear
 * until the stale-raid void, so production refuses to boot.
 */
export function assertProductionEnv(env: Record<string, string | undefined> = process.env): void {
  if (env.NODE_ENV === "production" && !env.GAME_SERVER_ID?.trim()) {
    throw new Error("GAME_SERVER_ID is required in production (WORLD v6: void-orphans identifies this server by it)");
  }
}
assertProductionEnv();
